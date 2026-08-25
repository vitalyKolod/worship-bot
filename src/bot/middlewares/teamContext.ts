import { Context, NextFunction } from "grammy";
import { getTeamByChatId } from "../../services/teamService";
import { TeamDoc } from "../../models/Team";

export interface TeamContextFlavor {
  team?: (TeamDoc & { _id: any }) | null;
}

/** Подмешивает ctx.team — команду, привязанную к текущему групповому чату (или null). */
export async function teamContextMiddleware(
  ctx: Context & TeamContextFlavor,
  next: NextFunction
) {
  if (ctx.chat && (ctx.chat.type === "group" || ctx.chat.type === "supergroup")) {
    ctx.team = await getTeamByChatId(ctx.chat.id);
  } else {
    ctx.team = null;
  }
  await next();
}
