import { env } from "../config/env";
import { roleIconHtml, rolePresentation } from "./message-intent.service";

export function escapeHtml(value: unknown): string {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatEventDate(value: Date): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: env.appTimezone,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(value);
}

export function formatEventTime(value: Date): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: env.appTimezone,
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

export function formatEventDateTime(value: Date): string {
  return `${formatEventDate(value)}, ${formatEventTime(value)}`;
}

export function formatRehearsalCard(rehearsal: { startsAt: Date; location?: string | null; comment?: string | null; status?: string; lineup?: Array<{ role: string; slotLabel?: string | null; displayName?: string | null; userTelegramId?: number | null }> }): string {
  const status = rehearsal.status === "cancelled" ? "❌ <b>РЕПЕТИЦИЯ ОТМЕНЕНА</b>" : "🎸 <b>РЕПЕТИЦИЯ</b>";
  const lineup = rehearsal.lineup?.map((item) => {
    const role = rolePresentation(item.role);
    return `${roleIconHtml(item.role)} <b>${escapeHtml(item.slotLabel ?? role.label)}</b> — ${escapeHtml(item.displayName ?? item.userTelegramId ?? "Не указано")}`;
  }) ?? [];
  return [
    status,
    "",
    `📅 ${escapeHtml(formatEventDate(rehearsal.startsAt))}`,
    `🕖 ${escapeHtml(formatEventTime(rehearsal.startsAt))}`,
    ...(rehearsal.location ? [`📍 ${escapeHtml(rehearsal.location)}`] : []),
    ...(rehearsal.comment ? [`💬 ${escapeHtml(rehearsal.comment)}`] : []),
    ...(lineup.length ? ["", "👥 <b>СОСТАВ</b>", ...lineup] : []),
  ].join("\n");
}
