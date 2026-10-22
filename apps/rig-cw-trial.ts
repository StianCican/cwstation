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
  cwTrialIntentDigest,
  type CwTrialContext,
  type CwTrialMessage,
  type CwTrialPreflight,
} from "../packages/cw-trial/src/index.js";
import { civPlanHex, planCivCwMessage, planCivCwStop, type CivTransport } from "../packages/devices/src/index.js";
// 直接从 serial.ts 引入独立命名的试验工厂，不扩大 packages/devices 公共出口。
import { openCwTrialSerialTransport } from "../packages/devices/src/serial.js";
import type { ReplyDispatchControl, ReplyDispatchLease } from "./reply-dispatch-control.js";

export const CW_TRIAL_USAGE =
  "rig-controld --cw-trial --simulate [--message E|TEST] [--simulate-confirm E|TEST] [--simulate-ack ok|ng|none] [--record-dir <dir>]\n" +
  "       rig-controld --cw-trial --port <COMx> --confirm-keying-off [--message E|TEST] [--record-dir <dir>] [--timeout-ms N]\n" +
  "       rig-controld --cw-trial --review-intent <id> --operator <name> --note <basis> [--record-dir <dir>] (TTY; no transport)";

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

/**
 * 进程内绑定：只用于 V00-03-B 的已校验回复提案。
 * 绝不从 CLI 参数读取任意文本，也不向真实发送入口开放。
 */
export interface CwTrialReplyBinding {
  readonly text: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly revision: number;
  /** 调用者保留提案有效性；每次异步步骤后、意图落盘后再次检查。 */
  readonly isCurrent: () => boolean;
}

export interface CwTrialRunnerDeps {
  readonly io?: CwTrialIo;
  readonly signal?: AbortSignal;
  /** 测试注入：用给定参数创建一个独占 transport。 */
  readonly createTransport?: (options: CwTrialCliOptions) => Promise<CivTransport>;
  /** 测试注入：打开指定记录目录；真实路径默认 CwTrialRecordStore.open。 */
  readonly openStore?: (directory: string) => Promise<CwTrialRecordStore>;
  /** 仅接收链路在进程内传入；只允许模拟模式并要求 TTY 完整正文确认。 */
  readonly replyProposal?: CwTrialReplyBinding;
  /**
   * V00-04-A：同一进程内的会话授权。只决定自动/人工与一次性 lease，
   * 不接收设备、草稿或发送循环。缺省时保持原人工确认路径。
   */
  readonly replyDispatch?: ReplyDispatchControl;
  /** Desktop-only simulated reply confirmation, requested after preflight.
   * Must return the exact text typed by the operator; never valid for a real port. */
  readonly confirmSimulatedReply?: (text: string) => Promise<string | null>;
}

class CwTrialInterrupted extends Error {}
class CwTrialDispatchRevoked extends Error {}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 人工编辑草稿的有界次数；非法编辑也计入，避免无限提示。 */
const MAX_REPLY_EDITS = 3;

function validateCwText(text: string): string | null {
  if (typeof text !== "string" || text.trim().length === 0) return "text must be a non-empty string";
  if (/[a-z]/.test(text)) return "text must already be uppercase ASCII";
  if (text.includes("^")) return "text must not request continuous keying";
  try {
    planCivCwMessage(text);
  } catch (error) {
    return `text is not a legal CW message: ${message(error)}`;
  }
  return null;
}

function validateReplyBinding(binding: CwTrialReplyBinding): string | null {
  const invalidText = validateCwText(binding.text);
  if (invalidText !== null) return invalidText;
  if (typeof binding.sessionId !== "string" || binding.sessionId.length === 0) return "sessionId must be non-empty";
  if (typeof binding.turnId !== "string" || binding.turnId.length === 0) return "turnId must be non-empty";
  if (!Number.isInteger(binding.revision) || binding.revision < 1) return "revision must be a positive integer";
  if (typeof binding.isCurrent !== "function") return "proposal validity check is required";
  return null;
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
  if (argv.includes("--review-intent")) return runIntentReview(argv, deps);
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
  if (deps.confirmSimulatedReply !== undefined
      && (!options.simulate || deps.replyProposal === undefined
        || typeof deps.confirmSimulatedReply !== "function"
        || deps.replyDispatch?.mode === "automatic")) {
    io.write("cw-trial: desktop confirmation requires a manual simulated reply; no message was sent");
    if (ownsIo) io.close?.();
    return 2;
  }
  if (deps.replyDispatch !== undefined && deps.replyProposal === undefined) {
    io.write("cw-trial: a reply dispatch control requires a reply proposal binding; no message was sent");
    if (ownsIo) io.close?.();
    return 2;
  }
  const binding = deps.replyProposal === undefined ? undefined : { ...deps.replyProposal };
  let messageText: string = options.message;
  let replyDetail = "";
  let automaticLease: ReplyDispatchLease | undefined;
  let automaticConsumed = false;
  if (binding !== undefined) {
    if (!options.simulate) {
      io.write("cw-trial: a reply proposal binding is only permitted in simulation; no message was sent");
      if (ownsIo) io.close?.();
      return 2;
    }
    if (!io.isTTY && deps.confirmSimulatedReply === undefined && deps.replyDispatch?.mode !== "automatic") {
      io.write("cw-trial: a reply proposal requires an interactive TTY; no message was sent");
      if (ownsIo) io.close?.();
      return 2;
    }
    if (options.simulateConfirm !== null) {
      io.write("cw-trial: a reply proposal cannot use an automatic confirmation; no message was sent");
      if (ownsIo) io.close?.();
      return 2;
    }
    const invalid = validateReplyBinding(binding);
    if (invalid !== null) {
      io.write(`cw-trial: invalid reply proposal binding: ${invalid}; no message was sent`);
      if (ownsIo) io.close?.();
      return 2;
    }
    messageText = binding.text;
    replyDetail = `; reply=${JSON.stringify({
      text: binding.text,
      sessionId: binding.sessionId,
      turnId: binding.turnId,
      revision: binding.revision,
    })}`;
    if (deps.replyDispatch !== undefined && deps.replyDispatch.mode === "automatic") {
      const authorization = deps.replyDispatch.authorize({
        text: binding.text,
        sessionId: binding.sessionId,
        turnId: binding.turnId,
        revision: binding.revision,
      }, binding.isCurrent);
      if (!authorization.authorized) {
        io.write(`cw-trial: automatic dispatch refused (${authorization.reason}); no message was sent`);
        if (ownsIo) io.close?.();
        return 3;
      }
      automaticLease = authorization.lease;
      io.write(`cw-trial: automatic dispatch armed; confirmation prompt skipped (generation ${authorization.lease.generation})`);
    }
  }
  const recordMessage = binding === undefined ? options.message : null;
  let store: CwTrialRecordStore | undefined;
  let releaseRecords: (() => Promise<void>) | undefined;
  let session: CwTrialSession | undefined;
  let stopped = false;
  let acknowledged = false;
  let stopRecordFailed = false;
  const requestStop = async (): Promise<void> => {
    if (stopped || !session?.view().messageAttempted) return;
    stopped = true;
    let intentDiagnostic: string | undefined;
    let resultDiagnostic: string | undefined;
    // A failed post-send record must not suppress the one best-effort stop.
    try {
      await store!.append({
        event: "stop_intent",
        message: recordMessage,
        detail: `frame ${civPlanHex(planCivCwStop())}${replyDetail}`,
      });
    } catch (error) {
      stopRecordFailed = true;
      intentDiagnostic = `cw-trial: stop intent record failed: ${message(error)}`;
    }
    const stop = await session.sendStop();
    acknowledged = acknowledged && stop.outcome === "ack_observed";
    try {
      await store!.append({
        event: "stop_result",
        message: recordMessage,
        detail: `outcome=${stop.outcome}; ${stop.detail}${replyDetail}`,
      });
    } catch (error) {
      stopRecordFailed = true;
      resultDiagnostic = `cw-trial: stop result record failed: ${message(error)}`;
    }
    // Diagnostics may throw; attempt the stop and its record before printing.
    if (intentDiagnostic !== undefined) io.write(intentDiagnostic);
    io.write(`cw-trial: stop outcome=${stop.outcome}; ${stop.detail}`);
    if (resultDiagnostic !== undefined) io.write(resultDiagnostic);
  };
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
  const onExternalAbort = (): void => interrupt("caller cancellation");
  const onDispatchStop = (): void => interrupt("session stop");
  const checkInterrupted = (): void => {
    if (interruptError) throw interruptError;
    io.signal?.throwIfAborted();
    deps.signal?.throwIfAborted();
    deps.replyDispatch?.signal.throwIfAborted();
    if (binding !== undefined && !binding.isCurrent()) {
      throw new CwTrialInterrupted("reply proposal is no longer current");
    }
  };
  const checkAutomatic = (stage: string): void => {
    if (automaticLease === undefined) return;
    const denial = deps.replyDispatch!.check(automaticLease, binding!.isCurrent);
    if (denial !== null) {
      throw new CwTrialDispatchRevoked(`automatic dispatch authorization lost (${denial}) after ${stage}`);
    }
  };
  process.on("SIGINT", onSigint); process.on("SIGTERM", onSigterm);
  deps.signal?.addEventListener("abort", onExternalAbort, { once: true });
  if (deps.signal?.aborted) onExternalAbort();
  deps.replyDispatch?.signal.addEventListener("abort", onDispatchStop, { once: true });
  if (deps.replyDispatch?.signal.aborted) onDispatchStop();

  try {
    checkInterrupted();
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
    releaseRecords = await store.acquireExclusive();
    checkInterrupted();
    checkAutomatic("record open");
    if (await store.hasUnresolvedIntent()) {
      io.write(
        `cw-trial: blocked; ${options.recordDir} has an unresolved send intent. ` +
          "Use --review-intent <id> --operator <name> --note <basis> for explicit TTY review; no automatic clear is provided.",
      );
      return 3;
    }
    checkInterrupted();
    checkAutomatic("unresolved intent check");

    const transport = await (deps.createTransport ?? defaultCreateTransport)(options);
    session = new CwTrialSession({ transport, queryTimeoutMs: options.timeoutMs });
    checkInterrupted();
    checkAutomatic("transport open");

    let context: CwTrialContext;
    try {
      context = await session.readContext();
    } catch (error) {
      io.write(`cw-trial: preflight read failed; no message was sent: ${message(error)}`);
      return 1;
    }
    checkInterrupted();
    checkAutomatic("preflight read");
    const preflight = evaluateCwTrialPreflight(context);
    printContext(io, context, preflight);
    if (!preflight.ok) {
      io.write("cw-trial: preflight refused; no message was sent");
      return 4;
    }

    let fingerprint = computeCwTrialContextFingerprint({
      message: messageText,
      context,
      sessionInstanceId: session.sessionInstanceId,
    });
    let typed = "";
    if (binding !== undefined) {
      if (!io.isTTY && deps.confirmSimulatedReply === undefined && automaticLease === undefined) {
        io.write("cw-trial: a reply proposal requires an interactive TTY; no message was sent");
        return 2;
      }
      if (deps.confirmSimulatedReply !== undefined) {
        typed = await Promise.race([deps.confirmSimulatedReply(messageText), interrupted]) ?? "";
        checkInterrupted();
      } else if (automaticLease === undefined) {
        // 草稿只存在 runner 本地；AI 提案副本不会被改写，取消时草稿仍可见。
        let edits = 0;
        for (;;) {
          typed = await Promise.race([io.prompt(
            `Type ${JSON.stringify(messageText)} exactly to confirm ONE simulated CW send, `
              + "EDIT <text> to change, anything else aborts: ",
          ), interrupted]);
          checkInterrupted();
          if (typed === messageText) break;
          if (!typed.startsWith("EDIT ")) {
            io.write("cw-trial: confirmation declined; no message was sent");
            return 3;
          }
          edits += 1;
          if (edits > MAX_REPLY_EDITS) {
            io.write("cw-trial: too many reply edits; no message was sent");
            return 3;
          }
          const candidate = typed.slice("EDIT ".length);
          const invalidEditedText = validateCwText(candidate);
          if (invalidEditedText !== null) {
            io.write(
              `cw-trial: invalid edited reply text: ${invalidEditedText}; `
                + `the draft stays ${JSON.stringify(messageText)}; re-enter EDIT <text> or type the final text`,
            );
            continue;
          }
          messageText = candidate;
          fingerprint = computeCwTrialContextFingerprint({
            message: messageText,
            context,
            sessionInstanceId: session.sessionInstanceId,
          });
          replyDetail = `; reply=${JSON.stringify({
            text: messageText,
            sessionId: binding.sessionId,
            turnId: binding.turnId,
            revision: binding.revision,
            edited: true,
          })}`;
          io.write(`cw-trial: reply draft updated to ${JSON.stringify(messageText)}; type it exactly to confirm`);
        }
      }
    } else if (options.simulate) {
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
    checkAutomatic("confirmation");
    if (automaticLease === undefined && typed !== messageText) {
      io.write("cw-trial: confirmation declined; no message was sent");
      return 3;
    }

    try {
      const reread = await session.readContext();
      checkInterrupted();
      checkAutomatic("re-read");
      const rereadFingerprint = computeCwTrialContextFingerprint({
        message: messageText,
        context: reread,
        sessionInstanceId: session.sessionInstanceId,
      });
      if (!cwTrialContextEquals(context, reread) || rereadFingerprint !== fingerprint) {
        io.write("cw-trial: context changed after confirmation; confirmation revoked; no message was sent");
        return 5;
      }
    } catch (error) {
      if (error instanceof CwTrialDispatchRevoked) throw error;
      io.write(
        `cw-trial: re-read failed after confirmation; confirmation revoked; no message was sent: ${message(error)}`,
      );
      return 5;
    }

    // 写前持久化意图并 fsync；失败即不发送。
    await store.append({
      event: "intent",
      message: recordMessage,
      contextFingerprint: fingerprint,
      detail: `frame ${civPlanHex(planCivCwMessage(messageText))}${replyDetail}`,
    });
    checkInterrupted();
    checkAutomatic("intent flush");

    if (automaticLease !== undefined) {
      io.write("cw-trial: automatic dispatch ready for one-time consumption");
      checkInterrupted();
      // 紧邻发送前的一次消费；check 同时复核模式、代次、精确身份与取消。
      const denial = deps.replyDispatch!.consume(automaticLease, binding!.isCurrent);
      if (denial !== null) {
        io.write(
          `cw-trial: automatic dispatch authorization lost (${denial}) immediately before send; no message was sent`,
        );
        return 3;
      }
      automaticConsumed = true;
    }

    const send = await session.sendMessage(messageText);
    acknowledged = send.outcome === "ack_observed";
    if (automaticConsumed) io.write("cw-trial: automatic dispatch consumed once; the same proposal cannot dispatch again");
    io.write(`cw-trial: send outcome=${send.outcome}; ${send.detail}`);
    try {
      await store.append({
        event: "send_result",
        message: recordMessage,
        contextFingerprint: fingerprint,
        detail: `outcome=${send.outcome}; ${send.detail}${replyDetail}`,
      });
    } catch (error) {
      io.write(`cw-trial: send result record failed: ${message(error)}`);
      throw error;
    }

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
    return stopRecordFailed ? 1 : acknowledged ? 0 : 7;
  } catch (error) {
    try {
      await requestStop();
    } catch (stopError) {
      io.write(`cw-trial: stop failed: ${message(stopError)}`);
    }
    io.write(`cw-trial: failed: ${message(error)}`);
    if (binding !== undefined) {
      io.write(`cw-trial: reply draft retained: ${JSON.stringify(messageText)}`);
    }
    return error instanceof CwTrialDispatchRevoked ? 3 : 1;
  } finally {
    process.off("SIGINT", onSigint); process.off("SIGTERM", onSigterm);
    deps.signal?.removeEventListener("abort", onExternalAbort);
    deps.replyDispatch?.signal.removeEventListener("abort", onDispatchStop);
    if (automaticLease !== undefined && !automaticConsumed) deps.replyDispatch?.revoke();
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
    try { await releaseRecords?.(); }
    catch (error) { cleanupExit ??= 1; io.write(`cw-trial: record lock release failed: ${message(error)}`); }
    if (ownsIo) io.close?.();
    // Cleanup evidence takes precedence over an earlier successful command flow.
    if (cleanupExit !== undefined) return cleanupExit;
  }
}

async function runIntentReview(argv: readonly string[], deps: CwTrialRunnerDeps): Promise<number> {
  const io = deps.io ?? defaultIo();
  let release: (() => Promise<void>) | undefined;
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  const check = (): void => { controller.signal.throwIfAborted(); deps.signal?.throwIfAborted(); io.signal?.throwIfAborted(); };
  process.on("SIGINT", abort); process.on("SIGTERM", abort);
  deps.signal?.addEventListener("abort", abort, { once: true });
  io.signal?.addEventListener("abort", abort, { once: true });
  let exit = 1;
  try {
    const values = new Map<string, string>();
    for (let index = 0; index < argv.length; index += 2) {
      const flag = argv[index]!, value = argv[index + 1];
      if (!["--review-intent", "--operator", "--note", "--record-dir"].includes(flag)
          || values.has(flag) || value === undefined || value.startsWith("--") || !value.trim()) throw new Error("invalid review arguments; review cannot be combined with sending");
      values.set(flag, value);
    }
    const id = values.get("--review-intent"), operator = values.get("--operator"), note = values.get("--note");
    if (!id || !operator || !note || !io.isTTY || deps.replyProposal || deps.replyDispatch || deps.confirmSimulatedReply) {
      throw new Error("review requires --review-intent, --operator, --note and an interactive TTY, without reply dispatch");
    }
    check();
    const store = await (deps.openStore ?? CwTrialRecordStore.open)(values.get("--record-dir") ?? DEFAULT_RECORD_DIR);
    release = await store.acquireExclusive(); check();
    const target = await store.intentForReview(id); check();
    const digest = cwTrialIntentDigest(target);
    io.write(`Review target (old completion/stop remain UNKNOWN): ${JSON.stringify(target)}`);
    io.write(`operator=${JSON.stringify(operator)} note=${JSON.stringify(note)} digest=${digest}`);
    const token = `REVIEW ${id} ${digest}`;
    const interrupted = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("review interrupted")), { once: true }));
    check();
    const answer = await Promise.race([io.prompt(`Confirm old processes exited and current device isolation/state was personally checked. Type ${JSON.stringify(token)} to permit FUTURE new proposals only: `), interrupted]);
    check();
    if (answer !== token) { io.write("cw-trial: review declined; records unchanged"); exit = 3; }
    else {
      await store.reviewIntent({ intentId: id, intentDigest: digest, operator, note }, controller.signal);
      io.write("cw-trial: review appended; old outcome remains UNKNOWN; no transport opened or message sent");
      exit = 0;
    }
  } catch (error) { io.write(`cw-trial: review failed: ${message(error)}; inspect records before retrying if a write was attempted`); }
  finally {
    process.off("SIGINT", abort); process.off("SIGTERM", abort);
    deps.signal?.removeEventListener("abort", abort); io.signal?.removeEventListener("abort", abort);
    try { await release?.(); } catch (error) { exit = 1; io.write(`cw-trial: record lock release failed: ${message(error)}`); }
    if (deps.io === undefined) io.close?.();
  }
  return exit;
}
