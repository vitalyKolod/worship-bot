import path from "node:path";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { env } from "../../config/env";
import { SectionName, SECTION_NAMES } from "./audio-accompaniment.service";
import { runProcess } from "./process-runner";

export type AiSection = { name: SectionName; label: string; weight: number; draftAt: number };
export type AiStructure = { downbeatIndex?: number; sections: AiSection[] };

export function parseAiStructure(value: unknown, duration: number, beatCount: number): AiStructure {
  if (!value || typeof value !== "object") throw new Error("ИИ вернул пустую разметку.");
  const draft = value as { downbeat_index?: unknown; sections?: unknown };
  const rawIndex = draft.downbeat_index;
  const downbeatIndex = Number.isInteger(rawIndex) && Number(rawIndex) >= 0 && Number(rawIndex) < Math.min(beatCount, 24)
    ? Number(rawIndex) : undefined;
  if (!Array.isArray(draft.sections) || draft.sections.length < 2 || draft.sections.length > 50) {
    throw new Error("ИИ не смог выделить последовательность частей.");
  }
  let previousAt = -1;
  const sections: AiSection[] = draft.sections.map((entry) => {
    const item = entry as { name?: unknown; at?: unknown };
    if (!item || !SECTION_NAMES.includes(item.name as SectionName) || typeof item.at !== "number" || !Number.isFinite(item.at)
      || item.at < 0 || item.at >= duration) throw new Error("ИИ вернул неверные времена частей.");
    const at = Math.round(item.at * 10) / 10;
    if (at <= previousAt) throw new Error("ИИ вернул части не по порядку.");
    previousAt = at;
    return { name: item.name as SectionName, label: item.name as string, weight: 1, draftAt: at };
  });
  return { downbeatIndex, sections };
}

export async function analyzeSongWithRouterAi(file: string, beats: number[], beatsPerBar: number): Promise<AiStructure> {
  if (!env.audio.routerAiKey) throw new Error("ROUTERAI_API_KEY не настроен.");
  const temporary = await mkdtemp(path.join(tmpdir(), "worship-ai-audio-"));
  try {
    const compressed = path.join(temporary, "song.mp3");
    await runProcess(env.audio.ffmpegPath, ["-v", "error", "-i", file, "-ac", "1", "-ar", "16000", "-b:a", "48k", "-y", compressed], 90_000);
    const info = await stat(compressed);
    if (info.size > 6 * 1024 * 1024) throw new Error("Запись слишком длинная для ИИ разметки.");
    const probe = await runProcess(env.audio.ffprobePath, ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file], 30_000);
    const duration = Number(probe.stdout.trim());
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("Не удалось узнать длительность записи.");
    const audio = (await readFile(compressed)).toString("base64");
    const response = await fetch("https://routerai.ru/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.audio.routerAiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: env.audio.routerAiModel,
        max_tokens: 1400,
        messages: [
          { role: "system", content: "Ты помогаешь музыкантам размечать запись. Ответь только JSON объектом: downbeat_index (целое число или null), sections (массив объектов name, at). Не придумывай точность: если сильная доля неясна, верни null. Времена at в секундах от начала файла. Допустимые имена: " + SECTION_NAMES.join(", ") },
          { role: "user", content: [
            { type: "text", text: `Послушай всю песню. Предложи последовательность музыкальных частей и их начала. Первая сильная доля такта должна быть одним из индексов списка первых долей (0-based): ${beats.slice(0, 24).map((at, index) => `${index}:${at.toFixed(2)}`).join(" ")}. Размер такта: ${beatsPerBar} долей. Не считай первую слышимую долю автоматически сильной. Укажи только слышимые части, без дублей. Длительность примерно ${duration.toFixed(1)} с.` },
            { type: "input_audio", input_audio: { data: audio, format: "mp3" } },
          ] },
        ],
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`RouterAI HTTP ${response.status}`);
    const result = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = result.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("RouterAI не вернул текст разметки.");
    const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    return parseAiStructure(JSON.parse(cleaned), duration, beats.length);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
