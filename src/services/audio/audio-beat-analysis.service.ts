import path from "node:path";
import { env } from "../../config/env";
import { runProcess } from "./process-runner";

export type BeatAnalysis = {
  status: "ready" | "needs_review";
  tempo?: number;
  beats?: number[];
  irregularity?: number;
  coverage?: number;
  reason?: string;
};

export async function analyzeBeats(file: string, tempoHint?: number): Promise<BeatAnalysis> {
  const script = path.resolve(__dirname, "../../../scripts/analyze-beats.py");
  const hint = tempoHint && tempoHint >= 40 && tempoHint <= 240 ? tempoHint : 120;
  const { stdout } = await runProcess(env.audio.separatorPython, [script, file, String(hint)], Math.min(env.audio.processTimeoutMs, 5 * 60_000));
  const result = JSON.parse(stdout.trim()) as BeatAnalysis;
  if (result.status !== "ready" || !result.beats || !result.tempo) return { status: "needs_review", reason: result.reason ?? "Не удалось определить доли." };
  if (result.beats.length < 16 || result.beats.length > 5000 || !Number.isFinite(result.tempo) || result.tempo < 40 || result.tempo > 240 || result.beats.some((beat, index) => !Number.isFinite(beat) || beat < 0 || (index > 0 && beat <= result.beats![index - 1]))) return { status: "needs_review", reason: "Неоднозначная сетка долей." };
  return result;
}
