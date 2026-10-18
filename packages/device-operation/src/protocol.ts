import { createHash } from "node:crypto";

export const METHODS = ["device.describe", "device.status", "context.refresh", "proposal.create",
  "proposal.approve", "proposal.revoke", "cw.execute", "cw.stop", "operation.get",
  "device.reconnect", "device.close"] as const;
export type Method = typeof METHODS[number];
export const READ_KINDS = ["displayFrequency", "displayMode", "txFrequency", "txStatus",
  "splitEnabled", "ritEnabled", "xitEnabled", "breakIn"] as const;
export const FIELD_KEYS = ["displayFrequencyHz", "displayMode", "displayFilter", "txFrequencyHz",
  "txStatus", "splitEnabled", "ritEnabled", "xitEnabled", "breakIn"] as const;
export type Values = [number, "CW" | "CW-R" | "USB", number, number, "RX" | "TX", boolean, boolean, boolean, "OFF" | "SEMI" | "FULL"];
export const ERROR_CODES = ["invalidRequest", "invalidParams", "unsupportedVersion", "unknownMethod",
  "unauthorized", "notFound", "busy", "expired", "staleContext", "conflict", "blocked",
  "unavailable", "timeout", "maintenanceRequired", "closeUnconfirmed", "storageFault", "internal"] as const;
export type ErrorCode = typeof ERROR_CODES[number];
export class OperationError extends Error {
  constructor(readonly code: ErrorCode, message: string = code) { super(message); }
}
export interface Request {
  deviceOperationVersion: 1; id: string; sequence: number; method: Method; params: Record<string, unknown>;
}
export interface InternalRequest extends Request {
  deadlineNs: string; remainingMs: number; actor: "operator" | "host"; channelId: string;
}
export interface Response {
  deviceOperationVersion: 1; id: string; sequence: number; ok: boolean;
  result: unknown; error: { code: ErrorCode; message: string } | null;
}
export function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) {
    throw new OperationError("invalidRequest", "unexpected object keys");
  }
}
export function bounded(value: unknown): void {
  const visit = (v: unknown, depth: number): void => {
    if (depth > 8) throw new OperationError("invalidRequest", "message nesting limit");
    if (typeof v === "number" && !Number.isFinite(v)) throw new OperationError("invalidRequest");
    if (v === undefined || typeof v === "bigint" || typeof v === "function" || typeof v === "symbol")
      throw new OperationError("invalidRequest");
    if (v && typeof v === "object") {
      if (!Array.isArray(v) && ![Object.prototype, null].includes(Object.getPrototypeOf(v)))
        throw new OperationError("invalidRequest");
      for (const item of Object.values(v)) visit(item, depth + 1);
    }
  };
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value)) > 16 * 1024) throw new OperationError("invalidRequest", "message size limit");
}
export function uuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
export function counter(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
export function parseRequest(raw: unknown, internal: false): Request;
export function parseRequest(raw: unknown, internal: true): InternalRequest;
export function parseRequest(raw: unknown, internal: boolean): Request | InternalRequest {
  bounded(raw);
  exact(raw, ["deviceOperationVersion", "id", "sequence", "method", "params",
    ...(internal ? ["deadlineNs", "remainingMs", "actor", "channelId"] : [])]);
  if (raw.deviceOperationVersion !== 1) throw new OperationError("unsupportedVersion");
  if (typeof raw.id !== "string" || !/^[\x21-\x7e]{1,64}$/.test(raw.id) || !counter(raw.sequence) || raw.sequence < 1)
    throw new OperationError("invalidRequest");
  if (!METHODS.includes(raw.method as Method)) throw new OperationError("unknownMethod");
  const method = raw.method as Method;
  const keys: Partial<Record<Method, string[]>> = {
    "proposal.create": ["text"], "proposal.approve": ["proposalId", "contextId"], "proposal.revoke": ["proposalId"],
    "cw.execute": ["proposalId", "approvalId", "operationId"], "cw.stop": ["operationId", "stopId"],
    "operation.get": ["operationId"], "device.reconnect": ["serviceInstanceId", "connectionGeneration"],
  };
  try {
    exact(raw.params, keys[method] ?? []);
    for (const [key, value] of Object.entries(raw.params)) {
      if (key === "text") { if (value !== "E" && value !== "TEST") throw new Error(); }
      else if (key === "connectionGeneration") { if (!counter(value)) throw new Error(); }
      else if (!uuid(value)) throw new Error();
    }
  } catch { throw new OperationError("invalidParams"); }
  if (internal) {
    if ((raw.actor !== "operator" && raw.actor !== "host") || !uuid(raw.channelId) ||
      typeof raw.deadlineNs !== "string" || !/^\d{1,30}$/.test(raw.deadlineNs) ||
      !Number.isInteger(raw.remainingMs) || (raw.remainingMs as number) < 1 || (raw.remainingMs as number) > 30000)
      throw new OperationError("invalidRequest");
    if (raw.actor === "host" ? !["device.describe", "device.status", "operation.get", "cw.stop", "device.close"].includes(method)
      : method === "device.close") throw new OperationError("unauthorized");
  }
  return raw as unknown as InternalRequest;
}
export function limit(method: Method): number {
  if (["context.refresh", "proposal.approve", "cw.execute"].includes(method)) return 30000;
  if (["cw.stop", "device.close"].includes(method)) return 5000;
  if (method === "device.reconnect") return 10000;
  return 2000;
}
export function deadline(req: InternalRequest, now = process.hrtime.bigint()): bigint {
  const ms = Math.min(req.remainingMs, limit(req.method), Number((BigInt(req.deadlineNs) - now) / 1000000n));
  if (ms < 1) throw new OperationError("timeout");
  return now + BigInt(ms) * 1000000n;
}
export function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function textHash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
export const CAPABILITIES = Object.freeze({ schemaVersion: 1, mode: "cw-trial", backend: "simulation",
  identityVerification: "unverified", readKinds: READ_KINDS, allowedMessages: ["E", "TEST"],
  sendAllowed: true, stopRequestAllowed: true, completionEvidence: "simulation", stopEvidence: "simulation", ptt: false });
export const CAPABILITIES_DIGEST = digest([1, "cw-trial", "simulation", "unverified", READ_KINDS,
  ["E", "TEST"], true, true, "simulation", "simulation", false]);
export type State = "prepared" | "notDispatched" | "dispatching" | "unknown" | "completed" | "cancelled";
export interface Observation { requestDispatched: boolean; ackObservation: "none" | "ack_observed" | "unattributed";
  evidence: "simulationCompleted" | "simulationStopped" | "unavailable"; }
export interface StopResult { stopId: string; operationId: string; alreadyAttempted: boolean;
  observation: Observation; operationState: State; }
export interface Operation { operationId: string; proposalId: string; approvalId: string; bindingDigest: string;
  source: "simulation"; state: State; unresolved: boolean; send: Observation; stop: StopResult | null; errorCode: ErrorCode | null; }
export function observation(dispatched = false, evidence: Observation["evidence"] = "unavailable"): Observation {
  return { requestDispatched: dispatched, ackObservation: "none", evidence };
}
export function response(req: Request, result: unknown, error: unknown = null): Response {
  const failure = error === null ? null : error instanceof OperationError ? error : new OperationError("internal");
  const value: Response = { deviceOperationVersion: 1, id: req.id, sequence: req.sequence, ok: failure === null,
    result: failure ? null : result, error: failure ? { code: failure.code, message: failure.message.slice(0, 512) } : null };
  bounded(value);
  if (!failure) { validateResult(req.method, result); validateResultCorrelation(req, result); }
  return value;
}
export function parseResponse(raw: unknown, req: Request): Response {
  bounded(raw); exact(raw, ["deviceOperationVersion", "id", "sequence", "ok", "result", "error"]);
  if (raw.deviceOperationVersion !== 1 || raw.id !== req.id || raw.sequence !== req.sequence || typeof raw.ok !== "boolean")
    throw new OperationError("invalidRequest", "response correlation");
  if (raw.ok) {
    if (raw.error !== null || raw.result === null) throw new OperationError("invalidRequest");
    validateResult(req.method, raw.result);
    validateResultCorrelation(req, raw.result);
  } else {
    exact(raw.error, ["code", "message"]);
    if (raw.result !== null || !ERROR_CODES.includes(raw.error.code as ErrorCode) || typeof raw.error.message !== "string" || raw.error.message.length > 512)
      throw new OperationError("invalidRequest");
  }
  return raw as unknown as Response;
}

function requireValue(ok: boolean): asserts ok { if (!ok) throw new OperationError("invalidRequest", "invalid result schema"); }
function hash(value: unknown): boolean { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function validateContext(value: unknown): void {
  exact(value, ["contextId", "serviceInstanceId", "connectionGeneration", "capabilitiesDigest", "fields", "nonAtomic"]);
  requireValue(uuid(value.contextId) && uuid(value.serviceInstanceId) && counter(value.connectionGeneration) &&
    value.capabilitiesDigest === CAPABILITIES_DIGEST && value.nonAtomic === true);
  exact(value.fields, FIELD_KEYS);
  const fields = value.fields;
  for (const [index, key] of FIELD_KEYS.entries()) {
    const field = fields[key]; exact(field, ["value", "sampledAt", "quality", "ttlMs"]);
    requireValue(field.ttlMs === (index < 3 ? 3000 : 6000) && counter(field.sampledAt) && ["fresh", "stale"].includes(field.quality as string));
    const v = field.value;
    if (index === 0 || index === 3) requireValue(counter(v) && (v as number) > 0);
    else if (index === 1) requireValue(["CW", "CW-R", "USB"].includes(v as string));
    else if (index === 2) requireValue([1, 2, 3].includes(v as number));
    else if (index === 4) requireValue(["RX", "TX"].includes(v as string));
    else if (index < 8) requireValue(typeof v === "boolean");
    else requireValue(["OFF", "SEMI", "FULL"].includes(v as string));
  }
}
function validateProposal(value: unknown): void {
  exact(value, ["proposalId", "text", "textSha256", "state"]);
  requireValue(uuid(value.proposalId) && ["E", "TEST"].includes(value.text as string) &&
    value.textSha256 === textHash(value.text as string) && ["proposed", "approved", "revoked", "consumed"].includes(value.state as string));
}
function validateObservation(value: unknown): void {
  exact(value, ["requestDispatched", "ackObservation", "evidence"]);
  requireValue(typeof value.requestDispatched === "boolean" && ["none", "ack_observed", "unattributed"].includes(value.ackObservation as string) &&
    ["unavailable", "simulationCompleted", "simulationStopped"].includes(value.evidence as string) &&
    (value.evidence === "unavailable" || value.requestDispatched === true));
}
function validateStop(value: unknown): void {
  exact(value, ["stopId", "operationId", "alreadyAttempted", "observation", "operationState"]);
  requireValue(uuid(value.stopId) && uuid(value.operationId) && typeof value.alreadyAttempted === "boolean" &&
    ["prepared", "notDispatched", "dispatching", "unknown", "completed", "cancelled"].includes(value.operationState as string));
  validateObservation(value.observation);
}
export function validateResult(method: Method, value: unknown): void {
  switch (method) {
    case "device.describe":
      exact(value, ["serviceInstanceId", "connectionGeneration", "configuredId", "hardwareFingerprint", "capabilities", "capabilitiesDigest", "blockedReason"]);
      requireValue(uuid(value.serviceInstanceId) && counter(value.connectionGeneration) && value.configuredId === null && value.hardwareFingerprint === null &&
        value.capabilitiesDigest === CAPABILITIES_DIGEST);
      exact(value.capabilities, Object.keys(CAPABILITIES));
      for (const key of Object.keys(CAPABILITIES)) requireValue(digest(value.capabilities[key]) === digest(CAPABILITIES[key as keyof typeof CAPABILITIES]));
      requireValue([null, "unresolvedOperation", "storageFault"].includes(value.blockedReason as null)); break;
    case "device.status":
      exact(value, ["serviceInstanceId", "connectionGeneration", "phase", "context", "blockedReason"]);
      requireValue(uuid(value.serviceInstanceId) && counter(value.connectionGeneration) && ["ready", "closing", "closed"].includes(value.phase as string) &&
        [null, "unresolvedOperation", "storageFault"].includes(value.blockedReason as null));
      if (value.context !== null) validateContext(value.context); break;
    case "context.refresh":
      exact(value, ["context", "preflight"]); validateContext(value.context);
      exact(value.preflight, ["eligible", "failedChecks"]);
      requireValue(Array.isArray(value.preflight.failedChecks) && value.preflight.failedChecks.length <= 12 &&
        new Set(value.preflight.failedChecks).size === value.preflight.failedChecks.length &&
        value.preflight.failedChecks.every(c => ["mode", "rx", "tx-frequency", "split", "rit", "xit", "break-in", "blocked"].includes(c)) &&
        value.preflight.eligible === (value.preflight.failedChecks.length === 0)); break;
    case "proposal.create": exact(value, ["proposal"]); validateProposal(value.proposal); break;
    case "proposal.approve":
      exact(value, ["proposal", "approval", "context"]); validateProposal(value.proposal); validateContext(value.context);
      exact(value.approval, ["approvalId", "proposalId", "bindingDigest", "expiresAt", "ttlMs"]);
      requireValue(uuid(value.approval.approvalId) && uuid(value.approval.proposalId) && hash(value.approval.bindingDigest) &&
        counter(value.approval.expiresAt) && value.approval.ttlMs === 30000); break;
    case "proposal.revoke": exact(value, ["proposal", "revoked"]); validateProposal(value.proposal); requireValue(typeof value.revoked === "boolean"); break;
    case "cw.execute": case "operation.get": {
      exact(value, ["operation"]);
      const op = value.operation;
      exact(op, ["operationId", "proposalId", "approvalId", "bindingDigest", "source", "state", "unresolved", "send", "stop", "errorCode"]);
      requireValue(uuid(op.operationId) && uuid(op.proposalId) && uuid(op.approvalId) && hash(op.bindingDigest) && op.source === "simulation" &&
        ["prepared", "notDispatched", "dispatching", "unknown", "completed", "cancelled"].includes(op.state as string) &&
        op.unresolved === ["dispatching", "unknown"].includes(op.state as string) &&
        (op.errorCode === null || ERROR_CODES.includes(op.errorCode as ErrorCode)));
      validateObservation(op.send); if (op.stop !== null) validateStop(op.stop);
      const send = op.send as unknown as Observation, stop = op.stop as unknown as StopResult | null;
      requireValue((op.state !== "completed" || send.evidence === "simulationCompleted") &&
        (op.state !== "cancelled" || stop?.observation.evidence === "simulationStopped") &&
        (op.state !== "notDispatched" || !send.requestDispatched) && (!stop || stop.operationId === op.operationId));
      break;
    }
    case "cw.stop": validateStop(value); break;
    case "device.close":
      exact(value, ["portReleased", "recordsFlushed", "rfStopEvidence"]);
      requireValue(typeof value.portReleased === "boolean" && typeof value.recordsFlushed === "boolean" &&
        ["unavailable", "simulationStopped"].includes(value.rfStopEvidence as string)); break;
    case "device.reconnect": throw new OperationError("invalidRequest", "Fake reconnect has no success result in this slice");
  }
}

function validateResultCorrelation(req: Request, value: unknown): void {
  const v = value as Record<string, unknown>;
  if (req.method === "cw.execute" || req.method === "operation.get") {
    const op = v.operation as Operation;
    requireValue(op.operationId === req.params.operationId);
    if (req.method === "cw.execute") requireValue(op.proposalId === req.params.proposalId && op.approvalId === req.params.approvalId);
  }
  if (req.method === "proposal.create") requireValue((v.proposal as Record<string, unknown>).text === req.params.text);
  if (req.method === "proposal.approve" || req.method === "proposal.revoke") {
    const proposal = v.proposal as Record<string, unknown>;
    requireValue(proposal.proposalId === req.params.proposalId);
    if (req.method === "proposal.approve") requireValue(proposal.state === "approved" &&
      (v.approval as Record<string, unknown>).proposalId === proposal.proposalId);
  }
  if (req.method === "cw.stop") requireValue(v.operationId === req.params.operationId && (v.alreadyAttempted === true || v.stopId === req.params.stopId));
  if (req.method === "device.status" && v.context !== null) {
    const context = v.context as Record<string, unknown>;
    requireValue(context.serviceInstanceId === v.serviceInstanceId && context.connectionGeneration === v.connectionGeneration);
  }
}
