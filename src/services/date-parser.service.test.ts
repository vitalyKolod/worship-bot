import test from "node:test";
import assert from "node:assert/strict";

import { parseRussianDateTime } from "./date-parser.service";

const now = new Date(2026, 7, 24, 12, 0, 0);

test("parses tomorrow with an explicit time", () => {
  const parsed = parseRussianDateTime("завтра в 19:00", now);
  assert.ok(parsed);
  assert.equal(parsed.value.getFullYear(), 2026);
  assert.equal(parsed.value.getMonth(), 7);
  assert.equal(parsed.value.getDate(), 25);
  assert.equal(parsed.value.getHours(), 19);
  assert.equal(parsed.value.getMinutes(), 0);
});

test("uses the nearest future weekday and treats bare 7 as evening", () => {
  const parsed = parseRussianDateTime("в пятницу в 7", now);
  assert.ok(parsed);
  assert.equal(parsed.value.getDate(), 28);
  assert.equal(parsed.value.getHours(), 19);
  assert.equal(parsed.ambiguousTime, true);
});

test("parses a named date", () => {
  const parsed = parseRussianDateTime("28 августа в 19", now);
  assert.ok(parsed);
  assert.equal(parsed.value.getDate(), 28);
  assert.equal(parsed.value.getMonth(), 7);
  assert.equal(parsed.value.getHours(), 19);
});

test("parses a numeric date", () => {
  const parsed = parseRussianDateTime("28.08.2026 в 19:30", now);
  assert.ok(parsed);
  assert.equal(parsed.value.getDate(), 28);
  assert.equal(parsed.value.getHours(), 19);
  assert.equal(parsed.value.getMinutes(), 30);
});
