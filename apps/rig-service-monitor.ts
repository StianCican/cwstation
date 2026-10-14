import { emitKeypressEvents } from "node:readline";
import { RigStatusClient, parseRigStatusEndpoint, type RigStatusReport } from "../packages/rig-status/src/index.js";
import { renderMonitor, type MonitorState } from "./rig-monitor-view.js";

export interface ServiceMonitorOptions { endpoint: string; timeoutMs: number; intervalMs: number }

export async function runServiceMonitor(options: ServiceMonitorOptions): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write("cwrig monitor service mode requires an interactive terminal.\n"); return 2;
  }
  const state: MonitorState = { source: "serial", port: "rig-statusd", baud: 0,
    status: "disconnected", snapshot: undefined, error: undefined, events: [], traces: [],
    diagnostics: false, polling: true, intervalMs: options.intervalMs };
  let client: RigStatusClient | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopping = false;
  let busy = false;
  let connecting = false;
  // 每代连接/关闭递增；晚到的回复与旧 tick 用代次判定失效，不更新已关闭状态。
  let generation = 0;
  let previous: string[] = [];
  let previousSize = "";
  const endpoint = parseRigStatusEndpoint(options.endpoint);
  const addEvent = (message: string): void => {
    state.events.push({ time: Date.now(), message }); if (state.events.length > 30) state.events.shift();
  };
  const draw = (): void => {
    const columns = process.stdout.columns ?? 80, rows = process.stdout.rows ?? 24;
    const lines = renderMonitor(state, columns, rows, Date.now(), process.env.NO_COLOR === undefined).split("\n");
    const size = `${columns}x${rows}`; let out = "";
    const count = Math.min(Math.max(lines.length, previous.length), Math.max(0, rows - 1));
    for (let i = 0; i < count; i++) if (size !== previousSize || lines[i] !== previous[i]) out += `\x1b[${i + 1};1H${lines[i] ?? ""}\x1b[K`;
    previous = lines; previousSize = size; if (out) process.stdout.write(out);
  };
  const apply = (report: RigStatusReport): void => {
    state.source = report.simulation ? "simulation" : "serial";
    state.status = report.status === "stale" ? "stale" : report.status;
    state.error = report.error ?? undefined;
    state.snapshot = report.snapshot === null ? undefined : {
      frequencyHz: report.snapshot.frequencyHz,
      mode: report.snapshot.mode,
      filter: report.snapshot.filter,
      time: report.snapshot.snapshotTime,
    };
    state.port = report.portPath ?? "rig-statusd"; state.baud = report.baudRate ?? 0;
  };
  const closeClient = (): void => { client?.close(); client = undefined; };
  const refresh = async (): Promise<void> => {
    const current = client;
    if (!current || busy || stopping) return;
    const gen = generation;
    busy = true; try {
      const report = await current.request("watch");
      if (gen !== generation || stopping) return;
      apply(report);
    } catch (error) {
      if (gen !== generation || stopping) return;
      state.status = "fault"; state.error = error instanceof Error ? error.message : String(error); state.polling = false;
      addEvent(`Status service fault: ${state.error}`);
    } finally { busy = false; if (gen === generation && !stopping) draw(); }
  };
  const connect = async (reconnect: boolean): Promise<void> => {
    // 连击 C 不得启动并发 reconnect：已有连接尝试时忽略。
    if (stopping || connecting) return;
    connecting = true;
    generation += 1;
    const gen = generation;
    closeClient(); state.status = "connecting"; state.error = undefined; draw();
    try {
      const candidate = await RigStatusClient.connect(endpoint, options.timeoutMs);
      if (gen !== generation || stopping) { candidate.close(); return; }
      client = candidate;
      // 初始连接只请求 status；C 才是显式服务端 reconnect（USB 拔插后恢复）。
      const report = await candidate.request(reconnect ? "reconnect" : "status");
      if (gen !== generation || stopping) return;
      apply(report);
      state.polling = true; addEvent(reconnect ? "Reconnected to rig-statusd" : "Connected to rig-statusd");
    }
    catch (error) {
      if (gen !== generation || stopping) return;
      state.status = "fault"; state.error = error instanceof Error ? error.message : String(error); state.polling = false; closeClient();
    }
    finally { connecting = false; if (gen === generation && !stopping) draw(); }
  };
  const disconnect = (): void => { generation += 1; closeClient(); state.status = "disconnected"; state.polling = false; addEvent("Disconnected from rig-statusd"); draw(); };
  const finish = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    generation += 1;
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    closeClient();
    input.pause();
    if (input.isTTY) input.setRawMode(false);
    input.off("keypress", onKey); process.off("SIGINT", onSignal); process.off("SIGTERM", onSignal);
    process.off("disconnect", onSignal); process.off("message", onHostMessage);
    if (typeof process.send === "function" && process.connected) process.disconnect();
    process.stdout.write("\x1b[?25h\x1b[?7h\x1b[?1049l\n"); done();
  };
  const input = process.stdin; let done: () => void = () => undefined; const completed = new Promise<void>((resolve) => { done = resolve; });
  const onSignal = (): void => { void finish(); };
  const onHostMessage = (raw: unknown): void => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return;
    const frame = raw as { version?: unknown; command?: unknown; event?: unknown; error?: unknown };
    if (frame.version === 1 && frame.command === "shutdown") void finish();
    else if (frame.version === 1 && frame.event === "service_fault" && !stopping) {
      generation += 1;
      closeClient();
      state.status = "fault";
      state.error = typeof frame.error === "string" ? frame.error : "Device service unavailable";
      state.polling = false;
      addEvent(state.error);
      draw();
    }
  };
  const onKey = (text: string, key: { name?: string; ctrl?: boolean }): void => {
    if (key.ctrl && key.name === "c") { void finish(); return; }
    switch ((key.name ?? text).toLowerCase()) {
      case "c": void connect(true); break; case "d": disconnect(); break; case "r": void refresh(); break;
      case "p": state.polling = !state.polling; addEvent(state.polling ? "Polling enabled" : "Polling paused"); draw(); break;
      case "g": state.diagnostics = !state.diagnostics; draw(); break; case "q": void finish(); break;
    }
  };
  const tick = (): void => {
    if (stopping) return;
    if (state.polling && client) void refresh();
    // stop/finish 之后不得再挂 timer。
    if (stopping) return;
    timer = setTimeout(tick, options.intervalMs);
  };
  emitKeypressEvents(input); input.setRawMode(true); input.resume(); input.on("keypress", onKey);
  process.on("SIGINT", onSignal); process.on("SIGTERM", onSignal);
  if (typeof process.send === "function") {
    process.on("disconnect", onSignal); process.on("message", onHostMessage);
  }
  process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[2J"); draw();
  if (typeof process.send === "function" && !process.connected) void finish();
  await connect(false); tick(); await completed; if (input.isTTY) input.setRawMode(false); return 0;
}
