import { Context } from "grammy";
import { isAdmin } from "../../services/teamService";
import { TeamContextFlavor } from "./teamContext";

/** Проверяет, что пользователь — админ (глобальный супер-админ или админ команды из ctx.team). */
export async function requireAdmin(ctx: Context & TeamContextFlavor): Promise<boolean> {
  const telegramId = ctx.from?.id;
  if (!telegramId) return false;
  return isAdmin(telegramId, ctx.team?._id);
}
