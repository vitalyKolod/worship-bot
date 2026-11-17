import { BeatGrid, SectionMark } from "./audio-accompaniment.service";
import { ChartSection } from "./holychords.service";

export function proposeGuideTimeline(sections: ChartSection[], grid: BeatGrid): SectionMark[] {
  const beats = grid.beats;
  const meter = grid.beatsPerBar;
  if (!beats || !Number.isInteger(meter) || meter < 2 || beats.length < sections.length * meter || sections.length < 2) {
    throw new Error("Для предложения времени частей сначала нужен готовый автоматический клик.");
  }
  const total = sections.reduce((sum, section) => sum + Math.max(1, section.weight), 0);
  let weightBefore = 0;
  let previous = -meter;
  return sections.map((section, index) => {
    const target = Math.round((weightBefore / total) * (beats.length / meter)) * meter;
    const minimum = previous + meter;
    const maximum = beats.length - (sections.length - index) * meter;
    const beatIndex = Math.max(minimum, Math.min(maximum, target));
    previous = beatIndex;
    weightBefore += Math.max(1, section.weight);
    return { name: section.name, variant: section.variant, at: Math.round(beats[beatIndex] * 10) / 10 };
  });
}
