import { Composer, InlineKeyboard } from "grammy";
import { Types } from "mongoose";
import { MyContext } from "../../context";
import { connectTeamToChat, getOwnedUnlinkedTeams, getTeamByChatId } from "../../../services/teamService";
import { isTelegramGroupAdmin } from "../../../services/telegramMembershipService";
import { Team } from "../../../models/Team";

export const groupSetupComposer = new Composer<MyContext>();

function escapeHtml(value: unknown): string {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function verifyAdmins(ctx: MyContext): Promise<boolean> {
  if (!ctx.from || !ctx.chat || (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup")) return false;
  const [caller, bot] = await Promise.all([ctx.getChatMember(ctx.from.id), ctx.getChatMember(ctx.me.id)]);
  if (!isTelegramGroupAdmin(caller)) {
    await ctx.reply("Подключить Worship Helper может только администратор группы.");
    return false;
  }
  if (!isTelegramGroupAdmin(bot)) {
    await ctx.reply("Сначала сделайте Worship Helper администратором группы, затем снова отправьте /setup.");
    return false;
  }
  return true;
}

groupSetupComposer.command("setup", async (ctx, next) => {
  if (!ctx.chat) return next();
  if (ctx.chat.type === "private") {
    await ctx.reply("Команду /setup нужно запускать внутри Telegram-группы прославления.");
    return;
  }
  if (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup") return next();
  if (!await verifyAdmins(ctx)) return;
  const linked = await getTeamByChatId(ctx.chat.id);
  if (linked) return void (await ctx.reply(`Эта Telegram-группа уже подключена к команде «${linked.name}» ✅`));
  const teams = await getOwnedUnlinkedTeams(ctx.from!.id);
  if (!teams.length) return void (await ctx.reply("У тебя нет неподключённых команд. Сначала создай команду в личном чате с ботом."));
  const keyboard = new InlineKeyboard();
  if (teams.length === 1) {
    keyboard.text("✅ ПОДКЛЮЧИТЬ", `setup:t:${teams[0]._id}`).text("✖️ ОТМЕНА", "setup:x");
    await ctx.reply(`🎸 <b>WORSHIP HELPER</b>\n\nПодключить команду:\n\n<b>${escapeHtml(teams[0].name)}</b>\n\nк этой Telegram-группе?`, { parse_mode: "HTML", reply_markup: keyboard });
    return;
  }
  teams.forEach((team) => keyboard.text(team.name, `setup:t:${team._id}`).row());
  keyboard.text("✖️ ОТМЕНА", "setup:x");
  await ctx.reply("🎸 <b>WORSHIP HELPER</b>\n\nКакую команду подключить к этой группе?", { parse_mode: "HTML", reply_markup: keyboard });
});

groupSetupComposer.callbackQuery(/^setup:/, async (ctx) => {
  const [, action, teamId] = ctx.callbackQuery.data.split(":");
  if (action === "x") {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("Подключение отменено.");
    return;
  }
  if (!ctx.chat || (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup")) {
    await ctx.answerCallbackQuery({ text: "Открой эту кнопку в группе", show_alert: true });
    return;
  }
  if (!await verifyAdmins(ctx)) {
    await ctx.answerCallbackQuery();
    return;
  }
  if (!Types.ObjectId.isValid(teamId)) {
    await ctx.answerCallbackQuery({ text: "Некорректная команда", show_alert: true });
    return;
  }
  const team = await Team.findOne({ _id: teamId, ownerId: ctx.from.id });
  if (!team || team.telegramChatId || team.chatId) return void (await ctx.answerCallbackQuery({ text: "Команда уже подключена или недоступна", show_alert: true }));
  if (await getTeamByChatId(ctx.chat.id)) return void (await ctx.answerCallbackQuery({ text: "Эта группа уже занята", show_alert: true }));
  const connected = await connectTeamToChat(teamId, ctx.from.id, ctx.chat.id, ctx.chat.title ?? "Telegram-группа");
  if (!connected) return void (await ctx.answerCallbackQuery({ text: "Не удалось подключить команду", show_alert: true }));
  await ctx.answerCallbackQuery({ text: "Команда подключена!" });
  const deepLink = `https://t.me/${ctx.me.username}?start=team_${connected.joinCode}`;
  const keyboard = new InlineKeyboard().url("🎸 ПРИСОЕДИНИТЬСЯ К КОМАНДЕ", deepLink);
  await ctx.editMessageText("🎸 <b>WORSHIP HELPER</b>\n\nГруппа подключена! ✅\n\nТеперь участники команды могут зарегистрироваться и получить доступ к Worship Helper.", { parse_mode: "HTML", reply_markup: keyboard });
});

groupSetupComposer.command("start", async (ctx, next) => {
  if (!ctx.chat) return next();
  if (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup") return next();
  await ctx.reply("Для подключения этой группы используй команду /setup.");
});
