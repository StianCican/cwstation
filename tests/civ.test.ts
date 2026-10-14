// P1-004：IC-7300 只读 CI-V 协议与模拟查询测试。
//
// 全部离线：只用注入的内存 FakeTransport 与模拟 transport，不打开串口、
// 不访问电台、不发射、不读数据库、不启动 daemon。

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ROOT, isBuiltMode, sleep } from "./helpers.js";
import * as devices from "../packages/devices/src/index.js";
import {
  CIV_DEFAULT_CONTROLLER_ADDRESS,
  CIV_DEFAULT_RADIO_ADDRESS,
  CivBusyError,
  CivConfigError,
  CivFrameParser,
  CivProtocolError,
  CivReadOnlyClient,
  CivSessionError,
  CivTimeoutError,
  CivTransportError,
  createSimulatedCivTransport,
  decodeFrequencyBcd,
  encodeFrequencyBcd,
  type CivTransport,
} from "../packages/devices/src/index.js";

const RADIO = CIV_DEFAULT_RADIO_ADDRESS; // 0x94
const CONTROLLER = CIV_DEFAULT_CONTROLLER_ADDRESS; // 0xe0

// ── 测试辅助 ────────────────────────────────────────────────────────────

function frame(to: number, from: number, command: number, data: readonly number[] = []): number[] {
  return [0xfe, 0xfe, to, from, command, ...data, 0xfd];
}

/** 内存 transport：可注入写失败，可手动注入数据/断连，并记录取消订阅次数。 */
class FakeTransport implements CivTransport {
  readonly writes: Uint8Array[] = [];
  closed = false;
  dataUnsubscribes = 0;
  closeUnsubscribes = 0;
  writeFailure: "throw" | "reject" | null = null;
  /** data emit 是否在 write 内同步进行（用于验证写同步抛错路径）。 */
  private readonly dataListeners = new Set<(chunk: Uint8Array) => void>();
  private readonly closeListeners = new Set<(error?: Error) => void>();

  write(data: Uint8Array): Promise<void> {
    if (this.writeFailure === "throw") throw new Error("simulated synchronous write failure");
    if (this.writeFailure === "reject") return Promise.reject(new Error("simulated asynchronous write failure"));
    this.writes.push(Uint8Array.from(data));
    return Promise.resolve();
  }

  onData(listener: (chunk: Uint8Array) => void): () => void {
    this.dataListeners.add(listener);
    return () => {
      if (this.dataListeners.delete(listener)) this.dataUnsubscribes += 1;
    };
  }

  onClose(listener: (error?: Error) => void): () => void {
    this.closeListeners.add(listener);
    return () => {
      if (this.closeListeners.delete(listener)) this.closeUnsubscribes += 1;
    };
  }

  close(): void {
    this.closed = true;
  }

  get dataListenerCount(): number {
    return this.dataListeners.size;
  }

  get closeListenerCount(): number {
    return this.closeListeners.size;
  }

  emitData(bytes: readonly number[] | Uint8Array): void {
    const chunk = Uint8Array.from(bytes);
    for (const listener of [...this.dataListeners]) listener(chunk);
  }

  emitClose(error?: Error): void {
    for (const listener of [...this.closeListeners]) listener(error);
  }
}

function makeClient(transport: CivTransport, timeoutMs = 1000): CivReadOnlyClient {
  return new CivReadOnlyClient({ transport, timeoutMs });
}

async function rejectsWith(promise: Promise<unknown>, type: new (...args: never[]) => Error): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof type);
}

// ── 精确读请求与解码 ────────────────────────────────────────────────────

test("readFrequency sends the exact read-only request bytes and decodes 14025000 Hz", async () => {
  const transport = new FakeTransport();
  const client = makeClient(transport);
  const pending = client.readFrequency();
  assert.equal(transport.writes.length, 1);
  assert.deepEqual([...(transport.writes[0] as Uint8Array)], [0xfe, 0xfe, 0x94, 0xe0, 0x03, 0xfd]);
  transport.emitData(frame(CONTROLLER, RADIO, 0x03, encodeFrequencyBcd(14_025_000)));
  assert.equal(await pending, 14_025_000);
  await client.close();
});

test("readMode sends the exact request bytes and returns mode plus filter", async () => {
  const transport = new FakeTransport();
  const client = makeClient(transport);
  const pending = client.readMode();
  assert.deepEqual([...(transport.writes[0] as Uint8Array)], [0xfe, 0xfe, 0x94, 0xe0, 0x04, 0xfd]);
  transport.emitData(frame(CONTROLLER, RADIO, 0x04, [0x03, 0x01]));
  assert.deepEqual(await pending, { mode: "CW", filter: 1 });
  await client.close();
});

test("package public surface exposes no arbitrary CI-V command constructor", () => {
  assert.equal("buildReadRequest" in devices, false);
  assert.equal("encodeFrame" in devices, false);
  assert.equal(typeof devices.CivReadOnlyClient, "function");
});

// ── 流式 parser：拆包、多包、噪声、超长帧重同步 ────────────────────────

test("parser reassembles byte-split replies across noise", async () => {
  const transport = new FakeTransport();
  const client = makeClient(transport);
  const pending = client.readFrequency();
  transport.emitData([0x00, 0xff, 0x7e]); // 前导噪声
  for (const byte of frame(CONTROLLER, RADIO, 0x03, encodeFrequencyBcd(7_000_000))) {
    transport.emitData([byte]);
  }
  assert.equal(await pending, 7_000_000);
  await client.close();
});

test("parser resyncs to a valid reply after an overlong frame and bounds its buffer", async () => {
  const transport = new FakeTransport();
  const client = makeClient(transport);
  const pending = client.readFrequency();
  transport.emitData(new Array(200).fill(0x55));
  transport.emitData([0xfe, 0xfe]);
  transport.emitData(new Array(200).fill(0x11)); // 无 FD 的超长帧
  transport.emitData(frame(CONTROLLER, RADIO, 0x03, encodeFrequencyBcd(21_000_000)));
  assert.equal(await pending, 21_000_000);
  await client.close();

  const parser = new CivFrameParser({ maxFrameBytes: 32 });
  parser.push(Uint8Array.from([0xfe, 0xfe]));
  assert.equal(parser.push(new Uint8Array(100_000).fill(0x41)).length, 0);
  assert.ok(parser.bufferedBytes <= parser.maxFrameBytes, `buffer ${parser.bufferedBytes} exceeded bound`);
  assert.equal(parser.push(Uint8Array.from(frame(CONTROLLER, RADIO, 0x04, [0x03, 0x01]))).length, 1);
});

test("parser enforces frame limit including FD and handles extra FE preambles", () => {
  const parser = new CivFrameParser({ maxFrameBytes: 8 });
  const mode = frame(CONTROLLER, RADIO, 4, [3, 1]);
  assert.equal(parser.push([...mode.slice(0, -1), 0, 0xfd]).length, 0);
  assert.equal(parser.push([0xfe, ...mode]).length, 1);
  assert.equal(parser.push([0xfe, 0xfe, ...mode]).length, 1);
  assert.equal(parser.bufferedBytes, 0);
});

test("echo, other addresses and transceive frames are ignored; multiple frames per chunk work", async () => {
  const transport = new FakeTransport();
  const client = makeClient(transport);
  const pending = client.readFrequency();
  const echo = [0xfe, 0xfe, 0x94, 0xe0, 0x03, 0xfd]; // 本机请求回显
  const transceiveBroadcast = frame(0x00, RADIO, 0x00, [0x00, 0x50, 0x02, 0x14, 0x00]);
  const transceiveMode = frame(CONTROLLER, RADIO, 0x01, [0x03, 0x01]);
  const otherRadio = frame(CONTROLLER, 0x95, 0x03, encodeFrequencyBcd(1_000_000));
  const reply = frame(CONTROLLER, RADIO, 0x03, encodeFrequencyBcd(14_025_000));
  transport.emitData([...echo, ...transceiveBroadcast, ...transceiveMode, ...otherRadio, ...reply]);
  assert.equal(await pending, 14_025_000);
  await client.close();
});

test("unsolicited frames before any query are ignored and do not lock the session", async () => {
  const transport = new FakeTransport();
  const client = makeClient(transport);
  transport.emitData(frame(CONTROLLER, RADIO, 0x03, encodeFrequencyBcd(1_000_000)));
  assert.equal(client.state, "idle");
  const pending = client.readFrequency();
  transport.emitData(frame(CONTROLLER, RADIO, 0x03, encodeFrequencyBcd(3_500_000)));
  assert.equal(await pending, 3_500_000);
  await client.close();
});

// ── 解码拒绝 ────────────────────────────────────────────────────────────

test("frequency decoding rejects wrong length, invalid BCD and out-of-range values", () => {
  assert.equal(decodeFrequencyBcd([0x00, 0x50, 0x02, 0x14, 0x00]), 14_025_000);
  assert.throws(() => decodeFrequencyBcd([0x00, 0x50, 0x02, 0x14]), CivProtocolError);
  assert.throws(() => decodeFrequencyBcd([0x00, 0x50, 0x02, 0x14, 0x00, 0x00]), CivProtocolError);
  assert.throws(() => decodeFrequencyBcd([0x00, 0xfa, 0x02, 0x14, 0x00]), CivProtocolError);
  assert.equal(decodeFrequencyBcd([0x00, 0x00, 0x80, 0x74, 0x00]), 74_800_000);
  for (const byte of [-1, 256, NaN, 1.5]) {
    assert.throws(() => decodeFrequencyBcd([byte, 0, 0, 0, 0]), CivProtocolError);
  }
  assert.deepEqual(encodeFrequencyBcd(0), [0x00, 0x00, 0x00, 0x00, 0x00]);
  assert.equal(decodeFrequencyBcd(encodeFrequencyBcd(9_999_999_999)), 9_999_999_999);
  assert.throws(() => encodeFrequencyBcd(10_000_000_000), CivConfigError);
  assert.throws(() => encodeFrequencyBcd(-1), CivConfigError);
});

for (const [name, data] of [
  ["unknown mode", [0x06, 0x01]],
  ["filter 00", [0x03, 0x00]],
  ["filter 04", [0x03, 0x04]],
  ["missing filter", [0x03]],
  ["extra mode byte", [0x03, 0x01, 0x00]],
] as const) {
  test(`malformed mode response (${name}) fails and locks the session`, async () => {
    const transport = new FakeTransport();
    const client = makeClient(transport);
    const pending = client.readMode();
    transport.emitData(frame(CONTROLLER, RADIO, 0x04, [...data]));
    await rejectsWith(pending, CivProtocolError);
    assert.equal(client.state, "locked");
    assert.equal(transport.closed, true);
    await rejectsWith(client.readFrequency(), CivSessionError);
  });
}

for (const [name, data] of [
  ["invalid BCD", [0x00, 0x1a, 0x02, 0x14, 0x00]],
  ["wrong length", [0x00, 0x50, 0x02, 0x14]],
  ["extra byte", [0x00, 0x00, 0x00, 0x70, 0x00, 0x00]],
] as const) {
  test(`malformed frequency response (${name}) fails and locks the session`, async () => {
    const transport = new FakeTransport();
    const client = makeClient(transport);
    const pending = client.readFrequency();
    transport.emitData(frame(CONTROLLER, RADIO, 0x03, [...data]));
    await rejectsWith(pending, CivProtocolError);
    assert.equal(client.state, "locked");
    await rejectsWith(client.readFrequency(), CivSessionError);
  });
}

test("NG (0xfa) and unexpected OK (0xfb) fail the read and lock the session", async () => {
  for (const command of [0xfa, 0xfb]) {
    const transport = new FakeTransport();
    const client = makeClient(transport);
    const pending = client.readFrequency();
    transport.emitData(frame(CONTROLLER, RADIO, command));
    await rejectsWith(pending, CivProtocolError);
    assert.equal(client.state, "locked");
    await rejectsWith(client.readMode(), CivSessionError);
    await client.close();
  }
});

// ── 并发、超时、故障与清理 ──────────────────────────────────────────────

test("only one query at a time: concurrent read rejects busy without locking", async () => {
  const transport = new FakeTransport();
  const client = makeClient(transport);
  const pending = client.readFrequency();
  await rejectsWith(client.readMode(), CivBusyError);
  assert.equal(client.state, "busy");
  transport.emitData(frame(CONTROLLER, RADIO, 0x03, encodeFrequencyBcd(14_025_000)));
  assert.equal(await pending, 14_025_000);
  assert.equal(client.state, "idle");
  const second = client.readMode();
  transport.emitData(frame(CONTROLLER, RADIO, 0x04, [0x01, 0x03]));
  assert.deepEqual(await second, { mode: "USB", filter: 3 });
  await client.close();
});

test("timeout locks the session and a late reply is not reused", async () => {
  const transport = new FakeTransport();
  const client = makeClient(transport, 30);
  const pending = client.readFrequency();
  await rejectsWith(pending, CivTimeoutError);
  assert.equal(client.state, "locked");
  assert.equal(transport.closed, true);
  assert.equal(transport.dataListenerCount, 0);
  // 迟到回复：listener 已清理，不能完成任何查询或解锁会话。
  transport.emitData(frame(CONTROLLER, RADIO, 0x03, encodeFrequencyBcd(14_025_000)));
  await rejectsWith(client.readFrequency(), CivSessionError);
  await client.close();
});

test("synchronous and asynchronous write failures lock the session", async () => {
  for (const failure of ["throw", "reject"] as const) {
    const transport = new FakeTransport();
    transport.writeFailure = failure;
    const client = makeClient(transport);
    await rejectsWith(client.readFrequency(), CivTransportError);
    assert.equal(client.state, "locked");
    assert.equal(transport.closed, true);
    await rejectsWith(client.readMode(), CivSessionError);
    await client.close();
  }
});

test("late write rejection cannot change an explicitly closed session", async () => {
  const transport = new FakeTransport();
  let rejectWrite!: (error: Error) => void;
  transport.write = () => new Promise<void>((_resolve, reject) => { rejectWrite = reject; });
  const client = makeClient(transport);
  const pending = client.readFrequency();
  const rejected = rejectsWith(pending, CivSessionError);
  await client.close();
  await rejected;
  rejectWrite(new Error("late write failure"));
  await sleep(0);
  assert.equal(client.state, "closed");
});

test("transport disconnect fails the pending read and locks the session", async () => {
  const transport = new FakeTransport();
  const client = makeClient(transport);
  const pending = client.readFrequency();
  transport.emitClose(new Error("cable unplugged"));
  await rejectsWith(pending, CivTransportError);
  assert.equal(client.state, "locked");
  await rejectsWith(client.readFrequency(), CivSessionError);
  await client.close();
});

test("disconnect with no pending read still locks the session", async () => {
  const transport = new FakeTransport();
  const client = makeClient(transport);
  transport.emitClose();
  assert.equal(client.state, "locked");
  await rejectsWith(client.readFrequency(), CivSessionError);
  await client.close();
});

test("close aborts the pending read, clears the timer and unsubscribes listeners", async () => {
  const transport = new FakeTransport();
  const client = makeClient(transport, 40);
  const pending = client.readFrequency();
  assert.equal(transport.dataListenerCount, 1);
  assert.equal(transport.closeListenerCount, 1);
  await client.close();
  await rejectsWith(pending, CivSessionError);
  assert.equal(transport.closed, true);
  assert.equal(transport.dataUnsubscribes, 1);
  assert.equal(transport.closeUnsubscribes, 1);
  assert.equal(transport.dataListenerCount, 0);
  assert.equal(client.state, "closed");
  await sleep(80); // 若 timer 未清理，超时会话会把状态改成 locked
  assert.equal(client.state, "closed");
  await client.close(); // 幂等
  assert.equal(transport.dataUnsubscribes, 1);
  await rejectsWith(client.readFrequency(), CivSessionError);
});

test("explicit address validation rejects broadcast and reserved addresses", async () => {
  const transport = new FakeTransport();
  assert.throws(() => new CivReadOnlyClient({ transport, radioAddress: 0x00 }), CivConfigError);
  assert.throws(() => new CivReadOnlyClient({ transport, radioAddress: 0xe0 }), CivConfigError);
  assert.throws(() => new CivReadOnlyClient({ transport, radioAddress: 0x100 }), CivConfigError);
  assert.throws(() => new CivReadOnlyClient({ transport, controllerAddress: 0x94 }), CivConfigError);
  assert.throws(
    () => new CivReadOnlyClient({ transport, radioAddress: 0x94, controllerAddress: 0x94 }),
    CivConfigError,
  );
  assert.throws(() => new CivReadOnlyClient({ transport, timeoutMs: 0 }), CivConfigError);
  const valid = new CivReadOnlyClient({ transport, radioAddress: 0x94, controllerAddress: 0xe0 });
  assert.equal(valid.state, "idle");
  await valid.close();
});

// ── 模拟 transport 与 CLI ───────────────────────────────────────────────

test("simulated transport answers with echo and byte-split replies", async () => {
  const transport = createSimulatedCivTransport();
  const client = makeClient(transport);
  assert.equal(await client.readFrequency(), 14_025_000);
  assert.deepEqual(await client.readMode(), { mode: "CW", filter: 1 });
  assert.equal(transport.requests.length, 2);
  assert.deepEqual([...(transport.requests[0] as Uint8Array)], [0xfe, 0xfe, 0x94, 0xe0, 0x03, 0xfd]);
  await client.close();
  assert.equal(transport.closed, true);
});

function cwrigEntry(): string[] {
  return isBuiltMode()
    ? [join(ROOT, "dist", "apps", "cwrig.js")]
    : ["--import", "tsx", join(ROOT, "apps", "cwrig.ts")];
}

interface CliRun {
  status: number | null;
  json: Record<string, unknown> | null;
  stdout: string;
  stderr: string;
}

function runCwrig(args: string[]): CliRun {
  const result = spawnSync(process.execPath, [...cwrigEntry(), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30_000,
  });
  const lines = result.stdout.trim().split("\n").filter((line) => line.length > 0);
  const last = lines.length > 0 ? (lines[lines.length - 1] as string) : "";
  return {
    status: result.status,
    json: last.startsWith("{") ? (JSON.parse(last) as Record<string, unknown>) : null,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

test("cwrig simulate reports a simulation-only read and touches no device path", () => {
  const run = runCwrig(["simulate"]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr.trim(), "");
  assert.deepEqual(
    {
      source: run.json?.source,
      readOnly: run.json?.readOnly,
      frequencyHz: run.json?.frequencyHz,
      mode: run.json?.mode,
      filter: run.json?.filter,
    },
    { source: "simulation", readOnly: true, frequencyHz: 14_025_000, mode: "CW", filter: 1 },
  );
});

test("cwrig rejects every command and argument other than simulate", () => {
  for (const args of [[], ["read"], ["simulate", "extra"], ["--config", "x"], ["status"], ["simulate", "--raw"]]) {
    const run = runCwrig(args);
    assert.equal(run.status, 2, `args=${JSON.stringify(args)} stderr=${run.stderr}`);
    assert.equal(run.json?.ok, false, `args=${JSON.stringify(args)}`);
    assert.equal(run.json?.code, "usage");
  }
});
