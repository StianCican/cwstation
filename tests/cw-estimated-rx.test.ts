import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CwTrialSession, CwTrialRecordStore, createCwTrialSimulatorTransport,
  estimateCwTrialWindow } from "../packages/cw-trial/src/index.js";
import { parseCwTrialArgs, runCwTrial } from "../apps/rig-cw-trial.js";
import type { CivTransport } from "../packages/devices/src/civ.js";

test("estimate reuses exact Morse duration and refuses unsupported or altered text/speed", () => {
  assert.equal(estimateCwTrialWindow("E", 48), 532);
  assert.equal(estimateCwTrialWindow("TEST", 20), 2075); // 21 Morse units
  assert.ok(estimateCwTrialWindow("E E", 20) > estimateCwTrialWindow("EE", 20));
  for (const text of ["e", " E", "E  E", "E^", "E+", ""]) {
    assert.throws(() => estimateCwTrialWindow(text, 20));
  }
  for (const wpm of [0, 5, 49, 20.1, NaN]) assert.throws(() => estimateCwTrialWindow("E", wpm));
  assert.equal(parseCwTrialArgs(["--simulate"]).estimatedWpm, null);
  for (const value of ["0", "5", "49", "NaN", "20.1"]) {
    assert.throws(() => parseCwTrialArgs(["--simulate", "--estimated-wpm", value]));
  }
});

test("RX observation waits out estimate, resets on TX, retains the sent message and unknown result", async t => {
  const transport = createCwTrialSimulatorTransport({ chunkSize: 64, echo: false });
  const sampleTimes: number[] = [];
  let observe = false;
  const wrapped: CivTransport = {
    write: bytes => {
      if (observe && bytes[4] === 0x1c && bytes[5] === 0) sampleTimes.push(performance.now());
      return transport.write(bytes);
    }, close: () => transport.close(),
    onClose: handler => transport.onClose(handler),
    onData: handler => transport.onData(chunk => {
      const changed = Uint8Array.from(chunk);
      if (observe && changed[4] === 0x1c && changed[5] === 0 && sampleTimes.length === 5) changed[6] = 1;
      handler(changed);
    }),
  };
  const session = new CwTrialSession({ transport: wrapped });
  t.after(() => session.close());
  await session.readContext();
  await assert.rejects(session.waitEstimatedReceiveWindow("E", 48));
  await session.sendMessage("E");
  await assert.rejects(session.waitEstimatedReceiveWindow("TEST", 48));
  observe = true;
  const start = performance.now();
  const result = await session.waitEstimatedReceiveWindow("E", 48);
  assert.ok(sampleTimes[0]! - start >= 520);
  assert.ok(performance.now() - sampleTimes[0]! >= 600);
  assert.ok(sampleTimes.length >= 12, "TX sample must restart the RX stability window");
  assert.equal(result.outcome, "estimated_rx_window");
  assert.equal(result.completion, "unknown");
  assert.equal(transport.requests.filter(bytes => bytes[4] === 0x17).length, 1);
});

test("runner integrates estimate, records UNKNOWN, stops once and preserves unresolved intent", async t => {
  const directory = await mkdtemp(join(tmpdir(), "cw-estimated-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const transport = createCwTrialSimulatorTransport();
  const output: string[] = [];
  const result = await runCwTrial(["--simulate", "--simulate-confirm", "E", "--estimated-wpm", "48", "--record-dir", directory], {
    createTransport: async () => transport,
    io: { isTTY: false, write: line => output.push(line), prompt: async () => "E" },
  });
  assert.equal(result, 0);
  assert.match(output.join("\n"), /estimated_rx_window.*completion.*unknown/);
  assert.equal(transport.requests.filter(bytes => bytes[4] === 0x17).length, 2);
  const store = await CwTrialRecordStore.open(directory);
  assert.equal(await store.hasUnresolvedIntent(), true);
  const rows = await store.readAll();
  assert.equal(rows.length, 6);
  assert.match(rows[0]!.detail!, /estimatedWpm=48/);
  assert.match(rows[2]!.detail!, /handoff=estimated_rx_window; completion=unknown/);
  assert.equal(transport.closed, true);
});

for (const inputClosure of [false, true]) test(`cancellation during estimate stops without RX wait (input closure=${inputClosure})`, async t => {
  const directory = await mkdtemp(join(tmpdir(), "cw-estimated-cancel-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const transport = createCwTrialSimulatorTransport();
  const cancel = new AbortController();
  const output: string[] = [];
  const result = await runCwTrial(["--simulate", "--simulate-confirm", "E", "--estimated-wpm", "6", "--record-dir", directory], {
    createTransport: async () => transport,
    ...(!inputClosure ? { signal: cancel.signal } : {}),
    io: { isTTY: false, ...(inputClosure ? { signal: cancel.signal } : {}),
      write: line => { output.push(line); if (line.includes("estimated handoff waiting")) setTimeout(() => cancel.abort(), 50); }, prompt: async () => "E" },
  });
  assert.notEqual(result, 0);
  assert.doesNotMatch(output.join("\n"), /estimated_rx_window/);
  assert.equal(transport.requests.filter(bytes => bytes[4] === 0x17).length, 2);
  assert.equal(transport.requests.filter(bytes => bytes[4] !== 0x17).length, 16);
  assert.equal(transport.closed, true);
});

for (const status of ["TX", "silent"] as const) test(`post-send ${status} never reports a successful handoff`, async t => {
  const directory = await mkdtemp(join(tmpdir(), "cw-estimated-timeout-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const transport = createCwTrialSimulatorTransport({ chunkSize: 64, echo: false });
  let attempted = false;
  const wrapped: CivTransport = {
    write: bytes => { if (bytes[4] === 0x17) attempted = true; return transport.write(bytes); },
    close: () => transport.close(), onClose: listener => transport.onClose(listener),
    onData: listener => transport.onData(chunk => {
      if (attempted && chunk[4] === 0x1c && chunk[5] === 0) {
        if (status === "silent") return;
        const tx = Uint8Array.from(chunk); tx[6] = 1; listener(tx);
      } else listener(chunk);
    }),
  };
  const output: string[] = [];
  const result = await runCwTrial(["--simulate", "--simulate-confirm", "E", "--estimated-wpm", "48", "--timeout-ms", "100", "--record-dir", directory], {
    createTransport: async () => wrapped,
    io: { isTTY: false, write: line => output.push(line), prompt: async () => "E" },
  });
  assert.notEqual(result, 0);
  assert.doesNotMatch(output.join("\n"), /estimated_rx_window/);
  if (status === "TX") assert.match(output.join("\n"), /observation_timeout/);
  assert.equal(transport.requests.filter(bytes => bytes[4] === 0x17).length, status === "silent" ? 1 : 2);
  if (status === "silent") assert.match(output.join("\n"), /stop outcome=(unavailable|write_failed)/);
  assert.equal(transport.closed, true);
  assert.equal(await (await CwTrialRecordStore.open(directory)).hasUnresolvedIntent(), true);
});

test("NG does not enter estimated observation and never retries the message", async t => {
  const directory = await mkdtemp(join(tmpdir(), "cw-estimated-ng-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const transport = createCwTrialSimulatorTransport({ ack: "ng" });
  const output: string[] = [];
  assert.equal(await runCwTrial(["--simulate", "--simulate-confirm", "E", "--estimated-wpm", "48", "--record-dir", directory], {
    createTransport: async () => transport,
    io: { isTTY: false, write: line => output.push(line), prompt: async () => "E" },
  }), 7);
  assert.doesNotMatch(output.join("\n"), /estimated handoff/);
  assert.equal(transport.requests.filter(bytes => bytes[4] === 0x17).length, 2);
});

test("cancellation during an in-flight RX query settles that query before the original stop", async t => {
  const directory = await mkdtemp(join(tmpdir(), "cw-estimated-query-cancel-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const transport = createCwTrialSimulatorTransport();
  const cancel = new AbortController();
  let observing = false;
  const wrapped: CivTransport = {
    write: bytes => {
      const result = transport.write(bytes);
      if (observing && bytes[4] === 0x1c && bytes[5] === 0) cancel.abort();
      return result;
    },
    close: () => transport.close(), onClose: listener => transport.onClose(listener),
    onData: listener => transport.onData(listener),
  };
  const output: string[] = [];
  assert.notEqual(await runCwTrial(["--simulate", "--simulate-confirm", "E", "--estimated-wpm", "48", "--record-dir", directory], {
    signal: cancel.signal, createTransport: async () => wrapped,
    io: { isTTY: false, prompt: async () => "E", write: line => {
      output.push(line); if (line.includes("estimated handoff waiting")) observing = true;
    } },
  }), 0);
  assert.equal(transport.requests.filter(bytes => bytes[4] === 0x17).length, 2);
  assert.match(output.join("\n"), /stop outcome=ack_observed/);
  assert.doesNotMatch(output.join("\n"), /estimated_rx_window/);
});


test("transport loss cancels a long estimate immediately and persists its first cause without resending", async t => {
  const directory = await mkdtemp(join(tmpdir(), "cw-estimated-disconnect-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const transport = createCwTrialSimulatorTransport({ chunkSize: 64, echo: false });
  let lost: ((error?: Error) => void) | undefined;
  const wrapped: CivTransport = {
    write: bytes => transport.write(bytes), close: () => transport.close(),
    onData: listener => transport.onData(listener),
    onClose: listener => { lost = listener; return transport.onClose(listener); },
  };
  const output: string[] = [];
  let waitingAt = 0;
  const result = await runCwTrial(["--simulate", "--message", "CQ CQ DE BG2GZA K",
    "--simulate-confirm", "CQ CQ DE BG2GZA K", "--estimated-wpm", "20", "--record-dir", directory], {
    createTransport: async () => wrapped,
    io: { isTTY: false, prompt: async () => "", write: line => {
      output.push(line);
      if (line.includes("estimated handoff waiting")) {
        waitingAt = performance.now();
        setTimeout(() => lost?.(new Error("USB DEVICE REMOVED fixture")), 20);
      }
    } },
  });
  assert.equal(result, 1);
  assert.ok(waitingAt > 0);
  assert.ok(performance.now() - waitingAt < 1000, "must not wait 13.625s after device loss");
  assert.match(output.join("\n"), /failed: CW trial transport closed: USB DEVICE REMOVED fixture/);
  assert.doesNotMatch(output.join("\n"), /handoff=estimated_rx_window/);
  assert.equal(transport.requests.filter(bytes => bytes[4] === 0x17).length, 1);
  const store = await CwTrialRecordStore.open(directory);
  assert.equal(await store.hasUnresolvedIntent(), true);
  const rows = await store.readAll();
  assert.match(rows.at(-1)!.detail!, /error=.*USB DEVICE REMOVED fixture/);
  assert.match(rows.at(-1)!.detail!, /closeConfirmed=true; phase=locked/);
});

test("explicit close cancels an estimated wait without waiting for the message duration", async t => {
  const transport = createCwTrialSimulatorTransport({ chunkSize: 64, echo: false });
  const session = new CwTrialSession({ transport });
  t.after(() => session.close());
  await session.readContext();
  await session.sendMessage("CQ CQ DE BG2GZA K");
  const waiting = session.waitEstimatedReceiveWindow("CQ CQ DE BG2GZA K", 20);
  const rejected = assert.rejects(waiting, /session closing; RX observation cancelled/);
  await session.close();
  await rejected;
  assert.equal(session.view().closeConfirmed, true);
  assert.equal(session.view().error, null);
});
