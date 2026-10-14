// P2 first slice: offline IC-7300 CW frame planning only.
// These tests must never open a serial port or call a transport.

import test from "node:test";
import assert from "node:assert/strict";
import {
  CIV_COMMAND_SEND_CW,
  CIV_CW_MAX_MESSAGE_BYTES,
  CIV_CW_STOP_BYTE,
  CivTxPlanError,
  civPlanHex,
  planCivCwMessage,
  planCivCwStop,
} from "../packages/devices/src/index.js";
import * as civTxPlanModule from "../packages/devices/src/civ-tx-plan.js";
import { parseTxDryRunArgs, runTxDryRun } from "../apps/cwrig.js";

// Independently restated from the IC-7300 instruction manual, Command 17
// ("Send CW messages"), printed page 19-13. This dedicated CW-message table
// must not be confused with the general character-input table on page 19-10.
const MANUAL_CW_ALLOWED_ASCII: ReadonlySet<number> = new Set<number>([
  0x20, // space
  ...Array.from({ length: 10 }, (_unused, index) => 0x30 + index), // 0-9
  ...Array.from({ length: 26 }, (_unused, index) => 0x41 + index), // A-Z
  ...Array.from({ length: 26 }, (_unused, index) => 0x61 + index), // a-z
  0x22, 0x27, 0x28, 0x29, 0x2b, 0x2c, 0x2d, 0x2e, 0x2f, 0x3a, 0x3d, 0x3f, 0x40, // " ' ( ) + , - . / : = ? @
  0x5e, // ^ continuous keying
]);

function codePointLabel(code: number): string {
  return `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
}

test("plans the exact IC-7300 CW message frame without a transport", () => {
  const plan = planCivCwMessage("CQ TEST");
  assert.equal(plan.dryRun, true);
  assert.equal(plan.executable, false);
  assert.equal(plan.kind, "message");
  assert.equal(plan.command, CIV_COMMAND_SEND_CW);
  assert.deepEqual(plan.payload, [0x43, 0x51, 0x20, 0x54, 0x45, 0x53, 0x54]);
  assert.deepEqual(plan.bytes, [0xfe, 0xfe, 0x94, 0xe0, 0x17, 0x43, 0x51, 0x20, 0x54, 0x45, 0x53, 0x54, 0xfd]);
  assert.equal(civPlanHex(plan), "fe fe 94 e0 17 43 51 20 54 45 53 54 fd");
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.payload), true);
  assert.equal(Object.isFrozen(plan.bytes), true);
});

test("plans the documented one-byte CW stop payload", () => {
  const plan = planCivCwStop();
  assert.equal(plan.kind, "stop");
  assert.equal(plan.text, null);
  assert.deepEqual(plan.payload, [CIV_CW_STOP_BYTE]);
  assert.deepEqual(plan.bytes, [0xfe, 0xfe, 0x94, 0xe0, 0x17, 0xff, 0xfd]);
});

test("matches the manual Command 17 table for every one of the 128 ASCII bytes", () => {
  let accepted = 0;
  let rejected = 0;
  for (let code = 0x00; code <= 0x7f; code += 1) {
    const character = String.fromCharCode(code);
    if (MANUAL_CW_ALLOWED_ASCII.has(code)) {
      accepted += 1;
      const plan = planCivCwMessage(character);
      assert.equal(plan.text, character);
      assert.deepEqual(plan.payload, [code], `ASCII ${codePointLabel(code)} must be accepted`);
      assert.deepEqual(plan.bytes, [0xfe, 0xfe, 0x94, 0xe0, 0x17, code, 0xfd]);
    } else {
      rejected += 1;
      assert.throws(
        () => planCivCwMessage(character),
        (error: unknown) => {
          if (!(error instanceof CivTxPlanError)) return false;
          if (!error.message.includes(codePointLabel(code))) return false;
          // Printable ASCII is named directly; the rest use its code point only.
          return code < 0x21 || code > 0x7e ? true : error.message.includes(`"${character}"`);
        },
        `ASCII ${codePointLabel(code)} (${JSON.stringify(character)}) must be rejected`,
      );
    }
  }
  assert.equal(accepted, 77, "the Command 17 table lists 77 character codes");
  assert.equal(rejected, 51);
});

test("rejects characters the general 19-10 table allows but Command 17 does not", () => {
  const generalOnly = ["!", "#", "$", "%", "&", "*", ";", "<", ">", "[", "\\", "]", "_", "`", "{", "|", "}", "~"];
  for (const character of generalOnly) {
    assert.equal(MANUAL_CW_ALLOWED_ASCII.has(character.charCodeAt(0)), false);
    assert.throws(
      () => planCivCwMessage(`CQ${character}`),
      (error: unknown) =>
        error instanceof CivTxPlanError &&
        error.message.includes(`"${character}"`) &&
        error.message.includes(codePointLabel(character.charCodeAt(0))),
      `${JSON.stringify(character)} must be rejected by name`,
    );
  }
  // The caret is on the Command 17 page for continuous keying and stays valid.
  assert.equal(planCivCwMessage("CQ^TEST").payload.includes(0x5e), true);
});

test("rejects non-ASCII and invisible characters without transcoding", () => {
  const nonAscii = ["中文", "é", "CQ\u00a0TEST", "😀", "e\u0301"];
  for (const text of nonAscii) {
    assert.throws(() => planCivCwMessage(text), CivTxPlanError, `${JSON.stringify(text)} must be rejected`);
  }
  // The offending non-ASCII code point is reported rather than silently mapped.
  assert.throws(
    () => planCivCwMessage("中"),
    (error: unknown) => error instanceof CivTxPlanError && error.message.includes("U+4E2D"),
  );
  assert.throws(
    () => planCivCwMessage("\u00a0"),
    (error: unknown) => error instanceof CivTxPlanError && error.message.includes("U+00A0"),
  );

  const invisible = ["\n", "\t", "\r", "\u0000", "\u0007", "\u001b", "\u007f"];
  for (const text of invisible) {
    assert.throws(
      () => planCivCwMessage(text),
      (error: unknown) =>
        error instanceof CivTxPlanError && error.message.includes(codePointLabel(text.charCodeAt(0))),
      `${JSON.stringify(text)} must be rejected`,
    );
  }
  assert.throws(() => planCivCwMessage(""), CivTxPlanError);
});

test("accepts exactly 30 bytes and rejects 31 without truncating", () => {
  const exactly30 = "0123456789".repeat(3);
  assert.equal(exactly30.length, 30);
  const plan = planCivCwMessage(exactly30);
  assert.equal(plan.payload.length, CIV_CW_MAX_MESSAGE_BYTES);
  assert.equal(plan.bytes.length, CIV_CW_MAX_MESSAGE_BYTES + 6);
  assert.deepEqual(plan.payload, [...exactly30].map((character) => character.charCodeAt(0)));

  for (const oversized of [`${exactly30}Z`, "A".repeat(31)]) {
    assert.throws(
      () => planCivCwMessage(oversized),
      (error: unknown) => error instanceof CivTxPlanError && error.message.includes("at most 30 bytes"),
      "a 31-byte message must be rejected, never sliced to 30",
    );
  }
});

test("keeps the Command 17 whitelist module-private", () => {
  assert.deepEqual(
    Object.keys(civTxPlanModule).sort(),
    [
      "CIV_COMMAND_SEND_CW",
      "CIV_CW_MAX_MESSAGE_BYTES",
      "CIV_CW_STOP_BYTE",
      "CivTxPlanError",
      "civPlanHex",
      "planCivCwMessage",
      "planCivCwStop",
    ].sort(),
    "the module must not export the authorized character set or a way to widen it",
  );
});

test("CLI tx command is explicitly dry-run and returns no executable path", () => {
  assert.deepEqual(parseTxDryRunArgs(["--dry-run", "--text", "CQ"]), { text: "CQ", stop: false });
  assert.deepEqual(parseTxDryRunArgs(["--stop", "--dry-run"]), { stop: true });
  assert.throws(() => parseTxDryRunArgs(["--text", "CQ"]), /--dry-run/);
  assert.throws(() => parseTxDryRunArgs(["--dry-run", "--text", "CQ", "--stop"]), /exactly one/);

  const result = runTxDryRun({ text: "CQ", stop: false });
  assert.equal(result.source, "civ-tx-plan");
  assert.equal(result.dryRun, true);
  assert.equal(result.executable, false);
  assert.equal(result.frameHex, "fe fe 94 e0 17 43 51 fd");
});
