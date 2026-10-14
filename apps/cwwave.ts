// cwwave：CW 合成任务/结果 CLI（纯 JSON 输出，明确退出码）。
//
// prepare：把文本 + 参数写成版本化任务 JSON；不发射、不自动启动 Julia，
//          任务文件用 O_EXCL 独占写入，绝不覆盖已有数据。
// verify ：校验 task + result + WAV 的 SHA256、结构、格式与音频内容。
//
// 退出码：0 成功；1 内部错误；2 用法/参数错误；3 文件不存在；4 校验失败/冲突。

import { writeFileSync } from "node:fs";
import path from "node:path";
import {
  CW_ALGORITHM_VERSION,
  CW_DEFAULT_RAMP_MS,
  CW_LIMITS,
  CW_TASK_CONTRACT_VERSION,
  CwContractError,
  buildTimeline,
  encodeCwText,
  normalizeCwText,
  sha256Hex,
  validateCwTask,
  verifyTaskResult,
  type CwTask,
} from "../packages/signal/src/index.js";

type Json = Record<string, unknown>;

class UsageError extends Error {}

const EXIT = {
  ok: 0,
  internal: 1,
  usage: 2,
  notFound: 3,
  verify: 4,
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

function integerFlag(flags: Map<string, string>, name: string, fallback: number): number {
  const raw = flags.get(name);
  if (raw === undefined) return fallback;
  if (!/^-?\d+$/.test(raw)) throw new UsageError(`--${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new UsageError(`--${name} is out of the safe integer range`);
  return value;
}

function numberFlag(flags: Map<string, string>, name: string, fallback: number): number {
  const raw = flags.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new UsageError(`--${name} must be a number`);
  return value;
}

function requiredValue(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (value === undefined) throw new UsageError(`missing required --${name}`);
  return value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function buildTaskFromFlags(flags: Map<string, string>): CwTask {
  const text = requiredValue(flags, "text");
  const wpm = integerFlag(flags, "wpm", 20);
  const toneHz = numberFlag(flags, "tone", 600);
  const sampleRateHz = integerFlag(flags, "sample-rate", 8000);
  const seed = integerFlag(flags, "seed", 42);
  const rampMs = integerFlag(flags, "ramp-ms", CW_DEFAULT_RAMP_MS);

  let snrDb: number | null;
  const rawSnr = flags.get("snr");
  if (rawSnr === undefined) {
    snrDb = 10;
  } else if (rawSnr === "clean" || rawSnr === "none" || rawSnr === "null") {
    snrDb = null;
  } else {
    const parsed = Number(rawSnr);
    if (!Number.isFinite(parsed)) throw new UsageError("--snr must be a number or one of clean|none|null");
    snrDb = parsed;
  }

  const normalizedText = normalizeCwText(text);
  const morseWords = encodeCwText(normalizedText);
  return validateCwTask({
    contractVersion: CW_TASK_CONTRACT_VERSION,
    algorithmVersion: CW_ALGORITHM_VERSION,
    text,
    normalizedText,
    morseWords,
    wpm,
    toneHz,
    sampleRateHz,
    snrDb,
    seed,
    rampMs,
  });
}

function runPrepare(args: string[]): number {
  const { flags, positionals } = parseFlags(
    args,
    new Set(["text", "out", "wpm", "tone", "sample-rate", "snr", "seed", "ramp-ms"]),
  );
  if (positionals.length > 0) throw new UsageError(`unexpected positional arguments: ${positionals.join(" ")}`);
  const task = buildTaskFromFlags(flags);
  const outPath = requiredValue(flags, "out");
  const timeline = buildTimeline(task.morseWords, task.sampleRateHz, task.wpm);

  const serialized = `${JSON.stringify(task, null, 2)}\n`;
  const data = Buffer.from(serialized, "utf8");
  const taskSha256 = sha256Hex(data);
  try {
    writeFileSync(outPath, data, { flag: "wx" });
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new CwContractError("output_exists", `refusing to overwrite existing file: ${outPath}`);
    }
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new CwContractError("output_parent_missing", `output directory does not exist: ${path.dirname(outPath)}`);
    }
    throw error;
  }

  print({
    ok: true,
    method: "prepare",
    result: {
      taskPath: outPath,
      taskSha256,
      contractVersion: task.contractVersion,
      algorithmVersion: task.algorithmVersion,
      normalizedText: task.normalizedText,
      morseWords: task.morseWords,
      wpm: task.wpm,
      toneHz: task.toneHz,
      sampleRateHz: task.sampleRateHz,
      snrDb: task.snrDb,
      seed: task.seed,
      rampMs: task.rampMs,
      exactDurationSeconds: timeline.exactDurationSeconds,
      sampleCount: timeline.sampleCount,
      durationQuantizationErrorSeconds: timeline.durationQuantizationErrorSeconds,
      transmits: false,
    },
  });
  return EXIT.ok;
}

function runVerify(args: string[]): number {
  const { flags, positionals } = parseFlags(args, new Set(["task", "result"]));
  if (positionals.length > 0) throw new UsageError(`unexpected positional arguments: ${positionals.join(" ")}`);
  const taskPath = requiredValue(flags, "task");
  const resultPath = requiredValue(flags, "result");
  const outcome = verifyTaskResult(taskPath, resultPath);
  print({
    ok: true,
    method: "verify",
    result: {
      taskPath: outcome.taskPath,
      resultPath: outcome.resultPath,
      taskSha256: outcome.taskSha256,
      algorithmVersion: outcome.algorithmVersion,
      sampleRateHz: outcome.sampleRateHz,
      sampleCount: outcome.sampleCount,
      durationSeconds: outcome.durationSeconds,
      requestedSnrDb: outcome.requestedSnrDb,
      measuredSnrDb: outcome.measuredSnrDb,
      artifacts: outcome.artifacts,
      checks: outcome.checks,
    },
  });
  return EXIT.ok;
}

function usage(): number {
  print({
    ok: true,
    usage: [
      "cwwave prepare --text <text> --out <task.json> [--wpm 20] [--tone 600] [--sample-rate 8000] [--snr 10|clean] [--seed 42] [--ramp-ms 5]",
      "cwwave verify --task <task.json> --result <result.json>",
    ],
    contractVersion: CW_TASK_CONTRACT_VERSION,
    algorithmVersion: CW_ALGORITHM_VERSION,
    limits: CW_LIMITS,
    note: "prepare never transmits and never starts Julia; it only writes an exclusive task JSON.",
  });
  return EXIT.ok;
}

function run(argv: string[]): number {
  const command = argv[0];
  const args = argv.slice(1);
  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return usage();
    case "prepare":
      return runPrepare(args);
    case "verify":
      return runVerify(args);
    default:
      throw new UsageError(`unknown command: ${command}`);
  }
}

try {
  process.exitCode = run(process.argv.slice(2));
} catch (error) {
  if (error instanceof UsageError) {
    print({ ok: false, code: "usage", error: error.message });
    process.exitCode = EXIT.usage;
  } else if (error instanceof CwContractError) {
    print({ ok: false, code: error.code, error: error.message });
    if (error.code === "file_not_found") {
      process.exitCode = EXIT.notFound;
    } else if (error.code === "output_exists") {
      process.exitCode = EXIT.verify;
    } else {
      // verify 失败与 prepare 参数/契约错误都归为“请求无效/校验失败”。
      process.exitCode = process.argv[2] === "verify" ? EXIT.verify : EXIT.usage;
    }
  } else {
    print({ ok: false, code: "internal", error: error instanceof Error ? error.message : String(error) });
    process.exitCode = EXIT.internal;
  }
}
