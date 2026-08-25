import { Composer } from "grammy";
import { isAdmin } from "../../../services/teamService";
import { MyContext } from "../../context";

export const privateMenuComposer = new Composer<MyContext>();

privateMenuComposer.command("add_song", async (ctx, next) => {
  if (ctx.chat?.type !== "private") return next();

  const admin = await isAdmin(ctx.from!.id);
  if (!admin) {
    await ctx.reply(
      "Эта команда доступна только админам команды. Обратись к своему лидеру worship-команды."
    );
    return;
  }

  await ctx.conversation.enter("addSongFlow");
});

privateMenuComposer.command("edit_song", async (ctx, next) => {
  if (ctx.chat?.type !== "private") return next();
  if (!(await isAdmin(ctx.from!.id))) {
    await ctx.reply("Эта команда доступна только администраторам команды.");
    return;
  }
  await ctx.conversation.enter("editSongFlow");
});
