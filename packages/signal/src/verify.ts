// verify：校验 task + result + WAV 的一致性、完整性与音频内容。
// 不只看 JSON 是否存在：会重算 SHA256、独立推导关键段落、解析 WAV、
// 检查峰值/间隔静音，并重算实测 SNR。

import { realpathSync } from "node:fs";
import path from "node:path";
import {
  CW_ALGORITHM_VERSION,
  CW_LIMITS,
  CW_PEAK_CEILING,
  CW_TASK_CONTRACT_VERSION,
  CwContractError,
  isPlainObject,
  type CwArtifact,
  type CwResult,
  type CwTask,
} from "./contracts.js";
import { buildCoverage, buildEnvelope, buildTimeline } from "./timeline.js";
import { readFileCapped, resolveArtifactPath, sha256Hex } from "./util.js";
import { validateCwTask } from "./validate.js";
import { parsePcm16MonoWav } from "./wav.js";

export interface VerifyOutcome {
  taskPath: string;
  resultPath: string;
  taskSha256: string;
  algorithmVersion: string;
  sampleRateHz: number;
  sampleCount: number;
  durationSeconds: number;
  requestedSnrDb: number | null;
  measuredSnrDb: number | null;
  artifacts: { cleanWav: CwArtifact; noisyWav: CwArtifact };
  checks: string[];
}

function fail(code: string, message: string): never {
  throw new CwContractError(code, message);
}

function parseJson(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new CwContractError("invalid_json", `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function requireStringField(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) fail("metadata_mismatch", `${name} must be a non-empty string`);
  return value;
}

function requireIntegerField(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    fail("metadata_mismatch", `${name} must be an integer`);
  }
  if (value < min || value > max) fail("metadata_mismatch", `${name} out of range`);
  return value;
}

function requireNumberField(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail("metadata_mismatch", `${name} must be a finite number`);
  return value;
}

function closeAbs(actual: number, expected: number, tolerance: number): boolean {
  return Math.abs(actual - expected) <= tolerance;
}

function closeRel(actual: number, expected: number, relTolerance: number, absTolerance = 0): boolean {
  return Math.abs(actual - expected) <= Math.max(absTolerance, relTolerance * Math.abs(expected));
}

/** 16bit PCM 量化步长带来的峰值容差。 */
const PEAK_TOLERANCE = 1.5 / 32767;

/** 逐样本载波比对容差：允许 16bit 量化与跨语言浮点舍入的 1~2 LSB。 */
const CARRIER_TOLERANCE = 3 / 32767;

function requireArtifact(value: unknown, name: string): CwArtifact {
  if (!isPlainObject(value)) fail("metadata_mismatch", `${name} must be an object`);
  const artifactPath = requireStringField(value.path, `${name}.path`);
  if (typeof value.bytes !== "number" || !Number.isInteger(value.bytes) || value.bytes < 0) {
    fail("metadata_mismatch", `${name}.bytes must be a non-negative integer`);
  }
  const sha256 = requireStringField(value.sha256, `${name}.sha256`);
  if (!/^[0-9a-f]{64}$/.test(sha256)) fail("metadata_mismatch", `${name}.sha256 must be 64 lowercase hex characters`);
  return { path: artifactPath, bytes: value.bytes, sha256 };
}

function paramsMatchTask(result: CwResult, task: CwTask): void {
  const p = result.params;
  const checks: Array<[unknown, unknown, string]> = [
    [p.text, task.text, "text"],
    [p.normalizedText, task.normalizedText, "normalizedText"],
    [p.wpm, task.wpm, "wpm"],
    [p.toneHz, task.toneHz, "toneHz"],
    [p.sampleRateHz, task.sampleRateHz, "sampleRateHz"],
    [p.snrDb, task.snrDb, "snrDb"],
    [p.seed, task.seed, "seed"],
    [p.rampMs, task.rampMs, "rampMs"],
  ];
  for (const [actual, expected, name] of checks) {
    if (actual !== expected) fail("task_result_mismatch", `result.params.${name} does not match the task`);
  }
  if (JSON.stringify(p.morseWords) !== JSON.stringify(task.morseWords)) {
    fail("task_result_mismatch", "result.params.morseWords does not match the task");
  }
}

interface ResultLike {
  contractVersion: unknown;
  algorithmVersion: unknown;
  taskSha256: unknown;
  taskContractVersion: unknown;
  taskAlgorithmVersion: unknown;
  params: unknown;
  environment: unknown;
  seed: unknown;
  exactDurationSeconds: unknown;
  durationSeconds: unknown;
  sampleCount: unknown;
  durationQuantizationErrorSeconds: unknown;
  maxSampleQuantizationErrorSeconds: unknown;
  requestedSnrDb: unknown;
  measuredSnrDb: unknown;
  noiseVariance: unknown;
  estimatedNoiseVariance: unknown;
  normalizationGain: unknown;
  peakClean: unknown;
  peakNoisy: unknown;
  keyDownSegments: unknown;
  artifacts: unknown;
  unrecognizedTaskFields: unknown;
  executionControl: unknown;
}

function asResultLike(value: unknown): ResultLike {
  if (!isPlainObject(value)) fail("invalid_result", "result must be a JSON object");
  return value as unknown as ResultLike;
}

/**
 * 端到端校验：读取 task/result 原始字节，重算 task SHA256，验证结果元数据、
 * 关键段落、WAV 格式与内容、峰值、间隔静音与实测 SNR。
 */
export function verifyTaskResult(taskPath: string, resultPath: string): VerifyOutcome {
  const taskBytes = readFileCapped(taskPath, CW_LIMITS.TASK_FILE_MAX_BYTES, "task file");
  const task = validateCwTask(parseJson(taskBytes, "task file"));
  const taskSha256 = sha256Hex(taskBytes);

  const resultBytes = readFileCapped(resultPath, CW_LIMITS.RESULT_FILE_MAX_BYTES, "result file");
  const result = asResultLike(parseJson(resultBytes, "result file"));

  const checks: string[] = ["task-contract", "task-sha256"];

  if (result.contractVersion !== CW_TASK_CONTRACT_VERSION) {
    fail("unsupported_result_version", `unsupported result contractVersion ${JSON.stringify(result.contractVersion)}`);
  }
  if (result.algorithmVersion !== CW_ALGORITHM_VERSION) {
    fail("unsupported_algorithm_version", `unsupported result algorithmVersion ${JSON.stringify(result.algorithmVersion)}`);
  }
  if (result.taskSha256 !== taskSha256) {
    fail("task_hash_mismatch", "result.taskSha256 does not match the task file bytes");
  }
  if (result.taskContractVersion !== task.contractVersion) {
    fail("metadata_mismatch", "result.taskContractVersion does not match the task");
  }
  if (result.taskAlgorithmVersion !== task.algorithmVersion) {
    fail("metadata_mismatch", "result.taskAlgorithmVersion does not match the task");
  }
  if (!isPlainObject(result.params)) fail("invalid_result", "result.params must be an object");
  paramsMatchTask(result as unknown as CwResult, task);
  checks.push("params");

  // 环境信息：必须记录 Julia 版本与相关包版本，便于复现。
  const environment = result.environment;
  if (!isPlainObject(environment)) fail("metadata_mismatch", "result.environment must be an object");
  requireStringField(environment.juliaVersion, "environment.juliaVersion");
  const environmentPackages = environment.packages;
  if (!isPlainObject(environmentPackages)) fail("metadata_mismatch", "environment.packages must be an object");
  for (const pkg of ["TyCommunication", "JSON3", "WAV"]) {
    const version = environmentPackages[pkg];
    if (version !== null && typeof version !== "string") {
      fail("metadata_mismatch", `environment.packages.${pkg} must be a string or null`);
    }
    if (typeof version !== "string" || version.length === 0) {
      fail("metadata_mismatch", `environment.packages.${pkg} is missing`);
    }
  }
  checks.push("environment");

  const timeline = buildTimeline(task.morseWords, task.sampleRateHz, task.wpm);

  if (result.seed !== task.seed) fail("metadata_mismatch", "result.seed does not match the task");
  const sampleCount = requireIntegerField(result.sampleCount, "sampleCount", 0, CW_LIMITS.DURATION_MAX_SECONDS * CW_LIMITS.SAMPLE_RATE_MAX);
  if (sampleCount !== timeline.sampleCount) {
    fail("metadata_mismatch", `result.sampleCount ${sampleCount} does not match the derived ${timeline.sampleCount}`);
  }
  const exactDurationSeconds = requireNumberField(result.exactDurationSeconds, "exactDurationSeconds");
  if (!closeAbs(exactDurationSeconds, timeline.exactDurationSeconds, 1e-9)) {
    fail("metadata_mismatch", "exactDurationSeconds does not match the derived value");
  }
  const durationSeconds = requireNumberField(result.durationSeconds, "durationSeconds");
  if (!closeAbs(durationSeconds, sampleCount / task.sampleRateHz, 1e-9)) {
    fail("metadata_mismatch", "durationSeconds does not match sampleCount / sampleRateHz");
  }
  const durationError = requireNumberField(result.durationQuantizationErrorSeconds, "durationQuantizationErrorSeconds");
  if (!closeAbs(durationError, durationSeconds - exactDurationSeconds, 1e-9)) {
    fail("metadata_mismatch", "durationQuantizationErrorSeconds is inconsistent");
  }
  const maxQuantError = requireNumberField(result.maxSampleQuantizationErrorSeconds, "maxSampleQuantizationErrorSeconds");
  if (!closeAbs(maxQuantError, timeline.maxSampleQuantizationErrorSeconds, 1e-9)) {
    fail("metadata_mismatch", "maxSampleQuantizationErrorSeconds is inconsistent");
  }
  checks.push("timeline-metadata");

  // 关键段落必须与 TS 独立推导完全一致。
  if (!Array.isArray(result.keyDownSegments)) fail("metadata_mismatch", "keyDownSegments must be an array");
  if (result.keyDownSegments.length !== timeline.segments.length) {
    fail("segment_mismatch", `keyDownSegments length ${result.keyDownSegments.length} != ${timeline.segments.length}`);
  }
  for (let i = 0; i < timeline.segments.length; i += 1) {
    const actual = result.keyDownSegments[i];
    const expected = timeline.segments[i] as { startSample: number; endSample: number };
    if (!isPlainObject(actual)) fail("segment_mismatch", `keyDownSegments[${i}] must be an object`);
    if (
      !Number.isInteger(actual.startSample) ||
      !Number.isInteger(actual.endSample) ||
      actual.startSample !== expected.startSample ||
      actual.endSample !== expected.endSample
    ) {
      fail("segment_mismatch", `keyDownSegments[${i}] does not match the derived segment`);
    }
  }
  checks.push("keydown-segments");

  // SNR 元数据一致性。
  const requestedSnrDb = result.requestedSnrDb;
  if (requestedSnrDb !== task.snrDb) fail("metadata_mismatch", "requestedSnrDb does not match the task snrDb");
  checks.push("snr-metadata");

  // 归一化增益与峰值必须是有限数值，且峰值不得超过 0.95（防止截幅）。
  const recordedGain = requireNumberField(result.normalizationGain, "normalizationGain");
  if (!(recordedGain > 0)) fail("metadata_mismatch", "normalizationGain must be positive");
  const recordedPeakClean = requireNumberField(result.peakClean, "peakClean");
  const recordedPeakNoisy = requireNumberField(result.peakNoisy, "peakNoisy");
  if (recordedPeakClean < 0 || recordedPeakNoisy < 0) fail("metadata_mismatch", "peak values must be non-negative");
  if (
    recordedPeakClean > CW_PEAK_CEILING + PEAK_TOLERANCE ||
    recordedPeakNoisy > CW_PEAK_CEILING + PEAK_TOLERANCE
  ) {
    fail("audio_peak_exceeded", "recorded peak exceeds the 0.95 ceiling");
  }
  checks.push("peak-metadata");

  const artifacts = result.artifacts;
  if (!isPlainObject(artifacts)) fail("metadata_mismatch", "result.artifacts must be an object");
  const cleanArtifact = requireArtifact(artifacts.cleanWav, "artifacts.cleanWav");
  const noisyArtifact = requireArtifact(artifacts.noisyWav, "artifacts.noisyWav");
  checks.push("artifact-metadata");

  const resultDir = path.dirname(path.resolve(resultPath));
  // 确认 result 目录本身真实存在（realpath 会在 artifact 解析时再次使用）。
  realpathSync(resultDir);

  const cleanPath = resolveArtifactPath(resultDir, cleanArtifact.path);
  const noisyPath = resolveArtifactPath(resultDir, noisyArtifact.path);
  checks.push("artifact-paths");

  const cleanBytes = readFileCapped(cleanPath, CW_LIMITS.WAV_FILE_MAX_BYTES, "clean WAV");
  const noisyBytes = readFileCapped(noisyPath, CW_LIMITS.WAV_FILE_MAX_BYTES, "noisy WAV");

  for (const [artifact, bytes, label] of [
    [cleanArtifact, cleanBytes, "clean WAV"],
    [noisyArtifact, noisyBytes, "noisy WAV"],
  ] as const) {
    if (bytes.length !== artifact.bytes) {
      fail("wav_size_mismatch", `${label} byte size ${bytes.length} != recorded ${artifact.bytes}`);
    }
    if (sha256Hex(bytes) !== artifact.sha256) {
      fail("wav_hash_mismatch", `${label} SHA256 does not match result metadata`);
    }
  }
  checks.push("artifact-hashes");

  const clean = parsePcm16MonoWav(cleanBytes);
  const noisy = parsePcm16MonoWav(noisyBytes);
  for (const [wav, label] of [
    [clean, "clean WAV"],
    [noisy, "noisy WAV"],
  ] as const) {
    if (wav.sampleRateHz !== task.sampleRateHz) {
      fail("wav_format_mismatch", `${label} sample rate ${wav.sampleRateHz} != ${task.sampleRateHz}`);
    }
    if (wav.sampleCount !== sampleCount) {
      fail("wav_format_mismatch", `${label} sample count ${wav.sampleCount} != ${sampleCount}`);
    }
  }
  checks.push("wav-format");

  // 峰值上限：归一化后不允许截幅。
  const decode = (samples: Int16Array): Float64Array => {
    const out = new Float64Array(samples.length);
    for (let i = 0; i < samples.length; i += 1) out[i] = (samples[i] as number) / 32767;
    return out;
  };
  const cleanSamples = decode(clean.samples);
  const noisySamples = decode(noisy.samples);
  let peakClean = 0;
  let peakNoisy = 0;
  for (let i = 0; i < sampleCount; i += 1) {
    const a = Math.abs(cleanSamples[i] as number);
    const b = Math.abs(noisySamples[i] as number);
    if (a > peakClean) peakClean = a;
    if (b > peakNoisy) peakNoisy = b;
  }
  if (peakClean > CW_PEAK_CEILING + PEAK_TOLERANCE || peakNoisy > CW_PEAK_CEILING + PEAK_TOLERANCE) {
    fail("audio_peak_exceeded", `WAV peak exceeds 0.95 (clean=${peakClean}, noisy=${peakNoisy})`);
  }
  if (!closeAbs(recordedPeakClean, peakClean, PEAK_TOLERANCE) || !closeAbs(recordedPeakNoisy, peakNoisy, PEAK_TOLERANCE)) {
    fail("metadata_mismatch", "recorded peaks do not match the PCM audio");
  }
  checks.push("audio-peak");

  // 间隔静音 + 关键段有能量：用 TS 独立推导的覆盖区间检查实际音频。
  const covered = buildCoverage(timeline.segments, sampleCount);
  let gapMax = 0;
  let minSegmentPeak = Number.POSITIVE_INFINITY;
  for (let i = 0; i < sampleCount; i += 1) {
    const magnitude = Math.abs(cleanSamples[i] as number);
    if (covered[i] === 0) {
      if (magnitude > gapMax) gapMax = magnitude;
    }
  }
  for (let s = 0; s < timeline.segments.length; s += 1) {
    const segment = timeline.segments[s] as { startSample: number; endSample: number };
    let peak = 0;
    for (let i = segment.startSample; i < segment.endSample; i += 1) {
      const magnitude = Math.abs(cleanSamples[i] as number);
      if (magnitude > peak) peak = magnitude;
    }
    if (peak < minSegmentPeak) minSegmentPeak = peak;
  }
  if (gapMax > 1e-9) fail("audio_gap_not_silent", `clean WAV has signal (${gapMax}) in an inter-element gap`);
  // 低 SNR 下 clean 被同比例压低，故用相对峰值判断关键段是否有能量，避免误杀 -20dB 场景。
  const segmentThreshold = Math.max(peakClean * 0.25, 1e-6);
  if (minSegmentPeak < segmentThreshold) {
    fail("audio_segment_silent", `a key-down segment has no energy (peak ${minSegmentPeak}, threshold ${segmentThreshold})`);
  }
  checks.push("audio-envelope");

  // 载波必须与固定合成算法逐样本一致：幅度/包络检查对整体反相不敏感，
  // 这里用记录增益与 task 参数重建 clean 载波，锁定波形与相位。
  const envelope = buildEnvelope(timeline.segments, sampleCount, task.rampMs, task.sampleRateHz);
  let carrierMaxError = 0;
  let baseSignalEnergy = 0;
  for (let i = 0; i < sampleCount; i += 1) {
    const base = Math.sin((2 * Math.PI * task.toneHz * i) / task.sampleRateHz) * (envelope[i] as number);
    const expected = recordedGain * base;
    baseSignalEnergy += base * base;
    const error = Math.abs((cleanSamples[i] as number) - expected);
    if (error > carrierMaxError) carrierMaxError = error;
  }
  if (carrierMaxError > CARRIER_TOLERANCE) {
    fail("audio_carrier_mismatch", `clean carrier deviates from the pinned synthesis (max error ${carrierMaxError})`);
  }
  checks.push("audio-carrier");

  // SNR：从实际的 clean/noisy WAV 重新计算，允许有限样本误差。
  let measuredSnrDb: number | null = null;
  if (task.snrDb === null) {
    let identical = clean.sampleCount === noisy.sampleCount;
    if (identical) {
      for (let i = 0; i < sampleCount; i += 1) {
        if (cleanSamples[i] !== noisySamples[i]) {
          identical = false;
          break;
        }
      }
    }
    if (!identical) fail("audio_mismatch", "snrDb is null but clean.wav and noisy.wav differ");
    if (result.measuredSnrDb !== null) fail("snr_mismatch", "measuredSnrDb must be null for a clean task");
    if (result.noiseVariance !== null || result.estimatedNoiseVariance !== null) {
      fail("snr_mismatch", "noise variance must be null for a clean task");
    }
    checks.push("audio-clean-identical");
  } else {
    let signalPower = 0;
    let noisePower = 0;
    for (let i = 0; i < sampleCount; i += 1) {
      const signal = cleanSamples[i] as number;
      const noise = (noisySamples[i] as number) - signal;
      signalPower += signal * signal;
      noisePower += noise * noise;
    }
    if (noisePower <= 0) fail("snr_mismatch", "noisy WAV contains no measurable noise");
    measuredSnrDb = 10 * Math.log10(signalPower / noisePower);
    const recordedSnr = requireNumberField(result.measuredSnrDb, "measuredSnrDb");
    if (!closeAbs(recordedSnr, measuredSnrDb, 0.35)) {
      fail("snr_mismatch", `recorded measuredSnrDb ${recordedSnr} != recomputed ${measuredSnrDb}`);
    }
    const estimated = requireNumberField(result.estimatedNoiseVariance, "estimatedNoiseVariance");
    if (!closeRel(estimated, noisePower / sampleCount, 5e-2, 1e-12)) {
      fail("snr_mismatch", `estimatedNoiseVariance ${estimated} != recomputed ${noisePower / sampleCount}`);
    }
    const theoretical = requireNumberField(result.noiseVariance, "noiseVariance");
    const expectedVariance = baseSignalEnergy / sampleCount / (10 ** (task.snrDb / 10));
    if (!closeRel(theoretical, expectedVariance, 1e-6, 1e-12)) {
      fail("snr_mismatch", "noiseVariance is inconsistent with signal power and requested SNR");
    }
    checks.push("audio-snr");
  }

  if (!Array.isArray(result.unrecognizedTaskFields) || result.unrecognizedTaskFields.some((f) => typeof f !== "string")) {
    fail("metadata_mismatch", "unrecognizedTaskFields must be an array of strings");
  }
  const executionControl = result.executionControl;
  if (!isPlainObject(executionControl)) fail("metadata_mismatch", "executionControl must be an object");
  if (executionControl.interactive !== false || executionControl.transmits !== false) {
    fail("metadata_mismatch", "executionControl must declare interactive=false and transmits=false");
  }
  checks.push("execution-control");

  return {
    taskPath,
    resultPath,
    taskSha256,
    algorithmVersion: CW_ALGORITHM_VERSION,
    sampleRateHz: task.sampleRateHz,
    sampleCount,
    durationSeconds,
    requestedSnrDb: task.snrDb,
    measuredSnrDb,
    artifacts: { cleanWav: cleanArtifact, noisyWav: noisyArtifact },
    checks,
  };
}
