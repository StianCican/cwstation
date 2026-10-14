// 任务契约校验（TS 侧）。与 Julia 侧独立重复执行同样的范围/类型检查。
// 额外做 TS 侧一致性校验：normalizedText 必须与 text 的规范化结果一致，
// morseWords 必须与复用库重新编码的结果一致。

import {
  CW_ALGORITHM_VERSION,
  CW_LIMITS,
  CW_TASK_CONTRACT_VERSION,
  CwContractError,
  isPlainObject,
  type CwMorseWords,
  type CwTask,
} from "./contracts.js";
import { encodeCwText, normalizeCwText } from "./morse.js";
import { buildTimeline } from "./timeline.js";

function fail(code: string, message: string): never {
  throw new CwContractError(code, message);
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") fail("invalid_field", `${name} must be a string`);
  return value;
}

function requireInteger(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    fail("invalid_field", `${name} must be an integer (booleans are not numbers)`);
  }
  if (value < min || value > max) {
    fail("out_of_range", `${name} must be in [${min}, ${max}]`);
  }
  return value;
}

function requireNumber(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("invalid_field", `${name} must be a finite number`);
  }
  if (value < min || value > max) {
    fail("out_of_range", `${name} must be in [${min}, ${max}]`);
  }
  return value;
}

function requireMorseWords(value: unknown): CwMorseWords {
  if (!Array.isArray(value) || value.length === 0) {
    fail("empty_morse", "morseWords must be a non-empty array of words");
  }
  const words: CwMorseWords = [];
  let totalLetters = 0;
  for (const word of value) {
    if (!Array.isArray(word) || word.length === 0) {
      fail("empty_word", "each Morse word must be a non-empty array of letters");
    }
    const letters: string[] = [];
    for (const letter of word) {
      if (typeof letter !== "string") fail("illegal_morse", "each Morse letter must be a string");
      if (!/^[.-]+$/.test(letter)) fail("illegal_morse", `illegal Morse letter: ${JSON.stringify(letter)}`);
      if (letter.length > CW_LIMITS.MORSE_LETTER_MAX_SYMBOLS) {
        fail("illegal_morse", `Morse letter exceeds ${CW_LIMITS.MORSE_LETTER_MAX_SYMBOLS} symbols`);
      }
      letters.push(letter);
      totalLetters += 1;
    }
    words.push(letters);
  }
  if (totalLetters === 0) fail("empty_morse", "morseWords contains no letters");
  if (totalLetters > CW_LIMITS.TEXT_MAX_CHARS) {
    fail("oversized_input", `Morse letters exceed ${CW_LIMITS.TEXT_MAX_CHARS}`);
  }
  return words;
}

/**
 * 严格校验一个任务对象，返回规范化后的 CwTask。
 * 未知版本、布尔冒充数值、空报文/空词、非法 Morse、超限输入都会抛 CwContractError。
 */
export function validateCwTask(value: unknown): CwTask {
  if (!isPlainObject(value)) fail("invalid_task", "task must be a JSON object");
  const obj = value;

  const contractVersion = requireInteger(obj.contractVersion, "contractVersion", 0, Number.MAX_SAFE_INTEGER);
  if (contractVersion !== CW_TASK_CONTRACT_VERSION) {
    fail("unsupported_contract_version", `unsupported contractVersion ${contractVersion}`);
  }
  if (obj.algorithmVersion !== CW_ALGORITHM_VERSION) {
    fail("unsupported_algorithm_version", `unsupported algorithmVersion ${JSON.stringify(obj.algorithmVersion)}`);
  }

  const text = requireString(obj.text, "text");
  if (text.length > CW_LIMITS.TEXT_MAX_CHARS) {
    fail("oversized_input", `text exceeds ${CW_LIMITS.TEXT_MAX_CHARS} characters`);
  }
  const normalizedText = requireString(obj.normalizedText, "normalizedText");
  if (normalizedText.length === 0) fail("empty_message", "normalizedText must not be empty");
  if (normalizedText.length > CW_LIMITS.TEXT_MAX_CHARS) {
    fail("oversized_input", `normalizedText exceeds ${CW_LIMITS.TEXT_MAX_CHARS} characters`);
  }

  const wpm = requireInteger(obj.wpm, "wpm", CW_LIMITS.WPM_MIN, CW_LIMITS.WPM_MAX);
  const sampleRateHz = requireInteger(
    obj.sampleRateHz,
    "sampleRateHz",
    CW_LIMITS.SAMPLE_RATE_MIN,
    CW_LIMITS.SAMPLE_RATE_MAX,
  );
  const toneHz = requireNumber(obj.toneHz, "toneHz", CW_LIMITS.TONE_MIN_HZ, CW_LIMITS.TONE_MAX_HZ);
  if (toneHz >= sampleRateHz / 2) fail("out_of_range", "toneHz must be below the Nyquist frequency");
  const seed = requireInteger(obj.seed, "seed", CW_LIMITS.SEED_MIN, CW_LIMITS.SEED_MAX);
  const rampMs = requireInteger(obj.rampMs, "rampMs", CW_LIMITS.RAMP_MS_MIN, CW_LIMITS.RAMP_MS_MAX);

  if (!Object.prototype.hasOwnProperty.call(obj, "snrDb")) {
    fail("invalid_field", "snrDb is required (use null for a clean scenario)");
  }
  const rawSnr = obj.snrDb;
  const snrDb = rawSnr === null ? null : requireNumber(rawSnr, "snrDb", CW_LIMITS.SNR_MIN_DB, CW_LIMITS.SNR_MAX_DB);

  const morseWords = requireMorseWords(obj.morseWords);

  // 一致性：规范文本必须由原始文本折叠/大写得到；Morse 必须由规范文本重新编码得到。
  const expectedNormalized = normalizeCwText(text);
  if (expectedNormalized !== normalizedText) {
    fail("inconsistent_text", "normalizedText does not match normalizeCwText(text)");
  }
  const expectedMorse = encodeCwText(normalizedText);
  if (JSON.stringify(expectedMorse) !== JSON.stringify(morseWords)) {
    fail("inconsistent_morse", "morseWords does not match the library-encoded normalizedText");
  }

  const timeline = buildTimeline(morseWords, sampleRateHz, wpm);
  if (timeline.exactDurationSeconds > CW_LIMITS.DURATION_MAX_SECONDS) {
    fail("duration_too_long", `exact duration ${timeline.exactDurationSeconds}s exceeds ${CW_LIMITS.DURATION_MAX_SECONDS}s`);
  }
  if (timeline.sampleCount > CW_LIMITS.DURATION_MAX_SECONDS * sampleRateHz) {
    fail("duration_too_long", `sample count ${timeline.sampleCount} exceeds the 120s budget`);
  }

  return {
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
  };
}

/** 从已校验任务派生时间轴（供 prepare/verify 复用）。 */
export function timelineForTask(task: CwTask) {
  return buildTimeline(task.morseWords, task.sampleRateHz, task.wpm);
}
