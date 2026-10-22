// V00-02-D：一个 FFmpeg 采集进程把实时音频转成固定 PCM，再交给同一个
// multimon-ng 收报会话。不新增解码器、入口、服务或持久化；不写原始音频。
//
// 采集进程只负责按固定后端/设备读取音频并输出 22050 Hz / mono / s16le 到
// stdout。生命周期、背压、错误优先级和清理都在这里收口，GUI 以后可直接调用
// runAudioReceive，而不解析 CLI 输出。

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import {
  MULTIMON_RECEIVE_DEFAULT_TIMEOUT_MS,
  MULTIMON_RECEIVE_MAX_TIMEOUT_MS,
  MultimonReceiveError,
  runMultimonReceive,
  type MultimonReceiveErrorCode,
  type MultimonReceiveResult,
  type MultimonRxChunk,
  type PcmByteSource,
} from "./multimon.js";

export const AUDIO_RECEIVE_MAX_STDERR_RETAINED_BYTES = 64 * 1024;
export const AUDIO_RECEIVE_TERMINATION_GRACE_MS = 500;
export const AUDIO_RECEIVE_SAMPLE_RATE_HZ = 22_050;
export const AUDIO_RECEIVE_CHANNELS = 1;
export const AUDIO_RECEIVE_SAMPLE_FORMAT = "s16le" as const;

export type AudioBackend = "pulse" | "dshow";

export type AudioReceiveErrorCode =
  | MultimonReceiveErrorCode
  | "capture_missing"
  | "capture_failed"
  | "internal";

export interface AudioReceiveErrorDetails {
  /** 采集和解码两侧的清理是否都有界确认；预启动失败视为已确认。 */
  readonly cleanupConfirmed?: boolean;
  /** 已交付给解码器的 PCM 字节数；失败/取消时也保留。 */
  readonly pcmBytes?: number;
  /** 采集 stderr 的有界保留字节数；不包含原文。 */
  readonly captureStderrRetainedBytes?: number;
  readonly decoderErrorCode?: MultimonReceiveErrorCode;
}

export class AudioReceiveError extends Error {
  readonly code: AudioReceiveErrorCode;
  readonly cleanupConfirmed: boolean;
  readonly pcmBytes: number;
  readonly captureStderrRetainedBytes: number;
  readonly decoderErrorCode: MultimonReceiveErrorCode | null;

  constructor(code: AudioReceiveErrorCode, message: string, details: AudioReceiveErrorDetails = {}) {
    super(message);
    this.name = "AudioReceiveError";
    this.code = code;
    this.cleanupConfirmed = details.cleanupConfirmed ?? true;
    this.pcmBytes = details.pcmBytes ?? 0;
    this.captureStderrRetainedBytes = details.captureStderrRetainedBytes ?? 0;
    this.decoderErrorCode = details.decoderErrorCode ?? null;
  }
}

export interface AudioReceiveOptions {
  /** 既有 multimon-ng 可执行文件；参数仍由 multimon 模块固定。 */
  readonly decoder: string;
  /** FFmpeg 可执行文件；不接受额外参数。 */
  readonly ffmpeg: string;
  readonly backend: AudioBackend;
  /** 显式音频设备名；dshow 时作为 audio=<name> 的单个 argv 传入。 */
  readonly device: string;
  readonly sessionId: string;
  /** 串行 await；抛错即终止采集和解码。 */
  readonly onChunk: (chunk: MultimonRxChunk) => void | Promise<void>;
  /** 采集启动、PCM 传输和解码共用的总运行预算，默认 60000 ms。 */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
  /** 仅用于测试/嵌入时替代宿主平台；CLI 不暴露此覆盖。 */
  readonly platform?: NodeJS.Platform;
}

export interface AudioReceiveResult {
  readonly source: "audio";
  readonly readOnly: true;
  readonly sessionId: string;
  readonly audioBackend: AudioBackend;
  readonly audioDevice: string;
  readonly sampleRateHz: number;
  readonly channels: number;
  readonly sampleFormat: typeof AUDIO_RECEIVE_SAMPLE_FORMAT;
  /** 已交给解码器的 PCM 字节数，不是抄收成功或空口准确率。 */
  readonly pcmBytes: number;
  readonly textChunks: number;
  readonly decoderStdoutBytes: number;
  readonly decoderStderrRetainedBytes: number;
  readonly captureStderrRetainedBytes: number;
  readonly decoderExitCode: number | null;
  readonly decoderSignal: NodeJS.Signals | null;
  readonly elapsedMs: number;
}

interface Failure {
  readonly code: AudioReceiveErrorCode;
  readonly message: string;
  readonly decoderErrorCode: MultimonReceiveErrorCode | null;
}

function isCleanValue(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.trim() === value
    && !value.includes("\0");
}

function resolveTimeout(value: number | undefined): number {
  const resolved = value ?? MULTIMON_RECEIVE_DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > MULTIMON_RECEIVE_MAX_TIMEOUT_MS) {
    throw new AudioReceiveError(
      "invalid_options",
      `timeoutMs must be an integer in 1..${MULTIMON_RECEIVE_MAX_TIMEOUT_MS}`,
    );
  }
  return resolved;
}

/**
 * 固定 FFmpeg 采集参数。调用者只能选择后端与单个设备 argv；不拼接 shell、
 * 不追加任意参数，也不接受网络输入。
 */
export function buildFfmpegCaptureArgs(backend: AudioBackend, device: string): string[] {
  if (backend !== "pulse" && backend !== "dshow") {
    throw new AudioReceiveError("invalid_options", "audio backend must be pulse or dshow");
  }
  if (!isCleanValue(device)) {
    throw new AudioReceiveError("invalid_options", "audio device must be a non-empty, trimmed name");
  }
  return [
    "-hide_banner",
    "-loglevel", "error",
    "-nostdin",
    "-f", backend,
    "-i", backend === "dshow" ? `audio=${device}` : device,
    "-vn",
    "-ac", String(AUDIO_RECEIVE_CHANNELS),
    "-ar", String(AUDIO_RECEIVE_SAMPLE_RATE_HZ),
    "-c:a", "pcm_s16le",
    "-f", "s16le",
    "pipe:1",
  ];
}

export function audioBackendMatchesPlatform(
  backend: AudioBackend,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (backend === "pulse") return platform === "linux";
  if (backend === "dshow") return platform === "win32";
  return false;
}

function withDeadline(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | null = setTimeout(() => {
      timer = null;
      resolve(false);
    }, ms);
    promise.then(
      () => {
        if (timer !== null) clearTimeout(timer);
        resolve(true);
      },
      () => {
        if (timer !== null) clearTimeout(timer);
        resolve(true);
      },
    );
  });
}

async function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * 运行一个有界的实时音频收报会话：先启动一个 FFmpeg 采集子进程，再把其
 * stdout PCM 按背压交给同一个 runMultimonReceive。正常完成只可能是解码器
 * 在采集仍运行时自行结束；实时采集自然退出（包括 0）一律是 capture_failed。
 */
export async function runAudioReceive(options: AudioReceiveOptions): Promise<AudioReceiveResult> {
  if (!isCleanValue(options.decoder)) {
    throw new AudioReceiveError("invalid_options", "decoder must be a non-empty executable path");
  }
  if (!isCleanValue(options.ffmpeg)) {
    throw new AudioReceiveError("invalid_options", "ffmpeg must be a non-empty executable path");
  }
  if (options.backend !== "pulse" && options.backend !== "dshow") {
    throw new AudioReceiveError("invalid_options", "audio backend must be pulse or dshow");
  }
  if (!isCleanValue(options.device)) {
    throw new AudioReceiveError("invalid_options", "audio device must be a non-empty, trimmed name");
  }
  if (typeof options.sessionId !== "string" || options.sessionId.length === 0) {
    throw new AudioReceiveError("invalid_options", "sessionId must be non-empty");
  }
  if (typeof options.onChunk !== "function") {
    throw new AudioReceiveError("invalid_options", "onChunk callback is required");
  }
  const timeoutMs = resolveTimeout(options.timeoutMs);
  const platform = options.platform ?? process.platform;
  if (!audioBackendMatchesPlatform(options.backend, platform)) {
    throw new AudioReceiveError(
      "invalid_options",
      `audio backend ${options.backend} is not supported on ${platform}`,
    );
  }
  // 参数校验和预取消必须在任何 spawn 之前完成。
  const captureArgs = buildFfmpegCaptureArgs(options.backend, options.device);
  const external = options.signal;
  if (external?.aborted === true) {
    throw new AudioReceiveError("aborted", "receive was aborted before the capture was started");
  }

  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const controller = new AbortController();

  // 闭包会写入失败状态；用持有对象避免 TypeScript 把控制流窄化当真。
  const failureState: { current: Failure | null } = { current: null };
  let pcmBytes = 0;
  let captureStderrRetained = Buffer.alloc(0);
  let captureExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let captureClosedResolved = false;
  let cleanupStarted = false;
  let cleanupPromise: Promise<boolean> | null = null;
  let decoderCleanupConfirmed = true;
  let captureCleanupConfirmed = false;
  let decoderResult: MultimonReceiveResult | null = null;
  let timer: NodeJS.Timeout | null = null;

  let child: ChildProcessByStdio<null, Readable, Readable>;
  try {
    child = spawn(options.ffmpeg, captureArgs, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new AudioReceiveError("capture_failed", "audio capture process could not be started");
  }

  let resolveCaptureClosed: () => void = () => undefined;
  const captureClosed = new Promise<void>((resolve) => {
    resolveCaptureClosed = resolve;
  });
  let resolveCaptureStarted: (error: NodeJS.ErrnoException | null) => void = () => undefined;
  const captureStarted = new Promise<NodeJS.ErrnoException | null>((resolve) => {
    resolveCaptureStarted = resolve;
  });
  let spawnSettled = false;
  const settleSpawn = (error: NodeJS.ErrnoException | null): void => {
    if (spawnSettled) return;
    spawnSettled = true;
    resolveCaptureStarted(error);
  };

  const beginCaptureCleanup = (): Promise<boolean> => {
    if (cleanupPromise === null) cleanupPromise = cleanupCapture();
    return cleanupPromise;
  };

  const setFailure = (code: AudioReceiveErrorCode, message: string): void => {
    if (failureState.current !== null) return;
    failureState.current = { code, message, decoderErrorCode: null };
    controller.abort();
    // 失败时立即开始采集清理；最终仍会 await 同一 promise。
    void beginCaptureCleanup();
  };

  async function cleanupCapture(): Promise<boolean> {
    cleanupStarted = true;
    try {
      if (!child.stdout.destroyed) child.stdout.destroy();
      if (!child.stderr.destroyed) child.stderr.destroy();
      if (child.pid === undefined) return true;

      let closed = captureClosedResolved;
      if (!closed && captureExit === null) {
        try {
          child.kill("SIGTERM");
        } catch {
          // 进程可能已退出；下面的有界等待/升级仍然有效。
        }
        closed = await withDeadline(captureClosed, AUDIO_RECEIVE_TERMINATION_GRACE_MS);
      }
      if (!closed) {
        try {
          child.kill("SIGKILL");
        } catch {
          // 同上；不重试。
        }
        closed = await withDeadline(captureClosed, AUDIO_RECEIVE_TERMINATION_GRACE_MS);
      }
      return closed;
    } catch {
      return false;
    }
  }

  const onExternalAbort = (): void => {
    setFailure("aborted", "receive was aborted");
  };
  external?.addEventListener("abort", onExternalAbort, { once: true });

  child.once("spawn", () => settleSpawn(null));
  child.once("error", (error: NodeJS.ErrnoException) => {
    settleSpawn(error);
    if (cleanupStarted) return;
    const missing = error.code === "ENOENT";
    if (missing && (failureState.current === null || failureState.current.code === "capture_failed")) {
      // 允许把更早的 stdout 结束误分类纠正为“缺失”；已确定的外部取消/超时优先。
      failureState.current = { code: "capture_missing", message: "audio capture executable was not found", decoderErrorCode: null };
      controller.abort();
      void beginCaptureCleanup();
      return;
    }
    setFailure("capture_failed", "audio capture process could not be started");
  });
  child.once("exit", (code, signal) => {
    captureExit = { code, signal };
    if (cleanupStarted) return;
    setFailure(
      "capture_failed",
      `live audio capture exited unexpectedly (code ${code ?? "null"}, signal ${signal ?? "none"})`,
    );
  });
  child.once("close", () => {
    captureClosedResolved = true;
    resolveCaptureClosed();
  });
  child.stdout.once("end", () => {
    if (cleanupStarted) return;
    setFailure("capture_failed", "live audio capture output ended unexpectedly");
  });
  child.stdout.once("error", () => {
    if (cleanupStarted) return;
    setFailure("capture_failed", "live audio capture output failed");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    // 持续排空，不因 stderr 大而阻塞采集；只保留尾部且不回显原文。
    const combined = Buffer.concat([captureStderrRetained, chunk]);
    captureStderrRetained = combined.length > AUDIO_RECEIVE_MAX_STDERR_RETAINED_BYTES
      ? Buffer.from(combined.subarray(combined.length - AUDIO_RECEIVE_MAX_STDERR_RETAINED_BYTES))
      : combined;
  });
  child.stderr.once("error", () => undefined);

  timer = setTimeout(() => {
    timer = null;
    setFailure("timeout", `receive exceeded the ${timeoutMs} ms runtime budget`);
  }, Math.max(0, deadline - Date.now()));

  const source: PcmByteSource = {
    async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
      try {
        for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
          if (controller.signal.aborted || cleanupStarted) return;
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
          pcmBytes += bytes.length;
          yield bytes;
        }
      } catch {
        if (!cleanupStarted) {
          setFailure("capture_failed", "live audio capture output failed");
        }
        return;
      }
      if (!cleanupStarted) {
        setFailure("capture_failed", "live audio capture output ended unexpectedly");
      }
    },
  };

  try {
    // 等待 spawn/error，确保缺失 FFmpeg 不会先启动解码器；等待受总预算约束。
    const spawnOutcome = await within(
      captureStarted.then((error) => ({ kind: "spawned" as const, error })),
      Math.max(1, deadline - Date.now()),
    );
    if (spawnOutcome === null) {
      if (failureState.current === null) {
        setFailure("timeout", `receive exceeded the ${timeoutMs} ms runtime budget`);
      }
    } else if (spawnOutcome.error !== null) {
      const missing = spawnOutcome.error.code === "ENOENT";
      if (failureState.current === null || (missing && failureState.current.code === "capture_failed")) {
        failureState.current = missing
          ? { code: "capture_missing", message: "audio capture executable was not found", decoderErrorCode: null }
          : { code: "capture_failed", message: "audio capture process could not be started", decoderErrorCode: null };
        controller.abort();
        void beginCaptureCleanup();
      }
    }

    if (failureState.current === null && deadline <= Date.now()) {
      setFailure("timeout", `receive exceeded the ${timeoutMs} ms runtime budget`);
    }
    if (failureState.current === null) {
      try {
        decoderResult = await runMultimonReceive({
          decoder: options.decoder,
          source,
          sessionId: options.sessionId,
          timeoutMs: Math.max(1, deadline - Date.now()),
          onChunk: options.onChunk,
          ...(options.now === undefined ? {} : { now: options.now }),
          signal: controller.signal,
        });
        decoderCleanupConfirmed = true;
      } catch (error) {
        if (error instanceof MultimonReceiveError) {
          decoderCleanupConfirmed = error.cleanupConfirmed;
          if (failureState.current === null) {
            failureState.current = {
              code: error.code,
              message: error.message,
              decoderErrorCode: error.code,
            };
          }
        } else {
          decoderCleanupConfirmed = false;
          if (failureState.current === null) {
            failureState.current = { code: "internal", message: "unexpected receive failure", decoderErrorCode: null };
          }
        }
      }
    }
  } finally {
    // 先停预算 timer，避免成功返回后的有界清理被误判为超时。
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    external?.removeEventListener("abort", onExternalAbort);
    captureCleanupConfirmed = await beginCaptureCleanup();
  }

  if (failureState.current === null && decoderResult === null) {
    failureState.current = { code: "internal", message: "receive ended without a result", decoderErrorCode: null };
  }
  const failure = failureState.current;
  if (failure !== null) {
    throw new AudioReceiveError(failure.code, failure.message, {
      cleanupConfirmed: decoderCleanupConfirmed && captureCleanupConfirmed,
      pcmBytes,
      captureStderrRetainedBytes: captureStderrRetained.length,
      ...(failure.decoderErrorCode === null ? {} : { decoderErrorCode: failure.decoderErrorCode }),
    });
  }

  const completed = decoderResult as MultimonReceiveResult;
  return {
    source: "audio",
    readOnly: true,
    sessionId: options.sessionId,
    audioBackend: options.backend,
    audioDevice: options.device,
    sampleRateHz: AUDIO_RECEIVE_SAMPLE_RATE_HZ,
    channels: AUDIO_RECEIVE_CHANNELS,
    sampleFormat: AUDIO_RECEIVE_SAMPLE_FORMAT,
    pcmBytes,
    textChunks: completed.textChunks,
    decoderStdoutBytes: completed.stdoutBytes,
    decoderStderrRetainedBytes: completed.stderrRetainedBytes,
    captureStderrRetainedBytes: captureStderrRetained.length,
    decoderExitCode: completed.exitCode,
    decoderSignal: completed.signal,
    elapsedMs: Date.now() - startedAt,
  };
}
