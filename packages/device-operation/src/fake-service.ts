import { randomUUID } from "node:crypto";
import type { Journal } from "./fixture-journal.js";
import { CAPABILITIES, CAPABILITIES_DIGEST, FIELD_KEYS, OperationError, deadline, digest,
  observation, parseRequest, response, textHash, type InternalRequest, type Operation,
  type Response, type StopResult, type Values } from "./protocol.js";

export interface FakeAdapter {
  read(signal: AbortSignal): Promise<Values>;
  send(text: "E" | "TEST"): Promise<"simulationCompleted" | "unavailable">;
  stop(): Promise<"simulationStopped" | "unavailable">;
  close(): Promise<void>;
}
export function createFakeAdapter(durationMs = 250): FakeAdapter & { sends: number; stops: number } {
  let finish: ((result: "simulationCompleted" | "unavailable") => void) | undefined;
  let timer: NodeJS.Timeout | undefined;
  const adapter = {
    sends: 0, stops: 0,
    async read(signal: AbortSignal): Promise<Values> {
      signal.throwIfAborted();
      return [14250000, "CW", 2, 14250000, "RX", false, false, false, "SEMI"];
    },
    send(_text: "E" | "TEST"): Promise<"simulationCompleted" | "unavailable"> {
      adapter.sends++;
      return new Promise(resolve => {
        finish = resolve;
        timer = setTimeout(() => { finish = undefined; resolve("simulationCompleted"); }, durationMs);
      });
    },
    async stop(): Promise<"simulationStopped"> {
      adapter.stops++; clearTimeout(timer); finish?.("unavailable"); finish = undefined;
      return "simulationStopped";
    },
    async close(): Promise<void> { clearTimeout(timer); finish?.("unavailable"); finish = undefined; },
  };
  return adapter;
}

interface Context {
  contextId: string; serviceInstanceId: string; connectionGeneration: number;
  capabilitiesDigest: string; fields: Record<string, { value: unknown; sampledAt: number; quality: "fresh" | "stale"; ttlMs: number }>;
  nonAtomic: true;
}
interface Snapshot { context: Context; values: Values; observed: bigint; }
interface Proposal { proposalId: string; text: "E" | "TEST"; textSha256: string; state: "proposed" | "approved" | "revoked" | "consumed"; }
interface Approval {
  approvalId: string; proposalId: string; bindingDigest: string; expiresAt: number; ttlMs: 30000;
}
interface Permit { public: Approval; channel: string; expires: bigint; values: Values; timer: NodeJS.Timeout; }
interface Attempt { valid: boolean; operation: Operation; permit: Permit; proposal: Proposal; deadline: bigint; intent: boolean; }

export async function within<T>(promise: Promise<T>, end: bigint, signal?: AbortSignal): Promise<T> {
  const ms = Number((end - process.hrtime.bigint()) / 1000000n);
  if (ms < 1) throw new OperationError("timeout");
  let timer: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new OperationError("timeout")), ms);
      abort = () => reject(new OperationError("unavailable", "simulation read cancelled"));
      if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
    })]);
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}

export class FakeOperationService {
  readonly serviceInstanceId = randomUUID();
  private generation = 0;
  private phase: "ready" | "closing" | "closed" = "ready";
  private snapshot: Snapshot | undefined;
  private proposals = new Map<string, Proposal>();
  private permits = new Map<string, Permit>();
  private sequences = new Map<string, number>();
  private active: Attempt | undefined;
  private activeDone: Promise<void> = Promise.resolve();
  private readAbort = new AbortController();
  private readTail: Promise<void> = Promise.resolve();
  private readCount = 0;
  private ordinary = 0;
  private controls = new Set<string>();
  private stopPromises = new Map<string, Promise<StopResult>>();
  private origins = new Map<string, number>();
  private storageFault = false;
  private invalidationVersion = 0;
  private closeResult: Promise<{ portReleased: boolean; recordsFlushed: boolean; rfStopEvidence: "simulationStopped" | "unavailable" }> | undefined;

  constructor(private journal: Journal, private adapter: FakeAdapter = createFakeAdapter(),
    private now: () => bigint = process.hrtime.bigint) {}

  private blockedReason(): "storageFault" | "unresolvedOperation" | null {
    if (this.storageFault) return "storageFault";
    return [...this.journal.operations.values()].some(op => op.unresolved) ? "unresolvedOperation" : null;
  }
  private invalidate(proposalId?: string): void {
    this.invalidationVersion++;
    for (const [id, permit] of this.permits) {
      if (proposalId && permit.public.proposalId !== proposalId) continue;
      clearTimeout(permit.timer); this.permits.delete(id);
      const proposal = this.proposals.get(permit.public.proposalId);
      if (proposal?.state === "approved") proposal.state = "revoked";
    }
    if (this.active && (!proposalId || this.active.proposal.proposalId === proposalId)) this.active.valid = false;
  }
  channelLost(channel: string): void {
    this.invalidationVersion++;
    for (const permit of this.permits.values()) if (permit.channel === channel) this.invalidate(permit.public.proposalId);
    // Bound channel bookkeeping to the current inherited session; no reconnect or role upgrade.
  }
  private statusContext(): Context | null {
    if (!this.snapshot) return null;
    const result = structuredClone(this.snapshot.context);
    for (const field of Object.values(result.fields)) {
      if (this.now() - this.snapshot.observed >= BigInt(field.ttlMs) * 1000000n) field.quality = "stale";
    }
    return result;
  }
  private async refresh(end: bigint): Promise<Snapshot> {
    if (this.readCount >= 2) throw new OperationError("busy");
    const signal = this.readAbort.signal;
    this.readCount++;
    const preceding = this.readTail;
    let release!: () => void;
    const finished = new Promise<void>(resolve => { release = resolve; });
    // A cancelled waiter still depends on every earlier physical read settling.
    this.readTail = preceding.then(() => finished);
    void this.readTail.then(() => { this.readCount--; });
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    let pending: Promise<Values> | undefined;
    let started = false;
    try {
      await within(preceding, end, signal);
      signal.throwIfAborted();
      if (this.now() >= end) throw new OperationError("timeout");
      started = true;
      pending = this.adapter.read(controller.signal);
      const values = await within(pending, end, signal);
      signal.throwIfAborted();
      if (this.now() >= end) throw new OperationError("timeout");
      if (values.length !== 9 || !Number.isSafeInteger(values[0]) || values[0] < 1 ||
        !["CW", "CW-R", "USB"].includes(values[1]) || ![1, 2, 3].includes(values[2]) ||
        !Number.isSafeInteger(values[3]) || values[3] < 1 || !["RX", "TX"].includes(values[4]) ||
        values.slice(5, 8).some(value => typeof value !== "boolean") || !["OFF", "SEMI", "FULL"].includes(values[8]))
        throw new OperationError("staleContext", "incomplete simulation context");
      if (this.snapshot && digest(this.snapshot.values) !== digest(values)) this.invalidate();
      const fields: Context["fields"] = {};
      for (const [index, key] of FIELD_KEYS.entries()) fields[key] = {
        value: values[index], sampledAt: Date.now(), quality: "fresh", ttlMs: index < 3 ? 3000 : 6000,
      };
      const snapshot: Snapshot = { values: structuredClone(values), observed: this.now(), context: {
        contextId: randomUUID(), serviceInstanceId: this.serviceInstanceId, connectionGeneration: this.generation,
        capabilitiesDigest: CAPABILITIES_DIGEST, fields, nonAtomic: true,
      } };
      this.snapshot = snapshot;
      return snapshot;
    } catch (error) {
      if (started) { this.invalidate(); this.snapshot = undefined; controller.abort(); }
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
      // An adapter may ignore cancellation; retain ownership until it really settles.
      if (pending) void pending.then(release, release); else release();
    }
  }
  private checks(values: Values): string[] {
    const failed: string[] = [];
    if (values[1] !== "CW" && values[1] !== "CW-R") failed.push("mode");
    if (values[4] !== "RX") failed.push("rx");
    if (values[0] !== values[3]) failed.push("tx-frequency");
    if (values[5]) failed.push("split");
    if (values[6]) failed.push("rit");
    if (values[7]) failed.push("xit");
    if (values[8] === "OFF") failed.push("break-in");
    if (this.blockedReason()) failed.push("blocked");
    return failed;
  }
  private binding(proposal: Proposal, values: Values): string {
    return digest(["device-operation-v1", this.serviceInstanceId, this.generation, null, "unverified",
      CAPABILITIES_DIGEST, proposal.proposalId, proposal.textSha256, ...values]);
  }
  private check(attempt: Attempt): void {
    if (this.now() >= attempt.deadline) throw new OperationError("timeout");
    if (this.now() >= attempt.permit.expires) { this.invalidate(attempt.proposal.proposalId); throw new OperationError("expired"); }
    if (!attempt.valid || this.phase !== "ready" || attempt.proposal.state !== "approved" ||
      this.permits.get(attempt.permit.public.approvalId) !== attempt.permit) throw new OperationError("expired");
    if (!this.snapshot || this.now() - this.snapshot.observed >= 3000000000n ||
      this.binding(attempt.proposal, this.snapshot.values) !== attempt.permit.public.bindingDigest)
      throw new OperationError("staleContext");
    if (this.storageFault) throw new OperationError("storageFault");
  }
  private async persist(operation: Operation, end: bigint): Promise<void> {
    if (this.storageFault) throw new OperationError("storageFault");
    try { await within(this.journal.append(operation), end); }
    catch { this.storageFault = true; this.invalidate(); throw new OperationError("storageFault"); }
  }
  private async execute(req: InternalRequest, end: bigint): Promise<{ operation: Operation }> {
    const { operationId, proposalId, approvalId } = req.params as Record<string, string>;
    const old = this.journal.operations.get(operationId!);
    if (old) {
      if (old.proposalId !== proposalId || old.approvalId !== approvalId) throw new OperationError("conflict");
      return { operation: structuredClone(old) };
    }
    if (this.active) throw new OperationError("busy");
    if (this.controls.size) throw new OperationError("busy");
    if (this.blockedReason() || !this.journal.hasCapacity()) throw new OperationError("blocked");
    const proposal = this.proposals.get(proposalId!);
    const permit = this.permits.get(approvalId!);
    if (!proposal || !permit || permit.channel !== req.channelId || permit.public.proposalId !== proposalId)
      throw new OperationError("expired");
    const operation: Operation = { operationId: operationId!, proposalId: proposalId!, approvalId: approvalId!,
      bindingDigest: permit.public.bindingDigest, source: "simulation", state: "prepared", unresolved: false,
      send: observation(), stop: null, errorCode: null };
    const attempt: Attempt = { valid: true, operation, permit, proposal, deadline: end, intent: false };
    this.active = attempt;
    this.journal.operations.set(operation.operationId, operation);
    let finish!: () => void;
    this.activeDone = new Promise(resolve => { finish = resolve; });
    try {
      this.check(attempt);
      await this.refresh(end); this.check(attempt);
      // From this point cancellation is unknown, including a queued or hung fsync.
      attempt.intent = true; operation.state = "dispatching"; operation.unresolved = true;
      this.journal.operations.set(operation.operationId, operation);
      await this.persist(operation, end); this.check(attempt);
      // No await between final permission check, one-time consumption and adapter dispatch.
      proposal.state = "consumed"; clearTimeout(permit.timer); this.permits.delete(approvalId!);
      operation.send = observation(true); this.origins.set(operation.operationId, this.generation);
      const pending = this.adapter.send(proposal.text);
      operation.state = "unknown";
      const evidence = await within(pending, end);
      if (evidence === "simulationCompleted" && operation.stop?.observation.evidence !== "simulationStopped") {
        operation.state = "completed"; operation.unresolved = false; operation.send.evidence = evidence;
      }
      await this.persist(operation, end);
    } catch (error) {
      this.invalidate(proposal.proposalId);
      const code = error instanceof OperationError ? error.code : "unavailable";
      if (operation.state !== "completed" && operation.state !== "cancelled") {
        operation.state = attempt.intent ? "unknown" : "notDispatched";
        operation.unresolved = attempt.intent;
      }
      operation.errorCode = code;
      this.journal.operations.set(operation.operationId, operation);
      if (!this.storageFault) {
        try { await this.persist(operation, end); } catch { operation.errorCode = "storageFault"; }
      }
      if (this.storageFault && attempt.intent) { operation.state = "unknown"; operation.unresolved = true; }
    } finally { if (this.active === attempt) this.active = undefined; finish(); }
    return { operation: structuredClone(operation) };
  }
  private async stop(operationId: string, stopId: string, end: bigint): Promise<StopResult> {
    const sameStop = [...this.journal.operations.values()].find(op => op.stop?.stopId === stopId);
    if (sameStop) {
      if (sameStop.operationId !== operationId) throw new OperationError("conflict");
      const pending = this.stopPromises.get(operationId);
      return pending ? await within(pending, end) : structuredClone(sameStop.stop!);
    }
    this.invalidate(); this.readAbort.abort(); this.readAbort = new AbortController();
    const operation = this.journal.operations.get(operationId);
    if (!operation) throw new OperationError("notFound");
    if (operation.stop) {
      const pending = this.stopPromises.get(operationId);
      const result = pending ? await within(pending, end) : operation.stop;
      return { ...structuredClone(result), alreadyAttempted: true };
    }
    if (!operation.send.requestDispatched) throw new OperationError("unavailable", "send was not attempted");
    if (this.origins.get(operationId) !== this.generation) throw new OperationError("staleContext");
    const result: StopResult = { stopId, operationId, alreadyAttempted: false, observation: observation(), operationState: operation.state };
    operation.stop = result;
    const run = async (): Promise<StopResult> => {
      try {
        // A slow journal cannot consume the entire stop deadline. Never start another writer.
        try { await this.persist(operation, this.now() + 500000000n < end ? this.now() + 500000000n : end); }
        catch { this.storageFault = true; }
        if (this.now() >= end) throw new OperationError("timeout");
        result.observation = observation(true);
        const evidence = await within(this.adapter.stop(), end);
        result.observation.evidence = evidence;
        if (evidence === "simulationStopped" && operation.state !== "completed") {
          operation.state = this.storageFault ? "unknown" : "cancelled"; operation.unresolved = this.storageFault;
        }
        result.operationState = operation.state;
        if (!this.storageFault) await this.persist(operation, end);
      } catch { result.operationState = operation.state; }
      return structuredClone(result);
    };
    const pending = run(); this.stopPromises.set(operationId, pending);
    try { return await pending; } finally { this.stopPromises.delete(operationId); }
  }
  async close(end = this.now() + 5000000000n): Promise<{ portReleased: boolean; recordsFlushed: boolean; rfStopEvidence: "simulationStopped" | "unavailable" }> {
    if (this.closeResult) return this.closeResult;
    this.phase = "closing"; this.invalidate(); this.snapshot = undefined; this.readAbort.abort();
    this.closeResult = (async () => {
      let rfStopEvidence: "simulationStopped" | "unavailable" = "unavailable";
      const active = [...this.journal.operations.values()].find(op => op.send.requestDispatched && op.unresolved && this.origins.get(op.operationId) === this.generation);
      if (active) {
        try { const stopped = await this.stop(active.operationId, active.stop?.stopId ?? randomUUID(), end);
          if (stopped.observation.evidence === "simulationStopped") rfStopEvidence = "simulationStopped"; } catch { /* Evidence stays unavailable. */ }
      }
      let portReleased = false, recordsFlushed = false;
      try { await within(Promise.all([this.adapter.close(), this.readTail]), end); portReleased = true; } catch { /* Report separately. */ }
      try { await within(this.activeDone, end); } catch { this.storageFault = true; }
      try { await within(this.journal.flush(), end); recordsFlushed = !this.storageFault; } catch { /* Keep lock until process exit. */ }
      if (recordsFlushed && portReleased) this.journal.release();
      this.phase = "closed";
      return { portReleased, recordsFlushed, rfStopEvidence };
    })();
    return this.closeResult;
  }
  async handle(raw: unknown): Promise<Response> {
    const req = parseRequest(raw, true);
    const high = this.sequences.get(req.channelId) ?? 0;
    if (req.sequence <= high) return response(req, null, new OperationError("conflict", "sequence replay"));
    if (this.sequences.size >= 2 && !this.sequences.has(req.channelId)) return response(req, null, new OperationError("unauthorized"));
    this.sequences.set(req.channelId, req.sequence);
    let end: bigint;
    try { end = deadline(req, this.now()); } catch (error) { return response(req, null, error); }
    const control = req.method === "cw.stop" || req.method === "device.close";
    if (control ? this.controls.has(req.method) : this.ordinary >= 4) return response(req, null, new OperationError("busy"));
    if (control) this.controls.add(req.method); else this.ordinary++;
    try {
      if (this.phase !== "ready" && !["device.describe", "device.status", "operation.get", "device.close"].includes(req.method)) throw new OperationError("unavailable");
      let result: unknown;
      const p = req.params as Record<string, string>;
      switch (req.method) {
        case "device.describe": result = { serviceInstanceId: this.serviceInstanceId, connectionGeneration: this.generation,
          configuredId: null, hardwareFingerprint: null, capabilities: CAPABILITIES, capabilitiesDigest: CAPABILITIES_DIGEST, blockedReason: this.blockedReason() }; break;
        case "device.status": result = { serviceInstanceId: this.serviceInstanceId, connectionGeneration: this.generation,
          phase: this.phase, context: this.statusContext(), blockedReason: this.blockedReason() }; break;
        case "context.refresh": {
          if (this.active?.intent || this.controls.size) throw new OperationError("busy");
          const snapshot = await this.refresh(end); const failedChecks = this.checks(snapshot.values);
          result = { context: snapshot.context, preflight: { eligible: failedChecks.length === 0, failedChecks } }; break;
        }
        case "proposal.create": {
          if (this.proposals.size >= 32) throw new OperationError("busy");
          const proposal: Proposal = { proposalId: randomUUID(), text: p.text as "E" | "TEST", textSha256: textHash(p.text!), state: "proposed" };
          this.proposals.set(proposal.proposalId, proposal); result = { proposal }; break;
        }
        case "proposal.approve": {
          if (this.active || this.controls.size) throw new OperationError("busy");
          if (this.blockedReason() || !this.journal.hasCapacity()) throw new OperationError("blocked");
          const proposal = this.proposals.get(p.proposalId!);
          if (!proposal) throw new OperationError("notFound");
          if (proposal.state !== "proposed" || !this.snapshot || this.snapshot.context.contextId !== p.contextId ||
            this.now() - this.snapshot.observed >= 3000000000n) throw new OperationError("staleContext");
          const confirmed = structuredClone(this.snapshot.values);
          const version = this.invalidationVersion;
          const snapshot = await this.refresh(end);
          if (this.phase !== "ready" || proposal.state !== "proposed" || this.now() >= end || this.blockedReason() ||
            version !== this.invalidationVersion || this.active || this.controls.size || !this.journal.hasCapacity() ||
            digest(confirmed) !== digest(snapshot.values) || this.checks(snapshot.values).length) throw new OperationError("staleContext");
          const approval: Approval = { approvalId: randomUUID(), proposalId: proposal.proposalId,
            bindingDigest: this.binding(proposal, confirmed), expiresAt: Date.now() + 30000, ttlMs: 30000 };
          const permit: Permit = { public: approval, channel: req.channelId, expires: this.now() + 30000000000n,
            values: confirmed, timer: setTimeout(() => this.invalidate(proposal.proposalId), 30000) };
          permit.timer.unref(); this.permits.set(approval.approvalId, permit); proposal.state = "approved";
          result = { proposal, approval, context: snapshot.context }; break;
        }
        case "proposal.revoke": {
          const proposal = this.proposals.get(p.proposalId!); if (!proposal) throw new OperationError("notFound");
          const revoked = proposal.state !== "consumed";
          this.invalidate(proposal.proposalId); if (revoked) proposal.state = "revoked";
          result = { proposal, revoked }; break;
        }
        case "cw.execute": result = await this.execute(req, end); break;
        case "cw.stop": result = await this.stop(p.operationId!, p.stopId!, end); break;
        case "operation.get": {
          const operation = this.journal.operations.get(p.operationId!); if (!operation) throw new OperationError("notFound");
          result = { operation }; break;
        }
        case "device.reconnect": throw new OperationError("unavailable", "reconnect deferred in temporary Fake slice");
        case "device.close": result = await this.close(end); break;
      }
      return response(req, structuredClone(result));
    } catch (error) { return response(req, null, error); }
    finally { if (control) this.controls.delete(req.method); else this.ordinary--; }
  }
}
