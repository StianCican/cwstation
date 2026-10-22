// V00-03-A/E：单轮收报回复提案与本地 CQ 快速回复专项。
// 使用项目内临时目录、Node 短生命周期解码夹具和 127.0.0.1 脚本化 HTTP；
// 不访问外网、不读取真实凭据、不启动真实模型/电台/麦克风。

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./helpers.js";
import {
  AssistantError,
  CQ_QUICK_REPLY_RULE,
  ReplyError,
  createReplySession,
  explainState,
  matchCqQuickReply,
  parseAssistantConfig,
  parseContinuousProposal,
  parseReplyProposal,
  requestChatCompletion,
  validateReplyCalls,
  type AssistantConfig,
  type ReplyProposalEvent,
  type ReplySession,
  type ReplySessionEvent,
} from "../packages/assistant/src/index.js";
import { runReceive } from "../apps/rig-receive.js";
import { ReplyDispatchControl } from "../apps/reply-dispatch-control.js";
import type { PcmByteSource } from "../packages/receive/src/index.js";
import { buildTimeline, encodeCwText, normalizeCwText } from "../packages/signal/src/index.js";
import { CwTrialRecordStore, createCwTrialSimulatorTransport } from "../packages/cw-trial/src/index.js";

type JsonRecord = Record<string, unknown>;

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(ROOT, "tests", ".tmp-receive-reply-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chatConfig(overrides: Record<string, unknown> = {}): AssistantConfig {
  return parseAssistantConfig({
    version: 1,
    provider: "chat-completions",
    endpoint: "https://api.example.invalid/v1/chat/completions",
    model: "test-model",
    apiKeyEnv: null,
    timeoutMs: 5_000,
    maxOutputTokens: 64,
    ...overrides,
  });
}

function mockConfig(): AssistantConfig {
  return parseAssistantConfig({ version: 1, provider: "mock", model: "mock-model" });
}

function disabledConfig(): AssistantConfig {
  return parseAssistantConfig({ version: 1, provider: "disabled" });
}

type Collected = ReplySessionEvent[] & { readonly onEvent: (event: ReplySessionEvent) => void };

function collected(): Collected {
  const events: ReplySessionEvent[] = [];
  const result = events as Collected;
  Object.defineProperty(result, "onEvent", {
    enumerable: false,
    value: (event: ReplySessionEvent): void => { events.push(event); },
  });
  return result;
}

function session(
  config: AssistantConfig,
  events: Collected,
  options: {
    idleMs?: number;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    continuous?: boolean;
    prepared?: boolean;
    budgetMs?: number;
    wpm?: number;
    monotonicNow?: () => number;
  } = {},
): ReplySession {
  const deps = {
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.monotonicNow === undefined ? {} : { monotonicNow: options.monotonicNow }),
  };
  return createReplySession({
    config,
    ownCall: "B1AA",
    peerCall: "B2BB",
    sessionId: "reply-test",
    ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
    ...(options.continuous === true ? { continuous: true } : {}),
    ...(options.prepared === true ? { prepared: true } : {}),
    ...(options.budgetMs === undefined ? {} : { budgetMs: options.budgetMs }),
    ...(options.wpm === undefined ? {} : { wpm: options.wpm }),
    onEvent: events.onEvent,
    ...(Object.keys(deps).length === 0 ? {} : { deps }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for reply event");
    await sleep(10);
  }
}

function replies(events: readonly ReplySessionEvent[]): ReplyProposalEvent[] {
  return events.filter((event): event is ReplyProposalEvent => event.type === "reply");
}

function chatResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function replyContent(value: unknown): string {
  return JSON.stringify(value);
}

function sourceOf(chunks: readonly Uint8Array[]): PcmByteSource {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
      for (const chunk of chunks) yield chunk;
    },
  };
}

// ── 组报/边界/缓冲 ─────────────────────────────────────────────────────

test("reply session: spaces are preserved, empty input makes no call, finish is idempotent", async () => {
  const events = collected();
  const reply = session(mockConfig(), events);
  reply.push("CQ TEST");
  reply.push(" ");
  reply.push("DE B1AA");
  const result = await reply.finish();
  assert.equal(result.status, "published");
  assert.deepEqual(events.filter((event) => event.type === "utterance").map((event) => event.receivedText), ["CQ TEST DE B1AA"]);
  const utterance = events.find((event) => event.type === "utterance");
  assert.equal(utterance?.boundary, "eof");
  assert.equal(utterance?.advisoryOnly, true);
  const firstReply = replies(events)[0]!;
  assert.equal(firstReply.provider, "mock");
  assert.equal(firstReply.validated, true);
  assert.equal(firstReply.action, "reply");
  assert.equal(firstReply.text, "B2BB DE B1AA K", "address peer first and identify own station after DE");
  assert.equal(firstReply.advisoryOnly, true);
  assert.equal(firstReply.readOnly, true);

  const before = events.length;
  await reply.finish();
  reply.push("SHOULD NOT START A SECOND TURN");
  const invalidated = await reply.finish();
  assert.equal(invalidated.status, "invalidated");
  assert.equal(invalidated.reply, null, "a revoked proposal must not remain available via finish");
  assert.equal(replies(events).length, 1);
  assert.equal(events.filter((event) => event.type === "utterance").length, 1);
  assert.equal(events.length, before + 1, "post-proposal text only emits one invalidation");
  assert.equal(events.at(-1)?.type, "invalidated");

  const emptyEvents = collected();
  const empty = session(mockConfig(), emptyEvents);
  empty.push(" ");
  empty.push("   ");
  const emptyResult = await empty.finish();
  assert.equal(emptyResult.status, "empty");
  assert.equal(emptyEvents.length, 0);
});

test("reply session: idle is timed from the latest non-whitespace character", async () => {
  const events = collected();
  const reply = session(mockConfig(), events, { idleMs: 1_000 });
  reply.push("CQ");
  await sleep(450);
  reply.push(" ");
  await sleep(700);
  // 450 + 700 > 1000 from the last non-whitespace; a space must not reset it.
  assert.equal(events.filter((event) => event.type === "utterance").length, 1);
  const utterance = events.find((event) => event.type === "utterance");
  assert.equal(utterance?.boundary, "idle");
  assert.equal(utterance?.receivedText, "CQ ");
  const result = await reply.finish();
  assert.equal(result.status, "published");
  assert.equal(replies(events)[0]?.text, "B2BB DE B1AA K");
});

test("reply session: 1024-character boundary is accepted and overflow fails before any model call", async () => {
  const acceptedEvents = collected();
  const accepted = session(mockConfig(), acceptedEvents);
  accepted.push("A".repeat(1_024));
  const acceptedResult = await accepted.finish();
  assert.equal(acceptedResult.status, "published");
  assert.equal(acceptedEvents.find((event) => event.type === "utterance")?.receivedText.length, 1_024);

  let calls = 0;
  const fakeFetch = (async () => {
    calls += 1;
    return chatResponse(replyContent({ action: "reply", text: "B1AA DE B2BB K", reason: "ok" }));
  }) as unknown as typeof fetch;
  const overflowEvents = collected();
  const overflow = session(chatConfig(), overflowEvents, { fetchImpl: fakeFetch });
  overflow.push("A".repeat(1_025));
  const overflowResult = await overflow.finish();
  assert.equal(overflowResult.status, "failed");
  assert.equal(calls, 0);
  assert.equal(replies(overflowEvents)[0]?.validated, false);
  assert.equal(replies(overflowEvents)[0]?.errorCode, "buffer_limit");
});

// ── 严格 JSON / 回复字节与字符限制 ────────────────────────────────────

test("reply model output: only exact action/text/reason JSON is accepted", async () => {
  const cases: Array<{ name: string; content: string; valid: boolean; action?: string; text?: string; code?: string }> = [
    { name: "valid reply", content: replyContent({ action: "reply", text: "B1AA DE B2BB K", reason: "short" }), valid: true, action: "reply", text: "B1AA DE B2BB K" },
    { name: "valid no_reply", content: replyContent({ action: "no_reply", text: "", reason: "unclear" }), valid: true, action: "no_reply", text: "" },
    { name: "extra field", content: replyContent({ action: "reply", text: "B1AA", reason: "ok", extra: 1 }), valid: false, code: "reply_output_invalid" },
    { name: "code fence", content: "```json\n{\"action\":\"reply\",\"text\":\"B1AA\",\"reason\":\"ok\"}\n```", valid: false, code: "reply_output_invalid" },
    { name: "lowercase", content: replyContent({ action: "reply", text: "b1aa de b2bb k", reason: "ok" }), valid: false, code: "reply_output_invalid" },
    { name: "continuous keying", content: replyContent({ action: "reply", text: "B1AA^", reason: "ok" }), valid: false, code: "reply_output_invalid" },
    { name: "over 30 bytes", content: replyContent({ action: "reply", text: "A".repeat(31), reason: "ok" }), valid: false, code: "reply_output_invalid" },
    { name: "empty reply", content: replyContent({ action: "reply", text: "", reason: "ok" }), valid: false, code: "reply_output_invalid" },
    { name: "no_reply text", content: replyContent({ action: "no_reply", text: " ", reason: "ok" }), valid: false, code: "reply_output_invalid" },
    { name: "reason too long", content: replyContent({ action: "no_reply", text: "", reason: "x".repeat(301) }), valid: false, code: "reply_output_invalid" },
    { name: "reason control", content: replyContent({ action: "no_reply", text: "", reason: "line\nbreak" }), valid: false, code: "reply_output_invalid" },
    { name: "unknown action", content: replyContent({ action: "maybe", text: "", reason: "ok" }), valid: false, code: "reply_output_invalid" },
  ];
  for (const item of cases) {
    let calls = 0;
    const fakeFetch = (async () => {
      calls += 1;
      return chatResponse(item.content);
    }) as unknown as typeof fetch;
    const events = collected();
    const reply = session(chatConfig(), events, { fetchImpl: fakeFetch });
    reply.push("CQ TEST");
    const result = await reply.finish();
    const proposal = replies(events)[0]!;
    assert.equal(calls, 1, item.name);
    assert.equal(result.status, item.valid ? "published" : "failed", item.name);
    assert.equal(proposal.validated, item.valid, item.name);
    if (item.valid) {
      assert.equal(proposal.action, item.action, item.name);
      assert.equal(proposal.text, item.text, item.name);
      assert.equal(proposal.errorCode, null, item.name);
    } else {
      assert.equal(proposal.action, null, item.name);
      assert.equal(proposal.text, "", item.name);
      assert.equal(proposal.errorCode, item.code, item.name);
      assert.doesNotMatch(JSON.stringify(proposal), /```|line\\nbreak|31/, item.name);
    }
    assert.equal(JSON.stringify(proposal).includes("choices"), false);
  }
});

test("reply calls and parser are strict about identity and JSON shape", () => {
  assert.deepEqual(validateReplyCalls("B1AA", "B2BB/7"), { ownCall: "B1AA", peerCall: "B2BB/7" });
  for (const [own, peer] of [
    ["b1aa", "B2BB"],
    ["B1AA", "B1AA"],
    ["B", "B2BB"],
    ["B1AA", "B2BB_"],
    ["BAAA", "B2BB"],
    ["1234", "B2BB"],
    ["B1AA", "B2BBBBBBBBBBB"],
  ] as const) {
    assert.throws(
      () => validateReplyCalls(own, peer),
      (error: unknown) => error instanceof ReplyError && error.code === "invalid_calls",
    );
  }
  assert.throws(() => parseReplyProposal("not json"), (error: unknown) => error instanceof ReplyError && error.code === "reply_output_invalid");
  assert.deepEqual(parseReplyProposal(replyContent({ action: "reply", text: "B1AA", reason: "" })), {
    action: "reply",
    text: "B1AA",
    reason: "",
  });
});

// ── 撤销/取消/迟到结果 ─────────────────────────────────────────────────

test("published reply and no_reply become unavailable after new text, including cached finish", async () => {
  for (const config of [mockConfig(), disabledConfig()]) {
    const events = collected();
    const reply = session(config, events);
    reply.push("CQ TEST");
    assert.equal((await reply.finish()).status, "published");
    reply.push(" NEW");
    const result = await reply.finish();
    assert.equal(result.status, "invalidated");
    assert.equal(result.reply, null);
    assert.equal(events.at(-1)?.type, "invalidated");
    reply.push(" MORE");
    assert.equal(events.filter((event) => event.type === "invalidated").length, 1);
  }
});

test("in-flight model result is aborted and suppressed after new receive text", async () => {
  let calls = 0;
  let release!: (content: string) => void;
  const fakeFetch = (async () => {
    calls += 1;
    // Ignore the AbortSignal and resolve late: the session must still not publish this.
    const content = await new Promise<string>((resolve) => { release = resolve; });
    return chatResponse(content);
  }) as unknown as typeof fetch;
  const events = collected();
  const reply = session(chatConfig(), events, { fetchImpl: fakeFetch });
  reply.push("CQ TEST");
  const finished = reply.finish();
  await sleep(30);
  reply.push("NEW");
  const result = await finished;
  assert.equal(result.status, "invalidated");
  assert.equal(calls, 1, "no retry");
  assert.equal(replies(events).length, 0);
  assert.equal(events.filter((event) => event.type === "invalidated").length, 1);
  release(replyContent({ action: "reply", text: "B1AA DE B2BB K", reason: "late" }));
  await sleep(60);
  assert.equal(replies(events).length, 0, "late model result must be suppressed");
});

test("cancel during a never-settling model resolves bounded with no late reply event", async () => {
  const events = collected();
  const controller = new AbortController();
  const fakeFetch = (async () => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
  const reply = session(chatConfig(), events, { fetchImpl: fakeFetch, signal: controller.signal });
  reply.push("CQ TEST");
  const finished = reply.finish();
  await sleep(20);
  const started = Date.now();
  controller.abort();
  const result = await finished;
  assert.ok(Date.now() - started < 1_000, "cancel must be bounded even if fetch ignores abort");
  assert.equal(result.status, "canceled");
  assert.equal(replies(events).length, 0);
  await sleep(60);
  assert.equal(replies(events).length, 0);
});

test("external abort bounds fetch and response-body reads even when fetch ignores abort", async () => {
  const messages = [{ role: "user" as const, content: "x" }];
  const neverFetch = (async () => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
  const neverController = new AbortController();
  const never = requestChatCompletion(chatConfig(), messages, { fetchImpl: neverFetch, signal: neverController.signal });
  setTimeout(() => neverController.abort(), 20);
  const started = Date.now();
  await assert.rejects(never, (error: unknown) => error instanceof AssistantError && error.code === "aborted");
  assert.ok(Date.now() - started < 1_000);

  const bodyController = new AbortController();
  const bodyFetch = (async () => new Response(new ReadableStream<Uint8Array>({ start() { /* never enqueues */ } }), { status: 200 })) as unknown as typeof fetch;
  const body = requestChatCompletion(chatConfig(), messages, { fetchImpl: bodyFetch, signal: bodyController.signal });
  setTimeout(() => bodyController.abort(), 20);
  const bodyStarted = Date.now();
  await assert.rejects(body, (error: unknown) => error instanceof AssistantError && error.code === "aborted");
  assert.ok(Date.now() - bodyStarted < 1_000);

  const lateController = new AbortController();
  const lateFetch = (async () => {
    await sleep(80);
    return chatResponse("late success");
  }) as unknown as typeof fetch;
  const late = requestChatCompletion(chatConfig(), messages, { fetchImpl: lateFetch, signal: lateController.signal });
  setTimeout(() => lateController.abort(), 10);
  await assert.rejects(late, (error: unknown) => error instanceof AssistantError && error.code === "aborted");
  await sleep(100);
});

test("late fetch response body is canceled after the request has already been aborted", async () => {
  let release!: (response: Response) => void;
  let canceled = false;
  const controller = new AbortController();
  const request = requestChatCompletion(chatConfig(), [{ role: "user", content: "x" }], {
    signal: controller.signal,
    fetchImpl: (async () => new Promise<Response>((resolve) => { release = resolve; })) as typeof fetch,
  });
  controller.abort();
  await assert.rejects(request, (error: unknown) => error instanceof AssistantError && error.code === "aborted");
  release(new Response(new ReadableStream<Uint8Array>({ cancel() { canceled = true; } })));
  await sleep(20);
  assert.equal(canceled, true);
});

// ── disabled / mock / 共用 HTTP 传输 ───────────────────────────────────

test("disabled and mock are local and visibly distinct", async () => {
  let calls = 0;
  const fakeFetch = (async () => { calls += 1; return chatResponse("{}"); }) as unknown as typeof fetch;
  const disabledEvents = collected();
  const disabled = session(disabledConfig(), disabledEvents, { fetchImpl: fakeFetch });
  disabled.push("CQ TEST");
  await disabled.finish();
  const disabledReply = replies(disabledEvents)[0]!;
  assert.equal(disabledReply.provider, "disabled");
  assert.equal(disabledReply.action, "no_reply");
  assert.equal(disabledReply.text, "");
  assert.equal(disabledReply.validated, true);

  const one = collected();
  const two = collected();
  const first = session(mockConfig(), one, { fetchImpl: fakeFetch });
  const second = session(mockConfig(), two, { fetchImpl: fakeFetch });
  first.push("CQ TEST");
  second.push("CQ TEST");
  await first.finish();
  await second.finish();
  assert.equal(calls, 0, "disabled/mock must not use the network");
  assert.equal(replies(one)[0]?.provider, "mock");
  assert.equal(replies(one)[0]?.text, replies(two)[0]?.text);
  assert.equal(parseReplyProposal(replyContent({ action: "reply", text: replies(one)[0]?.text ?? "", reason: "" })).action, "reply");
});

interface Recorded {
  body: string;
}

async function startServer(t: TestContext, content: string): Promise<{ endpoint: string; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { body += chunk; });
    req.on("end", () => {
      requests.push({ body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { endpoint: `http://127.0.0.1:${port}/v1/chat/completions`, requests };
}

test("shared HTTP transport sends the strict reply prompt and parses the scripted response", async (t) => {
  const server = await startServer(t, replyContent({ action: "reply", text: "B1AA DE B2BB K", reason: "brief" }));
  const events = collected();
  const reply = session(chatConfig({ endpoint: server.endpoint, maxOutputTokens: 77 }), events);
  reply.push("CQ TEST DE B1AA");
  const result = await reply.finish();
  assert.equal(result.status, "published");
  assert.equal(server.requests.length, 1);
  const body = JSON.parse(server.requests[0]!.body) as {
    model: string;
    max_tokens: number;
    messages: Array<{ role: string; content: string }>;
  };
  assert.equal(body.model, "test-model");
  assert.equal(body.max_tokens, 77);
  assert.equal(body.messages.length, 2);
  assert.match(body.messages[0]!.content, /strict JSON/);
  assert.match(body.messages[0]!.content, /uppercase ASCII/);
  assert.match(body.messages[1]!.content, /Own call: B1AA/);
  assert.match(body.messages[1]!.content, /Peer call: B2BB/);
  assert.match(body.messages[1]!.content, /Received text: CQ TEST DE B1AA/);
  const proposal = replies(events)[0]!;
  assert.equal(proposal.provider, "chat-completions");
  assert.equal(proposal.model, "test-model");
  assert.equal(proposal.validated, true);
  assert.equal(proposal.text, "B1AA DE B2BB K");
  assert.equal(proposal.advisoryOnly, true);
  for (const forbidden of ["executable", "frame", "approval", "transmit"]) {
    assert.equal(forbidden in proposal, false);
  }
});

test("DeepSeek replies explicitly disable thinking and request JSON without changing other endpoints", async () => {
  for (const endpoint of ["https://api.deepseek.com/chat/completions", "https://api.deepseek.com.example.invalid/chat/completions", "http://127.0.0.1/v1/chat/completions"]) {
    let body: JsonRecord = {};
    const fakeFetch = (async (_url: unknown, init: RequestInit | undefined) => {
      body = JSON.parse(String(init?.body)) as JsonRecord;
      return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: {
        content: replyContent({ action: "no_reply", text: "", reason: "unclear" }),
        reasoning_content: "",
      } }] }));
    }) as typeof fetch;
    const events = collected();
    const reply = session(chatConfig({ endpoint, model: "deepseek-flash" }), events, { fetchImpl: fakeFetch });
    reply.push("CQ TEST");
    const result = await reply.finish();
    assert.equal(result.status, "published");
    if (new URL(endpoint).hostname === "api.deepseek.com") {
      assert.deepEqual(body.thinking, { type: "disabled" });
      assert.deepEqual(body.response_format, { type: "json_object" });
    } else {
      assert.equal("thinking" in body, false);
      assert.equal("response_format" in body, false);
    }
    assert.equal(replies(events)[0]?.diagnostics?.finishReason, "stop");
    assert.equal(replies(events)[0]?.diagnostics?.reasoningChars, 0);
  }
});

test("DeepSeek explanation retains its original plain-text request defaults", async () => {
  let body: JsonRecord = {};
  const fakeFetch = (async (_url: unknown, init: RequestInit | undefined) => {
    body = JSON.parse(String(init?.body)) as JsonRecord;
    return chatResponse("  operator advice  ");
  }) as typeof fetch;
  const result = await explainState({ frequencyHz: 14030000, mode: "CW", txBusy: false,
    backendConnected: true, generation: 1, blockedReason: null },
  chatConfig({ endpoint: "https://api.deepseek.com/chat/completions", model: "deepseek-flash" }),
  { fetchImpl: fakeFetch });
  assert.equal(result.advisory, "operator advice");
  assert.equal("thinking" in body, false);
  assert.equal("response_format" in body, false);
  assert.deepEqual(Object.keys(result).sort(), ["advisory", "advisoryOnly", "model", "provider"]);
});

test("reply diagnostics classify incomplete and illegal output without leaking backend strings", async () => {
  const marker = "PRIVATE_BACKEND_TEXT";
  const cases = [
    { finish: "length", content: replyContent({ action: "no_reply", text: "", reason: "valid JSON but truncated turn" }), failure: "response_incomplete" },
    { finish: "stop", content: marker, failure: "json_invalid" },
    { finish: "stop", content: replyContent({ action: "no_reply", text: "", reason: "ok", extra: marker }), failure: "schema_invalid" },
    { finish: "stop", content: replyContent({ action: "reply", text: "^", reason: "ok" }), failure: "text_invalid" },
    { finish: "stop", content: replyContent({ action: "no_reply", text: "", reason: "x".repeat(301) }), failure: "reason_invalid" },
    { finish: marker, content: "{}", failure: "response_incomplete" },
  ];
  for (const item of cases) {
    let calls = 0;
    const fakeFetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ choices: [{ finish_reason: item.finish, message: {
        content: item.content, reasoning_content: marker,
      } }] }));
    }) as typeof fetch;
    const events = collected();
    const reply = session(chatConfig(), events, { fetchImpl: fakeFetch });
    reply.push("CQ TEST");
    assert.equal((await reply.finish()).status, "failed");
    const failure = replies(events)[0]!;
    assert.equal(failure.errorCode, "reply_output_invalid");
    assert.equal(failure.diagnostics?.validationFailure, item.failure);
    assert.equal(failure.diagnostics?.contentChars, item.content.length);
    assert.equal(failure.diagnostics?.reasoningChars, marker.length);
    assert.equal(failure.diagnostics?.finishReason, item.finish === marker ? "other" : item.finish);
    assert.equal(JSON.stringify(events).includes(marker), false);
    assert.equal(calls, 1);
  }
});

// ── V00-03-C 连续上下文、自主 wait/end、预算与限额 ─────────────────────

test("continuous reply: second request carries the real received turn and an explicitly unsent proposal", async () => {
  const bodies: string[] = [];
  const contents = [
    replyContent({ action: "reply", text: "B2BB DE B1AA K", reason: "answer the call" }),
    replyContent({ action: "end", text: "", reason: "QSO complete" }),
  ];
  const fakeFetch = (async (_url: unknown, init: RequestInit | undefined) => {
    bodies.push(String(init?.body));
    return chatResponse(contents[bodies.length - 1]!);
  }) as typeof fetch;
  const events = collected();
  const reply = session(chatConfig(), events, { fetchImpl: fakeFetch, continuous: true, idleMs: 1000, wpm: 25 });
  reply.push("CQ TEST DE B2BB K");
  await waitFor(() => replies(events).length === 1);
  const first = replies(events)[0]!;
  assert.equal(first.action, "reply");
  assert.equal(first.continuous, true);
  assert.equal(first.turnIndex, 1);
  assert.ok((first.timing?.totalMs ?? -1) >= 0);
  const expected = Math.round(
    buildTimeline(encodeCwText(normalizeCwText("B2BB DE B1AA K")), 22_050, 25).exactDurationSeconds * 1000 * 10,
  ) / 10;
  assert.equal(first.timing?.estimatedDurationMs, expected);
  assert.equal(first.timing?.wpmDeclaredOnly, true);

  reply.push("B2BB DE B1AA K");
  assert.equal(events.at(-1)?.type, "invalidated", "new input must revoke the displayed proposal immediately");
  await waitFor(() => events.some((event) => event.type === "ended"));
  const result = await reply.finish();
  assert.equal(result.status, "ended");
  assert.equal(result.endReason, "model_end");
  assert.equal(result.turns, 2);
  assert.equal(bodies.length, 2);
  const second = JSON.parse(bodies[1]!) as { messages: Array<{ content: string }> };
  const prompt = second.messages[1]!.content;
  assert.match(prompt, /CQ TEST DE B2BB K/, "the first real received turn must be present");
  assert.match(prompt, /B2BB DE B1AA K/, "the earlier proposal must be present");
  assert.match(prompt, /proposal NOT SENT/);
  assert.match(prompt, /nothing here was transmitted/);
  assert.match(prompt, /Current received text: B2BB DE B1AA K/);
  assert.doesNotMatch(prompt, /was sent/i);
  assert.equal(events.filter((event) => event.type === "reply").length, 2);
  assert.equal(events.filter((event) => event.type === "ended").length, 1);
});

test("continuous reply keeps the public idle floor and stops on context overflow before requesting", async () => {
  assert.throws(() => session(mockConfig(), collected(), { continuous: true, idleMs: 20 }),
    (error: unknown) => error instanceof ReplyError && error.code === "invalid_idle");
  let calls = 0;
  const fakeFetch = (async () => { calls++; return chatResponse("{}"); }) as typeof fetch;
  const events = collected();
  const reply = session(chatConfig(), events, { continuous: true, fetchImpl: fakeFetch });
  reply.push("X".repeat(1025));
  assert.equal((await reply.finish()).endReason, "context_limit");
  assert.equal(calls, 0);
  assert.equal(events.at(-1)?.type, "ended");
});

test("continuous reply checks elapsed deadline even before its timer callback runs", async () => {
  let now = 0;
  const events = collected();
  const fakeFetch = (async () => {
    now = 101;
    return chatResponse(replyContent({ action: "reply", text: "B1AA K", reason: "late" }));
  }) as typeof fetch;
  const reply = session(chatConfig(), events, {
    continuous: true, budgetMs: 100, fetchImpl: fakeFetch, monotonicNow: () => now,
  });
  reply.push("CQ TEST");
  await reply.finish();
  assert.equal(replies(events)[0]?.validated, false);
  assert.equal(replies(events)[0]?.errorCode, "budget_exceeded");
  assert.equal(replies(events)[0]?.timing?.modelMs, 101);
});

test("continuous reply: wait does not retry and end stops all later requests", async () => {
  const bodies: string[] = [];
  const fakeFetch = (async (_url: unknown, init: RequestInit | undefined) => {
    bodies.push(String(init?.body));
    return chatResponse(bodies.length === 1
      ? replyContent({ action: "wait", text: "", reason: "signal incomplete" })
      : replyContent({ action: "end", text: "", reason: "done" }));
  }) as typeof fetch;
  const events = collected();
  const reply = session(chatConfig(), events, { fetchImpl: fakeFetch, continuous: true, idleMs: 1000 });
  reply.push("CQ TEST");
  await waitFor(() => replies(events).length === 1);
  assert.equal(replies(events)[0]?.action, "wait");
  await sleep(80);
  assert.equal(bodies.length, 1, "wait must not poll the same received data again");
  assert.equal(replies(events).length, 1);

  reply.push("DE B2BB");
  await waitFor(() => events.some((event) => event.type === "ended"));
  assert.equal(bodies.length, 2);
  assert.equal(replies(events)[1]?.action, "end");
  const result = await reply.finish();
  assert.equal(result.endReason, "model_end");
  reply.push("AFTER END");
  await sleep(40);
  assert.equal(bodies.length, 2, "end must stop every later request");
  assert.equal((await reply.finish()).status, "ended");
});

test("continuous reply: model budget aborts a slow request and suppresses the late result", async () => {
  let calls = 0;
  const fakeFetch = (async () => {
    calls += 1;
    await sleep(300);
    return chatResponse(replyContent({ action: "reply", text: "B1AA DE B2BB K", reason: "late" }));
  }) as typeof fetch;
  const events = collected();
  const reply = session(chatConfig(), events, { fetchImpl: fakeFetch, continuous: true, idleMs: 1000, budgetMs: 100 });
  reply.push("CQ TEST");
  await waitFor(() => replies(events).length === 1, 2_000);
  const failure = replies(events)[0]!;
  assert.equal(failure.validated, false);
  assert.equal(failure.errorCode, "budget_exceeded");
  assert.equal(failure.timing?.budgetExceeded, true);
  assert.equal(failure.diagnostics?.validationFailure, "budget_exceeded");
  await sleep(350);
  assert.equal(calls, 1);
  assert.equal(replies(events).length, 1, "a late result after the budget must not be published");
  assert.equal((await reply.finish()).status, "ended");
});

test("continuous reply: new receive text aborts in-flight work, merges text and keeps one request path", async () => {
  let calls = 0;
  let releaseFirst!: (response: Response) => void;
  const bodies: string[] = [];
  const fakeFetch = (async (_url: unknown, init: RequestInit | undefined) => {
    calls += 1;
    bodies.push(String(init?.body));
    if (calls === 1) return new Promise<Response>((resolve) => { releaseFirst = resolve; });
    return chatResponse(replyContent({ action: "end", text: "", reason: "merged turn complete" }));
  }) as typeof fetch;
  const events = collected();
  const reply = session(chatConfig(), events, { fetchImpl: fakeFetch, continuous: true, idleMs: 1000 });
  reply.push("CQ TEST");
  await waitFor(() => calls === 1);
  reply.push(" DE B2BB");
  await waitFor(() => calls === 2);
  const invalidated = events.find((event) => event.type === "invalidated");
  assert.equal(invalidated?.type, "invalidated");
  const second = JSON.parse(bodies[1]!) as { messages: Array<{ content: string }> };
  const prompt = second.messages[1]!.content;
  assert.match(prompt, /Current received text: CQ TEST DE B2BB/, "pending text must be merged");
  assert.match(prompt, /in-flight proposal NOT SENT \(invalidated\)/);
  releaseFirst(chatResponse(replyContent({ action: "reply", text: "LATE", reason: "late" })));
  await waitFor(() => events.some((event) => event.type === "ended"));
  await sleep(40);
  assert.equal(replies(events).length, 1, "the aborted result must never publish");
  assert.equal(replies(events)[0]?.action, "end");
  assert.equal((await reply.finish()).endReason, "model_end");
});

test("continuous reply: turn limit stops explicitly after twelve turns and keeps history", async () => {
  let calls = 0;
  const fakeFetch = (async () => {
    calls += 1;
    return chatResponse(replyContent({ action: "reply", text: "B1AA K", reason: "keep going" }));
  }) as typeof fetch;
  const events = collected();
  const reply = session(chatConfig(), events, { fetchImpl: fakeFetch, continuous: true, idleMs: 1000 });
  for (let turn = 1; turn <= 12; turn += 1) {
    reply.push(`TURN ${turn}`);
    await waitFor(() => replies(events).length === turn);
  }
  reply.push("TURN 13");
  await waitFor(() => events.some((event) => event.type === "ended"));
  const ended = events.find((event) => event.type === "ended");
  assert.equal(ended?.type === "ended" ? ended.reason : null, "turn_limit");
  assert.equal(ended?.type === "ended" ? ended.turns : null, 12);
  assert.ok((ended?.type === "ended" ? ended.historyChars : 0) > 0);
  assert.equal(calls, 12, "the thirteenth turn must not call the model");
  const result = await reply.finish();
  assert.equal(result.status, "ended");
  assert.equal(result.endReason, "turn_limit");
});

test("continuous reply: normal EOF and cancellation stay distinct", async () => {
  const neverFetch = (async () => new Promise<Response>(() => undefined)) as typeof fetch;
  const canceledEvents = collected();
  let started = false;
  const trackedFetch = (async (...args: Parameters<typeof fetch>) => { started = true; return neverFetch(...args); }) as typeof fetch;
  const canceled = session(chatConfig(), canceledEvents, { fetchImpl: trackedFetch, continuous: true, idleMs: 1000 });
  canceled.push("CQ TEST");
  await waitFor(() => started);
  canceled.cancel();
  const canceledResult = await canceled.finish();
  assert.equal(canceledResult.status, "canceled");
  assert.equal(canceledResult.endReason ?? null, null);
  assert.equal(canceledEvents.filter((event) => event.type === "ended").length, 0);
  assert.equal(replies(canceledEvents).length, 0);

  const emptyEvents = collected();
  const empty = session(mockConfig(), emptyEvents, { continuous: true });
  const emptyResult = await empty.finish();
  assert.equal(emptyResult.status, "ended");
  assert.equal(emptyResult.endReason, "eof");
  assert.equal(emptyEvents.filter((event) => event.type === "reply").length, 0);

  const afterReplyEvents = collected();
  const afterReply = session(mockConfig(), afterReplyEvents, { continuous: true, idleMs: 1000 });
  afterReply.push("CQ TEST");
  await waitFor(() => replies(afterReplyEvents).length === 1);
  const eofResult = await afterReply.finish();
  assert.equal(eofResult.status, "ended");
  assert.equal(eofResult.endReason, "eof");
  assert.equal(eofResult.turns, 1);
});

test("continuous parser and declared-WPM estimate: unsupported-but-legal characters stay explicit", async () => {
  assert.deepEqual(parseContinuousProposal(replyContent({ action: "wait", text: "", reason: "unclear" })), {
    action: "wait", text: "", reason: "unclear",
  });
  assert.deepEqual(parseContinuousProposal(replyContent({ action: "end", text: "", reason: "done" })), {
    action: "end", text: "", reason: "done",
  });
  for (const content of [
    replyContent({ action: "wait", text: "X", reason: "bad" }),
    replyContent({ action: "end", text: "X", reason: "bad" }),
    replyContent({ action: "no_reply", text: "", reason: "legacy action" }),
    replyContent({ action: "reply", text: "", reason: "empty" }),
  ]) {
    assert.throws(() => parseContinuousProposal(content), (error: unknown) => error instanceof ReplyError && error.code === "reply_output_invalid");
  }

  let body = "";
  const fakeFetch = (async (_url: unknown, init: RequestInit | undefined) => {
    body = String(init?.body);
    return chatResponse(replyContent({ action: "reply", text: "B1AA=B2BB", reason: "legal CI-V text" }));
  }) as typeof fetch;
  const events = collected();
  const reply = session(chatConfig(), events, { fetchImpl: fakeFetch, continuous: true, idleMs: 1000, wpm: 30 });
  reply.push("CQ TEST");
  await waitFor(() => replies(events).length === 1);
  const proposal = replies(events)[0]!;
  assert.equal(proposal.validated, true);
  assert.equal(proposal.text, "B1AA=B2BB");
  assert.equal(proposal.timing?.estimatedDurationMs, null, "unsupported signal characters must be explicitly unestimable");
  assert.equal(proposal.timing?.wpm, 30);
  await reply.finish();
  const parsed = JSON.parse(body) as { messages: Array<{ content: string }> };
  assert.match(parsed.messages[0]!.content, /action=wait/);
  assert.match(parsed.messages[0]!.content, /NOT SENT/);
});

// ── CLI：现有解码主链 + 实际源码夹具 ──────────────────────────────────

function decoderFixture(t: TestContext, body: string): string {
  const dir = tempDir(t);
  const file = join(dir, "decoder.mjs");
  writeFileSync(file, `#!/usr/bin/env node\n${body}\n`, "utf8");
  chmodSync(file, 0o755);
  return file;
}

test("receive CLI runs the same multimon session and prints utterance plus validated reply", { skip: process.platform === "win32" }, async (t) => {
  const dir = tempDir(t);
  const decoder = decoderFixture(t, `
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write("CQ TEST DE B1AA K\\n", () => process.exit(0));
});
`);
  const config = join(dir, "mock.json");
  writeFileSync(config, `${JSON.stringify({ version: 1, provider: "mock", model: "mock-model" })}\n`, "utf8");
  const lines: JsonRecord[] = [];
  const guiEvents: JsonRecord[] = [];
  const code = await runReceive([
    "--decoder", decoder,
    "--pcm-s16le", "-",
    "--timeout-ms", "5000",
    "--reply-config", config,
    "--own-call", "B1AA",
    "--peer-call", "B2BB",
  ], {
    print: (value): void => { lines.push(value as JsonRecord); },
    onEvent: (value): void => { guiEvents.push(value as JsonRecord); },
    sessionId: "cli-reply",
    now: (): Date => new Date("2026-10-21T01:02:03.000Z"),
    source: sourceOf([new Uint8Array([1, 2])]),
  });
  assert.equal(code, 0, JSON.stringify(lines));
  assert.deepEqual(lines.filter((line) => line.type === "chunk").map((line) => line.text), ["CQ TEST DE B1AA K"]);
  const utterance = lines.find((line) => line.type === "utterance");
  assert.equal(utterance?.receivedText, "CQ TEST DE B1AA K");
  assert.equal(utterance?.boundary, "eof");
  assert.equal(utterance?.advisoryOnly, true);
  const reply = lines.find((line) => line.type === "reply");
  assert.equal(reply?.provider, "mock");
  assert.equal(reply?.validated, true);
  assert.equal(reply?.action, "reply");
  assert.equal(reply?.text, "B2BB DE B1AA K");
  assert.equal(reply?.advisoryOnly, true);
  assert.equal(lines.at(-1)?.state, "completed");
  assert.equal(lines.at(-1)?.replyStatus, "published");
  assert.deepEqual(guiEvents, lines, "embedded event callback observes the same structured stream as CLI output");
});

test("receive CLI actually runs continuous turns and prints timing fields", { skip: process.platform === "win32" }, async (t) => {
  const dir = tempDir(t);
  const decoder = decoderFixture(t, `
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write("CQ TEST DE B1AA K\\n", () => process.exit(0));
});
`);
  const config = join(dir, "mock.json");
  writeFileSync(config, `${JSON.stringify({ version: 1, provider: "mock", model: "mock-model" })}\n`, "utf8");
  const lines: JsonRecord[] = [];
  const code = await runReceive([
    "--decoder", decoder,
    "--pcm-s16le", "-",
    "--timeout-ms", "5000",
    "--reply-config", config,
    "--own-call", "B1AA",
    "--peer-call", "B2BB",
    "--reply-continuous",
    "--reply-wpm", "25",
    "--reply-budget-ms", "2000",
  ], {
    print: (value): void => { lines.push(value as JsonRecord); },
    sessionId: "cli-continuous",
    source: sourceOf([new Uint8Array([1, 2])]),
  });
  assert.equal(code, 0, JSON.stringify(lines));
  const reply = lines.find((line) => line.type === "reply");
  assert.equal(reply?.continuous, true);
  assert.equal(reply?.turnIndex, 1);
  assert.equal(reply?.action, "reply");
  const timing = reply?.timing as JsonRecord | undefined;
  assert.equal(timing?.wpm, 25);
  assert.equal(timing?.budgetMs, 2_000);
  assert.equal(timing?.wpmDeclaredOnly, true);
  const ended = lines.find((line) => line.type === "ended");
  assert.equal(ended?.reason, "eof");
  const status = lines.at(-1)!;
  assert.equal(status.state, "completed");
  assert.equal(status.replyStatus, "ended");
  assert.equal(status.replyContinuous, true);
  assert.equal(status.replyTurns, 1);
  assert.equal(status.replyEndReason, "eof");
  assert.equal(status.replyWpm, 25);
  assert.equal(status.replyBudgetMs, 2_000);
  assert.deepEqual(status.replyLastTiming, timing);
});

test("receive CLI rejects continuous flag combinations before spawning", async () => {
  const base = ["--decoder", "/unused", "--pcm-s16le", "-", "--reply-config", "/unused", "--own-call", "B1AA", "--peer-call", "B2BB"];
  const usageCases: string[][] = [
    ["--decoder", "/unused", "--pcm-s16le", "-", "--reply-continuous"],
    [...base, "--reply-continuous", "--reply-wpm", "4"],
    [...base, "--reply-continuous", "--reply-wpm", "61"],
    [...base, "--reply-continuous", "--reply-budget-ms", "99"],
    [...base, "--reply-continuous", "--reply-budget-ms", "10001"],
    [...base, "--reply-wpm", "20"],
    [...base, "--reply-budget-ms", "5000"],
    [...base, "--reply-continuous", "--reply-trial-simulate", "--reply-trial-record-dir", "/unused"],
  ];
  for (const argv of usageCases) {
    const lines: JsonRecord[] = [];
    assert.equal(await runReceive(argv, { print: (value): void => { lines.push(value as JsonRecord); } }), 2, argv.join(" "));
    assert.equal(lines[0]?.code, "usage");
  }
});

test("receive CLI rejects incomplete reply flags and unknown config before spawning", async (t) => {
  const usageCases: string[][] = [
    ["--decoder", "/unused", "--pcm-s16le", "-", "--reply-config", "/unused"],
    ["--decoder", "/unused", "--pcm-s16le", "-", "--own-call", "B1AA", "--peer-call", "B2BB"],
    ["--decoder", "/unused", "--pcm-s16le", "-", "--reply-idle-ms", "2500"],
    ["--decoder", "/unused", "--pcm-s16le", "-", "--reply-config", "/unused", "--own-call", "b1aa", "--peer-call", "B2BB"],
    ["--decoder", "/unused", "--pcm-s16le", "-", "--reply-config", "/unused", "--own-call", "B1AA", "--peer-call", "B2BB", "--reply-idle-ms", "999"],
    ["--decoder", "/unused", "--pcm-s16le", "-", "--reply-config", "/unused", "--own-call", "B1AA", "--peer-call", "B2BB", "--reply-idle-ms", "10001"],
  ];
  for (const argv of usageCases) {
    const lines: JsonRecord[] = [];
    assert.equal(await runReceive(argv, { print: (value): void => { lines.push(value as JsonRecord); } }), 2);
    assert.equal(lines[0]?.code, "usage");
    assert.match(String(lines[0]?.usage), /--reply-config/);
  }

  const dir = tempDir(t);
  const marker = join(dir, "spawned");
  const decoder = decoderFixture(t, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "spawned"); process.stdin.resume();`);
  const lines: JsonRecord[] = [];
  const code = await runReceive([
    "--decoder", decoder,
    "--pcm-s16le", "-",
    "--reply-config", join(dir, "missing.json"),
    "--own-call", "B1AA",
    "--peer-call", "B2BB",
  ], { print: (value): void => { lines.push(value as JsonRecord); } });
  assert.equal(code, 1);
  assert.equal(lines[0]?.code, "config_not_found");
  let spawned = true;
  try {
    // access is intentional: the fixture must not have been started.
    await import("node:fs/promises").then(async ({ access }) => access(marker));
  } catch {
    spawned = false;
  }
  assert.equal(spawned, false, "configuration must be validated before spawning the decoder");
});

// ── V00-03-B 已校验回复 → 既有模拟发送 ──────────────────────────────────

function replyTrialConfig(dir: string, provider = "mock"): string {
  const file = join(dir, "reply-trial.json");
  writeFileSync(file, `${JSON.stringify({ version: 1, provider, model: "mock-model" })}\n`, "utf8");
  return file;
}

test("receive caller cancellation interrupts a pending trial confirmation without dispatch", { skip: process.platform === "win32", timeout: 5000 }, async t => {
  const dir = tempDir(t);
  const decoder = decoderFixture(t, `process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("CQ TEST\\n", () => process.exit(0)));`);
  const transport = createCwTrialSimulatorTransport();
  t.after(async () => { await transport.close(); });
  const cancellation = new AbortController();
  const code = await runReceive([
    "--decoder", decoder, "--pcm-s16le", join(dir, "sample.s16le"),
    "--reply-config", replyTrialConfig(dir), "--own-call", "B1AA", "--peer-call", "B2BB",
    "--reply-trial-simulate", "--reply-trial-record-dir", join(dir, "records"),
  ], {
    print: () => undefined,
    isTTY: true,
    signal: cancellation.signal,
    source: sourceOf([new Uint8Array([1, 2])]),
    trialCreateTransport: async () => transport,
    trialIo: {
      isTTY: true, write: () => undefined,
      prompt: () => {
        cancellation.abort();
        return new Promise<string>(() => {});
      },
    },
  });
  assert.equal(code, 1);
  assert.equal(transport.requests.filter(bytes => bytes[4] === 0x17).length, 0);
  assert.equal(transport.closed, true);
});

test("receive CLI binds a published mock reply to one simulated trial, TTY confirmation and record identity", { skip: process.platform === "win32" }, async (t) => {
  const dir = tempDir(t);
  const decoder = decoderFixture(t, `
process.stdin.resume();
process.stdin.on("end", () => process.stdout.write("CQ TEST DE B1AA K\\n", () => process.exit(0)));
`);
  const config = replyTrialConfig(dir);
  const trialDir = join(dir, "trial-records");
  const transport = createCwTrialSimulatorTransport();
  t.after(async () => { await transport.close(); });
  const lines: JsonRecord[] = [];
  const trialLines: string[] = [];
  let prompts = 0;
  const code = await runReceive([
    "--decoder", decoder,
    "--pcm-s16le", join(dir, "capture.s16le"),
    "--timeout-ms", "5000",
    "--reply-config", config,
    "--own-call", "B1AA",
    "--peer-call", "B2BB",
    "--reply-trial-simulate",
    "--reply-trial-record-dir", trialDir,
  ], {
    print: (value): void => { lines.push(value as JsonRecord); },
    sessionId: "reply-trial-cli",
    isTTY: true,
    source: sourceOf([new Uint8Array([1, 2])]),
    trialIo: {
      isTTY: true,
      write: (line: string): void => { trialLines.push(line); },
      prompt: async (question: string): Promise<string> => {
        prompts += 1;
        assert.match(question, /B2BB DE B1AA K/);
        return "B2BB DE B1AA K";
      },
    },
    trialCreateTransport: async () => transport,
  });
  assert.equal(code, 0, JSON.stringify({ lines, trialLines }));
  assert.equal(prompts, 1);
  const trialEvent = lines.find(line => line.type === "reply_trial");
  assert.equal(trialEvent?.state, "confirm");
  assert.equal(trialEvent?.dispatch, "manual");
  assert.equal(trialEvent?.scope, "simulator");
  assert.equal(trialEvent?.text, "B2BB DE B1AA K");
  assert.equal(trialEvent?.transport, "simulator");
  assert.deepEqual(lines.at(-1)?.replyTrial, { performed: true, exitCode: 0, transport: "simulator" });
  assert.equal(lines.at(-1)?.replyDispatch, "manual");
  assert.equal(lines.at(-1)?.readOnly, false, "a completed simulated send must not be reported as read-only");
  assert.equal(transport.requests.filter(bytes => bytes[4] !== 0x17).length, 16);
  const messages = transport.requests.filter(bytes => bytes[4] === 0x17);
  assert.deepEqual([...messages[0]!.slice(5, -1)], [...Buffer.from("B2BB DE B1AA K", "ascii")]);
  assert.deepEqual([...messages[1]!.slice(5, -1)], [0xff]);
  assert.equal(transport.closed, true);
  const rows = await (await CwTrialRecordStore.open(trialDir)).readAll();
  assert.deepEqual(rows.map(row => row.event), ["intent", "send_result", "stop_intent", "stop_result", "session_close"]);
  for (const row of rows.filter(row => row.event !== "session_close")) {
    assert.equal(row.message, null);
    assert.match(row.detail!, /B2BB DE B1AA K/);
    assert.match(row.detail!, /reply-trial-cli/);
  }
});

test("reply trial simulation rejects stdin, realtime audio, missing reply/TTY before spawning", async (t) => {
  const dir = tempDir(t);
  const base = ["--decoder", "/unused", "--reply-config", "/unused", "--own-call", "B1AA", "--peer-call", "B2BB",
    "--reply-trial-simulate"];
  for (const argv of [
    [...base, "--pcm-s16le", "-", "--reply-trial-record-dir", join(dir, "a")],
    [...base, "--pcm-s16le", join(dir, "a.s16le")],
    ["--decoder", "/unused", "--pcm-s16le", join(dir, "a.s16le"), "--reply-trial-simulate",
      "--reply-trial-record-dir", join(dir, "b")],
    ["--decoder", "/unused", "--ffmpeg", "/unused", "--audio-backend", "pulse", "--audio-device", "default",
      "--reply-config", "/unused", "--own-call", "B1AA", "--peer-call", "B2BB",
      "--reply-trial-simulate", "--reply-trial-record-dir", join(dir, "c")],
    ["--decoder", "/unused", "--pcm-s16le", join(dir, "a.s16le"), "--reply-trial-record-dir", join(dir, "d")],
  ]) {
    const lines: JsonRecord[] = [];
    assert.equal(await runReceive(argv, { print: (value): void => { lines.push(value as JsonRecord); } }), 2);
    assert.equal(lines[0]?.code, "usage");
  }

  const marker = join(dir, "spawned");
  const decoder = decoderFixture(t, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, "spawned");`);
  const lines: JsonRecord[] = [];
  assert.equal(await runReceive([
    "--decoder", decoder,
    "--pcm-s16le", join(dir, "capture.s16le"),
    "--reply-config", replyTrialConfig(dir),
    "--own-call", "B1AA",
    "--peer-call", "B2BB",
    "--reply-trial-simulate",
    "--reply-trial-record-dir", join(dir, "tty-records"),
  ], {
    print: (value): void => { lines.push(value as JsonRecord); },
    isTTY: false,
  }), 2);
  assert.equal(lines[0]?.code, "not_tty");
  assert.equal(existsSync(marker), false, "TTY refusal must happen before the decoder starts");
});

test("no_reply proposal performs zero simulated dispatch and creates no trial record", { skip: process.platform === "win32" }, async (t) => {
  const dir = tempDir(t);
  const decoder = decoderFixture(t, `
process.stdin.resume();
process.stdin.on("end", () => process.stdout.write("CQ TEST DE B1AA K\\n", () => process.exit(0)));
`);
  const trialDir = join(dir, "trial-records");
  const lines: JsonRecord[] = [];
  let prompts = 0;
  const code = await runReceive([
    "--decoder", decoder,
    "--pcm-s16le", join(dir, "capture.s16le"),
    "--timeout-ms", "5000",
    "--reply-config", replyTrialConfig(dir, "disabled"),
    "--own-call", "B1AA",
    "--peer-call", "B2BB",
    "--reply-trial-simulate",
    "--reply-trial-record-dir", trialDir,
  ], {
    print: (value): void => { lines.push(value as JsonRecord); },
    isTTY: true,
    source: sourceOf([new Uint8Array([1, 2])]),
    trialIo: {
      isTTY: true,
      write: (): void => undefined,
      prompt: async (): Promise<string> => { prompts += 1; return "unused"; },
    },
  });
  assert.equal(code, 0);
  assert.equal(prompts, 0);
  assert.deepEqual(lines.at(-1)?.replyTrial, { performed: false, reason: "no_reply" });
  assert.equal(existsSync(trialDir), false);
});

// ── V00-04-A 会话级自动派发 ─────────────────────────────────────────────

test("reply auto is accepted only with the original simulated PCM file combination", async (t) => {
  const dir = tempDir(t);
  const base = ["--decoder", "/unused", "--pcm-s16le", join(dir, "a.s16le"),
    "--reply-config", "/unused", "--own-call", "B1AA", "--peer-call", "B2BB"];
  for (const argv of [
    [...base, "--reply-auto"],
    [...base, "--reply-trial-simulate", "--reply-trial-record-dir", join(dir, "a"), "--reply-auto", "--reply-auto"],
    ["--decoder", "/unused", "--pcm-s16le", "-", "--reply-config", "/unused", "--own-call", "B1AA",
      "--peer-call", "B2BB", "--reply-trial-simulate", "--reply-trial-record-dir", join(dir, "b"), "--reply-auto"],
    ["--decoder", "/unused", "--ffmpeg", "/unused", "--audio-backend", "pulse", "--audio-device", "default",
      "--reply-config", "/unused", "--own-call", "B1AA", "--peer-call", "B2BB",
      "--reply-trial-simulate", "--reply-trial-record-dir", join(dir, "c"), "--reply-auto"],
  ]) {
    const lines: JsonRecord[] = [];
    assert.equal(await runReceive(argv, { print: (value): void => { lines.push(value as JsonRecord); } }), 2, argv.join(" "));
    assert.equal(lines[0]?.code, "usage", argv.join(" "));
  }

  const lines: JsonRecord[] = [];
  assert.equal(await runReceive([
    ...base,
    "--reply-trial-simulate", "--reply-trial-record-dir", join(dir, "tty"), "--reply-auto",
  ], {
    print: (value): void => { lines.push(value as JsonRecord); },
    isTTY: false,
  }), 2);
  assert.equal(lines[0]?.code, "not_tty");
});

test("reply auto dispatches a local CQ fast-path reply without prompting", { skip: process.platform === "win32", timeout: 20000 }, async (t) => {
  const dir = tempDir(t);
  const decoder = decoderFixture(t, `
process.stdin.resume();
process.stdout.write("CQ TEST DE B2BB K\\n");
setTimeout(() => process.exit(0), 1_300);
`);
  const trialDir = join(dir, "trial-records");
  const transport = createCwTrialSimulatorTransport();
  t.after(async () => { await transport.close(); });
  const lines: JsonRecord[] = [];
  let prompts = 0;
  const code = await runReceive([
    "--decoder", decoder,
    "--pcm-s16le", join(dir, "capture.s16le"),
    "--timeout-ms", "10000",
    "--reply-config", replyTrialConfig(dir),
    "--own-call", "B1AA",
    "--peer-call", "B2BB",
    "--reply-continuous",
    "--reply-prepared",
    "--reply-idle-ms", "1000",
    "--reply-trial-simulate",
    "--reply-trial-record-dir", trialDir,
    "--reply-auto",
  ], {
    print: (value): void => { lines.push(value as JsonRecord); },
    sessionId: "auto-cq-cli",
    isTTY: true,
    source: sourceOf([new Uint8Array([1, 2])]),
    trialIo: {
      isTTY: true,
      write: (): void => undefined,
      prompt: async (): Promise<string> => {
        prompts += 1;
        throw new Error("automatic CQ dispatch must not prompt");
      },
    },
    trialCreateTransport: async () => transport,
  });
  assert.equal(code, 0, JSON.stringify(lines));
  assert.equal(prompts, 0);
  const reply = lines.find(line => line.type === "reply");
  assert.equal(reply?.replySource, "local_cq_template");
  assert.equal(reply?.text, "B2BB DE B1AA K");
  const trialEvent = lines.find(line => line.type === "reply_trial");
  assert.equal(trialEvent?.state, "automatic");
  assert.equal(trialEvent?.dispatch, "automatic");
  assert.equal(trialEvent?.scope, "simulator");
  assert.equal(trialEvent?.transport, "simulator");
  assert.equal(lines.at(-1)?.replyDispatch, "automatic");
  assert.deepEqual(lines.at(-1)?.replyTrial, { performed: true, exitCode: 0, transport: "simulator" });
  const sent = transport.requests.filter(bytes => bytes[4] === 0x17);
  assert.deepEqual([...sent[0]!.slice(5, -1)], [...Buffer.from("B2BB DE B1AA K", "ascii")]);
  assert.equal(sent.length, 2);
  const rows = await (await CwTrialRecordStore.open(trialDir)).readAll();
  assert.deepEqual(rows.map(row => row.event), ["intent", "send_result", "stop_intent", "stop_result", "session_close"]);
});

test("reply auto dispatches an AI fallback reply without prompting", { skip: process.platform === "win32", timeout: 20000 }, async (t) => {
  const dir = tempDir(t);
  const decoder = decoderFixture(t, `
process.stdin.resume();
process.stdin.on("end", () => process.stdout.write("CQ TEST\\n", () => process.exit(0)));
`);
  const server = await startServer(t, replyContent({ action: "reply", text: "B2BB DE B1AA K", reason: "answer" }));
  const config = join(dir, "auto-ai.json");
  writeFileSync(config, `${JSON.stringify({
    version: 1, provider: "chat-completions", endpoint: server.endpoint, model: "test-model",
    apiKeyEnv: null, timeoutMs: 5000, maxOutputTokens: 64,
  })}\n`, "utf8");
  const trialDir = join(dir, "trial-records");
  const transport = createCwTrialSimulatorTransport();
  t.after(async () => { await transport.close(); });
  const lines: JsonRecord[] = [];
  let prompts = 0;
  const code = await runReceive([
    "--decoder", decoder,
    "--pcm-s16le", join(dir, "capture.s16le"),
    "--timeout-ms", "10000",
    "--reply-config", config,
    "--own-call", "B1AA",
    "--peer-call", "B2BB",
    "--reply-trial-simulate",
    "--reply-trial-record-dir", trialDir,
    "--reply-auto",
  ], {
    print: (value): void => { lines.push(value as JsonRecord); },
    sessionId: "auto-ai-cli",
    isTTY: true,
    source: sourceOf([new Uint8Array([1, 2])]),
    trialIo: {
      isTTY: true,
      write: (): void => undefined,
      prompt: async (): Promise<string> => {
        prompts += 1;
        throw new Error("automatic AI dispatch must not prompt");
      },
    },
    trialCreateTransport: async () => transport,
  });
  assert.equal(code, 0, JSON.stringify(lines));
  assert.equal(prompts, 0);
  assert.equal(server.requests.length, 1);
  assert.equal(lines.find(line => line.type === "reply_trial")?.dispatch, "automatic");
  assert.equal(lines.at(-1)?.replyDispatch, "automatic");
  assert.deepEqual(lines.at(-1)?.replyTrial, { performed: true, exitCode: 0, transport: "simulator" });
  const sent = transport.requests.filter(bytes => bytes[4] === 0x17);
  assert.deepEqual([...sent[0]!.slice(5, -1)], [...Buffer.from("B2BB DE B1AA K", "ascii")]);
});

test("reply auto keeps no_reply proposals at zero dispatch", { skip: process.platform === "win32" }, async (t) => {
  const dir = tempDir(t);
  const decoder = decoderFixture(t, `
process.stdin.resume();
process.stdin.on("end", () => process.stdout.write("CQ TEST\\n", () => process.exit(0)));
`);
  const trialDir = join(dir, "trial-records");
  const transport = createCwTrialSimulatorTransport();
  t.after(async () => { await transport.close(); });
  const lines: JsonRecord[] = [];
  let prompts = 0;
  const code = await runReceive([
    "--decoder", decoder,
    "--pcm-s16le", join(dir, "capture.s16le"),
    "--timeout-ms", "10000",
    "--reply-config", replyTrialConfig(dir, "disabled"),
    "--own-call", "B1AA",
    "--peer-call", "B2BB",
    "--reply-trial-simulate",
    "--reply-trial-record-dir", trialDir,
    "--reply-auto",
  ], {
    print: (value): void => { lines.push(value as JsonRecord); },
    isTTY: true,
    source: sourceOf([new Uint8Array([1, 2])]),
    trialIo: {
      isTTY: true,
      write: (): void => undefined,
      prompt: async (): Promise<string> => {
        prompts += 1;
        throw new Error("no_reply must not prompt");
      },
    },
    trialCreateTransport: async () => transport,
  });
  assert.equal(code, 0, JSON.stringify(lines));
  assert.equal(prompts, 0);
  assert.equal(transport.requests.length, 0);
  assert.equal(lines.at(-1)?.replyDispatch, "automatic");
  assert.deepEqual(lines.at(-1)?.replyTrial, { performed: false, reason: "no_reply" });
  assert.equal(existsSync(trialDir), false);
});

test("an injected manual control is not overridden by the CLI --reply-auto flag", { skip: process.platform === "win32" }, async (t) => {
  const dir = tempDir(t);
  const decoder = decoderFixture(t, `
process.stdin.resume();
process.stdin.on("end", () => process.stdout.write("CQ TEST\\n", () => process.exit(0)));
`);
  const trialDir = join(dir, "trial-records");
  const transport = createCwTrialSimulatorTransport();
  t.after(async () => { await transport.close(); });
  const control = new ReplyDispatchControl();
  const lines: JsonRecord[] = [];
  let prompts = 0;
  const code = await runReceive([
    "--decoder", decoder,
    "--pcm-s16le", join(dir, "capture.s16le"),
    "--timeout-ms", "10000",
    "--reply-config", replyTrialConfig(dir),
    "--own-call", "B1AA",
    "--peer-call", "B2BB",
    "--reply-trial-simulate",
    "--reply-trial-record-dir", trialDir,
    "--reply-auto",
  ], {
    print: (value): void => { lines.push(value as JsonRecord); },
    isTTY: true,
    source: sourceOf([new Uint8Array([1, 2])]),
    replyDispatch: control,
    trialIo: {
      isTTY: true,
      write: (): void => undefined,
      prompt: async (): Promise<string> => {
        prompts += 1;
        return "B2BB DE B1AA K";
      },
    },
    trialCreateTransport: async () => transport,
  });
  assert.equal(code, 0, JSON.stringify(lines));
  assert.equal(prompts, 1, "the injected manual control must keep the original confirmation");
  assert.equal(control.mode, "manual");
  assert.equal(lines.find(line => line.type === "reply_trial")?.dispatch, "manual");
  assert.equal(lines.at(-1)?.replyDispatch, "manual");
  assert.equal(transport.requests.filter(bytes => bytes[4] === 0x17).length, 2);
});

test("receive dispatch control editing and stop before authorization use the original manual path", { skip: process.platform === "win32", timeout: 5000 }, async t => {
  for (const action of ["edit", "stop"] as const) {
    const dir = tempDir(t);
    const decoder = decoderFixture(t, `process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("CQ TEST\\n", () => process.exit(0)));`);
    const transport = createCwTrialSimulatorTransport();
    t.after(async () => { await transport.close(); });
    const control = new ReplyDispatchControl({ automatic: true });
    const lines: JsonRecord[] = [];
    let prompts = 0;
    const edited = "B2BB DE B1AA R";
    const code = await runReceive([
      "--decoder", decoder, "--pcm-s16le", join(dir, "sample.s16le"),
      "--reply-config", replyTrialConfig(dir), "--own-call", "B1AA", "--peer-call", "B2BB",
      "--reply-trial-simulate", "--reply-trial-record-dir", join(dir, "records"), "--reply-auto",
    ], {
      print: value => {
        const row = value as JsonRecord;
        lines.push(row);
        if (row.type === "reply_trial") {
          if (action === "edit") control.beginEdit();
          else control.stop();
        }
      },
      isTTY: true, replyDispatch: control, source: sourceOf([new Uint8Array([1, 2])]),
      trialCreateTransport: async () => transport,
      trialIo: { isTTY: true, write: () => undefined, prompt: async () => {
        prompts += 1;
        return prompts === 1 ? `EDIT ${edited}` : edited;
      } },
    });
    assert.equal(code, action === "edit" ? 0 : 1, JSON.stringify(lines));
    assert.equal(prompts, action === "edit" ? 2 : 0);
    assert.equal(lines.at(-1)?.replyDispatch, "manual");
    const messages = transport.requests.filter(bytes => bytes[4] === 0x17);
    assert.equal(messages.length, action === "edit" ? 2 : 0);
    if (action === "edit") assert.equal(Buffer.from(messages[0]!.slice(5, -1)).toString("ascii"), edited);
  }
});

test("caller revocation during preflight stops automatic dispatch with zero frames", { skip: process.platform === "win32" }, async (t) => {
  const dir = tempDir(t);
  const decoder = decoderFixture(t, `
process.stdin.resume();
process.stdin.on("end", () => process.stdout.write("CQ TEST\\n", () => process.exit(0)));
`);
  const trialDir = join(dir, "trial-records");
  const transport = createCwTrialSimulatorTransport();
  t.after(async () => { await transport.close(); });
  const control = new ReplyDispatchControl({ automatic: true });
  const lines: JsonRecord[] = [];
  const code = await runReceive([
    "--decoder", decoder,
    "--pcm-s16le", join(dir, "capture.s16le"),
    "--timeout-ms", "10000",
    "--reply-config", replyTrialConfig(dir),
    "--own-call", "B1AA",
    "--peer-call", "B2BB",
    "--reply-trial-simulate",
    "--reply-trial-record-dir", trialDir,
  ], {
    print: (value): void => { lines.push(value as JsonRecord); },
    isTTY: true,
    source: sourceOf([new Uint8Array([1, 2])]),
    replyDispatch: control,
    trialIo: {
      isTTY: true,
      write: (): void => undefined,
      prompt: async (): Promise<string> => {
        throw new Error("revoked automatic dispatch must not prompt");
      },
    },
    trialCreateTransport: async () => {
      control.revoke();
      return transport;
    },
  });
  assert.equal(code, 3, JSON.stringify(lines));
  assert.equal(transport.requests.filter(bytes => bytes[4] === 0x17).length, 0);
  assert.equal(lines.at(-1)?.replyDispatch, "automatic");
  assert.equal((lines.at(-1)?.replyTrial as JsonRecord | undefined)?.exitCode, 3);
  assert.equal(existsSync(trialDir), true, "the control-only trial records directory is still opened");
  const rows = await (await CwTrialRecordStore.open(trialDir)).readAll();
  assert.equal(rows.some(row => row.event === "intent"), false);
});

// ── V00-03-E CQ 本地快速回复模板与人工编辑 ─────────────────────────────

test("CQ quick reply matcher accepts only the strict direct-call grammar", () => {
  const calls = { ownCall: "B1AA", peerCall: "B2BB" };
  for (const text of [
    "CQ DE B2BB K",
    "CQ TEST DE B2BB K",
    "CQ CQ CQ TEST DE B2BB K",
    "CQ TEST DX POTA DE B2BB K",
    "  CQ   TEST  DE  B2BB   K  ",
  ]) {
    assert.deepEqual(
      matchCqQuickReply(text, calls),
      { text: "B2BB DE B1AA K", rule: CQ_QUICK_REPLY_RULE },
      JSON.stringify(text),
    );
  }
  for (const text of [
    "",
    "CQ TEST",
    "CQ TEST DE B2BB",
    "CQ TEST DE B2BB KN",
    "CQ TEST DE B1AA K",
    "CQ TEST DE B2CC K",
    "CQ TEST DE B2BB K EXTRA",
    "EXTRA CQ TEST DE B2BB K",
    "CQTEST DE B2BB K",
    "cq test de b2bb k",
    "CQ HELLO DE B2BB K",
    "CQ TEST DE B2BB K?",
    "CQ TEST DE B2BB K\n",
    "CQ TEST B2BB K",
    "CQ DE B2BB DE B2BB K",
    "CQ CQ CQ CQ CQ CQ CQ CQ DE B2BB K",
  ]) {
    assert.equal(matchCqQuickReply(text, calls), null, JSON.stringify(text));
  }
  assert.equal(
    matchCqQuickReply("CQ TEST DE B2BB/7 K", { ownCall: "B1AA", peerCall: "B2BB/7" })?.text,
    "B2BB/7 DE B1AA K",
  );
});

test("prepared CQ fast path answers locally with zero HTTP and explicit source fields", async () => {
  let calls = 0;
  const fakeFetch = (async () => {
    calls += 1;
    return chatResponse("{}");
  }) as typeof fetch;
  const events = collected();
  const reply = session(chatConfig(), events, { continuous: true, prepared: true, idleMs: 1000, wpm: 25, fetchImpl: fakeFetch });
  reply.push("CQ TEST DE B2BB K");
  const result = await reply.finish();
  assert.equal(result.status, "ended");
  assert.equal(result.endReason, "eof");
  assert.equal(result.reply?.text, "B2BB DE B1AA K");
  assert.equal(calls, 0, "the strict CQ rule must not make an HTTP request");
  const proposal = replies(events)[0]!;
  assert.equal(proposal.validated, true);
  assert.equal(proposal.action, "reply");
  assert.equal(proposal.text, "B2BB DE B1AA K");
  assert.equal(proposal.replySource, "local_cq_template");
  assert.equal(proposal.fastPathRule, CQ_QUICK_REPLY_RULE);
  assert.equal(proposal.modelWaitMs, 0);
  assert.equal(proposal.timing?.modelMs, 0);
  assert.equal(proposal.timing?.wpm, 25);
  const expected = Math.round(
    buildTimeline(encodeCwText(normalizeCwText("B2BB DE B1AA K")), 22_050, 25).exactDurationSeconds * 1000 * 10,
  ) / 10;
  assert.equal(proposal.timing?.estimatedDurationMs, expected);
  assert.equal("preparedCache" in proposal, false);
  assert.match(proposal.reason, /local rule cq_de_peer_k/);
  assert.match(proposal.reason, /no model request/);
  assert.equal(JSON.stringify(proposal).includes("choices"), false);
});

test("prepared CQ fast path falls back to the original three-field AI for every near miss", async () => {
  const cases = [
    "CQ TEST DE B1AA K",
    "CQ TEST DE B2CC K",
    "CQ TEST DE B2BB KN",
    "CQ TEST DE B2BB",
    "CQ TEST DE B2BB K EXTRA",
    "EXTRA CQ TEST DE B2BB K",
    "CQTEST DE B2BB K",
    "cq test de b2bb k",
    "CQ HELLO DE B2BB K",
    "CQ TEST DE B2BB K?",
    "CQ CQ CQ CQ CQ CQ CQ CQ DE B2BB K",
    "B2BB DE B1AA K",
  ];
  for (const text of cases) {
    const bodies: string[] = [];
    const fakeFetch = (async (_url: unknown, init: RequestInit | undefined) => {
      bodies.push(String(init?.body));
      return chatResponse(replyContent({ action: "reply", text: "B2BB DE B1AA K", reason: "fallback" }));
    }) as typeof fetch;
    const events = collected();
    const reply = session(chatConfig(), events, { continuous: true, prepared: true, idleMs: 1000, fetchImpl: fakeFetch });
    reply.push(text);
    const result = await reply.finish();
    assert.equal(bodies.length, 1, `near miss must reach the model: ${text}`);
    const messages = (JSON.parse(bodies[0]!) as { messages: Array<{ content: string }> }).messages;
    assert.match(messages[0]!.content, /exactly the fields action, text and reason/, text);
    assert.doesNotMatch(messages[0]!.content, /prepared/, text);
    assert.equal(result.status, "ended", text);
    assert.equal(result.endReason, "eof", text);
    const proposal = replies(events)[0]!;
    assert.equal(proposal.text, "B2BB DE B1AA K", text);
    assert.equal(proposal.replySource, undefined, text);
    assert.equal(proposal.fastPathRule, undefined, text);
    assert.equal(proposal.modelWaitMs, undefined, text);
    assert.equal("preparedCache" in proposal, false, text);
  }
});

test("normal continuous mode keeps the model path for CQ text because the fast path is prepared-only", async () => {
  let calls = 0;
  const fakeFetch = (async () => {
    calls += 1;
    return chatResponse(replyContent({ action: "reply", text: "B2BB DE B1AA K", reason: "model" }));
  }) as typeof fetch;
  const events = collected();
  const reply = session(chatConfig(), events, { continuous: true, idleMs: 1000, fetchImpl: fakeFetch });
  reply.push("CQ TEST DE B2BB K");
  const result = await reply.finish();
  assert.equal(result.status, "ended");
  assert.equal(calls, 1);
  const proposal = replies(events)[0]!;
  assert.equal(proposal.text, "B2BB DE B1AA K");
  assert.equal(proposal.replySource, undefined);
  assert.equal(proposal.fastPathRule, undefined);
  assert.equal(proposal.modelWaitMs, undefined);
});

test("prepared flag still requires continuous mode", async () => {
  assert.throws(() => session(mockConfig(), collected(), { prepared: true }), /require continuous/);
  const output: unknown[] = [];
  const code = await runReceive(["--decoder", "unused", "--pcm-s16le", "unused", "--reply-prepared"], {
    print: value => { output.push(value); },
    openSource: () => { throw new Error("must not open input"); },
  });
  assert.equal(code, 2);
  assert.match(JSON.stringify(output), /requires --reply-continuous/);
});

test("prepared reply: local CQ hit makes no first request, non-CQ falls back, EDIT sends the final text once", { skip: process.platform === "win32", timeout: 20000 }, async (t) => {
  const dir = tempDir(t);
  const decoder = decoderFixture(t, `
process.stdin.resume();
process.stdout.write("CQ TEST DE B2BB K\\n");
setTimeout(() => {
  process.stdout.write("B1AA DE B2BB K\\n", () => setTimeout(() => process.exit(0), 50));
}, 1_300);
`);
  const server = await startServer(t, replyContent({
    action: "reply",
    text: "B2BB DE B1AA K",
    reason: "answer the call",
  }));
  const config = join(dir, "prepared.json");
  writeFileSync(config, `${JSON.stringify({
    version: 1, provider: "chat-completions", endpoint: server.endpoint, model: "test-model",
    apiKeyEnv: null, timeoutMs: 5000, maxOutputTokens: 64,
  })}\n`, "utf8");
  const trialDir = join(dir, "trial-records");
  const transport = createCwTrialSimulatorTransport();
  t.after(async () => { await transport.close(); });
  const lines: JsonRecord[] = [];
  const trialLines: string[] = [];
  const prompts: string[] = [];
  const edited = "B2BB DE B1AA R";
  const code = await runReceive([
    "--decoder", decoder,
    "--pcm-s16le", join(dir, "capture.s16le"),
    "--timeout-ms", "10000",
    "--reply-config", config,
    "--own-call", "B1AA",
    "--peer-call", "B2BB",
    "--reply-continuous",
    "--reply-prepared",
    "--reply-idle-ms", "1000",
    "--reply-trial-simulate",
    "--reply-trial-record-dir", trialDir,
  ], {
    print: (value): void => { lines.push(value as JsonRecord); },
    sessionId: "prepared-cli",
    isTTY: true,
    source: sourceOf([new Uint8Array([1, 2])]),
    trialIo: {
      isTTY: true,
      write: (line: string): void => { trialLines.push(line); },
      prompt: async (question: string): Promise<string> => {
        prompts.push(question);
        return prompts.length === 1 ? `EDIT ${edited}` : edited;
      },
    },
    trialCreateTransport: async () => transport,
  });
  assert.equal(code, 0, JSON.stringify({ lines, trialLines, prompts }));
  assert.equal(server.requests.length, 1, "only the non-CQ turn may reach the model");
  const request = JSON.parse(server.requests[0]!.body) as { messages: Array<{ content: string }> };
  assert.match(request.messages[0]!.content, /exactly the fields action, text and reason/);
  assert.doesNotMatch(request.messages[0]!.content, /prepared/);
  const replyEvents = lines.filter((line) => line.type === "reply");
  assert.equal(replyEvents.length, 2);
  assert.equal(replyEvents[0]?.text, "B2BB DE B1AA K");
  assert.equal(replyEvents[0]?.replySource, "local_cq_template");
  assert.equal(replyEvents[0]?.fastPathRule, CQ_QUICK_REPLY_RULE);
  assert.equal(replyEvents[0]?.modelWaitMs, 0);
  assert.equal((replyEvents[0]?.timing as JsonRecord)?.modelMs, 0);
  assert.equal(replyEvents[0]?.preparedCache, undefined);
  assert.equal(replyEvents[1]?.turnIndex, 2);
  assert.equal(replyEvents[1]?.replySource, undefined);
  assert.equal(replyEvents[1]?.text, "B2BB DE B1AA K");
  assert.equal(lines.find((line) => line.type === "ended")?.reason, "eof");
  assert.equal(prompts.length, 2);
  assert.match(prompts[1]!, new RegExp(edited));
  assert.deepEqual(lines.at(-1)?.replyTrial, { performed: true, exitCode: 0, transport: "simulator" });

  const sent = transport.requests.filter(bytes => bytes[4] === 0x17);
  assert.deepEqual([...sent[0]!.slice(5, -1)], [...Buffer.from(edited, "ascii")]);
  const rows = await (await CwTrialRecordStore.open(trialDir)).readAll();
  assert.deepEqual(rows.map(row => row.event), ["intent", "send_result", "stop_intent", "stop_result", "session_close"]);
  for (const row of rows.filter(row => row.event !== "session_close")) {
    assert.equal(row.message, null);
    assert.match(row.detail!, new RegExp(edited));
    assert.match(row.detail!, /"edited":true/);
    assert.match(row.detail!, /prepared-cli/);
  }
});
