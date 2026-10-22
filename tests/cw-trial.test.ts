import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCwTrial } from "../apps/rig-cw-trial.js";
import { CwTrialRecordStore, createCwTrialSimulatorTransport } from "../packages/cw-trial/src/index.js";
import { ReplyDispatchControl } from "../apps/reply-dispatch-control.js";

async function fixture(t: TestContext, ack: "ok" | "ng" | "none" = "ok") {
  const directory = await mkdtemp(join(tmpdir(), "cw-trial-test-"));
  const transport = createCwTrialSimulatorTransport({ ack });
  const output: string[] = [];
  t.after(async () => { await transport.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    directory, transport, output,
    args: ["--simulate", "--simulate-confirm", "E", "--record-dir", directory, "--timeout-ms", "200"],
    deps: { io: { isTTY: false, write: (line: string) => { output.push(line); },
      prompt: async (_question: string) => "E" }, createTransport: async () => transport },
    messages: () => transport.requests.filter(bytes => bytes[4] === 0x17),
  };
}

test("selected trial path uses one transport, rereads, sends once, stops and retains unresolved intent", async t => {
  const f = await fixture(t);
  assert.equal(await runCwTrial(f.args, f.deps), 0);
  assert.equal(f.transport.requests.filter(bytes => bytes[4] !== 0x17).length, 16);
  assert.deepEqual(f.messages().map(bytes => [...bytes.slice(5, -1)]), [[0x45], [0xff]]);
  assert.equal(f.transport.closed, true);
  const store = await CwTrialRecordStore.open(f.directory);
  const rows = await store.readAll();
  assert.deepEqual(rows.map(row => row.event), ["intent", "send_result", "stop_intent", "stop_result", "session_close"]);
  assert.match(rows.at(-1)!.detail!, /closeConfirmed=true/);
  let opens = 0;
  assert.equal(await runCwTrial(f.args, { ...f.deps, createTransport: async () => { opens++; return f.transport; } }), 3);
  assert.equal(opens, 0);
});

test("trial without explicit simulation confirmation reads but never sends", async t => {
  const f = await fixture(t);
  assert.equal(await runCwTrial(["--simulate", "--record-dir", f.directory], f.deps), 3);
  assert.equal(f.messages().length, 0);
  assert.equal(f.transport.closed, true);
});

test("trial real mode without TTY refuses before opening records or transport", async t => {
  const f = await fixture(t); let opens = 0;
  const rejectOpen = async (): Promise<never> => { opens++; throw new Error("must not open"); };
  assert.equal(await runCwTrial(["--port", "NEVER-OPEN", "--confirm-keying-off"], {
    ...f.deps, openStore: rejectOpen, createTransport: rejectOpen,
  }), 2);
  assert.equal(opens, 0);
});

test("trial preflight refuses incompatible mode without command 17", async t => {
  const f = await fixture(t), incompatible = createCwTrialSimulatorTransport({ mode: "USB" });
  assert.equal(await runCwTrial(f.args, { ...f.deps, createTransport: async () => incompatible }), 4);
  assert.equal(incompatible.requests.some(bytes => bytes[4] === 0x17), false);
  assert.equal(incompatible.closed, true);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) test(`trial ${signal} during intent flush cannot dispatch`, async t => {
  const f = await fixture(t);
  const store = await CwTrialRecordStore.open(f.directory), append = store.append.bind(store);
  store.append = async input => { const row = await append(input); if (input.event === "intent") process.emit(signal); return row; };
  const before = process.listenerCount(signal);
  assert.notEqual(await runCwTrial(f.args, { ...f.deps, openStore: async () => store }), 0);
  assert.equal(f.messages().length, 0);
  assert.equal(f.transport.closed, true);
  assert.equal(await store.hasUnresolvedIntent(), true);
  assert.equal(process.listenerCount(signal), before);
});

test("trial interrupt during real confirmation cannot be overridden by typed text", async t => {
  const f = await fixture(t);
  // Only the CLI's real confirmation branch is exercised; transport remains injected memory simulation.
  const args = ["--port", "NEVER-OPEN", "--confirm-keying-off", "--record-dir", f.directory];
  const io = { ...f.deps.io, isTTY: true, prompt: async () => { process.emit("SIGINT"); return "E"; } };
  assert.notEqual(await runCwTrial(args, { ...f.deps, io }), 0);
  assert.equal(f.messages().length, 0);
  assert.equal(f.transport.closed, true);
});

test("trial intent persistence failure prevents send and still closes transport", async t => {
  const f = await fixture(t), store = await CwTrialRecordStore.open(f.directory), append = store.append.bind(store);
  store.append = async input => { if (input.event === "intent") throw new Error("disk failure"); return append(input); };
  assert.equal(await runCwTrial(f.args, { ...f.deps, openStore: async () => store }), 1);
  assert.equal(f.messages().length, 0);
  assert.equal(f.transport.closed, true);
  assert.doesNotMatch(f.output.join("\n"), /stop outcome/);
});

test("trial input closure during intent flush cannot dispatch after confirmation", async t => {
  const f = await fixture(t), input = new AbortController();
  const store = await CwTrialRecordStore.open(f.directory), append = store.append.bind(store);
  store.append = async row => { const result = await append(row); if (row.event === "intent") input.abort(); return result; };
  assert.equal(await runCwTrial(f.args, { ...f.deps,
    io: { ...f.deps.io, signal: input.signal }, openStore: async () => store,
  }), 1);
  assert.equal(f.messages().length, 0);
  assert.equal(f.transport.closed, true);
  assert.equal(await store.hasUnresolvedIntent(), true);
});

test("trial unconfirmed close overrides successful acknowledgement with exit 6", async t => {
  const f = await fixture(t), close = f.transport.close.bind(f.transport);
  const transport = { ...f.transport, close: async () => { await close(); throw new Error("close unconfirmed"); } };
  assert.equal(await runCwTrial(f.args, { ...f.deps, createTransport: async () => transport }), 6);
  assert.equal(f.messages().length, 2);
  assert.match(f.output.join("\n"), /close error/);
});

test("trial close record failure returns nonzero despite confirmed port release", async t => {
  const f = await fixture(t), store = await CwTrialRecordStore.open(f.directory), append = store.append.bind(store);
  store.append = async input => { if (input.event === "session_close") throw new Error("close record failure"); return append(input); };
  assert.equal(await runCwTrial(f.args, { ...f.deps, openStore: async () => store }), 1);
  assert.equal(f.transport.closed, true);
});

for (const ack of ["ng", "none"] as const) test(`trial ${ack} acknowledgement returns exit 7 and keeps unknown intent`, async t => {
  const f = await fixture(t, ack);
  assert.equal(await runCwTrial(f.args, f.deps), 7);
  assert.equal(f.messages().length, 2);
  assert.equal(f.transport.closed, true);
  assert.equal(await (await CwTrialRecordStore.open(f.directory)).hasUnresolvedIntent(), true);
});

test("trial send_result record failure still attempts one best-effort stop and stays nonzero", async t => {
  const f = await fixture(t), store = await CwTrialRecordStore.open(f.directory), append = store.append.bind(store);
  store.append = async input => {
    if (input.event === "send_result") throw new Error("send result disk failure");
    return append(input);
  };
  assert.equal(await runCwTrial(f.args, { ...f.deps, openStore: async () => store }), 1);
  assert.deepEqual(f.messages().map(bytes => [...bytes.slice(5, -1)]), [[0x45], [0xff]]);
  assert.equal(f.transport.closed, true);
  assert.match(f.output.join("\n"), /send result record failed/);
  assert.equal(await store.hasUnresolvedIntent(), true);
  let opens = 0;
  assert.equal(await runCwTrial(f.args, {
    ...f.deps, createTransport: async () => { opens++; return f.transport; },
  }), 3);
  assert.equal(opens, 0);
});

test("trial stop_intent record failure still attempts one best-effort stop and stays nonzero", async t => {
  const f = await fixture(t), store = await CwTrialRecordStore.open(f.directory), append = store.append.bind(store);
  store.append = async input => {
    if (input.event === "stop_intent") throw new Error("stop intent disk failure");
    return append(input);
  };
  assert.equal(await runCwTrial(f.args, { ...f.deps, openStore: async () => store }), 1);
  assert.deepEqual(f.messages().map(bytes => [...bytes.slice(5, -1)]), [[0x45], [0xff]]);
  assert.equal(f.transport.closed, true);
  assert.match(f.output.join("\n"), /stop intent record failed/);
  assert.deepEqual((await store.readAll()).map(row => row.event), [
    "intent", "send_result", "stop_result", "session_close",
  ]);
});

test("trial stop_result record failure keeps the single stop and returns nonzero", async t => {
  const f = await fixture(t), store = await CwTrialRecordStore.open(f.directory), append = store.append.bind(store);
  store.append = async input => {
    if (input.event === "stop_result") throw new Error("stop result disk failure");
    return append(input);
  };
  assert.equal(await runCwTrial(f.args, { ...f.deps, openStore: async () => store }), 1);
  assert.deepEqual(f.messages().map(bytes => [...bytes.slice(5, -1)]), [[0x45], [0xff]]);
  assert.equal(f.transport.closed, true);
  assert.match(f.output.join("\n"), /stop result record failed/);
  assert.deepEqual((await store.readAll()).map(row => row.event), [
    "intent", "send_result", "stop_intent", "session_close",
  ]);
});

test("trial stop write failure keeps nonzero and does not retry the stop", async t => {
  const f = await fixture(t);
  let stopWrites = 0;
  const transport = {
    ...f.transport,
    write: async (bytes: Uint8Array) => {
      if (bytes[4] === 0x17 && bytes[5] === 0xff) {
        stopWrites += 1;
        throw new Error("stop write failed");
      }
      return f.transport.write(bytes);
    },
  };
  assert.equal(await runCwTrial(f.args, { ...f.deps, createTransport: async () => transport }), 7);
  assert.equal(stopWrites, 1);
  assert.equal(f.transport.closed, true);
  assert.match(f.output.join("\n"), /stop outcome=write_failed/);
});

test("trial close failure still wins exit 6 after a post-send record failure", async t => {
  const f = await fixture(t), store = await CwTrialRecordStore.open(f.directory), append = store.append.bind(store);
  store.append = async input => {
    if (input.event === "send_result") throw new Error("send result disk failure");
    return append(input);
  };
  const close = f.transport.close.bind(f.transport);
  const transport = { ...f.transport, close: async () => { await close(); throw new Error("close unconfirmed"); } };
  assert.equal(await runCwTrial(f.args, {
    ...f.deps, openStore: async () => store, createTransport: async () => transport,
  }), 6);
  assert.deepEqual(f.messages().map(bytes => [...bytes.slice(5, -1)]), [[0x45], [0xff]]);
  assert.match(f.output.join("\n"), /close error/);
});

test("trial exception after send still stops before closing", async t => {
  const f = await fixture(t);
  let failed = false;
  const io = { ...f.deps.io, write: (line: string) => {
    if (!failed && line.startsWith("cw-trial: send outcome=")) {
      failed = true;
      throw new Error("output failure after send");
    }
    f.output.push(line);
  } };
  assert.equal(await runCwTrial(f.args, { ...f.deps, io }), 1);
  assert.deepEqual(f.messages().map(bytes => [...bytes.slice(5, -1)]), [[0x45], [0xff]]);
  assert.equal(f.transport.closed, true);
  assert.equal(await (await CwTrialRecordStore.open(f.directory)).hasUnresolvedIntent(), true);
});

test("trial repeated operator stop after record failure never writes a second stop", async t => {
  const f = await fixture(t), store = await CwTrialRecordStore.open(f.directory), append = store.append.bind(store);
  store.append = async input => {
    if (input.event === "stop_intent" || input.event === "stop_result") throw new Error("disk failure");
    return append(input);
  };
  const inputs = ["E", "S", "S", "Q"];
  const io = { ...f.deps.io, isTTY: true, prompt: async () => {
    const input = inputs.shift();
    assert.notEqual(input, undefined);
    return input!;
  } };
  assert.equal(await runCwTrial(["--port", "NEVER-OPEN", "--confirm-keying-off", "--record-dir", f.directory], {
    ...f.deps, io, openStore: async () => store,
  }), 1);
  assert.equal(inputs.length, 0);
  assert.deepEqual(f.messages().map(bytes => [...bytes.slice(5, -1)]), [[0x45], [0xff]]);
  assert.equal(f.transport.closed, true);
});

test("trial stop record diagnostic failure cannot suppress the stop or its result record", async t => {
  const f = await fixture(t), store = await CwTrialRecordStore.open(f.directory), append = store.append.bind(store);
  store.append = async input => {
    if (input.event === "stop_intent") throw new Error("disk failure");
    return append(input);
  };
  const io = { ...f.deps.io, write: (line: string) => {
    if (line.startsWith("cw-trial: stop intent record failed:")) throw new Error("diagnostic output failure");
    f.output.push(line);
  } };
  assert.equal(await runCwTrial(f.args, { ...f.deps, io, openStore: async () => store }), 1);
  assert.deepEqual(f.messages().map(bytes => [...bytes.slice(5, -1)]), [[0x45], [0xff]]);
  assert.deepEqual((await store.readAll()).map(row => row.event), ["intent", "send_result", "stop_result", "session_close"]);
  assert.equal(f.transport.closed, true);
});

test("trial stop outcome output failure cannot suppress its result record", async t => {
  const f = await fixture(t);
  const io = { ...f.deps.io, write: (line: string) => {
    if (line.startsWith("cw-trial: stop outcome=")) throw new Error("stop output failure");
    f.output.push(line);
  } };
  assert.equal(await runCwTrial(f.args, { ...f.deps, io }), 1);
  assert.deepEqual(f.messages().map(bytes => [...bytes.slice(5, -1)]), [[0x45], [0xff]]);
  assert.equal((await (await CwTrialRecordStore.open(f.directory)).readAll()).filter(row => row.event === "stop_result").length, 1);
  assert.equal(f.transport.closed, true);
});

test("trial record failure takes precedence over missing acknowledgements without resolving intent", async t => {
  const f = await fixture(t, "none"), store = await CwTrialRecordStore.open(f.directory), append = store.append.bind(store);
  store.append = async input => {
    if (input.event === "stop_result") throw new Error("stop result disk failure");
    return append(input);
  };
  assert.equal(await runCwTrial(f.args, { ...f.deps, openStore: async () => store }), 1);
  assert.deepEqual(f.messages().map(bytes => [...bytes.slice(5, -1)]), [[0x45], [0xff]]);
  assert.match(f.output.join("\n"), /stop outcome=timeout/);
  assert.equal(await store.hasUnresolvedIntent(), true);
  assert.equal(f.transport.closed, true);
});

// ── V00-03-B 回复提案绑定 ───────────────────────────────────────────────

const REPLY_TEXT = "B2BB DE B1AA K";
const REPLY_BINDING = {
  text: REPLY_TEXT,
  sessionId: "reply-session-1",
  turnId: "reply-session-1:turn-1",
  revision: 3,
  isCurrent: () => true,
} as const;

test("reply validity is rechecked after intent fsync and keeps the unresolved intent", async t => {
  const f = await fixture(t);
  let current = true;
  const store = await CwTrialRecordStore.open(f.directory);
  const append = store.append.bind(store);
  store.append = async row => {
    const result = await append(row);
    if (row.event === "intent") current = false;
    return result;
  };
  assert.equal(await runCwTrial(replyArgs(f.directory), {
    ...f.deps,
    io: { ...f.deps.io, isTTY: true, prompt: async () => REPLY_TEXT },
    replyProposal: { ...REPLY_BINDING, isCurrent: () => current },
    openStore: async () => store,
  }), 1);
  assert.equal(f.messages().length, 0);
  assert.equal(f.transport.closed, true);
  assert.equal(await store.hasUnresolvedIntent(), true);
  let opens = 0;
  assert.equal(await runCwTrial(replyArgs(f.directory), {
    ...f.deps,
    io: { ...f.deps.io, isTTY: true, prompt: async () => REPLY_TEXT },
    replyProposal: REPLY_BINDING,
    createTransport: async () => { opens++; return f.transport; },
  }), 3);
  assert.equal(opens, 0);
});

function replyArgs(directory: string): string[] {
  return ["--simulate", "--record-dir", directory, "--timeout-ms", "200"];
}

test("desktop exact-text confirmation uses the original reread, intent, send and stop path without TTY", async t => {
  const f = await fixture(t);
  let confirmations = 0;
  assert.equal(await runCwTrial(replyArgs(f.directory), {
    ...f.deps, replyProposal: REPLY_BINDING,
    io: { ...f.deps.io, prompt: async () => { throw new Error("must not prompt a TTY"); } },
    confirmSimulatedReply: async text => {
      confirmations++;
      assert.equal(text, REPLY_TEXT);
      assert.equal(f.transport.requests.length, 8);
      return text;
    },
  }), 0);
  assert.equal(confirmations, 1);
  assert.equal(f.transport.requests.filter(bytes => bytes[4] !== 0x17).length, 16);
  assert.deepEqual(f.messages().map(bytes => [...bytes.slice(5, -1)]), [[...Buffer.from(REPLY_TEXT)], [0xff]]);
  assert.deepEqual((await (await CwTrialRecordStore.open(f.directory)).readAll()).map(row => row.event),
    ["intent", "send_result", "stop_intent", "stop_result", "session_close"]);
});

for (const answer of [null, "WRONG"]) test(`desktop confirmation ${answer} cannot dispatch`, async t => {
  const f = await fixture(t);
  assert.notEqual(await runCwTrial(replyArgs(f.directory), {
    ...f.deps, replyProposal: REPLY_BINDING, confirmSimulatedReply: async () => answer,
  }), 0);
  assert.equal(f.messages().length, 0);
  assert.equal(f.transport.closed, true);
});

test("desktop confirmation refuses real mode, missing binding and automatic dispatch before opening anything", async t => {
  const f = await fixture(t);
  const control = new ReplyDispatchControl(); control.enableAutomatic();
  let opens = 0;
  const rejectOpen = async (): Promise<never> => { opens++; throw new Error("must not open"); };
  const base = { ...f.deps, openStore: rejectOpen, createTransport: rejectOpen,
    confirmSimulatedReply: async () => REPLY_TEXT };
  assert.equal(await runCwTrial(["--port", "NEVER-OPEN", "--confirm-keying-off"],
    { ...base, replyProposal: REPLY_BINDING }), 2);
  assert.equal(await runCwTrial(replyArgs(f.directory), base), 2);
  assert.equal(await runCwTrial(replyArgs(f.directory),
    { ...base, replyProposal: REPLY_BINDING, replyDispatch: control }), 2);
  assert.equal(opens, 0);
});

test("desktop cancellation interrupts a pending human confirmation and releases transport", async t => {
  const f = await fixture(t), controller = new AbortController();
  const before = process.listenerCount("SIGINT");
  assert.notEqual(await runCwTrial(replyArgs(f.directory), {
    ...f.deps, signal: controller.signal, replyProposal: REPLY_BINDING,
    confirmSimulatedReply: () => { controller.abort(); return new Promise(() => {}); },
  }), 0);
  assert.equal(f.messages().length, 0);
  assert.equal(f.transport.closed, true);
  assert.equal(process.listenerCount("SIGINT"), before);
});

test("desktop confirmation cannot revive a binding invalidated during intent flush", async t => {
  const f = await fixture(t), store = await CwTrialRecordStore.open(f.directory);
  let current = true;
  const append = store.append.bind(store);
  store.append = async row => { const result = await append(row); if (row.event === "intent") current = false; return result; };
  assert.notEqual(await runCwTrial(replyArgs(f.directory), {
    ...f.deps, openStore: async () => store,
    replyProposal: { ...REPLY_BINDING, isCurrent: () => current }, confirmSimulatedReply: async text => text,
  }), 0);
  assert.equal(f.messages().length, 0);
  assert.equal(await store.hasUnresolvedIntent(), true);
});

test("reply proposal binding sends the exact text once and records null message with identity", async t => {
  const f = await fixture(t);
  const prompts: string[] = [];
  const io = { ...f.deps.io, isTTY: true, prompt: async (question: string) => {
    prompts.push(question);
    return REPLY_TEXT;
  } };
  assert.equal(await runCwTrial(replyArgs(f.directory), {
    ...f.deps, io, replyProposal: REPLY_BINDING,
  }), 0);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0]!, /B2BB DE B1AA K/);
  assert.equal(f.transport.requests.filter(bytes => bytes[4] !== 0x17).length, 16);
  assert.deepEqual(f.messages().map(bytes => [...bytes.slice(5, -1)]), [
    [...Buffer.from(REPLY_TEXT, "ascii")], [0xff],
  ]);
  assert.equal(f.transport.closed, true);
  const rows = await (await CwTrialRecordStore.open(f.directory)).readAll();
  assert.deepEqual(rows.map(row => row.event), ["intent", "send_result", "stop_intent", "stop_result", "session_close"]);
  for (const row of rows.filter(row => row.event !== "session_close")) {
    assert.equal(row.message, null, "AI text must not widen the record message whitelist");
    assert.match(row.detail!, /B2BB DE B1AA K/);
    assert.match(row.detail!, /reply-session-1/);
    assert.match(row.detail!, /reply-session-1:turn-1/);
    assert.match(row.detail!, /"revision":3/);
  }
});

test("reply proposal binding refuses non-TTY and automatic confirmation before opening transport", async t => {
  const f = await fixture(t);
  let opens = 0;
  const createTransport = async () => { opens += 1; return f.transport; };
  assert.equal(await runCwTrial(replyArgs(f.directory), {
    ...f.deps,
    io: { ...f.deps.io, isTTY: false, prompt: async () => REPLY_TEXT },
    replyProposal: REPLY_BINDING,
    createTransport,
  }), 2);
  assert.equal(opens, 0);
  assert.equal(await runCwTrial(["--simulate", "--simulate-confirm", REPLY_TEXT, "--record-dir", f.directory], {
    ...f.deps,
    io: { ...f.deps.io, isTTY: true },
    replyProposal: REPLY_BINDING,
    createTransport,
  }), 2);
  assert.equal(opens, 0);
  assert.equal(f.messages().length, 0);
});

test("reply proposal binding cannot enter the real path or use an invalid identity", async t => {
  const f = await fixture(t);
  let opens = 0;
  const rejectOpen = async (): Promise<never> => { opens += 1; throw new Error("must not open"); };
  assert.equal(await runCwTrial(["--port", "NEVER-OPEN", "--confirm-keying-off", "--record-dir", f.directory], {
    ...f.deps,
    io: { ...f.deps.io, isTTY: true, prompt: async () => REPLY_TEXT },
    replyProposal: REPLY_BINDING,
    openStore: rejectOpen,
    createTransport: rejectOpen,
  }), 2);
  assert.equal(opens, 0);
  for (const invalid of [
    { ...REPLY_BINDING, text: "bad lower" },
    { ...REPLY_BINDING, text: "CQ ^" },
    { ...REPLY_BINDING, sessionId: "" },
    { ...REPLY_BINDING, revision: 0 },
  ]) {
    assert.equal(await runCwTrial(replyArgs(f.directory), {
      ...f.deps,
      io: { ...f.deps.io, isTTY: true, prompt: async () => invalid.text },
      replyProposal: invalid,
      createTransport: rejectOpen,
    }), 2);
  }
  assert.equal(opens, 0);
  assert.equal(f.messages().length, 0);
});

test("reply proposal wrong typed text and intent cancellation both dispatch nothing", async t => {
  const f = await fixture(t);
  assert.equal(await runCwTrial(replyArgs(f.directory), {
    ...f.deps,
    io: { ...f.deps.io, isTTY: true, prompt: async () => `${REPLY_TEXT} X` },
    replyProposal: REPLY_BINDING,
  }), 3);
  assert.equal(f.messages().length, 0);

  const input = new AbortController();
  const secondTransport = createCwTrialSimulatorTransport();
  t.after(async () => { await secondTransport.close(); });
  const store = await CwTrialRecordStore.open(f.directory);
  const append = store.append.bind(store);
  store.append = async row => {
    const result = await append(row);
    if (row.event === "intent") input.abort();
    return result;
  };
  assert.equal(await runCwTrial(replyArgs(f.directory), {
    ...f.deps,
    io: { ...f.deps.io, isTTY: true, signal: input.signal, prompt: async () => REPLY_TEXT },
    openStore: async () => store,
    createTransport: async () => secondTransport,
    replyProposal: REPLY_BINDING,
  }), 1);
  assert.equal(secondTransport.requests.filter(bytes => bytes[4] === 0x17).length, 0);
  assert.equal(await store.hasUnresolvedIntent(), true);
});

test("reply EDIT loses dispatch permission on stale context but retains the edited draft", async t => {
  const f = await fixture(t);
  let current = true;
  let prompts = 0;
  const edited = "B2BB DE B1AA R";
  assert.equal(await runCwTrial(replyArgs(f.directory), {
    ...f.deps,
    io: { ...f.deps.io, isTTY: true, prompt: async () => {
      prompts += 1;
      if (prompts === 1) return `EDIT ${edited}`;
      current = false;
      return edited;
    } },
    replyProposal: { ...REPLY_BINDING, isCurrent: () => current },
  }), 1);
  assert.equal(f.messages().length, 0);
  assert.match(f.output.join("\n"), /reply draft retained: "B2BB DE B1AA R"/);
  const rows = await (await CwTrialRecordStore.open(f.directory)).readAll();
  assert.equal(rows.some(row => row.event === "intent"), false);
});

test("reply EDIT post-send record failure retains the draft without falsely denying dispatch", async t => {
  const f = await fixture(t);
  const store = await CwTrialRecordStore.open(f.directory);
  const append = store.append.bind(store);
  store.append = async row => {
    if (row.event === "send_result") throw new Error("record failure after dispatch");
    return append(row);
  };
  assert.equal(await runCwTrial(replyArgs(f.directory), {
    ...f.deps, io: { ...f.deps.io, isTTY: true, prompt: async () => REPLY_TEXT },
    openStore: async () => store, replyProposal: REPLY_BINDING,
  }), 1);
  assert.deepEqual(f.messages().map(bytes => [...bytes.slice(5, -1)]), [
    [...Buffer.from(REPLY_TEXT, "ascii")], [0xff],
  ]);
  assert.match(f.output.join("\n"), /reply draft retained:/);
  assert.doesNotMatch(f.output.join("\n"), /was not sent/);
  assert.equal(await store.hasUnresolvedIntent(), true);
});

test("reply EDIT keeps a runner-local draft, revalidates and sends only the reconfirmed final text", async t => {
  const f = await fixture(t);
  const edited = "B2BB DE B1AA R";
  const prompts: string[] = [];
  const lines: string[] = [];
  const io = { ...f.deps.io, isTTY: true, write: (line: string) => { lines.push(line); },
    prompt: async (question: string) => {
      prompts.push(question);
      if (prompts.length === 1) return `EDIT ${edited}`;
      return edited;
    } };
  assert.equal(await runCwTrial(replyArgs(f.directory), {
    ...f.deps, io, replyProposal: REPLY_BINDING,
  }), 0);
  assert.equal(prompts.length, 2);
  assert.match(prompts[0]!, /B2BB DE B1AA K/);
  assert.match(prompts[1]!, /B2BB DE B1AA R/);
  assert.ok(lines.some(line => /reply draft updated to "B2BB DE B1AA R"/.test(line)));
  assert.deepEqual(f.messages().map(bytes => [...bytes.slice(5, -1)]), [
    [...Buffer.from(edited, "ascii")], [0xff],
  ]);
  const rows = await (await CwTrialRecordStore.open(f.directory)).readAll();
  for (const row of rows.filter(row => row.event !== "session_close")) {
    assert.match(row.detail!, /B2BB DE B1AA R/);
    assert.match(row.detail!, /"edited":true/);
    assert.match(row.detail!, /"revision":3/);
  }

  const second = await fixture(t);
  const invalidPrompts: string[] = [];
  assert.equal(await runCwTrial(replyArgs(second.directory), {
    ...second.deps,
    io: { ...second.deps.io, isTTY: true, write: () => undefined, prompt: async (question: string) => {
      invalidPrompts.push(question);
      if (invalidPrompts.length === 1) return "EDIT bad lower";
      return REPLY_TEXT;
    } },
    replyProposal: REPLY_BINDING,
  }), 0);
  assert.ok(invalidPrompts.length === 2);
  assert.ok(invalidPrompts[1]!.includes(REPLY_TEXT), "invalid edit must keep the original visible draft");
  assert.deepEqual(second.messages().map(bytes => [...bytes.slice(5, -1)]), [
    [...Buffer.from(REPLY_TEXT, "ascii")], [0xff],
  ]);
});

// ── V00-04-A 会话级自动派发授权 ─────────────────────────────────────────

test("dispatch stop interrupts a pending manual prompt without intent or message", { timeout: 3000 }, async t => {
  const f = await fixture(t);
  const control = new ReplyDispatchControl();
  const code = await runCwTrial(replyArgs(f.directory), {
    ...f.deps, replyProposal: REPLY_BINDING, replyDispatch: control,
    io: { ...f.deps.io, isTTY: true, prompt: () => {
      control.stop();
      return new Promise<string>(() => {});
    } },
  });
  assert.equal(code, 1, f.output.join("\n"));
  assert.equal(f.messages().length, 0);
  assert.equal(f.transport.closed, true);
  assert.equal(await (await CwTrialRecordStore.open(f.directory)).hasUnresolvedIntent(), false);
});

test("automatic dispatch final diagnostic permits cancellation before consumption", async t => {
  for (const action of ["manual", "stop", "stale"] as const) {
    const f = await fixture(t);
    const control = new ReplyDispatchControl({ automatic: true });
    let current = true;
    const code = await runCwTrial(replyArgs(f.directory), {
      ...f.deps, replyProposal: { ...REPLY_BINDING, isCurrent: () => current }, replyDispatch: control,
      io: { ...f.deps.io, isTTY: true, write: line => {
        f.output.push(line);
        if (!line.includes("ready for one-time consumption")) return;
        if (action === "manual") control.requireManual();
        else if (action === "stop") control.stop();
        else current = false;
      } },
    });
    assert.notEqual(code, 0, action);
    assert.equal(f.messages().length, 0, action);
    assert.equal(f.transport.closed, true, action);
    assert.equal(await (await CwTrialRecordStore.open(f.directory)).hasUnresolvedIntent(), true, action);
  }
});

test("automatic reply dispatch skips the prompt, sends the exact text once and keeps the original records", async t => {
  const f = await fixture(t);
  const control = new ReplyDispatchControl({ automatic: true });
  let prompts = 0;
  const code = await runCwTrial(replyArgs(f.directory), {
    ...f.deps,
    io: { ...f.deps.io, isTTY: true, prompt: async () => {
      prompts += 1;
      throw new Error("automatic dispatch must not prompt");
    } },
    replyProposal: REPLY_BINDING,
    replyDispatch: control,
  });
  assert.equal(code, 0, f.output.join("\n"));
  assert.equal(prompts, 0);
  assert.equal(control.mode, "automatic");
  assert.equal(control.hasLease, false);
  assert.match(f.output.join("\n"), /automatic dispatch consumed once/);
  assert.equal(f.transport.requests.filter(bytes => bytes[4] !== 0x17).length, 16);
  assert.deepEqual(f.messages().map(bytes => [...bytes.slice(5, -1)]), [
    [...Buffer.from(REPLY_TEXT, "ascii")], [0xff],
  ]);
  assert.equal(f.transport.closed, true);
  const rows = await (await CwTrialRecordStore.open(f.directory)).readAll();
  assert.deepEqual(rows.map(row => row.event), ["intent", "send_result", "stop_intent", "stop_result", "session_close"]);
  for (const row of rows.filter(row => row.event !== "session_close")) {
    assert.equal(row.message, null);
    assert.match(row.detail!, /B2BB DE B1AA K/);
    assert.match(row.detail!, /reply-session-1:turn-1/);
    assert.match(row.detail!, /"revision":3/);
  }
});

test("automatic dispatch revoked after intent flush sends zero frames and retains the unresolved intent", async t => {
  const f = await fixture(t);
  const control = new ReplyDispatchControl({ automatic: true });
  const store = await CwTrialRecordStore.open(f.directory);
  const append = store.append.bind(store);
  store.append = async row => {
    const result = await append(row);
    if (row.event === "intent") control.revoke();
    return result;
  };
  const code = await runCwTrial(replyArgs(f.directory), {
    ...f.deps,
    io: { ...f.deps.io, isTTY: true, prompt: async () => {
      throw new Error("automatic dispatch must not prompt");
    } },
    replyProposal: REPLY_BINDING,
    replyDispatch: control,
    openStore: async () => store,
  });
  assert.equal(code, 3, f.output.join("\n"));
  assert.equal(f.messages().length, 0);
  assert.equal(f.transport.closed, true);
  assert.equal(await store.hasUnresolvedIntent(), true);
  assert.match(f.output.join("\n"), /authorization lost \(revoked\) after intent flush/);
});

test("switching back to manual during preflight revokes automatic dispatch before any query", async t => {
  const f = await fixture(t);
  const control = new ReplyDispatchControl({ automatic: true });
  const code = await runCwTrial(replyArgs(f.directory), {
    ...f.deps,
    io: { ...f.deps.io, isTTY: true, prompt: async () => {
      throw new Error("automatic dispatch must not prompt");
    } },
    replyProposal: REPLY_BINDING,
    replyDispatch: control,
    createTransport: async () => {
      control.requireManual();
      return f.transport;
    },
  });
  assert.equal(code, 3, f.output.join("\n"));
  assert.equal(f.transport.requests.length, 0);
  assert.equal(f.transport.closed, true);
  assert.match(f.output.join("\n"), /authorization lost \(manual\) after transport open/);
});

test("a manual dispatch control preserves the original full-text confirmation path", async t => {
  const f = await fixture(t);
  const control = new ReplyDispatchControl();
  const prompts: string[] = [];
  const code = await runCwTrial(replyArgs(f.directory), {
    ...f.deps,
    io: { ...f.deps.io, isTTY: true, prompt: async (question: string) => {
      prompts.push(question);
      return REPLY_TEXT;
    } },
    replyProposal: REPLY_BINDING,
    replyDispatch: control,
  });
  assert.equal(code, 0);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0]!, /B2BB DE B1AA K/);
  assert.equal(control.hasLease, false);
  assert.deepEqual(f.messages().map(bytes => [...bytes.slice(5, -1)]), [
    [...Buffer.from(REPLY_TEXT, "ascii")], [0xff],
  ]);
});

test("a dispatch control without a reply binding is refused before any transport", async t => {
  const f = await fixture(t);
  assert.equal(await runCwTrial(f.args, {
    ...f.deps,
    replyDispatch: new ReplyDispatchControl({ automatic: true }),
  }), 2);
  assert.equal(f.transport.requests.length, 0);
});

test("the same consumed proposal cannot be automatically dispatched by a second trial", async t => {
  const first = await fixture(t);
  const control = new ReplyDispatchControl({ automatic: true });
  assert.equal(await runCwTrial(replyArgs(first.directory), {
    ...first.deps,
    io: { ...first.deps.io, isTTY: true },
    replyProposal: REPLY_BINDING,
    replyDispatch: control,
  }), 0);

  const second = await fixture(t);
  assert.equal(await runCwTrial(replyArgs(second.directory), {
    ...second.deps,
    io: { ...second.deps.io, isTTY: true, prompt: async () => {
      throw new Error("a consumed proposal must not prompt or dispatch");
    } },
    replyProposal: REPLY_BINDING,
    replyDispatch: control,
  }), 3, second.output.join("\n"));
  assert.equal(second.messages().length, 0);
  assert.equal(second.transport.requests.length, 0);
  assert.match(second.output.join("\n"), /already_consumed/);
});
