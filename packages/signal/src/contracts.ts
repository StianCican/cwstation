// CW 信号合成契约（P0-004 v1）。
//
// TS 侧负责：文本规范化 + Morse 编码（复用 morse-code-translator）、任务契约校验、
// 时间轴/关键段落推导、结果与 WAV 校验。
// Julia 侧负责：独立校验同一契约、按样本边界合成、加噪声、写 WAV/result.json。
//
// 这里只放纯数据契约与纯函数，不依赖 daemon / 控制核心，也不做任何发射。

/** 任务/结果契约版本。破坏兼容性变更必须提升此版本并在双方拒绝未知版本。 */
export const CW_TASK_CONTRACT_VERSION = 1 as const;

/** 算法版本：合成与噪声算法语义。变更合成语义时提升。 */
export const CW_ALGORITHM_VERSION = "1.0.0" as const;

/** 默认短余弦 ramp 时长（毫秒）。 */
export const CW_DEFAULT_RAMP_MS = 5;

/** 点长定义：dot = 1.2 / wpm 秒（即 1.2 个时间单位与 wpm 的关系）。 */
export const CW_DOT_SECONDS_NUMERATOR = 1.2;

/** 契约允许的取值上限；双方都必须独立执行这些限制，防止恶意任务无限分配。 */
export const CW_LIMITS = {
  TEXT_MAX_CHARS: 400,
  WPM_MIN: 5,
  WPM_MAX: 60,
  SAMPLE_RATE_MIN: 8000,
  SAMPLE_RATE_MAX: 48000,
  TONE_MIN_HZ: 200,
  TONE_MAX_HZ: 2000,
  SNR_MIN_DB: -20,
  SNR_MAX_DB: 60,
  SEED_MIN: 0,
  SEED_MAX: 2 ** 31 - 1,
  RAMP_MS_MIN: 0,
  RAMP_MS_MAX: 50,
  DURATION_MAX_SECONDS: 120,
  MORSE_LETTER_MAX_SYMBOLS: 7,
  /** 任务文件读取上限（字节）。 */
  TASK_FILE_MAX_BYTES: 1_048_576,
  /** 结果文件读取上限（字节）。 */
  RESULT_FILE_MAX_BYTES: 8_388_608,
  /** 单个 WAV 读取上限（字节）：120s * 48kHz * 16bit ≈ 11.5MB。 */
  WAV_FILE_MAX_BYTES: 64 * 1024 * 1024,
} as const;

/** 归一化后的峰值上限；留出 16bit 量化余量，绝不截幅。 */
export const CW_PEAK_CEILING = 0.95;

/** Morse 词表：每个词是字母数组，每个字母是仅含 '.' 与 '-' 的字符串。 */
export type CwMorseWords = string[][];

/** 任务参数（与 CLI / Julia 任务 JSON 字段一一对应）。 */
export interface CwTask {
  contractVersion: typeof CW_TASK_CONTRACT_VERSION;
  algorithmVersion: string;
  /** 原始输入文本（保留大小写与空白）。 */
  text: string;
  /** 折叠空白并转大写后的规范文本；用于生成 Morse。 */
  normalizedText: string;
  morseWords: CwMorseWords;
  wpm: number;
  toneHz: number;
  sampleRateHz: number;
  /** null 表示干净场景（不加噪声）。 */
  snrDb: number | null;
  seed: number;
  rampMs: number;
}

/** 一个 key-down 段，半开区间 [startSample, endSample)，样本下标从 0 开始。 */
export interface CwKeyDownSegment {
  startSample: number;
  endSample: number;
}

export interface CwArtifact {
  /** 相对 result.json 所在目录的路径，禁止绝对路径与目录外引用。 */
  path: string;
  bytes: number;
  sha256: string;
}

export interface CwEnvironment {
  juliaVersion: string;
  packages: Record<string, string | null>;
}

export interface CwResultParams {
  text: string;
  normalizedText: string;
  morseWords: CwMorseWords;
  wpm: number;
  toneHz: number;
  sampleRateHz: number;
  snrDb: number | null;
  seed: number;
  rampMs: number;
}

/** Julia 生产的 result.json 结构；TS verify 会严格校验。 */
export interface CwResult {
  contractVersion: number;
  algorithmVersion: string;
  /** 任务文件原始字节的 SHA256（十六进制小写）。 */
  taskSha256: string;
  taskContractVersion: number;
  taskAlgorithmVersion: string;
  params: CwResultParams;
  environment: CwEnvironment;
  seed: number;
  exactDurationSeconds: number;
  durationSeconds: number;
  sampleCount: number;
  durationQuantizationErrorSeconds: number;
  maxSampleQuantizationErrorSeconds: number;
  requestedSnrDb: number | null;
  measuredSnrDb: number | null;
  noiseVariance: number | null;
  estimatedNoiseVariance: number | null;
  normalizationGain: number;
  peakClean: number;
  peakNoisy: number;
  keyDownSegments: CwKeyDownSegment[];
  artifacts: {
    cleanWav: CwArtifact;
    noisyWav: CwArtifact;
  };
  /** 任务中未被本契约识别、但被原样保留的顶层字段名。 */
  unrecognizedTaskFields: string[];
  /** 明确声明本模块不参与发射/执行控制且无交互。 */
  executionControl: {
    interactive: boolean;
    transmits: boolean;
    mode: string;
  };
}

/** 校验失败时抛出；code 用于 CLI 输出与测试断言。 */
export class CwContractError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CwContractError";
    this.code = code;
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
