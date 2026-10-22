// V00-02-C：cwrig receive 子命令。只负责参数、JSONL 显示和终止；
// PCM 校验/引擎会话/序号由 packages/receive 复用，GUI 以后直接调用同一模块。

import { createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  AUDIO_RECEIVE_CHANNELS,
  AUDIO_RECEIVE_SAMPLE_FORMAT,
  AUDIO_RECEIVE_SAMPLE_RATE_HZ,
  AudioReceiveError,
  MULTIMON_RECEIVE_DEFAULT_TIMEOUT_MS,
  MULTIMON_RECEIVE_MAX_TIMEOUT_MS,
  MultimonReceiveError,
  runAudioReceive,
  runMultimonReceive,
  type AudioBackend,
  type AudioReceiveOptions,
  type AudioReceiveResult,
  type MultimonRxChunk,
  type PcmByteSource,
} from "../packages/receive/src/index.js";
import {
  AssistantError,
  ReplyError,
  createReplySession,
  loadAssistantConfig,
  validateReplyCalls,
  type AssistantConfig,
  type ReplySession,
  type ReplySessionResult,
  type ReplyProposalEvent,
} from "../packages/assistant/src/index.js";
import {
  runCwTrial,
  type CwTrialIo,
  type CwTrialReplyBinding,
  type CwTrialRunnerDeps,
} from "./rig-cw-trial.js";
import { ReplyDispatchControl } from "./reply-dispatch-control.js";
import type { CivTransport } from "../packages/devices/src/index.js";

export const RECEIVE_USAGE =
  "cwrig receive --decoder <executable> (--pcm-s16le <file|-> | "
  + "--ffmpeg <executable> --audio-backend <pulse|dshow> --audio-device <name>) "
  + "[--timeout-ms <1..3600000>] "
  + "[--reply-config <file> --own-call <call> --peer-call <call> [--reply-idle-ms <1000..10000>]] "
  + "[--reply-continuous [--reply-wpm <5..60>] [--reply-budget-ms <100..10000>]] "
  + "[--reply-prepared] "
  + "[--reply-trial-simulate --reply-trial-record-dir <dir> [--reply-auto]]";

const LEGACY_FLAGS = ["--endpoint", "--once", "--interval-ms"] as const;

export interface ReplyTrialCliOptions {
  readonly recordDir: string;
}

export interface PcmReceiveOptions {
  readonly mode: "pcm";
  readonly decoder: string;
  readonly pcmSource: string;
  readonly timeoutMs: number;
  readonly reply?: ReplyCliOptions;
  readonly replyTrial?: ReplyTrialCliOptions;
  readonly replyAuto: boolean;
}

export interface AudioCliReceiveOptions {
  readonly mode: "audio";
  readonly decoder: string;
  readonly ffmpeg: string;
  readonly audioBackend: AudioBackend;
  readonly audioDevice: string;
  readonly timeoutMs: number;
  readonly reply?: ReplyCliOptions;
}

export interface ReplyCliOptions {
  readonly configFile: string;
  readonly ownCall: string;
  readonly peerCall: string;
  readonly idleMs: number;
  readonly continuous: boolean;
  readonly prepared: boolean;
  readonly wpm: number;
  readonly budgetMs: number;
}

export type ReceiveOptions = PcmReceiveOptions | AudioCliReceiveOptions;

export interface ReceiveAudioControl {
  /** Resolves only after the active capture and decoder confirm cleanup. */
  pause(): Promise<void>;
  resume(): void;
}

export interface ReceiveDeps {
  print?: (value: unknown) => void;
  /** 嵌入式调用者可观察与 CLI 相同的结构化事件；不会改变 CLI 输出。 */
  onEvent?: (value: unknown) => void;
  onAudioControl?: (control: ReceiveAudioControl | null) => void;
  now?: () => Date;
  sessionId?: string;
  signal?: AbortSignal;
  /** 测试/嵌入时替代文件或 stdin 的已打开字节源。 */
  source?: PcmByteSource;
  /** 测试/嵌入时替代 createReadStream/process.stdin 的打开函数。 */
  openSource?: (target: string) => PcmByteSource;
  /** 测试/嵌入时替代实时音频会话函数；CLI 正常路径不使用。 */
  runAudio?: (options: AudioReceiveOptions) => Promise<AudioReceiveResult>;
  /** 测试/嵌入时显式声明交互 TTY；CLI 正常路径读取 process.stdin.isTTY。 */
  isTTY?: boolean;
  /** 测试/嵌入时替代回复试验的交互终端；生产使用 runCwTrial 默认 TTY。 */
  trialIo?: CwTrialIo;
  /** 测试/嵌入时替代模拟 transport；生产使用既有 CwTrial 模拟器。 */
  trialCreateTransport?: (options: import("./rig-cw-trial.js").CwTrialCliOptions) => Promise<CivTransport>;
  /**
   * V00-04-A：嵌入/GUI 可传入同一会话控制对象。传入时以该对象为准，
   * CLI `--reply-auto` 不会重新启用已被撤销的自动模式。
   */
  replyDispatch?: ReplyDispatchControl;
}

export function parseReceiveArgs(argv: readonly string[]): ReceiveOptions {
  const seen = new Set<string>();
  let decoder = "";
  let pcmSource = "";
  let ffmpeg = "";
  let audioBackend: AudioBackend | "" = "";
  let audioDevice = "";
  let timeoutMs = MULTIMON_RECEIVE_DEFAULT_TIMEOUT_MS;
  let replyConfig = "";
  let ownCall = "";
  let peerCall = "";
  let replyIdleMs: number | null = null;
  let replyContinuous = false;
  let replyPrepared = false;
  let replyWpm: number | null = null;
  let replyBudgetMs: number | null = null;
  let replyTrialSimulate = false;
  let replyTrialRecordDir = "";
  let replyAuto = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if ((LEGACY_FLAGS as readonly string[]).includes(flag)) {
      throw new Error(`${flag} is no longer supported: the fldigi receive path is frozen; use --decoder with --pcm-s16le or --ffmpeg`);
    }
    if (![
      "--decoder", "--pcm-s16le", "--ffmpeg", "--audio-backend", "--audio-device", "--timeout-ms",
      "--reply-config", "--own-call", "--peer-call", "--reply-idle-ms",
      "--reply-continuous", "--reply-prepared", "--reply-wpm", "--reply-budget-ms",
      "--reply-trial-simulate", "--reply-trial-record-dir", "--reply-auto",
    ].includes(flag) || seen.has(flag)) {
      throw new Error(`unknown or duplicate argument: ${flag}`);
    }
    seen.add(flag);
    if (flag === "--reply-trial-simulate") {
      replyTrialSimulate = true;
      continue;
    }
    if (flag === "--reply-continuous") {
      replyContinuous = true;
      continue;
    }
    if (flag === "--reply-prepared") {
      replyPrepared = true;
      continue;
    }
    if (flag === "--reply-auto") {
      replyAuto = true;
      continue;
    }
    const value = argv[++index];
    if (value === undefined || value.length === 0 || value.startsWith("--") || value.trim() !== value) {
      throw new Error(`missing or invalid value for ${flag}`);
    }
    if (flag === "--decoder") {
      decoder = value;
      continue;
    }
    if (flag === "--pcm-s16le") {
      pcmSource = value;
      continue;
    }
    if (flag === "--ffmpeg") {
      ffmpeg = value;
      continue;
    }
    if (flag === "--audio-backend") {
      if (value !== "pulse" && value !== "dshow") {
        throw new Error("--audio-backend must be pulse or dshow");
      }
      audioBackend = value;
      continue;
    }
    if (flag === "--audio-device") {
      audioDevice = value;
      continue;
    }
    if (flag === "--reply-config") {
      replyConfig = value;
      continue;
    }
    if (flag === "--own-call") {
      ownCall = value;
      continue;
    }
    if (flag === "--peer-call") {
      peerCall = value;
      continue;
    }
    if (flag === "--reply-idle-ms") {
      if (!/^[0-9]+$/.test(value)) throw new Error("invalid number for --reply-idle-ms");
      replyIdleMs = Number(value);
      if (!Number.isInteger(replyIdleMs) || replyIdleMs < 1000 || replyIdleMs > 10000) {
        throw new Error("--reply-idle-ms must be 1000..10000 ms");
      }
      continue;
    }
    if (flag === "--reply-wpm") {
      if (!/^[0-9]+$/.test(value)) throw new Error("invalid number for --reply-wpm");
      replyWpm = Number(value);
      if (!Number.isInteger(replyWpm) || replyWpm < 5 || replyWpm > 60) {
        throw new Error("--reply-wpm must be 5..60");
      }
      continue;
    }
    if (flag === "--reply-budget-ms") {
      if (!/^[0-9]+$/.test(value)) throw new Error("invalid number for --reply-budget-ms");
      replyBudgetMs = Number(value);
      if (!Number.isInteger(replyBudgetMs) || replyBudgetMs < 100 || replyBudgetMs > 10000) {
        throw new Error("--reply-budget-ms must be 100..10000 ms");
      }
      continue;
    }
    if (flag === "--reply-trial-record-dir") {
      replyTrialRecordDir = value;
      continue;
    }
    if (!/^[0-9]+$/.test(value)) throw new Error("invalid number for --timeout-ms");
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1 || number > MULTIMON_RECEIVE_MAX_TIMEOUT_MS) {
      throw new Error("timeout must be 1..3600000 ms");
    }
    timeoutMs = number;
  }
  if (decoder.length === 0) throw new Error("receive requires --decoder <executable>");
  const replyValues = [replyConfig, ownCall, peerCall];
  const replyAny = replyValues.some((value) => value.length > 0);
  const replyAll = replyValues.every((value) => value.length > 0);
  if (replyAny && !replyAll) {
    throw new Error("reply requires all of --reply-config, --own-call and --peer-call together");
  }
  if (replyIdleMs !== null && !replyAll) {
    throw new Error("--reply-idle-ms is only valid together with --reply-config, --own-call and --peer-call");
  }
  if (replyPrepared && !replyContinuous) {
    throw new Error("--reply-prepared requires --reply-continuous");
  }
  if (replyContinuous) {
    if (!replyAll) {
      throw new Error("--reply-continuous requires --reply-config, --own-call and --peer-call");
    }
    // 既有无发送路径的 continuous 切片保持拒绝；只有 prepared 模式可与模拟发送组合。
    if (replyTrialSimulate && !replyPrepared) {
      throw new Error("--reply-continuous cannot be combined with --reply-trial-simulate: this slice does not send, so continuous turns have no dispatch path");
    }
  }
  if ((replyWpm !== null || replyBudgetMs !== null) && !replyContinuous) {
    throw new Error("--reply-wpm and --reply-budget-ms are only valid with --reply-continuous");
  }
  let reply: ReplyCliOptions | undefined;
  if (replyAll) {
    validateReplyCalls(ownCall, peerCall);
    reply = {
      configFile: replyConfig,
      ownCall,
      peerCall,
      idleMs: replyIdleMs ?? 2500,
      continuous: replyContinuous,
      prepared: replyPrepared,
      wpm: replyWpm ?? 20,
      budgetMs: replyBudgetMs ?? 5000,
    };
  }
  const pcmMode = pcmSource.length > 0;
  const audioMode = ffmpeg.length > 0 || audioBackend.length > 0 || audioDevice.length > 0;
  if (pcmMode && audioMode) {
    throw new Error("receive requires exactly one input mode: --pcm-s16le or --ffmpeg/--audio-backend/--audio-device");
  }
  if (replyTrialRecordDir.length > 0 && !replyTrialSimulate) {
    throw new Error("--reply-trial-record-dir requires --reply-trial-simulate");
  }
  if (replyAuto && !replyTrialSimulate) {
    throw new Error("--reply-auto requires --reply-trial-simulate; the original full-text confirmation remains the manual default");
  }
  if (replyTrialSimulate) {
    if (!replyAll) {
      throw new Error("--reply-trial-simulate requires --reply-config, --own-call and --peer-call");
    }
    if (replyTrialRecordDir.length === 0) {
      throw new Error("--reply-trial-simulate requires --reply-trial-record-dir <dir>");
    }
    if (!pcmMode || pcmSource === "-") {
      throw new Error("--reply-trial-simulate only accepts a PCM file; stdin and realtime audio are not supported");
    }
    if (audioMode) {
      throw new Error("--reply-trial-simulate only accepts a PCM file; realtime audio is not supported");
    }
  }
  const replyTrial = replyTrialSimulate ? { recordDir: replyTrialRecordDir } : undefined;
  if (pcmMode) {
    return {
      mode: "pcm", decoder, pcmSource, timeoutMs,
      replyAuto,
      ...(reply === undefined ? {} : { reply }),
      ...(replyTrial === undefined ? {} : { replyTrial }),
    };
  }
  if (!audioMode) {
    throw new Error("receive requires exactly one input mode: --pcm-s16le <file|-> or --ffmpeg <executable> --audio-backend <pulse|dshow> --audio-device <name>");
  }
  if (ffmpeg.length === 0 || (audioBackend !== "pulse" && audioBackend !== "dshow") || audioDevice.length === 0) {
    throw new Error("audio mode requires all of --ffmpeg, --audio-backend and --audio-device");
  }
  return { mode: "audio", decoder, ffmpeg, audioBackend, audioDevice, timeoutMs, ...(reply === undefined ? {} : { reply }) };
}

function openDefaultSource(target: string): PcmByteSource {
  return target === "-" ? process.stdin : createReadStream(target);
}

async function runAudioWithPauses(options: AudioReceiveOptions,
  run: (options: AudioReceiveOptions) => Promise<AudioReceiveResult>,
  ready: ReceiveDeps["onAudioControl"], status: (state: string) => void): Promise<AudioReceiveResult> {
  const deadline = Date.now() + (options.timeoutMs ?? 3600000);
  let cycle: AbortController | null = null;
  let requested = false;
  let ended = false;
  const pauseState: { ack: { resolve: () => void; reject: (error: unknown) => void } | null } = { ack: null };
  let wake: (() => void) | null = null;
  const control: ReceiveAudioControl = {
    pause: () => {
      if (ended || options.signal?.aborted || requested || cycle === null) return Promise.reject(new Error("audio cannot be paused"));
      requested = true;
      const result = new Promise<void>((resolve, reject) => { pauseState.ack = { resolve, reject }; });
      cycle.abort();
      return result;
    },
    resume: () => { wake?.(); },
  };
  let published = false;
  try {
    for (;;) {
      if (options.signal?.aborted) throw new AudioReceiveError("aborted", "receive was stopped", { cleanupConfirmed: true });
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new AudioReceiveError("timeout", "receive runtime budget exhausted", { cleanupConfirmed: true });
      cycle = new AbortController();
      const active = cycle;
      const abort = (): void => active.abort();
      options.signal?.addEventListener("abort", abort, { once: true });
      try {
        const task = run({ ...options, signal: active.signal, timeoutMs: remaining });
        if (!published) { published = true; ready?.(control); }
        return await task;
      } catch (error) {
        if (!requested || options.signal?.aborted || !(error instanceof AudioReceiveError)
            || error.code !== "aborted" || !error.cleanupConfirmed) throw error;
      } finally {
        options.signal?.removeEventListener("abort", abort);
        cycle = null;
      }
      // Install the resume/stop wait before acknowledging pause to the caller.
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => { clearTimeout(timer); options.signal?.removeEventListener("abort", stopped); wake = null; };
        const stopped = (): void => { cleanup(); reject(new AudioReceiveError("aborted", "receive was stopped while paused", { cleanupConfirmed: true })); };
        const timer = setTimeout(() => { cleanup(); reject(new AudioReceiveError("timeout", "receive runtime budget exhausted while paused", { cleanupConfirmed: true })); }, Math.max(0, deadline - Date.now()));
        wake = () => { cleanup(); requested = false; resolve(); };
        options.signal?.addEventListener("abort", stopped, { once: true });
        status("paused");
        pauseState.ack?.resolve(); pauseState.ack = null;
        if (options.signal?.aborted) stopped();
      });
      status("resumed");
    }
  } finally {
    ended = true;
    pauseState.ack?.reject(new Error("audio pause did not confirm cleanup"));
    pauseState.ack = null;
    ready?.(null);
  }
}

/**
 * 运行一次后台收报，返回进程退出码：usage 2、运行/清理失败 1、
 * 正常完成或确认清理的主动取消 0。不启动真实电台；显式音频暂停后可恢复采集。
 */
export async function runReceive(argv: readonly string[], deps: ReceiveDeps = {}): Promise<number> {
  const output = deps.print ?? ((value: unknown): void => {
    process.stdout.write(`${JSON.stringify(value)}\n`);
  });
  const print = (value: unknown): void => {
    output(value);
    deps.onEvent?.(value);
  };
  let options: ReceiveOptions;
  try {
    options = parseReceiveArgs(argv);
  } catch (error) {
    print({
      ok: false,
      type: "error",
      code: "usage",
      error: error instanceof Error ? error.message : String(error),
      usage: RECEIVE_USAGE,
    });
    return 2;
  }

  if (deps.replyDispatch !== undefined
      && !(options.mode === "pcm" && options.replyTrial !== undefined)) {
    print({
      ok: false,
      type: "error",
      code: "usage",
      error: "a reply dispatch control requires --reply-trial-simulate with a PCM file; no reply was dispatched",
    });
    return 2;
  }

  if (options.mode === "pcm" && options.replyTrial !== undefined
      && !(deps.isTTY ?? Boolean(process.stdin.isTTY))) {
    print({
      ok: false,
      type: "error",
      code: "not_tty",
      error: "reply trial simulation requires an interactive TTY; no reply was dispatched",
    });
    return 2;
  }

  const replyDispatch = options.mode === "pcm" && options.replyTrial !== undefined
    ? deps.replyDispatch ?? new ReplyDispatchControl({ automatic: options.replyAuto })
    : undefined;

  let replyConfig: AssistantConfig | null = null;
  if (options.reply !== undefined) {
    try {
      // 联网前加载并严格校验既有 version1 配置；不打印凭据或其值。
      replyConfig = loadAssistantConfig(options.reply.configFile);
    } catch (error) {
      print({
        ok: false,
        type: "error",
        code: error instanceof AssistantError ? error.code : "invalid_reply_config",
        error: error instanceof Error ? error.message : "reply configuration could not be loaded",
      });
      return 1;
    }
  }

  const sessionId = deps.sessionId ?? randomUUID();
  const controller = new AbortController();
  let reply: ReplySession | null = null;
  let currentProposal: ReplyProposalEvent | null = null;
  let continuousLastTiming: Record<string, unknown> | null = null;
  if (options.reply !== undefined && replyConfig !== null) {
    try {
      reply = createReplySession({
        config: replyConfig,
        ownCall: options.reply.ownCall,
        peerCall: options.reply.peerCall,
        sessionId,
        idleMs: options.reply.idleMs,
        ...(options.reply.continuous
          ? {
              continuous: true,
              wpm: options.reply.wpm,
              budgetMs: options.reply.budgetMs,
              ...(options.reply.prepared ? { prepared: true } : {}),
            }
          : {}),
        signal: controller.signal,
        onEvent: (event): void => {
          if (event.type === "reply") {
            currentProposal = event;
            if (event.timing !== undefined) continuousLastTiming = { ...event.timing };
          } else if (event.type === "invalidated") currentProposal = null;
          print({ ok: true, ...event });
        },
      });
    } catch (error) {
      print({
        ok: false,
        type: "error",
        code: error instanceof AssistantError || error instanceof ReplyError ? error.code : "invalid_reply",
        error: error instanceof Error ? error.message : "reply session could not be created",
      });
      return 1;
    }
  }
  const stop = (): void => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const external = deps.signal;
  const onExternalAbort = (): void => controller.abort();
  replyDispatch?.signal.addEventListener("abort", onExternalAbort, { once: true });
  if (replyDispatch?.signal.aborted) controller.abort();
  if (external !== undefined) {
    if (external.aborted) controller.abort();
    else external.addEventListener("abort", onExternalAbort, { once: true });
  }

  const inputFields: Record<string, unknown> = options.mode === "pcm"
    ? { pcmS16le: options.pcmSource }
    : {
        ffmpeg: options.ffmpeg,
        audioBackend: options.audioBackend,
        audioDevice: options.audioDevice,
        audioSampleRateHz: AUDIO_RECEIVE_SAMPLE_RATE_HZ,
        audioChannels: AUDIO_RECEIVE_CHANNELS,
        audioSampleFormat: AUDIO_RECEIVE_SAMPLE_FORMAT,
      };

  const emitStatus = (state: string, extra: Record<string, unknown> = {}): void => {
    print({
      ok: true,
      type: "status",
      state,
      source: "multimon-ng",
      readOnly: true,
      sessionId,
      decoder: options.decoder,
      timeoutMs: options.timeoutMs,
      ...inputFields,
      ...extra,
    });
  };

  let chunks = 0;
  let decoded = false;
  try {
    if (controller.signal.aborted) {
      emitStatus("stopped", { stoppedBy: "signal", textChunks: 0 });
      return 0;
    }
    const onChunk = (chunk: MultimonRxChunk): void => {
      chunks += 1;
      decoded ||= chunk.text.trim().length > 0;
      print({ ok: true, type: "chunk", ...chunk });
      // push is synchronous: decoding must not wait for the model. Async reply
      // results are delivered through onEvent, and finish() flushes the turn.
      reply?.push(chunk);
    };
    if (options.mode === "pcm") {
      const source = deps.source ?? (deps.openSource ?? openDefaultSource)(options.pcmSource);
      emitStatus("started");
      const result = await runMultimonReceive({
        decoder: options.decoder,
        source,
        sessionId,
        timeoutMs: options.timeoutMs,
        onChunk,
        ...(deps.now === undefined ? {} : { now: deps.now }),
        signal: controller.signal,
      });
      let replyResult: ReplySessionResult | null = null;
      if (reply !== null) replyResult = await reply.finish();
      const continuousFields = options.reply?.continuous === true && replyResult !== null
        ? {
            replyContinuous: true,
            replyPrepared: options.reply.prepared,
            replyTurns: replyResult.turns ?? 0,
            replyEndReason: replyResult.endReason ?? null,
            replyWpm: options.reply.wpm,
            replyBudgetMs: options.reply.budgetMs,
            replyLastTiming: continuousLastTiming,
          }
        : {};
      const completion = {
        textChunks: result.textChunks,
        decoded,
        empty: !decoded,
        stdoutBytes: result.stdoutBytes,
        stderrRetainedBytes: result.stderrRetainedBytes,
        exitCode: result.exitCode,
        elapsedMs: result.elapsedMs,
        ...(replyResult === null ? {} : { replyStatus: replyResult.status }),
        ...continuousFields,
      };
      const replyTrial = options.replyTrial;
      if (replyTrial === undefined) {
        emitStatus("completed", completion);
        return 0;
      }
      // prepared 连续模式只在正常 EOF 且最后当前提案是合法 reply 时派发一次；
      // model_end/turn_limit/context_limit/failure/cancel 均不得派发。
      const preparedFinal = options.reply?.prepared === true
        && replyResult?.status === "ended"
        && replyResult.endReason === "eof"
        ? replyResult.reply
        : null;
      const proposal = replyResult?.status === "published" ? replyResult.reply : preparedFinal;
      const ready = proposal !== null
        && proposal.validated
        && proposal.action === "reply"
        && proposal.text.length > 0;
      if (!ready) {
        emitStatus("completed", {
          ...completion,
          replyDispatch: replyDispatch?.mode ?? "manual",
          replyTrial: {
            performed: false,
            reason: proposal?.action === "no_reply" ? "no_reply" : "no_valid_reply",
          },
        });
        return 0;
      }
      if (controller.signal.aborted) {
        emitStatus("completed", {
          ...completion,
          replyDispatch: replyDispatch?.mode ?? "manual",
          replyTrial: { performed: false, reason: "canceled" },
        });
        return 0;
      }
      const dispatchMode = replyDispatch?.mode ?? "manual";
      const binding: CwTrialReplyBinding = {
        text: proposal.text,
        sessionId: proposal.sessionId,
        turnId: proposal.turnId,
        revision: proposal.revision,
        isCurrent: () => currentProposal === proposal && !controller.signal.aborted,
      };
      print({
        ok: true,
        type: "reply_trial",
        state: dispatchMode === "automatic" ? "automatic" : "confirm",
        dispatch: dispatchMode,
        controlGeneration: replyDispatch?.generation ?? 0,
        scope: "simulator",
        transport: "simulator",
        sessionId: binding.sessionId,
        turnId: binding.turnId,
        revision: binding.revision,
        receivedText: proposal.receivedText,
        text: binding.text,
      });
      const actualDispatchMode = replyDispatch?.mode ?? "manual";
      const trialDeps: CwTrialRunnerDeps = {
        replyProposal: binding,
        signal: controller.signal,
        ...(replyDispatch === undefined ? {} : { replyDispatch }),
        ...(deps.trialIo === undefined ? {} : { io: deps.trialIo }),
        ...(deps.trialCreateTransport === undefined ? {} : { createTransport: deps.trialCreateTransport }),
      };
      const trialExitCode = await runCwTrial(["--simulate", "--record-dir", replyTrial.recordDir], trialDeps);
      emitStatus("completed", {
        ...completion,
        // 本状态覆盖了模拟发送，不能继续宣称整个会话只读。
        readOnly: false,
        replyTrial: { performed: true, exitCode: trialExitCode, transport: "simulator" },
        replyDispatch: actualDispatchMode,
      });
      return trialExitCode;
    }

    const runAudio = deps.runAudio ?? runAudioReceive;
    emitStatus("started");
    const result = await runAudioWithPauses({
      decoder: options.decoder,
      ffmpeg: options.ffmpeg,
      backend: options.audioBackend,
      device: options.audioDevice,
      sessionId,
      timeoutMs: options.timeoutMs,
      onChunk,
      ...(deps.now === undefined ? {} : { now: deps.now }),
      signal: controller.signal,
    }, runAudio, deps.onAudioControl, emitStatus);
    // 实时音频的结束不是 PCM EOF；idle 已在输入继续时收口，这里只清理未完成
    // 的 timer/模型，不把采集结束伪装成正常报文收口。
    reply?.cancel();
    emitStatus("completed", {
      textChunks: result.textChunks,
      decoded,
      empty: !decoded,
      pcmBytes: result.pcmBytes,
      decoderStdoutBytes: result.decoderStdoutBytes,
      decoderStderrRetainedBytes: result.decoderStderrRetainedBytes,
      captureStderrRetainedBytes: result.captureStderrRetainedBytes,
      decoderExitCode: result.decoderExitCode,
      elapsedMs: result.elapsedMs,
    });
    return 0;
  } catch (error) {
    // 采集/解码失败或取消不是 EOF：丢弃未收口文本并取消在途模型。
    reply?.cancel();
    const receiveError = error instanceof MultimonReceiveError ? error : null;
    const audioError = error instanceof AudioReceiveError ? error : null;
    const code = receiveError?.code ?? audioError?.code ?? "internal";
    const cleanupConfirmed = receiveError?.cleanupConfirmed ?? audioError?.cleanupConfirmed ?? false;
    if (code === "aborted" && cleanupConfirmed) {
      emitStatus("stopped", {
        stoppedBy: "signal",
        textChunks: chunks,
        ...(audioError === null
          ? {}
          : {
              pcmBytes: audioError.pcmBytes,
              captureStderrRetainedBytes: audioError.captureStderrRetainedBytes,
            }),
      });
      return 0;
    }
    print({
      ok: false,
      type: "error",
      source: "multimon-ng",
      readOnly: true,
      sessionId,
      code,
      cleanupConfirmed,
      error: receiveError?.message ?? audioError?.message ?? "unexpected receive failure",
      textChunks: chunks,
      ...(options.mode === "audio" ? inputFields : {}),
      ...(audioError === null
        ? {}
        : {
            pcmBytes: audioError.pcmBytes,
            captureStderrRetainedBytes: audioError.captureStderrRetainedBytes,
          }),
    });
    return 1;
  } finally {
    reply?.cancel();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    external?.removeEventListener("abort", onExternalAbort);
    replyDispatch?.signal.removeEventListener("abort", onExternalAbort);
  }
}
