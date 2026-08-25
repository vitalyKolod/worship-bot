import { Context, HttpError, InlineKeyboard } from "grammy";
import { SongDoc } from "../../models/Song";

type SongCardData = Partial<SongDoc> & { title: string };

function escapeHtml(value: unknown): string {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Повторяет только временные сетевые ошибки. Ошибки Telegram API
 * (невалидная ссылка, слишком длинная подпись и т.п.) повторять бессмысленно. */
async function withNetworkRetry<T>(operation: () => Promise<T>): Promise<T> {
  const delays = [500, 1500];
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof HttpError) || attempt >= delays.length) throw error;
      console.warn(`Временная ошибка сети Telegram, повтор ${attempt + 1}/${delays.length}…`);
      await wait(delays[attempt]);
    }
  }
}

export function formatSongCard(song: SongCardData): string {
  const lines = [`🎵 <b>${escapeHtml(song.title)}</b>`];
  if (song.artist) lines.push(`🎤 <b>Исполнитель:</b> ${escapeHtml(song.artist)}`);
  if (song.key) lines.push(`🎹 <b>Тональность:</b> ${escapeHtml(song.key)}`);
  if (song.timeSignature) lines.push(`🥁 <b>Размер:</b> ${escapeHtml(song.timeSignature)}`);
  if (song.tempo) lines.push(`⏱ <b>Темп:</b> ${song.tempo} BPM`);
  if (song.genre) lines.push(`🎸 <b>Жанр:</b> ${escapeHtml(song.genre)}`);
  if (song.chords) lines.push(`🎼 <b>Аккорды:</b> ${escapeHtml(song.chords)}`);
  if (song.notes) lines.push(`📝 <b>Заметки:</b> ${escapeHtml(song.notes)}`);
  return lines.join("\n");
}

export async function sendSongCard(
  ctx: Context,
  song: SongCardData,
  replyToMessageId?: number,
  keyboard?: InlineKeyboard
): Promise<void> {
  const common = {
    parse_mode: "HTML" as const,
    ...(keyboard ? { reply_markup: keyboard } : {}),
    ...(replyToMessageId
      ? { reply_parameters: { message_id: replyToMessageId } }
      : {}),
  };

  await withNetworkRetry(() => ctx.reply(formatSongCard(song), common));
}
