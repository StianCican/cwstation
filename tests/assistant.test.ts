// AI-001：只读 AI 状态建议入口测试。
//
// 只使用 127.0.0.1 随机端口上的本地 mock HTTP 服务，不访问外网，不使用真实
// 凭据。覆盖：配置/状态严格校验、密钥不落盘与错误不泄露、mock/disabled 闭环、
// 坏 JSON/空输出/HTTP 错误/重定向/超时/超大响应，以及输出字段边界。

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, isBuiltMode } from "./helpers.js";
import {
  ASSISTANT_LIMITS,
  AssistantError,
  explainState,
  parseAssistantConfig,
  parseStationState,
  validateEndpointUrl,
  type AssistantConfig,
  type StationStateSnapshot,
} from "../packages/assistant/src/index.js";

// ── 测试辅助 ────────────────────────────────────────────────────────────

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "cwstation-assistant-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeJson(dir: string, name: string, value: unknown): string {
  const file = join(dir, name);
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return file;
}

const VALID_STATE: StationStateSnapshot = {
  frequencyHz: 14_030_000,
  mode: "CW",
  txBusy: false,
  backendConnected: true,
  generation: 3,
  blockedReason: null,
};

function chatConfig(endpoint: string, overrides: Partial<AssistantConfig> = {}): AssistantConfig {
  return parseAssistantConfig({
    version: 1,
    provider: "chat-completions",
    endpoint,
    model: "test-model",
    apiKeyEnv: "CWAI_TEST_KEY",
    timeoutMs: 5_000,
    maxOutputTokens: 128,
    ...overrides,
  });
}

function throwsCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => error instanceof AssistantError && error.code === code);
}

function cwaiEntry(): string[] {
  return isBuiltMode()
    ? [join(ROOT, "dist", "apps", "cwai.js")]
    : ["--import", "tsx", join(ROOT, "apps", "cwai.ts")];
}

interface CliRun {
  status: number | null;
  json: Record<string, unknown> | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env: Record<string, string> = {}): CliRun {
  const result = spawnSync(process.execPath, [...cwaiEntry(), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, ...env },
  });
  const lines = result.stdout.trim().split("\n").filter((line) => line.length > 0);
  const last = lines.length > 0 ? (lines[lines.length - 1] as string) : "";
  let json: Record<string, unknown> | null = null;
  if (last.startsWith("{")) json = JSON.parse(last) as Record<string, unknown>;
  return { status: result.status, json, stdout: result.stdout, stderr: result.stderr };
}

async function runCliAsync(args: string[], env: Record<string, string> = {}): Promise<CliRun> {
  const child = spawn(process.execPath, [...cwaiEntry(), ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill(), 15_000);
  try {
    const status = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    const last = stdout.trim().split("\n").at(-1) ?? "";
    return { status, stdout, stderr, json: last.startsWith("{") ? JSON.parse(last) as Record<string, unknown> : null };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
  }
}

interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface MockServer {
  endpoint: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

async function startServer(t: TestContext, handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void): Promise<MockServer> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("error", () => {
      // 客户端中止读取（超时/超大响应）时忽略。
    });
    res.on("error", () => {
      // 同上。
    });
    req.on("end", () => {
      requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      handler(req, res, body);
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
  return {
    endpoint: `http://127.0.0.1:${port}/v1/chat/completions`,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function responseKeys(result: Record<string, unknown> | undefined): string[] {
  return Object.keys(result ?? {}).sort();
}

// ── 配置校验 ────────────────────────────────────────────────────────────

test("配置 version1：接受三种 provider、应用默认值并拒绝未知字段/版本/类型", () => {
  const disabled = parseAssistantConfig({ version: 1, provider: "disabled" });
  assert.equal(disabled.provider, "disabled");
  assert.equal(disabled.endpoint, null);
  assert.equal(disabled.timeoutMs, ASSISTANT_LIMITS.TIMEOUT_MS_DEFAULT);
  assert.equal(disabled.maxOutputTokens, ASSISTANT_LIMITS.MAX_OUTPUT_TOKENS_DEFAULT);

  const mock = parseAssistantConfig({ version: 1, provider: "mock", model: "m", timeoutMs: 1000, maxOutputTokens: 4 });
  assert.equal(mock.model, "m");
  assert.equal(mock.timeoutMs, 1000);
  assert.equal(mock.maxOutputTokens, 4);

  const chat = parseAssistantConfig({
    version: 1,
    provider: "chat-completions",
    endpoint: "https://api.example.invalid/v1/chat/completions",
    model: "m",
    apiKeyEnv: "CWAI_API_KEY",
  });
  assert.equal(chat.endpoint, "https://api.example.invalid/v1/chat/completions");
  assert.equal(chat.apiKeyEnv, "CWAI_API_KEY");

  throwsCode(() => parseAssistantConfig({ version: 1, provider: "mock", extra: true }), "unknown_config_field");
  throwsCode(() => parseAssistantConfig({ version: 2, provider: "mock" }), "invalid_config");
  throwsCode(() => parseAssistantConfig({ version: 1, provider: "openai" }), "invalid_config");
  throwsCode(() => parseAssistantConfig({ version: 1 }), "invalid_config");
  throwsCode(() => parseAssistantConfig({ version: 1, provider: "mock", timeoutMs: 99 }), "invalid_config");
  throwsCode(() => parseAssistantConfig({ version: 1, provider: "mock", timeoutMs: true }), "invalid_config");
  throwsCode(() => parseAssistantConfig({ version: 1, provider: "mock", maxOutputTokens: 0 }), "invalid_config");
  throwsCode(() => parseAssistantConfig({ version: 1, provider: "mock", maxOutputTokens: 4097 }), "invalid_config");
  throwsCode(() => parseAssistantConfig({ version: 1, provider: "mock", apiKeyEnv: "1BAD" }), "invalid_config");
  // chat-completions 必填 endpoint/model。
  throwsCode(() => parseAssistantConfig({ version: 1, provider: "chat-completions", model: "m" }), "invalid_config");
  throwsCode(() => parseAssistantConfig({ version: 1, provider: "chat-completions", endpoint: "https://x.invalid/v1" }), "invalid_config");
});

test("端点校验：HTTPS 任意主机；HTTP 仅本机；拒绝凭据/query/fragment/非法 scheme", () => {
  assert.equal(validateEndpointUrl("https://api.example.invalid/v1/chat/completions"), "https://api.example.invalid/v1/chat/completions");
  assert.equal(validateEndpointUrl("http://localhost:8080/v1"), "http://localhost:8080/v1");
  assert.equal(validateEndpointUrl("http://127.0.0.1:8080/v1"), "http://127.0.0.1:8080/v1");
  assert.equal(validateEndpointUrl("http://[::1]:8080/v1"), "http://[::1]:8080/v1");

  throwsCode(() => validateEndpointUrl("http://example.invalid/v1"), "insecure_endpoint");
  throwsCode(() => validateEndpointUrl("http://0.0.0.0/v1"), "insecure_endpoint");
  throwsCode(() => validateEndpointUrl("ftp://example.invalid/v1"), "invalid_endpoint");
  throwsCode(() => validateEndpointUrl("https://user:pass@example.invalid/v1"), "invalid_endpoint");
  throwsCode(() => validateEndpointUrl("https://example.invalid/v1?x=1"), "invalid_endpoint");
  throwsCode(() => validateEndpointUrl("https://example.invalid/v1#frag"), "invalid_endpoint");
  throwsCode(() => validateEndpointUrl("not a url"), "invalid_endpoint");
});

// ── 状态快照校验 ────────────────────────────────────────────────────────

test("状态快照：只接受精确字段、有限数值、布尔、CW 与合法阻止原因", () => {
  assert.deepEqual(parseStationState(VALID_STATE), VALID_STATE);
  assert.deepEqual(parseStationState({ ...VALID_STATE, blockedReason: "unresolved unknown execution" }), {
    ...VALID_STATE,
    blockedReason: "unresolved unknown execution",
  });

  throwsCode(() => parseStationState({ ...VALID_STATE, extra: 1 }), "unknown_state_field");
  throwsCode(() => parseStationState({ mode: "CW", txBusy: false, backendConnected: true, generation: 0, blockedReason: null }), "invalid_state");
  throwsCode(() => parseStationState({ ...VALID_STATE, frequencyHz: true }), "invalid_state");
  throwsCode(() => parseStationState({ ...VALID_STATE, frequencyHz: Infinity }), "invalid_state");
  throwsCode(() => parseStationState({ ...VALID_STATE, frequencyHz: -1 }), "invalid_state");
  throwsCode(() => parseStationState({ ...VALID_STATE, frequencyHz: ASSISTANT_LIMITS.FREQUENCY_HZ_MAX + 1 }), "invalid_state");
  throwsCode(() => parseStationState({ ...VALID_STATE, mode: "SSB" }), "invalid_state");
  throwsCode(() => parseStationState({ ...VALID_STATE, txBusy: "false" }), "invalid_state");
  throwsCode(() => parseStationState({ ...VALID_STATE, generation: 1.5 }), "invalid_state");
  throwsCode(() => parseStationState({ ...VALID_STATE, generation: -1 }), "invalid_state");
  throwsCode(() => parseStationState({ ...VALID_STATE, blockedReason: "" }), "invalid_state");
  throwsCode(() => parseStationState({ ...VALID_STATE, blockedReason: "x".repeat(ASSISTANT_LIMITS.BLOCKED_REASON_MAX_CHARS + 1) }), "invalid_state");
});

// ── explainState 进程内（注入 fetch） ───────────────────────────────────

test("explainState：disabled/mock 不调用 fetch，输出固定四字段", async () => {
  let called = 0;
  const fakeFetch = (async () => {
    called += 1;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  const disabled = await explainState(VALID_STATE, parseAssistantConfig({ version: 1, provider: "disabled" }), {
    fetchImpl: fakeFetch,
    env: {},
  });
  const mock = await explainState(VALID_STATE, parseAssistantConfig({ version: 1, provider: "mock", model: "m" }), {
    fetchImpl: fakeFetch,
    env: {},
  });

  assert.equal(called, 0);
  assert.deepEqual(Object.keys(disabled).sort(), ["advisory", "advisoryOnly", "model", "provider"]);
  assert.equal(disabled.advisoryOnly, true);
  assert.equal(disabled.provider, "disabled");
  assert.match(disabled.advisory, /不可用/);
  assert.equal(mock.advisoryOnly, true);
  assert.equal(mock.provider, "mock");
});

test("explainState：chat-completions 使用注入 fetch，只发送状态快照并携带 Bearer", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit = {};
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedInit = init ?? {};
    return new Response(JSON.stringify({ choices: [{ message: { content: "backend advisory" } }] }), { status: 200 });
  }) as unknown as typeof fetch;

  const config = chatConfig("https://api.example.invalid/v1/chat/completions", { apiKeyEnv: "CWAI_UNIT_KEY" });
  const advisory = await explainState(VALID_STATE, config, { fetchImpl: fakeFetch, env: { CWAI_UNIT_KEY: "unit-secret" } });

  assert.equal(capturedUrl, "https://api.example.invalid/v1/chat/completions");
  assert.equal(advisory.advisory, "backend advisory");
  assert.deepEqual(Object.keys(advisory).sort(), ["advisory", "advisoryOnly", "model", "provider"]);
  const headers = capturedInit.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer unit-secret");
  const body = JSON.parse(String(capturedInit.body)) as { model: string; max_tokens: number; messages: Array<{ role: string; content: string }> };
  assert.equal(body.model, "test-model");
  assert.equal(body.max_tokens, 128);
  assert.equal(body.messages.length, 2);
  assert.match(body.messages[1]?.content ?? "", /14030000/);
});

// ── CLI：validate-config ───────────────────────────────────────────────

test("cwai validate-config：合法配置成功且不要求凭据；错误映射确定性退出码", (t) => {
  const dir = tempDir(t);
  const chatFile = writeJson(dir, "chat.json", {
    version: 1,
    provider: "chat-completions",
    endpoint: "https://api.example.invalid/v1/chat/completions",
    model: "m",
    apiKeyEnv: "CWAI_TEST_KEY",
  });
  // 不提供 CWAI_TEST_KEY 也必须成功：validate 不读凭据。
  const ok = runCli(["validate-config", "--config", chatFile], { CWAI_TEST_KEY: "" });
  assert.equal(ok.status, 0);
  assert.equal(ok.json?.ok, true);
  const result = ok.json?.result as Record<string, unknown>;
  assert.equal(result.provider, "chat-completions");
  assert.equal(result.networkRequired, true);
  assert.equal(result.requiresApiKey, true);

  const notFound = runCli(["validate-config", "--config", join(dir, "nope.json")]);
  assert.equal(notFound.status, 3);
  assert.equal(notFound.json?.code, "config_not_found");

  const unknownField = writeJson(dir, "unknown.json", { version: 1, provider: "mock", surprise: 1 });
  const bad = runCli(["validate-config", "--config", unknownField]);
  assert.equal(bad.status, 4);
  assert.equal(bad.json?.code, "unknown_config_field");

  // 超大配置文件在解析前被拒绝。
  const big = join(dir, "big.json");
  writeFileSync(big, `{"version":1,"provider":"mock","model":"${"x".repeat(ASSISTANT_LIMITS.CONFIG_FILE_MAX_BYTES)}"}`, "utf8");
  const tooBig = runCli(["validate-config", "--config", big]);
  assert.equal(tooBig.status, 4);
  assert.equal(tooBig.json?.code, "config_too_large");

  const badArgs = runCli(["validate-config", "--config", chatFile, "extra"]);
  assert.equal(badArgs.status, 2);
  assert.equal(badArgs.json?.code, "usage");
});

// ── CLI：disabled / mock 闭环 ──────────────────────────────────────────

test("cwai explain：disabled/mock 本地闭环、输出字段固定且确定性", (t) => {
  const dir = tempDir(t);
  const stateFile = writeJson(dir, "state.json", VALID_STATE);
  const disabledFile = writeJson(dir, "disabled.json", { version: 1, provider: "disabled" });
  const mockFile = writeJson(dir, "mock.json", { version: 1, provider: "mock", model: "mock-model" });

  const disabled = runCli(["explain", "--config", disabledFile, "--state", stateFile]);
  assert.equal(disabled.status, 0);
  const disabledResult = disabled.json?.result as Record<string, unknown>;
  assert.deepEqual(responseKeys(disabledResult), ["advisory", "advisoryOnly", "model", "provider"]);
  assert.equal(disabledResult.advisoryOnly, true);
  assert.equal(disabledResult.provider, "disabled");
  assert.match(String(disabledResult.advisory), /不可用/);

  const first = runCli(["explain", "--config", mockFile, "--state", stateFile]);
  const second = runCli(["explain", "--config", mockFile, "--state", stateFile]);
  assert.equal(first.status, 0);
  assert.equal(second.status, 0);
  const firstResult = first.json?.result as Record<string, unknown>;
  const secondResult = second.json?.result as Record<string, unknown>;
  assert.deepEqual(responseKeys(firstResult), ["advisory", "advisoryOnly", "model", "provider"]);
  assert.equal(firstResult.provider, "mock");
  assert.equal(firstResult.model, "mock-model");
  assert.equal(firstResult.advisoryOnly, true);
  assert.equal(firstResult.advisory, secondResult.advisory, "mock output must be deterministic");
  // mock 建议文本本身不代表命令输出；结果对象不含执行相关字段。
  for (const forbidden of ["command", "proposal", "approval", "transmit", "rpc"]) {
    assert.equal(forbidden in firstResult, false, `result must not expose ${forbidden}`);
  }
});

test("cwai explain：状态快照非法或缺失时以退出码 3/4 拒绝", (t) => {
  const dir = tempDir(t);
  const mockFile = writeJson(dir, "mock.json", { version: 1, provider: "mock" });
  const missing = runCli(["explain", "--config", mockFile, "--state", join(dir, "missing.json")]);
  assert.equal(missing.status, 3);
  assert.equal(missing.json?.code, "state_not_found");

  const unknownState = writeJson(dir, "bad-state.json", { ...VALID_STATE, extra: true });
  const bad = runCli(["explain", "--config", mockFile, "--state", unknownState]);
  assert.equal(bad.status, 4);
  assert.equal(bad.json?.code, "unknown_state_field");
});

// ── CLI：chat-completions 本地 mock HTTP ───────────────────────────────

test("chat-completions：请求内容正确、响应被解析、只发送所选状态且不落盘密钥", async (t) => {
  const dir = tempDir(t);
  const secret = "sk-test-SECRET-VALUE-123";
  const stateFile = writeJson(dir, "state.json", VALID_STATE);
  // 同一目录放一个无关文件，确认不会被上传。
  writeFileSync(join(dir, "unrelated.txt"), "OTHER_FILE_MARKER", "utf8");

  const server = await startServer(t, (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "  backend advice  " } }] }));
  });
  const configFile = writeJson(dir, "chat.json", {
    version: 1,
    provider: "chat-completions",
    endpoint: server.endpoint,
    model: "test-model",
    apiKeyEnv: "CWAI_TEST_KEY",
    maxOutputTokens: 64,
  });

  const before = readdirSync(dir).sort();
  const run = await runCliAsync(["explain", "--config", configFile, "--state", stateFile], { CWAI_TEST_KEY: secret });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const result = run.json?.result as Record<string, unknown>;
  assert.deepEqual(responseKeys(result), ["advisory", "advisoryOnly", "model", "provider"]);
  assert.equal(result.advisory, "backend advice");
  assert.equal(result.provider, "chat-completions");
  assert.equal(result.model, "test-model");
  assert.equal(result.advisoryOnly, true);

  assert.equal(server.requests.length, 1);
  const request = server.requests[0];
  assert.equal(request?.method, "POST");
  assert.equal(request?.url, "/v1/chat/completions");
  assert.equal(request?.headers.authorization, `Bearer ${secret}`);
  const body = JSON.parse(request?.body ?? "{}") as { model: string; max_tokens: number; messages: Array<{ role: string; content: string }> };
  assert.equal(body.model, "test-model");
  assert.equal(body.max_tokens, 64);
  assert.match(body.messages[1]?.content ?? "", /"frequencyHz":14030000/);
  assert.equal(request?.body.includes("OTHER_FILE_MARKER"), false, "must not upload unrelated files");
  assert.equal(request?.body.includes(secret), false, "credential must not be in the request body");

  // 密钥不落盘：CLI 不新增文件，临时目录任何文件都不含密钥。
  assert.deepEqual(readdirSync(dir).sort(), before);
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isFile()) {
      assert.equal(readFileSync(full, "utf8").includes(secret), false, `${name} must not persist the credential`);
    }
  }
  // 输出与错误流都不泄露凭据。
  assert.equal(run.stdout.includes(secret), false);
  assert.equal(run.stderr.includes(secret), false);
});

test("chat-completions：坏 JSON、空输出与非法结构都返回确定性错误且不回显 body", async (t) => {
  const dir = tempDir(t);
  const stateFile = writeJson(dir, "state.json", VALID_STATE);
  const secret = "sk-test-SECRET-VALUE-456";

  const cases: Array<{ name: string; handler: (res: http.ServerResponse) => void; code: string }> = [
    { name: "bad-json", code: "response_invalid", handler: (res) => res.end("SECRET_BODY_MARKER not json") },
    { name: "empty", code: "empty_output", handler: (res) => res.end(JSON.stringify({ choices: [{ message: { content: "   " } }] })) },
    { name: "shape", code: "response_invalid", handler: (res) => res.end(JSON.stringify({ choices: [] })) },
  ];

  for (const item of cases) {
    const server = await startServer(t, (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      item.handler(res);
    });
    const configFile = writeJson(dir, `${item.name}.json`, {
      version: 1,
      provider: "chat-completions",
      endpoint: server.endpoint,
      model: "m",
      apiKeyEnv: "CWAI_TEST_KEY",
    });
    const run = await runCliAsync(["explain", "--config", configFile, "--state", stateFile], { CWAI_TEST_KEY: secret });
    assert.equal(run.status, 5, `${item.name}: ${run.stdout}${run.stderr}`);
    assert.equal(run.json?.code, item.code, item.name);
    assert.equal(run.stdout.includes("SECRET_BODY_MARKER"), false, `${item.name}: backend body must not leak`);
    assert.equal(run.stdout.includes(secret), false, `${item.name}: credential must not leak`);
    await server.close();
  }
});

test("chat-completions：HTTP 错误与重定向被拒绝，且不泄露后端 body/凭据", async (t) => {
  const dir = tempDir(t);
  const stateFile = writeJson(dir, "state.json", VALID_STATE);
  const secret = "sk-test-SECRET-VALUE-789";

  const errorServer = await startServer(t, (_req, res) => {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("BACKEND_SECRET_BODY");
  });
  const errorConfig = writeJson(dir, "error.json", {
    version: 1,
    provider: "chat-completions",
    endpoint: errorServer.endpoint,
    model: "m",
    apiKeyEnv: "CWAI_TEST_KEY",
  });
  const errorRun = await runCliAsync(["explain", "--config", errorConfig, "--state", stateFile], { CWAI_TEST_KEY: secret });
  assert.equal(errorRun.status, 5);
  assert.equal(errorRun.json?.code, "http_error");
  assert.equal(errorRun.stdout.includes("BACKEND_SECRET_BODY"), false);
  assert.equal(errorRun.stdout.includes(secret), false);

  let redirectTargetHits = 0;
  const targetServer = await startServer(t, (_req, res) => {
    redirectTargetHits += 1;
    res.end("should not be reached");
  });
  const redirectServer = await startServer(t, (_req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${new URL(targetServer.endpoint).port}/steal` });
    res.end();
  });
  const redirectConfig = writeJson(dir, "redirect.json", {
    version: 1,
    provider: "chat-completions",
    endpoint: redirectServer.endpoint,
    model: "m",
    apiKeyEnv: "CWAI_TEST_KEY",
  });
  const redirectRun = await runCliAsync(["explain", "--config", redirectConfig, "--state", stateFile], { CWAI_TEST_KEY: secret });
  assert.equal(redirectRun.status, 5);
  assert.equal(redirectRun.json?.code, "redirect_rejected");
  assert.equal(redirectServer.requests.length, 1, "client must not follow the redirect");
  assert.equal(redirectTargetHits, 0, "redirect target must never be contacted");
  assert.equal(redirectRun.stdout.includes(secret), false);

  await errorServer.close();
  await redirectServer.close();
  await targetServer.close();
});

test("chat-completions：超时覆盖读取响应体，且不重试", async (t) => {
  const dir = tempDir(t);
  const stateFile = writeJson(dir, "state.json", VALID_STATE);
  const server = await startServer(t, (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    // 先发送部分 body，再长时间不结束：超时必须覆盖读取 body。
    res.write('{"choices":[{"message":{"content":"slow');
    const timer = setTimeout(() => {
      try {
        res.end('"}}]}');
      } catch {
        // 客户端已中止。
      }
    }, 2_000);
    timer.unref();
  });
  const configFile = writeJson(dir, "timeout.json", {
    version: 1,
    provider: "chat-completions",
    endpoint: server.endpoint,
    model: "m",
    apiKeyEnv: "CWAI_TEST_KEY",
    timeoutMs: 100,
  });
  const started = Date.now();
  const run = await runCliAsync(["explain", "--config", configFile, "--state", stateFile], { CWAI_TEST_KEY: "sk-timeout" });
  const elapsed = Date.now() - started;
  assert.equal(run.status, 5);
  assert.equal(run.json?.code, "timeout");
  assert.equal(server.requests.length, 1, "no retry is performed");
  assert.ok(elapsed < 5_000, `timeout should fail fast, took ${elapsed}ms`);
  await server.close();
});

test("chat-completions：超大响应在读取上限处中止", async (t) => {
  const dir = tempDir(t);
  const stateFile = writeJson(dir, "state.json", VALID_STATE);
  const server = await startServer(t, (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    const filler = "A".repeat(ASSISTANT_LIMITS.RESPONSE_MAX_BYTES + 4096);
    res.end(JSON.stringify({ choices: [{ message: { content: filler } }] }));
  });
  const configFile = writeJson(dir, "oversize.json", {
    version: 1,
    provider: "chat-completions",
    endpoint: server.endpoint,
    model: "m",
    apiKeyEnv: "CWAI_TEST_KEY",
  });
  const run = await runCliAsync(["explain", "--config", configFile, "--state", stateFile], { CWAI_TEST_KEY: "sk-oversize" });
  assert.equal(run.status, 5);
  assert.equal(run.json?.code, "response_too_large");
  await server.close();
});

test("chat-completions：缺少环境变量时在联网前以 credential_missing 失败", async (t) => {
  const dir = tempDir(t);
  const stateFile = writeJson(dir, "state.json", VALID_STATE);
  let hits = 0;
  const server = await startServer(t, (_req, res) => {
    hits += 1;
    res.end("{}");
  });
  const configFile = writeJson(dir, "cred.json", {
    version: 1,
    provider: "chat-completions",
    endpoint: server.endpoint,
    model: "m",
    apiKeyEnv: "CWAI_TEST_MISSING_KEY",
  });
  const run = await runCliAsync(["explain", "--config", configFile, "--state", stateFile], { CWAI_TEST_MISSING_KEY: "" });
  assert.equal(run.status, 5);
  assert.equal(run.json?.code, "credential_missing");
  assert.equal(hits, 0, "must fail before any network request");
  // 只报告变量名，不回显其值。
  assert.match(String(run.json?.error), /CWAI_TEST_MISSING_KEY/);
  await server.close();
});

// ── 文件上限 ────────────────────────────────────────────────────────────

test("shared entry validates before fetch and refuses a credential echoed in successful text", async () => {
  let calls = 0;
  const config = chatConfig("http://127.0.0.1:9999/v1/chat/completions");
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: "echoed test-secret-credential" } }] }));
  };
  await assert.rejects(
    explainState({ ...VALID_STATE, txBusy: "false" } as unknown as StationStateSnapshot, config, { fetchImpl }),
    (error: unknown) => error instanceof AssistantError && error.code === "invalid_state",
  );
  await assert.rejects(
    explainState(VALID_STATE, { ...config, endpoint: "http://example.invalid/api" }, { fetchImpl }),
    (error: unknown) => error instanceof AssistantError && error.code === "insecure_endpoint",
  );
  assert.equal(calls, 0);
  await assert.rejects(
    explainState(VALID_STATE, config, { fetchImpl, env: { CWAI_TEST_KEY: "test-secret-credential" } }),
    (error: unknown) => error instanceof AssistantError && error.code === "response_invalid" && !error.message.includes("test-secret-credential"),
  );
  assert.equal(calls, 1);
});

test("状态文件超过上限时在解析前被拒绝", (t) => {
  const dir = tempDir(t);
  const mockFile = writeJson(dir, "mock.json", { version: 1, provider: "mock" });
  const bigState = join(dir, "big-state.json");
  writeFileSync(bigState, JSON.stringify({ ...VALID_STATE, blockedReason: "x".repeat(ASSISTANT_LIMITS.STATE_FILE_MAX_BYTES) }), "utf8");
  const run = runCli(["explain", "--config", mockFile, "--state", bigState]);
  assert.equal(run.status, 4);
  assert.equal(run.json?.code, "state_too_large");
});
