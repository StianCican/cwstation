import type { Proposal } from "../../contracts/src/index.js";
import { ControllerError, type TxController } from "../../core/src/tx-controller.js";
import type { FakeRigClient } from "./client.js";
import { validateResponse, type DeviceCapabilities, type DeviceSnapshot } from "./protocol.js";
import type { RemoteKeyer } from "./remote-keyer.js";

// The host owns the child. This session only observes and invalidates authorization.
export class RemoteFakeSession {
  private caps: DeviceCapabilities | null = null;
  private snapshot: DeviceSnapshot | null = null;
  private fingerprint: string | null = null;
  private error: string | null = null;
  private closed = false;
  private started = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: Promise<void> | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly controller: TxController, private readonly client: FakeRigClient,
    private readonly keyer: RemoteKeyer) {}

  async start(): Promise<void> {
    if (this.closed || this.started) return;
    this.started = true;
    this.unsubscribe = this.client.subscribeFailure((error) => this.fail(error));
    await this.refresh();
    this.schedule();
  }

  refresh(): Promise<void> {
    if (this.closed || !this.started) return Promise.resolve();
    if (this.pending !== null) return this.pending;
    const operation = this.read();
    this.pending = operation;
    void operation.finally(() => { if (this.pending === operation) this.pending = null; }).catch(() => undefined);
    return operation;
  }

  private async read(): Promise<void> {
    try {
      const caps = await this.client.refreshCapabilities();
      const snapshot = await this.client.snapshot();
      if (this.closed) return;
      if (!this.client.connected) throw new Error("Fake service is disconnected");
      validateResponse({ protocolVersion: 1, id: "observe", ok: true, result: caps }, "device.capabilities");
      validateResponse({ protocolVersion: 1, id: "observe", ok: true, result: snapshot }, "device.snapshot");
      if (caps.deviceInstanceId !== this.client.deviceInstanceId || snapshot.deviceInstanceId !== caps.deviceInstanceId ||
          snapshot.serviceInstanceId !== caps.serviceInstanceId || snapshot.simulation !== true ||
          caps.backendKind !== "fake" || caps.evidenceSource !== "simulation" ||
          snapshot.connectionGeneration !== caps.connectionGeneration || snapshot.permissionGeneration !== caps.permissionGeneration ||
          snapshot.mode !== "CW" || Date.now() - snapshot.snapshotTime > 2_000 || snapshot.snapshotTime > Date.now() + 20) {
        throw new Error("invalid or stale Fake device context");
      }
      const frequency = snapshot.frequencyHz;
      const fingerprint = JSON.stringify([caps.deviceInstanceId, caps.serviceInstanceId, frequency, snapshot.mode,
        snapshot.connectionGeneration, snapshot.permissionGeneration, caps.maxMessageBytes, caps.charsetVersion,
        caps.civAddress, caps.reliableCompletionEvidence, caps.reliableStopEvidence, caps.methods, caps.blocked, caps.blockedReason]);
      if (fingerprint !== this.fingerprint) {
        const generation = this.controller.status().generation;
        this.controller.setState({ frequencyHz: frequency, backendConnected: !caps.blocked }, "remote-fake:context-change");
        if (generation === this.controller.status().generation) this.controller.invalidate("remote-fake:context-change", true);
      }
      this.caps = caps;
      this.snapshot = snapshot;
      this.fingerprint = fingerprint;
      this.error = null;
    } catch (error) {
      if (!this.closed) this.fail(error);
    }
  }

  private fail(error: unknown): void {
    if (this.closed) return;
    this.error = error instanceof Error ? error.message : String(error);
    const hadContext = this.fingerprint !== null;
    this.caps = null;
    this.snapshot = null;
    this.fingerprint = null;
    if (!hadContext) return;
    try {
      const generation = this.controller.status().generation;
      this.controller.setState({ backendConnected: false }, "remote-fake:unavailable");
      if (generation === this.controller.status().generation) this.controller.invalidate("remote-fake:unavailable", true);
    } catch (failure) {
      this.error = `authorization persistence failed: ${String(failure)}`;
    }
  }

  checkApproval(proposal: Readonly<Proposal>): void {
    if (!this.started || this.closed || !this.client.connected || this.caps === null || this.snapshot === null || this.error !== null) {
      throw new ControllerError("blocked", `remote Fake unavailable: ${this.error ?? "no active device context"}`);
    }
    if (this.controller.status().blockedReason !== null) {
      throw new ControllerError("blocked", "core recovery or persistence fault blocks remote Fake approval");
    }
    this.keyer.checkApproval(proposal, this.caps, this.snapshot);
  }

  view(): Record<string, unknown> {
    const age = this.snapshot === null ? null : Date.now() - this.snapshot.snapshotTime;
    return { backendKind: "fake", evidenceSource: "simulation", pid: this.client.pid,
      connected: !this.closed && this.client.connected, capabilities: this.caps, snapshot: this.snapshot,
      fresh: age !== null && age >= -20 && age <= 2_000, error: this.error,
      executionMetrics: this.keyer.executionMetrics };
  }

  private schedule(): void {
    if (this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh();
      this.schedule();
    }, 1_000);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.pending;
    this.caps = null;
    this.snapshot = null;
  }
}
