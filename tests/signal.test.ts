// P0-004：CW 信号契约 / Morse 复用 / cwwave CLI / verify 测试。
//
// 说明：真正的合成由 Julia/MWORKS 侧完成（julia/test/runtests.jl + 证据）。
// 这里用 TS 侧契约函数构造一个自洽的 result+WAV 组合来测试 verify 的结构、
// SHA256、WAV 格式、路径安全与音频校验逻辑，并逐项验证篡改会被拒绝。

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, cliEntry, canCreateSymlinks } from "./helpers.js";
import {
  CW_ALGORITHM_VERSION,
  CwContractError,
  buildEnvelope,
  buildTimeline,
  encodeCwText,
  normalizeCwText,
  roundHalfToEven,
  sha256Hex,
  validateCwTask,
  verifyTaskResult,
  type CwTask,
} from "../packages/signal/src/index.js";

interface CliRun {
  status: number | null;
  json: Record<string, unknown> | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): CliRun {
  const result = spawnSync(process.execPath, [...cliEntry("cwwave"), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
  });
  const lines = result.stdout.trim().split("\n").filter((line) => line.length > 0);
  const last = lines.length > 0 ? (lines[lines.length - 1] as string) : "";
  let json: Record<string, unknown> | null = null;
  if (last.startsWith("{")) json = JSON.parse(last) as Record<string, unknown>;
  return { status: result.status, json, stdout: result.stdout, stderr: result.stderr };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "cwstation-signal-"));
}

// ── 契约 / Morse / 时间轴 ────────────────────────────────────────────────

test("Morse 复用库对支持字符给出标准编码，并严格拒绝不支持字符", () => {
  assert.deepEqual(encodeCwText("CQ TEST"), [["-.-.", "--.-"], ["-", ".", "...", "-"]]);
  assert.deepEqual(encodeCwText("E E"), [["."], ["."]]);
  assert.deepEqual(encodeCwText("? / . ,"), [["..--.."], ["-..-."], [".-.-.-"], ["--..--"]]);
  assert.equal(normalizeCwText("  cq   test "), "CQ TEST");
  const error = (() => {
    try {
      encodeCwText("CQ #");
      return null;
    } catch (err) {
      return err;
    }
  })();
  assert.ok(error instanceof CwContractError);
  assert.equal(error?.code, "unsupported_character");
});

test("时间轴：E/T 为 1:3、EE 字符间隔 3、E E 词间隔 7、无尾间隔", () => {
  const e = buildTimeline([["."]], 8000, 20);
  const t = buildTimeline([["-"]], 8000, 20);
  assert.equal(e.segments[0]?.startSample, 0);
  assert.equal(e.segments[0]?.endSample, 480);
  assert.equal(t.segments[0]?.endSample, 1440);

  const ee = buildTimeline([[".", "."]], 8000, 20);
  assert.equal(ee.segments[1]?.startSample, 1920);
  assert.equal((ee.segments[1]?.startSample as number) - (ee.segments[0]?.endSample as number), 3 * 480);

  const eSpaceE = buildTimeline([["."], ["."]], 8000, 20);
  assert.equal((eSpaceE.segments[1]?.startSample as number) - (eSpaceE.segments[0]?.endSample as number), 7 * 480);

  // 无多余末尾间隔：最后一个段结束即总样本数。
  const last = eSpaceE.segments[eSpaceE.segments.length - 1];
  assert.equal(last?.endSample, eSpaceE.sampleCount);
  assert.equal(eSpaceE.sampleCount, 4320);
});

test("ramp 样本数使用与 Julia 一致的 ties-to-even 舍入", () => {
  assert.equal(roundHalfToEven(42.5), 42);
  assert.equal(roundHalfToEven(43.5), 44);
  const timeline = buildTimeline([["."]], 8500, 20);
  const envelope = buildEnvelope(timeline.segments, timeline.sampleCount, 5, 8500);
  // ramp = round(5*8500/1000) = round(42.5) = 42（取偶），故 i=42 已进入平顶。
  assert.equal(envelope[0], 0);
  assert.equal(envelope[42], 1);
  assert.ok((envelope[41] as number) < 1);
});

test("任务校验拒绝未来版本、布尔冒充数值、空/非法 Morse、超限与超长输入", () => {
  const base: Record<string, unknown> = {
    contractVersion: 1,
    algorithmVersion: CW_ALGORITHM_VERSION,
    text: "EE",
    normalizedText: "EE",
    morseWords: [[".", "."]],
    wpm: 20,
    toneHz: 600,
    sampleRateHz: 8000,
    snrDb: 10,
    seed: 42,
    rampMs: 5,
  };
  const expectCode = (patch: Record<string, unknown>, code: string): void => {
    const error = (() => {
      try {
        validateCwTask({ ...base, ...patch });
        return null;
      } catch (err) {
        return err;
      }
    })();
    assert.ok(error instanceof CwContractError, `expected ${code}`);
    assert.equal(error?.code, code);
  };

  expectCode({ contractVersion: 2 }, "unsupported_contract_version");
  expectCode({ algorithmVersion: "9.9.9" }, "unsupported_algorithm_version");
  expectCode({ wpm: true }, "invalid_field");
  expectCode({ wpm: 20.5 }, "invalid_field");
  expectCode({ sampleRateHz: "8000" }, "invalid_field");
  expectCode({ morseWords: [] }, "empty_morse");
  expectCode({ morseWords: [["."], []] }, "empty_word");
  expectCode({ morseWords: [["."], ["x"]] }, "illegal_morse");
  expectCode({ text: "E".repeat(401), normalizedText: "E".repeat(401) }, "oversized_input");
  expectCode({ seed: -1 }, "out_of_range");
  expectCode({ toneHz: 3000, sampleRateHz: 8000 }, "out_of_range");
  expectCode({ normalizedText: "E E" }, "inconsistent_text");
  expectCode({ morseWords: [["-"]] }, "inconsistent_morse");
  expectCode({ snrDb: 999 }, "out_of_range");
});

test("任务校验拒绝超过 120s 的报文", () => {
  const text = "E".repeat(400);
  const error = (() => {
    try {
      validateCwTask({
        contractVersion: 1,
        algorithmVersion: CW_ALGORITHM_VERSION,
        text,
        normalizedText: text,
        morseWords: [Array.from({ length: 400 }, () => ".")],
        wpm: 5,
        toneHz: 600,
        sampleRateHz: 8000,
        snrDb: null,
        seed: 0,
        rampMs: 5,
      });
      return null;
    } catch (err) {
      return err;
    }
  })();
  assert.ok(error instanceof CwContractError);
  assert.equal(error?.code, "duration_too_long");
});

// ── prepare CLI ─────────────────────────────────────────────────────────

test("cwwave prepare 写入独占任务文件并拒绝覆盖", () => {
  const dir = tempDir();
  try {
    const taskPath = join(dir, "task.json");
    const first = runCli(["prepare", "--text", "CQ TEST", "--out", taskPath, "--snr", "10"]);
    assert.equal(first.status, 0);
    assert.equal(first.json?.ok, true);
    const result = first.json?.result as Record<string, unknown>;
    assert.equal(result.normalizedText, "CQ TEST");
    assert.equal(result.snrDb, 10);
    assert.equal(result.seed, 42);
    assert.equal(result.wpm, 20);

    const second = runCli(["prepare", "--text", "CQ TEST", "--out", taskPath]);
    assert.equal(second.status, 4);
    assert.equal(second.json?.code, "output_exists");

    const unknown = runCli(["prepare", "--text", "CQ", "--out", join(dir, "x.json"), "--bogus", "1"]);
    assert.equal(unknown.status, 2);
    assert.equal(unknown.json?.code, "usage");

    const unsupported = runCli(["prepare", "--text", "CQ #", "--out", join(dir, "y.json")]);
    assert.equal(unsupported.status, 2);
    assert.equal(unsupported.json?.code, "unsupported_character");

    const clean = runCli(["prepare", "--text", "E E", "--out", join(dir, "clean.json"), "--snr", "clean"]);
    assert.equal(clean.status, 0);
    const cleanResult = clean.json?.result as Record<string, unknown>;
    assert.equal(cleanResult.snrDb, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── verify：自洽组合与篡改 ───────────────────────────────────────────────

function writePcm16Wav(samples: Float64Array, sampleRate: number): Buffer {
  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "latin1");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "latin1");
  buffer.write("fmt ", 12, "latin1");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "latin1");
  buffer.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i += 1) {
    const scaled = Math.round((samples[i] as number) * 32767);
    buffer.writeInt16LE(Math.max(-32768, Math.min(32767, scaled)), 44 + i * 2);
  }
  return buffer;
}

function synthesize(task: CwTask): Float64Array {
  const timeline = buildTimeline(task.morseWords, task.sampleRateHz, task.wpm);
  const envelope = new Float64Array(timeline.sampleCount);
  const rampSamples = roundHalfToEven(task.rampMs * task.sampleRateHz / 1000);
  for (const segment of timeline.segments) {
    const length = segment.endSample - segment.startSample;
    const ramp = Math.min(rampSamples, Math.floor(length / 2));
    for (let i = 0; i < length; i += 1) {
      let gain = 1;
      if (ramp > 0) {
        if (i < ramp) gain = 0.5 * (1 - Math.cos((Math.PI * i) / ramp));
        else if (i >= length - ramp) gain = 0.5 * (1 - Math.cos((Math.PI * (length - 1 - i)) / ramp));
      }
      envelope[segment.startSample + i] = gain;
    }
  }
  const out = new Float64Array(timeline.sampleCount);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Math.sin((2 * Math.PI * task.toneHz * i) / task.sampleRateHz) * (envelope[i] as number);
  }
  return out;
}

function pseudoNoise(length: number, seed: number): Float64Array {
  let state = seed >>> 0 || 1;
  const rand = (): number => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  const noise = new Float64Array(length);
  for (let i = 0; i < length; i += 2) {
    const u1 = Math.max(rand(), 1e-12);
    const u2 = rand();
    const radius = Math.sqrt(-2 * Math.log(u1));
    noise[i] = radius * Math.cos(2 * Math.PI * u2);
    if (i + 1 < length) noise[i + 1] = radius * Math.sin(2 * Math.PI * u2);
  }
  return noise;
}

interface Bundle {
  dir: string;
  taskPath: string;
  resultPath: string;
  task: CwTask;
  result: Record<string, unknown>;
  cleanPath: string;
  noisyPath: string;
}

function makeBundle(snrDb = 10): Bundle {
  const dir = tempDir();
  const taskPath = join(dir, "task.json");
  const prepared = runCli(["prepare", "--text", "CQ TEST", "--out", taskPath, "--snr", String(snrDb)]);
  assert.equal(prepared.status, 0);
  const task = validateCwTask(JSON.parse(readFileSync(taskPath, "utf8")));
  const timeline = buildTimeline(task.morseWords, task.sampleRateHz, task.wpm);

  const clean = synthesize(task);
  let noisy = clean;
  let noiseVariance: number | null = null;
  let measuredSnrDb: number | null = null;
  let estimatedNoiseVariance: number | null = null;
  if (task.snrDb !== null) {
    const noise = pseudoNoise(clean.length, task.seed);
    let signalPower = 0;
    let noisePower = 0;
    for (let i = 0; i < clean.length; i += 1) {
      signalPower += (clean[i] as number) ** 2;
      noisePower += (noise[i] as number) ** 2;
    }
    const scale = Math.sqrt(signalPower / 10 ** (task.snrDb / 10) / noisePower);
    noisy = new Float64Array(clean.length);
    for (let i = 0; i < clean.length; i += 1) noisy[i] = (clean[i] as number) + (noise[i] as number) * scale;
    noiseVariance = (noisePower * scale * scale) / clean.length;
  }

  let peakNoisy = 0;
  for (let i = 0; i < noisy.length; i += 1) peakNoisy = Math.max(peakNoisy, Math.abs(noisy[i] as number));
  const gain = peakNoisy > 0 ? 0.95 / peakNoisy : 1;
  const cleanFinal = Float64Array.from(clean, (value) => value * gain);
  const noisyFinal = Float64Array.from(noisy, (value) => value * gain);

  if (task.snrDb !== null) {
    let signalPower = 0;
    let noisePower = 0;
    for (let i = 0; i < cleanFinal.length; i += 1) {
      signalPower += (cleanFinal[i] as number) ** 2;
      const noise = (noisyFinal[i] as number) - (cleanFinal[i] as number);
      noisePower += noise * noise;
    }
    measuredSnrDb = 10 * Math.log10(signalPower / noisePower);
    estimatedNoiseVariance = noisePower / cleanFinal.length;
  }

  let peakClean = 0;
  let peakNoisyFinal = 0;
  for (let i = 0; i < cleanFinal.length; i += 1) {
    peakClean = Math.max(peakClean, Math.abs(cleanFinal[i] as number));
    peakNoisyFinal = Math.max(peakNoisyFinal, Math.abs(noisyFinal[i] as number));
  }

  const cleanBytes = writePcm16Wav(cleanFinal, task.sampleRateHz);
  const noisyBytes = writePcm16Wav(noisyFinal, task.sampleRateHz);
  const cleanPath = join(dir, "clean.wav");
  const noisyPath = join(dir, "noisy.wav");
  writeFileSync(cleanPath, cleanBytes);
  writeFileSync(noisyPath, noisyBytes);

  const durationSeconds = timeline.sampleCount / task.sampleRateHz;
  const result: Record<string, unknown> = {
    contractVersion: 1,
    algorithmVersion: CW_ALGORITHM_VERSION,
    taskSha256: sha256Hex(readFileSync(taskPath)),
    taskContractVersion: task.contractVersion,
    taskAlgorithmVersion: task.algorithmVersion,
    params: {
      text: task.text,
      normalizedText: task.normalizedText,
      morseWords: task.morseWords,
      wpm: task.wpm,
      toneHz: task.toneHz,
      sampleRateHz: task.sampleRateHz,
      snrDb: task.snrDb,
      seed: task.seed,
      rampMs: task.rampMs,
    },
    environment: { juliaVersion: "1.10.10", packages: { TyCommunication: "1.0.7", JSON3: "1.14.3", WAV: "1.2.0" } },
    seed: task.seed,
    exactDurationSeconds: timeline.exactDurationSeconds,
    durationSeconds,
    sampleCount: timeline.sampleCount,
    durationQuantizationErrorSeconds: timeline.durationQuantizationErrorSeconds,
    maxSampleQuantizationErrorSeconds: timeline.maxSampleQuantizationErrorSeconds,
    requestedSnrDb: task.snrDb,
    measuredSnrDb,
    noiseVariance,
    estimatedNoiseVariance,
    normalizationGain: gain,
    peakClean,
    peakNoisy: peakNoisyFinal,
    keyDownSegments: timeline.segments,
    artifacts: {
      cleanWav: { path: "clean.wav", bytes: cleanBytes.length, sha256: sha256Hex(cleanBytes) },
      noisyWav: { path: "noisy.wav", bytes: noisyBytes.length, sha256: sha256Hex(noisyBytes) },
    },
    unrecognizedTaskFields: [],
    executionControl: { interactive: false, transmits: false, mode: "offline-simulation" },
  };
  const resultPath = join(dir, "result.json");
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  return { dir, taskPath, resultPath, task, result, cleanPath, noisyPath };
}

function expectVerifyCode(bundle: Bundle, code: string): void {
  const error = (() => {
    try {
      verifyTaskResult(bundle.taskPath, bundle.resultPath);
      return null;
    } catch (err) {
      return err;
    }
  })();
  assert.ok(error instanceof CwContractError, `expected ${code}, got ${String(error)}`);
  assert.equal(error?.code, code);
}

test("verify 接受自洽的 task/result/WAV 组合（含 SHA256、格式与音频校验）", () => {
  const bundle = makeBundle();
  try {
    const outcome = verifyTaskResult(bundle.taskPath, bundle.resultPath);
    assert.equal(outcome.sampleCount, 26400);
    assert.ok(outcome.checks.includes("artifact-hashes"));
    assert.ok(outcome.checks.includes("wav-format"));
    assert.ok(outcome.checks.includes("audio-envelope"));
    assert.ok(outcome.checks.includes("audio-snr"));
    assert.equal(outcome.requestedSnrDb, 10);
  } finally {
    rmSync(bundle.dir, { recursive: true, force: true });
  }
});

test("verify 通过 CLI 输出纯 JSON 且退出码为 0", () => {
  const bundle = makeBundle();
  try {
    const run = runCli(["verify", "--task", bundle.taskPath, "--result", bundle.resultPath]);
    assert.equal(run.status, 0);
    assert.equal(run.json?.ok, true);
    assert.equal(run.json?.method, "verify");
  } finally {
    rmSync(bundle.dir, { recursive: true, force: true });
  }
});

test("verify 接受低 SNR（-20 dB）下 clean 幅度很小的真实组合", () => {
  const bundle = makeBundle(-20);
  try {
    const outcome = verifyTaskResult(bundle.taskPath, bundle.resultPath);
    assert.ok(Math.abs((outcome.measuredSnrDb ?? 0) + 20) < 0.35);
    assert.ok(outcome.checks.includes("audio-envelope"));
  } finally {
    rmSync(bundle.dir, { recursive: true, force: true });
  }
});

test("verify 拒绝被篡改的 task 字节", () => {
  const bundle = makeBundle();
  try {
    // 修改一个与 Morse 一致性无关但合法的字段，使任务仍可解析、但字节哈希改变。
    writeFileSync(bundle.taskPath, readFileSync(bundle.taskPath, "utf8").replace('"seed": 42', '"seed": 43'));
    expectVerifyCode(bundle, "task_hash_mismatch");
  } finally {
    rmSync(bundle.dir, { recursive: true, force: true });
  }
});

test("verify 拒绝被篡改的 WAV 字节", () => {
  const bundle = makeBundle();
  try {
    const bytes = readFileSync(bundle.cleanPath);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] as number) ^ 0xff;
    writeFileSync(bundle.cleanPath, bytes);
    expectVerifyCode(bundle, "wav_hash_mismatch");
  } finally {
    rmSync(bundle.dir, { recursive: true, force: true });
  }
});

test("verify 拒绝错误的样本数、未来版本与错配元数据", () => {
  const bundle = makeBundle();
  try {
    const original = JSON.parse(readFileSync(bundle.resultPath, "utf8")) as Record<string, unknown>;
    original.sampleCount = 1;
    writeFileSync(bundle.resultPath, JSON.stringify(original));
    expectVerifyCode(bundle, "metadata_mismatch");
  } finally {
    rmSync(bundle.dir, { recursive: true, force: true });
  }

  const bundle2 = makeBundle();
  try {
    const original = JSON.parse(readFileSync(bundle2.resultPath, "utf8")) as Record<string, unknown>;
    original.contractVersion = 2;
    writeFileSync(bundle2.resultPath, JSON.stringify(original));
    expectVerifyCode(bundle2, "unsupported_result_version");
  } finally {
    rmSync(bundle2.dir, { recursive: true, force: true });
  }

  const bundle3 = makeBundle();
  try {
    const original = JSON.parse(readFileSync(bundle3.resultPath, "utf8")) as Record<string, unknown>;
    original.algorithmVersion = "9.9.9";
    writeFileSync(bundle3.resultPath, JSON.stringify(original));
    expectVerifyCode(bundle3, "unsupported_algorithm_version");
  } finally {
    rmSync(bundle3.dir, { recursive: true, force: true });
  }

  const bundle4 = makeBundle();
  try {
    const original = JSON.parse(readFileSync(bundle4.resultPath, "utf8")) as {
      artifacts: { cleanWav: { path: string } };
    };
    original.artifacts.cleanWav.path = "../escape.wav";
    writeFileSync(bundle4.resultPath, JSON.stringify(original));
    expectVerifyCode(bundle4, "artifact_path_unsafe");
  } finally {
    rmSync(bundle4.dir, { recursive: true, force: true });
  }

  const bundle5 = makeBundle();
  try {
    const original = JSON.parse(readFileSync(bundle5.resultPath, "utf8")) as {
      artifacts: { cleanWav: { path: string } };
    };
    original.artifacts.cleanWav.path = "/etc/hostname";
    writeFileSync(bundle5.resultPath, JSON.stringify(original));
    expectVerifyCode(bundle5, "artifact_path_unsafe");
  } finally {
    rmSync(bundle5.dir, { recursive: true, force: true });
  }
});

test("verify 拒绝目录外 symlink 与缺失 artifact", (t) => {
  const bundle = makeBundle();
  try {
    if (canCreateSymlinks()) {
      const outside = join(bundle.dir, "..", `cwstation-outside-${process.pid}.wav`);
      writeFileSync(outside, readFileSync(bundle.cleanPath));
      const linkPath = join(bundle.dir, "link.wav");
      symlinkSync(outside, linkPath);
      const original = JSON.parse(readFileSync(bundle.resultPath, "utf8")) as {
        artifacts: { cleanWav: { path: string; sha256: string; bytes: number } };
      };
      original.artifacts.cleanWav.path = "link.wav";
      original.artifacts.cleanWav.sha256 = sha256Hex(readFileSync(outside));
      original.artifacts.cleanWav.bytes = readFileSync(outside).length;
      writeFileSync(bundle.resultPath, JSON.stringify(original));
      expectVerifyCode(bundle, "artifact_path_unsafe");
      rmSync(outside, { force: true });
    } else {
      t.diagnostic("symlink check skipped: symlink creation is not permitted on this platform/user");
    }

    const original2 = JSON.parse(readFileSync(bundle.resultPath, "utf8")) as {
      artifacts: { cleanWav: { path: string } };
    };
    original2.artifacts.cleanWav.path = "missing.wav";
    writeFileSync(bundle.resultPath, JSON.stringify(original2));
    expectVerifyCode(bundle, "artifact_missing");
  } finally {
    rmSync(bundle.dir, { recursive: true, force: true });
  }
});

test("verify 拒绝错配的实测 SNR 与缺失文件", () => {
  const bundle = makeBundle();
  try {
    const original = JSON.parse(readFileSync(bundle.resultPath, "utf8")) as Record<string, unknown>;
    original.measuredSnrDb = 3.0;
    writeFileSync(bundle.resultPath, JSON.stringify(original));
    expectVerifyCode(bundle, "snr_mismatch");
  } finally {
    rmSync(bundle.dir, { recursive: true, force: true });
  }

  const missing = runCli(["verify", "--task", "/nonexistent/task.json", "--result", "/nonexistent/result.json"]);
  assert.equal(missing.status, 3);
  assert.equal(missing.json?.code, "file_not_found");
});

test("prepare 与 verify 的临时目录不会污染工作区", () => {
  // 该用例仅确认 unittest 临时目录可创建/清理，作为工作区卫生检查。
  const dir = tempDir();
  mkdirSync(join(dir, "sub"));
  assert.ok(dir.includes("cwstation-signal-"));
  rmSync(dir, { recursive: true, force: true });
});
