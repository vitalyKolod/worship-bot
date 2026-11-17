import { access } from "node:fs/promises";
import { env } from "../config/env";
import { runProcess } from "../services/audio/process-runner";

async function main() {
  await access(env.audio.separatorPython);
  const ffmpeg = await runProcess(env.audio.ffmpegPath, ["-version"], 10_000);
  await runProcess(env.audio.separatorPython, ["-m", "demucs", "--help"], 30_000);
  await runProcess(env.audio.separatorPython, ["-c", "import librosa; print(librosa.__version__)"], 30_000);
  console.log(ffmpeg.stdout.split("\n")[0]);
  console.log(`Demucs and librosa available; configured model: ${env.audio.separatorModel}`);
}
main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
