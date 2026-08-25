import { Composer, GrammyError, InlineKeyboard } from "grammy";
import { MyContext } from "../context";
import { env } from "../../config/env";
import { Rehearsal } from "../../models/Rehearsal";
import { Song } from "../../models/Song";
import { Team } from "../../models/Team";
import { User } from "../../models/User";
import { WorshipService } from "../../models/WorshipService";
import { endOfDay, startOfDay } from "../../services/date-parser.service";
import { escapeHtml, formatEventDate, formatEventDateTime, formatEventTime, formatRehearsalCard } from "../../services/event-format.service";
import { ROLE_DEFINITIONS, roleIconHtml, rolePresentation } from "../../services/message-intent.service";
import { cancelRehearsal, getAttendanceSummary, getNextRehearsal, getRehearsalsForDay, listUpcomingRehearsals, saveAttendance } from "../../services/rehearsal.service";
import { getAdminTeams, getTeamsForUser, isAdmin } from "../../services/teamService";
import { addLineupMember, addSetlistSong, cancelWorshipService, completeWorshipService, getLineupNames, getNextWorshipService, getServicesForDay, getSetlist, listUpcomingServices, moveSetlistSong, removeLineupMember, removeSetlistSong } from "../../services/worship-service.service";
import { notifyTeamGroup, pinServiceAnnouncement, sendTeamGroupMessage, unpinServiceAnnouncement } from "../../services/notification.service";

export const scheduleComposer = new Composer<MyContext>();

type TeamAction = "r" | "rs" | "ra" | "re" | "rc" | "sv" | "sa" | "se" | "sc" | "td" | "nx" | "ln" | "sl";

async function showScheduleScreen(ctx: MyContext, text: string, keyboard?: InlineKeyboard, html = true): Promise<void> {
  const options = { ...(html ? { parse_mode: "HTML" as const } : {}), ...(keyboard ? { reply_markup: keyboard } : {}) };
  if (ctx.chat?.type === "private" && ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text, options);
      return;
    } catch (error) {
      if (error instanceof GrammyError && error.description.includes("message is not modified")) return;
    }
  }
  await ctx.reply(text, options);
}

async function chooseTeam(ctx: MyContext, action: TeamAction, adminOnly: boolean) {
  if (ctx.team) {
    if (adminOnly && !(await isAdmin(ctx.from!.id, ctx.team._id))) {
      await ctx.reply("Это действие доступно только администратору команды.");
      return null;
    }
    return ctx.team;
  }
  if (ctx.chat?.type !== "private") {
    await ctx.reply("Эта группа ещё не привязана к команде. Администратору нужно выполнить /setup.");
    return null;
  }
  const teams = adminOnly ? await getAdminTeams(ctx.from!.id) : await getTeamsForUser(ctx.from!.id);
  if (!teams.length) {
    await ctx.reply(adminOnly ? "У тебя нет команд для управления." : "У тебя пока нет доступных команд.");
    return null;
  }
  if (teams.length === 1) return teams[0];
  const keyboard = new InlineKeyboard();
  teams.forEach((team) => keyboard.text(team.name, `ev:t:${action}:${team._id}`).row());
  await ctx.reply("Выбери команду:", { reply_markup: keyboard });
  return null;
}

function rehearsalKeyboard(rehearsalId: string, admin: boolean, backData?: string): InlineKeyboard {
  const keyboard = new InlineKeyboard()
    .text("✅ Буду", `att:y:${rehearsalId}`)
    .text("🟡 Опоздаю", `att:l:${rehearsalId}`)
    .text("❌ Не смогу", `att:n:${rehearsalId}`)
    .row()
    .text("👥 Ответы", `reh:stats:${rehearsalId}`);
  if (admin) keyboard.row().text("✏️ Перенести", `reh:edit:${rehearsalId}`).text("❌ Отменить", `reh:cancelask:${rehearsalId}`);
  if (admin) keyboard.row().text("👥 Изменить состав", `reh:lineup:${rehearsalId}`);
  if (backData) keyboard.row().text("⬅️ Назад", backData);
  return keyboard;
}

async function showNearestRehearsal(ctx: MyContext, teamId: string): Promise<void> {
  const rehearsal = await getNextRehearsal(teamId);
  if (!rehearsal) return void (await ctx.reply("Ближайших репетиций пока нет."));
  await showScheduleScreen(ctx, formatRehearsalCard(rehearsal), rehearsalKeyboard(rehearsal.id, await isAdmin(ctx.from!.id, teamId), `ev:t:rs:${teamId}`));
}

async function showRehearsalList(ctx: MyContext, teamId: string, cancelMode = false): Promise<void> {
  const rehearsals = await listUpcomingRehearsals(teamId, 10);
  if (!rehearsals.length) return void (await ctx.reply("Предстоящих репетиций пока нет."));
  const keyboard = new InlineKeyboard();
  rehearsals.forEach((item) => keyboard.text(formatEventDateTime(item.startsAt), cancelMode ? `reh:cancelask:${item.id}` : `reh:open:${item.id}`).row());
  if (ctx.chat?.type === "private") keyboard.text("⬅️ Назад к команде", `team:o:${teamId}`);
  await showScheduleScreen(ctx, cancelMode ? "Какую репетицию отменить?" : "📅 Ближайшие репетиции:", keyboard, false);
}

function formatServiceCard(service: any, lineup: Array<{ role: string; slotLabel?: string | null; name: string }> = []): string {
  return [
    `⛪ <b>${escapeHtml(service.title ?? "Служение")}</b>`,
    "",
    `📅 ${escapeHtml(formatEventDate(service.startsAt))}`,
    `🕖 ${escapeHtml(formatEventTime(service.startsAt))}`,
    ...(service.soundcheckAt ? [`🎚 Саундчек: ${escapeHtml(formatEventTime(service.soundcheckAt))}`] : []),
    ...(service.location ? [`📍 ${escapeHtml(service.location)}`] : []),
    ...(lineup.length ? ["", "👥 <b>СОСТАВ</b>", ...lineup.map((item) => {
      const role = rolePresentation(item.role);
      return `${roleIconHtml(item.role)} <b>${escapeHtml(item.slotLabel ?? role.label)}</b> — ${escapeHtml(item.name)}`;
    })] : []),
  ].join("\n");
}

async function showService(ctx: MyContext, serviceId: string): Promise<void> {
  const service = await WorshipService.findById(serviceId);
  if (!service) return void (await ctx.reply("Служение не найдено."));
  const team = await Team.findById(service.team);
  if (!team || !(team.ownerId === ctx.from!.id || team.members.some((member) => member.telegramId === ctx.from!.id))) return void (await ctx.reply("Нет доступа к служению."));
  const lineupData = await getLineupNames(service.id);
  const rehearsals = await Rehearsal.find({ service: service._id, status: "scheduled" }).sort({ startsAt: 1 }).lean();
  const keyboard = new InlineKeyboard().text("👥 Состав", `svc:ln:${service.id}`).text("🎵 Песни", `svc:sl:${service.id}`).row().text("🎸 Репетиции", `svc:rh:${service.id}`);
  if (await isAdmin(ctx.from!.id, team._id)) {
    keyboard.row().text("✏️ Дата / место", `svc:edit:${service.id}`).text("⚙️ Песни по блокам", `svc:smartset:${service.id}`);
    keyboard.row().text("➕ Репетиция", `svc:addreh:${service.id}`).text("✅ Завершить", `svc:completeask:${service.id}`);
    keyboard.row().text("📌 Закрепить / обновить", `svc:pin:${service.id}`);
    keyboard.row().text("❌ Отменить служение", `svc:cancelask:${service.id}`);
  }
  if (ctx.chat?.type === "private") keyboard.row().text("⬅️ Назад к служениям", `ev:t:sv:${service.team}`);
  const rehearsalLines = rehearsals.length ? `\n\n🎸 <b>РЕПЕТИЦИИ</b>\n${rehearsals.map((item) => `• ${escapeHtml(formatEventDateTime(item.startsAt))}${item.location ? ` — ${escapeHtml(item.location)}` : ""}`).join("\n")}` : "";
  await showScheduleScreen(ctx, formatServiceCard(service, lineupData?.lineup ?? []) + rehearsalLines, keyboard);
}

async function showServices(ctx: MyContext, teamId: string, cancelMode = false): Promise<void> {
  const services = await listUpcomingServices(teamId, 10);
  if (!services.length) return void (await ctx.reply("Ближайших служений пока нет."));
  const keyboard = new InlineKeyboard();
  services.forEach((service) => keyboard.text(`${service.title} — ${formatEventDateTime(service.startsAt)}`.slice(0, 64), cancelMode ? `svc:cancelask:${service.id}` : `svc:o:${service.id}`).row());
  if (ctx.chat?.type === "private") keyboard.text("⬅️ Назад к команде", `team:o:${teamId}`);
  await showScheduleScreen(ctx, cancelMode ? "Какое служение отменить?" : "⛪ <b>Служения и репетиции</b>\n\nВыбери служение:", keyboard, !cancelMode);
}

async function showLineup(ctx: MyContext, serviceId: string): Promise<void> {
  const result = await getLineupNames(serviceId);
  if (!result) return void (await ctx.reply("Служение не найдено."));
  const team = await Team.findById(result.service.team);
  if (!team || !(team.ownerId === ctx.from!.id || team.members.some((member) => member.telegramId === ctx.from!.id))) return void (await ctx.reply("Нет доступа."));
  const lines = result.lineup.map((item) => {
    const view = rolePresentation(item.role);
    return `${roleIconHtml(item.role)} <b>${escapeHtml(item.slotLabel ?? view.label)}</b> — ${escapeHtml(item.name)}`;
  });
  const keyboard = new InlineKeyboard();
  if (await isAdmin(ctx.from!.id, team._id)) keyboard.text("✍️ Ввести состав именами", `ln:manual:${serviceId}`).row().text("⚙️ Выбрать участников бота", `ln:roles:${serviceId}`);
  keyboard.row().text("⬅️ Назад к служению", `svc:o:${serviceId}`);
  await showScheduleScreen(ctx, `👥 <b>СОСТАВ</b>\n\n${lines.join("\n") || "Состав пока не назначен."}`, keyboard);
}

async function showSetlist(ctx: MyContext, serviceId: string): Promise<void> {
  const service: any = await getSetlist(serviceId);
  if (!service) return void (await ctx.reply("Служение не найдено."));
  const team = await Team.findById(service.team);
  if (!team || !(team.ownerId === ctx.from!.id || team.members.some((member) => member.telegramId === ctx.from!.id))) return void (await ctx.reply("Нет доступа."));
  const items = [...service.setlist].sort((a: any, b: any) => a.order - b.order);
  const sectionNames: Record<string, string> = { main: "Основной блок", transition: "Между", offering: "Пожертвование" };
  const lines: string[] = [];
  for (const section of ["main", "transition", "offering"]) {
    const sectionItems = items.filter((item: any) => (item.section ?? "main") === section);
    if (!sectionItems.length) continue;
    lines.push(`<b>${sectionNames[section]}</b>`);
    sectionItems.forEach((item: any, index: number) => lines.push(`${index + 1}. ${escapeHtml(item.song?.title ?? "Песня удалена")}${item.key ? ` — ${escapeHtml(item.key)}` : ""}`));
  }
  const keyboard = new InlineKeyboard();
  if (await isAdmin(ctx.from!.id, team._id)) {
    keyboard.text("✨ Собрать по блокам", `svc:smartset:${serviceId}`).row().text("➕ Добавить одну песню", `sl:add:${serviceId}`).row();
    items.forEach((item: any) => {
      const songId = String(item.song?._id ?? item.song);
      keyboard.text(`⬆️ ${String(item.song?.title ?? "Песня").slice(0, 22)}`, `sl:u:${serviceId}:${songId}`)
        .text("⬇️", `sl:n:${serviceId}:${songId}`)
        .text("🎹", `sl:k:${serviceId}:${songId}`)
        .text("🗑", `sl:d:${serviceId}:${songId}`).row();
    });
  }
  keyboard.row().text("⬅️ Назад к служению", `svc:o:${serviceId}`);
  await showScheduleScreen(ctx, `🎵 <b>СЕТ-ЛИСТ</b>\n\n${lines.join("\n") || "Песни пока не добавлены."}`, keyboard);
}

async function showToday(ctx: MyContext, teamId: string): Promise<void> {
  const now = new Date();
  const [rehearsals, services] = await Promise.all([getRehearsalsForDay(teamId, now), getServicesForDay(teamId, now)]);
  if (!rehearsals.length && !services.length) return void (await ctx.reply("На сегодня ничего не запланировано."));
  const lines = [`📅 <b>Сегодня, ${escapeHtml(formatEventDate(now))}</b>`];
  rehearsals.forEach((item) => lines.push(`\n🎸 Репетиция — ${formatEventTime(item.startsAt)}${item.location ? `\n📍 ${escapeHtml(item.location)}` : ""}`));
  for (const service of services) {
    lines.push(`\n⛪ ${escapeHtml(service.title)} — ${formatEventTime(service.startsAt)}`);
    const roles = service.lineup.filter((item) => item.userTelegramId === ctx.from!.id).map((item) => rolePresentation(item.role));
    if (roles.length) lines.push(`Твоя роль: ${service.lineup.filter((item) => item.userTelegramId === ctx.from!.id).map((item) => `${roleIconHtml(item.role)} ${escapeHtml(rolePresentation(item.role).label)}`).join(", ")}`);
    const populated: any = await getSetlist(service.id);
    if (populated?.setlist.length) lines.push("🎵 " + populated.setlist.sort((a: any, b: any) => a.order - b.order).map((item: any) => `${item.order}. ${escapeHtml(item.song?.title ?? "Песня")}${item.key ? ` — ${escapeHtml(item.key)}` : ""}`).join("\n"));
  }
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}

async function showNext(ctx: MyContext, teamId: string): Promise<void> {
  const [rehearsal, service] = await Promise.all([getNextRehearsal(teamId), getNextWorshipService(teamId)]);
  if (!rehearsal && !service) return void (await ctx.reply("Ближайших событий пока нет."));
  if (rehearsal && (!service || rehearsal.startsAt <= service.startsAt)) return showNearestRehearsal(ctx, teamId);
  return showService(ctx, service!.id);
}

async function executeTeamAction(ctx: MyContext, action: TeamAction, teamId: string): Promise<void> {
  if (action === "r") return showNearestRehearsal(ctx, teamId);
  if (action === "rs") return showRehearsalList(ctx, teamId);
  if (action === "ra") return void (await ctx.conversation.enter("rehearsalFlow", teamId));
  if (action === "re") return void (await ctx.conversation.enter("editRehearsalFlow", teamId));
  if (action === "rc") return showRehearsalList(ctx, teamId, true);
  if (action === "sv") return showServices(ctx, teamId);
  if (action === "sa") return void (await ctx.conversation.enter("serviceFlow", teamId));
  if (action === "se") return void (await ctx.conversation.enter("editServiceFlow", teamId));
  if (action === "sc") return showServices(ctx, teamId, true);
  if (action === "td") return showToday(ctx, teamId);
  if (action === "nx") return showNext(ctx, teamId);
  if (action === "ln") {
    const service = await getNextWorshipService(teamId);
    return service ? showLineup(ctx, service.id) : void (await ctx.reply("Ближайших служений нет."));
  }
  const service = await getNextWorshipService(teamId);
  return service ? showSetlist(ctx, service.id) : void (await ctx.reply("Ближайших служений нет."));
}

const commands: Array<[string, TeamAction, boolean]> = [
  ["rehearsal", "r", false], ["rehearsals", "rs", false], ["rehearsal_add", "ra", true],
  ["rehearsal_edit", "re", true], ["rehearsal_cancel", "rc", true], ["services", "sv", false],
  ["service_add", "sa", true], ["service_edit", "se", true], ["service_cancel", "sc", true], ["today", "td", false], ["next", "nx", false],
  ["lineup", "ln", false], ["setlist", "sl", false],
];
commands.forEach(([command, action, adminOnly]) => scheduleComposer.command(command, async (ctx) => {
  const team = await chooseTeam(ctx, action, adminOnly);
  if (team) await executeTeamAction(ctx, action, String(team._id));
}));

scheduleComposer.callbackQuery(/^ev:t:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const [, , action, teamId] = ctx.callbackQuery.data.split(":") as [string, string, TeamAction, string];
  const adminOnly = ["ra", "re", "rc", "sa", "se", "sc"].includes(action);
  const teams = adminOnly ? await getAdminTeams(ctx.from.id) : await getTeamsForUser(ctx.from.id);
  if (!teams.some((team) => String(team._id) === teamId)) return void (await ctx.reply("Команда недоступна."));
  await executeTeamAction(ctx, action, teamId);
});

scheduleComposer.callbackQuery(/^reh:open:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rehearsal = await Rehearsal.findById(ctx.callbackQuery.data.split(":")[2]);
  if (!rehearsal) return void (await ctx.reply("Репетиция не найдена."));
  const team = await Team.findById(rehearsal.team);
  if (!team || !(team.ownerId === ctx.from.id || team.members.some((member) => member.telegramId === ctx.from.id))) return void (await ctx.reply("Нет доступа."));
  const backData = rehearsal.service ? `svc:rh:${rehearsal.service}` : `ev:t:rs:${rehearsal.team}`;
  await showScheduleScreen(ctx, formatRehearsalCard(rehearsal), rehearsalKeyboard(rehearsal.id, await isAdmin(ctx.from.id, team._id), backData));
});

scheduleComposer.callbackQuery(/^reh:edit:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rehearsal = await Rehearsal.findById(ctx.callbackQuery.data.split(":")[2]);
  if (!rehearsal || !(await isAdmin(ctx.from.id, rehearsal.team))) return void (await ctx.reply("Репетиция недоступна."));
  await ctx.conversation.enter("editRehearsalFlow", String(rehearsal.team), rehearsal.id);
});

scheduleComposer.callbackQuery(/^reh:lineup:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rehearsal = await Rehearsal.findById(ctx.callbackQuery.data.split(":")[2]);
  if (!rehearsal || !(await isAdmin(ctx.from.id, rehearsal.team))) return void (await ctx.reply("Репетиция недоступна."));
  await ctx.conversation.enter("manualLineupFlow", String(rehearsal.team), "rehearsal", rehearsal.id);
});

scheduleComposer.callbackQuery(/^reh:cancelask:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rehearsal = await Rehearsal.findById(ctx.callbackQuery.data.split(":")[2]);
  if (!rehearsal || !(await isAdmin(ctx.from.id, rehearsal.team))) return void (await ctx.reply("Репетиция недоступна."));
  await showScheduleScreen(ctx, `Отменить репетицию ${formatEventDateTime(rehearsal.startsAt)}?`, new InlineKeyboard().text("✅ Да, отменить", `reh:cancel:${rehearsal.id}`).text("❌ Нет", `reh:open:${rehearsal.id}`), false);
});

scheduleComposer.callbackQuery(/^reh:(cancel|keep):/, async (ctx) => {
  const [, action, id] = ctx.callbackQuery.data.split(":");
  const rehearsal = await Rehearsal.findById(id);
  if (!rehearsal || !(await isAdmin(ctx.from.id, rehearsal.team))) return void (await ctx.answerCallbackQuery({ text: "Недоступно", show_alert: true }));
  if (action === "keep") { await ctx.answerCallbackQuery(); return void (await ctx.editMessageText("Отмена репетиции отменена.")); }
  const cancelled = await cancelRehearsal(rehearsal.team, id, ctx.from.id);
  await ctx.answerCallbackQuery({ text: cancelled ? "Репетиция отменена" : "Не удалось отменить" });
  if (cancelled && ctx.chat?.type === "private") await notifyTeamGroup(ctx.api, rehearsal.team, `❌ Репетиция ${formatEventDateTime(cancelled.startsAt)} отменена.`);
  await ctx.editMessageText(cancelled ? `❌ Репетиция ${formatEventDateTime(cancelled.startsAt)} отменена.` : "Репетиция недоступна.");
});

scheduleComposer.callbackQuery(/^att:/, async (ctx) => {
  const [, action, rehearsalId] = ctx.callbackQuery.data.split(":");
  const rehearsal = await Rehearsal.findById(rehearsalId);
  if (!rehearsal) return void (await ctx.answerCallbackQuery({ text: "Репетиция недоступна", show_alert: true }));
  if (action === "l") {
    await ctx.answerCallbackQuery();
    await ctx.reply("На сколько опоздаешь?", { reply_markup: new InlineKeyboard().text("10 мин", `late:10:${rehearsalId}`).text("20 мин", `late:20:${rehearsalId}`).text("30 мин", `late:30:${rehearsalId}`).row().text("Указать вручную", `late:x:${rehearsalId}`) });
    return;
  }
  const status = action === "y" ? "attending" : "unavailable";
  const saved = await saveAttendance(rehearsal.team, rehearsalId, ctx.from.id, status);
  await ctx.answerCallbackQuery({ text: saved ? (status === "attending" ? "Будешь ✅" : "Не сможешь ❌") : "Не удалось сохранить", show_alert: !saved });
});

scheduleComposer.callbackQuery(/^late:/, async (ctx) => {
  const [, value, rehearsalId] = ctx.callbackQuery.data.split(":");
  const rehearsal = await Rehearsal.findById(rehearsalId);
  if (!rehearsal) return void (await ctx.answerCallbackQuery({ text: "Репетиция недоступна", show_alert: true }));
  await ctx.answerCallbackQuery();
  if (value === "x") return void (await ctx.conversation.enter("lateResponseFlow", String(rehearsal.team), rehearsalId));
  const saved = await saveAttendance(rehearsal.team, rehearsalId, ctx.from.id, "late", Number(value));
  await ctx.reply(saved ? `🟡 Записал опоздание на ${value} мин.` : "Не удалось сохранить ответ.");
});

scheduleComposer.callbackQuery(/^reh:stats:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const rehearsal = await Rehearsal.findById(ctx.callbackQuery.data.split(":")[2]);
  if (!rehearsal) return void (await ctx.reply("Репетиция не найдена."));
  const allowed = await Team.exists({ _id: rehearsal.team, $or: [{ ownerId: ctx.from.id }, { "members.telegramId": ctx.from.id }] });
  if (!allowed) return void (await ctx.reply("Нет доступа к ответам этой команды."));
  const summary = await getAttendanceSummary(rehearsal.team, rehearsal.id);
  if (!summary) return;
  const list = (items: Array<{ telegramId: number; lateMinutes?: number | null }>) => items.map((item) => `${summary.name(item.telegramId)}${item.lateMinutes ? ` (${item.lateMinutes} мин)` : ""}`).join(", ") || "—";
  await showScheduleScreen(
    ctx,
    `👥 <b>Репетиция ${escapeHtml(formatEventDateTime(rehearsal.startsAt))}</b>\n\n✅ Будут: ${summary.attending.length}\n${escapeHtml(list(summary.attending))}\n\n🟡 Опоздают: ${summary.late.length}\n${escapeHtml(list(summary.late))}\n\n❌ Не смогут: ${summary.unavailable.length}\n${escapeHtml(list(summary.unavailable))}\n\n❔ Не ответили: ${summary.unanswered.length}\n${escapeHtml(summary.unanswered.map(summary.name).join(", ") || "—")}`,
    new InlineKeyboard().text("⬅️ Назад к репетиции", `reh:open:${rehearsal.id}`)
  );
});

scheduleComposer.callbackQuery(/^svc:o:/, async (ctx) => { await ctx.answerCallbackQuery(); await showService(ctx, ctx.callbackQuery.data.split(":")[2]); });
scheduleComposer.callbackQuery(/^svc:ln:/, async (ctx) => { await ctx.answerCallbackQuery(); await showLineup(ctx, ctx.callbackQuery.data.split(":")[2]); });
scheduleComposer.callbackQuery(/^svc:sl:/, async (ctx) => { await ctx.answerCallbackQuery(); await showSetlist(ctx, ctx.callbackQuery.data.split(":")[2]); });

scheduleComposer.callbackQuery(/^svc:rh:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const service = await WorshipService.findById(ctx.callbackQuery.data.split(":")[2]);
  if (!service) return void (await ctx.reply("Служение не найдено."));
  const team = await Team.findById(service.team);
  if (!team || !(team.ownerId === ctx.from.id || team.members.some((member) => member.telegramId === ctx.from.id))) return void (await ctx.reply("Нет доступа."));
  const rehearsals = await Rehearsal.find({ service: service._id, status: "scheduled" }).sort({ startsAt: 1 });
  const keyboard = new InlineKeyboard();
  rehearsals.forEach((item) => keyboard.text(formatEventDateTime(item.startsAt), `reh:open:${item.id}`).row());
  if (await isAdmin(ctx.from.id, service.team)) keyboard.text("➕ Добавить репетицию", `svc:addreh:${service.id}`);
  keyboard.row().text("⬅️ Назад к служению", `svc:o:${service.id}`);
  await showScheduleScreen(ctx, rehearsals.length ? "🎸 Репетиции этого служения:" : "У этого служения пока нет репетиций.", keyboard, false);
});

scheduleComposer.callbackQuery(/^svc:addreh:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const service = await WorshipService.findById(ctx.callbackQuery.data.split(":")[2]);
  if (!service || !(await isAdmin(ctx.from.id, service.team))) return void (await ctx.reply("Служение недоступно."));
  await ctx.conversation.enter("linkedRehearsalFlow", String(service.team), service.id);
});

scheduleComposer.callbackQuery(/^svc:smartset:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const service = await WorshipService.findById(ctx.callbackQuery.data.split(":")[2]);
  if (!service || !(await isAdmin(ctx.from.id, service.team))) return void (await ctx.reply("Служение недоступно."));
  await ctx.conversation.enter("serviceSetlistFlow", String(service.team), service.id);
});

scheduleComposer.callbackQuery(/^svc:pin:/, async (ctx) => {
  const service = await WorshipService.findById(ctx.callbackQuery.data.split(":")[2]);
  if (!service || !(await isAdmin(ctx.from.id, service.team))) return void (await ctx.answerCallbackQuery({ text: "Служение недоступно", show_alert: true }));
  const lineupData = await getLineupNames(service.id);
  const rehearsals = await Rehearsal.find({ service: service._id, status: "scheduled" }).sort({ startsAt: 1 }).lean();
  const text = formatServiceCard(service, lineupData?.lineup ?? []) + (rehearsals.length
    ? `\n\n🎸 <b>РЕПЕТИЦИИ</b>\n${rehearsals.map((item) => `• ${escapeHtml(formatEventDateTime(item.startsAt))}${item.location ? ` — ${escapeHtml(item.location)}` : ""}`).join("\n")}`
    : "");
  await unpinServiceAnnouncement(ctx.api, service.id);
  let pinned = false;
  if ((ctx.chat?.type === "group" || ctx.chat?.type === "supergroup") && ctx.callbackQuery.message) {
    try {
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("⛪ Открыть служение", `svc:o:${service.id}`) });
    } catch { /* Карточка уже актуальна. */ }
    pinned = await pinServiceAnnouncement(ctx.api, service.id, ctx.chat.id, ctx.callbackQuery.message.message_id);
  } else {
    const sent = await sendTeamGroupMessage(ctx.api, service.team, text, new InlineKeyboard().text("⛪ Открыть служение", `svc:o:${service.id}`));
    if (sent) pinned = await pinServiceAnnouncement(ctx.api, service.id, sent.chatId, sent.messageId);
  }
  await ctx.answerCallbackQuery({ text: pinned ? "Служение закреплено" : "Не удалось закрепить. Проверь право бота закреплять сообщения.", show_alert: !pinned });
});

scheduleComposer.callbackQuery(/^svc:completeask:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const service = await WorshipService.findById(ctx.callbackQuery.data.split(":")[2]);
  if (!service || !(await isAdmin(ctx.from.id, service.team))) return void (await ctx.reply("Служение недоступно."));
  await showScheduleScreen(ctx, `Служение «${service.title}» уже завершено? Оно уйдёт в архив, данные не удалятся.`, new InlineKeyboard().text("✅ Да, завершить", `svc:complete:${service.id}`).text("⬅️ Назад", `svc:o:${service.id}`), false);
});

scheduleComposer.callbackQuery(/^svc:complete:/, async (ctx) => {
  const service = await WorshipService.findById(ctx.callbackQuery.data.split(":")[2]);
  if (!service || !(await isAdmin(ctx.from.id, service.team))) return void (await ctx.answerCallbackQuery({ text: "Недоступно", show_alert: true }));
  const completed = await completeWorshipService(service.team, service.id);
  if (completed) await Rehearsal.updateMany({ service: service._id, status: "scheduled" }, { $set: { status: "completed" } });
  if (completed) await unpinServiceAnnouncement(ctx.api, service.id);
  await ctx.answerCallbackQuery({ text: completed ? "Служение перенесено в архив" : "Уже обработано" });
  await ctx.editMessageText(completed ? "✅ Служение завершено и сохранено в архиве." : "Служение уже недоступно.");
});

scheduleComposer.callbackQuery(/^svc:edit:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const service = await WorshipService.findById(ctx.callbackQuery.data.split(":")[2]);
  if (!service || !(await isAdmin(ctx.from.id, service.team))) return void (await ctx.reply("Служение недоступно."));
  await ctx.conversation.enter("editServiceFlow", String(service.team), service.id);
});

scheduleComposer.callbackQuery(/^svc:cancelask:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const service = await WorshipService.findById(ctx.callbackQuery.data.split(":")[2]);
  if (!service || !(await isAdmin(ctx.from.id, service.team))) return void (await ctx.reply("Служение недоступно."));
  await showScheduleScreen(ctx, `Отменить служение ${formatEventDateTime(service.startsAt)}?`, new InlineKeyboard().text("✅ Да, отменить", `svc:cancel:${service.id}`).text("⬅️ Назад", `svc:o:${service.id}`), false);
});

scheduleComposer.callbackQuery(/^svc:(cancel|keep):/, async (ctx) => {
  const [, action, id] = ctx.callbackQuery.data.split(":");
  const service = await WorshipService.findById(id);
  if (!service || !(await isAdmin(ctx.from.id, service.team))) return void (await ctx.answerCallbackQuery({ text: "Недоступно", show_alert: true }));
  if (action === "keep") { await ctx.answerCallbackQuery(); return void (await ctx.editMessageText("Отмена служения отменена.")); }
  const cancelled = await cancelWorshipService(service.team, id, ctx.from.id);
  if (cancelled) await Rehearsal.updateMany({ service: service._id, status: "scheduled" }, { $set: { status: "cancelled", cancelledBy: ctx.from.id, cancelledAt: new Date() } });
  if (cancelled) await unpinServiceAnnouncement(ctx.api, service.id);
  await ctx.answerCallbackQuery({ text: cancelled ? "Служение отменено" : "Не удалось отменить" });
  if (cancelled && ctx.chat?.type === "private") await notifyTeamGroup(ctx.api, service.team, `❌ Служение ${formatEventDateTime(cancelled.startsAt)} отменено.`);
  await ctx.editMessageText(cancelled ? `❌ Служение ${formatEventDateTime(cancelled.startsAt)} отменено.` : "Служение недоступно.");
});

scheduleComposer.callbackQuery(/^ln:roles:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const service = await WorshipService.findById(ctx.callbackQuery.data.split(":")[2]);
  if (!service || !(await isAdmin(ctx.from.id, service.team))) return void (await ctx.reply("Недостаточно прав."));
  const keyboard = new InlineKeyboard();
  const availableRoles = new Set(["vocal", "acoustic_guitar", "electric_guitar", "bass", "keys", "drums", "saxophone"]);
  ROLE_DEFINITIONS.forEach((role, index) => {
    if (!availableRoles.has(role.code)) return;
    keyboard.text(`${role.emoji} ${role.label}`, `ln:r:${service.id}:${index}`).row();
  });
  await ctx.reply("Выбери роль:", { reply_markup: keyboard });
});

scheduleComposer.callbackQuery(/^ln:manual:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const service = await WorshipService.findById(ctx.callbackQuery.data.split(":")[2]);
  if (!service || !(await isAdmin(ctx.from.id, service.team))) return void (await ctx.reply("Служение недоступно."));
  await ctx.conversation.enter("manualLineupFlow", String(service.team), "service", service.id);
});

scheduleComposer.callbackQuery(/^ln:r:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const [, , serviceId, indexValue] = ctx.callbackQuery.data.split(":");
  const role = ROLE_DEFINITIONS[Number(indexValue)];
  const service = await WorshipService.findById(serviceId);
  if (!role || !service || !(await isAdmin(ctx.from.id, service.team))) return void (await ctx.reply("Недоступно."));
  const team = await Team.findById(service.team);
  if (!team) return;
  const ids = team.members.map((member) => member.telegramId);
  const users = await User.find({ telegramId: { $in: ids } }).select("telegramId fullName firstName username").lean();
  const names = new Map(users.map((user) => [user.telegramId, user.fullName ?? user.firstName ?? user.username ?? String(user.telegramId)]));
  const keyboard = new InlineKeyboard();
  service.lineup.filter((item) => item.role === role.code).forEach((item) => {
    if (item.userTelegramId === undefined || item.userTelegramId === null) return;
    keyboard.text(`🗑 ${names.get(item.userTelegramId) ?? item.userTelegramId}`, `ln:d:${serviceId}:${indexValue}:${item.userTelegramId}`).row();
  });
  team.members.forEach((member) => keyboard.text(`➕ ${names.get(member.telegramId) ?? member.telegramId}`, `ln:a:${serviceId}:${indexValue}:${member.telegramId}`).row());
  await ctx.reply(`${role.emoji} ${role.label}:`, { reply_markup: keyboard });
});

scheduleComposer.callbackQuery(/^ln:(a|d):/, async (ctx) => {
  const [, action, serviceId, indexValue, telegramIdValue] = ctx.callbackQuery.data.split(":");
  const role = ROLE_DEFINITIONS[Number(indexValue)];
  const service = await WorshipService.findById(serviceId);
  if (!role || !service || !(await isAdmin(ctx.from.id, service.team))) return void (await ctx.answerCallbackQuery({ text: "Недоступно", show_alert: true }));
  const telegramId = Number(telegramIdValue);
  const updated = action === "a" ? await addLineupMember(service.team, serviceId, role.code, telegramId) : await removeLineupMember(service.team, serviceId, role.code, telegramId);
  if (updated) await Rehearsal.updateMany({ service: service._id, status: "scheduled" }, { $set: { lineup: updated.lineup } });
  await ctx.answerCallbackQuery({ text: updated ? "Состав обновлён" : "Не удалось обновить" });
  if (updated && ctx.chat?.type === "private") await notifyTeamGroup(ctx.api, service.team, `👥 <b>Состав обновлён</b>\n\n${roleIconHtml(role.code)} ${escapeHtml(role.label)}`);
});

scheduleComposer.callbackQuery(/^sl:add:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const service = await WorshipService.findById(ctx.callbackQuery.data.split(":")[2]);
  if (!service || !(await isAdmin(ctx.from.id, service.team))) return void (await ctx.reply("Недостаточно прав."));
  const songs = await Song.find({ team: service.team }).sort({ title: 1 }).limit(40);
  const keyboard = new InlineKeyboard();
  songs.forEach((song) => keyboard.text(song.title.slice(0, 60), `sl:a:${service.id}:${song.id}`).row());
  await ctx.reply(songs.length ? "Выбери песню:" : "В команде пока нет песен.", { reply_markup: keyboard });
});

scheduleComposer.callbackQuery(/^sl:(a|d|u|n|k):/, async (ctx) => {
  const [, action, serviceId, songId] = ctx.callbackQuery.data.split(":");
  const service = await WorshipService.findById(serviceId);
  if (!service || !(await isAdmin(ctx.from.id, service.team))) return void (await ctx.answerCallbackQuery({ text: "Недоступно", show_alert: true }));
  await ctx.answerCallbackQuery();
  if (action === "k") return void (await ctx.conversation.enter("setlistKeyFlow", String(service.team), serviceId, songId));
  if (action === "a") await addSetlistSong(service.team, serviceId, songId);
  if (action === "d") await removeSetlistSong(service.team, serviceId, songId);
  if (action === "u") await moveSetlistSong(service.team, serviceId, songId, -1);
  if (action === "n") await moveSetlistSong(service.team, serviceId, songId, 1);
  await showSetlist(ctx, serviceId);
});

scheduleComposer.command("test_rehearsal_reminder", async (ctx) => {
  if (!env.reminderTestMode || !ctx.team || !(await isAdmin(ctx.from!.id, ctx.team._id))) return void (await ctx.reply("Тест reminders отключён или недоступен."));
  const rehearsal = await getNextRehearsal(ctx.team._id);
  if (!rehearsal) return void (await ctx.reply("Нет ближайшей репетиции."));
  await ctx.reply(`🧪 <b>ТЕСТ НАПОМИНАНИЯ</b>\n\n${formatRehearsalCard(rehearsal)}`, { parse_mode: "HTML", reply_markup: rehearsalKeyboard(rehearsal.id, true) });
});
