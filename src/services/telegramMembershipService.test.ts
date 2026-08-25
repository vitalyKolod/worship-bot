import test from "node:test";
import assert from "node:assert/strict";
import { isTelegramGroupAdmin, isTelegramGroupMember } from "./telegramMembershipService";

type Member = Parameters<typeof isTelegramGroupMember>[0];

test("accepts active Telegram group members", () => {
  assert.equal(isTelegramGroupMember({ status: "creator" } as Member), true);
  assert.equal(isTelegramGroupMember({ status: "administrator" } as Member), true);
  assert.equal(isTelegramGroupMember({ status: "member" } as Member), true);
  assert.equal(isTelegramGroupMember({ status: "restricted", is_member: true } as Member), true);
});

test("rejects users who left or were kicked", () => {
  assert.equal(isTelegramGroupMember({ status: "restricted", is_member: false } as Member), false);
  assert.equal(isTelegramGroupMember({ status: "left" } as Member), false);
  assert.equal(isTelegramGroupMember({ status: "kicked" } as Member), false);
});

test("recognizes only creators and administrators as admins", () => {
  assert.equal(isTelegramGroupAdmin({ status: "creator" } as Member), true);
  assert.equal(isTelegramGroupAdmin({ status: "administrator" } as Member), true);
  assert.equal(isTelegramGroupAdmin({ status: "member" } as Member), false);
});
