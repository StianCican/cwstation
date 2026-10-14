// 键控器契约与 Fake 实现。
// FakeKeyer 仅用于离线/测试：支持可控时长与故障注入，绝不接触真实电台。
// 重要安全语义：即使键控器忽略 abort，调用方也必须能超时并判定为 unknown。

import type { TxRequest, TxResult } from "../../contracts/src/index.js";

export interface Keyer {
  /** 已实际调用键控的次数；真实键控器可省略。 */
  readonly keyedCount?: number;
  readonly executionMetrics?: ExecutionMetrics;
  transmit(request: TxRequest, signal: AbortSignal): Promise<TxResult>;
}

export interface ExecutionMetrics {
  readonly version: 1;
  readonly source: "simulation";
  readonly sendAttempts: number;
  readonly confirmedCompletions: number;
  readonly confirmedStops: number;
  readonly uncertainAttempts: number;
}

export interface FakeKeyerOptions {
  /** 正常完成所需时间；默认 30ms。 */
  durationMs?: number;
  /** 到期后抛出该消息，模拟后端故障。 */
  fault?: string | null;
  /** true 时忽略 abort 信号，模拟无法证明停止的键控器。 */
  ignoreAbort?: boolean;
}

export class KeyerAbortError extends Error {
  constructor(message = "transmission cancelled") {
    super(message);
    this.name = "KeyerAbortError";
  }
}

export class FakeKeyer implements Keyer {
  private keyCount = 0;

  constructor(private readonly options: FakeKeyerOptions = {}) {}

  /** 实际调用键控的次数；用于验证“同 ID 只键控一次”。 */
  get keyedCount(): number {
    return this.keyCount;
  }

  async transmit(request: TxRequest, signal: AbortSignal): Promise<TxResult> {
    this.keyCount += 1;
    const startedAt = new Date().toISOString();

    // 预先 abort：不得启动，也不得留下未清理监听器。
    if (signal.aborted) {
      return { requestId: request.proposal.id, outcome: "cancelled", startedAt, finishedAt: new Date().toISOString() };
    }

    const durationMs = this.options.durationMs ?? 30;
    const fault = this.options.fault ?? null;
    const ignoreAbort = this.options.ignoreAbort === true;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      };
      const onAbort = (): void => {
        if (settled) return;
        if (ignoreAbort) return; // 故意忽略，让调用方走超时/unknown 路径。
        settled = true;
        cleanup();
        reject(new KeyerAbortError());
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      }, durationMs);
      signal.addEventListener("abort", onAbort, { once: true });
    });

    if (fault) throw new Error(fault);
    return {
      requestId: request.proposal.id,
      outcome: "completed",
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }
}
