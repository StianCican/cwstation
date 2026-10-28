import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCwTrialArgs, runCwTrial } from "../apps/rig-cw-trial.js";
import {
  CwTrialRecordStore,
  createCwTrialSimulatorTransport,
  cwTrialIntentDigest,
} from "../packages/cw-trial/src/index.js";

// 26 single-byte Command 17 characters: upper-case letters, digits, an internal
// space and the table's `" ' ( ) + , - . / : = ? @` punctuation subset.
const CUSTOM_MESSAGE_26 = "CQ TEST 0123456789 +-./:?@";
// The advertised 30-byte boundary. A Command 17 frame with 30 payload bytes is
// 36 bytes on the wire; the default CivFrameParser limit is 32 (see the focused
// failing test below).
const CUSTOM_MESSAGE = "CQ TEST 0123456789 +-./:?@ABCD";
const CUSTOM_MESSAGE_31 = `${CUSTOM_MESSAGE}E`;

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "cw-custom-message-"));
  const transport = createCwTrialSimulatorTransport({ ack: "ok" });
  const output: string[] = [];
  t.after(async () => {
    await transport.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    transport,
    output,
    args: (confirm = CUSTOM_MESSAGE_26, message = CUSTOM_MESSAGE_26): string[] => [
      "--simulate",
      "--message", message,
      "--simulate-confirm", confirm,
      "--record-dir", directory,
      "--timeout-ms", "200",
    ],
    /** Command 17 frames only; the eight-query preflight/reread frames are excluded. */
    messages: () => transport.requests.filter(bytes => bytes[4] === 0x17),
  };
}

function nonInteractiveIo(output: string[]) {
  return {
    isTTY: false,
    write: (line: string) => { output.push(line); },
    prompt: async (_question: string): Promise<string> => {
      throw new Error("simulation must not prompt");
    },
  };
}

function payload(bytes: Uint8Array): number[] {
  return [...bytes.slice(5, -1)];
}

test("30-byte uppercase Command 17 message is accepted; 31 bytes is rejected", () => {
  assert.equal(CUSTOM_MESSAGE.length, 30);
  assert.equal(CUSTOM_MESSAGE_31.length, 31);
  const parsed = parseCwTrialArgs(["--simulate", "--message", CUSTOM_MESSAGE]);
  assert.equal(parsed.simulate, true);
  assert.equal(parsed.message, CUSTOM_MESSAGE);
  assert.throws(
    () => parseCwTrialArgs(["--simulate", "--message", CUSTOM_MESSAGE_31]),
    /at most 30 bytes/,
  );
});

test("empty, lowercase, control, non-ASCII and caret messages are rejected", () => {
  for (const item of [
    { name: "empty", value: "", pattern: /missing or invalid value/ },
    { name: "lowercase", value: "Cq test", pattern: /uppercase ASCII/ },
    { name: "control", value: "CQ\nTEST", pattern: /unsupported character U\+000A/ },
    { name: "non-ASCII", value: "CQ测试", pattern: /unsupported character U\+6D4B/ },
    { name: "caret", value: "CQ ^", pattern: /continuous keying/ },
  ] as const) {
    assert.throws(
      () => parseCwTrialArgs(["--simulate", "--message", item.value]),
      item.pattern,
      item.name,
    );
  }
});

test("31-byte custom message is refused before records or transport", async t => {
  const f = await fixture(t);
  let opens = 0;
  const rejectOpen = async (): Promise<never> => {
    opens += 1;
    throw new Error("must not open");
  };
  assert.equal(await runCwTrial([
    "--simulate",
    "--message", CUSTOM_MESSAGE_31,
    "--simulate-confirm", CUSTOM_MESSAGE_31,
    "--record-dir", f.directory,
  ], {
    io: nonInteractiveIo(f.output),
    openStore: rejectOpen,
    createTransport: rejectOpen,
  }), 2);
  assert.equal(opens, 0);
});

test("custom message is sent once, stopped once, recorded verbatim and blocks the next transport", async t => {
  const f = await fixture(t);
  const io = nonInteractiveIo(f.output);
  assert.equal(await runCwTrial(f.args(), {
    io,
    createTransport: async () => f.transport,
  }), 0, f.output.join("\n"));

  const command17 = f.messages();
  assert.equal(command17.length, 2);
  assert.deepEqual(payload(command17[0]!), [...Buffer.from(CUSTOM_MESSAGE_26, "ascii")]);
  assert.deepEqual(payload(command17[1]!), [0xff]);
  assert.equal(f.transport.requests.filter(bytes => bytes[4] !== 0x17).length, 16);
  assert.equal(f.transport.closed, true);

  const store = await CwTrialRecordStore.open(f.directory);
  const rows = await store.readAll();
  assert.deepEqual(rows.map(row => row.event), [
    "intent", "send_result", "stop_intent", "stop_result", "session_close",
  ]);
  for (const row of rows.filter(row => row.event !== "session_close")) {
    assert.equal(row.message, CUSTOM_MESSAGE_26);
  }
  const payloadHex = [...Buffer.from(CUSTOM_MESSAGE_26, "ascii")]
    .map(byte => byte.toString(16).padStart(2, "0")).join(" ");
  assert.match(rows[0]!.detail!, new RegExp(`frame fe fe 94 e0 17 ${payloadHex} fd`));
  assert.match(rows[1]!.detail!, /outcome=ack_observed/);

  let opens = 0;
  assert.equal(await runCwTrial(f.args(), {
    io,
    createTransport: async () => { opens += 1; return f.transport; },
  }), 3, f.output.join("\n"));
  assert.equal(opens, 0);
});

test("30-byte Command 17 payload is acknowledged through the default simulator", async t => {
  // Regression: a 30-byte payload needs a 36-byte frame. The original
  // 32-byte parser bound dropped this request without acknowledging it.
  const f = await fixture(t);
  assert.equal(await runCwTrial(f.args(CUSTOM_MESSAGE, CUSTOM_MESSAGE), {
    io: nonInteractiveIo(f.output),
    createTransport: async () => f.transport,
  }), 0, f.output.join("\n"));
  const command17 = f.messages();
  assert.equal(command17.length, 2);
  assert.deepEqual(payload(command17[0]!), [...Buffer.from(CUSTOM_MESSAGE, "ascii")]);
  assert.deepEqual(payload(command17[1]!), [0xff]);
  const rows = await (await CwTrialRecordStore.open(f.directory)).readAll();
  assert.deepEqual(rows.map(row => row.event), [
    "intent", "send_result", "stop_intent", "stop_result", "session_close",
  ]);
  for (const row of rows.filter(row => row.event !== "session_close")) {
    assert.equal(row.message, CUSTOM_MESSAGE);
  }
});

test("custom message confirmation mismatch sends zero Command 17 frames and writes no intent", async t => {
  const f = await fixture(t);
  assert.equal(await runCwTrial(f.args("CQ TEST"), {
    io: nonInteractiveIo(f.output),
    createTransport: async () => f.transport,
  }), 3, f.output.join("\n"));
  assert.equal(f.messages().length, 0);
  assert.equal(f.transport.closed, true);
  const rows = await (await CwTrialRecordStore.open(f.directory)).readAll();
  // The session was opened, so its close is still recorded; nothing was sent.
  assert.deepEqual(rows.map(row => row.event), ["session_close"]);
  assert.equal(rows.some(row => row.event === "intent"), false);
});

test("real TTY branch with injected simulator sends custom payload once and never opens the configured serial port", async t => {
  const f = await fixture(t);
  const answers = [CUSTOM_MESSAGE_26, "S", "Q"];
  const prompts: string[] = [];
  let transports = 0;
  const io = {
    isTTY: true,
    write: (line: string) => { f.output.push(line); },
    prompt: async (question: string): Promise<string> => {
      prompts.push(question);
      const answer = answers.shift();
      assert.notEqual(answer, undefined);
      return answer!;
    },
  };
  assert.equal(await runCwTrial([
    "--port", "NEVER-OPEN-CW-CUSTOM",
    "--confirm-keying-off",
    "--message", CUSTOM_MESSAGE_26,
    "--record-dir", f.directory,
    "--timeout-ms", "200",
  ], {
    io,
    createTransport: async () => { transports += 1; return f.transport; },
  }), 0, f.output.join("\n"));

  assert.equal(transports, 1);
  assert.equal(answers.length, 0);
  assert.equal(prompts.length, 3);
  assert.match(prompts[0]!, /CQ TEST 0123456789/);
  assert.match(prompts[1]!, /S=stop/);
  assert.match(prompts[2]!, /S=stop/);

  const command17 = f.messages();
  assert.equal(command17.length, 2);
  assert.deepEqual(payload(command17[0]!), [...Buffer.from(CUSTOM_MESSAGE_26, "ascii")]);
  assert.deepEqual(payload(command17[1]!), [0xff]);
  assert.equal(f.transport.requests.filter(bytes => bytes[4] !== 0x17).length, 16);
  assert.equal(f.transport.closed, true);
  const rows = await (await CwTrialRecordStore.open(f.directory)).readAll();
  assert.deepEqual(rows.map(row => row.event), [
    "intent", "send_result", "stop_intent", "stop_result", "session_close",
  ]);
  for (const row of rows.filter(row => row.event !== "session_close")) {
    assert.equal(row.message, CUSTOM_MESSAGE_26);
  }
});

test("cancellation during custom intent flush sends zero Command 17 frames and leaves unresolved intent", async t => {
  const f = await fixture(t);
  const store = await CwTrialRecordStore.open(f.directory);
  const append = store.append.bind(store);
  const abort = new AbortController();
  store.append = async input => {
    const row = await append(input);
    if (input.event === "intent") abort.abort();
    return row;
  };
  assert.equal(await runCwTrial(f.args(), {
    io: nonInteractiveIo(f.output),
    signal: abort.signal,
    openStore: async () => store,
    createTransport: async () => f.transport,
  }), 1, f.output.join("\n"));
  assert.equal(f.messages().length, 0);
  assert.equal(f.transport.closed, true);
  assert.equal(await store.hasUnresolvedIntent(), true);
});

test("custom intent persistence failure sends zero Command 17 frames and no stop", async t => {
  const f = await fixture(t);
  const store = await CwTrialRecordStore.open(f.directory);
  const append = store.append.bind(store);
  store.append = async input => {
    if (input.event === "intent") throw new Error("injected intent persistence failure");
    return append(input);
  };
  assert.equal(await runCwTrial(f.args(), {
    io: nonInteractiveIo(f.output),
    openStore: async () => store,
    createTransport: async () => f.transport,
  }), 1, f.output.join("\n"));
  assert.equal(f.messages().length, 0);
  assert.equal(f.transport.closed, true);
  assert.doesNotMatch(f.output.join("\n"), /stop outcome/);
  assert.equal(await store.hasUnresolvedIntent(), false);
});

test("legacy E and TEST intents keep their digest and remain manually reviewable without a transport", async t => {
  const directory = await mkdtemp(join(tmpdir(), "cw-custom-message-legacy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const legacy = [
    {
      id: "legacy-e-intent",
      at: "2026-10-14T15:20:55.098Z",
      message: "E",
      detail: "legacy E intent",
      digest: "088a82ac9d96047b0fa52b05e70dc6e1c4512a449bb786f92904b47f54d7d82a",
    },
    {
      id: "legacy-test-intent",
      at: "2026-10-14T15:21:55.098Z",
      message: "TEST",
      detail: "legacy TEST intent",
      digest: "2c046329879ac2ee05c5bd464ecf3e879b755bc4026055e8a30c049a92e6978a",
    },
  ] as const;
  const records = legacy.map(item => ({
    schemaVersion: 1,
    id: item.id,
    sessionId: "legacy-session",
    at: item.at,
    event: "intent",
    message: item.message,
    contextFingerprint: null,
    detail: item.detail,
  }));
  const file = join(directory, "cw-trial-intent.jsonl");
  await writeFile(file, `${records.map(record => JSON.stringify(record)).join("\n")}\n`, "utf8");

  const store = await CwTrialRecordStore.open(directory);
  const scan = await store.scan();
  assert.equal(scan.corrupted, false);
  assert.deepEqual(scan.records.map(record => record.message), ["E", "TEST"]);
  for (const item of legacy) {
    const record = scan.records.find(row => row.id === item.id);
    assert.notEqual(record, undefined);
    assert.equal(cwTrialIntentDigest(record!), item.digest);
  }

  const original = await readFile(file, "utf8");
  let transports = 0;
  for (const item of legacy) {
    const prompts: string[] = [];
    assert.equal(await runCwTrial([
      "--review-intent", item.id,
      "--operator", "test operator",
      "--note", "isolated legacy fixture; no radio",
      "--record-dir", directory,
    ], {
      io: {
        isTTY: true,
        write: () => undefined,
        prompt: async (question: string): Promise<string> => {
          prompts.push(question);
          return `REVIEW ${item.id} ${item.digest}`;
        },
      },
      createTransport: async () => { transports += 1; throw new Error("review must not open a transport"); },
    }), 0);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0]!, /personally checked/);
  }
  assert.equal(transports, 0);
  assert.equal((await readFile(file, "utf8")).startsWith(original), true);

  const rows = await store.readAll();
  assert.deepEqual(rows.map(row => row.event), [
    "intent", "intent", "intent_review", "intent_review",
  ]);
  assert.deepEqual(rows.filter(row => row.event === "intent").map(row => row.message), ["E", "TEST"]);
  assert.equal(rows[2]!.schemaVersion, 2);
  assert.equal(rows[3]!.schemaVersion, 2);
  assert.equal(await store.hasUnresolvedIntent(), false);
});
