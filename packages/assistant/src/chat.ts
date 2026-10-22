// Shared chat-completions transport for assistant features.
//
// explainState and the receive reply session both use this one transport. It
// owns the endpoint/credential/environment handling, the fixed request envelope,
// the bounded response body, redirect refusal, no-retry rule and external abort.
// Callers own their prompts and their own interpretation of the returned text.

import { ASSISTANT_LIMITS, AssistantError, type AssistantConfig } from "./contracts.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResponseMetadata {
  readonly finishReason: "stop" | "length" | "content_filter" | "tool_calls" | "insufficient_system_resource" | "aborted" | "other" | null;
  readonly contentChars: number | null;
  readonly reasoningChars: number | null;
}

export interface ChatRequestOptions {
  readonly responseFormat?: "json_object";
  readonly thinking?: "disabled";
}

export interface ChatDeps {
  /** 注入 fetch，便于测试；默认使用全局 fetch。 */
  fetchImpl?: typeof fetch;
  /** 读取凭据的环境变量来源；默认 process.env。 */
  env?: Record<string, string | undefined>;
  /** 外部取消；必须连 fetch 与响应体读取一起有界中止。 */
  signal?: AbortSignal;
  /** Metadata only: never backend text, reasoning, or arbitrary finish strings. */
  onResponseMetadata?: (metadata: ChatResponseMetadata) => void;
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

function buildChatRequest(
  config: AssistantConfig,
  messages: readonly ChatMessage[],
  env: Record<string, string | undefined>,
  options: ChatRequestOptions,
): ChatRequestParts {
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
    messages,
    max_tokens: config.maxOutputTokens,
    ...(options.responseFormat === undefined ? {} : { response_format: { type: options.responseFormat } }),
    ...(options.thinking === undefined ? {} : { thinking: { type: options.thinking } }),
  });
  return { url, headers, body };
}

async function readBoundedBody(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  limit: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) {
        total += value.byteLength;
        if (total > limit) {
          void reader.cancel().catch(() => undefined);
          throw new AssistantError("response_too_large", `backend response exceeds ${limit} bytes`);
        }
        chunks.push(Buffer.from(value));
      }
    }
  } catch (error) {
    if (error instanceof AssistantError) throw error;
    throw new AssistantError("network_error", "backend response read failed");
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

function parseChatCompletion(raw: Buffer, onMetadata: ChatDeps["onResponseMetadata"]): string {
  let payload: unknown;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new AssistantError("response_invalid", "backend response was not valid JSON");
  }
  const content = extractAssistantText(payload);
  const choice = (payload as { choices?: Array<{ finish_reason?: unknown; message?: { reasoning_content?: unknown } }> } | null)?.choices?.[0];
  const knownReasons = ["stop", "length", "content_filter", "tool_calls", "insufficient_system_resource", "aborted"];
  const reason = choice?.finish_reason;
  const reasoning = choice?.message?.reasoning_content;
  const metadata: ChatResponseMetadata = {
    finishReason: typeof reason !== "string" ? null
      : knownReasons.includes(reason) ? reason as ChatResponseMetadata["finishReason"] : "other",
    contentChars: content?.length ?? null,
    reasoningChars: typeof reasoning === "string" ? reasoning.length : null,
  };
  try {
    const returned = onMetadata?.(metadata) as unknown;
    if (returned !== null && typeof returned === "object" && typeof (returned as PromiseLike<unknown>).then === "function") {
      void Promise.resolve(returned).catch(() => undefined);
    }
  } catch { /* Diagnostics must not alter request completion. */ }
  if (content === null) {
    throw new AssistantError("response_invalid", "backend response did not contain assistant text");
  }
  return content;
}

/**
 * POST one chat-completions request and return the assistant content unchanged.
 *
 * `config` must already be validated by parseAssistantConfig/loadAssistantConfig.
 * The returned text is untrusted; callers must validate it before display or use.
 * External cancel and the configured timeout both cover fetch and body read, even
 * when an injected fetch ignores its AbortSignal. Late task failures are consumed
 * so they cannot become unhandled rejections or late results.
 */
export async function requestChatCompletion(
  config: AssistantConfig,
  messages: readonly ChatMessage[],
  deps: ChatDeps = {},
  options: ChatRequestOptions = {},
): Promise<string> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const env = deps.env ?? process.env;
  const external = deps.signal;
  if (external?.aborted === true) {
    throw new AssistantError("aborted", "assistant request was aborted");
  }

  const { url, headers, body } = buildChatRequest(config, messages, env, options);
  const controller = new AbortController();
  let stopReason: "timeout" | "aborted" | null = null;
  let rejectStop!: (error: unknown) => void;
  const stopPromise = new Promise<never>((_resolve, reject) => {
    rejectStop = reject;
  });
  // The race path above handles this rejection; this branch keeps a stop that
  // arrives between awaited operations from becoming an unhandled rejection.
  void stopPromise.catch(() => undefined);

  let bodyReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const cancelBody = (): void => {
    const reader = bodyReader;
    if (reader !== null) void reader.cancel().catch(() => undefined);
  };
  void stopPromise.catch(cancelBody);

  const stop = (reason: "timeout" | "aborted"): void => {
    if (stopReason !== null) return;
    stopReason = reason;
    controller.abort();
    rejectStop(
      reason === "timeout"
        ? new AssistantError("timeout", "backend request timed out")
        : new AssistantError("aborted", "assistant request was aborted"),
    );
  };
  const onExternalAbort = (): void => stop("aborted");
  external?.addEventListener("abort", onExternalAbort, { once: true });
  const timer = setTimeout(() => stop("timeout"), config.timeoutMs);

  const raceWithStop = <T>(task: Promise<T>): Promise<T> => {
    // Consume a late failure from a fetch/body task that ignores abort.
    void task.catch(() => undefined);
    return Promise.race([task, stopPromise]);
  };

  try {
    const fetchTask = (async (): Promise<Response> => {
      try {
        const response = await fetchImpl(url.toString(), {
          method: "POST",
          headers,
          body,
          redirect: "manual",
          signal: controller.signal,
        });
        if (stopReason !== null) {
          void response.body?.cancel().catch(() => undefined);
        }
        return response;
      } catch {
        if (stopReason !== null) {
          throw stopReason === "timeout"
            ? new AssistantError("timeout", "backend request timed out")
            : new AssistantError("aborted", "assistant request was aborted");
        }
        // 绝不透传原始 fetch 异常消息（可能含端点/代理细节）。
        throw new AssistantError("network_error", "backend request failed");
      }
    })();
    const response = await raceWithStop(fetchTask);
    if (stopReason !== null) {
      throw stopReason === "timeout"
        ? new AssistantError("timeout", "backend request timed out")
        : new AssistantError("aborted", "assistant request was aborted");
    }

    if (response.status >= 300 && response.status < 400) {
      controller.abort();
      void response.body?.cancel().catch(() => undefined);
      throw new AssistantError("redirect_rejected", "backend attempted a redirect; redirects are refused");
    }
    if (response.status < 200 || response.status >= 300) {
      controller.abort();
      void response.body?.cancel().catch(() => undefined);
      throw new AssistantError("http_error", `backend returned HTTP status ${response.status}`);
    }
    if (response.body === null) {
      throw new AssistantError("response_invalid", "backend response had no body");
    }
    bodyReader = response.body.getReader();
    const readTask = readBoundedBody(bodyReader, ASSISTANT_LIMITS.RESPONSE_MAX_BYTES);
    const raw = await raceWithStop(readTask);
    const content = parseChatCompletion(raw, deps.onResponseMetadata);
    const credential = config.apiKeyEnv === null ? undefined : env[config.apiKeyEnv];
    if (credential && content.includes(credential)) {
      throw new AssistantError("response_invalid", "backend response contained sensitive material");
    }
    return content;
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", onExternalAbort);
  }
}
