import { Bot, GrammyError, HttpError, session } from "grammy";
import { conversations, createConversation } from "@grammyjs/conversations";
import { env } from "../config/env";
import { MyContext } from "./context";
import { teamContextMiddleware } from "./middlewares/teamContext";
import { addSongFlow } from "./conversations/addSongFlow";
import { editSongFlow } from "./conversations/editSongFlow";
import { privateMenuComposer } from "./handlers/private/menu";
import { privatePortalComposer } from "./handlers/private/portal";
import { groupSetupComposer } from "./handlers/group/setup";
import { songQueryComposer } from "./handlers/group/songQuery";
import { jokesComposer } from "./handlers/group/jokes";
import { scheduleComposer } from "./handlers/schedule";
import { messageIntentsComposer } from "./handlers/group/messageIntents";
import { editRehearsalFlow, editServiceFlow, lateResponseFlow, linkedRehearsalFlow, manualLineupFlow, rehearsalFlow, serviceFlow, serviceSetlistFlow, setlistKeyFlow } from "./conversations/scheduleFlows";

export function createBot(): Bot<MyContext> {
  const bot = new Bot<MyContext>(env.botToken);

  // session нужен для @grammyjs/conversations — храним в памяти для MVP,
  // при желании потом подключить mongoose-адаптер сессий
  bot.use(session({ initial: () => ({}) }));
  bot.use(conversations());
  bot.use(teamContextMiddleware);

  bot.use(createConversation(addSongFlow, "addSongFlow"));
  bot.use(createConversation(editSongFlow, "editSongFlow"));
  bot.use(createConversation(rehearsalFlow, "rehearsalFlow"));
  bot.use(createConversation(editRehearsalFlow, "editRehearsalFlow"));
  bot.use(createConversation(serviceFlow, "serviceFlow"));
  bot.use(createConversation(serviceSetlistFlow, "serviceSetlistFlow"));
  bot.use(createConversation(linkedRehearsalFlow, "linkedRehearsalFlow"));
  bot.use(createConversation(editServiceFlow, "editServiceFlow"));
  bot.use(createConversation(lateResponseFlow, "lateResponseFlow"));
  bot.use(createConversation(setlistKeyFlow, "setlistKeyFlow"));
  bot.use(createConversation(manualLineupFlow, "manualLineupFlow"));

  bot.use(privatePortalComposer);
  bot.use(privateMenuComposer);
  bot.use(groupSetupComposer);
  bot.use(scheduleComposer);
  bot.use(songQueryComposer);
  bot.use(messageIntentsComposer);
  bot.use(jokesComposer); // После songQuery, чтобы вопрос о песне имел приоритет.

  bot.catch((err) => {
    // Не печатаем HttpError целиком: вложенный FetchError может содержать BOT_TOKEN в URL.
    if (err.error instanceof HttpError) {
      console.error("Ошибка сети при обращении к Telegram API. Проверь интернет, VPN или прокси.");
    } else if (err.error instanceof GrammyError) {
      console.error(`Ошибка Telegram API ${err.error.error_code}: ${err.error.description}`);
    } else {
      console.error("Ошибка в обработке апдейта:", err.error);
    }
  });

  return bot;
}
