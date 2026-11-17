import { Composer, GrammyError, InlineKeyboard, InputFile } from "grammy";
import { MyContext } from "../../context";
import { User } from "../../../models/User";
import {
  addWorshipTeamMember,
  createWorshipTeam,
  getAccessibleTeam,
  getTeamByJoinCode,
  getTeamsForUser,
  isAdmin,
  upsertUser,
} from "../../../services/teamService";
import { checkTelegramGroupMembership } from "../../../services/telegramMembershipService";
import { Song } from "../../../models/Song";
import { Team } from "../../../models/Team";
import { formatSongCard } from "../../views/songCard";
import { TeamMember, ROLES, Role } from "../../../models/TeamMember";
import { archiveSong, findSongsInTeam } from "../../../services/songService";
import { STEM_NAMES, StemName } from "../../../models/Song";
import { receiveTelegramAudio } from "../../../services/audio/audio-upload.service";
import { ensureAudioDirectories } from "../../../services/audio/audio-storage.service";
import { createStemMix } from "../../../services/audio/audio-mix.service";
import { createAccompaniment, createCountInPrelude, resolveSectionName, SECTION_NAMES, SectionMark } from "../../../services/audio/audio-accompaniment.service";
import { prepareAutomaticClick } from "../../../services/audio/automatic-click.service";
import { fetchHolyChordsSections } from "../../../services/audio/holychords.service";
import { proposeGuideTimeline } from "../../../services/audio/guide-timeline.service";
import { AudioJob } from "../../../models/AudioJob";
import { createSeparationJob, retryJob } from "../../../services/audio/audio-job.service";
import { env } from "../../../config/env";

export const privatePortalComposer = new Composer<MyContext>();

const ROLE_OPTIONS = [
  ["v", "Вокал"],
  ["e", "Электрогитара"],
  ["b", "Бас"],
  ["a", "Акустика"],
  ["k", "Клавиши"],
  ["d", "Барабаны"],
  ["s", "Звукорежиссёр"],
  ["m", "Медиа / Слайды"],
] as const;

const ROLE_BY_ID = new Map<string, string>(ROLE_OPTIONS);
const STEM_LABELS: Record<StemName, string> = { vocals: "🎤 Вокал", drums: "🥁 Барабаны", bass: "🎸 Бас", guitar: "🎸 Гитара", piano: "🎹 Клавиши", other: "🎧 Остальное" };

async function setAwaitingAudio(ctx: MyContext, songId?: string): Promise<void> {
  if (!ctx.from) return;
  await User.updateOne({ telegramId: ctx.from.id }, songId
    ? { $set: { awaitingAudioSongId: songId } }
    : { $unset: { awaitingAudioSongId: 1 } });
}

async function getAwaitingAudio(ctx: MyContext): Promise<string | undefined> {
  if (!ctx.from) return undefined;
  const user = await User.findOne({ telegramId: ctx.from.id }).select("awaitingAudioSongId");
  return user?.awaitingAudioSongId ? String(user.awaitingAudioSongId) : undefined;
}

function escapeHtml(value: unknown): string {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatAudioTime(seconds: number): string {
  const rounded = Math.round(seconds);
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
}

async function show(ctx: MyContext, text: string, keyboard?: InlineKeyboard): Promise<void> {
  const options = { parse_mode: "HTML" as const, ...(keyboard ? { reply_markup: keyboard } : {}) };
  if (ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text, options);
      return;
    } catch (error) {
      if (error instanceof GrammyError && error.description.includes("message is not modified")) return;
      // Фото нельзя превратить в текст через editMessageText. Удаляем старый экран,
      // чтобы навигация всё равно занимала одно актуальное сообщение.
      try { await ctx.deleteMessage(); } catch { /* Telegram может запретить удаление. */ }
      console.warn("Не удалось перелистнуть экран, отправляю новый:", error instanceof Error ? error.message : error);
    }
  }
  await ctx.reply(text, options);
}

async function showInvite(ctx: MyContext, teamId: string): Promise<void> {
  const team = await getAccessibleTeam(teamId, ctx.from!.id);
  if (!team || team.ownerId !== ctx.from!.id || !team.joinCode) {
    return void (await show(ctx, "Приглашение недоступно."));
  }
  const chatId = team.telegramChatId ?? team.chatId;
  if (!chatId) return void (await show(ctx, "Сначала подключи Telegram-группу команды."));

  const link = `https://t.me/${ctx.me.username}?start=team_${team.joinCode}`;
  const keyboard = new InlineKeyboard()
    .text("📨 ОТПРАВИТЬ В ГРУППУ", `team:invite_send:${team._id}`)
    .row()
    .text("⬅️ НАЗАД К КОМАНДЕ", `team:o:${team._id}`);
  await show(
    ctx,
    `👤 <b>ПРИГЛАШЕНИЕ В «${escapeHtml(team.name.toUpperCase())}»</b>\n\n` +
      `Скопируй и отправь эту ссылку участникам:\n\n<code>${escapeHtml(link)}</code>\n\n` +
      "Только перешедший по этой ссылке пользователь сможет принять приглашение и пройти регистрацию.",
    keyboard
  );
}

function mainKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("👤 ПРОФИЛЬ", "nav:profile")
    .row()
    .text("🎸 МОИ КОМАНДЫ", "nav:teams");
}

async function showMain(ctx: MyContext): Promise<void> {
  await show(ctx, "🎸 <b>WORSHIP HELPER</b>\n\nДобро пожаловать! Что хочешь открыть?", mainKeyboard());
}

function rolesKeyboard(selected: string[], prefix: "reg" | "jr", customRoles: string[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const [id, label] of ROLE_OPTIONS) {
    keyboard.text(`${selected.includes(label) ? "✅ " : ""}${label}`, `${prefix}:r:${id}`).row();
  }
  customRoles.forEach((role, index) => {
    keyboard.text(`${selected.includes(role) ? "✅ " : ""}${role}`, `${prefix}:c:${index}`).row();
  });
  keyboard.text("➕ ПРЕДЛОЖИТЬ ДРУГОЕ", `${prefix}:other`).row();
  keyboard.text("✅ ГОТОВО", `${prefix}:done`);
  if (prefix === "jr") keyboard.text("✖️ ОТМЕНА", "join:no");
  return keyboard;
}

async function showRegistrationRoles(ctx: MyContext, telegramId: number): Promise<void> {
  const user = await User.findOne({ telegramId });
  if (!user) return;
  await show(
    ctx,
    "🎵 <b>Кто ты в команде прославления?</b>\n\nМожно выбрать несколько вариантов.",
    rolesKeyboard(user.defaultRoles, "reg", user.customRoles)
  );
}

async function showRegistrationConfirm(ctx: MyContext, telegramId: number): Promise<void> {
  const user = await User.findOne({ telegramId });
  if (!user) return;
  const teamName = user.pendingTeamJoinCode
    ? (await getTeamByJoinCode(user.pendingTeamJoinCode))?.name
    : user.worshipGroupName;
  const roles = user.defaultRoles.map((role) => `• ${escapeHtml(role)}`).join("\n");
  const keyboard = new InlineKeyboard()
    .text("✅ ПОДТВЕРДИТЬ", "reg:confirm")
    .row()
    .text("✏️ ИЗМЕНИТЬ", "reg:edit");
  await show(
    ctx,
    `👤 <b>ПРОФИЛЬ</b>\n\n<b>${escapeHtml(user.fullName ?? "")}</b>\n\n` +
      `🎸 <b>Группа прославления:</b>\n${escapeHtml(teamName ?? "Не указана")}\n\n` +
      `🎵 <b>Роли:</b>\n${roles}`,
    keyboard
  );
}

async function resumeRegistration(ctx: MyContext, telegramId: number): Promise<void> {
  const user = await User.findOne({ telegramId });
  if (!user) return;
  if (user.registrationStep === "roles") return showRegistrationRoles(ctx, telegramId);
  if (user.registrationStep === "confirm") return showRegistrationConfirm(ctx, telegramId);
  if (user.registrationStep === "worship_group" && !user.pendingTeamJoinCode) {
    await User.updateOne({ telegramId }, { inputMode: "registration_group" });
    await show(ctx, "🎸 <b>Как называется ваша группа прославления?</b>\n\nНапример: Слово Жизни Worship");
    return;
  }
  await User.updateOne({ telegramId }, { registrationStep: "fio", inputMode: "registration_fio" });
  await show(ctx, "👤 <b>Как тебя зовут?</b>\n\nУкажи имя и фамилию, например: Виталий Колодченко");
}

async function validatePendingTeam(ctx: MyContext, code: string) {
  const team = await getTeamByJoinCode(code);
  const chatId = team?.telegramChatId ?? team?.chatId;
  if (!team || !chatId) {
    await show(ctx, "Ссылка приглашения недействительна или команда ещё не подключена к Telegram-группе.");
    return null;
  }
  const membership = await checkTelegramGroupMembership(ctx.api, chatId, ctx.from!.id);
  if (membership === "not_member") {
    await show(ctx, "🚫 Ты пока не состоишь в Telegram-группе этой команды.\n\nСначала вступи в группу, а затем снова открой ссылку.");
    return null;
  }
  if (membership === "unavailable") {
    await show(ctx, "Не удалось проверить участие в Telegram-группе. Попроси владельца проверить, что бот всё ещё является администратором.");
    return null;
  }
  return team;
}

async function showJoinConfirmation(ctx: MyContext, teamId: string): Promise<void> {
  const team = await getAccessibleTeam(teamId, ctx.from!.id) ?? await (async () => {
    const user = await User.findOne({ telegramId: ctx.from!.id });
    return user?.pendingTeamJoinCode ? getTeamByJoinCode(user.pendingTeamJoinCode) : null;
  })();
  if (!team) return void (await show(ctx, "Команда не найдена."));
  const keyboard = new InlineKeyboard()
    .text("✅ ДА", `join:yes:${team._id}`)
    .text("✖️ НЕТ", "join:no");
  await show(ctx, `👋 <b>ПРИСОЕДИНЕНИЕ К КОМАНДЕ</b>\n\nТы присоединяешься к:\n\n🎸 <b>${escapeHtml(team.name)}</b>\n\nВсё верно?`, keyboard);
}

async function showProfile(ctx: MyContext): Promise<void> {
  const user = await User.findOne({ telegramId: ctx.from!.id, registrationStatus: "done" });
  if (!user) return resumeRegistration(ctx, ctx.from!.id);
  const keyboard = new InlineKeyboard().text("✏️ РЕДАКТИРОВАТЬ ПРОФИЛЬ", "profile:edit").row().text("⬅️ НАЗАД", "nav:main");
  await show(
    ctx,
    `👤 <b>ПРОФИЛЬ</b>\n\n<b>${escapeHtml(user.fullName ?? user.firstName ?? "Без имени")}</b>\n\n` +
      `🎸 <b>Группа прославления:</b>\n${escapeHtml(user.worshipGroupName ?? "Не указана")}\n\n` +
      `🎵 <b>Основные роли:</b>\n${user.defaultRoles.map(escapeHtml).join(", ") || "Не указаны"}`,
    keyboard
  );
}

async function showProfileEditor(ctx: MyContext): Promise<void> {
  const user = await User.findOne({ telegramId: ctx.from!.id, registrationStatus: "done" });
  if (!user) return resumeRegistration(ctx, ctx.from!.id);
  await show(ctx, "✏️ <b>РЕДАКТИРОВАНИЕ ПРОФИЛЯ</b>\n\nЧто изменить?", new InlineKeyboard()
    .text("👤 Имя", "profile:name").row()
    .text("🎸 Название группы", "profile:group").row()
    .text("🎵 Основные роли", "profile:roles").row()
    .text("⬅️ Назад", "nav:profile"));
}

async function showProfileRoles(ctx: MyContext): Promise<void> {
  const user = await User.findOne({ telegramId: ctx.from!.id });
  if (!user) return;
  const keyboard = new InlineKeyboard();
  ROLE_OPTIONS.forEach(([id, role]) => keyboard.text(`${user.defaultRoles.includes(role) ? "✅ " : ""}${role}`, `profile:r:${id}`).row());
  keyboard.text("✅ Готово", "nav:profile");
  await show(ctx, "🎵 <b>ОСНОВНЫЕ РОЛИ</b>\n\nВыбери подходящие роли:", keyboard);
}

async function showTeamList(ctx: MyContext): Promise<void> {
  const teams = await getTeamsForUser(ctx.from!.id);
  const keyboard = new InlineKeyboard();
  teams.forEach((team) => keyboard.text(team.name, `team:o:${team._id}`).row());
  keyboard.text("➕ СОЗДАТЬ КОМАНДУ", "team:create").row().text("⬅️ НАЗАД", "nav:main");
  await show(ctx, `🎸 <b>МОИ КОМАНДЫ</b>\n\n${teams.length ? "Выбери команду:" : "У тебя пока нет команд."}`, keyboard);
}

async function showTeam(ctx: MyContext, teamId: string): Promise<void> {
  const team = await getAccessibleTeam(teamId, ctx.from!.id);
  if (!team) return void (await show(ctx, "У тебя нет доступа к этой команде.", new InlineKeyboard().text("⬅️ НАЗАД", "nav:teams")));
  const isOwner = team.ownerId === ctx.from!.id;
  const canManage = await isAdmin(ctx.from!.id, team._id);
  const connected = Boolean(team.telegramChatId ?? team.chatId);
  const memberUsers = await User.find({ telegramId: { $in: team.members.map((member) => member.telegramId) } })
    .select("telegramId username fullName firstName")
    .lean();
  const usersByTelegramId = new Map(memberUsers.map((user) => [user.telegramId, user]));
  const members = team.members.map((member) =>
    (() => {
      const user = usersByTelegramId.get(member.telegramId);
      const identity = user?.username ? `@${escapeHtml(user.username)}` : escapeHtml(user?.fullName ?? user?.firstName ?? "Имя не указано");
      return `• <b>${identity}</b>${member.telegramId === ctx.from!.id ? " — ВЫ" : ""}\n  ${member.roles.map(escapeHtml).join(", ") || "роль не указана"}`;
    })()
  ).join("\n");
  let text = `🎸 <b>${escapeHtml(team.name.toUpperCase())}</b>\n\n`;
  text += connected ? "Telegram-группа подключена ✅" : "Команда создана ✅";
  if (isOwner && !connected) {
    text += "\n\nТеперь подключи Telegram-группу:\n1. Добавь Worship Helper в группу\n2. Сделай бота администратором\n3. Напиши в группе /setup";
  }
  text += `\n\n👥 <b>Участники:</b>\n${members || "Пока никого нет"}`;
  const keyboard = new InlineKeyboard();
  keyboard.text("📅 СЛУЖЕНИЯ И РЕПЕТИЦИИ", `ev:t:sv:${team._id}`).row();
  if (canManage) keyboard.text("➕ ДОБАВИТЬ СЛУЖЕНИЕ", `ev:t:sa:${team._id}`).row();
  keyboard.text("👥 УЧАСТНИКИ", `team:members:${team._id}`).row();
  keyboard.text("🎵 ВСЕ ПЕСНИ", `team:songs:${team._id}`).row();
  if (canManage) keyboard.text("🎧 РАЗОБРАТЬ ПЕСНЮ", `team:audio:${team._id}`).row();
  if (isOwner) keyboard.text("➕ ДОБАВИТЬ ПЕСНЮ", `team:add_song:${team._id}`).row();
  if (isOwner && connected && team.joinCode) {
    keyboard.text("👤 ПРИГЛАСИТЬ УЧАСТНИКА", `team:invite:${team._id}`).row();
  }
  if (isOwner && !connected) keyboard.text("ℹ️ КАК ПОДКЛЮЧИТЬ ГРУППУ", `team:help:${team._id}`).row();
  keyboard.text("⬅️ НАЗАД", "nav:teams").text("🏠 ГЛАВНАЯ", "nav:main");
  await show(ctx, text, keyboard);
}

async function showAudioSongList(ctx: MyContext, teamId: string, requestedPage = 0): Promise<void> {
  const team = await getAccessibleTeam(teamId, ctx.from!.id);
  if (!team || !(await isAdmin(ctx.from!.id, team._id))) {
    return void (await show(ctx, "Разбирать песни могут только администраторы команды."));
  }
  if (!env.audio.enabled) {
    return void (await show(ctx, "Обработка аудио отключена на сервере.", new InlineKeyboard().text("⬅️ К КОМАНДЕ", `team:o:${teamId}`)));
  }
  const pageSize = 8;
  const filter = { team: team._id, archivedAt: { $exists: false } };
  const total = await Song.countDocuments(filter);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.max(0, Math.min(requestedPage, pages - 1));
  const songs = await Song.find(filter).sort({ title: 1 }).skip(page * pageSize).limit(pageSize).select("title artist audio.processingStatus");
  const keyboard = new InlineKeyboard();
  songs.forEach((song) => {
    const status = song.audio?.processingStatus === "awaiting_chords" ? " 🔗" : song.audio?.processingStatus === "completed" ? " ✅" : song.audio?.processingStatus === "processing" || song.audio?.processingStatus === "queued" ? " ⏳" : "";
    keyboard.text(`${song.title}${song.artist ? ` — ${song.artist}` : ""}${status}`.slice(0, 64), `ap:upload:${song._id}`).row();
  });
  if (page > 0) keyboard.text("⬅️", `team:audio:${team._id}:${page - 1}`);
  if (pages > 1) keyboard.text(`${page + 1}/${pages}`, "team:page");
  if (page < pages - 1) keyboard.text("➡️", `team:audio:${team._id}:${page + 1}`);
  if (pages > 1) keyboard.row();
  keyboard.text("⬅️ К КОМАНДЕ", `team:o:${team._id}`);
  await show(ctx, total ? "🎧 <b>РАЗОБРАТЬ ПЕСНЮ</b>\n\nВыбери песню, затем пришли MP3, WAV или M4A:" : "В команде пока нет песен. Сначала добавь песню в каталог.", keyboard);
}

async function showSongList(ctx: MyContext, teamId: string, requestedPage = 0): Promise<void> {
  await User.updateOne({ telegramId: ctx.from!.id, inputMode: "search_song" }, { $set: { inputMode: "none" }, $unset: { pendingSongSearchTeamId: 1 } });
  const team = await getAccessibleTeam(teamId, ctx.from!.id);
  if (!team) return void (await show(ctx, "У тебя нет доступа к этой команде."));
  const pageSize = 10;
  const total = await Song.countDocuments({ team: team._id, archivedAt: { $exists: false } });
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.max(0, Math.min(requestedPage, pages - 1));
  const songs = await Song.find({ team: team._id, archivedAt: { $exists: false } })
    .sort({ title: 1 })
    .skip(page * pageSize)
    .limit(pageSize)
    .select("title artist");
  const keyboard = new InlineKeyboard();
  songs.forEach((song) =>
    keyboard
      .text(`${song.title}${song.artist ? ` — ${song.artist}` : ""}`, `song:o:${song._id}`)
      .row()
  );
  keyboard.text("🔎 ПОИСК ВСЕХ ПЕСЕН", `team:search:${team._id}`).row();
  if (page > 0) keyboard.text("⬅️", `team:songs:${team._id}:${page - 1}`);
  if (pages > 1) keyboard.text(`${page + 1}/${pages}`, "team:page");
  if (page < pages - 1) keyboard.text("➡️", `team:songs:${team._id}:${page + 1}`);
  if (pages > 1) keyboard.row();
  keyboard.text("⬅️ НАЗАД К КОМАНДЕ", `team:o:${team._id}`);
  await show(
    ctx,
    `🎵 <b>ПЕСНИ — ${escapeHtml(team.name.toUpperCase())}</b>\n\n` +
      (total ? `Всего песен: ${total}\nВыбери песню:` : "В этой команде пока нет песен."),
    keyboard
  );
}

async function showMembers(ctx: MyContext, teamId: string): Promise<void> {
  const team = await getAccessibleTeam(teamId, ctx.from!.id);
  if (!team) return void (await show(ctx, "Команда недоступна."));
  const ids = [...new Set([...(team.ownerId ? [team.ownerId] : []), ...team.members.map((m) => m.telegramId)])];
  const users = await User.find({ telegramId: { $in: ids } }).lean();
  const byId = new Map(users.map((user) => [user.telegramId, user]));
  const keyboard = new InlineKeyboard();
  ids.forEach((id) => {
    const user = byId.get(id);
    keyboard.text(user?.fullName ?? user?.firstName ?? user?.username ?? String(id), `member:o:${team.id}:${id}`).row();
  });
  keyboard.text("⬅️ К команде", `team:o:${team.id}`);
  await show(ctx, "👥 <b>УЧАСТНИКИ</b>\n\nВыбери участника:", keyboard);
}

async function showMember(ctx: MyContext, teamId: string, telegramId: number): Promise<void> {
  const team = await getAccessibleTeam(teamId, ctx.from!.id);
  if (!team || !(team.ownerId === telegramId || team.members.some((m) => m.telegramId === telegramId))) return void (await show(ctx, "Участник недоступен."));
  const user = await User.findOne({ telegramId });
  const membership = user ? await TeamMember.findOne({ team: team._id, user: user._id }) : null;
  const member = team.members.find((m) => m.telegramId === telegramId);
  const canManage = await isAdmin(ctx.from!.id, team._id);
  const keyboard = new InlineKeyboard();
  if (canManage && telegramId !== team.ownerId) {
    keyboard.text("✏️ Редактировать", `member:edit:${team.id}:${telegramId}`).row()
      .text("🎸 Роли / инструменты", `member:inst:${team.id}:${telegramId}`).row()
      .text("🛡 Права", `member:perm:${team.id}:${telegramId}`).row()
      .text("🚪 Удалить из команды", `member:removeask:${team.id}:${telegramId}`).row();
  }
  keyboard.text("⬅️ Участники", `team:members:${team.id}`);
  await show(ctx, `👤 <b>${escapeHtml(user?.fullName ?? user?.firstName ?? user?.username ?? telegramId)}</b>\n\n` +
    `🛡 Права: ${escapeHtml(telegramId === team.ownerId ? "owner" : membership?.role ?? "member")}\n` +
    `🎸 Роли / инструменты: ${member?.roles.map(escapeHtml).join(", ") || "не указаны"}`, keyboard);
}

privatePortalComposer.command("start", async (ctx, next) => {
  if (ctx.chat.type !== "private") return next();
  if (!ctx.from) return;
  const user = await upsertUser(ctx.from.id, ctx.from.first_name, ctx.from.username);
  const payload = typeof ctx.match === "string" ? ctx.match.trim() : "";
  if (payload.startsWith("team_")) {
    const code = payload.slice(5).toUpperCase();
    const team = await validatePendingTeam(ctx, code);
    if (!team) return;
    await User.updateOne(
      { telegramId: ctx.from.id },
      {
        pendingTeamJoinCode: code,
        ...(user.registrationStatus === "done" ? {} : { worshipGroupName: team.name }),
      }
    );
    if (user.registrationStatus === "done") return showJoinConfirmation(ctx, String(team._id));
    await ctx.reply(`👋 Ты присоединяешься к команде:\n\n🎸 <b>${escapeHtml(team.name)}</b>`, { parse_mode: "HTML" });
  }
  if (user.registrationStatus === "done") {
    const fresh = await User.findById(user._id);
    if (fresh?.pendingTeamJoinCode) {
      const pendingTeam = await getTeamByJoinCode(fresh.pendingTeamJoinCode);
      if (pendingTeam) {
        if (fresh.pendingJoinRoles.length || fresh.inputMode === "join_custom_role") {
          return show(
            ctx,
            "🎵 <b>Выбери роли именно в этой команде</b>",
            rolesKeyboard(fresh.pendingJoinRoles, "jr", fresh.customRoles)
          );
        }
        return showJoinConfirmation(ctx, String(pendingTeam._id));
      }
    }
    return showMain(ctx);
  }
  if (user.registrationStatus === "none") {
    await User.updateOne(
      { telegramId: ctx.from.id },
      { registrationStatus: "in_progress", registrationStep: "fio", inputMode: "registration_fio" }
    );
  }
  await resumeRegistration(ctx, ctx.from.id);
});

privatePortalComposer.command("main", async (ctx, next) => {
  if (ctx.chat.type !== "private") return next();
  await showMain(ctx);
});
privatePortalComposer.command("profile", async (ctx, next) => {
  if (ctx.chat.type !== "private") return next();
  await showProfile(ctx);
});
privatePortalComposer.command("team_list", async (ctx, next) => {
  if (ctx.chat.type !== "private") return next();
  await showTeamList(ctx);
});

privatePortalComposer.callbackQuery(/^nav:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await User.updateOne({ telegramId: ctx.from.id, inputMode: "search_song" }, { $set: { inputMode: "none" }, $unset: { pendingSongSearchTeamId: 1 } });
  const target = ctx.callbackQuery.data.split(":")[1];
  if (target === "main") return showMain(ctx);
  if (target === "profile") return showProfile(ctx);
  if (target === "teams") return showTeamList(ctx);
});

privatePortalComposer.callbackQuery(/^profile:/, async (ctx) => {
  const [, action, value] = ctx.callbackQuery.data.split(":");
  const user = await User.findOne({ telegramId: ctx.from.id, registrationStatus: "done" });
  if (!user) return void (await ctx.answerCallbackQuery({ text: "Профиль недоступен" }));
  await ctx.answerCallbackQuery();
  if (action === "edit") return showProfileEditor(ctx);
  if (action === "name" || action === "group") {
    await User.updateOne({ _id: user._id }, { inputMode: action === "name" ? "profile_fio" : "profile_group" });
    return show(ctx, action === "name" ? "👤 Введи новое имя:" : "🎸 Введи новое название группы:", new InlineKeyboard().text("⬅️ Отмена", "profile:edit"));
  }
  if (action === "roles") return showProfileRoles(ctx);
  if (action === "r") {
    const role = ROLE_BY_ID.get(value);
    if (role) await User.updateOne({ _id: user._id }, user.defaultRoles.includes(role) ? { $pull: { defaultRoles: role } } : { $addToSet: { defaultRoles: role } });
    return showProfileRoles(ctx);
  }
});

privatePortalComposer.callbackQuery(/^reg:/, async (ctx) => {
  const [, action, value] = ctx.callbackQuery.data.split(":");
  const user = await User.findOne({ telegramId: ctx.from.id, registrationStatus: "in_progress" });
  if (!user) return void (await ctx.answerCallbackQuery({ text: "Регистрация уже завершена" }));
  if (action === "r" || action === "c") {
    const role = action === "r" ? ROLE_BY_ID.get(value) : user.customRoles[Number(value)];
    if (role) {
      const selected = user.defaultRoles.includes(role)
        ? user.defaultRoles.filter((item) => item !== role)
        : [...user.defaultRoles, role];
      await User.updateOne({ _id: user._id }, { defaultRoles: selected });
    }
    await ctx.answerCallbackQuery();
    return showRegistrationRoles(ctx, ctx.from.id);
  }
  if (action === "other") {
    await ctx.answerCallbackQuery();
    await User.updateOne({ _id: user._id }, { inputMode: "registration_custom_role" });
    return show(ctx, "✍️ <b>Напиши свою роль в команде</b>\n\nНапример: Духовые или Скрипка");
  }
  if (action === "done") {
    if (!user.defaultRoles.length) return void (await ctx.answerCallbackQuery({ text: "Выбери хотя бы одну роль", show_alert: true }));
    await ctx.answerCallbackQuery();
    await User.updateOne({ _id: user._id }, { registrationStep: "confirm", inputMode: "none" });
    return showRegistrationConfirm(ctx, ctx.from.id);
  }
  if (action === "edit") {
    await ctx.answerCallbackQuery();
    const keyboard = new InlineKeyboard().text("👤 ИМЯ", "reg:edit_fio").row();
    if (!user.pendingTeamJoinCode) keyboard.text("🎸 НАЗВАНИЕ ГРУППЫ", "reg:edit_group").row();
    keyboard.text("🎵 РОЛИ", "reg:edit_roles");
    return show(ctx, "Что хочешь изменить?", keyboard);
  }
  if (action.startsWith("edit_")) {
    await ctx.answerCallbackQuery();
    if (action === "edit_roles") {
      await User.updateOne({ _id: user._id }, { registrationStep: "roles", inputMode: "none" });
      return showRegistrationRoles(ctx, ctx.from.id);
    }
    const fio = action === "edit_fio";
    await User.updateOne({ _id: user._id }, { inputMode: fio ? "registration_fio" : "registration_group" });
    return show(ctx, fio ? "👤 Введи исправленные имя и фамилию:" : "🎸 Введи исправленное название группы:");
  }
  if (action === "confirm") {
    await ctx.answerCallbackQuery();
    await User.updateOne({ _id: user._id }, { registrationStatus: "done", inputMode: "none" });
    const fresh = await User.findById(user._id);
    if (fresh?.pendingTeamJoinCode) {
      const team = await validatePendingTeam(ctx, fresh.pendingTeamJoinCode);
      if (team) {
        await addWorshipTeamMember(String(team._id), ctx.from.id, fresh.defaultRoles);
        await User.updateOne({ _id: fresh._id }, { pendingTeamJoinCode: null, pendingJoinRoles: [] });
        await ctx.reply("✅ Регистрация завершена, ты добавлен в команду!");
        return showTeam(ctx, String(team._id));
      }
    }
    return showMain(ctx);
  }
});

privatePortalComposer.callbackQuery(/^team:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const [, action, id, pageValue] = ctx.callbackQuery.data.split(":");
  if (action === "o") return showTeam(ctx, id);
  if (action === "songs") {
    return showSongList(ctx, id, Number(pageValue) || 0);
  }
  if (action === "search") {
    const team = await getAccessibleTeam(id, ctx.from.id);
    if (!team) return show(ctx, "У тебя нет доступа к этой команде.");
    await User.updateOne({ telegramId: ctx.from.id, registrationStatus: "done" }, { $set: { inputMode: "search_song", pendingSongSearchTeamId: team._id } });
    return show(ctx, `🔎 <b>ПОИСК В «${escapeHtml(team.name)}»</b>\n\nНапиши название песни или исполнителя.`, new InlineKeyboard().text("✖️ ОТМЕНА", `team:search_cancel:${team._id}`));
  }
  if (action === "search_cancel") {
    await User.updateOne({ telegramId: ctx.from.id, inputMode: "search_song" }, { $set: { inputMode: "none" }, $unset: { pendingSongSearchTeamId: 1 } });
    return showSongList(ctx, id);
  }
  if (action === "audio") return showAudioSongList(ctx, id, Number(pageValue) || 0);
  if (action === "members") return showMembers(ctx, id);
  if (action === "page") return;
  if (action === "add_song") {
    const team = await getAccessibleTeam(id, ctx.from.id);
    if (!team || !(await isAdmin(ctx.from.id, team._id))) {
      return show(ctx, "Добавлять песни могут только администраторы команды.");
    }
    await ctx.conversation.enter("addSongFlow", id, ctx.callbackQuery.message?.message_id);
    return;
  }
  if (action === "invite") return showInvite(ctx, id);
  if (action === "invite_send") {
    const team = await getAccessibleTeam(id, ctx.from.id);
    if (!team || team.ownerId !== ctx.from.id || !team.joinCode) {
      return show(ctx, "Приглашение недоступно.");
    }
    const chatId = team.telegramChatId ?? team.chatId;
    if (!chatId) return show(ctx, "Сначала подключи Telegram-группу команды.");
    const link = `https://t.me/${ctx.me.username}?start=team_${team.joinCode}`;
    await ctx.api.sendMessage(
      chatId,
      `👋 <b>ПРИГЛАШЕНИЕ В «${escapeHtml(team.name.toUpperCase())}»</b>\n\n` +
        "Перейди по кнопке, чтобы принять приглашение и получить доступ к песням команды.",
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().url("🎸 ПРИНЯТЬ ПРИГЛАШЕНИЕ", link),
      }
    );
    return show(
      ctx,
      "✅ Приглашение отправлено в Telegram-группу.",
      new InlineKeyboard().text("⬅️ К ПРИГЛАШЕНИЮ", `team:invite:${team._id}`)
    );
  }
  if (action === "create") {
    const user = await User.findOne({ telegramId: ctx.from.id, registrationStatus: "done" });
    if (!user) return resumeRegistration(ctx, ctx.from.id);
    await User.updateOne({ _id: user._id }, { inputMode: "create_team" });
    return show(ctx, `🎸 <b>Как называется ваша команда прославления?</b>\n\n${user.worshipGroupName ? `Например: ${escapeHtml(user.worshipGroupName)}` : "Напиши название от 2 до 70 символов."}`, new InlineKeyboard().text("✖️ ОТМЕНА", "team:cancel_create"));
  }
  if (action === "cancel_create") {
    await User.updateOne({ telegramId: ctx.from.id, inputMode: "create_team" }, { inputMode: "none" });
    return showTeamList(ctx);
  }
  if (action === "help") return showTeam(ctx, id);
});

privatePortalComposer.callbackQuery(/^song:o:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const songId = ctx.callbackQuery.data.split(":")[2];
  const song = await Song.findById(songId);
  if (!song || song.archivedAt) return void (await show(ctx, "Песня не найдена."));
  const team = await getAccessibleTeam(String(song.team), ctx.from.id);
  if (!team) return void (await show(ctx, "У тебя нет доступа к этой песне."));
  const keyboard = new InlineKeyboard();
  if (song.audio?.processingStatus === "completed") keyboard.text("🎧 УЧИТЬ ПЕСНЮ", `ap:o:${song._id}`).row();
  else if (song.audio?.processingStatus === "awaiting_chords") keyboard.text("🔗 ДОБАВИТЬ HOLY CHORDS", `ap:holy:${song._id}`).row();
  else if (song.audio?.processingStatus === "queued" || song.audio?.processingStatus === "processing") keyboard.text("⏳ АУДИО ОБРАБАТЫВАЕТСЯ", `ap:o:${song._id}`).row();
  else if (song.audio?.processingStatus === "failed") keyboard.text("⚠️ АУДИО: ОШИБКА", `ap:o:${song._id}`).row();
  if (await isAdmin(ctx.from.id, team._id)) {
    if (env.audio.enabled) keyboard.text(song.audio?.original ? "🔄 ЗАМЕНИТЬ АУДИО" : "🎧 ЗАГРУЗИТЬ АУДИО", `ap:upload:${song._id}`).row();
    keyboard.text("✏️ РЕДАКТИРОВАТЬ", `song:edit:${song._id}`).text("🗑 УДАЛИТЬ", `song:delete:${song._id}`).row();
  }
  keyboard.text("⬅️ К ПЕСНЯМ", `team:songs:${team._id}`);
  await show(ctx, formatSongCard(song), keyboard);
});

async function getPracticeSong(ctx: MyContext, songId: string) {
  const song = await Song.findById(songId);
  if (!song || song.archivedAt || !(await getAccessibleTeam(String(song.team), ctx.from!.id))) return null;
  return song;
}

privatePortalComposer.callbackQuery(/^ap:/, async (ctx) => {
  const [, action, songId, value] = ctx.callbackQuery.data.split(":");
  const song = await getPracticeSong(ctx, songId);
  if (!song) return void (await ctx.answerCallbackQuery({ text: "Песня недоступна", show_alert: true }));
  await ctx.answerCallbackQuery();
  if (action === "upload") {
    if (!env.audio.enabled) return show(ctx, "Обработка аудио отключена на сервере.");
    if (!(await isAdmin(ctx.from.id, song.team))) return show(ctx, "Загружать аудио могут только администраторы команды.");
    await setAwaitingAudio(ctx, songId);
    return show(ctx, `🎧 <b>${escapeHtml(song.title)}</b>\n\nОтправь MP3, WAV или M4A как аудио или документ. Максимальный размер: ${Math.floor(env.audio.maxUploadBytes / 1024 / 1024)} МБ.`, new InlineKeyboard().text("✖️ ОТМЕНА", `ap:cancel:${songId}`));
  }
  if (action === "cancel") { await setAwaitingAudio(ctx); return show(ctx, formatSongCard(song), new InlineKeyboard().text("⬅️ К ПЕСНЕ", `song:o:${songId}`)); }
  if (action === "retry") {
    const job = await AudioJob.findOne({ songId, status: "failed" }).sort({ createdAt: -1 });
    const retried = job ? await retryJob(job.id) : false;
    return show(ctx, retried ? "🔄 Обработка снова поставлена в очередь." : "Не удалось повторить задачу.", new InlineKeyboard().text("⬅️ К ПЕСНЕ", `song:o:${songId}`));
  }
  if (action === "status") {
    const activeJob = await AudioJob.findOne({ songId, status: { $in: ["pending", "processing"] } }).sort({ createdAt: -1 });
    if (activeJob && ctx.callbackQuery.message) {
      await AudioJob.updateOne({ _id: activeJob._id }, { $set: { progressChatId: ctx.chat!.id, progressMessageId: ctx.callbackQuery.message.message_id } });
    }
    const keyboard = new InlineKeyboard();
    if (song.audio?.processingStatus === "awaiting_chords") keyboard.text("🔗 ДОБАВИТЬ ССЫЛКУ", `ap:holy:${songId}`).row();
    if (song.audio?.processingStatus === "completed") keyboard.text("🎚 ОТКРЫТЬ ДОРОЖКИ", `ap:o:${songId}`).row();
    else if (song.audio?.processingStatus === "failed") keyboard.text("🔄 ПОВТОРИТЬ", `ap:retry:${songId}`).row();
    keyboard.text("⬅️ К ПЕСНЕ", `song:o:${songId}`);
    const label = song.audio?.processingStatus === "awaiting_chords" ? "🔗 Жду ссылку Holy Chords" : song.audio?.processingStatus === "completed" ? "✅ Дорожки готовы" : song.audio?.processingStatus === "failed" ? "⚠️ Разделение не удалось" : activeJob?.stage === "beat_analysis" ? "🥁 Определяю темп и доли для клика" : song.audio?.processingStatus === "processing" ? `🎛 Анализирую аудио${activeJob?.analysisPercent ? `: ${activeJob.analysisPercent}%` : ""}` : "⏳ В очереди на разделение";
    const bar = song.audio?.processingStatus === "completed" ? "▰▰▰▰▰▰▰▰▰▰" : song.audio?.processingStatus === "processing" ? `${"▰".repeat(Math.floor((activeJob?.analysisPercent ?? 0) / 12.5))}${"▱".repeat(10 - Math.floor((activeJob?.analysisPercent ?? 0) / 12.5))}` : "▰▱▱▱▱▱▱▱▱▱";
    return show(ctx, `🎧 <b>${escapeHtml(song.title)}</b>\n\n${label}\n\n${bar}`, keyboard);
  }
  if (["holy", "holydraft", "holyreview", "holyedit", "holyconfirm"].includes(action)) {
    if (!(await isAdmin(ctx.from.id, song.team))) return show(ctx, "Настраивать гайд могут только администраторы команды.");
    const audio = song.audio;
    if (!audio) return show(ctx, "Сначала загрузи аудио песни.");
    if (action === "holy") {
      ctx.session.audioSetup = { songId, mode: "holy_link" };
      return show(ctx, "🎙 <b>ГАЙД HOLYCHORDS</b>\n\nПришли ссылку на страницу этой песни. Например: <code>https://holychords.pro/74985</code>", new InlineKeyboard().text("✖️ ОТМЕНА", `ap:setupcancel:${songId}`));
    }
    const chart = audio.guideChart;
    if (!chart?.sections?.length) return show(ctx, "Сначала пришли ссылку на страницу песни.", new InlineKeyboard().text("🔗 ДОБАВИТЬ ССЫЛКУ", `ap:holy:${songId}`));
    if (action === "holydraft") {
      if (audio.processingStatus !== "completed" || audio.accompaniment?.status !== "ready") return show(ctx, "Сначала дождись окончания обработки песни и готового клика.", new InlineKeyboard().text("🎛 СТАТУС", `ap:status:${songId}`));
      try {
        const accompaniment = audio.accompaniment;
        const proposed = proposeGuideTimeline(chart.sections as never, { tempo: accompaniment.tempo!, beatsPerBar: accompaniment.beatsPerBar!, firstBeatAt: accompaniment.firstBeatAt!, beats: accompaniment.beats ?? undefined, sections: [] });
        const sections = chart.sections.map((section, index) => ({ name: section.name, label: section.label, weight: section.weight, lyrics: section.lyrics, variant: section.variant, draftAt: proposed[index].at }));
        await Song.updateOne({ _id: songId }, { $set: { "audio.guideChart.sections": sections, "audio.guideChart.status": "draft" } });
        chart.sections = sections as typeof chart.sections;
      } catch (error) {
        return show(ctx, error instanceof Error ? escapeHtml(error.message) : "Не удалось предложить времена частей.", new InlineKeyboard().text("✏️ УКАЗАТЬ ВРЕМЕНА", `ap:holyedit:${songId}`));
      }
    }
    if (action === "holyedit") {
      ctx.session.audioSetup = { songId, mode: "holy_times" };
      const list = chart.sections.map((section, index) => `${index + 1}. ${escapeHtml(section.label)}`).join("\n");
      return show(ctx, `🎙 <b>ВРЕМЕНА ЧАСТЕЙ</b>\n\n${list}\n\nПришли ${chart.sections.length} времён начала через запятую в том же порядке. Например: <code>0:00, 0:16, 0:32</code>.`, new InlineKeyboard().text("✖️ ОТМЕНА", `ap:setupcancel:${songId}`));
    }
    if (action === "holyconfirm") {
      if (audio.processingStatus !== "completed" || !audio.original?.path || audio.accompaniment?.status !== "ready") return show(ctx, "Сначала дождись готового клика.");
      if (chart.sections.some((section) => section.draftAt == null)) return show(ctx, "Сначала укажи время каждой части.", new InlineKeyboard().text("✏️ ВРЕМЕНА", `ap:holyedit:${songId}`));
      const marks = chart.sections.map((section) => ({ name: section.name as SectionMark["name"], variant: section.variant ?? undefined, at: section.draftAt! }));
      const accompaniment = audio.accompaniment;
      const progress = await ctx.reply("🎙 Собираю голосовой гайд по подтверждённым переходам...");
      try {
        const generated = await createAccompaniment(songId, audio.original.path, { tempo: accompaniment.tempo!, beatsPerBar: accompaniment.beatsPerBar!, firstBeatAt: accompaniment.firstBeatAt!, beats: accompaniment.beats ?? undefined, sections: marks });
        if (!generated.guide) throw new Error("Голосовые сэмплы не найдены на сервере.");
        await Song.updateOne({ _id: songId }, { $set: { "audio.accompaniment.sections": marks, "audio.accompaniment.guide": generated.guide, "audio.guideChart.status": "confirmed" } });
        ctx.session.audioMixer = undefined;
        return void (await ctx.api.editMessageText(ctx.chat!.id, progress.message_id, "✅ Гайд готов. В настройке playback его можно включить или убрать отдельно от клика.", { reply_markup: new InlineKeyboard().text("🎚 ОТКРЫТЬ PLAYBACK", `ap:mixer:${songId}`) }));
      } catch (error) {
        console.warn("audio_guide_creation_failed", { songId, error: error instanceof Error ? error.message : String(error) });
        return void (await ctx.api.editMessageText(ctx.chat!.id, progress.message_id, `⚠️ ${escapeHtml(error instanceof Error ? error.message.slice(0, 200) : "Не удалось создать гайд.")}`, { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("✏️ ИСПРАВИТЬ ВРЕМЕНА", `ap:holyedit:${songId}`) }));
      }
    }
    const list = chart.sections.map((section, index) => `${index + 1}. ${escapeHtml(section.label)} — ${section.draftAt == null ? "?" : formatAudioTime(section.draftAt)}`).join("\n");
    const keyboard = new InlineKeyboard();
    if (chart.sections.every((section) => section.draftAt != null)) keyboard.text("✅ ПОДТВЕРДИТЬ И СОЗДАТЬ ГАЙД", `ap:holyconfirm:${songId}`).row();
    keyboard.text("✏️ ИСПРАВИТЬ ВРЕМЕНА", `ap:holyedit:${songId}`).row();
    if (audio.accompaniment?.beats?.length && chart.url) keyboard.text("🔄 ПРЕДЛОЖИТЬ ЗАНОВО", `ap:holydraft:${songId}`).row();
    keyboard.text("⬅️ К PLAYBACK", `ap:mixer:${songId}`);
    return show(ctx, `🎙 <b>ЧАСТИ ПЕСНИ</b>\n\n${list}\n\nПроверь времена по загруженной записи.`, keyboard);
  }
  if (action === "auto") {
    if (!(await isAdmin(ctx.from.id, song.team))) return show(ctx, "Готовить клик могут только администраторы команды.");
    if (song.audio?.processingStatus !== "completed" || !song.audio.original?.path || !song.audio.stems?.drums?.path) return show(ctx, "Сначала нужно разделить песню на дорожки.");
    const progress = await ctx.reply("🥁 Ищу темп и доли на дорожке барабанов. Подожди немного...");
    try {
      const existing = song.audio.accompaniment;
      const sections = (existing?.sections ?? []) as SectionMark[];
      const prepared = await prepareAutomaticClick(songId, song.audio.original.path, song.audio.stems.drums.path, song.tempo ?? undefined, song.timeSignature ?? undefined, sections);
      if (prepared.status !== "ready") {
        await ctx.api.editMessageText(ctx.chat!.id, progress.message_id, "Не смог уверенно определить доли. Прежние дорожки сохранены; настрой клик вручную.", { reply_markup: new InlineKeyboard().text("⏱ НАСТРОИТЬ ВРУЧНУЮ", `ap:setup:${songId}`) });
        return;
      }
      await Song.updateOne({ _id: songId }, { $set: { "audio.accompaniment": prepared } });
      ctx.session.audioMixer = undefined;
      await ctx.api.editMessageText(ctx.chat!.id, progress.message_id, `✅ Нашёл доли и подготовил клик: ~${prepared.tempo} BPM. Проверь его на слух.`, { reply_markup: new InlineKeyboard().text("🎚 ОТКРЫТЬ PLAYBACK", `ap:mixer:${songId}`) });
    } catch (error) {
      console.warn("audio_click_retry_failed", { songId, error: error instanceof Error ? error.message : String(error) });
      await ctx.api.editMessageText(ctx.chat!.id, progress.message_id, "Не удалось подготовить клик. Инструментальные дорожки не затронуты.", { reply_markup: new InlineKeyboard().text("⏱ НАСТРОИТЬ ВРУЧНУЮ", `ap:setup:${songId}`) });
    }
    return;
  }
  if (song.audio?.processingStatus !== "completed") {
    const keyboard = new InlineKeyboard();
    if (song.audio?.processingStatus === "failed") keyboard.text("🔄 ПОВТОРИТЬ", `ap:retry:${songId}`).row();
    if (song.audio?.processingStatus === "awaiting_chords") keyboard.text("🔗 ДОБАВИТЬ ССЫЛКУ", `ap:holy:${songId}`).row();
    keyboard.text("⬅️ К ПЕСНЕ", `song:o:${songId}`);
    const status = song.audio?.processingStatus === "awaiting_chords" ? "Аудио загружено. Пришли ссылку Holy Chords, чтобы начать обработку." : song.audio?.processingStatus === "failed" ? "Не удалось обработать аудио. Попробуйте другой файл или повторите позже." : "Аудио ещё обрабатывается в фоне.";
    return show(ctx, `🎧 <b>ПРАКТИКА</b>\n\n${status}`, keyboard);
  }
  const stems = song.audio.stems ?? {};
  if (action === "o") {
    const keyboard = new InlineKeyboard();
    for (const stem of STEM_NAMES) if (stems[stem]?.path) keyboard.text(STEM_LABELS[stem], `ap:stem:${songId}:${stem}`).row();
    keyboard.text("🎚 НАСТРОИТЬ PLAYBACK", `ap:mixer:${songId}`).row().text("⬅️ К ПЕСНЕ", `song:o:${songId}`);
    return show(ctx, "🎧 <b>ПРАКТИКА</b>\n\nВыберите инструмент или настройте playback:", keyboard);
  }
  if (action === "stem" && STEM_NAMES.includes(value as StemName)) {
    const stem = value as StemName;
    return show(ctx, `${STEM_LABELS[stem]}\n\nВыберите режим:`, new InlineKeyboard().text(`🎵 Только ${STEM_LABELS[stem].replace(/^\S+\s/, "").toLowerCase()}`, `ap:only:${songId}:${stem}`).row().text("🎧 Playback без партии", `ap:without:${songId}:${stem}`).row().text("⬅️ НАЗАД", `ap:o:${songId}`));
  }
  if (action === "only" && STEM_NAMES.includes(value as StemName)) {
    const item = stems[value as StemName];
    if (!item?.path) return void (await ctx.reply("Эта дорожка недоступна."));
    await ctx.replyWithAudio(new InputFile(item.path), { caption: `${STEM_LABELS[value as StemName]} — ${song.title}` });
    return;
  }
  if (action === "without" && STEM_NAMES.includes(value as StemName)) {
    const include = STEM_NAMES.filter((stem) => stem !== value && stems[stem]?.path);
    const output = await createStemMix(songId, include, stems as Partial<Record<StemName, { path: string }>>);
    await ctx.replyWithAudio(new InputFile(output), { caption: `🎧 ${song.title} — без ${STEM_LABELS[value as StemName].replace(/^\S+\s/, "").toLowerCase()}` });
    return;
  }
  if (action === "setup" || action === "sections") {
    if (!(await isAdmin(ctx.from.id, song.team))) return show(ctx, "Настраивать клик и гайд могут только администраторы команды.");
    ctx.session.audioSetup = { songId, mode: action === "setup" ? "timing" : "sections" };
    const current = song.audio.accompaniment;
    const example = action === "setup"
      ? `Отправь темп, число долей в такте и время первой доли в секундах через пробел.\nНапример: <code>120 4 2.5</code>\n\nТекущие данные: ${current?.tempo ?? song.tempo ?? "?"} BPM, ${current?.beatsPerBar ?? song.timeSignature?.split("/")[0] ?? "?"} доли, первая доля ${current?.firstBeatAt ?? "?"} с.`
      : `Отправь части песни через точку с запятой в формате <code>0:12 вступление; 0:28 куплет; 1:04 припев</code>.\nДоступно: ${SECTION_NAMES.join(", ")}, а также русские названия.\nИспользуй время именно загруженного аудио, не другой версии песни.`;
    return show(ctx, `🎚 <b>РАЗМЕТКА ПЕСНИ</b>\n\n${example}`, new InlineKeyboard().text("✖️ ОТМЕНА", `ap:setupcancel:${songId}`));
  }
  if (action === "setupcancel") { ctx.session.audioSetup = undefined; return show(ctx, "Настройка отменена.", new InlineKeyboard().text("⬅️ К PLAYBACK", `ap:mixer:${songId}`)); }
  if (["mixer", "toggle", "vol", "freq", "sound", "accent"].includes(action)) {
    const accompaniment = song.audio.accompaniment;
    const availableExtras = (["click", "guide"] as const).filter((name) => accompaniment?.[name]?.path);
    if (!ctx.session.audioMixer || ctx.session.audioMixer.songId !== songId) ctx.session.audioMixer = { songId, enabled: [...STEM_NAMES.filter((stem) => stems[stem]?.path), ...availableExtras], levels: {}, subdivision: 1, clickSound: "blip", accentBeat: 0 };
    if (action === "toggle" && (STEM_NAMES.includes(value as StemName) || availableExtras.includes(value as "click" | "guide"))) {
      const enabled = new Set(ctx.session.audioMixer.enabled);
      enabled.has(value) ? enabled.delete(value) : enabled.add(value);
      ctx.session.audioMixer.enabled = [...enabled];
    }
    if (action === "vol") {
      const match = value?.match(/^([a-z]+)([+-])$/);
      const name = match?.[1];
      if (name && (STEM_NAMES.includes(name as StemName) || availableExtras.includes(name as "click" | "guide"))) {
        const levels = ctx.session.audioMixer.levels ?? {};
        levels[name] = Math.max(0, Math.min(200, (levels[name] ?? 100) + (match[2] === "+" ? 25 : -25)));
        ctx.session.audioMixer.levels = levels;
      }
    }
    if (action === "freq" && ["1", "2", "4"].includes(value)) ctx.session.audioMixer.subdivision = Number(value) as 1 | 2 | 4;
    if (action === "sound" && (value === "blip" || value === "sine")) ctx.session.audioMixer.clickSound = value;
    if (action === "accent") ctx.session.audioMixer.accentBeat = ((ctx.session.audioMixer.accentBeat ?? 0) + 1) % (accompaniment?.beatsPerBar ?? 4);
    const keyboard = new InlineKeyboard();
    const shortLabels: Record<StemName, string> = { vocals: "🎤 Вокал", drums: "🥁 Бараб.", bass: "🎸 Бас", guitar: "🎸 Гитара", piano: "🎹 Клавиши", other: "🎧 Ост." };
    const volumeRow = (name: string, label: string) => keyboard
      .text(`${label} ${ctx.session.audioMixer!.enabled.includes(name) ? "✅" : "❌"}`, `ap:toggle:${songId}:${name}`)
      .text("−", `ap:vol:${songId}:${name}-`)
      .text("+", `ap:vol:${songId}:${name}+`)
      .text(`${ctx.session.audioMixer!.levels?.[name] ?? 100}%`, `ap:mixer:${songId}`).row();
    for (const stem of STEM_NAMES) if (stems[stem]?.path) volumeRow(stem, shortLabels[stem]);
    for (const name of availableExtras) volumeRow(name, name === "click" ? "🥁 Клик" : "🎙 Гайд");
    if (availableExtras.includes("click")) {
      for (const [amount, label] of [[1, "Доли"], [2, "2×"], [4, "4×"]] as const) keyboard.text(`${ctx.session.audioMixer.subdivision === amount ? "● " : ""}${label}`, `ap:freq:${songId}:${amount}`);
      keyboard.row();
      keyboard.text(`${ctx.session.audioMixer.clickSound === "blip" ? "● " : ""}Blip`, `ap:sound:${songId}:blip`).text(`${ctx.session.audioMixer.clickSound === "sine" ? "● " : ""}Сигнал`, `ap:sound:${songId}:sine`).row();
      keyboard.text(`Акцент: ${(ctx.session.audioMixer.accentBeat ?? 0) + 1}/${accompaniment?.beatsPerBar ?? 4}`, `ap:accent:${songId}:next`).row();
    }
    keyboard.text(accompaniment?.click?.path ? "🔄 ПЕРЕОПРЕДЕЛИТЬ КЛИК" : "🥁 СОЗДАТЬ КЛИК АВТОМАТИЧЕСКИ", `ap:auto:${songId}`).row();
    keyboard.text("⏱ ТЕМП И ТАКТ", `ap:setup:${songId}`).row();
    keyboard.text("🎙 ЧАСТИ ПЕСНИ", `ap:sections:${songId}`).row();
    keyboard.text(song.audio.guideChart?.sections?.length ? "🎙 ПРОВЕРИТЬ ЧАСТИ И ГАЙД" : "🔗 ДОБАВИТЬ HOLYCHORDS", song.audio.guideChart?.sections?.length ? `ap:holyreview:${songId}` : `ap:holy:${songId}`).row();
    keyboard.text("🎵 СОЗДАТЬ PLAYBACK", `ap:create:${songId}`).row().text("⬅️ НАЗАД", `ap:o:${songId}`);
    const status = accompaniment?.status === "ready"
      ? accompaniment.guide?.path ? "Клик и гайд готовы. Проверь синхронизацию на слух." : `Клик ${accompaniment.source === "automatic" ? `определён автоматически (~${accompaniment.tempo} BPM)` : "готов"}. Проверь его на слух; для гайда добавь части песни.`
      : "Клик и гайд появятся после подтверждения темпа и разметки.";
    return show(ctx, `🎚 <b>НАСТРОИТЬ PLAYBACK</b>\n\n${status}`, keyboard);
  }
  if (action === "create") {
    const selected = (ctx.session.audioMixer?.songId === songId ? ctx.session.audioMixer.enabled : []).filter((stem): stem is StemName => STEM_NAMES.includes(stem as StemName));
    const accompaniment = song.audio.accompaniment;
    const enabled = ctx.session.audioMixer?.songId === songId ? ctx.session.audioMixer.enabled : [];
    const mixer = ctx.session.audioMixer;
    let clickPath = accompaniment?.click?.path;
    if (enabled.includes("click") && clickPath && song.audio.original?.path && ((mixer?.subdivision ?? 1) !== 1 || (mixer?.clickSound ?? "blip") !== "blip" || (mixer?.accentBeat ?? 0) !== 0)) {
      const grid = { tempo: accompaniment!.tempo!, beatsPerBar: accompaniment!.beatsPerBar!, firstBeatAt: accompaniment!.firstBeatAt!, beats: accompaniment!.beats ?? undefined, sections: (accompaniment!.sections ?? []) as SectionMark[] };
      clickPath = (await createAccompaniment(songId, song.audio.original.path, grid, mixer?.subdivision ?? 1, mixer?.clickSound ?? "blip", mixer?.accentBeat ?? 0)).click.path;
    }
    const extras = {
      ...(enabled.includes("click") && clickPath ? { click: { path: clickPath } } : {}),
      ...(enabled.includes("guide") && accompaniment?.guide?.path ? { guide: { path: accompaniment.guide.path } } : {}),
    };
    if (!selected.length && !Object.keys(extras).length) return void (await ctx.reply("Выбери хотя бы одну дорожку."));
    const revision = JSON.stringify([accompaniment?.tempo, accompaniment?.beatsPerBar, accompaniment?.firstBeatAt, accompaniment?.sections, clickPath, accompaniment?.guide?.path, mixer?.subdivision, mixer?.clickSound, mixer?.accentBeat]);
    const prelude = accompaniment?.status === "ready" && accompaniment.tempo && accompaniment.beatsPerBar && enabled.includes("click") && enabled.includes("guide")
      ? await createCountInPrelude(songId, accompaniment.tempo, accompaniment.beatsPerBar, mixer?.clickSound ?? "blip", accompaniment.firstBeatAt ?? 0) : undefined;
    const output = await createStemMix(songId, selected, stems as Partial<Record<StemName, { path: string }>>, extras, revision, mixer?.levels, prelude);
    await ctx.replyWithAudio(new InputFile(output), { caption: `🎚 ${song.title} — персональный playback` });
  }
});

privatePortalComposer.on(["message:audio", "message:document"], async (ctx, next) => {
  if (ctx.chat.type !== "private") return next();
  const songId = await getAwaitingAudio(ctx);
  if (!songId) return next();
  const song = await Song.findById(songId);
  if (!song || song.archivedAt || !(await getAccessibleTeam(String(song.team), ctx.from.id)) || !(await isAdmin(ctx.from.id, song.team))) { await setAwaitingAudio(ctx); return void (await ctx.reply("Песня недоступна.")); }
  const file = ctx.message.audio ?? ctx.message.document;
  if (!file) return next();
  if (song.audio?.processingStatus === "queued" || song.audio?.processingStatus === "processing") {
    await setAwaitingAudio(ctx);
    return void (await ctx.reply("🎧 Эта песня уже обрабатывается. Статус обновится автоматически.", { reply_markup: new InlineKeyboard().text("🎛 СТАТУС", `ap:status:${songId}`) }));
  }
  const progress = await ctx.reply(`🎧 <b>${escapeHtml(song.title)}</b>\n\n⬇️ Скачиваю файл из Telegram...`, { parse_mode: "HTML" });
  let lastPercent = -1;
  let lastUpdate = 0;
  let updating = Promise.resolve();
  const updateProgress = (received: number) => {
    const percent = file.file_size ? Math.min(100, Math.floor(received * 100 / file.file_size)) : 0;
    if (percent === lastPercent || Date.now() - lastUpdate < 1500) return;
    lastPercent = percent;
    lastUpdate = Date.now();
    const bar = `${"▰".repeat(Math.floor(percent / 10))}${"▱".repeat(10 - Math.floor(percent / 10))}`;
    updating = updating.then(() => ctx.api.editMessageText(ctx.chat.id, progress.message_id, `🎧 <b>${escapeHtml(song.title)}</b>\n\n⬇️ Скачиваю файл: ${bar} ${percent}%`, { parse_mode: "HTML" })).then(() => {}, () => {});
  };
  try {
    const uploaded = await receiveTelegramAudio(ctx.api, songId, ctx.from.id, file, updateProgress);
    await updating;
    await createSeparationJob(uploaded.songId, uploaded.userId, uploaded.inputPath, uploaded.outputDir);
    await setAwaitingAudio(ctx);
    await ctx.api.editMessageText(ctx.chat.id, progress.message_id, `🎧 <b>${escapeHtml(song.title)}</b>\n\n✅ Файл загружен и поставлен в очередь. Разделение и клик подготовятся автоматически. После обработки проверь разметку перед созданием гайда.`, { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("🎛 СТАТУС", `ap:status:${songId}`) });
  } catch (error) {
    await updating;
    console.error("audio_upload_failed", { songId, userId: ctx.from.id, error: error instanceof Error ? error.message : String(error) });
    const message = error instanceof Error && /format|size/i.test(error.message) ? "Поддерживаются MP3, WAV и M4A в пределах установленного лимита." : "Не удалось загрузить аудио. Попробуйте ещё раз позже.";
    await ctx.api.editMessageText(ctx.chat.id, progress.message_id, `🎧 <b>${escapeHtml(song.title)}</b>\n\n⚠️ ${message}`, { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("⬅️ К ПЕСНЕ", `song:o:${songId}`) });
  }
});

privatePortalComposer.callbackQuery(/^song:(delete|delete_yes):/, async (ctx) => {
  const [, action, songId] = ctx.callbackQuery.data.split(":");
  const song = await Song.findById(songId);
  if (!song || song.archivedAt || !(await isAdmin(ctx.from.id, song.team))) {
    return void (await ctx.answerCallbackQuery({ text: "Недоступно", show_alert: true }));
  }
  await ctx.answerCallbackQuery();
  if (action === "delete") {
    return show(ctx, `🗑 Удалить песню «${escapeHtml(song.title)}»?`, new InlineKeyboard()
      .text("✅ Да, удалить", `song:delete_yes:${song.id}`).row()
      .text("❌ Отмена", `song:o:${song.id}`));
  }
  const archived = await archiveSong(song.team, song.id);
  await show(ctx, archived ? "✅ Песня архивирована. Старые служения продолжат её отображать." : "Не удалось архивировать песню.", new InlineKeyboard().text("⬅️ К песням", `team:songs:${song.team}`));
});

privatePortalComposer.callbackQuery(/^member:/, async (ctx) => {
  const [, action, teamId, telegramValue, value] = ctx.callbackQuery.data.split(":");
  const telegramId = Number(telegramValue);
  const team = await getAccessibleTeam(teamId, ctx.from.id);
  if (!team) return void (await ctx.answerCallbackQuery({ text: "Команда недоступна", show_alert: true }));
  if (action === "o") { await ctx.answerCallbackQuery(); return showMember(ctx, teamId, telegramId); }
  if (!(await isAdmin(ctx.from.id, team._id)) || telegramId === team.ownerId) return void (await ctx.answerCallbackQuery({ text: "Недостаточно прав", show_alert: true }));
  const target = await User.findOne({ telegramId });
  if (!target || !team.members.some((m) => m.telegramId === telegramId)) return void (await ctx.answerCallbackQuery({ text: "Участник недоступен", show_alert: true }));
  await ctx.answerCallbackQuery();
  if (action === "edit") return show(ctx, "Что изменить?", new InlineKeyboard().text("🎸 Роли / инструменты", `member:inst:${teamId}:${telegramId}`).row().text("🛡 Права", `member:perm:${teamId}:${telegramId}`).row().text("⬅️ Назад", `member:o:${teamId}:${telegramId}`));
  if (action === "inst") {
    const member = team.members.find((m) => m.telegramId === telegramId)!;
    const keyboard = new InlineKeyboard();
    ROLE_OPTIONS.forEach(([id, role]) => keyboard.text(`${member.roles.includes(role) ? "✅ " : ""}${role}`, `member:it:${teamId}:${telegramId}:${id}`).row());
    keyboard.text("✅ Готово", `member:o:${teamId}:${telegramId}`);
    return show(ctx, "🎸 Роли / инструменты в этой команде:", keyboard);
  }
  if (action === "it") {
    const role = ROLE_BY_ID.get(value);
    if (role) {
      const selected = team.members.find((m) => m.telegramId === telegramId)?.roles.includes(role);
      await Team.updateOne({ _id: team._id, "members.telegramId": telegramId }, selected ? { $pull: { "members.$.roles": role } } : { $addToSet: { "members.$.roles": role } });
    }
    return showMember(ctx, teamId, telegramId);
  }
  if (action === "perm") {
    const membership = await TeamMember.findOne({ team: team._id, user: target._id });
    const keyboard = new InlineKeyboard();
    ROLES.forEach((role) => keyboard.text(`${membership?.role === role ? "✅ " : ""}${role}`, `member:ps:${teamId}:${telegramId}:${role}`).row());
    keyboard.text("⬅️ Назад", `member:o:${teamId}:${telegramId}`);
    return show(ctx, "🛡 Права участника в этой команде:", keyboard);
  }
  if (action === "ps") {
    if (!ROLES.includes(value as Role)) return;
    await TeamMember.updateOne({ team: team._id, user: target._id }, { role: value }, { upsert: true });
    return showMember(ctx, teamId, telegramId);
  }
  if (action === "removeask") return show(ctx, "🚪 Удалить участника из команды?", new InlineKeyboard().text("✅ Да, удалить", `member:remove:${teamId}:${telegramId}`).row().text("❌ Отмена", `member:o:${teamId}:${telegramId}`));
  if (action === "remove") {
    await Promise.all([Team.updateOne({ _id: team._id }, { $pull: { members: { telegramId } } }), TeamMember.deleteOne({ team: team._id, user: target._id })]);
    return showMembers(ctx, teamId);
  }
});

privatePortalComposer.callbackQuery(/^song:edit:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const song = await Song.findById(ctx.callbackQuery.data.split(":")[2]);
  if (!song || !(await isAdmin(ctx.from.id, song.team))) {
    return void (await show(ctx, "Редактировать песни могут только администраторы команды."));
  }
  await ctx.conversation.enter("editSongFlow", String(song.team), String(song._id));
});

privatePortalComposer.callbackQuery(/^join:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const [, action, teamId] = ctx.callbackQuery.data.split(":");
  if (action === "no") {
    await User.updateOne({ telegramId: ctx.from.id }, { pendingTeamJoinCode: null, pendingJoinRoles: [] });
    return showMain(ctx);
  }
  const team = await getAccessibleTeam(teamId, ctx.from.id) ?? await (async () => {
    const user = await User.findOne({ telegramId: ctx.from.id });
    return user?.pendingTeamJoinCode ? getTeamByJoinCode(user.pendingTeamJoinCode) : null;
  })();
  if (!team) return show(ctx, "Команда не найдена.");
  if (team.members.some((member) => member.telegramId === ctx.from.id)) {
    await User.updateOne({ telegramId: ctx.from.id }, { pendingTeamJoinCode: null });
    await ctx.reply("Ты уже состоишь в этой команде ✅");
    return showTeam(ctx, String(team._id));
  }
  const chatId = team.telegramChatId ?? team.chatId;
  if (!chatId || await checkTelegramGroupMembership(ctx.api, chatId, ctx.from.id) !== "member") {
    return show(ctx, "Не удалось подтвердить участие в Telegram-группе команды.");
  }
  const user = await User.findOne({ telegramId: ctx.from.id });
  if (!user) return;
  await User.updateOne({ _id: user._id }, { pendingTeamJoinCode: team.joinCode, pendingJoinRoles: user.defaultRoles });
  return show(ctx, "🎵 <b>Выбери роли именно в этой команде</b>\n\nМожно выбрать несколько вариантов.", rolesKeyboard(user.defaultRoles, "jr", user.customRoles));
});

privatePortalComposer.callbackQuery(/^jr:/, async (ctx) => {
  const [, action, value] = ctx.callbackQuery.data.split(":");
  const user = await User.findOne({ telegramId: ctx.from.id, pendingTeamJoinCode: { $ne: null } });
  if (!user) return void (await ctx.answerCallbackQuery({ text: "Приглашение устарело" }));
  if (action === "r" || action === "c") {
    const role = action === "r" ? ROLE_BY_ID.get(value) : user.customRoles[Number(value)];
    if (role) {
      const selected = user.pendingJoinRoles.includes(role)
        ? user.pendingJoinRoles.filter((item) => item !== role)
        : [...user.pendingJoinRoles, role];
      await User.updateOne({ _id: user._id }, { pendingJoinRoles: selected });
    }
    await ctx.answerCallbackQuery();
    const fresh = await User.findById(user._id);
    if (fresh) await show(ctx, "🎵 <b>Выбери роли именно в этой команде</b>", rolesKeyboard(fresh.pendingJoinRoles, "jr", fresh.customRoles));
    return;
  }
  if (action === "other") {
    await ctx.answerCallbackQuery();
    await User.updateOne({ _id: user._id }, { inputMode: "join_custom_role" });
    return show(ctx, "✍️ <b>Напиши свою роль в этой команде</b>");
  }
  if (action === "done") {
    if (!user.pendingJoinRoles.length) return void (await ctx.answerCallbackQuery({ text: "Выбери хотя бы одну роль", show_alert: true }));
    await ctx.answerCallbackQuery();
    const team = await validatePendingTeam(ctx, user.pendingTeamJoinCode!);
    if (!team) return;
    await addWorshipTeamMember(String(team._id), ctx.from.id, user.pendingJoinRoles);
    await User.updateOne({ _id: user._id }, { pendingTeamJoinCode: null, pendingJoinRoles: [], inputMode: "none" });
    await ctx.reply("✅ Ты присоединился к команде!");
    return showTeam(ctx, String(team._id));
  }
});

privatePortalComposer.on("message:text", async (ctx, next) => {
  if (ctx.chat.type !== "private" || ctx.message.text.startsWith("/")) return next();
  if (ctx.session.audioSetup) {
    const { songId, mode } = ctx.session.audioSetup;
    const song = await getPracticeSong(ctx, songId);
    if (!song || !(await isAdmin(ctx.from.id, song.team))) {
      ctx.session.audioSetup = undefined;
      return void (await ctx.reply("Настройка недоступна. Открой песню ещё раз."));
    }
    const raw = ctx.message.text.trim();
    if (mode === "holy_link") {
      try {
        const imported = await fetchHolyChordsSections(raw);
        await Song.updateOne({ _id: songId }, { $set: { "audio.guideChart": { url: imported.url, sections: imported.sections, status: "imported", importedAt: new Date() } } });
        ctx.session.audioSetup = undefined;
        if (song.audio?.processingStatus === "awaiting_chords" && song.audio.original?.path) {
          const directories = await ensureAudioDirectories(songId);
          const user = await User.findOne({ telegramId: ctx.from.id });
          if (!user) throw new Error("Пользователь не найден.");
          await createSeparationJob(song._id, user._id, song.audio.original.path, directories.stems);
        }
        const ready = song.audio?.processingStatus === "completed" && song.audio.accompaniment?.status === "ready";
        await ctx.reply(`✅ Нашёл ${imported.sections.length} частей песни. ${ready ? "Предложу примерные времена по сетке клика, затем ты их проверишь." : "Аудио поставлено в очередь. После разделения предложу времена частей для проверки."}`, { reply_markup: new InlineKeyboard().text(ready ? "🎙 РАЗМЕТИТЬ ЧАСТИ" : "🎛 СТАТУС ОБРАБОТКИ", ready ? `ap:holydraft:${songId}` : `ap:status:${songId}`) });
      } catch (error) {
        console.warn("holychords_import_failed", { songId, error: error instanceof Error ? error.message : String(error) });
        await ctx.reply(`⚠️ ${error instanceof Error ? error.message : "Не удалось прочитать страницу."} Пришли другую ссылку HolyChords или попробуй ещё раз.`, { reply_markup: new InlineKeyboard().text("✖️ ОТМЕНА", `ap:setupcancel:${songId}`) });
      }
      return;
    }
    if (song.audio?.processingStatus !== "completed" || !song.audio.original?.path) {
      ctx.session.audioSetup = undefined;
      return void (await ctx.reply("Настройка недоступна. Открой песню ещё раз."));
    }
    if (mode === "holy_times") {
      const chart = song.audio.guideChart;
      if (!chart?.sections?.length) { ctx.session.audioSetup = undefined; return void (await ctx.reply("Сначала добавь ссылку HolyChords.")); }
      const times = raw.split(/[,;]+/).map((part) => {
        const value = part.trim();
        const match = value.match(/^(\d{1,2}):(\d{2})$/);
        return match && Number(match[2]) < 60 ? Number(match[1]) * 60 + Number(match[2]) : NaN;
      });
      if (times.length !== chart.sections.length || times.some((at, index) => !Number.isFinite(at) || (index > 0 && at <= times[index - 1]))) {
        return void (await ctx.reply(`Нужно ${chart.sections.length} отметок по возрастанию в формате 0:00, 0:16, 0:32.`));
      }
      const beats = song.audio.accompaniment?.beats ?? [];
      if (beats.length && times[times.length - 1] > (beats[beats.length - 1] ?? 0)) return void (await ctx.reply("Последняя отметка выходит за пределы записи. Проверь времена."));
      const sections = chart.sections.map((section, index) => ({ name: section.name, label: section.label, weight: section.weight, lyrics: section.lyrics, variant: section.variant, draftAt: times[index] }));
      await Song.updateOne({ _id: songId }, { $set: { "audio.guideChart.sections": sections, "audio.guideChart.status": "draft" } });
      ctx.session.audioSetup = undefined;
      return void (await ctx.reply("✅ Времена сохранены. Проверь их перед созданием гайда.", { reply_markup: new InlineKeyboard().text("🎙 ПРОВЕРИТЬ ЧАСТИ", `ap:holyreview:${songId}`) }));
    }
    const existing = song.audio.accompaniment;
    let tempo = existing?.tempo;
    let beatsPerBar = existing?.beatsPerBar;
    let firstBeatAt = existing?.firstBeatAt;
    let sections = (existing?.sections ?? []) as SectionMark[];
    if (mode === "timing") {
      const values = raw.replace(",", ".").split(/\s+/).map(Number);
      if (values.length !== 3 || values.some((value) => !Number.isFinite(value)) || values[0] < 40 || values[0] > 240 || !Number.isInteger(values[1]) || values[1] < 2 || values[1] > 12 || values[2] < 0) {
        return void (await ctx.reply("Нужны три значения: BPM (40–240), доли в такте (2–12), первая доля в секундах. Например: 120 4 2.5"));
      }
      [tempo, beatsPerBar, firstBeatAt] = values;
    } else {
      if (!tempo || !beatsPerBar || firstBeatAt === undefined) return void (await ctx.reply("Сначала укажи темп и начало первого такта."));
      const parsed = raw.split(";").map((part) => {
        const match = part.trim().match(/^(\d{1,2}):(\d{2})\s+(.+)$/);
        if (!match || Number(match[2]) > 59) return null;
        const name = resolveSectionName(match[3]);
        return name ? { at: Number(match[1]) * 60 + Number(match[2]), name } : null;
      });
      if (!parsed.length || parsed.length > 50 || parsed.some((part) => !part)) return void (await ctx.reply(`Не понял разметку. Пример: 0:12 Intro; 0:28 Verse; 1:04 Chorus. Доступно: ${SECTION_NAMES.join(", ")}.`));
      sections = parsed as SectionMark[];
      if (sections.some((part, index) => index > 0 && part.at <= sections[index - 1].at)) return void (await ctx.reply("Укажи части в порядке времени, без повторяющихся отметок."));
    }
    const progress = await ctx.reply("🎚 Готовлю отдельные дорожки клика и гайда. Это может занять немного времени...");
    try {
      const beats = mode === "sections" ? existing?.beats ?? undefined : undefined;
      const generated = await createAccompaniment(songId, song.audio.original.path, { tempo: tempo!, beatsPerBar: beatsPerBar!, firstBeatAt: firstBeatAt!, sections, beats });
      await Song.updateOne({ _id: songId }, { $set: { "audio.accompaniment": { tempo, beatsPerBar, firstBeatAt, sections, beats, source: beats ? "automatic" : "manual", ...generated, status: "ready" } } });
      ctx.session.audioSetup = undefined;
      ctx.session.audioMixer = undefined;
      await ctx.api.editMessageText(ctx.chat.id, progress.message_id, `✅ Клик готов.${generated.guide ? " Гайд готов." : " Гайд пока недоступен: добавь части песни и проверь путь к голосовым сэмплам на сервере."}`, { reply_markup: new InlineKeyboard().text("🎚 ОТКРЫТЬ PLAYBACK", `ap:mixer:${songId}`) });
    } catch (error) {
      console.error("audio_accompaniment_failed", { songId, error: error instanceof Error ? error.message : String(error) });
      const message = error instanceof Error ? error.message : "Не удалось подготовить дорожки.";
      await ctx.api.editMessageText(ctx.chat.id, progress.message_id, `⚠️ Не удалось подготовить клик и гайд: ${message.slice(0, 300)}`);
    }
    return;
  }
  const user = await User.findOne({ telegramId: ctx.from.id });
  if (!user || user.inputMode === "none") return next();
  const text = ctx.message.text.trim();
  if (user.inputMode === "search_song") {
    const teamId = user.pendingSongSearchTeamId ? String(user.pendingSongSearchTeamId) : "";
    await User.updateOne({ _id: user._id }, { $set: { inputMode: "none" }, $unset: { pendingSongSearchTeamId: 1 } });
    const team = teamId ? await getAccessibleTeam(teamId, ctx.from.id) : null;
    if (!team) return void (await ctx.reply("Команда недоступна. Открой список песен и попробуй ещё раз."));
    if (!text) return void (await ctx.reply("Напиши название песни или исполнителя.", { reply_markup: new InlineKeyboard().text("🔎 ИСКАТЬ СНОВА", `team:search:${teamId}`) }));
    const matches = await findSongsInTeam(team._id, text);
    if (!matches.length) return void (await ctx.reply("Ничего не нашёл.", { reply_markup: new InlineKeyboard().text("🔎 ИСКАТЬ СНОВА", `team:search:${teamId}`).row().text("⬅️ К ПЕСНЯМ", `team:songs:${teamId}`) }));
    if (matches.length === 1) {
      const song = matches[0];
      return void (await ctx.reply(formatSongCard(song), { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("🎵 ОТКРЫТЬ ПЕСНЮ", `song:o:${song._id}`).row().text("🔎 ИСКАТЬ СНОВА", `team:search:${teamId}`) }));
    }
    const keyboard = new InlineKeyboard();
    matches.forEach((song) => keyboard.text(`${song.title}${song.artist ? ` — ${song.artist}` : ""}`.slice(0, 64), `song:o:${song._id}`).row());
    keyboard.text("🔎 ИСКАТЬ СНОВА", `team:search:${teamId}`).row().text("⬅️ К ПЕСНЯМ", `team:songs:${teamId}`);
    return void (await ctx.reply(`Найдено несколько песен по запросу «${text}». Выбери нужную:`, { reply_markup: keyboard }));
  }
  if (user.inputMode === "profile_fio" || user.inputMode === "profile_group") {
    const max = user.inputMode === "profile_fio" ? 100 : 70;
    if (text.length < 2 || text.length > max) return void (await ctx.reply(`Значение должно содержать от 2 до ${max} символов.`));
    await User.updateOne({ _id: user._id }, { $set: user.inputMode === "profile_fio" ? { fullName: text, inputMode: "none" } : { worshipGroupName: text, inputMode: "none" } });
    await ctx.reply("✅ Профиль обновлён.");
    return showProfile(ctx);
  }
  if (user.inputMode === "registration_fio") {
    if (text.length < 2 || text.length > 100) return void (await ctx.reply("Имя должно содержать от 2 до 100 символов."));
    const pending = Boolean(user.pendingTeamJoinCode);
    await User.updateOne({ _id: user._id }, {
      fullName: text,
      registrationStep: pending ? "roles" : "worship_group",
      inputMode: pending ? "none" : "registration_group",
    });
    if (pending) return showRegistrationRoles(ctx, ctx.from.id);
    return void (await ctx.reply("🎸 <b>Как называется ваша группа прославления?</b>\n\nНапример: Слово Жизни Worship", { parse_mode: "HTML" }));
  }
  if (user.inputMode === "registration_group") {
    if (text.length < 2 || text.length > 70) return void (await ctx.reply("Название должно содержать от 2 до 70 символов."));
    await User.updateOne({ _id: user._id }, { worshipGroupName: text, registrationStep: "roles", inputMode: "none" });
    return showRegistrationRoles(ctx, ctx.from.id);
  }
  if (user.inputMode === "registration_custom_role" || user.inputMode === "join_custom_role") {
    if (text.length < 2 || text.length > 40) return void (await ctx.reply("Роль должна содержать от 2 до 40 символов."));
    const isJoin = user.inputMode === "join_custom_role";
    await User.updateOne({ _id: user._id }, {
      $addToSet: {
        customRoles: text,
        ...(isJoin ? { pendingJoinRoles: text } : { defaultRoles: text }),
      },
      $set: { inputMode: "none" },
    });
    if (isJoin) {
      const fresh = await User.findById(user._id);
      if (fresh) return show(ctx, "🎵 <b>Выбери роли именно в этой команде</b>", rolesKeyboard(fresh.pendingJoinRoles, "jr", fresh.customRoles));
    }
    return showRegistrationRoles(ctx, ctx.from.id);
  }
  if (user.inputMode === "create_team") {
    if (text.length < 2 || text.length > 70) return void (await ctx.reply("Название должно содержать от 2 до 70 символов."));
    const team = await createWorshipTeam(text, ctx.from.id, user.defaultRoles);
    await User.updateOne({ _id: user._id }, { inputMode: "none" });
    await ctx.reply("✅ Команда создана!");
    return showTeam(ctx, String(team._id));
  }
  return next();
});
