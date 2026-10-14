// daemon 入口：唯一拥有 TxController、FakeKeyer 与 SQLite 的进程。
// 启动顺序：显式配置 → 数据库锁 → 打开/迁移数据库 → 端点锁 → 独占端点 → 启动恢复。
// 恢复只在端点成功独占之后执行，避免双 daemon 同时操纵同一数据库。
//
// 运行参数来自：内置默认 < `--config <file>` < 已有 CWSTATION_* 环境变量 < CLI 路径旗标。
// 不自动搜索配置；故障注入变量（FAKE_FAULT/IGNORE_ABORT/DEV_COMMANDS）不进入配置文件。
//
// 停机：SIGTERM/SIGINT 与 RPC `daemon.stop` 共用同一个有界关闭路径。
// Windows 强制结束不会运行任何处理器，按崩溃处理，重启后由启动恢复发现 running→unknown。

import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "../packages/contracts/src/index.js";
import { FakeKeyer, type Keyer } from "../packages/core/src/keyer.js";
import { FakeRigClient } from "../packages/rig-control/src/client.js";
import { RemoteKeyer } from "../packages/rig-control/src/remote-keyer.js";
import { RemoteFakeSession } from "../packages/rig-control/src/fake-session.js";
import { ControllerError, TxController } from "../packages/core/src/tx-controller.js";
import { SqliteJournal } from "../packages/journal/src/sqlite.js";
import { DaemonServer } from "../packages/daemon/src/server.js";
import {
  parseRigStatusEndpoint,
  RigStatusError,
  type RigStatusEndpoint,
} from "../packages/rig-status/src/index.js";
import {
  ReadOnlyRigApprovalGate,
  ReadOnlyRejectingKeyer,
} from "../packages/rig-status/src/approval-gate.js";
import { acquireLock, LockedError, type LockHandle } from "../packages/daemon/src/lock.js";
import { canonicalPath, dbLockPath } from "../packages/daemon/src/paths.js";
import { canonicalEndpoint, endpointAddress, endpointLockPath, EndpointError } from "../packages/daemon/src/endpoint.js";
import { ConfigError, loadConfigFile, resolveDaemonConfig, type StationConfig } from "../packages/daemon/src/config.js";

interface CliArgs {
  socketPath?: string;
  dbPath?: string;
  configPath?: string;
  rigEndpoint?: string;
  remoteFakeLedger?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--socket" && next) {
      args.socketPath = next;
      i += 1;
    } else if (arg === "--db" && next) {
      args.dbPath = next;
      i += 1;
    } else if (arg === "--config" && next) {
      args.configPath = next;
      i += 1;
    } else if (arg === "--rig-endpoint" && next) {
      args.rigEndpoint = next;
      i += 1;
    } else if (arg === "--remote-fake-ledger" && next && !next.startsWith("--")) {
      if (args.remoteFakeLedger !== undefined) throw new Error("duplicate --remote-fake-ledger");
      args.remoteFakeLedger = next;
      i += 1;
    } else if (arg?.startsWith("--socket=")) {
      args.socketPath = arg.slice("--socket=".length);
    } else if (arg?.startsWith("--db=")) {
      args.dbPath = arg.slice("--db=".length);
    } else if (arg?.startsWith("--config=")) {
      args.configPath = arg.slice("--config=".length);
    } else if (arg?.startsWith("--rig-endpoint=")) {
      args.rigEndpoint = arg.slice("--rig-endpoint=".length);
    } else if (arg?.startsWith("--remote-fake-ledger=")) {
      if (args.remoteFakeLedger !== undefined) throw new Error("duplicate --remote-fake-ledger");
      args.remoteFakeLedger = arg.slice("--remote-fake-ledger=".length);
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        JSON.stringify({
          usage:
            "daemon [--config <file>] [--socket <unix-path|\\\\.\\pipe\\name>] [--db <path>] " +
            "[--rig-endpoint <path|\\\\.\\pipe\\name> | --remote-fake-ledger <dir>]",
          protocolVersion: PROTOCOL_VERSION,
        }) + "\n",
      );
      process.exit(0);
    } else if (arg && arg.length > 0) {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function envBool(name: string): boolean {
  const raw = process.env[name];
  return raw === "1" || raw === "true";
}

async function main(): Promise<void> {
  let config: StationConfig | undefined;
  let effective;
  let rigEndpoint: RigStatusEndpoint | undefined;
  let remoteFakeLedger: string | undefined;
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.configPath !== undefined) config = loadConfigFile(args.configPath);
    const overrides: { socketPath?: string; dbPath?: string } = {};
    if (args.socketPath !== undefined) overrides.socketPath = args.socketPath;
    if (args.dbPath !== undefined) overrides.dbPath = args.dbPath;
    effective = resolveDaemonConfig(config, overrides);
    if (args.rigEndpoint !== undefined) rigEndpoint = parseRigStatusEndpoint(args.rigEndpoint);
    if (args.remoteFakeLedger !== undefined) {
      if (!args.remoteFakeLedger.trim() || args.remoteFakeLedger.trim() !== args.remoteFakeLedger) throw new Error("invalid --remote-fake-ledger");
      if (rigEndpoint !== undefined) throw new Error("--rig-endpoint and --remote-fake-ledger are mutually exclusive");
      remoteFakeLedger = canonicalPath(args.remoteFakeLedger);
      if (remoteFakeLedger === canonicalPath(effective.dbPath) ||
          (effective.endpoint.kind === "unix" && remoteFakeLedger === canonicalPath(effective.endpoint.path))) {
        throw new Error("Fake ledger must be separate from database and control endpoint");
      }
    }
  } catch (error) {
    const code =
      error instanceof ConfigError
        ? error.code
        : error instanceof EndpointError
          ? error.code
          : error instanceof RigStatusError
            ? error.code
            : "usage";
    process.stderr.write(
      JSON.stringify({ event: "daemon.error", code, message: error instanceof Error ? error.message : String(error) }) + "\n",
    );
    process.exit(2);
    return;
  }

  // 端点与数据库都使用规范化形式：unix socket 解析符号链接别名；命名管道原样（不走文件系统）。
  const endpoint = canonicalEndpoint(effective.endpoint);
  const dbPath = canonicalPath(effective.dbPath);

  if (endpoint.kind === "unix") {
    // socket 目录：只有“由我们创建”时才收紧为 0700；
    // 用户显式传入的既有父目录（如 /tmp 或项目根）绝不 chmod，避免破坏他人权限。
    const socketDir = dirname(endpoint.path);
    const socketDirExisted = existsSync(socketDir);
    mkdirSync(socketDir, { recursive: true, mode: 0o700 });
    if (!socketDirExisted) {
      try {
        chmodSync(socketDir, 0o700);
      } catch {
        // socket 自身仍是 0600；目录权限收紧失败不致命。
      }
    }
  } else {
    // 命名管道本身不是文件；锁文件放在实际用户运行目录，需要先创建该目录。
    mkdirSync(dirname(endpointLockPath(endpoint)), { recursive: true });
  }

  // 打开数据库锁之前，确保数据库父目录存在。
  mkdirSync(dirname(dbPath), { recursive: true });

  // 显式附着真实只读入口时使用只读拒绝键控器；默认仍为 Fake，行为不变。
  let keyer: Keyer = rigEndpoint
    ? new ReadOnlyRejectingKeyer()
    : new FakeKeyer({
        durationMs: effective.fakeDurationMs,
        fault: process.env.CWSTATION_FAKE_FAULT ?? null,
        ignoreAbort: envBool("CWSTATION_FAKE_IGNORE_ABORT"),
      });

  const locks: LockHandle[] = [];
  const releaseAll = (): void => {
    for (const lock of locks.splice(0).reverse()) lock.release();
  };

  let journal: SqliteJournal | undefined;
  let server: DaemonServer | undefined;
  let approvalGate: ReadOnlyRigApprovalGate | undefined;
  let remoteClient: FakeRigClient | undefined;
  let remoteSession: RemoteFakeSession | undefined;
  let requestShutdown: ((signal: string) => Promise<void>) | undefined;
  let pendingShutdownReason: string | undefined;
  try {
    // 1) 数据库锁：防止两个 daemon 同时迁移/写入同一数据库。
    locks.push(acquireLock(dbLockPath(dbPath), "db", { dbPath }));
    journal = new SqliteJournal(dbPath);
    // Hold both owner locks before spawning the private Fake service.
    locks.push(acquireLock(endpointLockPath(endpoint), "socket", { socketPath: endpointAddress(endpoint), dbPath }));
    if (remoteFakeLedger !== undefined) {
      const entry = join(dirname(fileURLToPath(import.meta.url)), import.meta.url.endsWith(".ts") ? "rig-faked.ts" : "rig-faked.js");
      remoteClient = await FakeRigClient.start({ ledgerDir: remoteFakeLedger, entry,
        frequencyHz: journal.loadState().frequencyHz, deviceInstanceId: "fake-ic7300-01" });
      keyer = new RemoteKeyer({ client: remoteClient });
    }
    const controller = new TxController(
      TxController.loadState(journal, rigEndpoint || remoteClient ? { backendConnected: false } : {}),
      keyer,
      journal,
      {
        proposalTtlMs: effective.proposalTtlMs,
        approvalTtlMs: effective.approvalTtlMs,
        txTimeoutMs: effective.txTimeoutMs,
        approvalGuard: rigEndpoint
          ? (proposal) => {
              if (approvalGate === undefined) {
                throw new ControllerError("blocked", "read-only device approval gate is not initialized");
              }
              approvalGate.checkApproval(proposal);
            }
          : remoteClient ? (proposal) => {
              if (remoteSession === undefined) throw new ControllerError("blocked", "remote Fake session is not initialized");
              remoteSession.checkApproval(proposal);
            } : undefined,
      },
    );
    if (rigEndpoint !== undefined) {
      approvalGate = new ReadOnlyRigApprovalGate(controller, rigEndpoint);
    }
    if (remoteClient !== undefined) remoteSession = new RemoteFakeSession(controller, remoteClient, keyer as RemoteKeyer);
    const gate = approvalGate;

    // 2) 端点锁 + 独占端点。
    server = new DaemonServer({
      endpoint,
      dbPath,
      controller,
      journal,
      requestTimeoutMs: effective.requestTimeoutMs,
      maxFrameBytes: effective.maxFrameBytes,
      // 附着真实只读设备时禁用 dev.state，避免伪造状态或错误宣称解除 unknown。
      enableDevCommands: rigEndpoint || remoteClient ? false : envBool("CWSTATION_ENABLE_DEV_COMMANDS"),
      // 只有 FakeKeyer 时如实报告 Fake-only；附着只读设备时为 false。
      fakeOnly: rigEndpoint ? false : true,
      beforeDeviceCommand: gate ? () => gate.refresh() : remoteSession ? () => remoteSession!.refresh() : undefined,
      deviceStatus: gate ? () => gate.view() : remoteSession ? () => remoteSession!.view() : undefined,
      onTransportReady: async () => {
        controller.recoverOnStartup();
        await remoteSession?.start();
      },
      onStopRequested: (reason) => {
        if (requestShutdown) void requestShutdown(reason);
        else pendingShutdownReason = reason;
      },
    });
    await server.start();
    if (!server.listening || pendingShutdownReason) throw new Error("control transport failed during startup");

    // start verified the endpoint and completed recovery before admitting RPC.
    // core recoverOnStartup 已在 onTransportReady 中完成；随后启动只读设备门禁。
    if (gate !== undefined) await gate.start();
    if (!server.listening || pendingShutdownReason) throw new Error("control transport failed during device startup");

    process.stdout.write(
      JSON.stringify({
        event: "daemon.ready",
        protocolVersion: PROTOCOL_VERSION,
        pid: process.pid,
        platform: process.platform,
        endpointKind: endpoint.kind,
        socketPath: endpointAddress(endpoint),
        dbPath,
        configPath: config ? true : false,
        txTimeoutMs: effective.txTimeoutMs,
        at: new Date().toISOString(),
      }) + "\n",
    );

    let shuttingDown = false;
    const shutdown = async (signal: string): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      // 兜底看门狗：任何关闭路径都不能无限挂起。
      let exitCode = 0;
      const watchdog = setTimeout(() => {
        remoteClient?.kill();
        process.exit(remoteClient ? 1 : 0);
      }, effective.shutdownWatchdogMs);
      watchdog.unref();

      try {
        await server?.stop(async () => {
          const sessionClosing = remoteSession?.close();
          // 先断开只读 IPC（不关闭独立设备持有者），再关闭核心与 journal。
          try {
            await gate?.close();
          } catch {
            // 门禁关闭失败不阻塞核心关闭。
          }
          // 先撤销批准，再取消在途发射（由 controller.shutdown 有界完成）。
          try {
            const now = new Date().toISOString();
            journal?.transaction(() => {
              journal?.revokeAllApprovals(now, `daemon-shutdown:${signal}`);
            });
          } catch {
            // 数据库可能已不可写；仍继续取消在途。
            if (remoteClient) exitCode = 1;
          }
          try {
            await controller.shutdown(effective.shutdownTimeoutMs);
          } catch {
            if (remoteClient) exitCode = 1;
          }
          try { await sessionClosing; } catch { if (remoteClient) exitCode = 1; }
          if (remoteClient !== undefined) {
            let deviceClosed = false;
            try { deviceClosed = (await remoteClient.closeDevice()).closed; } catch { exitCode = 1; }
            try { await remoteClient.close(); } catch { exitCode = 1; }
            const cleanup = remoteClient.closeReport;
            if (!deviceClosed || !cleanup.confirmed) exitCode = 1;
            process.stdout.write(JSON.stringify({ event: "daemon.remote-fake.closed", ...cleanup, deviceClosed }) + "\n");
          }
        });
      } catch {
        // stop 内部已 fail-safe。
        if (remoteClient) exitCode = 1;
      }
      try {
        journal?.checkpoint();
        journal?.close();
      } catch {
        if (remoteClient) exitCode = 1;
      }
      releaseAll();
      clearTimeout(watchdog);
      process.stdout.write(JSON.stringify({ event: "daemon.stopped", signal, at: new Date().toISOString() }) + "\n");
      process.exit(exitCode);
    };
    requestShutdown = shutdown;
    if (pendingShutdownReason) void shutdown(pendingShutdownReason);

    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
  } catch (error) {
    try {
      await approvalGate?.close();
      await remoteSession?.close();
    } catch {
      // 忽略。
    }
    try { await remoteClient?.close(); } catch { remoteClient?.kill(); }
    try {
      await server?.stop();
    } catch {
      // 忽略。
    }
    try {
      journal?.close();
    } catch {
      // 忽略。
    }
    releaseAll();
    const code = error instanceof LockedError ? "locked" : "startup_failed";
    process.stderr.write(
      JSON.stringify({ event: "daemon.error", code, message: error instanceof Error ? error.message : String(error) }) + "\n",
    );
    process.exit(1);
  }
}

void main();
