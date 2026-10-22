// Independent read-only CI-V CLI; does not use the daemon or database.

import { pathToFileURL } from "node:url";
import { CivError, CivReadOnlyClient, createSimulatedCivTransport, openSerialCivTransport,
  civPlanHex, planCivCwMessage, planCivCwStop, SERIAL_ALLOWED_BAUD_RATES,
  type OpenSerialCivTransportOptions, type SerialCivTransport,
} from "../packages/devices/src/index.js";
import { RigStatusClient, parseRigStatusEndpoint, readRigStatusHistory } from "../packages/rig-status/src/index.js";

const USAGE = "cwrig simulate | cwrig status --endpoint <path|\\\\.\\pipe\\name> | cwrig read ... | cwrig tx --dry-run (--text <ASCII>|--stop) | cwrig history --file <path> [--tail N] | cwrig monitor ... | cwrig receive --decoder <executable> (--pcm-s16le <file|-> | --ffmpeg <executable> --audio-backend <pulse|dshow> --audio-device <name>) [--timeout-ms N] [--reply-config <file> --own-call <call> --peer-call <call> [--reply-idle-ms <1000..10000>]] [--reply-continuous [--reply-wpm <5..60>] [--reply-budget-ms <100..10000>]] [--reply-prepared] [--reply-trial-simulate --reply-trial-record-dir <dir> [--reply-auto]]";

type Json = Record<string, unknown>;

function print(value: Json): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/** 运行一次纯离线模拟读取，返回规范化 JSON 结果。 */
export async function runSimulation(): Promise<Json> {
  const transport = createSimulatedCivTransport();
  const client = new CivReadOnlyClient({ transport });
  try {
    const frequencyHz = await client.readFrequency();
    const reading = await client.readMode();
    return {
      source: "simulation",
      readOnly: true,
      frequencyHz,
      mode: reading.mode,
      filter: reading.filter,
      note: "offline simulation only; no serial port was opened and no transmission is possible",
    };
  } finally {
    await client.close();
  }
}

/** 命令行入口；返回进程退出码。 */
export interface ReadOptions { port: string; baud: number; timeoutMs: number; endpoint?: string }
type SerialOpener = (options: OpenSerialCivTransportOptions) => Promise<SerialCivTransport>;

export function parseReadArgs(argv: readonly string[]): ReadOptions {
  const seen = new Set<string>();
  let port = "";
  let baud = 19200;
  let timeoutMs = 2000;
  let endpoint: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    if (!["--port", "--baud", "--timeout-ms", "--endpoint", "--confirm-keying-off"].includes(flag) || seen.has(flag)) {
      throw new Error(`unknown or duplicate argument: ${flag}`);
    }
    seen.add(flag);
    if (flag === "--confirm-keying-off") continue;
    const value = argv[++index];
    if (value === undefined || value.startsWith("--") || value.trim() !== value || value.length === 0) {
      throw new Error(`missing or invalid value for ${flag}`);
    }
    if (flag === "--port") port = value;
    else if (flag === "--endpoint") endpoint = value;
    else {
      if (!/^[0-9]+$/.test(value)) throw new Error(`invalid number for ${flag}`);
      const number = Number(value);
      if (flag === "--baud") baud = number;
      else timeoutMs = number;
    }
  }
  if (endpoint !== undefined) {
    if (port || seen.has("--baud") || seen.has("--confirm-keying-off") || seen.has("--timeout-ms")) {
      throw new Error("--endpoint cannot be combined with direct serial options");
    }
    parseRigStatusEndpoint(endpoint);
    return { port: "service", baud: 0, timeoutMs, endpoint };
  }
  if (!port || !seen.has("--confirm-keying-off")) {
    throw new Error("--port and --confirm-keying-off are required (USB SEND/CW/RTTY mappings must be OFF)");
  }
  if (!SERIAL_ALLOWED_BAUD_RATES.includes(baud)) throw new Error("unsupported baud rate");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error("timeout must be 1..60000 ms");
  return { port, baud, timeoutMs };
}

export interface HistoryOptions { file: string; tail: number }

export interface TxDryRunOptions { text?: string; stop: boolean }

/** Parse the non-executable CI-V CW planning command. */
export function parseTxDryRunArgs(argv: readonly string[]): TxDryRunOptions {
  const seen = new Set<string>();
  let dryRun = false;
  let text: string | undefined;
  let stop = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (!["--dry-run", "--text", "--stop"].includes(flag) || seen.has(flag)) {
      throw new Error(`unknown or duplicate argument: ${flag}`);
    }
    seen.add(flag);
    if (flag === "--dry-run") {
      dryRun = true;
    } else if (flag === "--stop") {
      stop = true;
    } else {
      const value = argv[++index];
      if (value === undefined || value.startsWith("--") || value.trim() !== value || value.length === 0) {
        throw new Error("missing or invalid value for --text");
      }
      text = value;
    }
  }
  if (!dryRun) throw new Error("tx requires --dry-run; real transmission is not implemented");
  if (stop === (text !== undefined)) throw new Error("tx dry-run requires exactly one of --text or --stop");
  return stop ? { stop: true } : { text: text as string, stop: false };
}

/** Build a CI-V CW plan without opening a port or writing bytes. */
export function runTxDryRun(options: TxDryRunOptions): Json {
  const plan = options.stop ? planCivCwStop() : planCivCwMessage(options.text as string);
  return {
    source: "civ-tx-plan",
    dryRun: plan.dryRun,
    executable: plan.executable,
    kind: plan.kind,
    command: `0x${plan.command.toString(16).padStart(2, "0")}`,
    radioAddress: `0x${plan.radioAddress.toString(16).padStart(2, "0")}`,
    controllerAddress: `0x${plan.controllerAddress.toString(16).padStart(2, "0")}`,
    text: plan.text,
    payload: [...plan.payload],
    frameHex: civPlanHex(plan),
    note: "offline plan only; no serial port was opened and no transmission is possible",
  };
}

export function parseHistoryArgs(argv: readonly string[]): HistoryOptions {
  const seen = new Set<string>();
  let file = "";
  let tail = 100;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (!["--file", "--tail"].includes(flag) || seen.has(flag)) {
      throw new Error(`unknown or duplicate argument: ${flag}`);
    }
    seen.add(flag);
    const value = argv[++index];
    if (value === undefined || value.startsWith("--") || value.trim() !== value || value.length === 0) {
      throw new Error(`missing or invalid value for ${flag}`);
    }
    if (flag === "--file") file = value;
    else {
      if (!/^\d+$/.test(value)) throw new Error("invalid number for --tail");
      tail = Number(value);
    }
  }
  if (file.length === 0) throw new Error("history requires --file <path>");
  if (!Number.isInteger(tail) || tail < 1 || tail > 1000) throw new Error("tail must be 1..1000");
  return { file, tail };
}

export function parseMonitorArgs(argv: readonly string[]): import("./rig-monitor.js").MonitorOptions {
  let simulate = false;
  let intervalMs = 1000;
  let intervalSeen = false;
  const readArgs: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--simulate") {
      if (simulate) throw new Error("duplicate --simulate");
      simulate = true;
    } else if (arg === "--interval-ms") {
      const value = argv[++index];
      if (intervalSeen || value === undefined || !/^[0-9]+$/.test(value)) throw new Error("invalid or duplicate --interval-ms");
      intervalSeen = true;
      intervalMs = Number(value);
      if (!Number.isInteger(intervalMs) || intervalMs < 250 || intervalMs > 60000) throw new Error("interval must be 250..60000 ms");
    } else {
      readArgs.push(arg);
      if (["--port", "--baud", "--timeout-ms"].includes(arg)) {
        const value = argv[++index];
        if (value === undefined || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
        readArgs.push(value);
      }
    }
  }
  if (simulate && readArgs.length) throw new Error("--simulate cannot be combined with serial options");
  const endpointFlag = readArgs.indexOf("--endpoint");
  const options = simulate ? { port: "SIMULATOR", baud: 19200, timeoutMs: 2000 } : parseReadArgs(readArgs);
  if (!simulate && endpointFlag >= 0) {
    const endpoint = readArgs[endpointFlag + 1];
    if (endpoint === undefined) throw new Error("missing value for --endpoint");
    return { port: "rig-statusd", baud: 0, timeoutMs: 2000, serviceEndpoint: endpoint, simulate: false, intervalMs };
  }
  return { ...options, simulate, intervalMs };
}

export async function runSerialRead(options: ReadOptions, opener: SerialOpener = openSerialCivTransport): Promise<Json> {
  if (options.endpoint !== undefined) {
    const client = await RigStatusClient.connect(parseRigStatusEndpoint(options.endpoint), options.timeoutMs);
    try {
      const report = await client.request("status");
      return { ...report, endpoint: options.endpoint };
    } finally { client.close(); }
  }
  const abort = new AbortController();
  const interrupt = (): void => abort.abort();
  process.on("SIGINT", interrupt);
  let transport: SerialCivTransport | undefined;
  let client: CivReadOnlyClient | undefined;
  try {
    transport = await opener({ portPath: options.port, baudRate: options.baud,
      openTimeoutMs: options.timeoutMs, operationTimeoutMs: options.timeoutMs,
      closeTimeoutMs: options.timeoutMs, signal: abort.signal });
    if (abort.signal.aborted) throw new CivError("interrupted", "serial read interrupted");
    client = new CivReadOnlyClient({ transport, timeoutMs: options.timeoutMs });
    const frequencyHz = await client.readFrequency();
    const reading = await client.readMode();
    return { source: "serial", readOnly: true, port: options.port, baud: options.baud,
      frequencyHz, mode: reading.mode, filter: reading.filter };
  } finally {
    try {
      await client?.close();
      await transport?.close();
      if (transport?.closeError) throw transport.closeError;
      if (transport && !transport.isClosed) throw new CivError("serial_close", "port close could not be confirmed");
    } finally {
      process.off("SIGINT", interrupt);
    }
  }
}

export async function main(argv: readonly string[], opener: SerialOpener = openSerialCivTransport): Promise<number> {
  let readOptions: ReadOptions | undefined;
  try {
    if (argv[0] === "tx") {
      print({ ok: true, ...runTxDryRun(parseTxDryRunArgs(argv.slice(1))) });
      return 0;
    }
    if (argv[0] === "monitor") {
      const options = parseMonitorArgs(argv.slice(1));
      if (options.serviceEndpoint) {
        const { runServiceMonitor } = await import("./rig-service-monitor.js");
        return await runServiceMonitor({ endpoint: options.serviceEndpoint, timeoutMs: options.timeoutMs, intervalMs: options.intervalMs });
      }
      const { runMonitor } = await import("./rig-monitor.js");
      return await runMonitor(options);
    }
    if (argv[0] === "receive") {
      const { runReceive } = await import("./rig-receive.js");
      return await runReceive(argv.slice(1));
    }
    if (argv[0] === "status") {
      const endpointFlag = argv[1];
      const endpointValue = argv[2];
      if (endpointFlag !== "--endpoint" || endpointValue === undefined || argv.length !== 3) throw new Error("status requires exactly --endpoint <path>");
      const client = await RigStatusClient.connect(parseRigStatusEndpoint(endpointValue));
      try {
        print({ ok: true, ...(await client.request("status")) });
      } finally { client.close(); }
      return 0;
    }
    if (argv[0] === "history") {
      const options = parseHistoryArgs(argv.slice(1));
      print({ ok: true, file: options.file, records: await readRigStatusHistory(options.file, options.tail) });
      return 0;
    }
    if (argv[0] === "read") readOptions = parseReadArgs(argv.slice(1));
    else if (argv.length !== 1 || argv[0] !== "simulate") throw new Error("unsupported command");
  } catch (error) {
    print({
      ok: false,
      code: "usage",
      error: error instanceof Error ? error.message : String(error),
      usage: USAGE,
    });
    return 2;
  }
  try {
    print({ ok: true, ...(readOptions ? await runSerialRead(readOptions, opener) : await runSimulation()) });
    return 0;
  } catch (error) {
    print({
      ok: false,
      code: error instanceof CivError ? error.code : "internal",
      error: error instanceof Error ? error.message : String(error),
    });
    return 1;
  }
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return pathToFileURL(entry).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
      // A native operation may remain pending after a reported cleanup timeout.
      // Bound the standalone CLI lifetime; OS process teardown releases its handles.
      if (["read", "monitor", "receive"].includes(process.argv[2] ?? "")) process.stdout.write("", () => process.exit(code));
    })
    .catch((error: unknown) => {
      print({ ok: false, code: "internal", error: error instanceof Error ? error.message : String(error) });
      process.exitCode = 1;
    });
}
