// AI-001 v1：只读建议生成。
//
// disabled：不联网，明确声明 AI 不可用。
// mock    ：本地确定性输出，不联网，用于自测与离线演示。
// chat-completions：标准 fetch POST 的文本子集；HTTPS 或本机 HTTP。
//
// 请求只包含配置里的 model、上限和用户选择的状态快照；不放其它文件、日志或
// 环境变量。Authorization 只在发起请求前从配置指定的环境变量读取，绝不落盘，
// 也绝不出现在任何输出或错误消息中。

import {
  ASSISTANT_LIMITS,
  AssistantError,
  type AssistantAdvisory,
  type AssistantConfig,
  type StationStateSnapshot,
} from "./contracts.js";
import { parseAssistantConfig, parseStationState } from "./validate.js";

/** Prompt requests advice; actual isolation comes from having no execution tools. */
const SYSTEM_PROMPT =
  "You are a read-only assistant for an amateur radio CW station. " +
  "Explain the provided station state and suggest operator options in plain text. " +
  "You must not issue commands, approvals, or transmit intents; never output shell, device, or RPC commands.";

const DISABLED_ADVISORY =
  "AI 不可用：provider 为 disabled，未发送任何网络请求；台站与人工操作不受影响。";

export interface ExplainDeps {
  /** 注入 fetch，便于测试；默认使用全局 fetch。 */
  fetchImpl?: typeof fetch;
  /** 读取凭据的环境变量来源；默认 process.env。 */
  env?: Record<string, string | undefined>;
}

function mockAdvisory(state: StationStateSnapshot): string {
  const lines = [
    "[mock] 只读状态解释（不联网，不包含执行命令）：",
    `频率 ${state.frequencyHz} Hz，模式 ${state.mode}，发射中 ${state.txBusy ? "是" : "否"}，` +
      `后端连接 ${state.backendConnected ? "是" : "否"}，generation ${state.generation}。`,
    `阻止原因：${state.blockedReason === null ? "无" : state.blockedReason}。`,
  ];
  if (state.blockedReason !== null) {
    lines.push("建议：当前存在阻止原因，先由操作员人工核查，再决定下一步。");
  } else if (!state.backendConnected) {
    lines.push("建议：后端未连接，先检查设备连接与配置。");
  } else if (state.txBusy) {
    lines.push("建议：当前有发射在途，等待人工确认结果后再操作。");
  } else {
    lines.push("建议：台站处于空闲且可用状态，可按操作员判断继续日常操作。");
  }
  return lines.join("\n");
}

function requireHttpUrl(endpoint: string | null): URL {
  // 配置校验已保证 chat-completions 有合法 endpoint；这里再兜底一次。
  if (endpoint === null) throw new AssistantError("invalid_config", "endpoint is required");
  return new URL(endpoint);
}

interface ChatRequestParts {
  url: URL;
  headers: Record<string, string>;
  body: string;
}

function buildChatRequest(config: AssistantConfig, state: StationStateSnapshot, env: Record<string, string | undefined>): ChatRequestParts {
  const url = requireHttpUrl(config.endpoint);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.apiKeyEnv !== null) {
    const key = env[config.apiKeyEnv];
    if (typeof key !== "string" || key.length === 0) {
      // 只报告环境变量名缺失，绝不回显其值。
      throw new AssistantError("credential_missing", `environment variable ${config.apiKeyEnv} is not set`);
    }
    headers.authorization = `Bearer ${key}`;
  }
  const body = JSON.stringify({
    model: config.model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      // 只发送用户显式选择的状态快照；不附加其它上下文。
      { role: "user", content: `Station state snapshot (JSON): ${JSON.stringify(state)}` },
    ],
    max_tokens: config.maxOutputTokens,
  });
  return { url, headers, body };
}

async function readBoundedBody(response: Response, limit: number): Promise<Buffer> {
  if (response.body === null) {
    throw new AssistantError("response_invalid", "backend response had no body");
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) {
      total += value.byteLength;
      if (total > limit) {
        try {
          await reader.cancel();
        } catch {
          // 取消失败不影响判定。
        }
        throw new AssistantError("response_too_large", `backend response exceeds ${limit} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  }
  return Buffer.concat(chunks);
}

function extractAssistantText(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const choices = (payload as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (typeof first !== "object" || first === null) return null;
  const message = (first as Record<string, unknown>).message;
  if (typeof message !== "object" || message === null) return null;
  const content = (message as Record<string, unknown>).content;
  return typeof content === "string" ? content : null;
}

function parseChatCompletion(raw: Buffer): string {
  let payload: unknown;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new AssistantError("response_invalid", "backend response was not valid JSON");
  }
  const content = extractAssistantText(payload);
  if (content === null) {
    throw new AssistantError("response_invalid", "backend response did not contain assistant text");
  }
  const advisory = content.trim();
  if (advisory.length === 0) throw new AssistantError("empty_output", "backend returned empty assistant text");
  if (advisory.length > ASSISTANT_LIMITS.ADVISORY_MAX_CHARS) {
    throw new AssistantError("output_too_large", `advisory exceeds ${ASSISTANT_LIMITS.ADVISORY_MAX_CHARS} characters`);
  }
  return advisory;
}

async function requestChatCompletion(
  config: AssistantConfig,
  state: StationStateSnapshot,
  deps: ExplainDeps,
): Promise<string> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const env = deps.env ?? process.env;
  const { url, headers, body } = buildChatRequest(config, state, env);

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.timeoutMs);

  try {
    let response: Response;
    try {
      response = await fetchImpl(url.toString(), {
        method: "POST",
        headers,
        body,
        redirect: "manual",
        signal: controller.signal,
      });
    } catch {
      // 绝不透传原始 fetch 异常消息（可能含端点/代理细节）。
      throw new AssistantError(timedOut ? "timeout" : "network_error", timedOut ? "backend request timed out" : "backend request failed");
    }

    if (response.status < 200 || response.status >= 300) {
      controller.abort();
    }
    if (response.status >= 300 && response.status < 400) {
      throw new AssistantError("redirect_rejected", "backend attempted a redirect; redirects are refused");
    }
    if (response.status < 200 || response.status >= 300) {
      throw new AssistantError("http_error", `backend returned HTTP status ${response.status}`);
    }

    let raw: Buffer;
    try {
      raw = await readBoundedBody(response, ASSISTANT_LIMITS.RESPONSE_MAX_BYTES);
    } catch (error) {
      if (error instanceof AssistantError) throw error;
      throw new AssistantError(timedOut ? "timeout" : "network_error", timedOut ? "backend request timed out" : "backend response read failed");
    }
    const advisory = parseChatCompletion(raw);
    const credential = config.apiKeyEnv === null ? undefined : env[config.apiKeyEnv];
    if (credential && advisory.includes(credential)) {
      throw new AssistantError("response_invalid", "backend response contained sensitive material");
    }
    return advisory;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 根据配置生成建议。返回对象字段固定为 advisory/provider/model/advisoryOnly，
 * 不提供命令、提案、批准或发射接口；模型文本仍是不可信内容。
 */
export async function explainState(
  state: StationStateSnapshot,
  config: AssistantConfig,
  deps: ExplainDeps = {},
): Promise<AssistantAdvisory> {
  // Validate at the shared entry point as future UI callers bypass the file loaders.
  state = parseStationState(state);
  config = parseAssistantConfig(config);
  switch (config.provider) {
    case "disabled":
      return {
        advisory: DISABLED_ADVISORY,
        provider: "disabled",
        model: config.model ?? "disabled",
        advisoryOnly: true,
      };
    case "mock":
      return {
        advisory: mockAdvisory(state),
        provider: "mock",
        model: config.model ?? "mock",
        advisoryOnly: true,
      };
    case "chat-completions": {
      const advisory = await requestChatCompletion(config, state, deps);
      return {
        advisory,
        provider: "chat-completions",
        model: config.model ?? "unknown",
        advisoryOnly: true,
      };
    }
  }
}
