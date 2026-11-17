import { Composer, InlineKeyboard } from "grammy";
import { MyContext } from "../../context";
import { findSongsInTeam, listSongsInTeam } from "../../../services/songService";
import { Song, SongDoc } from "../../../models/Song";
import { formatSongCard, sendSongCard } from "../../views/songCard";
import { getTeamsForUser } from "../../../services/teamService";
import { isAdmin } from "../../../services/teamService";
import { env } from "../../../config/env";

export const songQueryComposer = new Composer<MyContext>();

// Все фразы распознаются локально: сообщения никуда за пределы бота не отправляются.
const KEYWORDS = [
  "тональност",
  "key",
  "капо",
  "капод",
  "темп",
  "bpm",
  "размер",
  "жанр",
  "исполнител",
  "автор",
  "аккорд",
  "название песни",
  "что за песня",
  "какая песня",
  "кто поет",
  "исполняет",
  "как играем",
  "как играть",
];

const QUERY_STOP_WORDS = new Set([
  "в",
  "и",
  "какая",
  "какой",
  "какие",
  "скажи",
  "подскажи",
  "пожалуйста",
  "у",
  "для",
  "про",
  "это",
  "этой",
  "там",
  "же",
  "песня",
  "песни",
  "играем",
  "играть",
  "будем",
  "мы",
  "как",
  "кто",
  "поет",
  "исполняет",
  "найди",
  "покажи",
  "мне",
  "наш",
  "наша",
  "наши",
  "есть",
  "базе",
  "список",
  "все",
]);

export function hasSongQuestionKeyword(text: string): boolean {
  const normalized = text.toLowerCase().replace(/ё/g, "е");
  return KEYWORDS.some((keyword) => normalized.includes(keyword));
}

export function isSongListQuestion(text: string): boolean {
  const normalized = text.toLowerCase().replace(/ё/g, "е");
  return /(?:(?:какие|список|покажи|все).{0,35}песн[а-я]*|песн[а-я]*.{0,35}(?:есть|добавлен[а-я]*|в\s+базе))/iu.test(normalized);
}

export function extractSongQueryFromText(text: string): string {
  let query = text.toLowerCase().replace(/ё/g, "е");
  const afterSong = query.match(/(?:у|для|про)?\s*песн(?:я|и|ю|е)\s+[«"']?(.+?)[»"']?[?!.]*$/i);
  if (afterSong?.[1]) return cleanQuery(afterSong[1]);
  for (const keyword of KEYWORDS) {
    query = query.replace(new RegExp(`${keyword}[а-яё]*`, "gi"), " ");
  }
  return cleanQuery(query)
    .split(" ")
    .filter((word) => !QUERY_STOP_WORDS.has(word))
    .join(" ");
}

export function isKeyQuestion(text: string): boolean {
  return /тональност|\bkey\b/i.test(text);
}

function cleanQuery(value: string): string {
  return value.replace(/[^a-zа-я0-9\s-]/gi, " ").replace(/\s+/g, " ").trim();
}

export function formatSong(song: SongDoc & { _id: any }): string {
  return formatSongCard(song);
}

type SongChoice = { id: string; title: string; artist?: string };

const SONG_SELECTION_TTL_MS = 5 * 60 * 1000;

function normalizeChoice(value: string): string {
  return value
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/giu, " ")
    .trim();
}

/** Принимает номер варианта или точное название из показанного ботом списка. */
export function resolveSongChoice(text: string, choices: SongChoice[]): SongChoice | undefined {
  const normalized = normalizeChoice(text);
  if (!normalized) return undefined;

  if (/^\d+$/.test(normalized)) {
    const index = Number(normalized) - 1;
    return choices[index];
  }

  const exactMatches = choices.filter((choice) => normalizeChoice(choice.title) === normalized);
  if (exactMatches.length === 1) return exactMatches[0];

  const prefixMatches = choices.filter((choice) => normalizeChoice(choice.title).startsWith(normalized));
  return prefixMatches.length === 1 ? prefixMatches[0] : undefined;
}

function rememberSongChoices(ctx: MyContext, teamId: string, choices: SongChoice[]): void {
  if (!ctx.from) return;
  ctx.session.pendingSongSelections ??= {};
  ctx.session.pendingSongSelections[String(ctx.from.id)] = {
    teamId,
    choices,
    expiresAt: Date.now() + SONG_SELECTION_TTL_MS,
  };
}

function clearSongChoices(ctx: MyContext): void {
  if (!ctx.from || !ctx.session.pendingSongSelections) return;
  delete ctx.session.pendingSongSelections[String(ctx.from.id)];
}

async function groupSongKeyboard(ctx: MyContext, song: SongDoc & { _id: any }): Promise<InlineKeyboard | undefined> {
  if (!ctx.team || !ctx.from || !env.audio.enabled) return undefined;
  const keyboard = new InlineKeyboard();
  if (song.audio?.processingStatus === "completed") keyboard.text("🎧 УЧИТЬ ПЕСНЮ", `ap:o:${song._id}`).row();
  else if (song.audio?.processingStatus === "awaiting_chords") keyboard.text("🔗 ЖДЁТ HOLY CHORDS", `ap:o:${song._id}`).row();
  else if (song.audio?.processingStatus === "queued" || song.audio?.processingStatus === "processing") keyboard.text("⏳ АУДИО ОБРАБАТЫВАЕТСЯ", `ap:o:${song._id}`).row();
  else if (song.audio?.processingStatus === "failed") keyboard.text("⚠️ ПОВТОРИТЬ ОБРАБОТКУ", `ap:o:${song._id}`).row();
  if (await isAdmin(ctx.from.id, ctx.team._id)) keyboard.text(song.audio?.original ? "🔄 РАЗОБРАТЬ ДРУГОЙ ФАЙЛ" : "🎧 РАЗОБРАТЬ ПЕСНЮ", `ap:upload:${song._id}`);
  return keyboard;
}

async function sendGroupSongCard(ctx: MyContext, song: SongDoc & { _id: any }, replyToMessageId?: number): Promise<void> {
  await sendSongCard(ctx, song, replyToMessageId, await groupSongKeyboard(ctx, song));
}

async function replyWithPendingSongChoice(ctx: MyContext, text: string): Promise<boolean> {
  if (!ctx.from || !ctx.team) return false;
  const pending = ctx.session.pendingSongSelections?.[String(ctx.from.id)];
  if (!pending) return false;

  if (pending.expiresAt <= Date.now() || pending.teamId !== String(ctx.team._id)) {
    clearSongChoices(ctx);
    return false;
  }

  const choice = resolveSongChoice(text, pending.choices);
  if (!choice) return false;

  clearSongChoices(ctx);
  const song = await Song.findOne({ _id: choice.id, team: ctx.team._id });
  if (!song) {
    await ctx.reply("Эта песня уже недоступна. Попробуй выполнить поиск ещё раз.");
    return true;
  }
  await sendGroupSongCard(ctx, song, ctx.message!.message_id);
  return true;
}

async function replyWithSearchResults(
  ctx: MyContext,
  teamId: any,
  query: string
) {
  const results = await findSongsInTeam(teamId, query);
  const replyParameters = { message_id: ctx.message!.message_id };

  if (results.length === 0) {
    await ctx.reply(`Не нашёл песню, похожую на «${query}» 🤔 Может, её ещё не добавили?`, {
      reply_parameters: replyParameters,
    });
    return;
  }

  if (results.length === 1) {
    clearSongChoices(ctx);
    const song = results[0];
    await sendGroupSongCard(ctx, song, ctx.message!.message_id);
    return;
  }

  const choices = results.map((song) => ({
    id: String(song._id),
    title: song.title,
    ...(song.artist ? { artist: song.artist } : {}),
  }));
  rememberSongChoices(ctx, String(teamId), choices);
  const keyboard = new InlineKeyboard();
  choices.forEach((choice, index) => {
    keyboard.text(`${index + 1}. ${choice.title}`.slice(0, 64), `song:q:${choice.id}`).row();
  });
  await ctx.reply(
    `Нашёл несколько вариантов:\n` +
      results.map((s, index) => `${index + 1}. ${s.title}${s.artist ? ` — ${s.artist}` : ""}`).join("\n") +
      "\n\nНажми кнопку или напиши номер / точное название.",
    { reply_parameters: replyParameters, reply_markup: keyboard }
  );
}

async function replyWithPrivateSearchResults(ctx: MyContext, query: string): Promise<void> {
  const teams = await getTeamsForUser(ctx.from!.id);
  const replyParameters = { message_id: ctx.message!.message_id };
  if (!teams.length) {
    await ctx.reply("У тебя пока нет доступных команд. Сначала создай команду или прими приглашение 🙂", {
      reply_parameters: replyParameters,
    });
    return;
  }

  const matches = (await Promise.all(
    teams.map(async (team) => ({
      team,
      songs: await findSongsInTeam(team._id, query),
    }))
  )).flatMap(({ team, songs }) => songs.map((song) => ({ team, song })));

  if (!matches.length) {
    await ctx.reply(`Не нашёл песню, похожую на «${query}», ни в одной из твоих команд 🤔`, {
      reply_parameters: replyParameters,
    });
    return;
  }

  if (matches.length === 1) {
    await sendSongCard(ctx, matches[0].song, ctx.message!.message_id);
    return;
  }

  const keyboard = new InlineKeyboard();
  matches.slice(0, 10).forEach(({ team, song }) => {
    const artist = song.artist ? ` — ${song.artist}` : "";
    const label = `${song.title}${artist} · ${team.name}`.slice(0, 64);
    keyboard.text(label, `song:o:${song._id}`).row();
  });
  await ctx.reply("Нашёл несколько вариантов. Выбери песню и команду:", {
    reply_parameters: replyParameters,
    reply_markup: keyboard,
  });
}

async function replyWithSongList(ctx: MyContext): Promise<void> {
  const songs = await listSongsInTeam(ctx.team!._id);
  const replyParameters = { message_id: ctx.message!.message_id };
  if (!songs.length) {
    await ctx.reply("В команде пока нет добавленных песен 🎵", {
      reply_parameters: replyParameters,
    });
    return;
  }

  const limit = 20;
  const visible = songs.slice(0, limit);
  const remaining = songs.length - visible.length;
  await ctx.reply(
    `🎵 Песни команды (${songs.length}):\n\n` +
      visible.map((song) => `• ${song.title}${song.artist ? ` — ${song.artist}` : ""}`).join("\n") +
      (remaining > 0 ? `\n\nИ ещё ${remaining}. Полный список доступен в личном меню бота.` : ""),
    { reply_parameters: replyParameters }
  );
}

async function replyWithPrivateSongList(ctx: MyContext): Promise<void> {
  const teams = await getTeamsForUser(ctx.from!.id);
  const replyParameters = { message_id: ctx.message!.message_id };
  if (!teams.length) {
    await ctx.reply("У тебя пока нет доступных команд 🎵", {
      reply_parameters: replyParameters,
    });
    return;
  }

  const teamSongs = await Promise.all(
    teams.map(async (team) => ({ team, songs: await listSongsInTeam(team._id) }))
  );
  const total = teamSongs.reduce((sum, item) => sum + item.songs.length, 0);
  if (!total) {
    await ctx.reply("В твоих командах пока нет добавленных песен 🎵", {
      reply_parameters: replyParameters,
    });
    return;
  }

  let shown = 0;
  const limit = 25;
  const sections: string[] = [];
  for (const { team, songs } of teamSongs) {
    if (!songs.length || shown >= limit) continue;
    const visible = songs.slice(0, limit - shown);
    shown += visible.length;
    sections.push(
      `🎸 ${team.name}\n` +
      visible.map((song) => `• ${song.title}${song.artist ? ` — ${song.artist}` : ""}`).join("\n")
    );
  }

  await ctx.reply(
    `🎵 Твои песни (${total}):\n\n${sections.join("\n\n")}` +
      (total > shown ? `\n\nИ ещё ${total - shown}. Полный список доступен в разделе «Мои команды».` : ""),
    { reply_parameters: replyParameters }
  );
}

songQueryComposer.on("message:text", async (ctx, next) => {
    const isPrivate = ctx.chat.type === "private";
    if ((!ctx.team && !isPrivate) || ctx.from?.is_bot || ctx.message.text.startsWith("/")) {
      await next();
      return;
    }

    const text = ctx.message.text;

    // После неоднозначного поиска обычное сообщение вроде «Славь» или «1»
    // является выбором, даже если в нём нет слов «тональность»/«аккорды».
    if (!isPrivate && await replyWithPendingSongChoice(ctx, text)) return;

    if (isSongListQuestion(text)) {
      if (isPrivate) await replyWithPrivateSongList(ctx);
      else await replyWithSongList(ctx);
      return;
    }

    const hasKeyword = hasSongQuestionKeyword(text);

    if (hasKeyword) {
      // пытаемся вычленить название песни: убираем ключевые слова, оставляем остаток как поисковый запрос
      const query = extractSongQueryFromText(text);

      if (query.length < 2) {
        await ctx.reply("Уточни, о какой песне речь? Напиши хотя бы часть названия 🙂");
        return;
      }

      if (isPrivate) await replyWithPrivateSearchResults(ctx, query);
      else await replyWithSearchResults(ctx, ctx.team!._id, query);
      return;
    }

    await next();
});

songQueryComposer.callbackQuery(/^song:q:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.team) {
    await ctx.reply("Эта кнопка работает только в подключённой группе команды.");
    return;
  }

  const songId = ctx.callbackQuery.data.split(":")[2];
  const song = await Song.findOne({ _id: songId, team: ctx.team._id });
  if (!song) {
    await ctx.reply("Песня не найдена в этой команде.");
    return;
  }

  clearSongChoices(ctx);
  await ctx.editMessageText(formatSongCard(song), { parse_mode: "HTML", reply_markup: await groupSongKeyboard(ctx, song) });
});
