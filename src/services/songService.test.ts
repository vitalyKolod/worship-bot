import test from "node:test";
import assert from "node:assert/strict";
import { scoreSongMatch } from "./songService";

test("fuzzy song score tolerates a small typo", () => {
  assert.ok(scoreSongMatch("Слави", "Славь, душа моя") <= 0.55);
});

test("fuzzy song score rejects an unrelated title", () => {
  assert.ok(scoreSongMatch("Славь", "Океаны") > 0.55);
});

test("song score can match by artist", () => {
  assert.ok(scoreSongMatch("Hillsong", "Океаны", "Hillsong United") <= 0.55);
});
