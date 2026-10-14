// 测试辅助：在临时目录启动/停止 daemon 子进程，确保不触碰用户数据。
// 所有 daemon 使用随机端点与随机 SQLite；测试结束必须清理子进程与目录。
// daemon 的 stdout/stderr 同时写入工作区 logs/，便于失败后取证（不依赖易失的临时目录）。
//
// 平台端点：Unix 用临时 socket 文件；Windows 用随机本地命名管道（不经过文件系统）。
// 优雅停机：统一走 RPC daemon.stop（两平台一致）；Windows 的 SIGTERM 是强制结束，
// 不保证命中关闭处理器，因此测试的清理路径必须在超时后强制结束，按崩溃恢复处理。
// 崩溃/强制结束恢复另由 kill() + 同目录重启测试覆盖。

import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { DaemonClient, DaemonUnavailableError } from "../packages/daemon/src/client.js";
import { endpointAddress, parseEndpointAddress, type Endpoint } from "../packages/daemon/src/endpoint.js";

/** 从当前文件向上找到含 package.json 的项目根（同时适配源码与 dist/tests）。 */
function findProjectRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

export const ROOT = findProjectRoot(dirname(fileURLToPath(import.meta.url)));
const LOG_DIR = join(ROOT, "logs");

/** Windows 的 SIGTERM 不能触发优雅关闭；测试统一用 RPC stop，信号仅用于 Unix 语义测试。 */
export const IS_WINDOWS = process.platform === "win32";

/**
 * 判断由 import.meta.url 得到的文件是否位于给定目录内。
 * 不能简单拼接 "/"：Windows 路径分隔符是 "\"，旧写法会把 built 模式误判为源码模式。
 */
export function isInsideDirectory(file: string, dir: string): boolean {
  const rel = relative(dir, file);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

const BUILT = isInsideDirectory(fileURLToPath(import.meta.url), join(ROOT, "dist"));

/** 当前测试是否运行编译产物（dist）而非源码。 */
export function isBuiltMode(): boolean {
  return BUILT;
}

export function cliEntry(app: "cwctl" | "cwwave" | "cwmaint"): string[] {
  return BUILT ? [join(ROOT, "dist", "apps", `${app}.js`)] : ["--import", "tsx", join(ROOT, "apps", `${app}.ts`)];
}

function defaultEndpoint(dir: string): Endpoint {
  if (IS_WINDOWS) {
    return { kind: "pipe", name: `cwstation-test-${process.pid}-${randomBytes(6).toString("hex")}` };
  }
  return { kind: "unix", path: join(dir, "cw.sock") };
}

/** 为直接构造 DaemonServer 的测试提供平台兼容端点。 */
export function testEndpoint(dir: string): Endpoint {
  return defaultEndpoint(dir);
}

/** 是否可以创建符号链接（Windows 需开发者模式/特权；不可用时相关 Unix 语义测试明确跳过）。 */
export function canCreateSymlinks(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "cwstation-symlink-probe-"));
  try {
    const target = join(dir, "target");
    const link = join(dir, "link");
    writeFileSync(target, "probe");
    try {
      symlinkSync(target, link);
      return true;
    } catch {
      return false;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 测试期间创建的所有子进程；进程退出时兜底强制结束，避免遗留 daemon。 */
const liveChildren = new Set<ChildProcess>();
process.on("exit", () => {
  for (const child of liveChildren) {
    try {
      child.kill("SIGKILL");
    } catch {
      // 已退出。
    }
  }
});

function appendWorkspaceLog(name: string, chunk: Buffer | string): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(join(LOG_DIR, name), chunk);
  } catch {
    // 日志失败不影响测试结论。
  }
}

export interface DaemonHandle {
  readonly dir: string;
  /** 端点的连接地址（Unix 路径或 \\.\pipe\name）。 */
  readonly socketPath: string;
  readonly endpoint: Endpoint;
  readonly dbPath: string;
  readonly proc: ChildProcess;
  stdout(): string;
  stderr(): string;
  client(): Promise<DaemonClient>;
  /** 通过 RPC daemon.stop 请求优雅停机并等待退出；超时则强制结束。 */
  stop(): Promise<void>;
  /** 强制结束（模拟崩溃）；Windows 上即 TerminateProcess。 */
  kill(): void;
  /** 进程是否已结束（正常退出或被信号终止）。 */
  hasExited(): boolean;
  /** 等待进程结束（含被信号终止）；返回是否已结束。 */
  waitForTermination(timeoutMs?: number): Promise<boolean>;
  waitForExit(timeoutMs?: number): Promise<number | null>;
}

export interface StartOptions {
  env?: Record<string, string>;
  /** 复用已有目录（用于崩溃后重启同一数据库）。 */
  dir?: string;
  /** 覆盖端点地址（Unix 路径或 \\.\pipe\name）。 */
  socketPath?: string;
  /** 覆盖结构化端点（优先于 socketPath）。 */
  endpoint?: Endpoint;
  /** 覆盖数据库路径（用于验证父目录自动创建）。 */
  dbPath?: string;
  /** 用 `--config <file>` 启动；此时不再传 --socket/--db，调用方需提供匹配的 socketPath/dbPath。 */
  configPath?: string;
  /** 不等待 ready，仅返回句柄（用于第二 daemon 拒绝测试）。 */
  waitForReady?: boolean;
}

function spawnDaemon(
  socketPath: string,
  dbPath: string,
  env: Record<string, string>,
  configPath?: string,
): ChildProcess {
  const daemonArgs = BUILT ? ["dist/apps/daemon.js"] : ["--import", "tsx", "apps/daemon.ts"];
  if (configPath !== undefined) daemonArgs.push("--config", configPath);
  else daemonArgs.push("--socket", socketPath, "--db", dbPath);
  const proc = spawn(process.execPath, daemonArgs, {
      cwd: ROOT,
      env: { ...process.env, CWSTATION_ENABLE_DEV_COMMANDS: "1", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  liveChildren.add(proc);
  proc.once("exit", () => liveChildren.delete(proc));
  return proc;
}

function resolveEndpointOption(options: StartOptions, dir: string): Endpoint {
  if (options.endpoint) return options.endpoint;
  if (options.socketPath !== undefined) return parseEndpointAddress(options.socketPath, process.platform);
  return defaultEndpoint(dir);
}

export async function startDaemon(options: StartOptions = {}): Promise<DaemonHandle> {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "cwstation-test-"));
  const endpoint = resolveEndpointOption(options, dir);
  const socketPath = endpointAddress(endpoint);
  const dbPath = options.dbPath ?? join(dir, "cw.sqlite");
  const proc = spawnDaemon(socketPath, dbPath, options.env ?? {}, options.configPath);
  const logName = `daemon-${proc.pid ?? "unknown"}.log`;

  let out = "";
  let err = "";
  proc.stdout?.on("data", (chunk: Buffer) => {
    out += chunk.toString();
    appendWorkspaceLog(logName, chunk);
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    err += chunk.toString();
    appendWorkspaceLog(logName, chunk);
  });

  const handle: DaemonHandle = {
    dir,
    socketPath,
    endpoint,
    dbPath,
    proc,
    stdout: () => out,
    stderr: () => err,
    client: () => DaemonClient.connect(socketPath, { connectTimeoutMs: 3_000, requestTimeoutMs: 20_000 }),
    async stop() {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        cleanup(dir);
        return;
      }
      await requestGracefulStop(socketPath);
      const code = await handle.waitForExit(6_000);
      if (code === null) {
        // 优雅停机未完成（或端点不可达）：强制结束，绝不遗留 daemon。
        try {
          proc.kill("SIGKILL");
        } catch {
          // 已退出。
        }
        await handle.waitForExit(2_000);
      }
      cleanup(dir);
    },
    kill() {
      proc.kill("SIGKILL");
    },
    hasExited() {
      return proc.exitCode !== null || proc.signalCode !== null;
    },
    waitForTermination(timeoutMs = 5_000) {
      if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true);
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        proc.once("exit", () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
    },
    waitForExit(timeoutMs = 5_000) {
      if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(proc.exitCode);
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), timeoutMs);
        proc.once("exit", (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });
    },
  };

  if (options.waitForReady === false) return handle;

  try {
    await waitForReady(handle);
  } catch (error) {
    // 启动失败也要清理子进程，避免遗留 daemon 拖住测试进程。
    try {
      proc.kill("SIGKILL");
      await handle.waitForExit(2_000);
    } catch {
      // 忽略。
    }
    cleanup(dir);
    throw error;
  }
  return handle;
}

/** 通过 RPC daemon.stop 请求优雅停机；端点不可达时静默返回，由调用方决定强制结束。 */
async function requestGracefulStop(socketPath: string): Promise<void> {
  let client: DaemonClient | undefined;
  try {
    client = await DaemonClient.connect(socketPath, { connectTimeoutMs: 1_000, requestTimeoutMs: 5_000 });
    await client.request("daemon.stop", {});
  } catch {
    // 端点不可达/已关闭：交给强制结束兜底。
  } finally {
    client?.close();
  }
}

async function waitForReady(handle: DaemonHandle): Promise<void> {
  const deadline = Date.now() + 15_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (handle.proc.exitCode !== null) {
      throw new Error(`daemon exited early (${handle.proc.exitCode}): ${handle.stderr()}`);
    }
    // 命名管道的“存在”不能用文件系统判断，因此不做 existsSync 门控，直接尝试连接。
    let client: DaemonClient | undefined;
    try {
      client = await DaemonClient.connect(handle.socketPath, { connectTimeoutMs: 500 });
      await client.request("ping");
      client.close();
      return;
    } catch (error) {
      lastError = error;
      client?.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`daemon did not become ready: ${String(lastError)}`);
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // 临时目录清理失败不影响测试结论。
  }
}

/** 启动一个预期失败的 daemon 并返回其退出码与 stderr。 */
export async function startDaemonExpectFailure(
  dir: string,
  options: { env?: Record<string, string>; endpoint?: Endpoint; socketPath?: string } = {},
): Promise<{ code: number | null; stderr: string }> {
  const endpoint = resolveEndpointOption(options, dir);
  const socketPath = endpointAddress(endpoint);
  const dbPath = join(dir, "cw.sqlite");
  const proc = spawnDaemon(socketPath, dbPath, options.env ?? {});
  let err = "";
  proc.stderr?.on("data", (chunk: Buffer) => {
    err += chunk.toString();
    appendWorkspaceLog(`daemon-${proc.pid ?? "unknown"}.log`, chunk);
  });
  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve(null);
    }, 10_000);
    proc.once("exit", (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  return { code, stderr: err };
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export { DaemonUnavailableError };
