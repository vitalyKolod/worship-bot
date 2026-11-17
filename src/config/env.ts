import "dotenv/config";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const appTimezone = process.env.APP_TIMEZONE || "Europe/Moscow";
process.env.TZ = appTimezone;
const localGuideSamples = path.join(homedir(), "Downloads", "Click and Guide Samples");

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Отсутствует обязательная переменная окружения: ${name}`);
  }
  return value;
}

export const env = {
  botToken: required("BOT_TOKEN"),
  mongodbUri: required("MONGODB_URI"),
  superAdminIds: (process.env.SUPER_ADMIN_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .map(Number),
  appTimezone,
  reminderIntervalMs: Math.max(10_000, Number(process.env.REMINDER_INTERVAL_MS) || 60_000),
  reminderTestMode: ["1", "true", "yes", "on"].includes((process.env.REMINDER_TEST_MODE ?? "").toLowerCase()),
  audio: {
    routerAiKey: process.env.ROUTERAI_API_KEY || "",
    routerAiModel: process.env.ROUTERAI_AUDIO_MODEL || "openai/gpt-audio",
    enabled: ["1", "true", "yes", "on"].includes((process.env.AUDIO_PROCESSING_ENABLED ?? "false").toLowerCase()),
    storagePath: process.env.AUDIO_STORAGE_PATH || "data/songs",
    maxConcurrentJobs: Math.max(1, Number(process.env.AUDIO_MAX_CONCURRENT_JOBS) || 1),
    maxUploadBytes: Math.max(1, Number(process.env.AUDIO_MAX_UPLOAD_BYTES) || 20 * 1024 * 1024),
    ffmpegPath: process.env.AUDIO_FFMPEG_PATH || "ffmpeg",
    ffprobePath: process.env.AUDIO_FFPROBE_PATH || "ffprobe",
    guidesPath: process.env.AUDIO_GUIDES_PATH || (existsSync(localGuideSamples) ? localGuideSamples : ""),
    separatorPython: process.env.AUDIO_SEPARATOR_PYTHON || ".audio-venv/bin/python",
    separatorModel: process.env.AUDIO_SEPARATOR_MODEL || "htdemucs_6s",
    processTimeoutMs: Math.max(60_000, Number(process.env.AUDIO_PROCESS_TIMEOUT_MS) || 30 * 60_000),
    workerPollMs: Math.max(1_000, Number(process.env.AUDIO_WORKER_POLL_MS) || 5_000),
  },
};
