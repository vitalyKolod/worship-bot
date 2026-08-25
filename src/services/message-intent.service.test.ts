import test from "node:test";
import assert from "node:assert/strict";

import { extractLineupCandidates, parseMessageIntent, roleIconHtml } from "./message-intent.service";

test("recognizes schedule and attendance intents", () => {
  assert.equal(parseMessageIntent("репетиция завтра в 19").type, "CREATE_REHEARSAL");
  assert.equal(parseMessageIntent("репу отменяем").type, "CANCEL_REHEARSAL");
  assert.equal(parseMessageIntent("перенесем на субботу").type, "MOVE_REHEARSAL");
  assert.equal(parseMessageIntent("перенесем служение на субботу").type, "MOVE_SERVICE");
  assert.deepEqual(parseMessageIntent("я опоздаю на 20 минут"), { type: "USER_LATE", lateMinutes: 20 });
  assert.equal(parseMessageIntent("я сегодня не смогу").type, "USER_UNAVAILABLE");
});

test("uses configured custom emoji with a standard fallback", () => {
  assert.equal(roleIconHtml("drums"), '<tg-emoji emoji-id="5465293043177388397">🥁</tg-emoji>');
  assert.equal(roleIconHtml("bass"), '<tg-emoji emoji-id="5219879140164908839">🎸</tg-emoji>');
});

test("recognizes a lineup without guessing ordinary chat", () => {
  assert.equal(parseMessageIntent("на барабанах Виталий").type, "SET_LINEUP");
  assert.deepEqual(extractLineupCandidates("на барабанах Виталий"), [{ role: "drums", names: ["Виталий"] }]);
  assert.equal(parseMessageIntent("классная песня").type, "NONE");
});

test("parses free-form lineup names without requiring registered users", () => {
  const text = "Барабаны - Виталик\nЭлектро - Макс\nКлавиши - Денис";
  assert.deepEqual(extractLineupCandidates(text), [
    { role: "drums", names: ["Виталик"] },
    { role: "electric_guitar", names: ["Макс"] },
    { role: "keys", names: ["Денис"] },
  ]);
});
