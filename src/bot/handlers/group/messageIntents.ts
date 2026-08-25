import { Composer, InlineKeyboard } from "grammy";
import { MyContext } from "../../context";
import { PendingAction } from "../../../models/PendingAction";
import { ReplacementRequest } from "../../../models/ReplacementRequest";
import { Team } from "../../../models/Team";
import { User } from "../../../models/User";
import { WorshipService } from "../../../models/WorshipService";
import { Rehearsal } from "../../../models/Rehearsal";
import { combineDateAndTime, parseRussianDate, parseRussianDateTime, parseRussianTime } from "../../../services/date-parser.service";
import { escapeHtml, formatEventDateTime, formatRehearsalCard } from "../../../services/event-format.service";
import { extractLineupCandidates, parseMessageIntent, rolePresentation, ROLE_DEFINITIONS } from "../../../services/message-intent.service";
import { applyPendingAction, cancelPendingAction, createPendingAction } from "../../../services/pending-action.service";
import { findRelevantRehearsal, findRehearsalForDate, getRehearsalsForDay, saveAttendance } from "../../../services/rehearsal.service";
import { isAdmin } from "../../../services/teamService";
import { getNextWorshipService, getServicesForDay, getSetlist } from "../../../services/worship-service.service";
import { notifyTeamGroup, notifyUser } from "../../../services/notification.service";

export const messageIntentsComposer = new Composer<MyContext>();

function proposalKeyboard(id: string): InlineKeyboard {
  return new InlineKeyboard().text("✅ Подтвердить", `pa:y:${id}`).text("✏️ Изменить", `pa:e:${id}`).text("❌ Отмена", `pa:n:${id}`);
}

async function cleanupHandledGroupMessage(ctx: MyContext): Promise<void> {
  if (!ctx.chat || !ctx.message) return;
  try { await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id); } catch { /* Нужны права на удаление; без них просто оставляем сообщение. */ }
}

async function createRehearsalProposal(ctx: MyContext): Promise<void> {
  const parsed = parseRussianDateTime(ctx.message!.text!);
  if (!parsed) {
    const date = parseRussianDate(ctx.message!.text!);
    if (date) {
      await cleanupHandledGroupMessage(ctx);
      return void (await ctx.conversation.enter("rehearsalFlow", String(ctx.team!._id), `date:${date.toISOString()}`));
    }
    return void (await ctx.reply("Понял, что речь о репетиции, но не смог определить дату. Например: «репетиция завтра в 19:00»."));
  }
  if (parsed.value <= new Date()) return void (await ctx.reply("Эта дата уже в прошлом. Репетицию не предлагаю."));
  const summary = `Похоже, вы хотите назначить репетицию:\n\n📅 ${formatEventDateTime(parsed.value)}${parsed.ambiguousTime ? "\n\nℹ️ Время без минут понял как вечернее." : ""}`;
  const action = await createPendingAction({ team: ctx.team!._id, actorTelegramId: ctx.from!.id, type: "create_rehearsal", summary, payload: { startsAt: parsed.value.toISOString() } });
  await ctx.reply(`${summary}\n\nПодтвердить?`, { reply_markup: proposalKeyboard(action.id) });
  await cleanupHandledGroupMessage(ctx);
}

function moveTargetText(text: string): string {
  return text.match(/вместо.+?\sв\s+(.+)$/iu)?.[1] ?? text.match(/(?:перенес\w*|перенос\w*).+?\sна\s+(.+)$/iu)?.[1] ?? text;
}

async function createMoveProposal(ctx: MyContext): Promise<void> {
  const rehearsal = await findRehearsalForDate(ctx.team!._id, null);
  if (!rehearsal) return void (await ctx.reply("Нет ближайшей репетиции, которую можно перенести."));
  const targetText = moveTargetText(ctx.message!.text!);
  const targetDate = parseRussianDate(targetText);
  if (!targetDate) return void (await ctx.reply("Понял перенос, но не понял новую дату. Например: «перенесём репетицию на субботу в 18:00»."));
  const parsedTime = parseRussianTime(targetText);
  const fallbackTime = { hours: rehearsal.startsAt.getHours(), minutes: rehearsal.startsAt.getMinutes(), ambiguous: false };
  const startsAt = combineDateAndTime(targetDate, parsedTime ?? fallbackTime);
  if (startsAt <= new Date()) return void (await ctx.reply("Новая дата уже в прошлом."));
  const summary = `🔄 Похоже, вы хотите перенести репетицию:\n\nБыло: ${formatEventDateTime(rehearsal.startsAt)}\nСтало: ${formatEventDateTime(startsAt)}`;
  const action = await createPendingAction({ team: ctx.team!._id, actorTelegramId: ctx.from!.id, type: "move_rehearsal", summary, payload: { rehearsalId: rehearsal.id, startsAt: startsAt.toISOString(), previousStartsAt: rehearsal.startsAt.toISOString() } });
  await ctx.reply(`${summary}\n\nПодтвердить?`, { reply_markup: proposalKeyboard(action.id), reply_parameters: { message_id: ctx.message!.message_id } });
}

async function createCancelProposal(ctx: MyContext): Promise<void> {
  const requestedDate = parseRussianDate(ctx.message!.text!);
  const rehearsal = await findRehearsalForDate(ctx.team!._id, requestedDate);
  if (!rehearsal) return void (await ctx.reply("Не нашёл подходящую запланированную репетицию."));
  const summary = `❌ Похоже, вы хотите отменить репетицию:\n\n📅 ${formatEventDateTime(rehearsal.startsAt)}`;
  const action = await createPendingAction({ team: ctx.team!._id, actorTelegramId: ctx.from!.id, type: "cancel_rehearsal", summary, payload: { rehearsalId: rehearsal.id } });
  await ctx.reply(`${summary}\n\nПодтвердить?`, { reply_markup: proposalKeyboard(action.id), reply_parameters: { message_id: ctx.message!.message_id } });
}

async function createMoveServiceProposal(ctx: MyContext): Promise<void> {
  const service = await getNextWorshipService(ctx.team!._id);
  if (!service) return void (await ctx.reply("Нет ближайшего служения, которое можно перенести."));
  const targetText = moveTargetText(ctx.message!.text!);
  const targetDate = parseRussianDate(targetText);
  if (!targetDate) return void (await ctx.reply("Понял перенос служения, но не понял новую дату."));
  const parsedTime = parseRussianTime(targetText);
  const fallbackTime = { hours: service.startsAt.getHours(), minutes: service.startsAt.getMinutes(), ambiguous: false };
  const startsAt = combineDateAndTime(targetDate, parsedTime ?? fallbackTime);
  if (startsAt <= new Date()) return void (await ctx.reply("Новая дата уже в прошлом."));
  const summary = `🔄 Похоже, вы хотите перенести служение:\n\nБыло: ${formatEventDateTime(service.startsAt)}\nСтало: ${formatEventDateTime(startsAt)}`;
  const action = await createPendingAction({ team: ctx.team!._id, actorTelegramId: ctx.from!.id, type: "move_service", summary, payload: { serviceId: service.id, startsAt: startsAt.toISOString() } });
  await ctx.reply(`${summary}\n\nПодтвердить?`, { reply_markup: proposalKeyboard(action.id), reply_parameters: { message_id: ctx.message!.message_id } });
}

async function resolveLineup(ctx: MyContext): Promise<void> {
  const candidates = extractLineupCandidates(ctx.message!.text!);
  const requestedDate = parseRussianDate(ctx.message!.text!);
  const service = requestedDate ? (await getServicesForDay(ctx.team!._id, requestedDate))[0] : await getNextWorshipService(ctx.team!._id);
  if (!service) return void (await ctx.reply("Не нашёл подходящее служение. Сначала добавь его через /service_add."));
  const assignments: Array<{ role: string; slotLabel: string; displayName: string }> = [];
  const preview: string[] = [];
  const roleCounts = new Map<string, number>();
  for (const entry of candidates) {
    const names: string[] = [];
    for (const inputName of entry.names) {
      const role = rolePresentation(entry.role);
      const next = (roleCounts.get(entry.role) ?? 0) + 1;
      roleCounts.set(entry.role, next);
      const totalForRole = candidates.filter((candidate) => candidate.role === entry.role).reduce((sum, candidate) => sum + candidate.names.length, 0);
      assignments.push({ role: entry.role, slotLabel: totalForRole > 1 ? `${role.label} ${next}` : role.label, displayName: inputName });
      names.push(inputName);
    }
    const role = rolePresentation(entry.role);
    preview.push(`${role.emoji} ${role.label} — ${names.join(", ")}`);
  }
  if (!assignments.length) return;
  const summary = `Нашёл состав:\n\n${preview.join("\n")}\n\nСлужение: ${formatEventDateTime(service.startsAt)}`;
  const action = await createPendingAction({ team: ctx.team!._id, actorTelegramId: ctx.from!.id, type: "set_lineup", summary, payload: { serviceId: service.id, assignments } });
  await ctx.reply(`${summary}\n\nСохранить?`, { reply_markup: proposalKeyboard(action.id), reply_parameters: { message_id: ctx.message!.message_id } });
}

async function handlePersonalAvailability(ctx: MyContext, unavailable: boolean, lateMinutes?: number): Promise<boolean> {
  if (!ctx.team!.members.some((member) => member.telegramId === ctx.from!.id) && ctx.team!.ownerId !== ctx.from!.id) return false;
  const requestedDate = parseRussianDate(ctx.message!.text!);
  if (unavailable && requestedDate) {
    const service = (await getServicesForDay(ctx.team!._id, requestedDate))[0];
    const slots = service?.lineup.map((item, index) => ({ item, index })).filter(({ item }) => item.userTelegramId === ctx.from!.id) ?? [];
    if (service && slots.length) {
      const user = await User.findOne({ telegramId: ctx.from!.id }).lean();
      const name = user?.fullName ?? user?.firstName ?? String(ctx.from!.id);
      const keyboard = new InlineKeyboard();
      slots.forEach(({ item }) => {
        const roleIndex = ROLE_DEFINITIONS.findIndex((definition) => definition.code === item.role);
        if (roleIndex >= 0) keyboard.text(`Найти замену: ${rolePresentation(item.role).label}`, `rp:s:${service.id}:${roleIndex}:${ctx.from!.id}`).row();
      });
      await ctx.reply(`⚠️ ${escapeHtml(name)} не сможет участвовать ${escapeHtml(formatEventDateTime(service.startsAt))}.\n\nАдминистратор может подобрать замену.`, { parse_mode: "HTML", reply_markup: keyboard });
      return true;
    }
  }
  const rehearsal = await findRelevantRehearsal(ctx.team!._id);
  if (rehearsal) {
    if (unavailable) {
      await saveAttendance(ctx.team!._id, rehearsal.id, ctx.from!.id, "unavailable");
      await ctx.reply("❌ Записал, что тебя не будет на ближайшей репетиции. Пюпитр будет скучать 😄", { reply_parameters: { message_id: ctx.message!.message_id } });
    } else if (lateMinutes) {
      await saveAttendance(ctx.team!._id, rehearsal.id, ctx.from!.id, "late", lateMinutes);
      await ctx.reply(`🟡 Записал опоздание на ${lateMinutes} мин. Метроном уже считает 😄`, { reply_parameters: { message_id: ctx.message!.message_id } });
    } else {
      await ctx.reply("К ближайшей репетиции? Метроном уже считает 😄 Укажи, пожалуйста, на сколько минут опоздаешь или нажми «Опоздаю» в карточке репетиции.");
    }
    return true;
  }
  if (!unavailable) return false;
  const service = requestedDate ? (await getServicesForDay(ctx.team!._id, requestedDate))[0] : await getNextWorshipService(ctx.team!._id);
  const slots = service?.lineup.map((item, index) => ({ item, index })).filter(({ item }) => item.userTelegramId === ctx.from!.id) ?? [];
  if (!service || !slots.length) return false;
  const user = await User.findOne({ telegramId: ctx.from!.id }).lean();
  const name = user?.fullName ?? user?.firstName ?? String(ctx.from!.id);
  const keyboard = new InlineKeyboard();
  slots.forEach(({ item }) => {
    const roleIndex = ROLE_DEFINITIONS.findIndex((definition) => definition.code === item.role);
    if (roleIndex >= 0) keyboard.text(`Найти замену: ${rolePresentation(item.role).label}`, `rp:s:${service.id}:${roleIndex}:${ctx.from!.id}`).row();
  });
  await ctx.reply(`⚠️ ${escapeHtml(name)} не сможет участвовать ${escapeHtml(formatEventDateTime(service.startsAt))}.\n\nАдминистратор может подобрать замену.`, { parse_mode: "HTML", reply_markup: keyboard });
  return true;
}

async function answerToday(ctx: MyContext): Promise<void> {
  const today = new Date();
  const [rehearsals, services] = await Promise.all([getRehearsalsForDay(ctx.team!._id, today), getServicesForDay(ctx.team!._id, today)]);
  if (!rehearsals.length && !services.length) return void (await ctx.reply("На сегодня ничего не запланировано."));
  const lines = [`📅 Сегодня`];
  rehearsals.forEach((item) => lines.push(`🎸 Репетиция — ${formatEventDateTime(item.startsAt)}${item.location ? `, ${item.location}` : ""}`));
  for (const item of services) {
    lines.push(`⛪ ${item.title} — ${formatEventDateTime(item.startsAt)}`);
    const roles = item.lineup.filter((slot) => slot.userTelegramId === ctx.from!.id).map((slot) => rolePresentation(slot.role));
    if (roles.length) lines.push(`Твоя роль: ${roles.map((role) => `${role.emoji} ${role.label}`).join(", ")}`);
    const populated: any = await getSetlist(item.id);
    if (populated?.setlist.length) {
      lines.push("🎵 Сет-лист:\n" + populated.setlist.sort((a: any, b: any) => a.order - b.order).map((entry: any) => `${entry.order}. ${entry.song?.title ?? "Песня"}${entry.key ? ` — ${entry.key}` : ""}`).join("\n"));
    }
  }
  await ctx.reply(lines.join("\n\n"));
}

async function answerAssignment(ctx: MyContext): Promise<void> {
  const requestedDate = parseRussianDate(ctx.message!.text!);
  const service = requestedDate ? (await getServicesForDay(ctx.team!._id, requestedDate))[0] : await getNextWorshipService(ctx.team!._id);
  if (!service) return void (await ctx.reply("Не нашёл подходящее служение."));
  const roles = service.lineup.filter((item) => item.userTelegramId === ctx.from!.id).map((item) => rolePresentation(item.role));
  await ctx.reply(roles.length ? `На служении ${formatEventDateTime(service.startsAt)} ты играешь:\n${roles.map((item) => `${item.emoji} ${item.label}`).join("\n")}` : "На это служение тебя пока нет в составе.");
}

messageIntentsComposer.on("message:text").filter((ctx) => !!ctx.team, async (ctx, next) => {
  if (!ctx.from || ctx.from.is_bot || ctx.message.text.startsWith("/")) return next();
  const intent = parseMessageIntent(ctx.message.text);
  if (intent.type === "NONE") return next();
  console.log(`[MESSAGE_INTENT] type=${intent.type} team=${ctx.team!._id}`);
  if (intent.type === "WHAT_TODAY") return answerToday(ctx);
  if (intent.type === "USER_ASSIGNMENT") return answerAssignment(ctx);
  if (intent.type === "USER_LATE") {
    if (await handlePersonalAvailability(ctx, false, intent.lateMinutes)) return;
    return next();
  }
  if (intent.type === "USER_UNAVAILABLE") {
    if (await handlePersonalAvailability(ctx, true)) return;
    return next();
  }
  if (!(await isAdmin(ctx.from.id, ctx.team!._id))) {
    await ctx.reply("Изменять расписание и состав может только администратор команды.", { reply_parameters: { message_id: ctx.message.message_id } });
    return;
  }
  if (intent.type === "CREATE_REHEARSAL") return createRehearsalProposal(ctx);
  if (intent.type === "MOVE_REHEARSAL") return createMoveProposal(ctx);
  if (intent.type === "CANCEL_REHEARSAL") return createCancelProposal(ctx);
  if (intent.type === "MOVE_SERVICE") return createMoveServiceProposal(ctx);
  if (intent.type === "SET_LINEUP") return resolveLineup(ctx);
  return next();
});

messageIntentsComposer.callbackQuery(/^pa:(y|e|n):/, async (ctx) => {
  const [, action, actionId] = ctx.callbackQuery.data.split(":");
  const pending = await PendingAction.findById(actionId);
  if (!pending || !(await isAdmin(ctx.from.id, pending.team))) return void (await ctx.answerCallbackQuery({ text: "Предложение недоступно", show_alert: true }));
  if (action === "n") {
    await cancelPendingAction(actionId, pending.team);
    await ctx.answerCallbackQuery({ text: "Отменено" });
    return void (await ctx.editMessageText("Действие отменено. Данные не изменены."));
  }
  if (action === "e") {
    await cancelPendingAction(actionId, pending.team);
    await ctx.answerCallbackQuery();
    if (pending.type === "create_rehearsal") return void (await ctx.conversation.enter("rehearsalFlow", String(pending.team)));
    if (pending.type === "move_rehearsal") return void (await ctx.conversation.enter("editRehearsalFlow", String(pending.team), String((pending.payload as any).rehearsalId)));
    if (pending.type === "move_service") return void (await ctx.conversation.enter("editServiceFlow", String(pending.team), String((pending.payload as any).serviceId)));
    return void (await ctx.reply("Открой /lineup и измени состав кнопками."));
  }
  if (pending.type === "create_rehearsal") {
    await cancelPendingAction(actionId, pending.team);
    await ctx.answerCallbackQuery({ text: "Теперь добавим детали и состав" });
    return void (await ctx.conversation.enter("rehearsalFlow", String(pending.team), String((pending.payload as any).startsAt)));
  }
  const applied = await applyPendingAction(actionId, pending.team, ctx.from.id);
  if (applied.state === "already_confirmed") return void (await ctx.answerCallbackQuery({ text: "Уже подтверждено" }));
  if (applied.state !== "confirmed") return void (await ctx.answerCallbackQuery({ text: "Предложение устарело", show_alert: true }));
  await ctx.answerCallbackQuery({ text: "Сохранено" });
  const result: any = applied.result;
  if (pending.type === "move_rehearsal") return void (await ctx.editMessageText(`✅ Репетиция перенесена\n\n${formatRehearsalCard(result)}`, { parse_mode: "HTML" }));
  if (pending.type === "cancel_rehearsal") return void (await ctx.editMessageText(`❌ Репетиция ${formatEventDateTime(result.startsAt)} отменена.`));
  if (pending.type === "move_service") return void (await ctx.editMessageText(`✅ Служение перенесено на ${formatEventDateTime(result.startsAt)}.`));
  await ctx.editMessageText(`✅ Состав сохранён\n\n${pending.summary}`);
});

messageIntentsComposer.callbackQuery(/^rp:s:/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const [, , serviceId, roleIndexValue, currentIdValue] = ctx.callbackQuery.data.split(":");
  const service = await WorshipService.findById(serviceId);
  const roleDefinition = ROLE_DEFINITIONS[Number(roleIndexValue)];
  const currentTelegramId = Number(currentIdValue);
  const slot = service?.lineup.find((item) => item.role === roleDefinition?.code && item.userTelegramId === currentTelegramId);
  if (!service || !slot || !roleDefinition || !(await isAdmin(ctx.from.id, service.team))) return void (await ctx.reply("Замена недоступна."));
  const team = await Team.findById(service.team);
  if (!team) return;
  const suitable = team.members.filter((member) => member.telegramId !== slot.userTelegramId && (!roleDefinition || member.roles.some((role) => roleDefinition.pattern.test(role))));
  const candidates = suitable;
  const users = await User.find({ telegramId: { $in: candidates.map((item) => item.telegramId) } }).select("telegramId fullName firstName username").lean();
  const names = new Map(users.map((user) => [user.telegramId, user.fullName ?? user.firstName ?? user.username ?? String(user.telegramId)]));
  const keyboard = new InlineKeyboard();
  candidates.forEach((member) => keyboard.text(String(names.get(member.telegramId) ?? member.telegramId), `rp:c:${serviceId}:${roleIndexValue}:${currentTelegramId}:${member.telegramId}`).row());
  await ctx.reply(candidates.length ? "Кому предложить замену?" : "Нет подходящих участников.", { reply_markup: keyboard });
});

messageIntentsComposer.callbackQuery(/^rp:c:/, async (ctx) => {
  const [, , serviceId, roleIndexValue, currentIdValue, candidateValue] = ctx.callbackQuery.data.split(":");
  const service = await WorshipService.findById(serviceId);
  const roleDefinition = ROLE_DEFINITIONS[Number(roleIndexValue)];
  const currentTelegramId = Number(currentIdValue);
  const slot = service?.lineup.find((item) => item.role === roleDefinition?.code && item.userTelegramId === currentTelegramId);
  if (!service || !slot || !roleDefinition || !(await isAdmin(ctx.from.id, service.team))) return void (await ctx.answerCallbackQuery({ text: "Недоступно", show_alert: true }));
  const candidateTelegramId = Number(candidateValue);
  const belongs = await Team.exists({ _id: service.team, "members.telegramId": candidateTelegramId });
  if (!belongs) return void (await ctx.answerCallbackQuery({ text: "Участник недоступен", show_alert: true }));
  const request = await ReplacementRequest.findOneAndUpdate(
    { service: service._id, role: slot.role, currentTelegramId: slot.userTelegramId, candidateTelegramId, status: "pending" },
    { $setOnInsert: { team: service.team, service: service._id, role: slot.role, currentTelegramId: slot.userTelegramId, candidateTelegramId, requestedBy: ctx.from.id, status: "pending" } },
    { upsert: true, returnDocument: "after" }
  );
  const role = rolePresentation(slot.role);
  const delivered = await notifyUser(ctx.api, candidateTelegramId, `${role.emoji} Тебя хотят поставить на роль «${escapeHtml(role.label)}» ${formatEventDateTime(service.startsAt)}.`, new InlineKeyboard().text("✅ Могу", `rp:y:${request.id}`).text("❌ Не могу", `rp:n:${request.id}`));
  if (delivered) {
    await ctx.answerCallbackQuery({ text: "Предложение отправлено" });
  } else {
    request.status = "cancelled";
    await request.save();
    await ctx.answerCallbackQuery({ text: "Не удалось написать участнику. Он должен сначала открыть бота.", show_alert: true });
  }
});

messageIntentsComposer.callbackQuery(/^rp:(y|n):/, async (ctx) => {
  const [, answer, requestId] = ctx.callbackQuery.data.split(":");
  const request = await ReplacementRequest.findOne({ _id: requestId, candidateTelegramId: ctx.from.id });
  if (!request || request.status !== "pending") return void (await ctx.answerCallbackQuery({ text: "Запрос уже обработан", show_alert: true }));
  if (answer === "n") {
    request.status = "declined";
    request.respondedAt = new Date();
    await request.save();
    await ctx.answerCallbackQuery({ text: "Ответ сохранён" });
    return void (await ctx.editMessageText("Ты отказался от замены."));
  }
  const service = await WorshipService.findOneAndUpdate(
    { _id: request.service, team: request.team, status: "scheduled" },
    { $set: { "lineup.$[slot].userTelegramId": request.candidateTelegramId } },
    { arrayFilters: [{ "slot.role": request.role, "slot.userTelegramId": request.currentTelegramId }], returnDocument: "after" }
  );
  if (!service) return void (await ctx.answerCallbackQuery({ text: "Служение уже недоступно", show_alert: true }));
  await Rehearsal.updateMany({ service: service._id, status: "scheduled" }, { $set: { lineup: service.lineup } });
  request.status = "accepted";
  request.respondedAt = new Date();
  await request.save();
  await ctx.answerCallbackQuery({ text: "Состав обновлён" });
  await ctx.editMessageText("✅ Ты подтвердил замену. Состав обновлён.");
  const role = rolePresentation(request.role);
  await notifyTeamGroup(ctx.api, request.team, `🔄 <b>Замена в составе</b>\n\n${role.emoji} ${escapeHtml(role.label)} — участник подтвердил замену.`);
});
