// cwctl：纯 JSON 输出的本地 CLI。
// 只通过 daemon 的 Unix socket 操作；不直接打开数据库，也绝不自动批准。
// demo 是显式标记的仅 Fake 端到端演示，默认 transmit 仍需先 approve。

import {
  PROTOCOL_VERSION,
  RESOLUTION_NOTE_MAX_LENGTH,
  RESOLUTION_OPERATOR_MAX_LENGTH,
  type RpcErrorCode,
} from "../packages/contracts/src/index.js";
import { DaemonClient, DaemonUnavailableError, RpcError } from "../packages/daemon/src/client.js";
import { canonicalEndpoint, endpointAddress, EndpointError } from "../packages/daemon/src/endpoint.js";
import { ConfigError, loadConfigFile, resolveEndpoint } from "../packages/daemon/src/config.js";

type Json = Record<string, unknown>;

class UsageError extends Error {}

const EXIT_CODES: Record<string, number> = {
  usage: 2,
  invalid_request: 2,
  invalid_params: 2,
  not_found: 3,
  conflict: 4,
  busy: 4,
  expired: 4,
  blocked: 4,
  unauthorized: 4,
  unavailable: 5,
  protocol_version: 6,
  request_timeout: 7,
  internal: 1,
};

function print(value: Json): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function parseGlobal(argv: string[]): { socketPath?: string; configPath?: string; rest: string[] } {
  let socketPath: string | undefined;
  let configPath: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--socket" || arg === "--config") {
      const value = argv[i + 1];
      if (value === undefined || value.length === 0) throw new UsageError(`missing value for ${arg}`);
      if (arg === "--socket") socketPath = value;
      else configPath = value;
      i += 1;
    } else if (arg?.startsWith("--socket=")) {
      socketPath = arg.slice("--socket=".length);
      if (socketPath.length === 0) throw new UsageError("missing value for --socket");
    } else if (arg?.startsWith("--config=")) {
      configPath = arg.slice("--config=".length);
      if (configPath.length === 0) throw new UsageError("missing value for --config");
    } else if (arg !== undefined) {
      rest.push(arg);
    }
  }
  return { ...(socketPath !== undefined ? { socketPath } : {}), ...(configPath !== undefined ? { configPath } : {}), rest };
}

interface ParsedOptions {
  positionals: string[];
  flags: Map<string, string | boolean>;
}

function parseFlags(args: string[], valueFlags: Set<string>): ParsedOptions {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (valueFlags.has(name)) {
        const value = args[i + 1];
        if (value === undefined) throw new UsageError(`missing value for --${name}`);
        flags.set(name, value);
        i += 1;
      } else {
        flags.set(name, true);
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

function numberFlag(flags: Map<string, string | boolean>, name: string): number | undefined {
  const raw = flags.get(name);
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") throw new UsageError(`--${name} requires a value`);
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new UsageError(`--${name} must be a number`);
  return value;
}

interface ResolveUnknownArgs {
  proposalId: string;
  operator: string;
  note: string;
  confirmStopped: true;
}

/**
 * resolve-unknown 的严格旗标解析：
 *  - 只接受一个 proposalId 位置参数，多余位置参数一律报错；
 *  - 仅允许 --operator/--note/--confirm-stopped，任何未知旗标报错；
 *  - --operator/--note 必须带非空值且不超过上限；
 *  - --confirm-stopped 必须是裸旗标（不接受 =true/false 之类写法）。
 */
function parseResolveArgs(args: string[]): ResolveUnknownArgs {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  let confirmStopped = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg.startsWith("--")) {
      if (arg === "--operator" || arg === "--note") {
        const value = args[i + 1];
        if (value === undefined || value.startsWith("--")) {
          throw new UsageError(`missing value for ${arg}`);
        }
        values.set(arg, value);
        i += 1;
      } else if (arg === "--confirm-stopped") {
        confirmStopped = true;
      } else {
        throw new UsageError(`unknown flag for resolve-unknown: ${arg}`);
      }
    } else {
      positionals.push(arg);
    }
  }

  if (positionals.length === 0) throw new UsageError("resolve-unknown requires a proposal id");
  if (positionals.length > 1) {
    throw new UsageError(`unexpected extra arguments: ${positionals.slice(1).join(" ")}`);
  }
  const operator = values.get("--operator");
  if (operator === undefined || operator.trim().length === 0) {
    throw new UsageError("--operator is required and must be non-empty");
  }
  if (operator.length > RESOLUTION_OPERATOR_MAX_LENGTH) {
    throw new UsageError(`--operator exceeds ${RESOLUTION_OPERATOR_MAX_LENGTH} characters`);
  }
  const note = values.get("--note");
  if (note === undefined || note.trim().length === 0) {
    throw new UsageError("--note is required and must be non-empty");
  }
  if (note.length > RESOLUTION_NOTE_MAX_LENGTH) {
    throw new UsageError(`--note exceeds ${RESOLUTION_NOTE_MAX_LENGTH} characters`);
  }
  if (!confirmStopped) throw new UsageError("--confirm-stopped is required");
  return { proposalId: positionals[0] as string, operator, note, confirmStopped: true };
}

async function withClient(socketPath: string, fn: (client: DaemonClient) => Promise<Json>): Promise<Json> {
  const client = await DaemonClient.connect(socketPath);
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

async function run(): Promise<number> {
  const parsed = parseGlobal(process.argv.slice(2));
  // cwctl 只使用 socket 路径，但仍完整校验配置文件（因此不要求 daemon 在运行）。
  const config = parsed.configPath !== undefined ? loadConfigFile(parsed.configPath) : undefined;
  const socketPath = endpointAddress(canonicalEndpoint(resolveEndpoint(config, parsed.socketPath)));
  const rest = parsed.rest;
  const command = rest[0];
  const args = rest.slice(1);

  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    print({
      ok: true,
      usage: [
        "cwctl [--config <file>] [--socket <path>] status",
        "cwctl [--config <file>] [--socket <path>] propose <text> [--ttl <ms>] [--freq <hz>] [--mode CW]",
        "cwctl [--config <file>] [--socket <path>] approve <proposalId>",
        "cwctl [--config <file>] [--socket <path>] transmit <proposalId>",
        "cwctl [--config <file>] [--socket <path>] abort",
        "cwctl [--config <file>] [--socket <path>] audit [limit]",
        "cwctl [--config <file>] [--socket <path>] proposals [limit]",
        "cwctl [--config <file>] [--socket <path>] executions [limit]",
        "cwctl [--config <file>] [--socket <path>] unresolved",
        "cwctl [--config <file>] [--socket <path>] resolve-unknown <proposalId> --operator <name> --note <reason> --confirm-stopped",
        "cwctl [--config <file>] [--socket <path>] doctor",
        "cwctl [--config <file>] [--socket <path>] stop  # request graceful shutdown; accepted does not mean exited",
        "cwctl [--config <file>] [--socket <path>] demo [text]  # FAKE-ONLY, explicitly not a real transmission",
      ],
      protocolVersion: PROTOCOL_VERSION,
      securityNote: "CLI requests do not prove human approval. Unix uses socket mode 0600; Windows pipe access must be verified separately with doctor and the ACL probe.",
    });
    return 0;
  }

  switch (command) {
    case "status":
      return report(command, await withClient(socketPath, (client) => client.request("status") as Promise<Json>));

    case "doctor":
      return report(command, await withClient(socketPath, (client) => client.request("doctor") as Promise<Json>));

    case "propose": {
      const { positionals, flags } = parseFlags(args, new Set(["ttl", "freq", "mode"]));
      const text = positionals.join(" ").trim();
      if (text.length === 0) throw new UsageError("propose requires message text");
      const params: Json = { text };
      const ttl = numberFlag(flags, "ttl");
      const freq = numberFlag(flags, "freq");
      const mode = flags.get("mode");
      if (ttl !== undefined) params.ttlMs = ttl;
      if (freq !== undefined) params.frequencyHz = freq;
      if (typeof mode === "string") params.mode = mode;
      const result = await withClient(socketPath, (client) => client.request("propose", params) as Promise<Json>);
      return report(command, result);
    }

    case "approve": {
      const id = args[0];
      if (!id) throw new UsageError("approve requires a proposal id");
      const result = await withClient(socketPath, (client) => client.request("approve", { id }) as Promise<Json>);
      return report(command, result);
    }

    case "transmit": {
      const id = args[0];
      if (!id) throw new UsageError("transmit requires a proposal id");
      const result = await withClient(socketPath, (client) => client.request("transmit", { id }) as Promise<Json>);
      return report(command, result);
    }

    case "abort":
      return report(command, await withClient(socketPath, (client) => client.request("abort") as Promise<Json>));

    case "stop": {
      // 严格空参数：stop 不接受任何位置参数或旗标。
      if (args.length > 0) throw new UsageError(`stop takes no arguments: ${args.join(" ")}`);
      return report(command, await withClient(socketPath, (client) => client.request("daemon.stop", {}) as Promise<Json>));
    }

    case "audit":
    case "proposals":
    case "executions": {
      const limit = args[0] !== undefined ? Number(args[0]) : undefined;
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
        throw new UsageError(`${command} limit must be a positive integer`);
      }
      const params: Json = limit !== undefined ? { limit } : {};
      return report(command, await withClient(socketPath, (client) => client.request(command, params) as Promise<Json>));
    }

    case "unresolved": {
      if (args.length > 0) throw new UsageError("unresolved takes no arguments");
      return report(command, await withClient(socketPath, (client) => client.request("unresolved") as Promise<Json>));
    }

    case "resolve-unknown": {
      const parsed = parseResolveArgs(args);
      const result = await withClient(
        socketPath,
        (client) =>
          client.request("resolve-unknown", {
            proposalId: parsed.proposalId,
            operator: parsed.operator,
            note: parsed.note,
            confirmStopped: parsed.confirmStopped,
          }) as Promise<Json>,
      );
      return report(command, result);
    }

    case "demo": {
      // 显式 Fake-only 的端到端演示；不是默认发射路径。
      const text = args.join(" ").trim() || "CQ TEST DE BD7XXX";
      const result = await withClient(socketPath, async (client) => {
        const proposal = (await client.request("propose", { text })) as Json;
        const id = proposal.id as string;
        const approval = (await client.request("approve", { id })) as Json;
        const execution = (await client.request("transmit", { id })) as Json;
        return { fakeOnly: true, warning: "FAKE-ONLY demo; no real radio was keyed", proposal, approval, execution };
      });
      return report(command, result);
    }

    default:
      throw new UsageError(`unknown command: ${command}`);
  }
}

function report(method: string, result: unknown): number {
  print({ ok: true, method, result });
  return 0;
}

run()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof UsageError) {
      print({ ok: false, code: "usage", error: error.message });
      process.exitCode = EXIT_CODES.usage ?? 2;
      return;
    }
    if (error instanceof ConfigError) {
      print({ ok: false, code: error.code, error: error.message });
      process.exitCode = EXIT_CODES.usage ?? 2;
      return;
    }
    if (error instanceof EndpointError) {
      print({ ok: false, code: error.code, error: error.message });
      process.exitCode = EXIT_CODES.usage ?? 2;
      return;
    }
    if (error instanceof RpcError) {
      print({ ok: false, code: error.code, error: error.message });
      process.exitCode = EXIT_CODES[error.code as RpcErrorCode] ?? 1;
      return;
    }
    if (error instanceof DaemonUnavailableError) {
      print({ ok: false, code: "unavailable", error: error.message });
      process.exitCode = EXIT_CODES.unavailable ?? 5;
      return;
    }
    print({ ok: false, code: "internal", error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  });
