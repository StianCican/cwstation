// AI-001 v1：只读建议生成。
//
// disabled：不联网，明确声明 AI 不可用。
// mock    ：本地确定性输出，不联网，用于自测与离线演示。
// chat-completions：通过 chat.ts 的共用传输发送状态快照。
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
import { requestChatCompletion, type ChatDeps, type ChatMessage } from "./chat.js";
import { parseAssistantConfig, parseStationState } from "./validate.js";

/** Prompt requests advice; actual isolation comes from having no execution tools. */
const SYSTEM_PROMPT =
  "You are a read-only assistant for an amateur radio CW station. " +
  "Explain the provided station state and suggest operator options in plain text. " +
  "You must not issue commands, approvals, or transmit intents; never output shell, device, or RPC commands.";

const DISABLED_ADVISORY =
  "AI 不可用：provider 为 disabled，未发送任何网络请求；台站与人工操作不受影响。";

export type ExplainDeps = ChatDeps;

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

function explainMessages(state: StationStateSnapshot): ChatMessage[] {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    // 只发送用户显式选择的状态快照；不附加其它上下文。
    { role: "user", content: `Station state snapshot (JSON): ${JSON.stringify(state)}` },
  ];
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
      const content = await requestChatCompletion(config, explainMessages(state), deps);
      // 保持原 explain 输出语义：去掉首尾空白后非空且不超过建议上限。
      const advisory = content.trim();
      if (advisory.length === 0) throw new AssistantError("empty_output", "backend returned empty assistant text");
      if (advisory.length > ASSISTANT_LIMITS.ADVISORY_MAX_CHARS) {
        throw new AssistantError("output_too_large", `advisory exceeds ${ASSISTANT_LIMITS.ADVISORY_MAX_CHARS} characters`);
      }
      return {
        advisory,
        provider: "chat-completions",
        model: config.model ?? "unknown",
        advisoryOnly: true,
      };
    }
  }
}
