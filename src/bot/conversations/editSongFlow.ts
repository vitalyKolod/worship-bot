import { Conversation } from "@grammyjs/conversations";
import { InlineKeyboard } from "grammy";
import { MyContext } from "../context";
import { getAdminTeams } from "../../services/teamService";
import { listSongsInTeam, updateSong } from "../../services/songService";
import { Song } from "../../models/Song";
import { formatSongCard, sendSongCard } from "../views/songCard";

type MyConversation = Conversation<MyContext, MyContext>;

const FIELDS = {
  title: "название",
  artist: "автор / исполнитель",
  tempo: "темп BPM",
  key: "тональность",
  timeSignature: "музыкальный размер (4/4, 6/8)",
  chords: "аккорды",
  notes: "заметки",
} as const;

type Field = keyof typeof FIELDS;

const CANCEL = "edit-nav:cancel";
const BACK_TO_TEAMS = "edit-nav:teams";
const BACK_TO_SONGS = "edit-nav:songs";
const BACK_TO_FIELDS = "edit-nav:fields";

export async function editSongFlow(
  conversation: MyConversation,
  ctx: MyContext,
  initialTeamId?: string,
  initialSongId?: string
) {
  // Состояние conversation сериализуется между апдейтами. Mongoose ObjectId
  // такую сериализацию не переживает, поэтому сохраняем только обычные строки.
  const teams = await conversation.external(async () =>
    (await getAdminTeams(ctx.from!.id)).map((team) => ({
      id: team._id.toString(),
      name: team.name,
    }))
  );
  if (!teams.length) return void (await ctx.reply("У тебя пока нет команд для редактирования."));

  let team = teams.find((item) => item.id === initialTeamId) ?? teams[0];
  if (initialTeamId && team.id !== initialTeamId) {
    return void (await ctx.reply("Эта команда недоступна для редактирования."));
  }
  let reuseCurrentScreen = Boolean(initialSongId && ctx.callbackQuery?.message);

  teamSelection: while (true) {
    if (!initialTeamId && teams.length > 1) {
      const keyboard = new InlineKeyboard();
      teams.forEach((item) => keyboard.text(item.name, `edit-team:${item.id}`).row());
      keyboard.text("✖️ Отмена", CANCEL);
      await ctx.reply("Выбери команду:", { reply_markup: keyboard });
      const answer = await conversation.waitForCallbackQuery(/^(edit-team:|edit-nav:cancel)/);
      const data = answer.callbackQuery.data;
      await answer.answerCallbackQuery();
      if (data === CANCEL) return void (await ctx.reply("Редактирование отменено."));
      const selectedTeam = teams.find((item) => item.id === data.split(":")[1]);
      if (!selectedTeam) continue;
      team = selectedTeam;
    }

    const songs = await conversation.external(async () =>
      (await listSongsInTeam(team.id)).map((song) => ({
        id: song._id.toString(),
        title: song.title,
      }))
    );
    if (!songs.length) return void (await ctx.reply("В этой команде пока нет песен."));

    let songPage = 0;
    songSelection: while (true) {
      const requestedSong = initialSongId
        ? songs.find((item) => item.id === initialSongId)
        : undefined;
      if (initialSongId && !requestedSong) return void (await ctx.reply("Песня не найдена."));
      const songKeyboard = new InlineKeyboard();
      const pageSize = 8;
      const pageCount = Math.max(1, Math.ceil(songs.length / pageSize));
      songPage = Math.max(0, Math.min(songPage, pageCount - 1));
      songs.slice(songPage * pageSize, (songPage + 1) * pageSize).forEach((song) => songKeyboard.text(song.title, `edit-song:${song.id}`).row());
      if (songPage > 0) songKeyboard.text("⬅️", `edit-page:${songPage - 1}`);
      if (pageCount > 1) songKeyboard.text(`${songPage + 1}/${pageCount}`, "edit-page:current");
      if (songPage < pageCount - 1) songKeyboard.text("➡️", `edit-page:${songPage + 1}`);
      if (pageCount > 1) songKeyboard.row();
      if (teams.length > 1) songKeyboard.text("⬅️ Назад", BACK_TO_TEAMS);
      songKeyboard.text("✖️ Отмена", CANCEL);
      let song = requestedSong;
      if (!song) {
        const songListMessage = await ctx.reply("Какую песню изменить?", { reply_markup: songKeyboard });
        const songAnswer = await conversation.waitForCallbackQuery(/^(edit-song:|edit-page:|edit-nav:(teams|cancel))/);
        const songData = songAnswer.callbackQuery.data;
        await songAnswer.answerCallbackQuery();
        try { await ctx.api.deleteMessage(ctx.chat!.id, songListMessage.message_id); } catch { /* Уже удалено. */ }
        if (songData.startsWith("edit-page:")) {
          const requestedPage = Number(songData.split(":")[1]);
          if (Number.isInteger(requestedPage)) songPage = requestedPage;
          continue songSelection;
        }
        if (songData === CANCEL) return void (await ctx.reply("Редактирование отменено."));
        if (songData === BACK_TO_TEAMS) continue teamSelection;
        song = songs.find((item) => item.id === songData.split(":")[1]);
      }
      if (!song) continue;

      while (true) {
        const fieldKeyboard = new InlineKeyboard();
        Object.entries(FIELDS).forEach(([field, label]) =>
          fieldKeyboard.text(label, `edit-field:${field}`).row()
        );
        fieldKeyboard.text("⬅️ Назад", BACK_TO_SONGS).text("✖️ Отмена", CANCEL);
        if (reuseCurrentScreen) {
          try {
            await ctx.editMessageText("Что изменить или дополнить?", { reply_markup: fieldKeyboard });
          } catch {
            await ctx.reply("Что изменить или дополнить?", { reply_markup: fieldKeyboard });
          }
          reuseCurrentScreen = false;
        } else {
          await ctx.reply("Что изменить или дополнить?", { reply_markup: fieldKeyboard });
        }
        const fieldAnswer = await conversation.waitForCallbackQuery(/^(edit-field:|edit-nav:(songs|cancel))/);
        const fieldData = fieldAnswer.callbackQuery.data;
        await fieldAnswer.answerCallbackQuery();
        if (initialSongId && (fieldData === CANCEL || fieldData === BACK_TO_SONGS)) {
          const currentSong = await conversation.external(async () => {
            const found = await Song.findOne({ _id: initialSongId, team: team.id }).lean();
            if (!found) return null;
            return {
              title: found.title,
              artist: found.artist,
              genre: found.genre,
              key: found.key,
              chords: found.chords,
              timeSignature: found.timeSignature,
              tempo: found.tempo,
              notes: found.notes,
            };
          });
          if (!currentSong) return void (await fieldAnswer.editMessageText("Песня не найдена."));
          const cardKeyboard = new InlineKeyboard()
            .text("⬅️ НАЗАД", `team:songs:${team.id}`)
            .text("✏️ РЕДАКТИРОВАТЬ", `song:edit:${initialSongId}`);
          await fieldAnswer.editMessageText(formatSongCard(currentSong), {
            parse_mode: "HTML",
            reply_markup: cardKeyboard,
          });
          return;
        }
        if (fieldData === CANCEL) return void (await ctx.reply("Редактирование отменено."));
        if (fieldData === BACK_TO_SONGS) continue songSelection;
        const field = fieldData.split(":")[1] as Field;
        if (!(field in FIELDS)) continue;

        const valueKeyboard = new InlineKeyboard()
          .text("⬅️ Назад", BACK_TO_FIELDS)
          .text("✖️ Отмена", CANCEL);
        await ctx.reply(`Введи новое значение для поля «${FIELDS[field]}»:`, { reply_markup: valueKeyboard });

        const valueAnswer = await conversation.wait();
        const navigation = valueAnswer.callbackQuery?.data;
        if (navigation === CANCEL || navigation === BACK_TO_FIELDS) {
          await valueAnswer.answerCallbackQuery();
          if (navigation === CANCEL) return void (await ctx.reply("Редактирование отменено."));
          continue;
        }

        const raw = valueAnswer.message?.text?.trim();
        const input = raw;
        if (!input) {
          await ctx.reply("Не получил значение. Попробуй ещё раз через /edit_song.");
          return;
        }

        let value: string | number = input;
        if (field === "tempo") {
          value = Number(input.replace(",", "."));
          if (!Number.isFinite(value) || value <= 0) {
            await ctx.reply("Темп должен быть положительным числом.");
            continue;
          }
        }
        if (field === "timeSignature") {
          value = input.replace(/\s/g, "");
          if (!/^[1-9]\d?\/[1-9]\d?$/.test(value)) {
            await ctx.reply("Напиши музыкальный размер в формате 4/4 или 6/8.");
            continue;
          }
        }

        const updatedSong = await conversation.external(async () => {
          const updated = await updateSong(team.id, song.id, { [field]: value });
          if (!updated) return null;
          const plain = updated.toObject();
          return {
            title: plain.title,
            artist: plain.artist,
            genre: plain.genre,
            key: plain.key,
            chords: plain.chords,
            timeSignature: plain.timeSignature,
            tempo: plain.tempo,
            notes: plain.notes,
          };
        });
        if (!updatedSong) return void (await ctx.reply("Песня не найдена."));
        await ctx.reply("✅ Песня обновлена!");
        await sendSongCard(ctx, updatedSong);
        return;
      }
    }
  }
}
