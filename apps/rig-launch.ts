// P2-003b rig-launch：统一 rig.sh 的启动与监督宿主。
//
// 边界（docs/tasks/P2-003b-rig启动监督.md）：
//  - 宿主同进程不打开任何串口；串口只由 fork 出的编译版 rig-controld 持有。
//  - 服务参数先经已有 parseRigStatusdArgs 显式校验，非法参数不 fork 任何进程。
//  - 父子之间只用私有 fork IPC（version 1）传 listening/ready/stopped/error 与
//    shutdown 命令；绝不扩展公开的 status/watch/reconnect 端点。
//  - 服务 stdout/stderr 持续消费进有界诊断缓存；需要落盘时只追加，不删除历史。
//  - 服务未报告 ready（初读完成）前不启动监视台；启动总期限 10s，失败不重试。
//  - 监视台退出或宿主收到 SIGINT/SIGTERM 时请求关闭；等待 stopped 与进程退出
//    （5s），超时定向强杀自家进程树（Windows 含 CwPipeBridge，等退出 2s）。
//  - 进程退出码 0 不是释放证据：只有收到 released:true 的 stopped 且未被强杀
//    才算关闭确认，否则报告“关闭未确认”并非零退出。

import { fork, spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rigStatusEndpointAddress } from "../packages/rig-status/src/index.js";
import { RIG_STATUSD_USAGE, parseRigStatusdArgs, type RigStatusdOptions } from "./rig-statusd.js";

const PROTOCOL_VERSION = 1 as const;
const STARTUP_DEADLINE_MS = 10_000;
const SHUTDOWN_DEADLINE_MS = 5_000;
const FORCE_KILL_DEADLINE_MS = 2_000;
const MONITOR_SIGNAL_GRACE_MS = 5_000;
const DIAGNOSTIC_LIMIT_CHARS = 8 * 1024;
const DIAGNOSTICS_FILE = "rig-launch-diagnostics.jsonl";

/** 宿主退出码：非零均代表未确认成功，具体码区分原因便于脚本与人工排查。 */
export const RIG_LAUNCH_EXIT_OK = 0;
export const RIG_LAUNCH_EXIT_FAILURE = 1;
export const RIG_LAUNCH_EXIT_USAGE = 2;
export const RIG_LAUNCH_EXIT_CLOSE_UNCONFIRMED = 3;

export const RIG_LAUNCH_USAGE =
  `rig-launch <service args>\nService args: ${RIG_STATUSD_USAGE}\n` +
  "The host forks dist/apps/rig-controld.js, then runs cwrig monitor on the same endpoint.";

interface ServiceFrame {
  readonly version?: unknown;
  readonly event?: unknown;
  readonly command?: unknown;
  readonly released?: unknown;
  readonly error?: unknown;
  readonly code?: unknown;
  readonly endpoint?: unknown;
}

interface StoppedEvidence {
  readonly released: boolean;
  readonly error: string | null;
}

type StartupResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reportHost(value: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify({ source: "rig-launch", ...value })}\n`);
}

/** 从当前模块位置向上找到含 package.json 的项目根，用于定位编译产物与日志。 */
function projectRoot(): string {
  let root = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(root, "package.json"))) return root;
    const parent = dirname(root);
    if (parent === root) throw new Error("cannot locate project root (package.json not found)");
    root = parent;
  }
}

/** 有界 stdout/stderr 诊断缓存：只保留最近 DIAGNOSTIC_LIMIT_CHARS 个字符。 */
class DiagnosticBuffer {
  private text = "";
  private overflowed = false;

  append(chunk: string): void {
    if (chunk.length === 0) return;
    this.text += chunk;
    if (this.text.length > DIAGNOSTIC_LIMIT_CHARS) {
      this.text = this.text.slice(this.text.length - DIAGNOSTIC_LIMIT_CHARS);
      this.overflowed = true;
    }
  }

  snapshot(): { text: string; truncated: boolean } {
    return { text: this.text, truncated: this.overflowed };
  }
}

function asServiceFrame(raw: unknown): ServiceFrame | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  return raw as ServiceFrame;
}

function frameText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

/** 在 timeoutMs 内等待一个只 resolve 的 promise；超时返回 false，不改动 promise。 */
function withTimeout(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, timeoutMs);
    const complete = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    };
    void promise.then(complete, complete);
  });
}

/**
 * 定向强杀自家进程树。Windows 用 taskkill /T /F 覆盖 rig-controld fork 出的
 * CwPipeBridge；参数以数组传入、不经 shell/cmd，也不执行任何用户参数。
 */
async function forceKillTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      const ended = new Promise<void>((done) => {
        killer.once("error", () => done());
        killer.once("close", () => done());
      });
      if (!(await withTimeout(ended, FORCE_KILL_DEADLINE_MS))) killer.kill();
    } catch {
      // 回退到下面的 child.kill。
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // 进程已退出或句柄已释放。
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  // 1) 显式复用服务参数解析器：非法参数直接失败，不 fork 任何进程。
  let options: RigStatusdOptions;
  try {
    options = parseRigStatusdArgs(argv);
  } catch (error) {
    reportHost({ event: "error", code: "usage", error: text(error), usage: RIG_LAUNCH_USAGE });
    return RIG_LAUNCH_EXIT_USAGE;
  }

  let root: string;
  let controldEntry: string;
  let cwrigEntry: string;
  try {
    root = projectRoot();
    controldEntry = join(root, "dist", "apps", "rig-controld.js");
    cwrigEntry = join(root, "dist", "apps", "cwrig.js");
    if (!existsSync(controldEntry)) throw new Error(`compiled service entry missing: ${controldEntry}`);
    if (!existsSync(cwrigEntry)) throw new Error(`compiled monitor entry missing: ${cwrigEntry}`);
  } catch (error) {
    reportHost({ event: "error", code: "build", error: text(error) });
    return RIG_LAUNCH_EXIT_FAILURE;
  }

  const endpointAddress = rigStatusEndpointAddress(options.endpoint);
  const diagnostics = new DiagnosticBuffer();
  let monitor: ChildProcess | undefined;
  const notifyServiceFault = (reason: string): void => {
    diagnostics.append(`${reason}\n`);
    if (monitor?.connected) {
      try { monitor.send({ version: 1, event: "service_fault", error: reason }, () => undefined); }
      catch { /* Monitor may already be closing. */ }
    }
  };

  let serviceExited = false;
  let serviceExitCode: number | null = null;
  let serviceExitSignal: NodeJS.Signals | null = null;
  let serviceDiedUnexpectedly = false;
  let serviceDisconnectedUnexpectedly = false;
  let shutdownRequested = false;
  let stoppedFrame: StoppedEvidence | null = null;
  let serviceAddress: string | null = null;

  let startupSettled = false;
  let resolveStartup: (result: StartupResult) => void = () => undefined;
  const startup = new Promise<StartupResult>((resolve) => {
    resolveStartup = resolve;
  });
  const settleStartup = (result: StartupResult): void => {
    if (startupSettled) return;
    startupSettled = true;
    resolveStartup(result);
  };

  let resolveServiceExit: () => void = () => undefined;
  const serviceExit = new Promise<void>((resolve) => {
    resolveServiceExit = resolve;
  });

  let resolveHostSignal: () => void = () => undefined;
  const hostSignal = new Promise<void>((resolve) => {
    resolveHostSignal = resolve;
  });
  let hostSignalled = false;
  const triggerSignal = (signal: NodeJS.Signals): void => {
    if (hostSignalled) return;
    hostSignalled = true;
    reportHost({ event: "signal", signal });
    resolveHostSignal();
  };
  const onSigint = (): void => triggerSignal("SIGINT");
  const onSigterm = (): void => triggerSignal("SIGTERM");

  // 2) 只 fork 编译后的 rig-controld，stdout/stderr 走管道持续消费，IPC 为私有通道。
  const service = fork(controldEntry, [...argv], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
    execArgv: [],
  });

  service.stdout?.on("data", (chunk: Buffer | string) => diagnostics.append(chunk.toString()));
  service.stderr?.on("data", (chunk: Buffer | string) => diagnostics.append(chunk.toString()));

  service.on("message", (raw: unknown) => {
    const frame = asServiceFrame(raw);
    if (frame === null) return;
    if (frame.version !== PROTOCOL_VERSION) {
      settleStartup({ ok: false, reason: `service supervision protocol version mismatch: ${String(frame.version)}` });
      return;
    }
    switch (frame.event) {
      case "listening":
        if (typeof frame.endpoint === "string") serviceAddress = frame.endpoint;
        break;
      case "ready":
        if (serviceAddress !== endpointAddress) {
          settleStartup({ ok: false, reason: "service endpoint mismatch or missing listening event" });
          break;
        }
        // 初读完成（可能带 fault 状态）即可启动监视台；故障由监视台展示。
        settleStartup({ ok: true });
        break;
      case "error":
        settleStartup({ ok: false, reason: `service error: ${frameText(frame.error, "unknown service error")}` });
        break;
      case "stopped":
        stoppedFrame = { released: frame.released === true, error: typeof frame.error === "string" ? frame.error : null };
        break;
      default:
        break;
    }
  });
  service.on("error", (error: Error) => {
    if (service.pid === undefined) {
      serviceExited = true;
      resolveServiceExit();
    }
    if (!shutdownRequested) {
      serviceDiedUnexpectedly = true;
      notifyServiceFault(`Device service unavailable: ${error.message}`);
    }
    diagnostics.append(`service process error: ${error.message}\n`);
    settleStartup({ ok: false, reason: `service process error: ${error.message}` });
  });
  service.on("disconnect", () => {
    if (!shutdownRequested && !serviceExited) {
      serviceDisconnectedUnexpectedly = true;
      notifyServiceFault("Device service control channel disconnected; restart rig.sh explicitly.");
    }
  });
  service.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
    serviceExited = true;
    serviceExitCode = code;
    serviceExitSignal = signal;
    if (!shutdownRequested) {
      serviceDiedUnexpectedly = true;
      notifyServiceFault(`Device service exited (code=${code}, signal=${signal}); restart rig.sh explicitly.`);
    }
    if (!startupSettled) {
      settleStartup({ ok: false, reason: `service exited before ready (code=${code ?? "null"}, signal=${signal ?? "null"})` });
    }
    resolveServiceExit();
  });

  const sendShutdownCommand = (): void => {
    if (!service.connected) return;
    try {
      service.send({ version: PROTOCOL_VERSION, command: "shutdown" }, () => undefined);
    } catch {
      // 通道已断开：无法请求关闭，由 released/stopped 缺失得出“关闭未确认”。
    }
  };

  const persistDiagnostics = (reason: string): void => {
    try {
      mkdirSync(join(root, "logs"), { recursive: true });
      const recorded = diagnostics.snapshot();
      const record = JSON.stringify({
        source: "rig-launch",
        time: new Date().toISOString(),
        reason,
        servicePid: service.pid ?? null,
        serviceExitCode,
        serviceExitSignal,
        stopped: stoppedFrame,
        diagnosticsTruncated: recorded.truncated,
        stdoutStderr: recorded.text,
      });
      // 只追加，绝不删除已有历史。
      appendFileSync(join(root, "logs", DIAGNOSTICS_FILE), `${record}\n`);
    } catch {
      // 诊断保留失败不能掩盖原始失败结论。
    }
  };

  let monitorStarted = false;
  let monitorExited = false;
  let monitorExitCode: number | null = null;
  let resolveMonitorExit: () => void = () => undefined;
  const monitorExit = new Promise<void>((resolve) => {
    resolveMonitorExit = resolve;
  });
  const spawnMonitor = (): void => {
    monitorStarted = true;
    monitor = fork(cwrigEntry, ["monitor", "--endpoint", endpointAddress], {
      cwd: root,
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      execArgv: [],
    });
    monitor.once("exit", (code: number | null) => {
      monitorExited = true;
      monitorExitCode = code;
      resolveMonitorExit();
    });
    monitor.on("error", (error: Error) => {
      diagnostics.append(`monitor process error: ${error.message}\n`);
      if (monitorExited) return;
      monitorExited = true;
      monitorExitCode = -1;
      resolveMonitorExit();
    });
  };

  /**
   * 幂等收尾：请求关闭、等 stopped 与退出（5s）、必要时强杀进程树（等 2s），
   * 并确保监视台不再存活。返回关闭是否被确认（released:true 且未被强杀）。
   */
  const finalize = async (): Promise<{ confirmed: boolean; forced: boolean; stopped: StoppedEvidence | null }> => {
    if (!shutdownRequested) {
      shutdownRequested = true;
      sendShutdownCommand();
    }
    let exited = serviceExited;
    if (!exited) exited = await withTimeout(serviceExit, SHUTDOWN_DEADLINE_MS);
    let forced = false;
    if (!exited) {
      forced = true;
      reportHost({ event: "force_kill", pid: service.pid ?? null });
      await forceKillTree(service);
      exited = await withTimeout(serviceExit, FORCE_KILL_DEADLINE_MS);
    }
    if (monitorStarted && !monitorExited && monitor !== undefined) {
      try {
        if (monitor.connected) monitor.send({ version: 1, command: "shutdown" }, () => undefined);
        else monitor.kill("SIGTERM");
      } catch {
        // 监视台已退出。
      }
      if (!(await withTimeout(monitorExit, MONITOR_SIGNAL_GRACE_MS))) {
        await forceKillTree(monitor);
        await withTimeout(monitorExit, FORCE_KILL_DEADLINE_MS);
      }
    }
    const confirmed = stoppedFrame !== null && stoppedFrame.released === true && !forced
      && serviceExited && serviceExitCode === 0 && (!monitorStarted || monitorExited);
    return { confirmed, forced, stopped: stoppedFrame };
  };

  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  const startupTimer = setTimeout(() => {
    settleStartup({ ok: false, reason: `service did not report ready within ${STARTUP_DEADLINE_MS}ms` });
  }, STARTUP_DEADLINE_MS);

  try {
    const startupOutcome = await Promise.race<StartupResult>([
      startup,
      hostSignal.then(() => ({ ok: false as const, reason: "host signal during startup" })),
    ]);
    clearTimeout(startupTimer);

    if (!startupOutcome.ok) {
      reportHost({ event: "startup_failed", error: startupOutcome.reason, servicePid: service.pid ?? null });
      const startupFinal = await finalize();
      persistDiagnostics(`startup failed: ${startupOutcome.reason}`);
      if (!startupFinal.confirmed) reportHost({ event: "close_unconfirmed", stopped: stoppedFrame !== null });
      return RIG_LAUNCH_EXIT_FAILURE;
    }

    reportHost({
      event: "ready",
      endpoint: endpointAddress,
      serviceEndpoint: serviceAddress,
      servicePid: service.pid ?? null,
      monitorPid: null,
    });

    // 启动过程中若已收到宿主信号，不启动监视台，直接收尾。
    if (!hostSignalled) {
      spawnMonitor();
      if (serviceExited || serviceDisconnectedUnexpectedly || serviceDiedUnexpectedly) {
        notifyServiceFault("Device service unavailable; restart rig.sh explicitly.");
      }
      await Promise.race([monitorExit, hostSignal]);
    }

    const final = await finalize();

    if (!final.confirmed) {
      const faulted = serviceDiedUnexpectedly || serviceDisconnectedUnexpectedly;
      persistDiagnostics(final.forced ? "service force-killed without confirmed release"
        : faulted ? "device service fault; release not confirmed" : "service release not confirmed");
      const stopped = final.stopped;
      reportHost({
        event: "close_unconfirmed",
        stopped: stopped !== null,
        stoppedReleased: stopped === null ? null : stopped.released,
        stoppedError: stopped === null ? null : stopped.error,
        forced: final.forced,
        serviceFault: faulted,
        serviceExited,
        serviceExitCode,
        serviceExitSignal,
      });
      return RIG_LAUNCH_EXIT_CLOSE_UNCONFIRMED;
    }

    if (serviceDiedUnexpectedly || serviceDisconnectedUnexpectedly) {
      persistDiagnostics("service exited unexpectedly");
      reportHost({
        event: "service_fault",
        exitedUnexpectedly: serviceDiedUnexpectedly,
        disconnectedUnexpectedly: serviceDisconnectedUnexpectedly,
        serviceExitCode,
        serviceExitSignal,
      });
      return RIG_LAUNCH_EXIT_FAILURE;
    }

    if (monitorExitCode !== null && monitorExitCode !== 0) {
      persistDiagnostics(`monitor exited with code ${monitorExitCode}`);
      reportHost({ event: "monitor_failed", exitCode: monitorExitCode });
      return RIG_LAUNCH_EXIT_FAILURE;
    }

    reportHost({ event: "closed", released: true, monitorExitCode });
    return RIG_LAUNCH_EXIT_OK;
  } catch (error) {
    diagnostics.append(`host failure: ${text(error)}\n`);
    const final = await finalize();
    persistDiagnostics(`host failure: ${text(error)}`);
    reportHost({ event: final.confirmed ? "host_failed" : "close_unconfirmed", error: text(error) });
    return final.confirmed ? RIG_LAUNCH_EXIT_FAILURE : RIG_LAUNCH_EXIT_CLOSE_UNCONFIRMED;
  } finally {
    clearTimeout(startupTimer);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
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
      reportHost({ event: "fatal", error: text(error) });
      process.exitCode = RIG_LAUNCH_EXIT_FAILURE;
    });
}
