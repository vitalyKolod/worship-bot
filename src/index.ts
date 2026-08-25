import mongoose from "mongoose";
import { env } from "./config/env";
import { createBot } from "./bot";
import { Team } from "./models/Team";
import { migrateLegacyTeams } from "./services/teamService";
import { Rehearsal } from "./models/Rehearsal";
import { RehearsalResponse } from "./models/RehearsalResponse";
import { WorshipService } from "./models/WorshipService";
import { PendingAction } from "./models/PendingAction";
import { ReplacementRequest } from "./models/ReplacementRequest";
import { startReminderScheduler } from "./services/reminder.service";
import { Song } from "./models/Song";

async function main() {
  await mongoose.connect(env.mongodbUri);
  // Мигрирует старый обязательный unique chatId в sparse-index: новые Team
  // существуют до /setup и поэтому ещё не имеют Telegram chat ID.
  await Promise.all([
    Team.syncIndexes(),
    Rehearsal.syncIndexes(),
    RehearsalResponse.syncIndexes(),
    WorshipService.syncIndexes(),
    PendingAction.syncIndexes(),
    ReplacementRequest.syncIndexes(),
    Song.syncIndexes(),
  ]);
  await migrateLegacyTeams();
  console.log("✅ Подключено к MongoDB");

  const bot = createBot();
  startReminderScheduler(bot.api);
  await bot.start();
  console.log("🤖 Бот запущен");
}

main().catch((err) => {
  console.error("Не удалось запустить бота:", err);
  process.exit(1);
});
