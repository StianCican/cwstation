// CW 时间轴：点/划、元素/字符/词间隔与整数样本量化。
//
// 约定（与 Julia 侧完全一致）：
//   dot = 1 单位，dash = 3 单位，元素间隔 = 1，字符间隔 = 3，词间隔 = 7；
//   1 单位 = 1.2 / wpm 秒；末尾不留额外间隔。
// 样本边界使用整数运算的“四舍五入到最近、.5 向上”：
//   sampleAt(u) = floor((2*u*sampleRate*6 + 5*wpm) / (10*wpm))
// 该公式等价于 round(u * sampleRate * 1.2 / wpm)，但避免浮点 .5 的歧义，
// 保证 TS 与 Julia 得到逐样本一致的边界。

import { CW_DOT_SECONDS_NUMERATOR, type CwKeyDownSegment, type CwMorseWords } from "./contracts.js";

export interface CwTimeline {
  totalUnits: number;
  sampleCount: number;
  exactDurationSeconds: number;
  durationSeconds: number;
  durationQuantizationErrorSeconds: number;
  /** 所有段边界上 |量化位置 - 精确位置| 的最大值（秒）。 */
  maxSampleQuantizationErrorSeconds: number;
  segments: CwKeyDownSegment[];
}

/** 单位位置 → 整数样本下标（0 基，半开区间语义）。 */
export function sampleAt(unit: number, sampleRateHz: number, wpm: number): number {
  const numerator = 2 * unit * sampleRateHz * 6 + 5 * wpm;
  const denominator = 10 * wpm;
  return Math.floor(numerator / denominator);
}

/** 每单位精确秒数。 */
export function exactSecondsPerUnit(wpm: number): number {
  return CW_DOT_SECONDS_NUMERATOR / wpm;
}

/** 根据 Morse 词表推导关键段落与时长量化误差。 */
export function buildTimeline(words: CwMorseWords, sampleRateHz: number, wpm: number): CwTimeline {
  const segments: CwKeyDownSegment[] = [];
  const boundaries = new Set<number>([0]);
  let unit = 0;

  for (let wi = 0; wi < words.length; wi += 1) {
    if (wi > 0) unit += 7;
    const word = words[wi] as string[];
    for (let ci = 0; ci < word.length; ci += 1) {
      if (ci > 0) unit += 3;
      const letter = word[ci] as string;
      for (let si = 0; si < letter.length; si += 1) {
        if (si > 0) unit += 1;
        const symbol = letter[si] as string;
        const symbolUnits = symbol === "." ? 1 : 3;
        const startSample = sampleAt(unit, sampleRateHz, wpm);
        boundaries.add(unit);
        unit += symbolUnits;
        const endSample = sampleAt(unit, sampleRateHz, wpm);
        boundaries.add(unit);
        segments.push({ startSample, endSample });
      }
    }
  }

  const totalUnits = unit;
  const exactDurationSeconds = totalUnits * CW_DOT_SECONDS_NUMERATOR / wpm;
  const sampleCount = sampleAt(totalUnits, sampleRateHz, wpm);
  const durationSeconds = sampleCount / sampleRateHz;
  let maxSampleQuantizationErrorSeconds = 0;
  const secondsPerUnit = exactSecondsPerUnit(wpm);
  for (const boundary of boundaries) {
    const exactPositionSeconds = boundary * secondsPerUnit;
    const actualPositionSeconds = sampleAt(boundary, sampleRateHz, wpm) / sampleRateHz;
    const error = Math.abs(actualPositionSeconds - exactPositionSeconds);
    if (error > maxSampleQuantizationErrorSeconds) maxSampleQuantizationErrorSeconds = error;
  }

  return {
    totalUnits,
    sampleCount,
    exactDurationSeconds,
    durationSeconds,
    durationQuantizationErrorSeconds: durationSeconds - exactDurationSeconds,
    maxSampleQuantizationErrorSeconds,
    segments,
  };
}

/** 供测试与 verify 使用：判断某样本是否落在任一 key-down 段内。 */
export function buildCoverage(segments: CwKeyDownSegment[], sampleCount: number): Uint8Array {
  const covered = new Uint8Array(sampleCount);
  for (const segment of segments) {
    const start = Math.max(0, segment.startSample);
    const end = Math.min(sampleCount, segment.endSample);
    for (let i = start; i < end; i += 1) covered[i] = 1;
  }
  return covered;
}

/**
 * 与 Julia `round(Int, x)`（RoundNearest，.5 取偶）一致的舍入。
 * 仅用于非负值（ramp 样本数），跨语言逐样本一致需要它而非 JS 的 Math.round。
 */
export function roundHalfToEven(value: number): number {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction < 0.5) return floor;
  if (fraction > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * 复现每个 key-down 段内的短余弦包络（0..1）。
 * 与 Julia `_synthesize` 完全同一公式，供 verify 逐样本重建载波。
 */
export function buildEnvelope(
  segments: CwKeyDownSegment[],
  sampleCount: number,
  rampMs: number,
  sampleRateHz: number,
): Float64Array {
  const envelope = new Float64Array(sampleCount);
  const rampSamples = roundHalfToEven(rampMs * sampleRateHz / 1000);
  for (const segment of segments) {
    const length = segment.endSample - segment.startSample;
    const ramp = Math.min(rampSamples, Math.floor(length / 2));
    for (let i = 0; i < length; i += 1) {
      let gain = 1;
      if (ramp > 0) {
        if (i < ramp) gain = 0.5 * (1 - Math.cos(Math.PI * i / ramp));
        else if (i >= length - ramp) gain = 0.5 * (1 - Math.cos(Math.PI * (length - 1 - i) / ramp));
      }
      envelope[segment.startSample + i] = gain;
    }
  }
  return envelope;
}
