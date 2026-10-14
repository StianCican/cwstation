import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Duplex } from "node:stream";

const FRAME_LIMIT = 128 * 1024;
const QUEUE_LIMIT = 512 * 1024;
type Frame = Record<string, unknown>;

export function bridgeExecutable(): string {
  let root = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(root, "package.json"))) {
    const parent = dirname(root);
    if (parent === root) throw new Error("cannot locate Windows bridge build");
    root = parent;
  }
  const exe = join(root, "dist", "native", "CwPipeBridge.exe");
  if (!existsSync(exe)) throw new Error("Windows bridge missing; run scripts/build-native-windows.mjs");
  return exe;
}

class BridgeSocket extends Duplex {
  constructor(readonly bridge: WindowsBridge, readonly id: number) {
    super({ readableHighWaterMark: 128 * 1024, writableHighWaterMark: 128 * 1024 });
    this.on("error", () => undefined);
  }
  _read(): void {}
  _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    this.bridge.writeData(this.id, Buffer.from(chunk), done);
  }
  _final(done: (error?: Error | null) => void): void {
    this.bridge.send({ t: "close", id: this.id });
    done();
    this.destroy();
  }
  _destroy(error: Error | null, done: (error?: Error | null) => void): void {
    this.bridge.sockets.delete(this.id);
    this.bridge.cancelWrites(this.id);
    this.bridge.send({ t: "close", id: this.id });
    done(error);
    if (this.bridge.role === "client") void this.bridge.stop();
  }
  receive(bytes: Buffer): void {
    if (!this.push(bytes)) this.destroy(new Error("pipe receive queue exceeded"));
  }
}

export class WindowsBridge {
  readonly sockets = new Map<number, BridgeSocket>();
  readonly child: ChildProcessWithoutNullStreams;
  info: Frame | undefined;
  running = false;
  private stopping = false;
  private failed = false;
  private buffer = Buffer.alloc(0);
  private seq = 0;
  private readonly writes = new Map<number, { id: number; done: (error?: Error | null) => void; timer: NodeJS.Timeout }>();
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  readonly ready: Promise<void>;

  constructor(
    readonly role: "server" | "client",
    readonly pipe: string,
    private readonly onConnection: (socket: Duplex) => void,
    private readonly onFailure: () => void,
    timeoutMs = 5000,
  ) {
    if (process.platform !== "win32") throw new Error("Windows bridge requires native Windows");
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    const args = [role, "--pipe", pipe, "--parent", String(process.pid)];
    if (role === "client") args.push("--connect-timeout-ms", String(Math.min(15000, Math.max(1, timeoutMs))));
    this.child = spawn(bridgeExecutable(), args, { stdio: "pipe", shell: false, windowsHide: true });
    const timer = setTimeout(() => this.fail("Windows bridge startup timed out"), timeoutMs + 1000);
    void this.ready.then(() => clearTimeout(timer), () => clearTimeout(timer));
    this.child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    this.child.stderr.on("data", () => undefined);
    this.child.stdin.on("error", () => this.fail("Windows bridge input closed"));
    this.child.on("error", () => this.fail("Windows bridge could not start"));
    this.child.on("exit", () => {
      this.running = false;
      if (!this.stopping) this.fail("Windows bridge exited");
    });
  }

  send(frame: Frame): void {
    if (this.stopping || this.failed) return;
    const bytes = `${JSON.stringify({ ...frame, v: 1 })}\n`;
    if (Buffer.byteLength(bytes) > FRAME_LIMIT || this.child.stdin.writableLength > QUEUE_LIMIT) {
      this.fail("Windows bridge send queue exceeded");
      return;
    }
    this.child.stdin.write(bytes);
  }

  writeData(id: number, bytes: Buffer, done: (error?: Error | null) => void): void {
    if (this.failed || this.stopping) { done(new Error("Windows bridge unavailable")); return; }
    if (bytes.length === 0) { done(); return; }
    const seq = ++this.seq;
    const chunk = bytes.subarray(0, 64 * 1024);
    const timer = setTimeout(() => this.fail("Windows bridge write timed out"), 6000);
    this.writes.set(seq, { id, timer, done: (error) => {
      if (error) done(error);
      else if (bytes.length > chunk.length) this.writeData(id, bytes.subarray(chunk.length), done);
      else done();
    } });
    this.send({ t: "data", id, seq, b: chunk.toString("base64") });
  }

  cancelWrites(id: number): void {
    for (const [seq, write] of this.writes) {
      if (write.id !== id) continue;
      this.writes.delete(seq);
      clearTimeout(write.timer);
      write.done(new Error("pipe connection closed"));
    }
  }

  private receive(chunk: Buffer): void {
    if (this.failed || this.stopping) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const newline = this.buffer.indexOf(10);
      if (newline < 0) break;
      if (newline > FRAME_LIMIT) { this.fail("Windows bridge frame exceeded"); return; }
      const bytes = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      try { this.frame(JSON.parse(bytes.toString("utf8")) as Frame); }
      catch { this.fail("Windows bridge protocol invalid"); return; }
      if (this.failed || this.stopping) return;
    }
    if (this.buffer.length > FRAME_LIMIT) this.fail("Windows bridge frame exceeded");
  }

  private frame(frame: Frame): void {
    if (frame === null || Array.isArray(frame) || frame.v !== 1) throw new Error("bad frame");
    if (frame.t === "fatal") { this.fail("Windows bridge rejected connection or permissions"); return; }
    if (frame.t === "ready") {
      if (this.info || frame.role !== this.role || frame.pipe !== this.pipe || frame.pid !== this.child.pid ||
          frame.verified !== true || typeof frame.userSid !== "string" || typeof frame.dacl !== "string") throw new Error("bad ready");
      const sid = frame.userSid;
      if (!/^S-1-5-[0-9-]+$/.test(sid) || !frame.dacl.endsWith(`D:P(D;;FA;;;NU)(A;;FA;;;${sid})(A;;FA;;;SY)`)) throw new Error("bad ACL");
      if (this.role === "server" && (frame.rejectRemote !== true || frame.parentPid !== process.pid)) throw new Error("bad server");
      if (this.role === "client" && (frame.serverUserSid !== sid || !Number.isSafeInteger(frame.serverPid))) throw new Error("bad identity");
      this.info = frame;
      this.running = true;
      if (this.role === "client") this.addSocket(1);
      this.resolveReady();
      return;
    }
    if (!this.info || !Number.isSafeInteger(frame.id) || (frame.id as number) < 1) throw new Error("bad connection");
    const id = frame.id as number;
    if (frame.t === "conn" && this.role === "server") {
      if (this.sockets.has(id) || this.sockets.size >= 32) throw new Error("bad connection");
      this.addSocket(id);
    } else if (frame.t === "data") {
      if (typeof frame.b !== "string" || frame.b.length > 87384 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.b)) throw new Error("bad data");
      this.sockets.get(id)?.receive(Buffer.from(frame.b, "base64"));
    } else if (frame.t === "close") {
      this.sockets.get(id)?.destroy();
    } else if (frame.t === "ack") {
      const seq = frame.seq as number;
      const write = this.writes.get(seq);
      if (!Number.isSafeInteger(seq) || seq < 1) throw new Error("bad write acknowledgement");
      if (!write) return; // A connection may close before its final write acknowledgement arrives.
      if (write.id !== id) throw new Error("bad write acknowledgement");
      this.writes.delete(seq);
      clearTimeout(write.timer);
      write.done();
    } else throw new Error("unexpected frame");
  }

  private addSocket(id: number): void {
    const socket = new BridgeSocket(this, id);
    this.sockets.set(id, socket);
    this.onConnection(socket);
  }

  private fail(message: string): void {
    if (this.failed || this.stopping) return;
    this.failed = true;
    this.running = false;
    const error = new Error(message);
    this.rejectReady(error);
    for (const socket of [...this.sockets.values()]) socket.destroy(error);
    for (const id of new Set([...this.writes.values()].map((write) => write.id))) this.cancelWrites(id);
    this.child.kill();
    this.onFailure();
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.send({ t: "shutdown" });
    this.stopping = true;
    this.running = false;
    for (const socket of [...this.sockets.values()]) socket.destroy();
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { this.child.kill(); }, 1000);
      const deadline = setTimeout(() => { clearTimeout(timer); resolve(); }, 2000);
      this.child.once("close", () => { clearTimeout(timer); clearTimeout(deadline); resolve(); });
    });
  }
}
