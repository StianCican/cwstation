// P1-007 rig-statusd：独立只读电台状态守护进程。
//
// 它独占一个只读 CI-V 串口（或显式离线模拟），通过本地 NDJSON IPC 暴露
// status/watch/reconnect。它不读取数据库、不接入 daemon/core、不发射，也不
// 监听 TCP。
//
// 关闭顺序：收到 SIGINT/SIGTERM 时先关闭 transport/session，再关闭 IPC 端点。
// 连接失败后不自动重连；客户端必须显式调用 reconnect。

import { pathToFileURL } from "node:url";
import { SERIAL_ALLOWED_BAUD_RATES, SERIAL_DEFAULT_BAUD_RATE } from "../packages/devices/src/index.js";
import {
  RIG_STATUS_DEFAULT_POLL_INTERVAL_MS,
  RIG_STATUS_DEFAULT_QUERY_TIMEOUT_MS,
  RIG_STATUS_SOURCE,
  RigStatusError,
  RigStatusIpcServer,
  RigStatusHistoryWriter,
  RigStatusService,
  parseRigStatusEndpoint,
  type RigStatusEndpoint,
  type RigStatusServiceOptions,
} from "../packages/rig-status/src/index.js";

export const RIG_STATUSD_USAGE =
  "rig-statusd --endpoint <path|\\\\.\\pipe\\name> (--port COM17 --confirm-keying-off | --simulate) " +
  "[--baud 19200] [--interval-ms 1000] [--timeout-ms 2000] [--history <path>]";

/**
 * 私有父子 IPC 监督协议版本。仅在 rig-launch 以 fork 方式启动 rig-controld
 * 时使用，用于端点就绪、初读完成与关闭确认；它不扩展公开的
 * status/watch/reconnect 端点，也不是新的公开 RPC。
 */
export const RIG_STATUS_SUPERVISION_VERSION = 1 as const;

export interface RigStatusdOptions {
  readonly endpoint: RigStatusEndpoint;
  readonly portPath: string;
  readonly baudRate: number;
  readonly pollIntervalMs: number;
  readonly queryTimeoutMs: number;
  readonly simulate: boolean;
  readonly historyPath: string | null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function print(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/**
 * 仅当本进程由父进程以带 IPC 通道的 fork 启动时启用监督。直接运行
 * rig-statusd/rig-controld 时保持旧的独立模式，行为不变。
 */
function supervisionChannelPresent(): boolean {
  return typeof process.send === "function";
}

/** 向父进程发送一条监督事件；通道缺失或已断开时静默丢弃。 */
function sendSupervision(frame: Record<string, unknown>): Promise<void> {
  return new Promise((resolveSend) => {
    if (typeof process.send !== "function" || process.connected === false) { resolveSend(); return; }
    try { process.send({ version: RIG_STATUS_SUPERVISION_VERSION, ...frame }, () => resolveSend()); }
    catch { resolveSend(); }
  });
}

export function parseRigStatusdArgs(argv: readonly string[]): RigStatusdOptions {
  const seen = new Set<string>();
  let endpointRaw = "";
  let portPath = "";
  let baudRate = SERIAL_DEFAULT_BAUD_RATE;
  let pollIntervalMs = RIG_STATUS_DEFAULT_POLL_INTERVAL_MS;
  let queryTimeoutMs = RIG_STATUS_DEFAULT_QUERY_TIMEOUT_MS;
  let simulate = false;
  let keyingOff = false;
  let historyPath: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag === "--simulate") {
      if (simulate) throw new RigStatusError("config", "duplicate --simulate");
      simulate = true;
      continue;
    }
    if (flag === "--confirm-keying-off") {
      if (keyingOff) throw new RigStatusError("config", "duplicate --confirm-keying-off");
      keyingOff = true;
      continue;
    }
    if (!["--endpoint", "--port", "--baud", "--interval-ms", "--timeout-ms", "--history"].includes(flag) || seen.has(flag)) {
      throw new RigStatusError("config", `unknown or duplicate argument: ${flag}`);
    }
    seen.add(flag);
    const value = argv[++index];
    if (value === undefined || value.startsWith("--") || value.length === 0 || value.trim() !== value) {
      throw new RigStatusError("config", `missing or invalid value for ${flag}`);
    }
    if (flag === "--endpoint") {
      endpointRaw = value;
    } else if (flag === "--history") {
      historyPath = value;
    } else if (flag === "--port") {
      portPath = value;
    } else {
      if (!/^\d+$/.test(value)) throw new RigStatusError("config", `invalid number for ${flag}`);
      const number = Number(value);
      if (flag === "--baud") baudRate = number;
      else if (flag === "--interval-ms") pollIntervalMs = number;
      else queryTimeoutMs = number;
    }
  }

  if (endpointRaw.length === 0) throw new RigStatusError("config", "--endpoint is required");
  if (!SERIAL_ALLOWED_BAUD_RATES.includes(baudRate)) {
    throw new RigStatusError("config", `--baud must be one of ${SERIAL_ALLOWED_BAUD_RATES.join(", ")}`);
  }
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 50 || pollIntervalMs > 60_000) {
    throw new RigStatusError("config", "--interval-ms must be an integer in [50, 60000]");
  }
  if (!Number.isInteger(queryTimeoutMs) || queryTimeoutMs < 1 || queryTimeoutMs > 60_000) {
    throw new RigStatusError("config", "--timeout-ms must be an integer in [1, 60000]");
  }
  if (!simulate) {
    if (portPath.length === 0) throw new RigStatusError("config", "--port is required unless --simulate");
    if (!keyingOff) {
      throw new RigStatusError(
        "config",
        "--confirm-keying-off is required unless --simulate (USB SEND / CW / RTTY mappings must be OFF)",
      );
    }
  }

  return {
    endpoint: parseRigStatusEndpoint(endpointRaw),
    portPath,
    baudRate,
    pollIntervalMs,
    queryTimeoutMs,
    simulate,
    historyPath,
  };
}

export async function main(argv: readonly string[]): Promise<number> {
  let options: RigStatusdOptions;
  try {
    options = parseRigStatusdArgs(argv);
  } catch (error) {
    print({
      source: RIG_STATUS_SOURCE,
      readOnly: true,
      event: "error",
      code: error instanceof RigStatusError ? error.code : "usage",
      error: message(error),
      usage: RIG_STATUSD_USAGE,
    });
    return 2;
  }

  const supervised = supervisionChannelPresent();
  const history = options.historyPath === null ? null : new RigStatusHistoryWriter(options.historyPath);
  const serviceOptions: RigStatusServiceOptions = {
    portPath: options.portPath,
    baudRate: options.baudRate,
    pollIntervalMs: options.pollIntervalMs,
    queryTimeoutMs: options.queryTimeoutMs,
    simulate: options.simulate,
    ...(history === null ? {} : { historySink: history }),
  };
  const service = new RigStatusService(serviceOptions);
  const server = new RigStatusIpcServer({ endpoint: options.endpoint, service });

  let shuttingDown = false;
  let startupOperation: Promise<void> | null = null;
  let released = true;
  const releaseErrors: string[] = [];
  let finish: () => void = () => undefined;
  const done = new Promise<void>((resolveDone) => {
    finish = resolveDone;
  });
  /**
   * 幂等关闭：先释放 transport/session，再关 IPC 端点与历史。任何一步失败都
   * 记为 released=false 并保留错误文本，绝不吞掉关闭失败冒充成功。错误不会
   * 阻止 finish()，挂起由宿主期限兜底。
   */
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await service.stop();
    } catch (error) {
      released = false;
      releaseErrors.push(`service stop failed: ${message(error)}`);
    }
    await startupOperation?.catch(() => undefined);
    try {
      await server.stop();
    } catch (error) {
      released = false;
      releaseErrors.push(`ipc endpoint stop failed: ${message(error)}`);
    }
    try {
      await history?.close();
    } catch (error) {
      released = false;
      releaseErrors.push(`history close failed: ${message(error)}`);
    }
    if (supervised) {
      if (releaseErrors.length === 0) await sendSupervision({ event: "stopped", released });
      else await sendSupervision({ event: "stopped", released, error: releaseErrors.join("; ") });
      try {
        process.disconnect();
      } catch {
        // 父进程已先断开；此时通道本就不存在。
      }
    }
    if (!released) print({ event: "close_unconfirmed", readOnly: true, error: releaseErrors.join("; ") });
    finish();
  };
  // 旧的 SIGINT/SIGTERM 路径与监督关闭走同一实现：关闭失败同样上报，不冒充成功。
  const onSignal = (): void => { void shutdown(); };
  // 私有监督命令：只认版本 1 的 shutdown。不新增任何公开 status/watch/reconnect 端点。
  const onMessage = (raw: unknown): void => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return;
    const frame = raw as { version?: unknown; command?: unknown };
    if (frame.version !== RIG_STATUS_SUPERVISION_VERSION || frame.command !== "shutdown") return;
    void shutdown();
  };
  // 宿主异常退出导致 IPC 断开时，服务必须自行关闭而不是泄漏串口。
  const onDisconnect = (): void => { void shutdown(); };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  if (supervised) {
    process.on("message", onMessage);
    process.on("disconnect", onDisconnect);
    if (!process.connected) onDisconnect();
  }

  try {
    startupOperation = (async () => {
    await server.start();
    // 关闭竞态：已进入关闭流程时不再发 listening/ready，避免虚假就绪。
    if (!shuttingDown) {
      print({
        source: RIG_STATUS_SOURCE,
        readOnly: true,
        event: "listening",
        endpoint: server.address,
        simulation: options.simulate,
        pollIntervalMs: options.pollIntervalMs,
        historyPath: history?.path ?? null,
        pid: process.pid,
      });
      await sendSupervision({
        event: "listening",
        endpoint: server.address,
        simulation: options.simulate,
        historyPath: history?.path ?? null,
        pid: process.pid,
      });
      if (shuttingDown) return;
      const report = await service.start();
      if (!shuttingDown) {
        print({ event: "status", ...report });
        await sendSupervision({
          event: "ready",
          status: report.status,
          stale: report.stale,
          error: report.error,
          snapshot: report.snapshot,
          portPath: report.portPath,
          baudRate: report.baudRate,
          simulation: report.simulation,
        });
      }
    }
    })();
    await startupOperation;
    await done;
    // 正常退出（含 SIGINT/SIGTERM 与监督 shutdown）也必须检查释放结论。
    return released ? 0 : 1;
  } catch (error) {
    if (!shuttingDown) {
      const code = error instanceof RigStatusError ? error.code : "internal";
      print({
        source: RIG_STATUS_SOURCE,
        readOnly: true,
        event: "error",
        code,
        error: message(error),
      });
      await sendSupervision({ event: "error", code, error: message(error) });
    }
    await shutdown();
    await done;
    return 1;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    if (supervised) {
      process.off("message", onMessage);
      process.off("disconnect", onDisconnect);
    }
  }
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return pathToFileURL(entry).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      print({ source: RIG_STATUS_SOURCE, readOnly: true, event: "error", code: "internal", error: message(error) });
      process.exitCode = 1;
    });
}
