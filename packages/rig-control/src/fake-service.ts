// P2-002a：受监督的 Fake 设备服务与显式目录账本。
//
// 边界（docs/tasks/P2-002a-Fake-IPC链路.md）：
//  - 仅模拟 IC-7300 的 CW Command 17（30 字节），复用 planCivCwMessage /
//    contentHash；绝不导入 serialport 或真实串口工厂，不接受 --port。
//  - 单一在途 send；stop/close 保留优先控制槽。
//  - 显式目录账本 JSONL：intent 刷盘后才计后端调用，终态追加；恢复未决为
//    unknown 并阻止新 send；同键同摘要重放零副作用，不同摘要冲突。
//  - 会话密钥只在内存中，（hello 私有帧交付），不落盘、不进日志。
//  - 停止只凭已握手控制会话，不受 send 授权期限限制。
//
// 此文件中的 test* 选项是显式的 Fake 故障注入，仅测试通过 argv 启用。

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { acquireLock, type LockHandle } from "../../daemon/src/lock.js";
import type { StationMode } from "../../contracts/src/index.js";
import { contentHash } from "../../core/src/tx-controller.js";
import { civPlanHex, planCivCwMessage, type CivCwPlan } from "../../devices/src/civ-tx-plan.js";
import {
  RIG_CONTROL_BACKEND_KIND,
  RIG_CONTROL_CHARSET_VERSION,
  RIG_CONTROL_EVIDENCE_SOURCE,
  RIG_CONTROL_MAX_DEVICE_ID_LENGTH,
  RIG_CONTROL_MAX_EXPIRES_MS,
  RIG_CONTROL_MAX_MESSAGE_BYTES,
  RIG_CONTROL_METHODS,
  RIG_CONTROL_PROTOCOL_VERSION,
  RigControlError,
  cwSendRequestDigest,
  extractRequestId,
  validateCwSendParams,
  validateCwStopParams,
  validateEmptyParams,
  validateHelloParams,
  validateOperationGetParams,
  validateRequest,
  verifyCwSendToken,
  type CwSendParams,
  type CwStopParams,
  type DeviceCapabilities,
  type DeviceCloseResult,
  type DeviceSnapshot,
  type HelloParams,
  type HelloResult,
  type OperationResult,
  type OperationState,
  type RigControlRequest,
  type RigControlResponse,
  type StopResult,
} from "./protocol.js";

// ── 账本记录 ──────────────────────────────────────────────────────────────

const LEDGER_SCHEMA_VERSION = 1 as const;
const MAX_LEDGER_BYTES = 8 * 1024 * 1024;
const MAX_LEDGER_RECORDS = 10_000;

interface LedgerIntent {
  readonly schemaVersion: typeof LEDGER_SCHEMA_VERSION;
  readonly type: "intent";
  readonly at: number;
  readonly operationId: string;
  readonly deviceInstanceId: string;
  readonly civAddress: number;
  readonly text: string;
  readonly contentSha256: string;
  readonly frequencyHz: number;
  readonly mode: StationMode;
  readonly connectionGeneration: number;
  readonly permissionGeneration: number;
  readonly stateGeneration: number;
  readonly expiresAt: number;
  readonly requestDigest: string;
}

interface LedgerTerminal {
  readonly schemaVersion: typeof LEDGER_SCHEMA_VERSION;
  readonly type: "terminal";
  readonly at: number;
  readonly operationId: string;
  readonly outcome: "completed" | "cancelled" | "unknown";
  readonly evidence: string;
  readonly reason: string | null;
  readonly frameHex: string | null;
  readonly frameBytes: number | null;
}

interface LedgerStop {
  readonly schemaVersion: typeof LEDGER_SCHEMA_VERSION;
  readonly type: "stop";
  readonly at: number;
  readonly stopId: string;
  readonly operationId: string;
  readonly outcome: "cancelled" | "unknown";
  readonly evidence: string;
}

type LedgerRecord = LedgerIntent | LedgerTerminal | LedgerStop;

function recordError(index: number, message: string): Error {
  return new Error(`ledger record ${index + 1}: ${message}`);
}

function parseLedgerRecord(raw: unknown, index: number): LedgerRecord {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw recordError(index, "must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.schemaVersion !== LEDGER_SCHEMA_VERSION) throw recordError(index, "unsupported schemaVersion");
  const fields = obj.type === "intent"
    ? ["schemaVersion", "type", "at", "operationId", "deviceInstanceId", "civAddress", "text", "contentSha256", "frequencyHz", "mode", "connectionGeneration", "permissionGeneration", "stateGeneration", "expiresAt", "requestDigest"]
    : obj.type === "terminal"
      ? ["schemaVersion", "type", "at", "operationId", "outcome", "evidence", "reason", "frameHex", "frameBytes"]
      : ["schemaVersion", "type", "at", "stopId", "operationId", "outcome", "evidence"];
  if (Object.keys(obj).length !== fields.length || fields.some(key => !(key in obj))) {
    throw recordError(index, "unexpected or missing fields");
  }
  if (!Number.isSafeInteger(obj.at) || (obj.at as number) < 0 ||
      typeof obj.operationId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(obj.operationId)) {
    throw recordError(index, "invalid timestamp or operationId");
  }
  if (obj.type === "intent") {
    for (const key of [
      "at",
      "operationId",
      "deviceInstanceId",
      "text",
      "contentSha256",
      "frequencyHz",
      "mode",
      "connectionGeneration",
      "permissionGeneration",
      "stateGeneration",
      "expiresAt",
      "requestDigest",
    ]) {
      if (!(key in obj)) throw recordError(index, `intent is missing ${key}`);
    }
    if (
      typeof obj.operationId !== "string" ||
      typeof obj.deviceInstanceId !== "string" ||
      typeof obj.text !== "string" ||
      typeof obj.contentSha256 !== "string" ||
      typeof obj.frequencyHz !== "number" ||
      obj.mode !== "CW" ||
      typeof obj.connectionGeneration !== "number" ||
      typeof obj.permissionGeneration !== "number" ||
      typeof obj.stateGeneration !== "number" ||
      typeof obj.expiresAt !== "number" ||
      typeof obj.at !== "number" ||
      typeof obj.requestDigest !== "string"
    ) {
      throw recordError(index, "intent has invalid field types");
    }
    const params = validateCwSendParams({
      ...Object.fromEntries(Object.entries(obj).filter(([key]) => !["schemaVersion", "type", "at", "requestDigest", "civAddress"].includes(key))),
      serviceInstanceId: "ledger", nonce: "0".repeat(32), token: "0".repeat(64),
    });
    if (!Number.isInteger(obj.civAddress) || (obj.civAddress as number) < 1 || (obj.civAddress as number) > 0xdf) throw recordError(index, "invalid civAddress");
    planCivCwMessage(params.text, { radioAddress: obj.civAddress as number });
    if (params.contentSha256 !== contentHash(params.text, params.frequencyHz, params.mode) ||
        obj.requestDigest !== cwSendRequestDigest(params)) throw recordError(index, "intent digest mismatch");
    return obj as unknown as LedgerIntent;
  }
  if (obj.type === "terminal") {
    if (
      typeof obj.operationId !== "string" ||
      typeof obj.at !== "number" ||
      (obj.outcome !== "completed" && obj.outcome !== "cancelled" && obj.outcome !== "unknown") ||
      typeof obj.evidence !== "string" ||
      !(obj.reason === null || typeof obj.reason === "string") ||
      !(obj.frameHex === null || (typeof obj.frameHex === "string" && /^(?:[0-9a-f]{2})(?: [0-9a-f]{2})*$/.test(obj.frameHex))) ||
      !(obj.frameBytes === null || (Number.isSafeInteger(obj.frameBytes) && (obj.frameBytes as number) > 0)) ||
      (obj.outcome === "completed" && obj.evidence !== "backend_completed") ||
      (obj.outcome === "cancelled" && obj.evidence !== "backend_stopped")
    ) {
      throw recordError(index, "terminal has invalid field types");
    }
    return obj as unknown as LedgerTerminal;
  }
  if (obj.type === "stop") {
    if (
      typeof obj.stopId !== "string" ||
      typeof obj.operationId !== "string" ||
      typeof obj.at !== "number" ||
      (obj.outcome !== "cancelled" && obj.outcome !== "unknown") ||
      typeof obj.evidence !== "string"
    ) {
      throw recordError(index, "stop has invalid field types");
    }
    validateCwStopParams({ stopId: obj.stopId, operationId: obj.operationId });
    return obj as unknown as LedgerStop;
  }
  throw recordError(index, "unknown record type");
}

/** 单写者账本：复用既有锁 + 串行追加 + 每条 fsync。 */
class Ledger {
  private fd: number | null = null;
  private lock: LockHandle | null = null;
  private bytes = 0;
  private records = 0;

  constructor(
    private readonly path: string,
    private readonly lockPath: string,
  ) {}

  open(serviceInstanceId: string): void {
    mkdirSync(dirname(this.path), { recursive: true });
    this.lock = acquireLock(this.lockPath, `rig-faked:${serviceInstanceId}`);
    try {
      this.fd = openSync(this.path, "a", 0o600);
      const stat = statSync(this.path);
      if (!stat.isFile()) throw new Error("ledger must be a regular file");
      this.bytes = stat.size;
    } catch (error) {
      this.close();
      throw error;
    }
  }

  readRecords(): LedgerRecord[] {
    if (!existsSync(this.path)) return [];
    if (this.bytes > MAX_LEDGER_BYTES) throw new Error("ledger exceeds byte limit");
    const text = readFileSync(this.path, "utf8");
    const records: LedgerRecord[] = [];
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]?.trim() ?? "";
      if (line.length === 0) continue;
      if (Buffer.byteLength(line) > 16_384 || records.length >= MAX_LEDGER_RECORDS) throw recordError(index, "ledger limit exceeded");
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw recordError(index, "is not valid JSON");
      }
      records.push(parseLedgerRecord(parsed, index));
    }
    this.records = records.length;
    return records;
  }

  append(record: LedgerRecord): void {
    if (this.fd === null) throw new Error("ledger is not open");
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
    if (this.records >= MAX_LEDGER_RECORDS || this.bytes + bytes.length > MAX_LEDGER_BYTES) throw new Error("ledger limit exceeded");
    for (let offset = 0; offset < bytes.length;) {
      const written = writeSync(this.fd, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error("ledger short write");
      offset += written;
    }
    fsyncSync(this.fd);
    this.bytes += bytes.length;
    this.records += 1;
  }

  close(): void {
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch {
        // 关闭失败不改变禁发状态。
      }
      this.fd = null;
    }
    this.lock?.release();
    this.lock = null;
  }
}

// ── Fake 设备服务 ─────────────────────────────────────────────────────────

interface OperationEntry {
  readonly intent: LedgerIntent;
  terminal: LedgerTerminal | null;
}

interface InFlight {
  readonly operationId: string;
  readonly plan: CivCwPlan;
  timer: ReturnType<typeof setTimeout> | null;
  readonly resolve: (result: OperationResult) => void;
}

export interface FakeRigServiceOptions {
  /** 账本目录；服务在其中维护 ledger.jsonl 与 ledger.lock。 */
  readonly ledgerDir: string;
  /** 稳定配置设备标识，跨重启不变；不随启动变化。 */
  readonly deviceInstanceId: string;
  /** 模拟频率（Hz），代表 Fake 的 TX 上下文。 */
  readonly frequencyHz?: number;
  readonly model?: string;
  readonly civAddress?: number;
  /** 显式测试故障注入：后端完成延迟（毫秒）。 */
  readonly testDelayMs?: number;
  /** 显式测试故障注入：send 永不完成。 */
  readonly testHangSend?: boolean;
  /** 显式测试故障注入：stop 是否提供可靠停止证据。 */
  readonly testStopEvidence?: "stopped" | "none";
  readonly testLedgerWriteFailure?: boolean;
  readonly now?: () => number;
}

function resolveInteger(name: string, value: number | undefined, fallback: number, min: number, max: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new Error(`${name} must be an integer in [${min}, ${max}]`);
  }
  return resolved;
}

export class FakeRigService {
  readonly deviceInstanceId: string;
  readonly serviceInstanceId: string;
  readonly frequencyHz: number;
  readonly model: string;
  readonly civAddress: number;

  private readonly ledger: Ledger;
  private readonly now: () => number;
  private readonly testDelayMs: number;
  private readonly testHangSend: boolean;
  private readonly testStopEvidence: "stopped" | "none";
  private readonly testLedgerWriteFailure: boolean;

  private readonly operations = new Map<string, OperationEntry>();
  private readonly stops = new Map<string, LedgerStop>();
  private readonly usedNonces = new Set<string>();

  private helloDone = false;
  private sessionKey: string | null = null;
  private closed = false;
  private blockedReason: string | null = null;
  private ledgerFault = false;

  private connectionGeneration = 0;
  private permissionGeneration = 0;
  /**
   * 最后接受的核心 stateGeneration；初始 0。
   * 这是诊断值，不是设备连接/许可代次，也不得与新的核心代次强制相等：
   * 只在 intent 成功刷盘后提升，小于已接受代次的新操作按回退拒绝。
   */
  private stateGeneration = 0;

  private inFlight: InFlight | null = null;
  private backendCallCount = 0;

  constructor(options: FakeRigServiceOptions) {
    if (
      typeof options.deviceInstanceId !== "string" ||
      options.deviceInstanceId.length === 0 ||
      options.deviceInstanceId.length > RIG_CONTROL_MAX_DEVICE_ID_LENGTH
    ) {
      throw new Error("deviceInstanceId must be a non-empty string within the configured limit");
    }
    if (typeof options.ledgerDir !== "string" || options.ledgerDir.length === 0) {
      throw new Error("ledgerDir is required");
    }
    this.deviceInstanceId = options.deviceInstanceId;
    this.serviceInstanceId = randomUUID();
    this.frequencyHz = resolveInteger("frequencyHz", options.frequencyHz, 14_000_000, 1, 100_000_000);
    this.model = options.model ?? "IC-7300";
    this.civAddress = resolveInteger("civAddress", options.civAddress, 0x94, 0x01, 0xdf);
    this.now = options.now ?? (() => Date.now());
    this.testDelayMs = resolveInteger("testDelayMs", options.testDelayMs, 30, 0, 60_000);
    this.testHangSend = options.testHangSend === true;
    this.testStopEvidence = options.testStopEvidence ?? "stopped";
    this.testLedgerWriteFailure = options.testLedgerWriteFailure === true;
    if (this.testStopEvidence !== "stopped" && this.testStopEvidence !== "none") {
      throw new Error('testStopEvidence must be "stopped" or "none"');
    }

    this.ledger = new Ledger(join(options.ledgerDir, "ledger.jsonl"), join(options.ledgerDir, "ledger.lock"));
    this.ledger.open(this.serviceInstanceId);
    try {
      this.loadLedger();
      this.recoverUnfinished();
    } catch (error) {
      this.operations.clear();
      this.stops.clear();
      this.ledgerFault = true;
      this.blockedReason = "ledger_fault";
      process.stderr.write(`rig-faked: ledger blocked: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  /** 供测试/诊断：本进程实际发起过的后端调用次数（intent 刷盘后计数）。 */
  get backendCalls(): number {
    return this.backendCallCount;
  }

  get blocked(): string | null {
    return this.blockedReason;
  }

  private loadLedger(): void {
    for (const record of this.ledger.readRecords()) {
      if (record.type === "intent") {
        if (record.deviceInstanceId !== this.deviceInstanceId || this.operations.has(record.operationId)) throw new Error("foreign device or duplicate intent");
        this.stateGeneration = Math.max(this.stateGeneration, record.stateGeneration);
        this.operations.set(record.operationId, { intent: record, terminal: null });
      } else if (record.type === "terminal") {
        const entry = this.operations.get(record.operationId);
        if (entry === undefined) {
          // 终态先于 intent 出现属于损坏；拒绝在该账本上继续。
          throw new Error(`terminal for unknown operationId ${record.operationId}`);
        }
        if (entry.terminal !== null) throw new Error("duplicate terminal");
        const frame = planCivCwMessage(entry.intent.text, { radioAddress: entry.intent.civAddress });
        if (record.frameHex !== civPlanHex(frame) || record.frameBytes !== frame.bytes.length) throw new Error("terminal frame mismatch");
        entry.terminal = record;
      } else {
        if (this.stops.has(record.stopId) || !this.operations.has(record.operationId)) throw new Error("duplicate or orphan stop");
        this.stops.set(record.stopId, record);
      }
    }
  }

  private recoverUnfinished(): void {
    for (const entry of this.operations.values()) {
      if (entry.terminal !== null) continue;
      const frame = this.frameOfText(entry.intent.text, entry.intent.civAddress);
      const terminal: LedgerTerminal = {
        schemaVersion: LEDGER_SCHEMA_VERSION,
        type: "terminal",
        at: this.now(),
        operationId: entry.intent.operationId,
        outcome: "unknown",
        evidence: "recovered_unfinished",
        reason: "service restarted with an unfinished operation",
        frameHex: frame === null ? null : civPlanHex(frame),
        frameBytes: frame === null ? null : frame.bytes.length,
      };
      this.ledger.append(terminal);
      entry.terminal = terminal;
      this.blockedReason = "unknown";
    }
    for (const entry of this.operations.values()) {
      if (entry.terminal?.outcome === "unknown") this.blockedReason = "unknown";
    }
  }

  private frameOfText(text: string, radioAddress = this.civAddress): CivCwPlan | null {
    try {
      return planCivCwMessage(text, { radioAddress });
    } catch {
      return null;
    }
  }

  private markLedgerFault(message: string): void {
    this.ledgerFault = true;
    this.blockedReason = "ledger_fault";
    process.stderr.write(`rig-faked: ledger write failed: ${message}\n`);
  }

  private append(record: LedgerRecord): boolean {
    try {
      if (this.testLedgerWriteFailure) throw new Error("simulated ledger write failure");
      this.ledger.append(record);
      return true;
    } catch (error) {
      this.markLedgerFault(error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  private assertHello(): void {
    if (!this.helloDone || this.sessionKey === null) {
      throw new RigControlError("unauthorized", "control session has not completed hello");
    }
  }

  // ── 请求分派 ────────────────────────────────────────────────────────────

  async handleRequest(parsed: unknown): Promise<RigControlResponse> {
    const id = extractRequestId(parsed);
    try {
      const request = validateRequest(parsed);
      const result = await this.dispatch(request);
      return { protocolVersion: RIG_CONTROL_PROTOCOL_VERSION, id: request.id, ok: true, result };
    } catch (error) {
      const code = error instanceof RigControlError ? error.code : "internal";
      const message = error instanceof RigControlError ? error.message : "internal error";
      return { protocolVersion: RIG_CONTROL_PROTOCOL_VERSION, id, ok: false, error: { code, message } };
    }
  }

  private async dispatch(request: RigControlRequest): Promise<unknown> {
    if (request.method === "hello") return this.hello(validateHelloParams(request.params));
    this.assertHello();
    switch (request.method) {
      case "device.capabilities":
        validateEmptyParams(request.params, request.method);
        return this.capabilities();
      case "device.snapshot":
        validateEmptyParams(request.params, request.method);
        return this.snapshot();
      case "cw.send":
        return await this.send(validateCwSendParams(request.params));
      case "cw.stop":
        return this.stop(validateCwStopParams(request.params));
      case "operation.get":
        return this.operationGet(validateOperationGetParams(request.params));
      case "device.close":
        validateEmptyParams(request.params, request.method);
        return await this.closeDevice();
      default:
        throw new RigControlError("unknown_method", `unknown method: ${request.method}`);
    }
  }

  // ── 方法实现 ────────────────────────────────────────────────────────────

  private hello(params: HelloParams): HelloResult {
    if (this.helloDone) {
      throw new RigControlError("conflict", "control session is already established");
    }
    if (params.deviceInstanceId !== this.deviceInstanceId) {
      throw new RigControlError("unauthorized", "deviceInstanceId does not match this service");
    }
    this.sessionKey = params.sessionKey;
    this.helloDone = true;
    return {
      protocolVersion: RIG_CONTROL_PROTOCOL_VERSION,
      deviceInstanceId: this.deviceInstanceId,
      serviceInstanceId: this.serviceInstanceId,
    };
  }

  private capabilities(): DeviceCapabilities {
    return {
      protocolVersion: RIG_CONTROL_PROTOCOL_VERSION,
      backendKind: RIG_CONTROL_BACKEND_KIND,
      evidenceSource: RIG_CONTROL_EVIDENCE_SOURCE,
      model: this.model,
      civAddress: this.civAddress,
      deviceInstanceId: this.deviceInstanceId,
      serviceInstanceId: this.serviceInstanceId,
      maxMessageBytes: RIG_CONTROL_MAX_MESSAGE_BYTES,
      charsetVersion: RIG_CONTROL_CHARSET_VERSION,
      reliableCompletionEvidence: true,
      reliableStopEvidence: this.testStopEvidence === "stopped",
      connectionGeneration: this.connectionGeneration,
      permissionGeneration: this.permissionGeneration,
      stateGeneration: this.stateGeneration,
      blocked: this.blockedReason !== null,
      blockedReason: this.blockedReason,
      methods: RIG_CONTROL_METHODS,
    };
  }

  private snapshot(): DeviceSnapshot {
    return {
      deviceInstanceId: this.deviceInstanceId,
      serviceInstanceId: this.serviceInstanceId,
      frequencyHz: this.frequencyHz,
      mode: "CW",
      snapshotTime: this.now(),
      simulation: true,
      connectionGeneration: this.connectionGeneration,
      permissionGeneration: this.permissionGeneration,
      stateGeneration: this.stateGeneration,
    };
  }

  private async send(params: CwSendParams): Promise<OperationResult> {
    if (params.deviceInstanceId !== this.deviceInstanceId) {
      throw new RigControlError("unauthorized", "deviceInstanceId mismatch");
    }
    if (params.serviceInstanceId !== this.serviceInstanceId) {
      throw new RigControlError("unauthorized", "serviceInstanceId mismatch");
    }
    const sessionKey = this.sessionKey;
    if (sessionKey === null || !verifyCwSendToken(sessionKey, params, params.token)) {
      throw new RigControlError("unauthorized", "cw.send token verification failed");
    }
    const digest = cwSendRequestDigest(params);

    // 业务键优先：同键同摘要重放零副作用，不同摘要冲突（不受代次/期限变化影响）。
    const existing = this.operations.get(params.operationId);
    if (existing !== undefined) {
      if (existing.intent.requestDigest !== digest) {
        throw new RigControlError("conflict", "operationId already exists with different content");
      }
      return this.viewFor(existing);
    }

    if (this.blockedReason !== null) {
      throw new RigControlError("blocked", `new cw.send is blocked: ${this.blockedReason}`);
    }
    if (this.closed) {
      throw new RigControlError("blocked", "device session is closed");
    }
    if (params.connectionGeneration !== this.connectionGeneration) {
      throw new RigControlError("conflict", "connectionGeneration mismatch");
    }
    if (params.permissionGeneration !== this.permissionGeneration) {
      throw new RigControlError("conflict", "permissionGeneration mismatch");
    }
    // 核心代次回退拒绝：不接受比已刷盘接受过的更旧的核心 generation。
    // 更高或相等的核心代次可以继续；同键重放已在上方按摘要优先返回。
    if (params.stateGeneration < this.stateGeneration) {
      throw new RigControlError("conflict", "stateGeneration regression: an older core generation was already superseded");
    }
    if (params.frequencyHz !== this.frequencyHz) throw new RigControlError("conflict", "frequencyHz mismatch");
    const now = this.now();
    if (params.expiresAt <= now) {
      throw new RigControlError("expired", "authorization has expired");
    }
    if (params.expiresAt - now > RIG_CONTROL_MAX_EXPIRES_MS) {
      throw new RigControlError("invalid_params", "expiresAt exceeds the 60s service limit");
    }
    if (params.contentSha256 !== contentHash(params.text, params.frequencyHz, "CW")) {
      throw new RigControlError("invalid_params", "contentSha256 does not match text/frequency/mode");
    }
    let plan: CivCwPlan;
    try {
      plan = planCivCwMessage(params.text, { radioAddress: this.civAddress });
    } catch (error) {
      throw new RigControlError("invalid_params", error instanceof Error ? error.message : "invalid CW message");
    }
    if (this.inFlight !== null) {
      throw new RigControlError("busy", "another cw.send is already in flight");
    }
    if (this.usedNonces.has(params.nonce)) {
      throw new RigControlError("conflict", "nonce has already been consumed");
    }

    const intent: LedgerIntent = {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      type: "intent",
      at: now,
      operationId: params.operationId,
      deviceInstanceId: this.deviceInstanceId,
      text: params.text,
      civAddress: this.civAddress,
      contentSha256: params.contentSha256,
      frequencyHz: params.frequencyHz,
      mode: "CW",
      connectionGeneration: params.connectionGeneration,
      permissionGeneration: params.permissionGeneration,
      stateGeneration: params.stateGeneration,
      expiresAt: params.expiresAt,
      requestDigest: digest,
    };
    if (!this.append(intent)) {
      throw new RigControlError("blocked", "ledger write failed; cw.send was not executed");
    }
    // 只有 intent 成功刷盘后才提升已接受的核心代次。
    this.stateGeneration = params.stateGeneration;
    this.usedNonces.add(params.nonce);
    const entry: OperationEntry = { intent, terminal: null };
    this.operations.set(params.operationId, entry);
    this.backendCallCount += 1;
    return await this.executeSend(entry, plan);
  }

  private executeSend(entry: OperationEntry, plan: CivCwPlan): Promise<OperationResult> {
    return new Promise<OperationResult>((resolve) => {
      const inFlight: InFlight = { operationId: entry.intent.operationId, plan, timer: null, resolve };
      this.inFlight = inFlight;
      if (!this.testHangSend) {
        inFlight.timer = setTimeout(() => this.completeBackend(entry.intent.operationId), this.testDelayMs);
      }
    });
  }

  private completeBackend(operationId: string): void {
    const entry = this.operations.get(operationId);
    if (entry === undefined) return;
    if (entry.terminal !== null) {
      // 迟到完成不得覆盖 stop/close 已确定的终态。
      this.clearInFlight(operationId);
      return;
    }
    const frame = this.frameOfText(entry.intent.text, entry.intent.civAddress);
    let terminal: LedgerTerminal = {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      type: "terminal",
      at: this.now(),
      operationId,
      outcome: "completed",
      evidence: "backend_completed",
      reason: null,
      frameHex: frame === null ? null : civPlanHex(frame),
      frameBytes: frame === null ? null : frame.bytes.length,
    };
    if (!this.append(terminal)) {
      terminal = {
        schemaVersion: LEDGER_SCHEMA_VERSION,
        type: "terminal",
        at: this.now(),
        operationId,
        outcome: "unknown",
        evidence: "ledger_write_failed",
        reason: "backend completed but the terminal record could not be persisted",
        frameHex: frame === null ? null : civPlanHex(frame),
        frameBytes: frame === null ? null : frame.bytes.length,
      };
      this.blockedReason = "ledger_fault";
    }
    entry.terminal = terminal;
    this.settleInFlight(operationId, this.viewFor(entry));
  }

  private stop(params: CwStopParams): StopResult {
    const prior = this.stops.get(params.stopId);
    if (prior !== undefined) {
      if (prior.operationId !== params.operationId) {
        throw new RigControlError("conflict", "stopId already used for a different operation");
      }
      return this.stopResult(prior);
    }
    if (this.stops.size >= MAX_LEDGER_RECORDS) throw new RigControlError("blocked", "stop record limit exceeded");
    const entry = this.operations.get(params.operationId);
    if (entry === undefined) {
      throw new RigControlError("not_found", "unknown operationId");
    }
    if (entry.terminal !== null) {
      // 已终结的操作不再变更；如实回报既有 outcome，不制造新的 unknown 锁。
      const outcome: "cancelled" | "unknown" = entry.terminal.outcome === "cancelled" ? "cancelled" : "unknown";
      let record: LedgerStop = {
        schemaVersion: LEDGER_SCHEMA_VERSION,
        type: "stop",
        at: this.now(),
        stopId: params.stopId,
        operationId: params.operationId,
        outcome,
        evidence: `already_${entry.terminal.outcome}`,
      };
      if (!this.append(record)) record = { ...record, outcome: "unknown", evidence: "ledger_write_failed" };
      this.stops.set(params.stopId, record);
      return this.stopResult(record);
    }

    const frame = this.frameOfText(entry.intent.text, entry.intent.civAddress);
    let terminal: LedgerTerminal;
    if (this.testStopEvidence === "stopped") {
      terminal = {
        schemaVersion: LEDGER_SCHEMA_VERSION,
        type: "terminal",
        at: this.now(),
        operationId: params.operationId,
        outcome: "cancelled",
        evidence: "backend_stopped",
        reason: null,
        frameHex: frame === null ? null : civPlanHex(frame),
        frameBytes: frame === null ? null : frame.bytes.length,
      };
    } else {
      terminal = {
        schemaVersion: LEDGER_SCHEMA_VERSION,
        type: "terminal",
        at: this.now(),
        operationId: params.operationId,
        outcome: "unknown",
        evidence: "stop_insufficient",
        reason: "no reliable stop evidence was produced",
        frameHex: frame === null ? null : civPlanHex(frame),
        frameBytes: frame === null ? null : frame.bytes.length,
      };
    }
    if (!this.append(terminal)) {
      terminal = { ...terminal, outcome: "unknown", evidence: "ledger_write_failed" };
    }
    entry.terminal = terminal;
    if (terminal.outcome === "unknown" && !this.ledgerFault) this.blockedReason = "unknown";

    let stopRecord: LedgerStop = {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      type: "stop",
      at: this.now(),
      stopId: params.stopId,
      operationId: params.operationId,
      outcome: terminal.outcome === "cancelled" ? "cancelled" : "unknown",
      evidence: terminal.evidence,
    };
    if (!this.append(stopRecord)) stopRecord = { ...stopRecord, outcome: "unknown", evidence: "ledger_write_failed" };
    this.stops.set(params.stopId, stopRecord);

    this.permissionGeneration += 1;
    this.settleInFlight(params.operationId, this.viewFor(entry));
    return this.stopResult(stopRecord);
  }

  private operationGet(params: { readonly operationId: string }): OperationResult {
    const entry = this.operations.get(params.operationId);
    if (entry === undefined) throw new RigControlError("not_found", "unknown operationId");
    return this.viewFor(entry);
  }

  private async closeDevice(): Promise<DeviceCloseResult> {
    if (!this.closed) {
      this.closed = true;
      this.permissionGeneration += 1;
      if (this.inFlight !== null) {
        const entry = this.operations.get(this.inFlight.operationId);
        if (entry !== undefined) {
          const frame = this.frameOfText(entry.intent.text, entry.intent.civAddress);
          const terminal: LedgerTerminal = {
            schemaVersion: LEDGER_SCHEMA_VERSION,
            type: "terminal",
            at: this.now(),
            operationId: entry.intent.operationId,
            outcome: "unknown",
            evidence: "close_insufficient",
            reason: "device session closed while the operation was in flight",
            frameHex: frame === null ? null : civPlanHex(frame),
            frameBytes: frame === null ? null : frame.bytes.length,
          };
          this.append(terminal);
          entry.terminal = terminal;
          if (!this.ledgerFault) this.blockedReason = "unknown";
          this.settleInFlight(entry.intent.operationId, this.viewFor(entry));
        }
      }
    }
    return {
      closed: true,
      connectionGeneration: this.connectionGeneration,
      permissionGeneration: this.permissionGeneration,
      stateGeneration: this.stateGeneration,
      blockedReason: this.blockedReason,
    };
  }

  /** 宿主失联：撤销会话与未使用 token，在途操作证据不足锁为 unknown。 */
  onChannelLost(): void {
    if (this.helloDone) this.permissionGeneration += 1;
    this.closed = true;
    this.helloDone = false;
    this.sessionKey = null;
    if (this.inFlight !== null) {
      const entry = this.operations.get(this.inFlight.operationId);
      if (entry !== undefined && entry.terminal === null) {
        const frame = this.frameOfText(entry.intent.text, entry.intent.civAddress);
        const terminal: LedgerTerminal = {
          schemaVersion: LEDGER_SCHEMA_VERSION,
          type: "terminal",
          at: this.now(),
          operationId: entry.intent.operationId,
          outcome: "unknown",
          evidence: "channel_lost",
          reason: "host control channel was lost while the operation was in flight",
          frameHex: frame === null ? null : civPlanHex(frame),
          frameBytes: frame === null ? null : frame.bytes.length,
        };
        this.append(terminal);
        entry.terminal = terminal;
        if (!this.ledgerFault) this.blockedReason = "unknown";
        this.settleInFlight(entry.intent.operationId, this.viewFor(entry));
      } else if (entry !== undefined) {
        this.settleInFlight(entry.intent.operationId, this.viewFor(entry));
      }
    }
  }

  /** 释放进程资源：清 timer、刷盘、移除锁。幂等。 */
  close(): void {
    if (this.inFlight !== null) this.clearInFlight(this.inFlight.operationId);
    this.ledger.close();
  }

  private clearInFlight(operationId: string): void {
    const inFlight = this.inFlight;
    if (inFlight === null || inFlight.operationId !== operationId) return;
    if (inFlight.timer !== null) clearTimeout(inFlight.timer);
    inFlight.timer = null;
    this.inFlight = null;
  }

  private settleInFlight(operationId: string, result: OperationResult): void {
    const inFlight = this.inFlight;
    if (inFlight === null || inFlight.operationId !== operationId) return;
    if (inFlight.timer !== null) clearTimeout(inFlight.timer);
    inFlight.timer = null;
    this.inFlight = null;
    inFlight.resolve(result);
  }

  private viewFor(entry: OperationEntry): OperationResult {
    const intent = entry.intent;
    const terminal = entry.terminal;
    const frame = this.frameOfText(intent.text, intent.civAddress);
    const frameHex = terminal?.frameHex ?? (frame === null ? null : civPlanHex(frame));
    const frameBytes = terminal?.frameBytes ?? (frame === null ? null : frame.bytes.length);
    const state: OperationState = terminal === null ? "running" : terminal.outcome;
    return {
      operationId: intent.operationId,
      deviceInstanceId: this.deviceInstanceId,
      serviceInstanceId: this.serviceInstanceId,
      state,
      outcome: terminal === null ? null : terminal.outcome,
      evidence: terminal === null ? "intent_recorded" : terminal.evidence,
      text: intent.text,
      contentSha256: intent.contentSha256,
      frequencyHz: intent.frequencyHz,
      mode: intent.mode,
      connectionGeneration: intent.connectionGeneration,
      permissionGeneration: intent.permissionGeneration,
      stateGeneration: intent.stateGeneration,
      frameHex,
      frameBytes,
      at: terminal === null ? intent.at : terminal.at,
    };
  }

  private stopResult(record: LedgerStop): StopResult {
    return {
      stopId: record.stopId,
      operationId: record.operationId,
      outcome: record.outcome,
      evidence: record.evidence,
      at: record.at,
      permissionGeneration: this.permissionGeneration,
    };
  }
}
