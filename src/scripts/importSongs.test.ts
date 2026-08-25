import test from "node:test";
import assert from "node:assert/strict";
import { INITIAL_SONGS } from "../data/initialSongs";
import { normalizeSongTitle, parseImportOptions } from "./importSongs";

test("initial song catalog has unique normalized titles and fixed defaults", () => {
  const normalizedTitles = INITIAL_SONGS.map((song) => normalizeSongTitle(song.title));
  assert.equal(new Set(normalizedTitles).size, INITIAL_SONGS.length);
  assert.ok(INITIAL_SONGS.every((song) => song.timeSignature === "4/4"));
  assert.ok(INITIAL_SONGS.every((song) => song.key.length > 0));
});

test("import options support dry-run and explicit commit", () => {
  assert.deepEqual(parseImportOptions(["--team-name", "Прославление"]), {
    commit: false,
    help: false,
    teamName: "Прославление",
  });
  assert.deepEqual(parseImportOptions(["--team-id=507f1f77bcf86cd799439011", "--commit"]), {
    commit: true,
    help: false,
    teamId: "507f1f77bcf86cd799439011",
  });
});

test("import options reject ambiguous team selectors", () => {
  assert.throws(
    () => parseImportOptions(["--team-name", "Прославление", "--chat-id", "-100123"]),
    /только один селектор/
  );
});

