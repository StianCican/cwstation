import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeFakeFixture } from "../packages/device-operation/src/fixture-journal.js";
import { within } from "../packages/device-operation/src/fake-service.js";
import { OperationError, bounded, limit, parseRequest, parseResponse, response,
  uuid, type InternalRequest, type Request, type Response } from "../packages/device-operation/src/protocol.js";

export function parseFakeMode(argv: readonly string[]): { demo: "E" | "TEST" | null } {
  if (argv.length !== 3 && argv.length !== 5 || argv[0] !== "--mode" || argv[1] !== "cw-trial" || argv[2] !== "--simulate" ||
    (argv.length === 5 && (argv[3] !== "--demo" || (argv[4] !== "E" && argv[4] !== "TEST"))))
    throw new OperationError("invalidParams", "usage: --mode cw-trial --simulate [--demo E|TEST]");
  return { demo: argv[4] as "E" | "TEST" | undefined ?? null };
}

// One bounded correlation table per actual inherited interaction handle. No public control endpoint.
export class OperationRelay {
  readonly operatorChannel = randomUUID();
  private hostChannel = randomUUID();
  private highest = 0;
  private serviceSequence = 0;
  private pending = new Map<string, { original: Request; internal: InternalRequest; resolve: (result: Response) => void; timer: NodeJS.Timeout; control: string | null }>();
  private closed = false;
  private serviceInstanceId: string | undefined;
  constructor(private send: (value: InternalRequest) => void) {}
  bindService(id: string): void {
    if (!uuid(id) || this.serviceInstanceId) throw new OperationError("conflict");
    this.serviceInstanceId = id;
  }
  async request(raw: unknown, host = false): Promise<Response> {
    const req = parseRequest(raw, false);
    if (this.closed) return response(req, null, new OperationError("unavailable"));
    if (!host && req.sequence <= this.highest) return response(req, null, new OperationError("conflict"));
    if (!host) this.highest = req.sequence;
    const control = req.method === "cw.stop" || req.method === "device.close" ? req.method : null;
    if (control ? [...this.pending.values()].some(p => p.control === control)
      : [...this.pending.values()].filter(p => !p.control).length >= 4) return response(req, null, new OperationError("busy"));
    if (this.serviceSequence >= Number.MAX_SAFE_INTEGER) { this.disconnect(); return response(req, null, new OperationError("unavailable")); }
    const ms = limit(req.method);
    const internal: InternalRequest = { ...req, id: randomUUID(), sequence: ++this.serviceSequence,
      deadlineNs: (process.hrtime.bigint() + BigInt(ms) * 1000000n).toString(), remainingMs: ms,
      actor: host ? "host" : "operator", channelId: host ? this.hostChannel : this.operatorChannel };
    // Validate roles and envelope before forwarding, including caller-forged host fields.
    parseRequest(internal, true);
    return await new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(internal.id); resolve(response(req, null, new OperationError("timeout")));
      }, ms);
      this.pending.set(internal.id, { original: req, internal, resolve, timer, control });
      try { bounded(internal); this.send(internal); }
      catch { clearTimeout(timer); this.pending.delete(internal.id); resolve(response(req, null, new OperationError("unavailable"))); }
    });
  }
  receive(raw: unknown): void {
    if (!raw || typeof raw !== "object" || !("id" in raw) || typeof raw.id !== "string") return;
    const pending = this.pending.get(raw.id); if (!pending) return;
    let result;
    try {
      result = parseResponse(raw, pending.internal);
      if (result.ok && this.serviceInstanceId) {
        const value = result.result as Record<string, unknown>;
        const context = value.context as Record<string, unknown> | null | undefined;
        const instance = value.serviceInstanceId ?? context?.serviceInstanceId;
        if (instance !== undefined && instance !== this.serviceInstanceId) throw new OperationError("conflict", "service instance changed");
      }
    }
    catch { this.disconnect(); return; }
    clearTimeout(pending.timer); this.pending.delete(raw.id);
    pending.resolve({ ...result, id: pending.original.id, sequence: pending.original.sequence });
  }
  disconnect(): void {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer); pending.resolve(response(pending.original, null, new OperationError("unavailable")));
    }
    this.pending.clear();
  }
}

export async function runFakeOperationHost(argv: readonly string[], root: string): Promise<number> {
  const options = parseFakeMode(argv); // Validate everything before creating fixtures or forking.
  const parent = await mkdtemp(join(tmpdir(), "cwstation-operation-fake-"));
  const fixture = join(parent, "fixture");
  await initializeFakeFixture(fixture);
  process.stderr.write(JSON.stringify({ source: "rig-launch", mode: "cw-trial", backend: "simulation", fixture }) + "\n");
  const startedAt = process.hrtime.bigint();
  const child = fork(join(root, "dist/apps/rig-controld.js"), ["--operation-fake-fixture", fixture], {
    stdio: ["ignore", "pipe", "pipe", "ipc"], execArgv: [], windowsHide: true,
  });
  // Consume diagnostics without retaining unbounded buffers.
  child.stdout?.resume(); child.stderr?.on("data", (data: Buffer) => process.stderr.write(data.subarray(0, 4096)));
  let exited = false, childCode: number | null = null;
  const childExit = new Promise<void>(resolve => child.once("exit", code => { exited = true; childCode = code; resolve(); }));
  const relay = new OperationRelay(req => { child.send(req, error => { if (error) relay.disconnect(); }); });
  let closeRequest: Promise<Response> | undefined;
  const closeService = (): Promise<Response> => closeRequest ??= relay.request({ deviceOperationVersion: 1,
    id: randomUUID(), sequence: 1, method: "device.close", params: {} }, true);
  let readyResolve!: () => void, readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  let stopped: { portReleased: boolean; recordsFlushed: boolean } | undefined;
  child.on("message", (raw: unknown) => {
    const v = raw as Record<string, unknown> | null;
    if (v?.version === 1 && v.event === "ready") {
      if (!uuid(v.serviceInstanceId) || typeof v.clockNs !== "string" || !/^\d{1,30}$/.test(v.clockNs) ||
        BigInt(v.clockNs) < startedAt || BigInt(v.clockNs) > process.hrtime.bigint()) readyReject(new Error("child monotonic clock mismatch"));
      else { try { relay.bindService(v.serviceInstanceId); readyResolve(); } catch { readyReject(new Error("duplicate service ready")); } }
    } else if (v?.version === 1 && v.event === "stopped") {
      stopped = { portReleased: v.portReleased === true, recordsFlushed: v.recordsFlushed === true };
    } else relay.receive(raw);
  });
  child.once("error", error => { readyReject(error); relay.disconnect(); });
  child.once("exit", () => { readyReject(new Error("service exited")); relay.disconnect(); });
  let client: ChildProcess | undefined;
  let clientDone: Promise<number> | undefined;
  let signalResolve!: () => void;
  const signal = new Promise<void>(resolve => { signalResolve = resolve; });
  child.once("disconnect", () => { relay.disconnect(); if (!closeRequest) signalResolve(); });
  const onSignal = (): void => signalResolve();
  process.once("SIGINT", onSignal); process.once("SIGTERM", onSignal);
  let outcome = 1;
  try {
    await within(ready, process.hrtime.bigint() + 10000000000n);
    client = fork(join(root, "dist/apps/cw-operation.js"), options.demo ? ["--demo", options.demo] : [], {
      stdio: ["inherit", "inherit", "inherit", "ipc"], execArgv: [],
    });
    clientDone = new Promise(resolve => {
      client!.once("error", () => resolve(1));
      client!.once("exit", code => resolve(code ?? 1));
      client!.once("disconnect", () => { void closeService().catch(() => undefined); });
    });
    client.on("message", (raw: unknown) => {
      void relay.request(raw).then(result => {
        try { if (client?.connected) client.send(result, () => undefined); }
        catch { signalResolve(); }
      }, () => { client?.kill(); signalResolve(); });
    });
    const serviceFailure = childExit.then(async () => client && !client.connected && closeRequest
      ? await within(clientDone!, process.hrtime.bigint() + 2000000000n).catch(() => 1) : 1);
    outcome = await Promise.race([clientDone, serviceFailure, signal.then(() => 1)]);
    const close = await closeService();
    if (!close.ok) outcome = 3;
  } catch (error) { process.stderr.write(String(error) + "\n"); outcome = 1; }
  finally {
    if (client?.connected) { try { client.disconnect(); } catch { /* Already closed. */ } }
    if (client && client.exitCode === null && client.signalCode === null) client.kill();
    // EOF revokes all approvals and closes the service even if a request failed.
    if (child.connected) { try { child.disconnect(); } catch { /* Already closed. */ } }
    try { await within(childExit, process.hrtime.bigint() + 5000000000n); }
    catch { child.kill("SIGKILL"); outcome = 3; await within(childExit, process.hrtime.bigint() + 2000000000n).catch(() => undefined); }
    if (clientDone) await within(clientDone, process.hrtime.bigint() + 2000000000n).catch(() => { outcome = 3; });
    relay.disconnect(); process.off("SIGINT", onSignal); process.off("SIGTERM", onSignal);
  }
  if (!exited || childCode !== 0 || !stopped?.portReleased || !stopped.recordsFlushed) return 3;
  return outcome;
}
