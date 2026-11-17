import path from "node:path";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { env } from "../../config/env";
import { audioPaths, existingFile } from "./audio-storage.service";
import { runProcess } from "./process-runner";

const SAMPLE_RATE = 48000;
export const SECTION_NAMES = ["Intro", "Verse", "Pre Chorus", "Chorus", "Post Chorus", "Bridge", "Interlude", "Solo", "Breakdown", "Turnaround", "Tag", "Vamp", "Outro", "Acapella"] as const;
export type SectionName = typeof SECTION_NAMES[number];
const SECTION_ALIASES: Record<string, SectionName> = { "вступление": "Intro", "куплет": "Verse", "предприпев": "Pre Chorus", "припев": "Chorus", "постприпев": "Post Chorus", "бридж": "Bridge", "проигрыш": "Interlude", "соло": "Solo", "брейк": "Breakdown", "переход": "Turnaround", "концовка": "Outro" };
export function resolveSectionName(value: string): SectionName | undefined {
  return SECTION_NAMES.find((name) => name.toLowerCase() === value.trim().toLowerCase()) ?? SECTION_ALIASES[value.trim().toLowerCase()];
}
export type SectionMark = { name: SectionName; at: number; variant?: number };
export type BeatGrid = { tempo: number; beatsPerBar: number; firstBeatAt: number; sections: SectionMark[]; beats?: number[] };
export type ClickSubdivision = 1 | 2 | 4;
export type ClickSound = "blip" | "sine";

export function validateBeatGrid(grid: BeatGrid, duration: number): void {
  if (!Number.isFinite(grid.tempo) || grid.tempo < 40 || grid.tempo > 240) throw new Error("Темп должен быть от 40 до 240 BPM.");
  if (!Number.isInteger(grid.beatsPerBar) || grid.beatsPerBar < 2 || grid.beatsPerBar > 12) throw new Error("Размер должен содержать от 2 до 12 долей.");
  if (!Number.isFinite(grid.firstBeatAt) || grid.firstBeatAt < 0 || grid.firstBeatAt >= duration) throw new Error("Начало первого такта вне песни.");
  if (grid.sections.length > 50 || grid.sections.some((section) => !SECTION_NAMES.includes(section.name) || !Number.isFinite(section.at) || section.at < 0 || section.at >= duration || (section.variant !== undefined && (!Number.isInteger(section.variant) || section.variant < 1 || section.variant > 7)))) throw new Error("Неверная разметка частей песни.");
  if (grid.beats && (grid.beats.length < 16 || grid.beats.length > 5000 || grid.beats.some((beat, index) => !Number.isFinite(beat) || beat < 0 || beat >= duration || (index > 0 && beat <= grid.beats![index - 1])))) throw new Error("Неверная автоматическая сетка долей.");
}

export function beatTimes(grid: BeatGrid, duration: number): number[] {
  if (grid.beats?.length) return grid.beats;
  const step = 60 / grid.tempo;
  const count = Math.ceil((duration - grid.firstBeatAt) / step);
  return Array.from({ length: count }, (_, index) => grid.firstBeatAt + index * step).filter((at) => at < duration);
}

export function clickTimes(grid: BeatGrid, duration: number, subdivision: ClickSubdivision): Array<{ at: number; primary: boolean }> {
  const beats = beatTimes(grid, duration);
  const result: Array<{ at: number; primary: boolean }> = [];
  for (let index = 0; index < beats.length; index++) {
    const next = beats[index + 1] ?? beats[index] + 60 / grid.tempo;
    for (let part = 0; part < subdivision; part++) {
      const at = beats[index] + (next - beats[index]) * part / subdivision;
      if (at < duration) result.push({ at, primary: part === 0 });
    }
  }
  return result;
}

export function downbeatIndex(grid: BeatGrid, duration: number): number {
  const beats = beatTimes(grid, duration);
  if (!beats.length) return 0;
  return beats.reduce((best, at, index) => Math.abs(at - grid.firstBeatAt) < Math.abs(beats[best] - grid.firstBeatAt) ? index : best, 0);
}

export function isAccentedBeat(beatIndex: number, firstDownbeat: number, beatsPerBar: number, accentBeat: number): boolean {
  return (beatIndex - firstDownbeat - accentBeat) % beatsPerBar === 0;
}

export function guideCueAt(section: SectionMark, grid: BeatGrid): number {
  return Math.max(0, section.at - grid.beatsPerBar * 60 / grid.tempo * 2);
}

/** Spoken count-in on the actual beat grid before a section begins. */
export function countInCues(section: SectionMark, grid: BeatGrid, previousSectionAt = 0): Array<{ number: number; at: number }> {
  const beats = beatTimes(grid, section.at + 60 / grid.tempo);
  const sectionBeat = beats.findIndex((at) => at >= section.at - 0.08);
  if (sectionBeat < 0) return [];
  const numbers = grid.beatsPerBar === 4 ? [1, 2, 1, 2, 3, 4] : Array.from({ length: grid.beatsPerBar }, (_, index) => index + 1);
  const start = sectionBeat - numbers.length;
  if (start < 0 || beats[start] < previousSectionAt + 0.1) return [];
  return numbers.map((number, index) => ({ number, at: beats[start + index] }));
}

async function durationOf(file: string): Promise<number> {
  const result = await runProcess(env.audio.ffprobePath, ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file], 30_000);
  const duration = Number(result.stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0 || duration > 15 * 60) throw new Error("Клик и гайд поддерживают записи до 15 минут.");
  return duration;
}

async function decodeSample(file: string, temporary: string): Promise<Buffer> {
  await runProcess(env.audio.ffmpegPath, ["-v", "error", "-i", file, "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", "-acodec", "pcm_s16le", "-y", temporary], 60_000);
  return readFile(temporary);
}

function addSample(track: Int16Array, at: number, sample: Buffer, gain: number): void {
  const start = Math.round(at * SAMPLE_RATE);
  for (let index = 0; index < sample.length / 2 && start + index < track.length; index++) {
    const value = track[start + index] + Math.round(sample.readInt16LE(index * 2) * gain);
    track[start + index] = Math.max(-32768, Math.min(32767, value));
  }
}

async function writeWav(file: string, samples: Int16Array): Promise<void> {
  const output = Buffer.allocUnsafe(44 + samples.length * 2);
  output.write("RIFF", 0);
  output.writeUInt32LE(output.length - 8, 4);
  output.write("WAVEfmt ", 8);
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(SAMPLE_RATE, 24);
  output.writeUInt32LE(SAMPLE_RATE * 2, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write("data", 36);
  output.writeUInt32LE(samples.length * 2, 40);
  for (let index = 0; index < samples.length; index++) output.writeInt16LE(samples[index], 44 + index * 2);
  await writeFile(file, output);
}

/** A short click lead-in followed by the spoken 1, 2, 1, 2, 3, 4 count. */
export async function createCountInPrelude(songId: string, tempo: number, beatsPerBar: number, clickSound: ClickSound = "blip", firstBeatAt = 0): Promise<{ path: string; duration: number; firstBeatAt: number }> {
  if (!Number.isFinite(tempo) || tempo < 40 || tempo > 240 || !Number.isInteger(beatsPerBar) || beatsPerBar < 2 || beatsPerBar > 12) throw new Error("Сначала настрой темп и размер песни.");
  if (!Number.isFinite(firstBeatAt) || firstBeatAt < 0) throw new Error("Неверное время начала первого такта.");
  const base = path.join(env.audio.guidesPath, "English Guides", "Song Sections");
  const numbers = beatsPerBar === 4 ? [1, 2, 1, 2, 3, 4] : Array.from({ length: beatsPerBar }, (_, index) => index + 1);
  for (const number of new Set(numbers)) if (!(await existingFile(path.join(base, `English Female - ${number}.wav`)))) throw new Error("Для вступительного отсчёта не найдены голосовые сэмплы чисел.");
  const step = 60 / tempo;
  const leadBeats = Math.max(beatsPerBar, Math.ceil(firstBeatAt / (beatsPerBar * step)) * beatsPerBar);
  const frames = Math.ceil((leadBeats + numbers.length) * step * SAMPLE_RATE);
  const duration = frames / SAMPLE_RATE;
  const output = path.join(audioPaths(songId).mixes, `prelude-${createHash("sha256").update(JSON.stringify([tempo, beatsPerBar, clickSound, firstBeatAt, env.audio.guidesPath])).digest("hex").slice(0, 16)}.wav`);
  await mkdir(path.dirname(output), { recursive: true });
  if (await existingFile(output)) return { path: output, duration, firstBeatAt };
  const temporary = await mkdtemp(path.join(tmpdir(), "worship-prelude-"));
  try {
    const samples = new Int16Array(frames);
    const clickFile = path.join(env.audio.guidesPath, "Click Tracks", "New Click -  Blip-eighth.wav");
    const clickSample = clickSound === "blip" && await existingFile(clickFile) ? await decodeSample(clickFile, path.join(temporary, "click.raw")) : null;
    for (let beat = 0; beat < leadBeats + numbers.length; beat++) {
      const at = beat * step;
      if (clickSample) addSample(samples, at, clickSample, beat % beatsPerBar === 0 ? 0.65 : 0.45);
      else {
        const start = Math.round(at * SAMPLE_RATE);
        for (let frame = 0; frame < SAMPLE_RATE * 0.035 && start + frame < frames; frame++) {
          samples[start + frame] += Math.round(6500 * Math.exp(-frame / (SAMPLE_RATE * 0.008)) * Math.sin(2 * Math.PI * 950 * frame / SAMPLE_RATE));
        }
      }
    }
    for (const [index, number] of numbers.entries()) {
      const voice = await decodeSample(path.join(base, `English Female - ${number}.wav`), path.join(temporary, `number-${index}.raw`));
      addSample(samples, (leadBeats + index) * step, voice, 0.85);
    }
    const staged = path.join(temporary, "prelude.wav");
    await writeWav(staged, samples);
    await rename(staged, output);
    return { path: output, duration, firstBeatAt };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function createAccompaniment(songId: string, original: string, grid: BeatGrid, subdivision: ClickSubdivision = 1, clickSound: ClickSound = "blip", accentBeat = 0): Promise<{ click: { path: string; size: number }; guide?: { path: string; size: number } }> {
  const duration = await durationOf(original);
  validateBeatGrid(grid, duration);
  if (![1, 2, 4].includes(subdivision)) throw new Error("Неверная частота клика.");
  if (!Number.isInteger(accentBeat) || accentBeat < 0 || accentBeat >= grid.beatsPerBar) throw new Error("Неверная доля акцента.");
  const frames = Math.ceil(duration * SAMPLE_RATE);
  const temporary = await mkdtemp(path.join(tmpdir(), "worship-cues-"));
  const root = audioPaths(songId).mixes;
  await mkdir(root, { recursive: true });
  const revision = createHash("sha256").update(JSON.stringify([grid, subdivision, clickSound, accentBeat, env.audio.guidesPath])).digest("hex").slice(0, 16);
  try {
    const click = new Int16Array(frames);
    const clickFile = path.join(env.audio.guidesPath, "Click Tracks", "New Click -  Blip-eighth.wav");
    const clickSample = clickSound === "blip" && env.audio.guidesPath && await existingFile(clickFile)
      ? await decodeSample(clickFile, path.join(temporary, "click.raw"))
      : null;
    const firstDownbeat = downbeatIndex(grid, duration);
    for (const [index, tick] of clickTimes(grid, duration, subdivision).entries()) {
      const { at, primary } = tick;
      const accent = primary && isAccentedBeat(Math.floor(index / subdivision), firstDownbeat, grid.beatsPerBar, accentBeat);
      if (clickSample) addSample(click, at, clickSample, primary ? accent ? 0.9 : 0.7 : 0.4);
      else {
        const start = Math.round(at * SAMPLE_RATE);
        const length = Math.round(SAMPLE_RATE * 0.04);
        for (let frame = 0; frame < length && start + frame < frames; frame++) {
          const envelope = Math.exp(-frame / (SAMPLE_RATE * 0.009));
          click[start + frame] = Math.round((primary ? 11000 : 6500) * envelope * Math.sin(2 * Math.PI * (accent ? 1200 : primary ? 1000 : 800) * frame / SAMPLE_RATE));
        }
      }
    }
    const clickOutput = path.join(root, `click-${revision}.wav`);
    await writeWav(path.join(temporary, "click.wav"), click);
    await rename(path.join(temporary, "click.wav"), clickOutput);
    const result: { click: { path: string; size: number }; guide?: { path: string; size: number } } = { click: { path: clickOutput, size: (await stat(clickOutput)).size } };
    if (grid.sections.length && env.audio.guidesPath) {
      const guide = new Int16Array(frames);
      let placed = 0;
      const base = path.join(env.audio.guidesPath, "English Guides", "Song Sections");
      for (const [index, section] of grid.sections.entries()) {
        const numbered = section.variant ? path.join(base, `English Female - ${section.name} ${section.variant}.wav`) : "";
        const file = numbered && await existingFile(numbered) ? numbered : path.join(base, `English Female - ${section.name}.wav`);
        if (!(await existingFile(file))) continue;
        const raw = await decodeSample(file, path.join(temporary, `guide-${index}.raw`));
        addSample(guide, guideCueAt(section, grid), raw, 0.85);
        placed++;
        const count = countInCues(section, grid, index ? grid.sections[index - 1].at : 0);
        for (const [cueIndex, cue] of count.entries()) {
          const countFile = path.join(base, `English Female - ${cue.number}.wav`);
          if (!(await existingFile(countFile))) continue;
          const countRaw = await decodeSample(countFile, path.join(temporary, `count-${index}-${cueIndex}.raw`));
          addSample(guide, cue.at, countRaw, 0.8);
        }
      }
      if (placed) {
        const guideOutput = path.join(root, `guide-${revision}.wav`);
        await writeWav(path.join(temporary, "guide.wav"), guide);
        await rename(path.join(temporary, "guide.wav"), guideOutput);
        result.guide = { path: guideOutput, size: (await stat(guideOutput)).size };
      }
    }
    return result;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
