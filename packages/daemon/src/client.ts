// CLI 使用的本地 Unix socket 客户端：NDJSON 请求/响应，支持并发在途请求。

import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { WindowsBridge } from "./bridge.js";
import { PROTOCOL_VERSION, type RpcErrorCode, type RpcResponse } from "../../contracts/src/index.js";

export class RpcError extends Error {
  constructor(readonly code: RpcErrorCode, message: string) {
    super(message);
    this.name = "RpcError";
  }
}

export class DaemonUnavailableError extends Error {}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export interface ClientOptions {
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export class DaemonClient {
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();
  private closed = false;

  private constructor(
    private readonly socket: Duplex,
    private readonly defaultRequestTimeoutMs: number,
  ) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("error", (error) => this.failAll(new DaemonUnavailableError(String(error))));
    socket.on("close", () => this.failAll(new DaemonUnavailableError("daemon connection closed")));
  }

  static async connect(socketPath: string, options: ClientOptions = {}): Promise<DaemonClient> {
    const connectTimeoutMs = options.connectTimeoutMs ?? 2_000;
    if (process.platform === "win32") {
      let client: DaemonClient | undefined;
      let bridge: WindowsBridge | undefined;
      try {
        bridge = new WindowsBridge("client", socketPath, (socket) => {
          client = new DaemonClient(socket, options.requestTimeoutMs ?? 15_000);
        }, () => undefined, connectTimeoutMs);
        await bridge.ready;
        if (!client) throw new Error("Windows pipe client not ready");
        return client;
      } catch {
        await bridge?.stop();
        throw new DaemonUnavailableError("Windows pipe connection or identity verification failed");
      }
    }
    return new Promise((resolve, reject) => {
      const socket = connect(socketPath);
      const onError = (): void => {
        socket.destroy();
        reject(new DaemonUnavailableError(`cannot reach daemon at ${socketPath}: connection failed`));
      };
      const onErrorArg = (error: Error): void => {
        socket.destroy();
        reject(new DaemonUnavailableError(`cannot reach daemon at ${socketPath}: ${String(error)}`));
      };
      socket.setTimeout(connectTimeoutMs, onError);
      socket.once("connect", () => {
        socket.setTimeout(0);
        socket.removeListener("error", onErrorArg);
        resolve(new DaemonClient(socket, options.requestTimeoutMs ?? 15_000));
      });
      socket.once("error", onErrorArg);
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length === 0) continue;
      let response: RpcResponse;
      try {
        response = JSON.parse(line) as RpcResponse;
      } catch {
        continue;
      }
      const key = response.id ?? "";
      const pending = this.pending.get(key);
      if (!pending) continue;
      this.pending.delete(key);
      clearTimeout(pending.timer);
      if (response.ok) pending.resolve(response.result);
      else pending.reject(new RpcError(response.error?.code ?? "internal", response.error?.message ?? "unknown error"));
    }
  }

  private failAll(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  request(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new DaemonUnavailableError("client is closed"));
    const id = String(this.nextId++);
    const effectiveTimeout = timeoutMs ?? this.defaultRequestTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError("request_timeout", `request ${method} exceeded ${effectiveTimeout}ms`));
      }, effectiveTimeout);
      this.pending.set(id, { resolve, reject, timer });
      const frame = JSON.stringify({ protocolVersion: PROTOCOL_VERSION, id, method, params });
      this.socket.write(`${frame}\n`);
    });
  }

  close(): void {
    this.socket.end();
    this.socket.destroy();
    this.failAll(new DaemonUnavailableError("client closed"));
  }
}
