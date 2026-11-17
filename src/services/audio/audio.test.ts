import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { normalizeAudioExtension, safeSongDirectory } from "./audio-storage.service";
import { mixCacheName, selectAvailableStems } from "./audio-mix.service";
import { canTransitionAudioJob } from "./audio-job.service";
import { separateAudio } from "./audio-separation.service";
import { beatTimes, clickTimes, countInCues, downbeatIndex, guideCueAt, isAccentedBeat, resolveSectionName, validateBeatGrid } from "./audio-accompaniment.service";
import { parseAiStructure } from "./routerai-audio.service";
import { normalizeHolyChordsUrl, parseHolyChordsPage } from "./holychords.service";
import { proposeGuideTimeline } from "./guide-timeline.service";

test("HolyChords import accepts only song pages and preserves section order", () => {
  assert.equal(normalizeHolyChordsUrl("https://holychords.pro/74985?from=share"), "https://holychords.pro/74985");
  for (const url of ["http://holychords.pro/74985", "https://holychords.pro.evil.test/74985", "https://holychords.pro@evil.test/74985", "https://holychords.pro/admin"]) {
    assert.throws(() => normalizeHolyChordsUrl(url));
  }
  const html = `<pre id="music_text" itemprop="lyrics">Вступление:\nC G Am F\nКуплет 1:\nC G\nПрипев: x2\nAm F C G\nБридж:\nF G</pre>`;
  const sections = parseHolyChordsPage(html);
  assert.deepEqual(sections.map((section) => section.name), ["Intro", "Verse", "Chorus", "Bridge"]);
  assert.equal(sections[1].variant, 1);
  assert.ok(sections[2].weight > sections[1].weight);
  const marks = proposeGuideTimeline(sections, { tempo: 120, beatsPerBar: 4, firstBeatAt: 0, beats: Array.from({ length: 64 }, (_, index) => index / 2), sections: [] });
  assert.equal(marks.length, 4);
  assert.ok(marks.every((mark, index) => index === 0 || mark.at > marks[index - 1].at));
});

test("normalizes supported filenames and rejects executable suffixes", () => {
  assert.equal(normalizeAudioExtension("demo.MP3", undefined), ".mp3");
  assert.equal(normalizeAudioExtension("../../attack.sh", "application/octet-stream"), null);
  assert.equal(normalizeAudioExtension("wrong.exe", "audio/wav"), ".wav");
});

test("builds paths only from Mongo ObjectIds", () => {
  const value = safeSongDirectory("507f1f77bcf86cd799439011");
  assert.equal(path.basename(value), "507f1f77bcf86cd799439011");
  assert.throws(() => safeSongDirectory("../../etc"));
});

test("selects only available stems and tolerates missing optional stems", () => {
  const stems = { vocals: { path: "/tmp/v.wav" }, drums: { path: "/tmp/d.wav" } };
  assert.deepEqual(selectAvailableStems(["vocals", "guitar", "drums", "vocals"], stems), ["vocals", "drums"]);
});

test("mix cache is stable and order independent", () => {
  assert.equal(mixCacheName(["vocals", "drums"]), mixCacheName(["drums", "vocals"]));
  assert.notEqual(mixCacheName(["drums"]), mixCacheName(["vocals"]));
});

test("completed mixes resolve to the same cache entry on repeated request", () => {
  const first = mixCacheName(["vocals", "bass", "other"]);
  const repeated = mixCacheName(["other", "vocals", "bass", "vocals"]);
  assert.equal(first, repeated);
});

test("click and guide choices produce distinct cached mixes", () => {
  assert.notEqual(mixCacheName(["drums"], ["click"]), mixCacheName(["drums"], ["guide"]));
  assert.notEqual(mixCacheName(["drums"], ["click"], "old"), mixCacheName(["drums"], ["click"], "new"));
});

test("beat grid stays on sample-independent musical times", () => {
  const grid = { tempo: 120, beatsPerBar: 4, firstBeatAt: 1.25, sections: [{ name: "Chorus" as const, at: 9.25 }] };
  validateBeatGrid(grid, 12);
  assert.deepEqual(beatTimes(grid, 3), [1.25, 1.75, 2.25, 2.75]);
  assert.deepEqual(clickTimes(grid, 2, 2), [{ at: 1.25, primary: true }, { at: 1.5, primary: false }, { at: 1.75, primary: true }]);
  assert.deepEqual(beatTimes({ ...grid, beats: [0.1, 0.6, 1.13, 1.64, 2.15, 2.66, 3.17, 3.68, 4.19, 4.7, 5.21, 5.72, 6.23, 6.74, 7.25, 7.76] }, 12).slice(0, 3), [0.1, 0.6, 1.13]);
  assert.equal(guideCueAt(grid.sections[0], grid), 5.25);
  assert.equal(resolveSectionName("припев"), "Chorus");
  assert.throws(() => validateBeatGrid({ ...grid, firstBeatAt: 12 }, 12));
});

test("AI downbeat moves the click accent without removing earlier beats", () => {
  const grid = { tempo: 120, beatsPerBar: 4, firstBeatAt: 1.5, beats: Array.from({ length: 20 }, (_, index) => index / 2), sections: [] };
  assert.equal(downbeatIndex(grid, 10), 3);
  assert.equal(clickTimes(grid, 2, 1).length, 4);
  assert.equal(isAccentedBeat(3, 3, 4, 0), true);
  assert.equal(isAccentedBeat(0, 3, 4, 0), false);
  assert.equal(isAccentedBeat(7, 3, 4, 0), true);
  const proposal = parseAiStructure({ downbeat_index: 3, sections: [{ name: "Intro", at: 0 }, { name: "Verse", at: 8 }] }, 20, 20);
  assert.equal(proposal.downbeatIndex, 3);
  assert.deepEqual(proposal.sections.map((section) => section.draftAt), [0, 8]);
  assert.throws(() => parseAiStructure({ downbeat_index: 3, sections: [{ name: "Intro", at: 8 }, { name: "Verse", at: 4 }] }, 20, 20));
});

test("audio job transitions permit retry but never rerun completed jobs", () => {
  assert.equal(canTransitionAudioJob("pending", "processing"), true);
  assert.equal(canTransitionAudioJob("processing", "completed"), true);
  assert.equal(canTransitionAudioJob("processing", "failed"), true);
  assert.equal(canTransitionAudioJob("failed", "pending"), true);
  assert.equal(canTransitionAudioJob("completed", "pending"), false);
});

test("failed separator subprocess is propagated", async () => {
  const runner = async () => { throw new Error("mock separator failure"); };
  await assert.rejects(() => separateAudio("507f1f77bcf86cd799439011", "/tmp/fake.wav", "/tmp", runner), /mock separator failure/);
});

test("count-in follows the beat grid and skips sections without room", () => {
  const grid = { tempo: 120, beatsPerBar: 4, firstBeatAt: 0, sections: [], beats: Array.from({ length: 80 }, (_, index) => index / 2) };
  assert.deepEqual(countInCues({ name: "Chorus", at: 12 }, grid, 4), [
    { number: 1, at: 9 }, { number: 2, at: 9.5 }, { number: 1, at: 10 },
    { number: 2, at: 10.5 }, { number: 3, at: 11 }, { number: 4, at: 11.5 },
  ]);
  assert.deepEqual(countInCues({ name: "Verse", at: 2 }, grid), []);
  assert.deepEqual(countInCues({ name: "Chorus", at: 12 }, grid, 10), []);
});

test("HolyChords separates lyrics from chord lines and reads repeated sections", () => {
  const html = `<pre id="music_text" itemprop="lyrics">Интро:\nHm D G\nО-о-о\n1 куплет:\nHm\nБог перед Тобой\nD\nСклоняются века\nПрипев: х2\nG Hm\nБог вся вселенная поёт\nТы так велик\nПроигрыш:\nG Hm A Em</pre>`;
  const sections = parseHolyChordsPage(html);
  assert.deepEqual(sections.map((section) => section.name), ["Intro", "Verse", "Chorus", "Interlude"]);
  assert.deepEqual(sections[1].lyrics, ["Бог перед Тобой", "Склоняются века"]);
  assert.equal(sections[2].weight, 4);
  assert.deepEqual(sections[3].lyrics, []);
});
