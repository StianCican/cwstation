// P2-002a rig-faked：受监督的 Fake 设备服务进程入口。
//
// 只使用私有 stdin/stdout 通道：stdout 仅协议 NDJSON 帧，stderr 仅不含会话
// 密钥的诊断。hello 私有帧不进入日志。stdin EOF 触发本地禁发、在途置
// unknown、账本刷盘和有界退出。它不打开串口、不读数据库、不接入 daemon。

import { pathToFileURL } from "node:url";
import { FakeRigService } from "../packages/rig-control/src/fake-service.js";
import {
  RIG_CONTROL_MAX_FRAME_BYTES,
  RIG_CONTROL_MAX_PENDING_REQUESTS,
  RIG_CONTROL_PROTOCOL_VERSION,
  extractRequestId,
  isRigControlControlMethod,
  type RigControlErrorCode,
  type RigControlResponse,
} from "../packages/rig-control/src/protocol.js";

export const RIG_FAKED_USAGE =
  "rig-faked --ledger <dir> --device-id <id> [--frequency-hz N] [--civ-address N] " +
  "[--test-delay-ms N] [--test-hang-send] [--test-stop-evidence stopped|none]";

export interface RigFakedOptions {
  readonly ledgerDir: string;
  readonly deviceInstanceId: string;
  readonly frequencyHz: number | undefined;
  readonly civAddress: number | undefined;
  readonly testDelayMs: number | undefined;
  readonly testHangSend: boolean;
  readonly testLedgerWriteFailure: boolean;
  readonly testStopEvidence: "stopped" | "none" | undefined;
}

function requiredValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("--") || value.length === 0 || value.trim() !== value) {
    throw new Error(`missing or invalid value for ${flag}`);
  }
  return value;
}

function parseInteger(value: string, flag: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`invalid number for ${flag}`);
  return Number(value);
}

export function parseRigFakedArgs(argv: readonly string[]): RigFakedOptions {
  const seen = new Set<string>();
  let ledgerDir = "";
  let deviceInstanceId = "";
  let frequencyHz: number | undefined;
  let civAddress: number | undefined;
  let testDelayMs: number | undefined;
  let testHangSend = false;
  let testLedgerWriteFailure = false;
  let testStopEvidence: "stopped" | "none" | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag === "--test-ledger-write-failure") {
      if (testLedgerWriteFailure) throw new Error("duplicate --test-ledger-write-failure");
      testLedgerWriteFailure = true;
      continue;
    }
    if (flag === "--test-hang-send") {
      if (testHangSend) throw new Error("duplicate --test-hang-send");
      testHangSend = true;
      continue;
    }
    const allowed = [
      "--ledger",
      "--device-id",
      "--frequency-hz",
      "--civ-address",
      "--test-delay-ms",
      "--test-stop-evidence",
    ];
    if (!allowed.includes(flag) || seen.has(flag)) {
      throw new Error(`unknown or duplicate argument: ${flag}`);
    }
    seen.add(flag);
    const value = requiredValue(argv, index + 1, flag);
    index += 1;
    if (flag === "--ledger") ledgerDir = value;
    else if (flag === "--device-id") deviceInstanceId = value;
    else if (flag === "--frequency-hz") frequencyHz = parseInteger(value, flag);
    else if (flag === "--civ-address") civAddress = parseInteger(value, flag);
    else if (flag === "--test-delay-ms") testDelayMs = parseInteger(value, flag);
    else if (flag === "--test-stop-evidence") {
      if (value !== "stopped" && value !== "none") {
        throw new Error("--test-stop-evidence must be stopped or none");
      }
      testStopEvidence = value;
    }
  }

  if (ledgerDir.length === 0) throw new Error("--ledger is required");
  if (deviceInstanceId.length === 0) throw new Error("--device-id is required");
  return { ledgerDir, deviceInstanceId, frequencyHz, civAddress, testDelayMs, testHangSend, testStopEvidence, testLedgerWriteFailure };
}

function extractMethod(parsed: unknown): string | null {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const method = (parsed as Record<string, unknown>).method;
  return typeof method === "string" ? method : null;
}

function errorResponse(id: string | null, code: RigControlErrorCode, message: string): RigControlResponse {
  return { protocolVersion: RIG_CONTROL_PROTOCOL_VERSION, id, ok: false, error: { code, message } };
}

export async function main(argv: readonly string[]): Promise<number> {
  let options: RigFakedOptions;
  try {
    options = parseRigFakedArgs(argv);
  } catch (error) {
    process.stderr.write(`rig-faked: ${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write(`usage: ${RIG_FAKED_USAGE}\n`);
    return 2;
  }

  let service: FakeRigService;
  try {
    service = new FakeRigService({
      ledgerDir: options.ledgerDir,
      deviceInstanceId: options.deviceInstanceId,
      ...(options.frequencyHz === undefined ? {} : { frequencyHz: options.frequencyHz }),
      ...(options.civAddress === undefined ? {} : { civAddress: options.civAddress }),
      ...(options.testDelayMs === undefined ? {} : { testDelayMs: options.testDelayMs }),
      ...(options.testHangSend ? { testHangSend: true } : {}),
      ...(options.testLedgerWriteFailure ? { testLedgerWriteFailure: true } : {}),
      ...(options.testStopEvidence === undefined ? {} : { testStopEvidence: options.testStopEvidence }),
    });
  } catch (error) {
    process.stderr.write(`rig-faked: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  let pending = 0;
  let controls = 0;
  let shuttingDown = false;
  let buffer = Buffer.alloc(0);
  let finish: () => void = () => undefined;
  const done = new Promise<void>((resolveDone) => {
    finish = resolveDone;
  });

  const writeResponse = (response: RigControlResponse): void => {
    if (shuttingDown) return;
    if (process.stdout.writableLength > 64 * 1024) { void shutdown(1); return; }
    if (!process.stdout.write(`${JSON.stringify(response)}\n`)) process.stdin.pause();
  };

  const shutdown = async (code: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    buffer = Buffer.alloc(0);
    process.stdin.pause();
    service.onChannelLost();
    service.close();
    const deadline = setTimeout(() => process.exit(code), 1_000);
    await new Promise<void>((resolveFlush) => {
      process.stdout.write("", () => resolveFlush());
    });
    clearTimeout(deadline);
    finish();
    process.exit(code);
  };

  const rejectFrame = (message: string): void => {
    if (shuttingDown) return;
    writeResponse(errorResponse(null, "invalid_request", message));
    void shutdown(1);
  };

  const dispatchLine = (text: string): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      writeResponse(errorResponse(null, "invalid_request", "malformed JSON frame"));
      return;
    }
    const method = extractMethod(parsed);
    const control = method !== null && isRigControlControlMethod(method);
    if ((control && controls >= 1) || (!control && pending >= RIG_CONTROL_MAX_PENDING_REQUESTS)) {
      writeResponse(errorResponse(extractRequestId(parsed), "busy", "too many pending requests"));
      return;
    }
    if (control) controls += 1;
    else pending += 1;
    void service
      .handleRequest(parsed)
      .then((response) => writeResponse(response))
      .catch(() => writeResponse(errorResponse(extractRequestId(parsed), "internal", "internal error")))
      .finally(() => {
        if (control) controls -= 1;
        else pending -= 1;
      });
  };

  process.stdin.on("data", (chunk: Buffer) => {
    if (shuttingDown) return;
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > RIG_CONTROL_MAX_FRAME_BYTES && buffer.indexOf(0x0a) === -1) {
      rejectFrame(`frame exceeds ${RIG_CONTROL_MAX_FRAME_BYTES} bytes`);
      return;
    }
    for (;;) {
      const newline = buffer.indexOf(0x0a);
      if (newline === -1) break;
      const lineBytes = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      if (lineBytes.length > RIG_CONTROL_MAX_FRAME_BYTES) {
        rejectFrame(`frame exceeds ${RIG_CONTROL_MAX_FRAME_BYTES} bytes`);
        return;
      }
      const text = lineBytes.toString("utf8").trim();
      if (text.length === 0) continue;
      dispatchLine(text);
    }
    if (buffer.length > RIG_CONTROL_MAX_FRAME_BYTES) rejectFrame(`frame exceeds ${RIG_CONTROL_MAX_FRAME_BYTES} bytes`);
  });
  process.stdout.on("drain", () => { if (!shuttingDown) process.stdin.resume(); });
  process.stdout.on("error", () => void shutdown(1));
  process.stdin.on("end", () => void shutdown(0));
  process.stdin.on("error", () => void shutdown(1));

  const onSignal = (): void => void shutdown(0);
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  process.stderr.write(
    `rig-faked: listening device=${options.deviceInstanceId} service=${service.serviceInstanceId} ` +
      `pid=${process.pid} ledger=${options.ledgerDir}\n`,
  );
  await done;
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  return 0;
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
    })
    .catch((error: unknown) => {
      process.stderr.write(`rig-faked: internal error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
