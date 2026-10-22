// V00-02-C：multimon-ng 后台收报会话。
//
// 一个会话只管理一个固定参数的 multimon-ng 子进程，接受调用者提供的
// 22050 Hz / mono / signed-16 little-endian PCM 字节流。不解析 WAV、不访问
// 声卡、不启动网络服务；不重启/重试，也不向解码器传递任意方法或参数。

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

export const MULTIMON_RECEIVE_DEFAULT_TIMEOUT_MS = 60_000;
export const MULTIMON_RECEIVE_MAX_TIMEOUT_MS = 3_600_000;
export const MULTIMON_RECEIVE_DEFAULT_MAX_STDOUT_BYTES = 1024 * 1024;
export const MULTIMON_RECEIVE_MAX_STDERR_RETAINED_BYTES = 64 * 1024;
export const MULTIMON_RECEIVE_SAMPLE_RATE_HZ = 22_050;
export const MULTIMON_RECEIVE_SILENCE_MS = 500;
export const MULTIMON_RECEIVE_SILENCE_BYTES =
  (MULTIMON_RECEIVE_SAMPLE_RATE_HZ * MULTIMON_RECEIVE_SILENCE_MS) / 1000 * 2;

/** 固定参数；不得由调用者追加或覆盖。 */
const MULTIMON_ARGS = ["-q", "-c", "-a", "MORSE_CW", "-t", "raw", "-"] as const;
const CANCEL_GRACE_MS = 500;
const INPUT_SETTLE_MS = 1_000;
const ITERATOR_RETURN_MS = 200;

export type MultimonReceiveErrorCode =
  | "invalid_options"
  | "aborted"
  | "decoder_missing"
  | "decoder_failed"
  | "premature_exit"
  | "timeout"
  | "output_limit"
  | "input_error"
  | "callback_failed"
  | "cleanup_failed";

export class MultimonReceiveError extends Error {
  readonly code: MultimonReceiveErrorCode;
  /** 取消/失败后的子进程清理是否有界确认。spawn 失败或子进程已退出时为 true。 */
  readonly cleanupConfirmed: boolean;

  constructor(code: MultimonReceiveErrorCode, message: string, cleanupConfirmed = true) {
    super(message);
    this.name = "MultimonReceiveError";
    this.code = code;
    this.cleanupConfirmed = cleanupConfirmed;
  }
}

export type PcmByteSource = Readable | AsyncIterable<Uint8Array>;

export interface MultimonRxChunk {
  readonly source: "multimon-ng";
  readonly readOnly: true;
  readonly sessionId: string;
  /** 仅对本次会话交付的非空文本递增，从 1 开始。 */
  readonly seq: number;
  readonly text: string;
  readonly receivedAt: string;
}

export interface MultimonReceiveOptions {
  /** multimon-ng 可执行文件；参数由本模块固定。 */
  readonly decoder: string;
  readonly source: PcmByteSource;
  readonly sessionId: string;
  /** 串行 await；抛错即终止会话并清理。 */
  readonly onChunk: (chunk: MultimonRxChunk) => void | Promise<void>;
  /** 输入等待和解码的运行预算，默认 60000 ms；触发后另有有界清理宽限。 */
  readonly timeoutMs?: number;
  readonly maxStdoutBytes?: number;
  readonly maxStderrRetainedBytes?: number;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
}

export interface MultimonReceiveResult {
  readonly source: "multimon-ng";
  readonly readOnly: true;
  readonly sessionId: string;
  readonly textChunks: number;
  readonly stdoutBytes: number;
  readonly stderrRetainedBytes: number;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly elapsedMs: number;
}

function configInteger(
  name: string,
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new MultimonReceiveError(
      "invalid_options",
      `${name} must be an integer in ${minimum}..${maximum}`,
    );
  }
  return resolved;
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<boolean> {
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

/**
 * 运行一个有界的后台收报会话：正常 EOF 补 0.5 s 静音后关闭引擎 stdin，
 * 等待引擎退出并交付流式文本。取消或失败不补静音，先 SIGTERM，500 ms
 * 未退出再 SIGKILL；任何取消后的迟到文本都被丢弃。
 */
export async function runMultimonReceive(options: MultimonReceiveOptions): Promise<MultimonReceiveResult> {
  if (typeof options.decoder !== "string" || options.decoder.length === 0 || options.decoder.trim() !== options.decoder) {
    throw new MultimonReceiveError("invalid_options", "decoder must be a non-empty executable path");
  }
  if (typeof options.sessionId !== "string" || options.sessionId.length === 0) {
    throw new MultimonReceiveError("invalid_options", "sessionId must be non-empty");
  }
  if (typeof options.onChunk !== "function") {
    throw new MultimonReceiveError("invalid_options", "onChunk callback is required");
  }
  if (options.source === null || typeof options.source !== "object") {
    throw new MultimonReceiveError("invalid_options", "PCM source must be a Readable or AsyncIterable");
  }
  const timeoutMs = configInteger(
    "timeoutMs",
    options.timeoutMs,
    MULTIMON_RECEIVE_DEFAULT_TIMEOUT_MS,
    1,
    MULTIMON_RECEIVE_MAX_TIMEOUT_MS,
  );
  const maxStdoutBytes = configInteger(
    "maxStdoutBytes",
    options.maxStdoutBytes,
    MULTIMON_RECEIVE_DEFAULT_MAX_STDOUT_BYTES,
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const maxStderrRetainedBytes = configInteger(
    "maxStderrRetainedBytes",
    options.maxStderrRetainedBytes,
    MULTIMON_RECEIVE_MAX_STDERR_RETAINED_BYTES,
    1,
    MULTIMON_RECEIVE_MAX_STDERR_RETAINED_BYTES,
  );
  const external = options.signal;
  if (external?.aborted === true) {
    throw new MultimonReceiveError("aborted", "receive was aborted before the decoder was started");
  }

  const now = options.now ?? ((): Date => new Date());
  const startedAt = Date.now();
  const textDecoder = new StringDecoder("utf8");
  const queue: string[] = [];

  type SessionState = "running" | "completed" | "failed" | "aborted";
  let state: SessionState = "running";
  let failure: MultimonReceiveError | null = null;
  let seq = 0;
  let stdoutBytes = 0;
  let stderrRetained = Buffer.alloc(0);
  let inputFinished = false;
  let sourceIsReadable = false;
  let sourceIterator: AsyncIterator<Uint8Array> | null = null;
  let stdoutPaused = false;
  let chain: Promise<void> = Promise.resolve();
  let cleanupPromise: Promise<boolean> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  // 闭包会改变 state/exitInfo；用取值函数避免 TypeScript 把控制流窄化当真。
  const getState = (): SessionState => state;
  const getExitInfo = (): { code: number | null; signal: NodeJS.Signals | null } | null => exitInfo;
  let signalStopped: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => {
    signalStopped = resolve;
  });

  const child: ChildProcessWithoutNullStreams = spawn(options.decoder, [...MULTIMON_ARGS], {
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let settleChild: () => void = () => undefined;
  const childClosed = new Promise<void>((resolve) => {
    settleChild = resolve;
  });
  let settleStdout: () => void = () => undefined;
  const stdoutClosed = new Promise<void>((resolve) => {
    settleStdout = resolve;
  });

  const beginCleanup = (): Promise<boolean> => {
    if (cleanupPromise === null) cleanupPromise = cleanup();
    return cleanupPromise;
  };

  const fail = (code: MultimonReceiveErrorCode, message: string): void => {
    if (state !== "running") return;
    state = "failed";
    failure = new MultimonReceiveError(code, message);
    signalStopped();
    void beginCleanup();
  };

  const abort = (): void => {
    if (state !== "running") return;
    state = "aborted";
    signalStopped();
    void beginCleanup();
  };

  const enqueue = (text: string): void => {
    // 引擎结束换行是帧边界；空格本身可能是单独到达的 CW 词间隔。
    text = text.replace(/[\r\n]/g, "");
    if (state !== "running" || text.length === 0) return;
    queue.push(text);
    if (!stdoutPaused && !child.stdout.destroyed) {
      stdoutPaused = true;
      child.stdout.pause();
    }
    chain = chain.then(drainQueue).catch((error: unknown) => {
      fail("callback_failed", error instanceof Error ? "text callback failed" : "text callback failed");
    });
  };

  const drainQueue = async (): Promise<void> => {
    while (queue.length > 0) {
      if (state !== "running") {
        queue.length = 0;
        break;
      }
      const text = queue.shift()!;
      seq += 1;
      await options.onChunk({
        source: "multimon-ng",
        readOnly: true,
        sessionId: options.sessionId,
        seq,
        text,
        receivedAt: now().toISOString(),
      });
    }
    if (state === "running" && queue.length === 0 && stdoutPaused && !child.stdout.destroyed) {
      stdoutPaused = false;
      child.stdout.resume();
    }
  };

  child.once("error", (error: NodeJS.ErrnoException) => {
    settleChild();
    const missing = error.code === "ENOENT";
    fail(missing ? "decoder_missing" : "decoder_failed", missing
      ? "decoder executable was not found"
      : "decoder process could not be started");
  });
  child.once("exit", (code, signal) => {
    exitInfo = { code, signal };
    settleChild();
  });
  child.once("close", () => settleChild());
  child.stdout.once("close", () => settleStdout());
  child.stdout.once("error", () => settleStdout());
  child.once("close", () => settleStdout());

  child.stdout.on("data", (chunk: Buffer) => {
    if (state !== "running") return;
    stdoutBytes += chunk.length;
    if (stdoutBytes > maxStdoutBytes) {
      fail("output_limit", `decoder stdout exceeded ${maxStdoutBytes} bytes`);
      return;
    }
    enqueue(textDecoder.write(chunk));
  });
  child.stdout.on("end", () => {
    if (state === "running") enqueue(textDecoder.end());
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const combined = Buffer.concat([stderrRetained, chunk]);
    stderrRetained = combined.length > maxStderrRetainedBytes
      ? Buffer.from(combined.subarray(combined.length - maxStderrRetainedBytes))
      : combined;
  });
  child.stdin.on("error", () => {
    if (state === "running" && !inputFinished) {
      fail("premature_exit", "decoder closed its input before the PCM stream ended");
    }
  });

  const onExternalAbort = (): void => abort();
  external?.addEventListener("abort", onExternalAbort, { once: true });
  timer = setTimeout(() => {
    timer = null;
    fail("timeout", `receive exceeded the ${timeoutMs} ms runtime budget`);
  }, timeoutMs);

  const writeChunk = (buffer: Buffer): Promise<void> => new Promise((resolve, reject) => {
    if (state !== "running" || child.stdin.destroyed) {
      reject(new MultimonReceiveError("aborted", "decoder input is no longer writable"));
      return;
    }
    child.stdin.write(buffer, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });

  const feedInput = async (): Promise<void> => {
    sourceIsReadable = options.source instanceof Readable;
    const iterator = (options.source as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
    sourceIterator = iterator;
    let pending: Buffer | null = null;
    let hasPcm = false;
    try {
      while (state === "running") {
        let next: IteratorResult<Uint8Array>;
        try {
          next = await iterator.next();
        } catch {
          fail("input_error", "PCM input stream failed");
          return;
        }
        if (next.done === true) break;
        const chunk: unknown = next.value;
        if (!(chunk instanceof Uint8Array)) {
          fail("input_error", "PCM input chunks must be byte arrays");
          return;
        }
        const incoming = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        let buffer: Buffer = pending === null ? incoming : Buffer.concat([pending, incoming]);
        pending = null;
        if (buffer.length % 2 === 1) {
          pending = Buffer.from(buffer.subarray(buffer.length - 1));
          buffer = buffer.subarray(0, buffer.length - 1);
        }
        if (buffer.length > 0) {
          try {
            await writeChunk(buffer);
            hasPcm = true;
          } catch {
            if (state === "running") fail("premature_exit", "decoder stopped accepting PCM input");
            return;
          }
        }
      }
      if (state !== "running") return;
      if (pending !== null) {
        fail("input_error", "PCM input ended with an incomplete 16-bit sample");
        return;
      }
      try {
        if (hasPcm) await writeChunk(Buffer.alloc(MULTIMON_RECEIVE_SILENCE_BYTES, 0));
      } catch {
        if (state === "running") fail("premature_exit", "decoder stopped accepting PCM input");
        return;
      }
      if (state !== "running") return;
      inputFinished = true;
      child.stdin.end();
    } finally {
      if (sourceIterator === iterator) sourceIterator = null;
    }
  };

  const feedTask = feedInput().catch(() => {
    fail("input_error", "PCM input stream failed");
  });

  async function cleanup(): Promise<boolean> {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    external?.removeEventListener("abort", onExternalAbort);
    if (state === "completed") return true;

    const iterator = sourceIterator;
    if (iterator !== null && typeof iterator.return === "function") {
      try {
        await withDeadline(Promise.resolve(iterator.return()), ITERATOR_RETURN_MS);
      } catch {
        // 尽力停止输入；下面仍会销毁本地 Readable。
      }
    }
    if (sourceIsReadable && options.source instanceof Readable && !options.source.destroyed) {
      options.source.destroy();
    }
    if (!child.stdin.destroyed) child.stdin.destroy();
    if (!child.stdout.destroyed) child.stdout.destroy();
    if (!child.stderr.destroyed) child.stderr.destroy();

    let exited = exitInfo !== null || child.pid === undefined;
    if (!exited) {
      try {
        child.kill("SIGTERM");
      } catch {
        // 子进程可能已退出；以下等待/升级仍有界。
      }
      exited = await withDeadline(childClosed, CANCEL_GRACE_MS);
    }
    if (!exited) {
      try {
        child.kill("SIGKILL");
      } catch {
        // 同上。
      }
      exited = await withDeadline(childClosed, CANCEL_GRACE_MS);
    }
    return exited;
  }

  await Promise.race([Promise.all([childClosed, stdoutClosed]), stopped]);
  await withDeadline(feedTask, INPUT_SETTLE_MS);
  await Promise.race([chain, stopped]);

  if (getState() === "running") {
    if (!inputFinished) {
      fail("premature_exit", "decoder exited before the complete PCM input was delivered");
    } else if (getExitInfo() === null) {
      fail("decoder_failed", "decoder did not report an exit status");
    } else if (getExitInfo()!.code !== 0) {
      fail("decoder_failed", `decoder exited with code ${getExitInfo()!.code ?? "null"}`);
    } else {
      state = "completed";
    }
  }

  const cleanupConfirmed = await beginCleanup();
  if (getState() === "failed") {
    const error = failure ?? new MultimonReceiveError("decoder_failed", "decoder failed");
    throw new MultimonReceiveError(error.code, error.message, cleanupConfirmed);
  }
  if (getState() === "aborted") {
    throw new MultimonReceiveError("aborted", "receive was aborted", cleanupConfirmed);
  }

  return {
    source: "multimon-ng",
    readOnly: true,
    sessionId: options.sessionId,
    textChunks: seq,
    stdoutBytes,
    stderrRetainedBytes: stderrRetained.length,
    exitCode: getExitInfo()?.code ?? null,
    signal: getExitInfo()?.signal ?? null,
    elapsedMs: Date.now() - startedAt,
  };
}
