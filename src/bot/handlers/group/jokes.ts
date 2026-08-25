import { Composer } from "grammy";
import { MyContext } from "../../context";

export const jokesComposer = new Composer<MyContext>();

export type JokeKind = "late" | "absent";

const LATE_PATTERN = /(?:опозд|опаздыва|задерж|(?:^|\s)бегу(?:\s|[.!?,]|$)|чуть\s+позже\s+буду|уже\s+выезжаю|не\s+успе(?:ваю|ю)\s+(?:к\s+началу|вовремя)|подъеду\s+позже)/iu;
const ABSENT_PATTERN = /(?:^(?:я\s+)?(?:сегодня\s+)?не\s+буду[\s.!?]*$|не\s+(?:приду|приеду|смогу\s+(?:прийти|приехать))(?:\s|[.!?,]|$)|меня\s+(?:сегодня\s+)?не\s+будет(?:\s|[.!?,]|$)|сегодня\s+без\s+меня(?:\s|[.!?,]|$))/iu;

const LATE_JOKES = [
  "Опаздываешь? Мы пока настроим метроном на темп твоего прибытия 😄",
  "Тональность прощения уже настроена, залетай скорее 🎹",
  "Ждём! Но метроном уже начал считать минуты 😅",
  "Главное приезжай — партию вступления сыграем ещё раз специально для тебя 🎸",
];

const ABSENT_JOKES = [
  "Не будешь? Тогда сегодня твою партию исполнит вера 🙏😄",
  "Принято! Но пюпитр всё равно будет скучать по тебе 🎼",
  "Эх, минус один музыкант, плюс один повод сыграть попроще 😅",
  "Хорошо, отметили. Твою долю вкусняшек после репы торжественно спасём 😄",
];

export function detectJokeKind(text: string): JokeKind | null {
  const normalized = text.trim();
  if (ABSENT_PATTERN.test(normalized)) return "absent";
  if (LATE_PATTERN.test(normalized)) return "late";
  return null;
}

export function pickJoke(kind: JokeKind, random = Math.random): string {
  const jokes = kind === "late" ? LATE_JOKES : ABSENT_JOKES;
  return jokes[Math.floor(random() * jokes.length)] ?? jokes[0];
}

jokesComposer.on("message:text").filter(
  (ctx) => !!ctx.team,
  async (ctx, next) => {
    if (ctx.from?.is_bot || ctx.message.text.startsWith("/")) {
      await next();
      return;
    }

    const kind = detectJokeKind(ctx.message.text);
    if (!kind) {
      await next();
      return;
    }

    await ctx.reply(pickJoke(kind), {
      reply_parameters: { message_id: ctx.message.message_id },
    });
  }
);
