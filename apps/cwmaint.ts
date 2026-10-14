// cwmaint：离线维护 CLI（纯 JSON 输出、明确退出码）。
//
// 命令：
//   backup --db <path> --out <new-directory>
//   inspect --bundle <dir>
//   restore --bundle <dir> --db <new-path>
//   clear-storage-fault --db <path> --operator <name> --note <reason> --confirm-stopped
//
// 所有命令都可用 `--config <file>` 提供 dbPath 默认值；--db 显式覆盖配置。
// 严格拒绝未知/重复/缺失旗标与多余位置参数；不会自动启动或停止 daemon。
//
// 退出码：0 成功；1 内部错误；2 用法/参数错误；3 文件不存在；4 冲突或校验失败。

import { ConfigError, loadConfigFile, resolveDbPath, type StationConfig } from "../packages/daemon/src/config.js";
import {
  MaintenanceError,
  backupDatabase,
  clearStorageFault,
  inspectBundle,
  restoreBundle,
} from "../packages/maintenance/src/index.js";

type Json = Record<string, unknown>;

class UsageError extends Error {}

const EXIT = {
  ok: 0,
  internal: 1,
  usage: 2,
  notFound: 3,
  conflict: 4,
} as const;

function print(value: Json): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

interface ParsedFlags {
  values: Map<string, string>;
  bare: Set<string>;
}

function parseFlags(args: string[], valueFlags: readonly string[], bareFlags: readonly string[]): ParsedFlags {
  const values = new Map<string, string>();
  const bare = new Set<string>();
  const valueSet = new Set(valueFlags);
  const bareSet = new Set(bareFlags);

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (!arg.startsWith("--")) {
      throw new UsageError(`unexpected positional argument: ${arg}`);
    }
    const eq = arg.indexOf("=");
    const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);

    if (bareSet.has(name)) {
      if (eq >= 0) throw new UsageError(`--${name} is a bare flag and takes no value`);
      if (bare.has(name)) throw new UsageError(`duplicate flag: --${name}`);
      bare.add(name);
      continue;
    }
    if (valueSet.has(name)) {
      let value: string;
      if (eq >= 0) {
        value = arg.slice(eq + 1);
      } else {
        const next = args[i + 1];
        if (next === undefined || next.startsWith("--")) throw new UsageError(`missing value for --${name}`);
        value = next;
        i += 1;
      }
      if (value.length === 0) throw new UsageError(`missing value for --${name}`);
      if (values.has(name)) throw new UsageError(`duplicate flag: --${name}`);
      values.set(name, value);
      continue;
    }
    throw new UsageError(`unknown flag: --${name}`);
  }
  return { values, bare };
}

function requiredValue(flags: ParsedFlags, name: string): string {
  const value = flags.values.get(name);
  if (value === undefined) throw new UsageError(`missing required --${name}`);
  return value;
}

/** --db 优先，其次 --config 的 dbPath；维护命令绝不回退到隐式默认数据库。 */
function resolveDb(flags: ParsedFlags, config: StationConfig | undefined): string {
  const cli = flags.values.get("db");
  if (cli !== undefined || config?.dbPath) return resolveDbPath(config, cli);
  throw new UsageError("--db is required (or provide dbPath via --config)");
}

async function run(argv: string[]): Promise<number> {
  const globalFlags: string[] = [];
  while (argv[0] === "--config" || argv[0]?.startsWith("--config=")) {
    const flag = argv[0]!;
    if (flag === "--config") {
      if (!argv[1] || argv[1].startsWith("--")) throw new UsageError("missing value for --config");
      globalFlags.push(flag, argv[1]);
      argv = argv.slice(2);
    } else {
      globalFlags.push(flag);
      argv = argv.slice(1);
    }
  }
  const command = argv[0];
  const rest = [...argv.slice(1), ...globalFlags];

  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    print({
      ok: true,
      usage: [
        "cwmaint [--config <file>] backup --db <path> --out <new-directory>",
        "cwmaint inspect --bundle <dir>",
        "cwmaint [--config <file>] restore --bundle <dir> --db <new-path>",
        "cwmaint [--config <file>] clear-storage-fault --db <path> --operator <name> --note <reason> --confirm-stopped",
      ],
      note: "Maintenance never auto-starts or auto-stops the daemon; a held database lock makes it refuse.",
    });
    return EXIT.ok;
  }

  switch (command) {
    case "backup": {
      const flags = parseFlags(rest, ["db", "out", "config"], []);
      const config = loadOptionalConfig(flags);
      const result = backupDatabase(resolveDb(flags, config), requiredValue(flags, "out"));
      print({ ok: true, method: "backup", result });
      return EXIT.ok;
    }
    case "inspect": {
      const flags = parseFlags(rest, ["bundle", "config"], []);
      loadOptionalConfig(flags);
      const result = inspectBundle(requiredValue(flags, "bundle"));
      print({ ok: true, method: "inspect", result });
      return EXIT.ok;
    }
    case "restore": {
      const flags = parseFlags(rest, ["bundle", "db", "config"], []);
      const config = loadOptionalConfig(flags);
      const result = restoreBundle(requiredValue(flags, "bundle"), resolveDb(flags, config));
      print({ ok: true, method: "restore", result });
      return EXIT.ok;
    }
    case "clear-storage-fault": {
      const flags = parseFlags(rest, ["db", "operator", "note", "config"], ["confirm-stopped"]);
      const config = loadOptionalConfig(flags);
      if (!flags.bare.has("confirm-stopped")) throw new UsageError("--confirm-stopped is required");
      const result = clearStorageFault(
        resolveDb(flags, config),
        requiredValue(flags, "operator"),
        requiredValue(flags, "note"),
        true,
      );
      print({ ok: true, method: "clear-storage-fault", result });
      return EXIT.ok;
    }
    default:
      throw new UsageError(`unknown command: ${command}`);
  }
}

function loadOptionalConfig(flags: ParsedFlags): StationConfig | undefined {
  const configPath = flags.values.get("config");
  return configPath === undefined ? undefined : loadConfigFile(configPath);
}

function exitCodeFor(error: MaintenanceError): number {
  switch (error.code) {
    case "usage":
      return EXIT.usage;
    case "not_found":
      return EXIT.notFound;
    case "internal":
      return EXIT.internal;
    default:
      return EXIT.conflict;
  }
}

run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof UsageError) {
      print({ ok: false, code: "usage", error: error.message });
      process.exitCode = EXIT.usage;
      return;
    }
    if (error instanceof ConfigError) {
      print({ ok: false, code: error.code, error: error.message });
      process.exitCode = EXIT.usage;
      return;
    }
    if (error instanceof MaintenanceError) {
      print({ ok: false, code: error.code, error: error.message });
      process.exitCode = exitCodeFor(error);
      return;
    }
    print({ ok: false, code: "internal", error: error instanceof Error ? error.message : String(error) });
    process.exitCode = EXIT.internal;
  });
