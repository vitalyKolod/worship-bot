import path from "node:path";
import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { env } from "../../config/env";
import { STEM_NAMES, StemName } from "../../models/Song";
import { runProcess } from "./process-runner";
import { stemPath } from "./audio-storage.service";

export type SeparationProgress = { stage: "separating"; percent: number } | { stage: "saving"; stem: StemName };

export async function separateAudio(songId: string, inputPath: string, outputDir: string, runner = runProcess, onProgress?: (progress: SeparationProgress) => void): Promise<Partial<Record<StemName, { path: string; size: number }>>> {
  const tempDir = path.join(outputDir, `.demucs-${Date.now()}`);
  await mkdir(tempDir, { recursive: true });
  console.info("audio_separation_started", { songId, model: env.audio.separatorModel });
  const started = Date.now();
  try {
    let lastPercent = -1;
    await runner(env.audio.separatorPython, ["-m", "demucs", "--name", env.audio.separatorModel, "--out", tempDir, inputPath], env.audio.processTimeoutMs, undefined, (chunk) => {
      const matches = [...chunk.matchAll(/(?:^|[\r\n])[^\r\n]*?(\d{1,3})%/g)];
      const percent = matches.length ? Number(matches[matches.length - 1][1]) : -1;
      if (percent >= 0 && percent <= 100 && percent >= lastPercent + 5) {
        lastPercent = percent;
        onProgress?.({ stage: "separating", percent });
      }
    });
    const inputBase = path.parse(inputPath).name;
    const generated = path.join(tempDir, env.audio.separatorModel, inputBase);
    const names = await readdir(generated);
    const result: Partial<Record<StemName, { path: string; size: number }>> = {};
    for (const stem of STEM_NAMES) {
      if (!names.includes(`${stem}.wav`)) continue;
      const destination = stemPath(songId, stem);
      await copyFile(path.join(generated, `${stem}.wav`), destination);
      result[stem] = { path: destination, size: (await stat(destination)).size };
      onProgress?.({ stage: "saving", stem });
    }
    if (!result.vocals || !result.drums) throw new Error("Separator did not create required vocals/drums stems");
    console.info("audio_separation_completed", { songId, duration: Date.now() - started, stems: Object.keys(result) });
    return result;
  } catch (error) {
    console.error("audio_separation_failed", { songId, duration: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
