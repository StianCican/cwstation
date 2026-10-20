import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCwTrial } from "../apps/rig-cw-trial.js";
import { CwTrialRecordStore, createCwTrialSimulatorTransport } from "../packages/cw-trial/src/index.js";

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
