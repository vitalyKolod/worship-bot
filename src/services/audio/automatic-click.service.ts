import { createAccompaniment, SectionMark } from "./audio-accompaniment.service";
import { analyzeBeats } from "./audio-beat-analysis.service";

export async function prepareAutomaticClick(songId: string, original: string, drums: string, tempoHint?: number, timeSignature?: string, sections: SectionMark[] = []) {
  const analysis = await analyzeBeats(drums, tempoHint);
  if (analysis.status !== "ready" || !analysis.tempo || !analysis.beats?.length) {
    return { status: "needs_review" as const, error: analysis.reason ?? "Не удалось уверенно определить доли." };
  }
  const numerator = Number(timeSignature?.split("/")[0]);
  const grid = {
    tempo: analysis.tempo,
    beatsPerBar: Number.isInteger(numerator) && numerator >= 2 && numerator <= 12 ? numerator : 4,
    firstBeatAt: analysis.beats[0],
    beats: analysis.beats,
    sections,
  };
  const files = await createAccompaniment(songId, original, grid);
  return { ...grid, ...files, source: "automatic" as const, status: "ready" as const };
}
