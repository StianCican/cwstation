// V00-04-A：会话级回复自动派发授权。
//
// 本对象只保存模式、控制代次和一次性 lease，不接收音频、不构建帧、不打开
// 设备、不写记录、不运行发送循环。CLI/GUI/嵌入调用者共享同一个实例；模式
// 切换、编辑、停止或显式撤销都会使旧 lease 永久失效，重新启用自动模式也
// 不能复活旧 lease。

export type ReplyDispatchMode = "manual" | "automatic";

export interface ReplyDispatchIdentity {
  readonly text: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly revision: number;
}

export interface ReplyDispatchLease {
  readonly mode: "automatic";
  readonly generation: number;
  readonly identity: ReplyDispatchIdentity;
}

export type ReplyDispatchDenial =
  | "stopped"
  | "manual"
  | "invalid_identity"
  | "invalid_validity_check"
  | "proposal_no_longer_current"
  | "already_consumed"
  | "capacity_exhausted"
  | "revoked"
  | "stale_generation"
  | "identity_mismatch";

export type ReplyDispatchAuthorization =
  | { readonly authorized: true; readonly lease: ReplyDispatchLease }
  | { readonly authorized: false; readonly reason: ReplyDispatchDenial };

export interface ReplyDispatchControlOptions {
  /** 会话开始时的初始模式；缺省为人工。 */
  readonly automatic?: boolean;
}

/** 会话内提案数量有限；该上限只防止异常调用无限积累失效身份。 */
const MAX_RETIRED_IDENTITIES = 4096;

function identityProblem(identity: ReplyDispatchIdentity): string | null {
  if (typeof identity.text !== "string" || identity.text.length === 0) return "text must be non-empty";
  if (typeof identity.sessionId !== "string" || identity.sessionId.length === 0) return "sessionId must be non-empty";
  if (typeof identity.turnId !== "string" || identity.turnId.length === 0) return "turnId must be non-empty";
  if (!Number.isInteger(identity.revision) || identity.revision < 1) return "revision must be a positive integer";
  return null;
}

function identityKey(identity: ReplyDispatchIdentity): string {
  // JSON array encoding keeps exact text and identifiers unambiguous.
  return JSON.stringify([identity.sessionId, identity.turnId, identity.revision, identity.text]);
}

function proposalKey(identity: ReplyDispatchIdentity): string {
  return JSON.stringify([identity.sessionId, identity.turnId, identity.revision]);
}

function copyIdentity(identity: ReplyDispatchIdentity): ReplyDispatchIdentity {
  return Object.freeze({
    text: identity.text,
    sessionId: identity.sessionId,
    turnId: identity.turnId,
    revision: identity.revision,
  });
}

/**
 * 会话级自动派发授权。默认人工；只有显式 automatic 模式才签发 lease。
 * 调用者必须在每个异步步骤后和紧邻发送前检查，并在发送前一次性消费。
 */
export class ReplyDispatchControl {
  #mode: ReplyDispatchMode;
  #generation = 1;
  #lease: ReplyDispatchLease | null = null;
  readonly #consumed = new Set<string>();
  readonly #blocked = new Set<string>();
  readonly #stopController = new AbortController();

  constructor(options: ReplyDispatchControlOptions = {}) {
    this.#mode = options.automatic === true ? "automatic" : "manual";
  }

  get mode(): ReplyDispatchMode {
    return this.#mode;
  }

  get signal(): AbortSignal {
    return this.#stopController.signal;
  }

  /** 每次模式变化或撤销都会推进代次；lease 绑定签发时的代次。 */
  get generation(): number {
    return this.#generation;
  }

  get hasLease(): boolean {
    return this.#lease !== null;
  }

  /** 切换模式；任意实际切换都会撤销当前 lease 并推进代次。 */
  setMode(mode: ReplyDispatchMode): void {
    if (mode !== "manual" && mode !== "automatic") {
      throw new Error(`invalid reply dispatch mode: ${String(mode)}`);
    }
    if (this.signal.aborted || mode === this.#mode) return;
    this.#mode = mode;
    this.#invalidate();
  }

  enableAutomatic(): void {
    this.setMode("automatic");
  }

  requireManual(): void {
    this.setMode("manual");
  }

  /** 显式撤销当前自动派发资格；不改变会话级模式。 */
  revoke(): void {
    this.#invalidate();
  }

  /** 编辑暂停自动模式；只有调用者显式重新启用才可恢复。 */
  beginEdit(): void {
    this.#mode = "manual";
    this.#invalidate();
  }

  /** 停止/退出时撤销；旧 lease 不可复活。 */
  stop(): void {
    this.#mode = "manual";
    this.#invalidate();
    this.#stopController.abort();
  }

  /**
   * 为当前提案签发自动 lease。人工模式或提案已失效时拒绝；同一提案在
   * 消费前重复授权返回同一 lease，消费后永不再次签发。
   */
  authorize(
    identity: ReplyDispatchIdentity,
    isCurrent: () => boolean,
  ): ReplyDispatchAuthorization {
    if (this.signal.aborted) return { authorized: false, reason: "stopped" };
    if (identityProblem(identity) !== null) return { authorized: false, reason: "invalid_identity" };
    if (typeof isCurrent !== "function") return { authorized: false, reason: "invalid_validity_check" };
    if (this.#mode !== "automatic") return { authorized: false, reason: "manual" };
    if (!isCurrent()) return { authorized: false, reason: "proposal_no_longer_current" };
    const key = identityKey(identity);
    if (this.#consumed.has(proposalKey(identity))) return { authorized: false, reason: "already_consumed" };
    if (this.#blocked.has(key)) return { authorized: false, reason: "revoked" };
    if (this.#consumed.size + this.#blocked.size >= MAX_RETIRED_IDENTITIES) {
      return { authorized: false, reason: "capacity_exhausted" };
    }
    if (this.#lease !== null && this.#lease.generation === this.#generation
        && identityKey(this.#lease.identity) === key) {
      return { authorized: true, lease: this.#lease };
    }
    // 新提案替换旧 lease；旧提案永久退出自动资格。首次授权不推进代次。
    if (this.#lease !== null) this.#invalidate();
    this.#lease = Object.freeze({
      mode: "automatic" as const,
      generation: this.#generation,
      identity: copyIdentity(identity),
    });
    return { authorized: true, lease: this.#lease };
  }

  /** 非消费检查：null 表示当前仍可自动派发。 */
  check(lease: ReplyDispatchLease, isCurrent: () => boolean): ReplyDispatchDenial | null {
    if (this.signal.aborted) return "stopped";
    if (this.#mode !== "automatic") return "manual";
    if (typeof isCurrent !== "function") return "invalid_validity_check";
    const key = identityKey(lease.identity);
    if (this.#consumed.has(proposalKey(lease.identity))) return "already_consumed";
    if (this.#blocked.has(key)) return "revoked";
    if (lease.generation !== this.#generation) return "stale_generation";
    if (this.#lease === null) return "revoked";
    if (this.#lease.generation !== lease.generation) return "revoked";
    if (identityKey(this.#lease.identity) !== key) return "identity_mismatch";
    if (!isCurrent()) return "proposal_no_longer_current";
    return null;
  }

  /**
   * 紧邻发送前的一次性消费。成功返回 null；失败返回拒绝原因且不改变状态。
   * 消费后 lease、同一提案的再次授权以及后续检查全部失败。
   */
  consume(lease: ReplyDispatchLease, isCurrent: () => boolean): ReplyDispatchDenial | null {
    const denial = this.check(lease, isCurrent);
    if (denial !== null) return denial;
    const current = this.#lease;
    if (current === null) return "revoked";
    this.#consumed.add(proposalKey(current.identity));
    this.#lease = null;
    this.#generation += 1;
    return null;
  }

  #invalidate(): void {
    if (this.#lease !== null) this.#blocked.add(identityKey(this.#lease.identity));
    this.#generation += 1;
    this.#lease = null;
  }
}
