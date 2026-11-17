import path from "node:path";
import { mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { env } from "../../config/env";
import { StemName, STEM_NAMES } from "../../models/Song";
import { audioPaths, existingFile } from "./audio-storage.service";
import { runProcess } from "./process-runner";

export function selectAvailableStems(include: readonly StemName[], stems: Partial<Record<StemName, { path: string }>>): StemName[] {
  return [...new Set(include)].filter((name) => STEM_NAMES.includes(name) && Boolean(stems[name]?.path));
}

export function mixCacheName(include: readonly StemName[], extras: readonly string[] = [], revision = ""): string {
  const normalized = [...new Set(include)].sort();
  return `mix-${createHash("sha256").update(JSON.stringify([normalized, [...new Set(extras)].sort(), revision])).digest("hex").slice(0, 16)}.mp3`;
}

export async function createStemMix(songId: string, include: StemName[], stems: Partial<Record<StemName, { path: string }>>, extras: Partial<Record<"click" | "guide", { path: string }>> = {}, revision = "", levels: Record<string, number> = {}, prelude?: { path: string; duration: number; firstBeatAt: number }): Promise<string> {
  const selected = selectAvailableStems(include, stems);
  const extraNames = (["click", "guide"] as const).filter((name) => extras[name]?.path);
  if (!selected.length && !extraNames.length) throw new Error("No available audio tracks selected");
  const levelFor = (name: string) => {
    const value = levels[name] ?? 100;
    return Number.isFinite(value) ? Math.max(0, Math.min(200, value)) : 100;
  };
  const levelKey = [...selected, ...extraNames].map((name) => [name, levelFor(name)]);
  const output = path.join(audioPaths(songId).mixes, mixCacheName(selected, extraNames, JSON.stringify([revision, levelKey, prelude])));
  await mkdir(path.dirname(output), { recursive: true });
  if (await existingFile(output)) return output;
  const started = Date.now();
  console.info("audio_mix_started", { songId, stems: selected });
  const args = [...selected.flatMap((stem) => ["-i", stems[stem]!.path]), ...extraNames.flatMap((name) => ["-i", extras[name]!.path])];
  if (prelude) args.push("-i", prelude.path);
  const inputs = [...selected, ...extraNames].map((_, index) => `[${index}:a]`).join("");
  const count = selected.length + extraNames.length;
  const weights = [...selected.map((name) => levelFor(name) / 100 / selected.length), ...extraNames.map((name) => (name === "click" ? 0.35 : 0.8) * levelFor(name) / 100)].join(" ");
  const customized = extraNames.length > 0 || selected.some((name) => levelFor(name) !== 100);
  const mixed = customized
    ? `${inputs}amix=inputs=${count}:duration=longest:normalize=0:weights='${weights}',alimiter=limit=0.95`
    : `${inputs}amix=inputs=${count}:duration=longest:normalize=1,alimiter=limit=0.95`;
  const delayMs = prelude ? Math.round(Math.max(0, prelude.duration - prelude.firstBeatAt) * 1000) : 0;
  const filter = prelude
    ? `${mixed}[mixed];[mixed]adelay=${delayMs}:all=1[delayed];[${count}:a][delayed]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95[out]`
    : `${mixed}[out]`;
  args.push("-filter_complex", filter, "-map", "[out]", "-codec:a", "libmp3lame", "-b:a", "256k", "-y", output);
  try {
    await runProcess(env.audio.ffmpegPath, args, Math.min(env.audio.processTimeoutMs, 10 * 60_000));
    console.info("audio_mix_completed", { songId, duration: Date.now() - started, output });
    return output;
  } catch (error) {
    console.error("audio_mix_failed", { songId, duration: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
