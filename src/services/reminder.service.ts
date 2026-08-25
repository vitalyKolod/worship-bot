import { Api, InlineKeyboard } from "grammy";
import { env } from "../config/env";
import { Rehearsal } from "../models/Rehearsal";
import { escapeHtml, formatEventDate, formatEventTime } from "./event-format.service";
import { notifyTeamGroup } from "./notification.service";
import { WorshipService } from "../models/WorshipService";

let timer: NodeJS.Timeout | null = null;

function attendanceKeyboard(rehearsalId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Буду", `att:y:${rehearsalId}`)
    .text("🟡 Опоздаю", `att:l:${rehearsalId}`)
    .text("❌ Не смогу", `att:n:${rehearsalId}`);
}

async function sendDue(api: Api, field: "reminder24hSent" | "reminder2hSent", after: Date, until: Date, title: (startsAt: Date) => string): Promise<void> {
  const due = await Rehearsal.find({ status: "scheduled", startsAt: { $gt: after, $lte: until }, [field]: false }).limit(100);
  for (const rehearsal of due) {
    const claimed = await Rehearsal.findOneAndUpdate({ _id: rehearsal._id, [field]: false }, { $set: { [field]: true } }, { returnDocument: "after" });
    if (!claimed) continue;
    const text = [
      title(claimed.startsAt),
      "",
      `📅 ${formatEventDate(claimed.startsAt)}`,
      `🕖 ${formatEventTime(claimed.startsAt)}`,
      ...(claimed.location ? [`📍 ${escapeHtml(claimed.location)}`] : []),
    ].join("\n");
    await notifyTeamGroup(api, claimed.team, text, attendanceKeyboard(claimed.id));
    console.log(`[REMINDER] sent kind=${field} rehearsal=${claimed.id} team=${claimed.team}`);
  }
}

export async function runReminderTick(api: Api): Promise<void> {
  try {
    const now = Date.now();
    await sendDue(api, "reminder2hSent", new Date(now), new Date(now + 2 * 60 * 60 * 1000), (startsAt) => `⏰ <b>Репетиция через 2 часа</b>\n\nНачало в ${formatEventTime(startsAt)}.`);
    await sendDue(api, "reminder24hSent", new Date(now + 2 * 60 * 60 * 1000), new Date(now + 24 * 60 * 60 * 1000), () => "🎸 <b>Завтра репетиция</b>");
    const finished = await WorshipService.find({
      status: "scheduled",
      startsAt: { $gte: new Date(now - 7 * 24 * 60 * 60 * 1000), $lte: new Date(now - 3 * 60 * 60 * 1000) },
      completionPromptSent: false,
    }).limit(20);
    for (const service of finished) {
      const claimed = await WorshipService.findOneAndUpdate({ _id: service._id, completionPromptSent: false }, { $set: { completionPromptSent: true } }, { returnDocument: "after" });
      if (!claimed) continue;
      await notifyTeamGroup(api, claimed.team, `⛪ <b>${escapeHtml(claimed.title)}</b> уже прошло. Перенести служение в архив?`, new InlineKeyboard().text("✅ Да, завершить", `svc:complete:${claimed.id}`).text("⏳ Оставить", `svc:keep:${claimed.id}`));
    }
  } catch (error) {
    console.error("[REMINDER] scheduler error:", error instanceof Error ? error.message : error);
  }
}

export function startReminderScheduler(api: Api): () => void {
  if (timer) return () => undefined;
  void runReminderTick(api);
  timer = setInterval(() => void runReminderTick(api), env.reminderIntervalMs);
  console.log(`[REMINDER] scheduler started interval_ms=${env.reminderIntervalMs} timezone=${env.appTimezone}`);
  return () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
}
