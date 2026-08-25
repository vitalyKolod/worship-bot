import test from "node:test";
import assert from "node:assert/strict";

import { detectJokeKind, pickJoke } from "./jokes";

test("detects late messages locally", () => {
  assert.equal(detectJokeKind("Опоздаю минут на десять"), "late");
  assert.equal(detectJokeKind("Я немного задержусь"), "late");
  assert.equal(detectJokeKind("Уже выезжаю"), "late");
});

test("detects absence without mistaking an ordinary sentence for it", () => {
  assert.equal(detectJokeKind("Сегодня не буду"), "absent");
  assert.equal(detectJokeKind("Меня сегодня не будет"), "absent");
  assert.equal(detectJokeKind("Не буду опаздывать"), "late");
  assert.equal(detectJokeKind("Не буду играть эту песню"), null);
});

test("picks a joke from code without an external service", () => {
  assert.match(pickJoke("late", () => 0), /Опаздываешь/);
  assert.match(pickJoke("absent", () => 0), /Не будешь/);
});
