import "dotenv/config";

const appTimezone = process.env.APP_TIMEZONE || "Europe/Moscow";
process.env.TZ = appTimezone;

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
};
