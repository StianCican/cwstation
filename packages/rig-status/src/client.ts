import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { WindowsBridge } from "../../daemon/src/bridge.js";
import {
  rigStatusEndpointAddress,
  type RigStatusEndpoint,
  type RigStatusReport,
  type RigStatusResponse,
} from "./service.js";

export class RigStatusClientError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export class RigStatusClient {
  private buffer = "";
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private nextId = 1;
  private closed = false;
  private bridge: WindowsBridge | undefined;

  private constructor(private readonly socket: Duplex, private readonly timeoutMs: number) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("error", (error) => this.failAll(new RigStatusClientError("unavailable", error.message)));
    socket.on("close", () => this.failAll(new RigStatusClientError("unavailable", "rig-statusd connection closed")));
  }

  static async connect(endpoint: RigStatusEndpoint, timeoutMs = 2000): Promise<RigStatusClient> {
    const address = rigStatusEndpointAddress(endpoint);
    if (endpoint.kind === "pipe") {
      let client: RigStatusClient | undefined;
      let bridge: WindowsBridge | undefined;
      try {
        bridge = new WindowsBridge("client", address, (socket) => {
          client = new RigStatusClient(socket, timeoutMs);
        }, () => undefined, timeoutMs);
        await bridge.ready;
        if (!client) throw new Error("status pipe client unavailable");
        client.bridge = bridge;
        return client;
      } catch (error) {
        await bridge?.stop().catch(() => undefined);
        throw new RigStatusClientError("unavailable", error instanceof Error ? error.message : String(error));
      }
    }
    const socket = await new Promise<Socket>((resolve, reject) => {
      const candidate = connect(address);
      const timer = setTimeout(() => { candidate.destroy(); reject(new Error("status socket connect timed out")); }, timeoutMs);
      candidate.once("connect", () => { clearTimeout(timer); resolve(candidate); });
      candidate.once("error", (error) => { clearTimeout(timer); candidate.destroy(); reject(error); });
    });
    return new RigStatusClient(socket, timeoutMs);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let response: RigStatusResponse;
      try { response = JSON.parse(line) as RigStatusResponse; }
      catch { continue; }
      const id = response.id ?? "";
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (response.ok) pending.resolve(response.result);
      else pending.reject(new RigStatusClientError(response.error?.code ?? "internal", response.error?.message ?? "status request failed"));
    }
  }

  private failAll(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }

  request(method: "status" | "watch" | "reconnect"): Promise<RigStatusReport> {
    if (this.closed) return Promise.reject(new RigStatusClientError("unavailable", "status client is closed"));
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RigStatusClientError("timeout", `${method} exceeded ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(`${JSON.stringify({ id, method, params: {} })}\n`);
    });
  }

  close(): void {
    this.socket.destroy();
    this.bridge?.stop().catch(() => undefined);
    this.failAll(new RigStatusClientError("closed", "status client closed"));
  }
}
