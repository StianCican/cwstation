// P1-007 只读状态服务测试：全部使用离线模拟 transport 与临时端点。
//
// 不打开真实串口、不访问电台、不监听 TCP。Unix socket 语义测试在 Windows 上
// 跳过（Windows 命名管道类型保留但本轮未启用）。

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  createSimulatedCivTransport,
  type CivTransport,
  type SimulatedCivTransport,
} from "../../devices/src/index.js";
import {
  RIG_STATUS_MAX_FRAME_BYTES,
  RigStatusError,
  RigStatusIpcServer,
  RigStatusService,
  parseRigStatusEndpoint,
  rigStatusEndpointAddress,
  type RigStatusEndpoint,
} from "./service.js";

const IS_WINDOWS = process.platform === "win32";

interface Harness {
  readonly service: RigStatusService;
  readonly server: RigStatusIpcServer;
}

function makeHarness(context: TestContext, options: ConstructorParameters<typeof RigStatusService>[0]): Harness {
  const dir = mkdtempSync(join(tmpdir(), "rig-status-test-"));
  const endpoint: RigStatusEndpoint = IS_WINDOWS
    ? { kind: "pipe", name: `rig-status-test-${process.pid}-${Math.floor(Math.random() * 1e9).toString(16)}` }
    : { kind: "unix", path: join(dir, "status.sock") };
  const service = new RigStatusService(options);
  const server = new RigStatusIpcServer({ endpoint, service });
  context.after(async () => {
    try {
      await service.stop();
    } catch {
      // 尽力清理。
    }
    try {
      await server.stop();
    } catch {
      // 尽力清理。
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 临时目录清理失败不影响测试结论。
    }
  });
  return { service, server };
}

function connectClient(address: string): Promise<Socket> {
  return new Promise((resolveConnect, rejectConnect) => {
    const socket = connect(address);
    socket.once("connect", () => resolveConnect(socket));
    socket.once("error", rejectConnect);
  });
}

function lineReader(socket: Socket): () => Promise<string> {
  let buffer = "";
  const queue: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const waiter = waiters.shift();
      if (waiter !== undefined) waiter(line);
      else queue.push(line);
    }
  });
  return () =>
    new Promise<string>((resolveLine) => {
      const line = queue.shift();
      if (line !== undefined) resolveLine(line);
      else waiters.push(resolveLine);
    });
}

async function rpc(
  socket: Socket,
  next: () => Promise<string>,
  request: Record<string, unknown>,
): Promise<Record<string, any>> {
  socket.write(`${JSON.stringify(request)}\n`);
  return JSON.parse(await next()) as Record<string, any>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

test("service reports a read-only ready snapshot from an offline transport", async (context) => {
  const service = new RigStatusService({ simulate: true, pollIntervalMs: 25, staleAfterMs: 200 });
  context.after(async () => {
    await service.stop();
  });

  const report = await service.start();
  assert.equal(report.source, "rig-statusd");
  assert.equal(report.readOnly, true);
  assert.equal(report.status, "ready");
  assert.equal(report.stale, false);
  assert.ok(report.snapshot !== null);
  assert.equal(report.snapshot?.frequencyHz, 14_025_000);
  assert.equal(report.snapshot?.mode, "CW");
  assert.equal(report.snapshot?.filter, 1);
  assert.equal(typeof report.snapshotTime, "number");
  assert.equal(report.snapshotTime, report.snapshot?.snapshotTime);
  assert.equal(service.watch().snapshotTime, report.snapshotTime);
});

test("service holds one transport, faults without a device, and reconnects only on request", async (context) => {
  let opens = 0;
  const service = new RigStatusService({
    pollIntervalMs: 25,
    staleAfterMs: 200,
    transportFactory: (): CivTransport => {
      opens += 1;
      if (opens === 1) {
        return {
          write: () => Promise.reject(new Error("mock device unavailable")),
          onData: () => () => undefined,
          onClose: () => () => undefined,
          close: () => undefined,
        };
      }
      return createSimulatedCivTransport({ frequencyHz: 7_030_000 });
    },
  });
  context.after(async () => {
    await service.stop();
  });

  const first = await service.start();
  assert.equal(opens, 1);
  assert.equal(first.status, "fault");
  assert.equal(first.snapshot, null);
  assert.match(first.error ?? "", /mock device unavailable/);

  // 不自动重连：再等几个轮询周期，transport 仍未重新打开。
  await sleep(90);
  assert.equal(opens, 1);

  const second = await service.reconnect();
  assert.equal(opens, 2);
  assert.equal(second.status, "ready");
  assert.equal(second.snapshot?.frequencyHz, 7_030_000);
});

test("stop closes the owned transport and returns to disconnected", async () => {
  const transports: SimulatedCivTransport[] = [];
  const service = new RigStatusService({
    pollIntervalMs: 20,
    transportFactory: () => {
      const transport = createSimulatedCivTransport();
      transports.push(transport);
      return transport;
    },
  });
  await service.start();
  assert.equal(transports[0]?.closed, false);
  await service.stop();
  assert.equal(transports[0]?.closed, true);
  assert.equal(service.status().status, "disconnected");
});

test("reconnect closes the previous transport before opening a new one", async (context) => {
  const transports: SimulatedCivTransport[] = [];
  let opens = 0;
  const service = new RigStatusService({
    pollIntervalMs: 20,
    staleAfterMs: 500,
    transportFactory: () => {
      opens += 1;
      const transport = createSimulatedCivTransport();
      transports.push(transport);
      return transport;
    },
  });
  context.after(async () => {
    await service.stop();
  });

  await service.start();
  assert.equal(opens, 1);
  assert.equal(transports[0]?.closed, false);
  await sleep(80);
  assert.equal(opens, 1, "polling must not open additional transports");

  const report = await service.reconnect();
  assert.equal(opens, 2);
  assert.equal(transports[0]?.closed, true);
  assert.equal(report.status, "ready");
});

test("IPC serves status/watch and rejects unknown methods and control fields", { skip: IS_WINDOWS }, async (context) => {
  const { service, server } = makeHarness(context, { simulate: true, pollIntervalMs: 25, staleAfterMs: 200 });
  await server.start();
  await service.start();

  const socket = await connectClient(server.address);
  context.after(() => socket.destroy());
  const next = lineReader(socket);

  const status = await rpc(socket, next, { id: "s1", method: "status" });
  assert.equal(status.ok, true);
  assert.equal(status.source, "rig-statusd");
  assert.equal(status.readOnly, true);
  assert.equal(status.result.status, "ready");
  assert.equal(status.result.stale, false);
  assert.equal(typeof status.result.snapshotTime, "number");
  assert.equal(status.result.snapshot.frequencyHz, 14_025_000);

  const watch = await rpc(socket, next, { id: "w1", method: "watch" });
  assert.equal(watch.ok, true);
  assert.equal(watch.result.snapshot.mode, "CW");

  const unknown = await rpc(socket, next, { id: "u1", method: "set_frequency" });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, "unknown_method");

  const control = await rpc(socket, next, { id: "c1", method: "status", params: { frequencyHz: 7_000_000 } });
  assert.equal(control.ok, false);
  assert.equal(control.error.code, "invalid_params");

  const extraField = await rpc(socket, next, { id: "e1", method: "status", ptt: true });
  assert.equal(extraField.ok, false);
  assert.equal(extraField.error.code, "invalid_request");
});

test("IPC rejects NDJSON frames larger than 64KiB", { skip: IS_WINDOWS }, async (context) => {
  const { service, server } = makeHarness(context, { simulate: true, pollIntervalMs: 25 });
  await server.start();
  await service.start();

  const socket = await connectClient(server.address);
  context.after(() => socket.destroy());
  const next = lineReader(socket);

  const padding = "x".repeat(RIG_STATUS_MAX_FRAME_BYTES + 16);
  const response = await rpc(socket, next, { id: "big", method: "status", params: { pad: padding } });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "invalid_request");
  assert.match(response.error.message, /exceeds/);
});

test("client disconnect does not stop the service", { skip: IS_WINDOWS }, async (context) => {
  const { service, server } = makeHarness(context, { simulate: true, pollIntervalMs: 25 });
  await server.start();
  await service.start();

  const first = await connectClient(server.address);
  const firstStatus = await rpc(first, lineReader(first), { id: "a", method: "status" });
  assert.equal(firstStatus.ok, true);
  first.destroy();
  await new Promise<void>((resolveClose) => first.once("close", () => resolveClose()));

  assert.equal(service.status().status, "ready");

  const second = await connectClient(server.address);
  context.after(() => second.destroy());
  const secondStatus = await rpc(second, lineReader(second), { id: "b", method: "status" });
  assert.equal(secondStatus.ok, true);
  assert.equal(secondStatus.result.status, "ready");
});

test("endpoint parsing never accepts TCP ports or URLs", () => {
  assert.throws(() => parseRigStatusEndpoint("12345"), RigStatusError);
  assert.throws(() => parseRigStatusEndpoint("http://localhost:12345"), RigStatusError);
  assert.throws(() => parseRigStatusEndpoint("  "), RigStatusError);
});

test("named pipe endpoints keep an explicit type and address", () => {
  if (IS_WINDOWS) {
    const endpoint = parseRigStatusEndpoint("\\\\.\\pipe\\cwstation-rig");
    assert.deepEqual(endpoint, { kind: "pipe", name: "cwstation-rig" });
    assert.equal(rigStatusEndpointAddress(endpoint), "\\\\.\\pipe\\cwstation-rig");
  } else {
    // Unix 上明确拒绝管道地址，且不把它误当成文件路径。
    assert.throws(() => parseRigStatusEndpoint("\\\\.\\pipe\\cwstation-rig"), RigStatusError);
    const endpoint = parseRigStatusEndpoint("./rig-status.sock");
    assert.equal(endpoint.kind, "unix");
    assert.equal(rigStatusEndpointAddress(endpoint), join(process.cwd(), "rig-status.sock"));
  }
});
