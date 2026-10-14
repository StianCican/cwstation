import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTRACT_VERSION, PROTOCOL_VERSION } from "../packages/contracts/src/index.js";
import { contentHash } from "../packages/core/src/tx-controller.js";

test("contract and protocol versions are explicit", () => {
  assert.equal(CONTRACT_VERSION, 1);
  assert.equal(PROTOCOL_VERSION, 1);
});

test("content hash binds text, frequency and mode", () => {
  const base = contentHash("CQ TEST", 7_030_000, "CW");
  assert.equal(base, contentHash("CQ TEST", 7_030_000, "CW"));
  assert.notEqual(base, contentHash("CQ TEST ", 7_030_000, "CW"));
  assert.notEqual(base, contentHash("CQ TEST", 7_030_001, "CW"));
  assert.match(base, /^[0-9a-f]{64}$/);
});
