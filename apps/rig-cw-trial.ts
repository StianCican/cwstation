// P2-015 受控 CW 试验 CLI（rig-controld --cw-trial 的显式路由目标）。
//
// 流程：记录目录未解决意图检查 → 显式 keying-off 与非 TTY 拒绝 → 打开唯一
// 试验 transport → 八查询预检 → 交互确认 → 重读八项核对 → 写前 fsync 记录
// 意图 → 一次固定短报文 → 只允许停止/退出。真实模式必须有 TTY 且必须由用户
// 输入报文本身确认；模拟模式用注入的 Fake transport 观察同一流程，绝不自动
// 确认真实发送。

import { createInterface } from "node:readline/promises";
import {
  CwTrialRecordStore,
  CwTrialSession,
  computeCwTrialContextFingerprint,
  createCwTrialSimulatorTransport,
  cwTrialContextEquals,
  evaluateCwTrialPreflight,
  CW_TRIAL_MESSAGES,
  type CwTrialContext,
  type CwTrialMessage,
  type CwTrialPreflight,
} from "../packages/cw-trial/src/index.js";
import { civPlanHex, planCivCwMessage, planCivCwStop, type CivTransport } from "../packages/devices/src/index.js";
// 直接从 serial.ts 引入独立命名的试验工厂，不扩大 packages/devices 公共出口。
import { openCwTrialSerialTransport } from "../packages/devices/src/serial.js";

export const CW_TRIAL_USAGE =
  "rig-controld --cw-trial --simulate [--message E|TEST] [--simulate-confirm E|TEST] [--simulate-ack ok|ng|none] [--record-dir <dir>]\n" +
  "       rig-controld --cw-trial --port <COMx> --confirm-keying-off [--message E|TEST] [--record-dir <dir>] [--timeout-ms N]";

const DEFAULT_RECORD_DIR = "logs/cw-trial";
const DEFAULT_TIMEOUT_MS = 2_000;

export interface CwTrialCliOptions {
  readonly simulate: boolean;
  readonly port: string | null;
  readonly confirmKeyingOff: boolean;
  readonly message: CwTrialMessage;
  readonly recordDir: string;
  readonly timeoutMs: number;
  readonly simulateConfirm: string | null;
  readonly simulateAck: "ok" | "ng" | "none";
  readonly help: boolean;
}

/** 解析 `--cw-trial` 之后的参数；非法组合抛普通 Error（由 main 转 usage）。 */
export function parseCwTrialArgs(argv: readonly string[]): CwTrialCliOptions {
  const allowed = [
    "--simulate",
    "--port",
    "--confirm-keying-off",
    "--message",
    "--record-dir",
    "--timeout-ms",
    "--simulate-confirm",
    "--simulate-ack",
    "--help",
  ];
  const seen = new Set<string>();
  let simulate = false;
  let port: string | null = null;
  let confirmKeyingOff = false;
  let message = "E";
  let recordDir = DEFAULT_RECORD_DIR;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let simulateConfirm: string | null = null;
  let simulateAck: "ok" | "ng" | "none" = "ok";
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (!allowed.includes(flag)) throw new Error(`--cw-trial: unknown argument ${flag}`);
    if (seen.has(flag)) throw new Error(`--cw-trial: duplicate argument ${flag}`);
    seen.add(flag);
    if (flag === "--simulate") {
      simulate = true;
      continue;
    }
    if (flag === "--confirm-keying-off") {
      confirmKeyingOff = true;
      continue;
    }
    if (flag === "--help") {
      help = true;
      continue;
    }
    const value = argv[++index];
    if (value === undefined || value.startsWith("--") || value.trim() !== value || value.length === 0) {
      throw new Error(`--cw-trial: missing or invalid value for ${flag}`);
    }
    if (flag === "--port") port = value;
    else if (flag === "--record-dir") recordDir = value;
    else if (flag === "--message") {
      if (!(CW_TRIAL_MESSAGES as readonly string[]).includes(value)) {
        throw new Error(`--cw-trial: message must be E or TEST, got ${value}`);
      }
      message = value;
    } else if (flag === "--timeout-ms") {
      if (!/^\d+$/.test(value)) throw new Error("--cw-trial: --timeout-ms must be an integer");
      timeoutMs = Number(value);
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
        throw new Error("--cw-trial: --timeout-ms must be 1..60000");
      }
    } else if (flag === "--simulate-confirm") simulateConfirm = value;
    else {
      if (value !== "ok" && value !== "ng" && value !== "none") {
        throw new Error("--cw-trial: --simulate-ack must be ok, ng or none");
      }
      simulateAck = value;
    }
  }

  if (help) {
    return { simulate, port, confirmKeyingOff, message: message as CwTrialMessage, recordDir, timeoutMs,
      simulateConfirm, simulateAck, help };
  }
  if (simulate) {
    if (port !== null || confirmKeyingOff) {
      throw new Error("--cw-trial: --simulate cannot be combined with --port or --confirm-keying-off");
    }
  } else {
    if (port === null) throw new Error("--cw-trial: real trial requires --port <COMx>");
    if (!confirmKeyingOff) {
      throw new Error("--cw-trial: real trial requires --confirm-keying-off (USB SEND/CW/RTTY mappings OFF)");
    }
  }
  return { simulate, port, confirmKeyingOff, message: message as CwTrialMessage, recordDir, timeoutMs,
    simulateConfirm, simulateAck, help };
}

export interface CwTrialIo {
  readonly isTTY: boolean;
  readonly signal?: AbortSignal;
  write(line: string): void;
  prompt(question: string): Promise<string>;
  close?(): void;
}

export interface CwTrialRunnerDeps {
  readonly io?: CwTrialIo;
  /** 测试注入：用给定参数创建一个独占 transport。 */
  readonly createTransport?: (options: CwTrialCliOptions) => Promise<CivTransport>;
  /** 测试注入：打开指定记录目录；真实路径默认 CwTrialRecordStore.open。 */
  readonly openStore?: (directory: string) => Promise<CwTrialRecordStore>;
}

class CwTrialInterrupted extends Error {}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultIo(): CwTrialIo {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY),
  });
  const inputClosed = new AbortController();
  readline.on("SIGINT", () => process.emit("SIGINT"));
  readline.once("close", () => inputClosed.abort(new CwTrialInterrupted("input closed")));
  return {
    isTTY: Boolean(process.stdin.isTTY),
    signal: inputClosed.signal,
    write: (line) => process.stdout.write(`${line}\n`),
    prompt: (question) => readline.question(question, { signal: inputClosed.signal }),
    close: () => readline.close(),
  };
}

async function defaultCreateTransport(options: CwTrialCliOptions): Promise<CivTransport> {
  if (options.simulate) {
    return createCwTrialSimulatorTransport({ ack: options.simulateAck });
  }
  return openCwTrialSerialTransport({
    portPath: options.port as string,
    baudRate: 19200,
    confirmKeyingOff: true,
    openTimeoutMs: options.timeoutMs,
    operationTimeoutMs: options.timeoutMs,
    closeTimeoutMs: options.timeoutMs,
  });
}

function printContext(io: CwTrialIo, context: CwTrialContext, preflight: CwTrialPreflight): void {
  io.write(
    `context: display=${context.displayFrequencyHz} Hz ${context.displayMode}/FIL${context.displayFilter}; ` +
      `txFrequency=${context.txFrequencyHz} Hz; txStatus=${context.txStatus}`,
  );
  io.write(
    `         split=${context.splitEnabled ? "ON" : "OFF"} rit=${context.ritEnabled ? "ON" : "OFF"} ` +
      `xit=${context.xitEnabled ? "ON" : "OFF"} breakIn=${context.breakIn}`,
  );
  for (const check of preflight.checks) {
    io.write(`  [${check.ok ? "ok" : "FAIL"}] ${check.id}: ${check.detail}`);
  }
}

function usageLine(): string {
  return `usage: ${CW_TRIAL_USAGE}`;
}

/**
 * 运行受控 CW 试验。返回进程退出码：
 * 0 成功/帮助；1 预检读取或内部错误；2 用法或无 TTY 拒绝；3 未解决意图/未确认/
 * 拒绝确认；4 预检不合格；5 确认后上下文变化或重读失败；6 关闭未确认；
 * 7 发送或停止未观察到应答。0仅表示命令流程完成，不证明物理完成/停止。
 */
export async function runCwTrial(argv: readonly string[], deps: CwTrialRunnerDeps = {}): Promise<number> {
  let options: CwTrialCliOptions;
  try {
    options = parseCwTrialArgs(argv);
  } catch (error) {
    const io = deps.io ?? defaultIo();
    io.write(`cw-trial: ${message(error)}`);
    io.write(usageLine());
    io.close?.();
    return 2;
  }
  if (options.help) {
    const io = deps.io ?? defaultIo();
    io.write(usageLine());
    io.close?.();
    return 0;
  }

  const io = deps.io ?? defaultIo();
  const ownsIo = deps.io === undefined;
  let store: CwTrialRecordStore | undefined;
  let session: CwTrialSession | undefined;
  let interruptError: CwTrialInterrupted | undefined;
  let rejectInterrupt: ((error: Error) => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectInterrupt = reject;
  });
  void interrupted.catch(() => undefined);
  const interrupt = (signal: string): void => {
    interruptError ??= new CwTrialInterrupted(`interrupted by ${signal}`);
    rejectInterrupt?.(interruptError);
  };
  const onSigint = (): void => interrupt("SIGINT");
  const onSigterm = (): void => interrupt("SIGTERM");
  const checkInterrupted = (): void => {
    if (interruptError) throw interruptError;
    io.signal?.throwIfAborted();
  };
  process.on("SIGINT", onSigint); process.on("SIGTERM", onSigterm);

  try {
    if (!options.simulate) {
      if (!options.confirmKeyingOff) {
        io.write("cw-trial: refusing to send without --confirm-keying-off");
        return 2;
      }
      if (!io.isTTY) {
        io.write("cw-trial: refusing a real trial without an interactive TTY; no bytes were sent");
        return 2;
      }
    }

    store = deps.openStore !== undefined
      ? await deps.openStore(options.recordDir)
      : await CwTrialRecordStore.open(options.recordDir);
    checkInterrupted();
    if (await store.hasUnresolvedIntent()) {
      io.write(
        `cw-trial: blocked; ${options.recordDir} has an unresolved send intent. ` +
          "Manual review is required and no automatic clear is provided.",
      );
      return 3;
    }
    checkInterrupted();

    const transport = await (deps.createTransport ?? defaultCreateTransport)(options);
    session = new CwTrialSession({ transport, queryTimeoutMs: options.timeoutMs });
    checkInterrupted();

    let context: CwTrialContext;
    try {
      context = await session.readContext();
      checkInterrupted();
    } catch (error) {
      io.write(`cw-trial: preflight read failed; no message was sent: ${message(error)}`);
      return 1;
    }
    const preflight = evaluateCwTrialPreflight(context);
    printContext(io, context, preflight);
    if (!preflight.ok) {
      io.write("cw-trial: preflight refused; no message was sent");
      return 4;
    }

    const fingerprint = computeCwTrialContextFingerprint({
      message: options.message,
      context,
      sessionInstanceId: session.sessionInstanceId,
    });
    let typed: string;
    if (options.simulate) {
      if (options.simulateConfirm === null) {
        io.write("cw-trial: simulation confirmation not provided; no message was sent");
        return 3;
      }
      typed = options.simulateConfirm;
    } else {
      typed = await Promise.race([io.prompt(
        `Type "${options.message}" to confirm ONE real CW send, anything else aborts: `,
      ), interrupted]);
    }
    checkInterrupted();
    if (typed !== options.message) {
      io.write("cw-trial: confirmation declined; no message was sent");
      return 3;
    }

    try {
      const reread = await session.readContext();
      checkInterrupted();
      const rereadFingerprint = computeCwTrialContextFingerprint({
        message: options.message,
        context: reread,
        sessionInstanceId: session.sessionInstanceId,
      });
      if (!cwTrialContextEquals(context, reread) || rereadFingerprint !== fingerprint) {
        io.write("cw-trial: context changed after confirmation; confirmation revoked; no message was sent");
        return 5;
      }
    } catch (error) {
      io.write(
        `cw-trial: re-read failed after confirmation; confirmation revoked; no message was sent: ${message(error)}`,
      );
      return 5;
    }

    // 写前持久化意图并 fsync；失败即不发送。
    await store.append({
      event: "intent",
      message: options.message,
      contextFingerprint: fingerprint,
      detail: `frame ${civPlanHex(planCivCwMessage(options.message))}`,
    });
    checkInterrupted();

    const send = await session.sendMessage(options.message);
    io.write(`cw-trial: send outcome=${send.outcome}; ${send.detail}`);
    await store.append({
      event: "send_result",
      message: options.message,
      contextFingerprint: fingerprint,
      detail: `outcome=${send.outcome}; ${send.detail}`,
    });

    let stopped = false;
    let acknowledged = send.outcome === "ack_observed";
    const requestStop = async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      await store!.append({
        event: "stop_intent",
        message: options.message,
        detail: `frame ${civPlanHex(planCivCwStop())}`,
      });
      const stop = await session!.sendStop();
      acknowledged = acknowledged && stop.outcome === "ack_observed";
      io.write(`cw-trial: stop outcome=${stop.outcome}; ${stop.detail}`);
      await store!.append({
        event: "stop_result",
        message: options.message,
        detail: `outcome=${stop.outcome}; ${stop.detail}`,
      });
    };

    if (options.simulate) {
      await requestStop();
    } else {
      for (;;) {
        let input: string;
        try {
          input = await Promise.race([
            io.prompt("S=stop  Q=exit: "),
            interrupted,
          ]);
        } catch (error) {
          if (error instanceof CwTrialInterrupted) {
            io.write("cw-trial: interrupt received; requesting stop and closing");
            await requestStop();
            break;
          }
          io.write("cw-trial: input closed; requesting stop and closing");
          await requestStop();
          break;
        }
        const command = input.trim().toLowerCase();
        if (command === "s") {
          await requestStop();
          continue;
        }
        if (command === "q") break;
        io.write("cw-trial: send attempted; completion is unknown. Enter S to request stop or Q to exit");
      }
      if (!stopped) await requestStop();
    }
    return acknowledged ? 0 : 7;
  } catch (error) {
    io.write(`cw-trial: failed: ${message(error)}`);
    return 1;
  } finally {
    process.off("SIGINT", onSigint); process.off("SIGTERM", onSigterm);
    let cleanupExit: number | undefined;
    if (session !== undefined) {
      try {
        await session.close();
      } catch (error) {
        cleanupExit = 6;
        io.write(`cw-trial: close error: ${message(error)}`);
      }
      if (store !== undefined) {
        try {
          await store.append({
            event: "session_close",
            detail: `closeConfirmed=${session.view().closeConfirmed}; phase=${session.view().phase}`,
          });
        } catch (error) {
          cleanupExit ??= 1;
          io.write(`cw-trial: close record error: ${message(error)}`);
        }
      }
    }
    if (ownsIo) io.close?.();
    // Cleanup evidence takes precedence over an earlier successful command flow.
    if (cleanupExit !== undefined) return cleanupExit;
  }
}
