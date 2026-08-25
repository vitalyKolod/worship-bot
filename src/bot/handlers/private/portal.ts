import { Composer, InlineKeyboard } from "grammy";
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
import { formatSongCard } from "../../views/songCard";

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

function escapeHtml(value: unknown): string {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function show(ctx: MyContext, text: string, keyboard?: InlineKeyboard): Promise<void> {
  const options = { parse_mode: "HTML" as const, ...(keyboard ? { reply_markup: keyboard } : {}) };
  if (ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text, options);
      return;
    } catch (error) {
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
  const keyboard = new InlineKeyboard().text("⬅️ НАЗАД", "nav:main");
  await show(
    ctx,
    `👤 <b>ПРОФИЛЬ</b>\n\n<b>${escapeHtml(user.fullName ?? user.firstName ?? "Без имени")}</b>\n\n` +
      `🎸 <b>Группа прославления:</b>\n${escapeHtml(user.worshipGroupName ?? "Не указана")}\n\n` +
      `🎵 <b>Основные роли:</b>\n${user.defaultRoles.map(escapeHtml).join(", ") || "Не указаны"}`,
    keyboard
  );
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
  keyboard.text("🎵 ВСЕ ПЕСНИ", `team:songs:${team._id}`).row();
  if (isOwner) keyboard.text("➕ ДОБАВИТЬ ПЕСНЮ", `team:add_song:${team._id}`).row();
  if (isOwner && connected && team.joinCode) {
    keyboard.text("👤 ПРИГЛАСИТЬ УЧАСТНИКА", `team:invite:${team._id}`).row();
  }
  if (isOwner && !connected) keyboard.text("ℹ️ КАК ПОДКЛЮЧИТЬ ГРУППУ", `team:help:${team._id}`).row();
  keyboard.text("⬅️ НАЗАД", "nav:teams").text("🏠 ГЛАВНАЯ", "nav:main");
  await show(ctx, text, keyboard);
}

async function showSongList(ctx: MyContext, teamId: string, requestedPage = 0): Promise<void> {
  const team = await getAccessibleTeam(teamId, ctx.from!.id);
  if (!team) return void (await show(ctx, "У тебя нет доступа к этой команде."));
  const pageSize = 10;
  const total = await Song.countDocuments({ team: team._id });
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.max(0, Math.min(requestedPage, pages - 1));
  const songs = await Song.find({ team: team._id })
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
  const target = ctx.callbackQuery.data.split(":")[1];
  if (target === "main") return showMain(ctx);
  if (target === "profile") return showProfile(ctx);
  if (target === "teams") return showTeamList(ctx);
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
  if (action === "page") return;
  if (action === "add_song") {
    const team = await getAccessibleTeam(id, ctx.from.id);
    if (!team || team.ownerId !== ctx.from.id) {
      return show(ctx, "Добавлять песни может только владелец команды.");
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
    return show(ctx, `🎸 <b>Как называется ваша команда прославления?</b>\n\n${user.worshipGroupName ? `Например: ${escapeHtml(user.worshipGroupName)}` : "Напиши название от 2 до 70 символов."}`);
  }
  if (action === "help") return showTeam(ctx, id);
});

privatePortalComposer.callbackQuery(/^song:o:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const songId = ctx.callbackQuery.data.split(":")[2];
  const song = await Song.findById(songId);
  if (!song) return void (await show(ctx, "Песня не найдена."));
  const team = await getAccessibleTeam(String(song.team), ctx.from.id);
  if (!team) return void (await show(ctx, "У тебя нет доступа к этой песне."));
  const keyboard = new InlineKeyboard().text("⬅️ НАЗАД", `team:songs:${team._id}`);
  if (await isAdmin(ctx.from.id, team._id)) {
    keyboard.text("✏️ РЕДАКТИРОВАТЬ", `song:edit:${song._id}`);
  }
  await show(ctx, formatSongCard(song), keyboard);
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
  const user = await User.findOne({ telegramId: ctx.from.id });
  if (!user || user.inputMode === "none") return next();
  const text = ctx.message.text.trim();
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
