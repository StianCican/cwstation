// P2-014 A 候选只读投影类型与固定能力摘要（纯类型/纯函数，不调用仲裁）。
//
// 设计依据：docs/design/P2-013-只读接入实施契约.md v3.1 §4 与
// docs/tasks/P2-014-离线统一查询仲裁.md。本模块只声明候选投影 v1 的只读类型、
// 固定六 kind 能力值和私有固定九项数组的 SHA256 摘要函数。
//
// 边界：
//  - 不调用 CivReadArbiter，不实现 IPC decoder、收包 TTL 转换或真实 renderer
//    映射；这些留在 B/C 单独交付。类型不是运行时校验。
//  - 不从 rig-status/src/index.ts 导出，不修改 RigStatusReport 或批准门禁。
//  - 导出能力是私有摘要真源的副本：调用方改写返回值不能污染摘要输入。
//  - 身份只能产生 unverified；hardwareFingerprint/verified 是未来保留分支，
//    本模块不据此声明稳定设备身份。

import { createHash } from "node:crypto";
import type { ContextReadKind, ContextReadReading } from "../../devices/src/civ-context-read.js";

/** 候选 context 投影 schema 版本。 */
export const CONTEXT_PROJECTION_SCHEMA_VERSION = 1 as const;

/** 候选 context 字段 TTL（与 P2-013 契约一致）。 */
export const CONTEXT_PROJECTION_TTL_MS = 6_000;

/**
 * 六 kind 规范顺序的导出副本（已冻结）。它只是能力值的只读副本，
 * 摘要函数另有同名私有真源，两者不是同一个数组对象。
 */
export const CONTEXT_READ_KINDS: readonly ContextReadKind[] = Object.freeze<ContextReadKind[]>([
  "txFrequency",
  "txStatus",
  "splitEnabled",
  "ritEnabled",
  "xitEnabled",
  "breakIn",
]);

// ── 私有摘要真源 ──────────────────────────────────────────────────────────
//
// 固定九项数组，按 P2-013 §4：schemaVersion、radioAddress、controllerAddress、
// readKinds、cwSend、cwStop、ptt、completionEvidence、stopEvidence。
// 真源与任何导出对象分离，调用方无法通过改写导出能力影响摘要结果。

const DIGEST_INPUT_SOURCE: readonly unknown[] = Object.freeze([
  CONTEXT_PROJECTION_SCHEMA_VERSION,
  148,
  224,
  Object.freeze([...CONTEXT_READ_KINDS]),
  false,
  false,
  false,
  "unavailable",
  "unavailable",
]);

/** 候选投影身份 v1；verification 默认 unverified，且无稳定硬件身份真源。 */
export interface ContextProjectionIdentityV1 {
  readonly configuredId: string | null;
  readonly hardwareFingerprint: string | null;
  readonly verification: "unverified" | "verified";
}

/** 候选只读能力 v1；发送/停止/PTT 恒为 false，完成/停止证据不可用。 */
export interface ContextProjectionCapabilitiesV1 {
  readonly version: 1;
  readonly radioAddress: 148;
  readonly controllerAddress: 224;
  readonly readKinds: readonly ContextReadKind[];
  readonly cwSend: false;
  readonly cwStop: false;
  readonly ptt: false;
  readonly completionEvidence: "unavailable";
  readonly stopEvidence: "unavailable";
}

/** 单个 context 字段的候选投影；readonly，sampledAt 为 epoch 毫秒。 */
export interface ContextProjectionFieldV1 {
  readonly reading: ContextReadReading | null;
  readonly sampledAt: number | null;
  readonly quality: "unknown" | "fresh" | "stale";
  readonly ttlMs: 6000;
}

/** P2-013 §4 候选投影 v1；所有对象/数组字段只读。 */
export interface ContextProjectionV1 {
  readonly schemaVersion: 1;
  readonly contextSource: "simulation" | "serial";
  readonly serviceInstanceId: string;
  readonly connectionGeneration: number;
  readonly phase: "idle" | "reading" | "closing" | "locked" | "closed";
  readonly error: string | null;
  readonly identity: ContextProjectionIdentityV1;
  readonly capabilities: ContextProjectionCapabilitiesV1;
  readonly capabilitiesDigest: string;
  readonly fields: Readonly<Record<ContextReadKind, ContextProjectionFieldV1>>;
}

/** 返回六 kind 规范顺序的独立冻结副本。 */
export function contextReadKindsV1(): readonly ContextReadKind[] {
  return Object.freeze([...CONTEXT_READ_KINDS]);
}

/**
 * 返回固定能力值的独立冻结副本。副本不能污染私有摘要真源；能力改变必须
 * 升版本并使旧 context 失效，不能就地放宽本对象。
 */
export function contextProjectionCapabilitiesV1(): ContextProjectionCapabilitiesV1 {
  const capabilities: ContextProjectionCapabilitiesV1 = {
    version: CONTEXT_PROJECTION_SCHEMA_VERSION,
    radioAddress: 148,
    controllerAddress: 224,
    readKinds: contextReadKindsV1(),
    cwSend: false,
    cwStop: false,
    ptt: false,
    completionEvidence: "unavailable",
    stopEvidence: "unavailable",
  };
  return Object.freeze(capabilities);
}

/**
 * 纯能力摘要：对固定九项位置数组做 UTF-8 JSON 的 SHA256，64 位小写 hex。
 * 输入是模块私有冻结真源，不接受调用方传入能力对象，也不读写任何外部状态。
 */
export function computeContextCapabilitiesDigest(): string {
  return createHash("sha256").update(JSON.stringify(DIGEST_INPUT_SOURCE), "utf8").digest("hex");
}
