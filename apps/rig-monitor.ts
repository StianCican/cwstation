import { emitKeypressEvents } from "node:readline";
import { CivReadOnlyClient, createSimulatedCivTransport, openSerialCivTransport,
  type CivTransport, type SerialCivTransport, type SimulatedCivTransport,
} from "../packages/devices/src/index.js";
import { renderMonitor, type MonitorState } from "./rig-monitor-view.js";

export interface MonitorOptions {
  simulate: boolean;
  port: string;
  baud: number;
  timeoutMs: number;
  intervalMs: number;
  serviceEndpoint?: string;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runMonitor(options: MonitorOptions): Promise<number> {
  const input = process.stdin;
  const output = process.stdout;
  if (!input.isTTY || !output.isTTY) {
    process.stderr.write("cwrig monitor requires an interactive terminal; use cwrig read for JSON.\n");
    return 2;
  }
  const state: MonitorState = {
    source: options.simulate ? "simulation" : "serial", port: options.port,
    baud: options.baud, status: "disconnected", snapshot: undefined, error: undefined,
    events: [], traces: [], diagnostics: false, polling: true, intervalMs: options.intervalMs,
  };
  let transport: CivTransport | undefined;
  let client: CivReadOnlyClient | undefined;
  let controller: AbortController | undefined;
  let unsubscribe: (() => void) | undefined;
  let connecting: Promise<void> | undefined;
  let reading: Promise<void> | undefined;
  let releasing: Promise<void> | undefined;
  let disconnecting: Promise<void> | undefined;
  let nextRead = 0;
  let exiting = false;
  let openCleanupUnknown = false;
  let exitCode = 0;
  let finish: () => void = () => undefined;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const color = process.env.NO_COLOR === undefined && process.env.TERM !== "dumb";
  const wasRaw = input.isRaw;
  const wasFlowing = input.readableFlowing;
  let previousLines: string[] = [];
  let previousSize = "";

  function draw(): void {
    const columns = output.columns ?? 80;
    const rows = output.rows ?? 24;
    const lines = renderMonitor(state, columns, rows, Date.now(), color).split("\n");
    const size = `${columns}x${rows}`;
    let update = "";
    const count = Math.min(Math.max(lines.length, previousLines.length), Math.max(0, rows - 1));
    for (let row = 0; row < count; row++) {
      const line = lines[row] ?? "";
      if (size !== previousSize || line !== (previousLines[row] ?? "")) {
        update += `\x1b[${row + 1};1H${line}\x1b[K`;
      }
    }
    previousLines = lines;
    previousSize = size;
    if (update) output.write(update);
  }
  function event(text: string): void {
    state.events.push({ time: Date.now(), message: text });
    if (state.events.length > 40) state.events.shift();
    draw();
  }
  function trace(direction: string, bytes: Uint8Array): void {
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join(" ");
    state.traces.push({ time: Date.now(), message: `${direction} ${hex}` });
    if (state.traces.length > 80) state.traces.shift();
  }
  function released(held: CivTransport): boolean {
    return options.simulate ? (held as SimulatedCivTransport).closed : (held as SerialCivTransport).isClosed;
  }
  function fault(error: unknown): void {
    state.status = "fault";
    state.error = message(error);
    state.polling = false;
    event(`Connection fault: ${state.error}`);
  }

  function release(): Promise<void> {
    if (releasing) return releasing;
    const held = transport;
    const session = client;
    unsubscribe?.();
    unsubscribe = undefined;
    const operation = (async () => {
      if (!held) return;
      try {
        await session?.close();
        await held.close();
      } catch (error) {
        if (!released(held)) throw error;
      } finally {
        if (released(held)) {
          transport = undefined;
          client = undefined;
        }
      }
      if (!released(held)) throw new Error("Port close could not be confirmed; reconnect blocked");
    })();
    releasing = operation;
    void operation.finally(() => { if (releasing === operation) releasing = undefined; }).catch(() => undefined);
    return operation;
  }

  function refresh(): Promise<void> {
    if (reading) return reading;
    const session = client;
    const signal = controller?.signal;
    if (!session || signal?.aborted || exiting || disconnecting || state.status === "fault") return Promise.resolve();
    // Routine reads do not change the last known healthy connection status.
    if (!state.snapshot || state.status === "connecting") state.status = "reading";
    draw();
    const operation = (async () => {
      try {
        const frequencyHz = await session.readFrequency();
        const mode = await session.readMode();
        if (signal?.aborted || exiting) return;
        state.snapshot = { frequencyHz, mode: mode.mode, filter: mode.filter, time: Date.now() };
        state.status = "ready";
        state.error = undefined;
        event("Frequency and mode replies received");
      } catch (error) {
        if (!signal?.aborted && !exiting) {
          if (state.status !== "fault") fault(error);
          try { await release(); } catch (cleanupError) { fault(cleanupError); }
        }
      } finally {
        nextRead = Date.now() + state.intervalMs;
      }
    })();
    reading = operation;
    void operation.finally(() => { if (reading === operation) reading = undefined; }).catch(() => undefined);
    return operation;
  }

  function connect(): Promise<void> {
    if (connecting) return connecting;
    if (disconnecting || exiting || ["ready", "reading", "connecting", "closing"].includes(state.status)) return Promise.resolve();
    const abort = new AbortController();
    controller = abort;
    state.status = "connecting";
    state.error = undefined;
    event(options.simulate ? "Starting offline simulation" : `Opening ${options.port}`);
    const operation = (async () => {
      try {
        if (openCleanupUnknown) throw new Error("Opening cleanup is unconfirmed; quit and restart the monitor");
        if (transport) {
          if (!released(transport)) throw new Error("Previous port close is unconfirmed; disconnect again before connecting");
          await release();
        }
        const held = options.simulate ? createSimulatedCivTransport() : await openSerialCivTransport({
          portPath: options.port, baudRate: options.baud, openTimeoutMs: options.timeoutMs,
          operationTimeoutMs: options.timeoutMs, closeTimeoutMs: options.timeoutMs, signal: abort.signal,
        });
        transport = held;
        if (abort.signal.aborted || exiting) { await release(); return; }
        const observed: CivTransport = {
          write(data) { trace("TX", data); return held.write(data); },
          onData(listener) { return held.onData((data) => { trace("RX", data); listener(data); }); },
          onClose(listener) { return held.onClose(listener); },
          close() { return held.close(); },
        };
        client = new CivReadOnlyClient({ transport: observed, timeoutMs: options.timeoutMs });
        unsubscribe = held.onClose((error) => {
          if (abort.signal.aborted || exiting || state.status === "closing") return;
          if (state.status !== "fault") fault(error ?? new Error("Serial connection closed"));
          void release().catch((cleanupError) => fault(cleanupError));
        });
        // Each explicit connection starts polling again after a fault or pause.
        state.polling = true;
        event(options.simulate ? "Simulation session opened" : "Port opened; awaiting valid replies");
        await refresh();
      } catch (error) {
        if (!transport && message(error).includes("cleanup:")) openCleanupUnknown = true;
        if (!abort.signal.aborted && !exiting) fault(error);
        try { await release(); } catch (cleanupError) { fault(cleanupError); }
      }
    })();
    connecting = operation;
    void operation.finally(() => { if (connecting === operation) connecting = undefined; }).catch(() => undefined);
    return operation;
  }

  function disconnect(): Promise<void> {
    if (disconnecting) return disconnecting;
    state.status = "closing";
    event("Closing session");
    controller?.abort();
    const operation = (async () => {
      try {
        await connecting;
        await release();
        await reading;
        if (openCleanupUnknown) throw new Error("Opening cleanup could not be confirmed; restart required");
        state.status = "disconnected";
        state.error = undefined;
        event("Session closed");
      } catch (error) {
        fault(error);
        if (exiting) exitCode = 1;
      }
    })();
    disconnecting = operation;
    void operation.finally(() => { if (disconnecting === operation) disconnecting = undefined; }).catch(() => undefined);
    return operation;
  }

  async function quit(): Promise<void> {
    if (exiting) return;
    exiting = true;
    await disconnect();
    finish();
  }
  function keypress(text: string, key: { name?: string; ctrl?: boolean }): void {
    if (key?.ctrl && key.name === "c") { void quit(); return; }
    if (exiting) return;
    switch ((key?.name ?? text ?? "").toLowerCase()) {
      case "c": void connect(); break;
      case "d": void disconnect(); break;
      case "r": if (!connecting && !disconnecting) void refresh(); break;
      case "p": state.polling = !state.polling; nextRead = Date.now(); event(state.polling ? "Polling enabled" : "Polling paused"); break;
      case "g": state.diagnostics = !state.diagnostics; draw(); break;
      case "q": void quit(); break;
    }
  }
  const interrupt = (): void => { void quit(); };
  const resize = (): void => draw();
  const eof = (): void => { void quit(); };
  let ticker: ReturnType<typeof setInterval> | undefined;
  try {
    emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    input.on("keypress", keypress);
    input.on("end", eof);
    output.on("resize", resize);
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", interrupt);
    output.write("\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[2J");
    draw();
    ticker = setInterval(() => {
      if (exiting) return;
      draw();
      if (state.polling && state.status === "ready" && !connecting && !reading && !disconnecting && Date.now() >= nextRead) {
        void refresh();
      }
    }, 250);
    void connect();
    await done;
  } finally {
    if (ticker) clearInterval(ticker);
    if (!exiting) {
      exiting = true;
      await disconnect();
    }
    input.off("keypress", keypress);
    input.off("end", eof);
    output.off("resize", resize);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    if (input.isTTY) input.setRawMode(wasRaw ?? false);
    if (wasFlowing !== true) input.pause();
    output.write("\x1b[?7h\x1b[?25h\x1b[?1049l");
  }
  output.write(exitCode ? "CW Station closed; device cleanup could not be confirmed.\n" : "CW Station closed.\n");
  return exitCode;
}
