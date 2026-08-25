import { Conversation } from "@grammyjs/conversations";
import { InlineKeyboard } from "grammy";
import { MyContext } from "../context";
import { combineDateAndTime, parseRussianDate, parseRussianDateTime, parseRussianTime } from "../../services/date-parser.service";
import { escapeHtml, formatEventDateTime, formatRehearsalCard } from "../../services/event-format.service";
import { createRehearsal, listUpcomingRehearsals, moveRehearsal, saveAttendance } from "../../services/rehearsal.service";
import { getAdminTeams, isAdmin } from "../../services/teamService";
import { createWorshipService, listUpcomingServices, moveWorshipService, replaceSetlist, updateSetlistKey } from "../../services/worship-service.service";
import { notifyTeamGroup, pinServiceAnnouncement, sendTeamGroupMessage } from "../../services/notification.service";
import { roleIconHtml, rolePresentation } from "../../services/message-intent.service";
import { Rehearsal } from "../../models/Rehearsal";
import { WorshipService } from "../../models/WorshipService";
import { createSong, findSongsInTeam, updateSong } from "../../services/songService";
import { upsertUser } from "../../services/teamService";
import { formatSongCard } from "../views/songCard";

type MyConversation = Conversation<MyContext, MyContext>;

type ManualLineupEntry = { role: string; slotLabel: string; displayName: string; userTelegramId?: number };
type SetlistSection = "main" | "transition" | "offering";
type DraftSong = {
  id: string;
  title: string;
  artist?: string;
  key?: string;
  tempo?: number;
  genre?: string;
  chords?: string;
  timeSignature?: string;
  notes?: string;
};
type DraftSetlistItem = DraftSong & { section: SetlistSection };
type DraftRehearsal = { startsAt: Date; location?: string; comment?: string };
type StepResult<T> = { action: "value"; value: T } | { action: "back" } | { action: "cancel" };

const LINEUP_SLOTS = [
  { role: "vocal", label: "Вокал" },
  { role: "vocal", label: "Бэк-вокал" },
  { role: "acoustic_guitar", label: "Акустическая гитара" },
  { role: "electric_guitar", label: "Электрогитара 1" },
  { role: "electric_guitar", label: "Электрогитара 2" },
  { role: "bass", label: "Бас" },
  { role: "keys", label: "Клавиши" },
  { role: "drums", label: "Барабаны" },
  { role: "saxophone", label: "Саксофон" },
] as const;

function formatManualLineup(lineup: ManualLineupEntry[]): string {
  return lineup.map((item) => {
    return `${roleIconHtml(item.role)} <b>${escapeHtml(item.slotLabel)}</b> — ${escapeHtml(item.displayName)}`;
  }).join("\n");
}

function navigationKeyboard(withSkip = false): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (withSkip) keyboard.text("⏭ Пропустить", "wf:skip").row();
  return keyboard.text("⬅️ Назад", "wf:back").text("❌ Отмена", "wf:cancel");
}

async function cleanupStep(ctx: MyContext, promptMessageId?: number, inputMessageId?: number): Promise<void> {
  if (!ctx.chat) return;
  const messageIds = [promptMessageId, inputMessageId];
  for (const messageId of messageIds) {
    if (!messageId) continue;
    try { await ctx.api.deleteMessage(ctx.chat.id, messageId); } catch { /* Сообщение уже удалено или недоступно. */ }
  }
}

async function askNavigableText(
  conversation: MyConversation,
  ctx: MyContext,
  prompt: string,
  optional = false
): Promise<StepResult<string | undefined>> {
  const promptMessage = await ctx.reply(prompt, { reply_markup: navigationKeyboard(optional) });
  while (true) {
    const answer = await conversation.wait();
    const callback = answer.callbackQuery?.data;
    if (callback === "wf:back" || callback === "wf:cancel" || (optional && callback === "wf:skip")) {
      await answer.answerCallbackQuery();
      await cleanupStep(ctx, promptMessage.message_id);
      if (callback === "wf:back") return { action: "back" };
      if (callback === "wf:cancel") return { action: "cancel" };
      return { action: "value", value: undefined };
    }
    const value = answer.message?.text?.trim();
    if (value) {
      await cleanupStep(ctx, promptMessage.message_id, answer.message?.message_id);
      return { action: "value", value };
    }
    if (answer.callbackQuery) await answer.answerCallbackQuery({ text: "Используй кнопки под последним вопросом" });
  }
}

async function askChoice<T extends string>(
  conversation: MyConversation,
  ctx: MyContext,
  prompt: string,
  choices: Array<{ label: string; value: T }>
): Promise<StepResult<T>> {
  const keyboard = new InlineKeyboard();
  choices.forEach((choice) => keyboard.text(choice.label, `wf:choice:${choice.value}`));
  keyboard.row().text("⬅️ Назад", "wf:back").text("❌ Отмена", "wf:cancel");
  const promptMessage = await ctx.reply(prompt, { reply_markup: keyboard });
  while (true) {
    const answer = await conversation.waitForCallbackQuery(/^wf:(choice:[a-z0-9_-]+|back|cancel)$/i);
    await answer.answerCallbackQuery();
    await cleanupStep(ctx, promptMessage.message_id);
    const data = answer.callbackQuery.data;
    if (data === "wf:back") return { action: "back" };
    if (data === "wf:cancel") return { action: "cancel" };
    const value = data.slice("wf:choice:".length) as T;
    if (choices.some((choice) => choice.value === value)) return { action: "value", value };
  }
}

async function askNaturalDateTime(
  conversation: MyConversation,
  ctx: MyContext,
  title: string
): Promise<StepResult<Date>> {
  while (true) {
    const raw = await askNavigableText(conversation, ctx, `${title}\n\nМожно написать одним сообщением: «в пятницу в 21:00», «28.08 в 19:30» или просто «в среду».`);
    if (raw.action !== "value") return raw;
    const combined = parseRussianDateTime(raw.value!);
    if (combined?.value && combined.value > new Date()) return { action: "value", value: combined.value };
    const date = parseRussianDate(raw.value!);
    if (!date) {
      await ctx.reply("Не понял дату. Например: «в пятницу в 21:00» или «28.08.2026 в 19:00».");
      continue;
    }
    const timeRaw = await askNavigableText(conversation, ctx, "🕖 Во сколько? Например, 19:00");
    if (timeRaw.action === "cancel") return timeRaw;
    if (timeRaw.action === "back") continue;
    const time = parseRussianTime(timeRaw.value!);
    if (!time) {
      await ctx.reply("Не понял время. Используй формат 19:00.");
      continue;
    }
    const value = combineDateAndTime(date, time);
    if (value <= new Date()) {
      await ctx.reply("Это время уже прошло. Укажи будущую дату.");
      continue;
    }
    return { action: "value", value };
  }
}

function serviceLineupKeyboard(selected: number[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  LINEUP_SLOTS.forEach((slot, index) => keyboard.text(`${selected.includes(index) ? "✅ " : ""}${slot.label}`, `wfl:t:${index}`).row());
  keyboard.text("✅ Инструменты выбраны", "wfl:done").row();
  keyboard.text("⬅️ Назад", "wfl:back").text("❌ Отмена", "wfl:cancel");
  return keyboard;
}

async function collectServiceLineup(
  conversation: MyConversation,
  ctx: MyContext,
  initial: ManualLineupEntry[] = []
): Promise<StepResult<ManualLineupEntry[]>> {
  const selected = LINEUP_SLOTS.map((slot, index) => initial.some((item) => item.slotLabel === slot.label) ? index : -1).filter((index) => index >= 0);
  const lineupPrompt = await ctx.reply("👥 <b>СОСТАВ КОМАНДЫ</b>\n\nОтметь все позиции на служении. Этот состав автоматически будет использоваться и для связанных репетиций.", { parse_mode: "HTML", reply_markup: serviceLineupKeyboard(selected) });
  while (true) {
    const answer = await conversation.waitForCallbackQuery(/^wfl:(t:\d+|done|back|cancel)$/);
    const data = answer.callbackQuery.data;
    await answer.answerCallbackQuery();
    if (data === "wfl:back") { await cleanupStep(ctx, lineupPrompt.message_id); return { action: "back" }; }
    if (data === "wfl:cancel") { await cleanupStep(ctx, lineupPrompt.message_id); return { action: "cancel" }; }
    if (data === "wfl:done") {
      if (!selected.length) {
        await ctx.reply("Выбери хотя бы одну позицию.");
        continue;
      }
      await cleanupStep(ctx, lineupPrompt.message_id);
      break;
    }
    const index = Number(data.split(":")[2]);
    if (!LINEUP_SLOTS[index]) continue;
    const current = selected.indexOf(index);
    if (current >= 0) selected.splice(current, 1); else selected.push(index);
    selected.sort((left, right) => left - right);
    await answer.editMessageReplyMarkup({ reply_markup: serviceLineupKeyboard(selected) });
  }

  const lineup: ManualLineupEntry[] = [];
  let position = 0;
  while (position < selected.length) {
    const slot = LINEUP_SLOTS[selected[position]];
    const previous = initial.find((item) => item.slotLabel === slot.label)?.displayName;
    const name = await askNavigableText(conversation, ctx, `👤 Кто будет на позиции «${slot.label}»?${previous ? `\nСейчас: ${previous}` : ""}`);
    if (name.action === "cancel") return name;
    if (name.action === "back") {
      if (position === 0) return collectServiceLineup(conversation, ctx, initial);
      position -= 1;
      lineup.pop();
      continue;
    }
    if (!name.value || name.value.length > 100) {
      await ctx.reply("Имя должно содержать от 1 до 100 символов.");
      continue;
    }
    lineup.push({ role: slot.role, slotLabel: slot.label, displayName: name.value });
    position += 1;
  }
  return { action: "value", value: lineup };
}

function plainSong(song: any): DraftSong {
  return {
    id: String(song._id ?? song.id), title: song.title, artist: song.artist ?? undefined,
    key: song.key ?? undefined, tempo: song.tempo ?? undefined, genre: song.genre ?? undefined,
    chords: song.chords ?? undefined, timeSignature: song.timeSignature ?? undefined,
    notes: song.notes ?? undefined,
  };
}

async function quickCreateSong(
  conversation: MyConversation,
  ctx: MyContext,
  teamId: string,
  suggestedTitle: string
): Promise<StepResult<DraftSong>> {
  const title = await askNavigableText(conversation, ctx, `➕ Добавляем новую песню.\n\nНазвание (ты искал «${suggestedTitle}»):`, false);
  if (title.action !== "value") return title as StepResult<DraftSong>;
  const artist = await askNavigableText(conversation, ctx, "🎤 Исполнитель:", true);
  if (artist.action !== "value") return artist as StepResult<DraftSong>;
  const key = await askNavigableText(conversation, ctx, "🎹 Тональность:", true);
  if (key.action !== "value") return key as StepResult<DraftSong>;
  let tempo: number | undefined;
  while (true) {
    const tempoRaw = await askNavigableText(conversation, ctx, "⏱ Темп в BPM:", true);
    if (tempoRaw.action !== "value") return tempoRaw as StepResult<DraftSong>;
    if (!tempoRaw.value) break;
    const parsedTempo = Number(tempoRaw.value.replace(",", "."));
    if (Number.isFinite(parsedTempo) && parsedTempo >= 1 && parsedTempo <= 500) {
      tempo = parsedTempo;
      break;
    }
    await ctx.reply("Темп должен быть числом от 1 до 500 BPM.");
  }
  const created = await conversation.external(async () => {
    const user = await upsertUser(ctx.from!.id, ctx.from!.first_name, ctx.from!.username);
    const song = await createSong({ team: teamId, title: title.value || suggestedTitle, artist: artist.value, key: key.value, tempo, createdBy: user._id });
    return plainSong(song.toObject());
  });
  await ctx.reply("✅ Песня добавлена в базу команды.");
  return { action: "value", value: created };
}

async function editSongDuringService(
  conversation: MyConversation,
  ctx: MyContext,
  teamId: string,
  song: DraftSong
): Promise<StepResult<DraftSong>> {
  const field = await askChoice(conversation, ctx, `✏️ Что изменить в «${song.title}»?`, [
    { label: "Название", value: "title" }, { label: "Исполнитель", value: "artist" },
    { label: "Тональность", value: "key" }, { label: "BPM", value: "tempo" },
  ]);
  if (field.action !== "value") return field as StepResult<DraftSong>;
  const value = await askNavigableText(conversation, ctx, "Введи новое значение:");
  if (value.action !== "value") return value as StepResult<DraftSong>;
  const update: Record<string, string | number> = field.value === "tempo" ? { tempo: Number(value.value) } : { [field.value]: value.value! };
  if (field.value === "tempo" && (!Number.isFinite(update.tempo) || Number(update.tempo) < 1 || Number(update.tempo) > 500)) {
    await ctx.reply("BPM должен быть числом от 1 до 500.");
    return editSongDuringService(conversation, ctx, teamId, song);
  }
  const updated = await conversation.external(async () => {
    const result = await updateSong(teamId, song.id, update);
    return result ? plainSong(result.toObject()) : null;
  });
  if (!updated) return { action: "back" };
  await ctx.reply("✅ Карточка песни обновлена.");
  return { action: "value", value: updated };
}

async function chooseSong(
  conversation: MyConversation,
  ctx: MyContext,
  teamId: string,
  label: string
): Promise<StepResult<DraftSong>> {
  while (true) {
    const query = await askNavigableText(conversation, ctx, `🎵 ${label}\n\nНапиши часть названия — можно с небольшой опечаткой.`);
    if (query.action !== "value") return query as StepResult<DraftSong>;
    let matches = await conversation.external(async () => (await findSongsInTeam(teamId, query.value!)).map((song) => plainSong(song.toObject())));
    if (!matches.length) {
      const missing = await askChoice(conversation, ctx, `По запросу «${query.value}» ничего не найдено.`, [
        { label: "➕ Добавить песню", value: "add" }, { label: "🔎 Искать ещё", value: "search" },
      ]);
      if (missing.action !== "value") return missing as StepResult<DraftSong>;
      if (missing.value === "add") {
        const created = await quickCreateSong(conversation, ctx, teamId, query.value!);
        if (created.action === "value") return created;
        if (created.action === "cancel") return created;
      }
      continue;
    }
    let index = 0;
    while (index < matches.length) {
      const candidate = matches[index];
      const keyboard = new InlineKeyboard()
        .text("✅ Она", "wfs:yes").text("➡️ Другой вариант", "wfs:next").row()
        .text("✏️ Редактировать", "wfs:edit").text("➕ Новая песня", "wfs:add").row()
        .text("⬅️ Назад", "wfs:back").text("❌ Отмена", "wfs:cancel");
      const candidateMessage = await ctx.reply(`${formatSongCard(candidate)}\n\nЭто нужная песня?`, { parse_mode: "HTML", reply_markup: keyboard });
      const answer = await conversation.waitForCallbackQuery(/^wfs:(yes|next|edit|add|back|cancel)$/);
      await answer.answerCallbackQuery();
      await cleanupStep(ctx, candidateMessage.message_id);
      const action = answer.callbackQuery.data.split(":")[1];
      if (action === "yes") return { action: "value", value: candidate };
      if (action === "cancel") return { action: "cancel" };
      if (action === "back") break;
      if (action === "add") {
        const created = await quickCreateSong(conversation, ctx, teamId, query.value!);
        if (created.action === "value" || created.action === "cancel") return created;
        continue;
      }
      if (action === "edit") {
        const edited = await editSongDuringService(conversation, ctx, teamId, candidate);
        if (edited.action === "cancel") return edited;
        if (edited.action === "value") matches[index] = edited.value;
        continue;
      }
      index += 1;
      if (index >= matches.length) {
        await ctx.reply("Других похожих вариантов нет. Попробуй другой запрос или добавь новую песню.");
        break;
      }
    }
  }
}

async function askSongCount(conversation: MyConversation, ctx: MyContext, prompt: string): Promise<StepResult<number>> {
  while (true) {
    const result = await askNavigableText(conversation, ctx, prompt);
    if (result.action !== "value") return result as StepResult<number>;
    const count = Number(result.value);
    if (Number.isInteger(count) && count >= 1 && count <= 20) return { action: "value", value: count };
    await ctx.reply("Введи целое число от 1 до 20.");
  }
}

async function collectSectionSongs(
  conversation: MyConversation,
  ctx: MyContext,
  teamId: string,
  section: SetlistSection,
  title: string,
  count: number
): Promise<StepResult<DraftSetlistItem[]>> {
  const songs: DraftSetlistItem[] = [];
  let index = 0;
  while (index < count) {
    const selected = await chooseSong(conversation, ctx, teamId, `${title}: песня ${index + 1} из ${count}`);
    if (selected.action === "cancel") return selected as StepResult<DraftSetlistItem[]>;
    if (selected.action === "back") {
      if (index === 0) return { action: "back" };
      songs.pop();
      index -= 1;
      continue;
    }
    songs.push({ ...selected.value, section });
    index += 1;
  }
  return { action: "value", value: songs };
}

async function collectSetlist(
  conversation: MyConversation,
  ctx: MyContext,
  teamId: string
): Promise<StepResult<DraftSetlistItem[]>> {
  const mainCount = await askSongCount(conversation, ctx, "🎵 Сколько песен будет в основном блоке?");
  if (mainCount.action !== "value") return mainCount as StepResult<DraftSetlistItem[]>;
  const main = await collectSectionSongs(conversation, ctx, teamId, "main", "Основной блок", mainCount.value);
  if (main.action !== "value") return main;

  const transitionChoice = await askChoice(conversation, ctx, "Будет песня или отдельный блок между основным блоком и пожертвованием?", [
    { label: "✅ Да", value: "yes" }, { label: "⏭ Нет, пропустить", value: "no" },
  ]);
  if (transitionChoice.action === "cancel") return transitionChoice as StepResult<DraftSetlistItem[]>;
  if (transitionChoice.action === "back") return collectSetlist(conversation, ctx, teamId);
  let transition: DraftSetlistItem[] = [];
  if (transitionChoice.value === "yes") {
    const count = await askSongCount(conversation, ctx, "Сколько песен будет в блоке «Между»?");
    if (count.action !== "value") return count.action === "cancel" ? count as StepResult<DraftSetlistItem[]> : collectSetlist(conversation, ctx, teamId);
    const selected = await collectSectionSongs(conversation, ctx, teamId, "transition", "Между", count.value);
    if (selected.action !== "value") return selected.action === "cancel" ? selected : collectSetlist(conversation, ctx, teamId);
    transition = selected.value;
  }

  const offeringChoice = await askChoice(conversation, ctx, "Будет песня на пожертвование?", [
    { label: "✅ Да, одна", value: "yes" }, { label: "⏭ Нет, пропустить", value: "no" },
  ]);
  if (offeringChoice.action === "cancel") return offeringChoice as StepResult<DraftSetlistItem[]>;
  if (offeringChoice.action === "back") return collectSetlist(conversation, ctx, teamId);
  let offering: DraftSetlistItem[] = [];
  if (offeringChoice.value === "yes") {
    const selected = await collectSectionSongs(conversation, ctx, teamId, "offering", "Пожертвование", 1);
    if (selected.action !== "value") return selected.action === "cancel" ? selected : collectSetlist(conversation, ctx, teamId);
    offering = selected.value;
  }
  return { action: "value", value: [...main.value, ...transition, ...offering] };
}

async function collectRehearsalsForService(
  conversation: MyConversation,
  ctx: MyContext,
  defaultLocation?: string
): Promise<StepResult<DraftRehearsal[]>> {
  const first = await askChoice(conversation, ctx, "Добавить репетицию к этому служению?", [
    { label: "✅ Да", value: "yes" }, { label: "⏭ Пока нет", value: "no" },
  ]);
  if (first.action !== "value") return first as StepResult<DraftRehearsal[]>;
  if (first.value === "no") return { action: "value", value: [] };
  const rehearsals: DraftRehearsal[] = [];
  while (true) {
    const startsAt = await askNaturalDateTime(conversation, ctx, "🎸 Когда будет репетиция?");
    if (startsAt.action === "cancel") return startsAt as StepResult<DraftRehearsal[]>;
    if (startsAt.action === "back") {
      if (!rehearsals.length) return collectRehearsalsForService(conversation, ctx, defaultLocation);
      rehearsals.pop();
      continue;
    }
    const location = await askNavigableText(conversation, ctx, `📍 Где будет репетиция?${defaultLocation ? `\nМесто служения: ${defaultLocation}` : ""}`, true);
    if (location.action === "cancel") return location as StepResult<DraftRehearsal[]>;
    if (location.action === "back") continue;
    rehearsals.push({ startsAt: startsAt.value, location: location.value ?? defaultLocation });
    const more = await askChoice(conversation, ctx, "Добавить ещё одну репетицию?", [
      { label: "➕ Ещё репетиция", value: "yes" }, { label: "✅ Готово", value: "no" },
    ]);
    if (more.action === "cancel") return more as StepResult<DraftRehearsal[]>;
    if (more.action === "back") {
      rehearsals.pop();
      continue;
    }
    if (more.value === "no") return { action: "value", value: rehearsals };
  }
}

const SECTION_TITLES: Record<SetlistSection, string> = {
  main: "Основной блок", transition: "Между", offering: "Пожертвование",
};

function formatDraftSetlist(setlist: DraftSetlistItem[]): string {
  const lines: string[] = [];
  for (const section of ["main", "transition", "offering"] as SetlistSection[]) {
    const items = setlist.filter((item) => item.section === section);
    if (!items.length) continue;
    lines.push(`<b>${SECTION_TITLES[section]}</b>`);
    items.forEach((item, index) => lines.push(`${index + 1}. ${escapeHtml(item.title)}${item.key ? ` — ${escapeHtml(item.key)}` : ""}`));
  }
  return lines.join("\n");
}

async function askText(conversation: MyConversation, ctx: MyContext, prompt: string): Promise<string> {
  await ctx.reply(prompt);
  const answer = await conversation.waitFor("message:text");
  return answer.message.text.trim();
}

async function selectAdminTeam(conversation: MyConversation, ctx: MyContext, initialTeamId?: string) {
  const teams = await conversation.external(async () => (await getAdminTeams(ctx.from!.id)).map((team) => ({ id: String(team._id), name: team.name })));
  if (!teams.length) {
    await ctx.reply("У тебя нет команд, которыми ты можешь управлять.");
    return null;
  }
  if (initialTeamId) {
    const team = teams.find((item) => item.id === initialTeamId);
    if (!team) await ctx.reply("У тебя нет прав администратора этой команды.");
    return team ?? null;
  }
  if (teams.length === 1) return teams[0];
  const keyboard = new InlineKeyboard();
  teams.forEach((team) => keyboard.text(team.name, `sf:t:${team.id}`).row());
  await ctx.reply("Выбери команду:", { reply_markup: keyboard });
  const answer = await conversation.waitForCallbackQuery(/^sf:t:/);
  await answer.answerCallbackQuery();
  return teams.find((item) => item.id === answer.callbackQuery.data.split(":")[2]) ?? null;
}

async function askFutureDateTime(conversation: MyConversation, ctx: MyContext): Promise<Date> {
  while (true) {
    const dateText = await askText(conversation, ctx, "📅 Введи дату: например, 28.08.2026, завтра или в пятницу");
    const date = parseRussianDate(dateText);
    if (!date) {
      await ctx.reply("Не понял дату. Попробуй формат 28.08.2026 или «в пятницу».");
      continue;
    }
    const timeText = await askText(conversation, ctx, "🕖 Введи время: например, 19:00");
    const time = parseRussianTime(timeText);
    if (!time) {
      await ctx.reply("Не понял время. Начни добавление заново и используй формат 19:00.");
      continue;
    }
    const startsAt = combineDateAndTime(date, time);
    if (startsAt <= new Date()) {
      await ctx.reply("Эта дата уже в прошлом. Укажи будущую дату.");
      continue;
    }
    return startsAt;
  }
}

async function confirm(conversation: MyConversation, ctx: MyContext, text: string): Promise<boolean> {
  const keyboard = new InlineKeyboard().text("✅ Подтвердить", "sf:yes").text("❌ Отмена", "sf:no");
  const prompt = await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
  const answer = await conversation.waitForCallbackQuery(/^sf:(yes|no)$/);
  await answer.answerCallbackQuery();
  await cleanupStep(ctx, prompt.message_id);
  return answer.callbackQuery.data === "sf:yes";
}

async function confirmWithLineupEdit(conversation: MyConversation, ctx: MyContext, text: string): Promise<"yes" | "edit" | "no"> {
  const keyboard = new InlineKeyboard().text("✅ Подтвердить", "sf:yes").row().text("✏️ Изменить состав", "sf:lineup").text("❌ Отмена", "sf:no");
  const prompt = await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
  const answer = await conversation.waitForCallbackQuery(/^sf:(yes|lineup|no)$/);
  await answer.answerCallbackQuery();
  await cleanupStep(ctx, prompt.message_id);
  return answer.callbackQuery.data === "sf:yes" ? "yes" : answer.callbackQuery.data === "sf:lineup" ? "edit" : "no";
}

export async function rehearsalFlow(conversation: MyConversation, ctx: MyContext, initialTeamId?: string, initialStartsAt?: string) {
  const team = await selectAdminTeam(conversation, ctx, initialTeamId);
  if (!team) return;
  let dateResult: StepResult<Date>;
  if (initialStartsAt?.startsWith("date:")) {
    const date = new Date(initialStartsAt.slice(5));
    const timeRaw = await askNavigableText(conversation, ctx, `📅 Запомнил дату: ${formatEventDateTime(date).split(",")[0]}.\n\n🕖 Во сколько будет репетиция? Например, 19:00`);
    if (timeRaw.action !== "value") return void (await ctx.reply("Добавление репетиции отменено."));
    const time = parseRussianTime(timeRaw.value!);
    if (!time) return void (await ctx.reply("Не понял время. Запусти добавление ещё раз и напиши, например, 19:00."));
    dateResult = { action: "value", value: combineDateAndTime(date, time) };
  } else {
    dateResult = initialStartsAt ? { action: "value", value: new Date(initialStartsAt) } : await askNaturalDateTime(conversation, ctx, "🎸 Когда будет репетиция?");
  }
  if (dateResult.action !== "value") return void (await ctx.reply("Добавление репетиции отменено."));
  const startsAt = dateResult.value;
  if (!Number.isFinite(startsAt.getTime()) || startsAt <= new Date()) return void (await ctx.reply("Предложенная дата уже недоступна. Запусти /rehearsal_add заново."));
  const locationResult = await askNavigableText(conversation, ctx, "📍 Место репетиции:", true);
  if (locationResult.action !== "value") return void (await ctx.reply("Добавление репетиции отменено."));
  const commentResult = await askNavigableText(conversation, ctx, "💬 Комментарий:", true);
  if (commentResult.action !== "value") return void (await ctx.reply("Добавление репетиции отменено."));
  const locationText = locationResult.value;
  const commentText = commentResult.value;
  const services = await conversation.external(async () => (await listUpcomingServices(team.id, 8)).map((service) => ({ id: service.id, label: `${service.title} — ${formatEventDateTime(service.startsAt)}` })));
  let serviceId: string | undefined;
  if (services.length) {
    const keyboard = new InlineKeyboard().text("Без привязки", "sf:s:none").row();
    services.forEach((service) => keyboard.text(service.label.slice(0, 60), `sf:s:${service.id}`).row());
    keyboard.text("❌ Отмена", "sf:s:cancel");
    const servicePrompt = await ctx.reply("Связать репетицию со служением?", { reply_markup: keyboard });
    const answer = await conversation.waitForCallbackQuery(/^sf:s:/);
    await answer.answerCallbackQuery();
    await cleanupStep(ctx, servicePrompt.message_id);
    const selected = answer.callbackQuery.data.split(":")[2];
    if (selected === "cancel") return void (await ctx.reply("Добавление репетиции отменено."));
    if (selected !== "none") serviceId = selected;
  }
  let lineup: ManualLineupEntry[];
  if (serviceId) {
    lineup = await conversation.external(async () => {
      const service = await WorshipService.findById(serviceId).lean();
      return service?.lineup.map((item) => ({
        role: item.role,
        slotLabel: item.slotLabel ?? rolePresentation(item.role).label,
        displayName: item.displayName ?? "Не указано",
        userTelegramId: item.userTelegramId ?? undefined,
      })) ?? [];
    });
  } else {
    const lineupResult = await collectServiceLineup(conversation, ctx);
    if (lineupResult.action !== "value") return void (await ctx.reply("Добавление репетиции отменено."));
    lineup = lineupResult.value;
  }
  while (true) {
    const preview = `${formatRehearsalCard({ startsAt, location: locationText, comment: commentText })}\n\n👥 <b>СОСТАВ</b>\n${formatManualLineup(lineup)}`;
    const decision = serviceId
      ? (await confirm(conversation, ctx, `${preview}\n\nСохранить репетицию?`) ? "yes" : "no")
      : await confirmWithLineupEdit(conversation, ctx, `${preview}\n\nСохранить репетицию?`);
    if (decision === "no") return void (await ctx.reply("Добавление отменено."));
    if (decision === "edit") {
      const changed = await collectServiceLineup(conversation, ctx, lineup);
      if (changed.action !== "value") return void (await ctx.reply("Добавление репетиции отменено."));
      lineup = changed.value;
      continue;
    }
    break;
  }
  const created = await conversation.external(async () => {
    const rehearsal = await createRehearsal({ team: team.id, service: serviceId, startsAt, location: locationText, comment: commentText, lineup, createdBy: ctx.from!.id });
    return { id: rehearsal.id, startsAt: rehearsal.startsAt.toISOString(), location: rehearsal.location, comment: rehearsal.comment, lineup: rehearsal.lineup.map((item) => ({ role: item.role, slotLabel: item.slotLabel, displayName: item.displayName })) };
  });
  const message = `✅ <b>Репетиция добавлена</b>\n\n${formatRehearsalCard({ ...created, startsAt: new Date(created.startsAt) })}`;
  await ctx.reply(message, { parse_mode: "HTML" });
  if (ctx.chat?.type === "private") await notifyTeamGroup(ctx.api, team.id, message);
  console.log(`[REHEARSAL] created id=${created.id} team=${team.id}`);
}

export async function editRehearsalFlow(conversation: MyConversation, ctx: MyContext, initialTeamId?: string, initialRehearsalId?: string) {
  const team = await selectAdminTeam(conversation, ctx, initialTeamId);
  if (!team) return;
  const rehearsals = (await conversation.external(async () => (await listUpcomingRehearsals(team.id, 10)).map((item) => ({ id: item.id, startsAt: item.startsAt.toISOString(), location: item.location })))).map((item) => ({ ...item, startsAt: new Date(item.startsAt) }));
  if (!rehearsals.length) return void (await ctx.reply("Нет предстоящих репетиций для переноса."));
  let rehearsal = rehearsals.find((item) => item.id === initialRehearsalId);
  if (!rehearsal) {
    const keyboard = new InlineKeyboard();
    rehearsals.forEach((item) => keyboard.text(formatEventDateTime(item.startsAt), `sf:e:${item.id}`).row());
    await ctx.reply("Какую репетицию перенести?", { reply_markup: keyboard });
    const answer = await conversation.waitForCallbackQuery(/^sf:e:/);
    await answer.answerCallbackQuery();
    rehearsal = rehearsals.find((item) => item.id === answer.callbackQuery.data.split(":")[2]);
  }
  if (!rehearsal) return;
  const newStartsAt = await askFutureDateTime(conversation, ctx);
  const locationText = await askText(conversation, ctx, `📍 Новое место или /keep, чтобы оставить «${rehearsal.location ?? "не указано"}»:`);
  const location = locationText === "/keep" ? rehearsal.location ?? undefined : locationText;
  const preview = `🔄 <b>ПЕРЕНОС РЕПЕТИЦИИ</b>\n\nБыло: ${formatEventDateTime(rehearsal.startsAt)}\nСтало: ${formatEventDateTime(newStartsAt)}${location ? `\n📍 ${escapeHtml(location)}` : ""}`;
  if (!await confirm(conversation, ctx, `${preview}\n\nСохранить изменения?`)) return void (await ctx.reply("Перенос отменён."));
  const updated = await conversation.external(async () => Boolean(await moveRehearsal(team.id, rehearsal!.id, newStartsAt, ctx.from!.id, location)));
  if (!updated) return void (await ctx.reply("Репетиция уже недоступна."));
  await ctx.reply(`✅ ${preview}`, { parse_mode: "HTML" });
  if (ctx.chat?.type === "private") await notifyTeamGroup(ctx.api, team.id, preview);
}

export async function serviceFlow(conversation: MyConversation, ctx: MyContext, initialTeamId?: string) {
  const team = await selectAdminTeam(conversation, ctx, initialTeamId);
  if (!team) return;
  let startsAt: Date | undefined;
  let title = "Служение";
  let location: string | undefined;
  let soundcheckAt: Date | undefined;
  let lineup: ManualLineupEntry[] = [];
  let setlist: DraftSetlistItem[] = [];
  let rehearsals: DraftRehearsal[] = [];
  let stage = 0;

  while (true) {
    while (stage <= 6) {
      if (stage === 0) {
        const result = await askNaturalDateTime(conversation, ctx, "⛪ Когда начнётся служение?");
        if (result.action === "cancel" || result.action === "back") return void (await ctx.reply("Добавление служения отменено."));
        startsAt = result.value;
        stage = 1;
      } else if (stage === 1) {
        const result = await askNavigableText(conversation, ctx, "⛪ Название служения:", true);
        if (result.action === "cancel") return void (await ctx.reply("Добавление служения отменено."));
        if (result.action === "back") { stage = 0; continue; }
        title = result.value || "Служение";
        stage = 2;
      } else if (stage === 2) {
        const result = await askNavigableText(conversation, ctx, "📍 Место служения:", true);
        if (result.action === "cancel") return void (await ctx.reply("Добавление служения отменено."));
        if (result.action === "back") { stage = 1; continue; }
        location = result.value;
        stage = 3;
      } else if (stage === 3) {
        const choice = await askChoice(conversation, ctx, "Добавить саундчек?", [
          { label: "✅ Да", value: "yes" }, { label: "⏭ Пропустить", value: "no" },
        ]);
        if (choice.action === "cancel") return void (await ctx.reply("Добавление служения отменено."));
        if (choice.action === "back") { stage = 2; continue; }
        soundcheckAt = undefined;
        if (choice.value === "yes") {
          const raw = await askNavigableText(conversation, ctx, "🎚 Во сколько саундчек? Например, 09:00");
          if (raw.action === "cancel") return void (await ctx.reply("Добавление служения отменено."));
          if (raw.action === "back") continue;
          const time = parseRussianTime(raw.value!);
          if (!time || !startsAt) { await ctx.reply("Не понял время саундчека."); continue; }
          soundcheckAt = combineDateAndTime(startsAt, time);
          if (soundcheckAt >= startsAt) { soundcheckAt = undefined; await ctx.reply("Саундчек должен быть раньше служения."); continue; }
        }
        stage = 4;
      } else if (stage === 4) {
        const result = await collectServiceLineup(conversation, ctx, lineup);
        if (result.action === "cancel") return void (await ctx.reply("Добавление служения отменено."));
        if (result.action === "back") { stage = 3; continue; }
        lineup = result.value;
        stage = 5;
      } else if (stage === 5) {
        const result = await collectSetlist(conversation, ctx, team.id);
        if (result.action === "cancel") return void (await ctx.reply("Добавление служения отменено."));
        if (result.action === "back") { stage = 4; continue; }
        setlist = result.value;
        stage = 6;
      } else {
        const result = await collectRehearsalsForService(conversation, ctx, location);
        if (result.action === "cancel") return void (await ctx.reply("Добавление служения отменено."));
        if (result.action === "back") { stage = 5; continue; }
        rehearsals = result.value;
        stage = 7;
      }
    }

    const eventPreview = [
      `⛪ <b>${escapeHtml(title)}</b>`, `📅 ${escapeHtml(formatEventDateTime(startsAt!))}`,
      ...(soundcheckAt ? [`🎚 Саундчек: ${escapeHtml(formatEventDateTime(soundcheckAt))}`] : []),
      ...(location ? [`📍 ${escapeHtml(location)}`] : []), "", "👥 <b>СОСТАВ</b>", formatManualLineup(lineup),
      "", "🎵 <b>ПЕСНИ</b>", formatDraftSetlist(setlist), "", "🎸 <b>РЕПЕТИЦИИ</b>",
      ...(rehearsals.length ? rehearsals.map((item) => `• ${escapeHtml(formatEventDateTime(item.startsAt))}${item.location ? ` — ${escapeHtml(item.location)}` : ""}`) : ["Пока не добавлены"]),
    ].join("\n");
    const keyboard = new InlineKeyboard().text("✅ Сохранить и отправить", "wf:save").row()
      .text("📅 Данные", "wf:edit:details").text("👥 Состав", "wf:edit:lineup").row()
      .text("🎵 Песни", "wf:edit:songs").text("🎸 Репетиции", "wf:edit:rehearsals").row()
      .text("❌ Отмена", "wf:cancel");
    const previewMessage = await ctx.reply(`${eventPreview}\n\nПроверь всё перед отправкой:`, { parse_mode: "HTML", reply_markup: keyboard });
    const answer = await conversation.waitForCallbackQuery(/^wf:(save|cancel|edit:(details|lineup|songs|rehearsals))$/);
    await answer.answerCallbackQuery();
    await cleanupStep(ctx, previewMessage.message_id);
    const action = answer.callbackQuery.data;
    if (action === "wf:cancel") return void (await ctx.reply("Добавление служения отменено."));
    if (action === "wf:edit:details") {
      const date = await askNaturalDateTime(conversation, ctx, "⛪ Новая дата и время служения:");
      if (date.action === "cancel") return void (await ctx.reply("Добавление служения отменено."));
      if (date.action === "value") startsAt = date.value;
      const newTitle = await askNavigableText(conversation, ctx, `⛪ Название служения (сейчас «${title}»):`, true);
      if (newTitle.action === "cancel") return void (await ctx.reply("Добавление служения отменено."));
      if (newTitle.action === "value" && newTitle.value) title = newTitle.value;
      const newLocation = await askNavigableText(conversation, ctx, `📍 Место${location ? ` (сейчас «${location}»)` : ""}:`, true);
      if (newLocation.action === "cancel") return void (await ctx.reply("Добавление служения отменено."));
      if (newLocation.action === "value" && newLocation.value) location = newLocation.value;
      continue;
    }
    if (action === "wf:edit:lineup") {
      const changed = await collectServiceLineup(conversation, ctx, lineup);
      if (changed.action === "cancel") return void (await ctx.reply("Добавление служения отменено."));
      if (changed.action === "value") lineup = changed.value;
      continue;
    }
    if (action === "wf:edit:songs") {
      const changed = await collectSetlist(conversation, ctx, team.id);
      if (changed.action === "cancel") return void (await ctx.reply("Добавление служения отменено."));
      if (changed.action === "value") setlist = changed.value;
      continue;
    }
    if (action === "wf:edit:rehearsals") {
      const changed = await collectRehearsalsForService(conversation, ctx, location);
      if (changed.action === "cancel") return void (await ctx.reply("Добавление служения отменено."));
      if (changed.action === "value") rehearsals = changed.value;
      continue;
    }

    const service = await conversation.external(async () => {
      const created = await createWorshipService({
        team: team.id, startsAt: startsAt!, soundcheckAt, title, location, lineup,
        setlist: setlist.map((item, index) => ({ song: item.id, order: index + 1, section: item.section, key: item.key, bpm: item.tempo })),
        createdBy: ctx.from!.id,
      });
      await Promise.all(rehearsals.map((item) => createRehearsal({
        team: team.id, service: created._id, startsAt: item.startsAt, location: item.location,
        comment: item.comment, lineup, createdBy: ctx.from!.id,
      })));
      return { id: created.id };
    });
    const savedMessage = `✅ <b>Служение добавлено</b>\n\n${eventPreview}`;
    const openKeyboard = new InlineKeyboard().text("⚙️ Открыть служение", `svc:o:${service.id}`);
    const saved = await ctx.reply(savedMessage, { parse_mode: "HTML", reply_markup: openKeyboard });
    if (ctx.chat?.type === "private") {
      const announcement = await sendTeamGroupMessage(ctx.api, team.id, savedMessage, new InlineKeyboard().text("⛪ Открыть служение", `svc:o:${service.id}`));
      if (announcement) await pinServiceAnnouncement(ctx.api, service.id, announcement.chatId, announcement.messageId);
    } else if (ctx.chat && (ctx.chat.type === "group" || ctx.chat.type === "supergroup")) {
      await pinServiceAnnouncement(ctx.api, service.id, ctx.chat.id, saved.message_id);
    }
    console.log(`[SERVICE] created id=${service.id} team=${team.id} rehearsals=${rehearsals.length} songs=${setlist.length}`);
    return;
  }
}

export async function serviceSetlistFlow(conversation: MyConversation, ctx: MyContext, teamId: string, serviceId: string) {
  if (!await conversation.external(async () => isAdmin(ctx.from!.id, teamId))) return void (await ctx.reply("Недостаточно прав."));
  const selected = await collectSetlist(conversation, ctx, teamId);
  if (selected.action !== "value") return void (await ctx.reply(selected.action === "cancel" ? "Изменение песен отменено." : "Сет-лист оставлен без изменений."));
  const updated = await conversation.external(async () => Boolean(await replaceSetlist(
    teamId,
    serviceId,
    selected.value.map((item, index) => ({ song: item.id, order: index + 1, section: item.section, key: item.key, bpm: item.tempo }))
  )));
  await ctx.reply(updated ? "✅ Блоки песен обновлены." : "Служение уже недоступно.");
  if (updated && ctx.chat?.type === "private") await notifyTeamGroup(ctx.api, teamId, `🎵 <b>Песни служения обновлены</b>\n\n${formatDraftSetlist(selected.value)}`);
}

export async function linkedRehearsalFlow(conversation: MyConversation, ctx: MyContext, teamId: string, serviceId: string) {
  const service = await conversation.external(async () => {
    if (!await isAdmin(ctx.from!.id, teamId)) return null;
    const item = await WorshipService.findOne({ _id: serviceId, team: teamId, status: "scheduled" }).lean();
    return item ? { location: item.location ?? undefined, lineup: item.lineup.map((slot) => ({ role: slot.role, slotLabel: slot.slotLabel ?? undefined, displayName: slot.displayName ?? undefined, userTelegramId: slot.userTelegramId ?? undefined })) } : null;
  });
  if (!service) return void (await ctx.reply("Служение недоступно."));
  const startsAt = await askNaturalDateTime(conversation, ctx, "🎸 Когда будет новая репетиция?");
  if (startsAt.action !== "value") return void (await ctx.reply("Добавление репетиции отменено."));
  const location = await askNavigableText(conversation, ctx, `📍 Место репетиции:${service.location ? `\nМожно пропустить — возьмём «${service.location}»` : ""}`, true);
  if (location.action !== "value") return void (await ctx.reply("Добавление репетиции отменено."));
  const created = await conversation.external(async () => createRehearsal({ team: teamId, service: serviceId, startsAt: startsAt.value, location: location.value ?? service.location, lineup: service.lineup, createdBy: ctx.from!.id }));
  const message = `✅ <b>Репетиция добавлена к служению</b>\n\n${formatRehearsalCard(created)}`;
  await ctx.reply(message, { parse_mode: "HTML" });
  if (ctx.chat?.type === "private") await notifyTeamGroup(ctx.api, teamId, message);
}

export async function editServiceFlow(conversation: MyConversation, ctx: MyContext, initialTeamId?: string, initialServiceId?: string) {
  const team = await selectAdminTeam(conversation, ctx, initialTeamId);
  if (!team) return;
  const services = (await conversation.external(async () => (await listUpcomingServices(team.id, 10)).map((item) => ({ id: item.id, startsAt: item.startsAt.toISOString(), location: item.location, title: item.title })))).map((item) => ({ ...item, startsAt: new Date(item.startsAt) }));
  if (!services.length) return void (await ctx.reply("Нет предстоящих служений для переноса."));
  let service = services.find((item) => item.id === initialServiceId);
  if (!service) {
    const keyboard = new InlineKeyboard();
    services.forEach((item) => keyboard.text(`${item.title} — ${formatEventDateTime(item.startsAt)}`.slice(0, 64), `sf:v:${item.id}`).row());
    await ctx.reply("Какое служение перенести?", { reply_markup: keyboard });
    const answer = await conversation.waitForCallbackQuery(/^sf:v:/);
    await answer.answerCallbackQuery();
    service = services.find((item) => item.id === answer.callbackQuery.data.split(":")[2]);
  }
  if (!service) return;
  const startsAt = await askFutureDateTime(conversation, ctx);
  const locationText = await askText(conversation, ctx, `📍 Новое место или /keep, чтобы оставить «${service.location ?? "не указано"}»:`);
  const location = locationText === "/keep" ? service.location ?? undefined : locationText;
  const preview = `🔄 <b>ПЕРЕНОС СЛУЖЕНИЯ</b>\n\nБыло: ${formatEventDateTime(service.startsAt)}\nСтало: ${formatEventDateTime(startsAt)}${location ? `\n📍 ${escapeHtml(location)}` : ""}`;
  if (!await confirm(conversation, ctx, `${preview}\n\nСохранить изменения?`)) return void (await ctx.reply("Перенос отменён."));
  const updated = await conversation.external(async () => Boolean(await moveWorshipService(team.id, service!.id, startsAt, ctx.from!.id, location)));
  if (!updated) return void (await ctx.reply("Служение уже недоступно."));
  await ctx.reply(`✅ ${preview}`, { parse_mode: "HTML" });
  if (ctx.chat?.type === "private") await notifyTeamGroup(ctx.api, team.id, preview);
}

export async function lateResponseFlow(conversation: MyConversation, ctx: MyContext, teamId: string, rehearsalId: string) {
  const raw = await askText(conversation, ctx, "На сколько минут опоздаешь? Введи число:");
  const minutes = Number(raw);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 600) return void (await ctx.reply("Нужно целое число от 1 до 600."));
  const saved = await conversation.external(async () => Boolean(await saveAttendance(teamId, rehearsalId, ctx.from!.id, "late", minutes)));
  await ctx.reply(saved ? `🟡 Записал: опоздаешь примерно на ${minutes} мин.` : "Не удалось сохранить ответ.");
}

export async function setlistKeyFlow(conversation: MyConversation, ctx: MyContext, teamId: string, serviceId: string, songId: string) {
  if (!await conversation.external(async () => isAdmin(ctx.from!.id, teamId))) return void (await ctx.reply("Недостаточно прав."));
  const key = await askText(conversation, ctx, "🎹 Введи тональность для этой песни:");
  if (!key || key.length > 20) return void (await ctx.reply("Некорректная тональность."));
  const updated = await conversation.external(async () => Boolean(await updateSetlistKey(teamId, serviceId, songId, key)));
  await ctx.reply(updated ? "✅ Тональность в сет-листе обновлена." : "Не удалось обновить сет-лист.");
}

export async function manualLineupFlow(conversation: MyConversation, ctx: MyContext, teamId: string, eventType: "service" | "rehearsal", eventId: string) {
  if (!await conversation.external(async () => isAdmin(ctx.from!.id, teamId))) return void (await ctx.reply("Недостаточно прав."));
  const lineupResult = await collectServiceLineup(conversation, ctx);
  if (lineupResult.action !== "value") return void (await ctx.reply("Изменение состава отменено."));
  const lineup = lineupResult.value;
  const preview = `👥 <b>НОВЫЙ СОСТАВ</b>\n\n${formatManualLineup(lineup)}`;
  if (!await confirm(conversation, ctx, `${preview}\n\nСохранить состав?`)) return void (await ctx.reply("Изменение состава отменено."));
  const updated = await conversation.external(async () => {
    if (eventType === "service") {
      const result = await WorshipService.updateOne({ _id: eventId, team: teamId, status: "scheduled" }, { $set: { lineup } });
      if (!result.matchedCount) return false;
      await Rehearsal.updateMany({ service: eventId, team: teamId, status: "scheduled" }, { $set: { lineup } });
      return true;
    }
    return Boolean(await Rehearsal.exists({ _id: eventId, team: teamId, status: "scheduled" }) && await Rehearsal.updateOne({ _id: eventId, team: teamId, status: "scheduled" }, { $set: { lineup } }));
  });
  await ctx.reply(updated ? `✅ Состав обновлён\n\n${preview}` : "Событие недоступно.", { parse_mode: "HTML" });
  if (updated && ctx.chat?.type === "private") await notifyTeamGroup(ctx.api, teamId, `👥 <b>Состав обновлён</b>\n\n${formatManualLineup(lineup)}`);
}
