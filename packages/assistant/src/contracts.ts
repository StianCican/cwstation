// AI-001 v1：只读台站建议契约。
//
// 本模块只做两件事：严格校验 version1 配置与 StationState 快照，并把快照
// 交给 disabled/mock/chat-completions 三种后端之一生成“建议文本”。
//
// 安全边界（与 ADR0005 一致）：
// - 不连接 daemon、不读数据库、不调用 approve/transmit/resolve/shell/串口。
// - 输出只有 advisory/provider/model/advisoryOnly，不生成任何执行命令。
// - 配置只保存 apiKeyEnv（环境变量名），不保存凭据值；联网时才读取。
// - 不向其它文件、日志或环境变量取材，只发送用户显式选择的状态快照。

/** 配置契约版本。破坏兼容性变更必须提升此版本并拒绝未知版本。 */
export const ASSISTANT_CONFIG_VERSION = 1 as const;

/** 支持的后端种类；新增后端必须同时更新校验与请求实现。 */
export const ASSISTANT_PROVIDERS = ["disabled", "mock", "chat-completions"] as const;
export type AssistantProvider = (typeof ASSISTANT_PROVIDERS)[number];

/**
 * 固定限制。请求/响应/文件上限不来自配置，避免用配置放宽安全边界。
 */
export const ASSISTANT_LIMITS = {
  /** 配置文件读取上限（字节）。 */
  CONFIG_FILE_MAX_BYTES: 64 * 1024,
  /** 状态快照读取上限（字节）。 */
  STATE_FILE_MAX_BYTES: 64 * 1024,
  TIMEOUT_MS_MIN: 100,
  TIMEOUT_MS_MAX: 120_000,
  TIMEOUT_MS_DEFAULT: 30_000,
  MAX_OUTPUT_TOKENS_MIN: 1,
  MAX_OUTPUT_TOKENS_MAX: 4096,
  MAX_OUTPUT_TOKENS_DEFAULT: 256,
  /** 响应体读取上限（字节）；超出立即中止读取。 */
  RESPONSE_MAX_BYTES: 64 * 1024,
  /** 建议文本字符上限；超出视为无效输出。 */
  ADVISORY_MAX_CHARS: 4_000,
  MODEL_MAX_CHARS: 128,
  API_KEY_ENV_MAX_CHARS: 128,
  BLOCKED_REASON_MAX_CHARS: 500,
  FREQUENCY_HZ_MAX: 1_000_000_000,
  GENERATION_MAX: Number.MAX_SAFE_INTEGER,
} as const;

/** 已校验的 version1 配置。endpoint/model/apiKeyEnv 允许为空（按 provider 决定）。 */
export interface AssistantConfig {
  version: typeof ASSISTANT_CONFIG_VERSION;
  provider: AssistantProvider;
  /** chat-completions 必填；disabled/mock 可为 null。 */
  endpoint: string | null;
  model: string | null;
  /** 只保存环境变量名，绝不保存凭据值。 */
  apiKeyEnv: string | null;
  timeoutMs: number;
  maxOutputTokens: number;
}

/**
 * 与 `packages/contracts` 的 StationState 对齐的只读快照。
 * 这里有意重复声明而不 import 运行时模块：AI 进程独立于控制核心，
 * 字段集固定，核心新增字段会先被本层拒绝而不是被静默上传。
 */
export interface StationStateSnapshot {
  frequencyHz: number;
  mode: "CW";
  txBusy: boolean;
  backendConnected: boolean;
  generation: number;
  blockedReason: string | null;
}

/** explain 的唯一成功输出载荷；advisoryOnly 恒为字面量 true。 */
export interface AssistantAdvisory {
  advisory: string;
  provider: AssistantProvider;
  model: string;
  advisoryOnly: true;
}

/** 校验/后端失败时抛出；code 为确定性错误码，用于 CLI 输出与测试断言。 */
export class AssistantError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AssistantError";
    this.code = code;
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
