// cwai：只读 AI 台站状态建议 CLI（JSON 输出，确定性错误码）。
//
// validate-config --config <file>
//     严格校验 version1 配置；不联网、不要求凭据、不读取任何状态或秘密。
// explain --config <file> --state <file>
//     读取经过校验的状态快照，按 provider 生成建议文本；disabled/mock 不联网，
//     chat-completions 只向配置端点 POST 状态快照。
//
// 本入口不连接 daemon、不读数据库，也不调用 approve/transmit/resolve/shell/串口。
//
// 退出码：0 成功；1 内部错误；2 用法错误；3 文件不存在；4 配置/状态校验失败；5 后端或网络失败。

import {
  ASSISTANT_CONFIG_VERSION,
  AssistantError,
  explainState,
  loadAssistantConfig,
  loadStationState,
  type AssistantConfig,
} from "../packages/assistant/src/index.js";

type Json = Record<string, unknown>;

class UsageError extends Error {}

const EXIT = {
  ok: 0,
  internal: 1,
  usage: 2,
  notFound: 3,
  invalid: 4,
  backend: 5,
} as const;

function print(value: Json): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function parseFlags(args: string[], allowed: ReadonlySet<string>): { flags: Map<string, string>; positionals: string[] } {
  const flags = new Map<string, string>();
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
      if (!allowed.has(name)) throw new UsageError(`unknown flag: --${name}`);
      let value: string | undefined;
      if (eq >= 0) {
        value = arg.slice(eq + 1);
      } else {
        value = args[i + 1];
        i += 1;
      }
      if (value === undefined || value.length === 0 || (eq < 0 && value.startsWith("--"))) {
        throw new UsageError(`missing value for --${name}`);
      }
      if (flags.has(name)) throw new UsageError(`duplicate flag: --${name}`);
      flags.set(name, value);
    } else {
      positionals.push(arg);
    }
  }
  return { flags, positionals };
}

function requiredValue(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (value === undefined) throw new UsageError(`missing required --${name}`);
  return value;
}

function configSummary(config: AssistantConfig): Json {
  return {
    version: config.version,
    provider: config.provider,
    endpoint: config.endpoint,
    model: config.model,
    apiKeyEnv: config.apiKeyEnv,
    timeoutMs: config.timeoutMs,
    maxOutputTokens: config.maxOutputTokens,
    networkRequired: config.provider === "chat-completions",
    requiresApiKey: config.provider === "chat-completions" && config.apiKeyEnv !== null,
    advisoryOnly: true,
  };
}

function runValidateConfig(args: string[]): number {
  const { flags, positionals } = parseFlags(args, new Set(["config"]));
  if (positionals.length > 0) throw new UsageError(`unexpected positional arguments: ${positionals.join(" ")}`);
  const configPath = requiredValue(flags, "config");
  const config = loadAssistantConfig(configPath);
  print({ ok: true, method: "validate-config", result: configSummary(config) });
  return EXIT.ok;
}

async function runExplain(args: string[]): Promise<number> {
  const { flags, positionals } = parseFlags(args, new Set(["config", "state"]));
  if (positionals.length > 0) throw new UsageError(`unexpected positional arguments: ${positionals.join(" ")}`);
  const configPath = requiredValue(flags, "config");
  const statePath = requiredValue(flags, "state");
  const config = loadAssistantConfig(configPath);
  const state = loadStationState(statePath);
  const advisory = await explainState(state, config);
  // 输出字段固定：只有建议文本、provider/model 与 advisoryOnly，不含任何执行命令。
  print({
    ok: true,
    method: "explain",
    result: {
      advisory: advisory.advisory,
      provider: advisory.provider,
      model: advisory.model,
      advisoryOnly: advisory.advisoryOnly,
    },
  });
  return EXIT.ok;
}

function usage(): number {
  print({
    ok: true,
    usage: [
      "cwai validate-config --config <file>",
      "cwai explain --config <file> --state <file>",
    ],
    configVersion: ASSISTANT_CONFIG_VERSION,
    note: "read-only advisory only; never transmits, never connects to the daemon, never reads credentials during validate-config.",
  });
  return EXIT.ok;
}

async function run(argv: string[]): Promise<number> {
  const command = argv[0];
  const args = argv.slice(1);
  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return usage();
    case "validate-config":
      return runValidateConfig(args);
    case "explain":
      return runExplain(args);
    default:
      throw new UsageError(`unknown command: ${command}`);
  }
}

function exitCodeFor(error: AssistantError): number {
  switch (error.code) {
    case "config_not_found":
    case "state_not_found":
      return EXIT.notFound;
    case "invalid_config":
    case "unknown_config_field":
    case "config_too_large":
    case "invalid_state":
    case "unknown_state_field":
    case "state_too_large":
    case "invalid_endpoint":
    case "insecure_endpoint":
      return EXIT.invalid;
    case "credential_missing":
    case "network_error":
    case "timeout":
    case "redirect_rejected":
    case "http_error":
    case "response_too_large":
    case "response_invalid":
    case "empty_output":
    case "output_too_large":
      return EXIT.backend;
    default:
      return EXIT.internal;
  }
}

try {
  process.exitCode = await run(process.argv.slice(2));
} catch (error) {
  if (error instanceof UsageError) {
    print({ ok: false, code: "usage", error: error.message });
    process.exitCode = EXIT.usage;
  } else if (error instanceof AssistantError) {
    print({ ok: false, code: error.code, error: error.message });
    process.exitCode = exitCodeFor(error);
  } else {
    print({ ok: false, code: "internal", error: "assistant operation failed" });
    process.exitCode = EXIT.internal;
  }
}
