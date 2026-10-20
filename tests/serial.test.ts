import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { CivReadOnlyClient } from "../packages/devices/src/civ.js";
import { openSerialCivTransport, ALLOWED_CIV_READ_REQUESTS,
  openCwTrialSerialTransport, ALLOWED_CW_TRIAL_WRITES,
  type SerialPortLike, type SerialPortCallback, type SerialPortOpenSettings,
} from "../packages/devices/src/serial.js";
import { main, runSerialRead, runSimulation } from "../apps/cwrig.js";

type Operation = "open" | "set" | "flush" | "write" | "drain" | "close";
const frequency = Uint8Array.from([0xfe, 0xfe, 0xe0, 0x94, 3, 0, 0x70, 0x54, 0x14, 0, 0xfd]);
const mode = Uint8Array.from([0xfe, 0xfe, 0xe0, 0x94, 4, 1, 2, 0xfd]);
let sequence = 0;

class FakePort extends EventEmitter implements SerialPortLike {
  isOpen = false;
  calls: string[] = [];
  writes: Uint8Array[] = [];
  fail: Operation | undefined;
  stall: Operation | undefined;
  replies = false;
  openCallback: SerialPortCallback | undefined;
  controls: unknown;
  invoke(operation: Operation, callback: SerialPortCallback): void {
    this.calls.push(operation);
    if (this.stall === operation) {
      if (operation === "open") this.openCallback = callback;
      return;
    }
    if (this.fail === operation) { callback(new Error(`${operation} failure`)); return; }
    if (operation === "open") this.isOpen = true;
    if (operation === "close") { this.isOpen = false; this.emit("close"); }
    callback(null);
  }
  open(callback: SerialPortCallback): void { this.invoke("open", callback); }
  set(options: unknown, callback: SerialPortCallback): void {
    this.controls = options; this.invoke("set", callback);
  }
  flush(callback: SerialPortCallback): void { this.invoke("flush", callback); }
  drain(callback: SerialPortCallback): void { this.invoke("drain", callback); }
  close(callback: SerialPortCallback): void { this.invoke("close", callback); }
  write(data: Uint8Array, callback: SerialPortCallback): boolean {
    this.writes.push(data);
    if (this.replies) {
      const reply = data[4] === 3 ? frequency : mode;
      this.emit("data", reply.slice(0, 4));
      this.emit("data", reply.slice(4));
    }
    this.invoke("write", callback); return true;
  }
}

function options(port: FakePort, path = `FAKE-${++sequence}`) {
  return { portPath: path, settleMs: 1, openTimeoutMs: 20, operationTimeoutMs: 20,
    closeTimeoutMs: 20, portFactory: () => port };
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 2));

test("selected trial transport requires explicit confirmation and only permits fixed messages", async () => {
  const fake = new FakePort(), opts = options(fake);
  await assert.rejects(openCwTrialSerialTransport({ ...opts, confirmKeyingOff: false }), /confirmKeyingOff/);
  assert.equal(fake.calls.length, 0);
  const transport = await openCwTrialSerialTransport({ ...opts, confirmKeyingOff: true });
  try {
    for (const bytes of ALLOWED_CW_TRIAL_WRITES) await transport.write(Uint8Array.from(bytes));
    assert.equal(fake.writes.length, 3);
    for (const bytes of [
      [0xfe, 0xfe, 0x94, 0xe0, 0x17, 0x53, 0x4f, 0x53, 0xfd],
      [0xfe, 0xfe, 0x94, 0xe0, 0x1c, 0, 1, 0xfd],
      [0xfe, 0xfe, 0x94, 0xe0, 5, 0, 0, 0, 0, 0, 0xfd],
    ]) await assert.rejects(transport.write(Uint8Array.from(bytes)), /non-whitelisted/);
    assert.equal(fake.writes.length, 3);
  } finally { await transport.close(); }
  assert.equal(transport.isClosed, true);
});

test("serial open settings, initialization order, normal close and reopen", async () => {
  const fake = new FakePort();
  const opts = options(fake);
  let settings: SerialPortOpenSettings | undefined;
  const transport = await openSerialCivTransport({ ...opts, portFactory: (value) => { settings = value; return fake; } });
  assert.deepEqual(settings, { path: opts.portPath, baudRate: 19200, dataBits: 8, stopBits: 1,
    parity: "none", rtscts: false, xon: false, xoff: false, autoOpen: false, lock: true });
  assert.deepEqual(fake.controls, { dtr: false, rts: false });
  assert.deepEqual(fake.calls, ["open", "set", "flush", "flush"]);
  await assert.rejects(openSerialCivTransport(opts), /already held/);
  await Promise.all([transport.close(), transport.close()]);
  assert.equal(transport.isClosed, true);
  assert.equal(fake.listenerCount("error"), 0);
  assert.equal(fake.calls.filter((op) => op === "close").length, 1);
  const next = await openSerialCivTransport(opts); await next.close();
});

test("immutable whitelist rejects transmitting/settings bytes and snapshots input", async () => {
  assert.equal(Object.isFrozen(ALLOWED_CIV_READ_REQUESTS), true);
  assert.equal(Object.isFrozen(ALLOWED_CIV_READ_REQUESTS[0]), true);
  const fake = new FakePort(); const transport = await openSerialCivTransport(options(fake));
  for (const command of [5, 6, 0x17, 0x1c, 0xff]) {
    await assert.rejects(transport.write(Uint8Array.from([0xfe, 0xfe, 0x94, 0xe0, command, 0xfd])), /non-whitelisted/);
  }
  await assert.rejects(transport.write(frequency), /non-whitelisted/);
  assert.equal(fake.writes.length, 0);
  const request = Uint8Array.from(ALLOWED_CIV_READ_REQUESTS[0]!);
  const write = transport.write(request); request[4] = 0x17; await write;
  assert.equal(fake.writes[0]![4], 3);
  await transport.close();
});

test("real frame fixture through serial/client and CLI, simulator preserved", async () => {
  const fake = new FakePort(); fake.replies = true;
  const result = await runSerialRead({ port: "fixture", baud: 19200, timeoutMs: 200 },
    (opts) => openSerialCivTransport({ ...opts, portFactory: () => fake, settleMs: 1 }));
  assert.deepEqual(result, { source: "serial", readOnly: true, port: "fixture", baud: 19200,
    frequencyHz: 14547000, mode: "USB", filter: 2 });
  assert.deepEqual(fake.writes.map((data) => [...data]), ALLOWED_CIV_READ_REQUESTS);
  assert.equal(fake.isOpen, false);
  assert.equal((await runSimulation()).source, "simulation");
});

for (const operation of ["open", "set", "flush", "write", "drain"] as const) {
  for (const kind of ["failure", "timeout"] as const) {
    test(`${operation} ${kind} invalidates and closes without retry`, async () => {
      const fake = new FakePort(); const opts = options(fake);
      if (operation === "write" || operation === "drain") {
        const transport = await openSerialCivTransport(opts);
        fake[kind === "failure" ? "fail" : "stall"] = operation;
        let closed = 0; transport.onClose(() => closed++);
        await assert.rejects(transport.write(Uint8Array.from(ALLOWED_CIV_READ_REQUESTS[0]!)));
        await tick(); assert.equal(transport.isClosed, true); assert.equal(closed, 1);
        await assert.rejects(transport.write(Uint8Array.from(ALLOWED_CIV_READ_REQUESTS[0]!)), /not ready/);
      } else {
        fake[kind === "failure" ? "fail" : "stall"] = operation;
        await assert.rejects(openSerialCivTransport(opts));
        if (operation === "open" && kind === "timeout") {
          // The still-pending open keeps ownership and a handled error listener.
          await assert.rejects(openSerialCivTransport(opts), /already held/);
          assert.equal(fake.listenerCount("error"), 1);
          fake.isOpen = true; fake.openCallback!(null); await tick();
        }
        assert.equal(fake.isOpen, false);
      }
      fake.fail = undefined; fake.stall = undefined;
      const next = await openSerialCivTransport(opts); await next.close();
    });
  }
}

for (const kind of ["failure", "timeout"] as const) {
  test(`close ${kind} retains ownership until verified release`, async () => {
    const fake = new FakePort(); const opts = options(fake);
    const transport = await openSerialCivTransport(opts);
    let notified = 0; transport.onClose(() => notified++);
    fake[kind === "failure" ? "fail" : "stall"] = "close";
    await assert.rejects(transport.close(), /could not be confirmed/);
    assert.equal(notified, 1);
    assert.equal(transport.isClosed, false);
    assert.equal(fake.listenerCount("error"), 1);
    await assert.rejects(openSerialCivTransport(opts), /already held/);
    fake.fail = undefined; fake.stall = undefined; await transport.close();
    assert.equal(transport.isClosed, true);
  });
}

test("native error/disconnect reject pending read and release listeners", async () => {
  for (const event of ["error", "close"]) {
    const fake = new FakePort(); const transport = await openSerialCivTransport(options(fake));
    const client = new CivReadOnlyClient({ transport, timeoutMs: 100 });
    const read = client.readFrequency();
    if (event === "close") fake.isOpen = false;
    fake.emit(event, new Error("disconnected"));
    await assert.rejects(read); await client.close(); await tick();
    assert.equal(transport.isClosed, true); assert.equal(fake.listenerCount("error"), 0);
  }
});

test("initialization error prevents subsequent setup/read", async () => {
  const fake = new FakePort();
  fake.set = (_opts, callback) => { fake.emit("error", new Error("setup event")); callback(null); };
  await assert.rejects(openSerialCivTransport(options(fake)), /setup event/);
  assert.equal(fake.calls.includes("flush"), false); assert.equal(fake.isOpen, false);
});

test("read timeout sends one request only", async () => {
  const fake = new FakePort(); const transport = await openSerialCivTransport(options(fake));
  const client = new CivReadOnlyClient({ transport, timeoutMs: 15 });
  await assert.rejects(client.readFrequency(), /timed out/);
  await client.close(); assert.equal(fake.writes.length, 1); assert.equal(fake.isOpen, false);
});

test("a reply cannot succeed before a failing native drain", async () => {
  const fake = new FakePort(); fake.replies = true;
  const transport = await openSerialCivTransport(options(fake)); fake.fail = "drain";
  const client = new CivReadOnlyClient({ transport, timeoutMs: 100 });
  await assert.rejects(client.readFrequency()); await client.close();
});

test("abort during pending open retains ownership and cleans delayed success", async () => {
  const fake = new FakePort(); fake.stall = "open";
  const controller = new AbortController(); const opts = options(fake);
  const opened = openSerialCivTransport({ ...opts, signal: controller.signal });
  await tick(); controller.abort();
  await assert.rejects(opened);
  fake.isOpen = true; fake.openCallback!(null); await tick();
  assert.equal(fake.isOpen, false);
  fake.stall = undefined; const next = await openSerialCivTransport(opts); await next.close();
});

test("invalid CLI arguments never call the serial opener", async () => {
  let opened = 0;
  const opener = async (): Promise<never> => { opened++; throw new Error("must not open"); };
  const valid = ["read", "--port", "COM17", "--confirm-keying-off"];
  const cases = [[], ["read"], ["read", "--port", "COM17"], [...valid, "--port", "COM18"],
    [...valid, "--unknown"], [...valid, "--baud"], [...valid, "extra"], [...valid, "--baud", "123"],
    [...valid, "--timeout-ms", "0"], [...valid, "--confirm-keying-off"], [...valid, "--baud", "1e4"]];
  for (const args of cases) assert.equal(await main(args, opener), 2);
  assert.equal(opened, 0);
});

test("CLI rejects cleanup failure after valid reads", async () => {
  const fake = new FakePort(); fake.replies = true;
  const opener = async (opts: Parameters<typeof openSerialCivTransport>[0]) => {
    const transport = await openSerialCivTransport({ ...opts, settleMs: 1, portFactory: () => fake });
    fake.fail = "close";
    return transport;
  };
  assert.equal(await main(["read", "--port", "cleanup-fixture", "--confirm-keying-off"], opener), 1);
  fake.fail = undefined; fake.isOpen = false; fake.emit("close");
});
