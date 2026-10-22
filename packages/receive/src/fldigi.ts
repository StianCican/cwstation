// V00-02：fldigi 只读收报适配。
//
// 只向本机回环 XML-RPC 端点发送固定的 rx.get_data 请求；不暴露任意方法调用、
// 发报、改频、PTT 或清空文本能力。空结果表示“本次没有新字符”，不是解码成功。

import { randomUUID } from "node:crypto";
import { XMLParser, XMLValidator } from "fast-xml-parser";

export const FLDIGI_RECEIVE_DEFAULT_TIMEOUT_MS = 5_000;
export const FLDIGI_RECEIVE_MAX_TIMEOUT_MS = 120_000;
export const FLDIGI_RECEIVE_DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
export const FLDIGI_RECEIVE_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

const RX_GET_DATA_REQUEST =
  '<?xml version="1.0"?><methodCall><methodName>rx.get_data</methodName><params></params></methodCall>';

const XML_PARSER = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
  isArray: (name: string) => name === "param" || name === "member",
});

export type FldigiReceiveErrorCode =
  | "invalid_endpoint"
  | "invalid_options"
  | "busy"
  | "http_status"
  | "timeout"
  | "aborted"
  | "network"
  | "response_too_large"
  | "invalid_xml"
  | "xml_fault"
  | "invalid_result"
  | "invalid_base64"
  | "invalid_utf8";

export class FldigiReceiveError extends Error {
  readonly code: FldigiReceiveErrorCode;

  constructor(code: FldigiReceiveErrorCode, message: string) {
    super(message);
    this.name = "FldigiReceiveError";
    this.code = code;
  }
}

export interface FldigiEndpoint {
  /** 规范化后的完整端点；只可能是 http://127.0.0.1:<port>/RPC2 或 http://[::1]:<port>/RPC2。 */
  readonly href: string;
  readonly host: "127.0.0.1" | "[::1]";
  readonly port: number;
}

/** 仅接受显式回环字面地址、http、显式端口、精确 /RPC2，不允许凭据/查询/片段。 */
export function parseFldigiReceiveEndpoint(endpoint: string): FldigiEndpoint {
  if (endpoint.length === 0 || endpoint.trim() !== endpoint) {
    throw new FldigiReceiveError("invalid_endpoint", "receive endpoint must be an explicit non-empty URL");
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new FldigiReceiveError("invalid_endpoint", "receive endpoint is not a valid URL");
  }
  if (url.protocol !== "http:") {
    throw new FldigiReceiveError("invalid_endpoint", "receive endpoint must use http");
  }
  if (url.username !== "" || url.password !== "") {
    throw new FldigiReceiveError("invalid_endpoint", "receive endpoint must not contain credentials");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new FldigiReceiveError("invalid_endpoint", "receive endpoint must not contain a query or fragment");
  }
  if (url.pathname !== "/RPC2") {
    throw new FldigiReceiveError("invalid_endpoint", "receive endpoint path must be exactly /RPC2");
  }
  if (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") {
    throw new FldigiReceiveError("invalid_endpoint", "receive endpoint host must be the literal 127.0.0.1 or [::1]");
  }
  if (url.port === "") {
    throw new FldigiReceiveError("invalid_endpoint", "receive endpoint must declare an explicit port");
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new FldigiReceiveError("invalid_endpoint", "receive endpoint port must be 1..65535");
  }
  return Object.freeze({ href: url.href, host: url.hostname as FldigiEndpoint["host"], port });
}

export interface FldigiReceiveClientOptions {
  endpoint: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

/** 单个实例同一时间只允许一项在途读取；调用方必须在上一项完成后才发起下一项。 */
export class FldigiReceiveClient {
  readonly endpoint: FldigiEndpoint;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly #fetch: typeof fetch;
  #inFlight = false;

  constructor(options: FldigiReceiveClientOptions) {
    this.endpoint = parseFldigiReceiveEndpoint(options.endpoint);
    const timeoutMs = options.timeoutMs ?? FLDIGI_RECEIVE_DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > FLDIGI_RECEIVE_MAX_TIMEOUT_MS) {
      throw new FldigiReceiveError("invalid_options", `receive timeout must be 1..${FLDIGI_RECEIVE_MAX_TIMEOUT_MS} ms`);
    }
    const maxResponseBytes = options.maxResponseBytes ?? FLDIGI_RECEIVE_DEFAULT_MAX_RESPONSE_BYTES;
    if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 ||
        maxResponseBytes > FLDIGI_RECEIVE_MAX_RESPONSE_BYTES) {
      throw new FldigiReceiveError("invalid_options",
        `receive response limit must be 1..${FLDIGI_RECEIVE_MAX_RESPONSE_BYTES} bytes`);
    }
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  /** 取走服务端当前缓冲文本；响应丢失也可能已消耗文本，失败后不能假定可重读。 */
  async readText(signal?: AbortSignal): Promise<string> {
    if (this.#inFlight) {
      throw new FldigiReceiveError("busy", "a receive read is already in flight for this client");
    }
    if (signal?.aborted) throw abortedError();
    this.#inFlight = true;
    try {
      return await this.#request(signal);
    } finally {
      this.#inFlight = false;
    }
  }

  async #request(signal?: AbortSignal): Promise<string> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    timer.unref();
    const onAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      let response: Response;
      try {
        response = await this.#fetch(this.endpoint.href, {
          method: "POST",
          headers: { "content-type": "text/xml; charset=utf-8", connection: "close" },
          body: RX_GET_DATA_REQUEST,
          redirect: "error",
          signal: controller.signal,
        });
      } catch {
        throw failureFor(timedOut, signal, controller.signal);
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new FldigiReceiveError("http_status",
          `fldigi XML-RPC returned HTTP status ${response.status}`);
      }
      let bytes: Uint8Array;
      try {
        bytes = await this.#readBoundedBody(response);
      } catch (error) {
        if (error instanceof FldigiReceiveError) throw error;
        throw failureFor(timedOut, signal, controller.signal);
      }
      if (timedOut) throw new FldigiReceiveError("timeout", "fldigi XML-RPC request timed out");
      if (signal?.aborted) throw abortedError();
      return parseRxPayload(decodeXml(bytes));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async #readBoundedBody(response: Response): Promise<Uint8Array> {
    const body = response.body;
    if (body === null) {
      throw new FldigiReceiveError("invalid_result", "fldigi XML-RPC response had no body");
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        total += value.byteLength;
        if (total > this.maxResponseBytes) {
          await reader.cancel().catch(() => undefined);
          throw new FldigiReceiveError("response_too_large",
            `fldigi XML-RPC response exceeds ${this.maxResponseBytes} bytes`);
        }
        chunks.push(value);
      }
    } finally {
      try { reader.releaseLock(); } catch { /* already released by cancel */ }
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return merged;
  }
}

/** 一次接收会话的公开事件；seq 只表示本会话内的读取顺序。 */
export interface RxChunk {
  readonly source: "fldigi";
  readonly readOnly: true;
  readonly sessionId: string;
  readonly seq: number;
  readonly text: string;
  readonly receivedAt: string;
}

export interface FldigiReceiveSessionOptions {
  client: FldigiReceiveClient;
  sessionId?: string;
  now?: () => Date;
}

/** 为界面/CLI 提供同一文本流的薄会话层；不建立跨进程扇出服务。 */
export class FldigiReceiveSession {
  readonly sessionId: string;
  readonly #client: FldigiReceiveClient;
  readonly #now: () => Date;
  #seq = 0;

  constructor(options: FldigiReceiveSessionOptions) {
    this.#client = options.client;
    this.sessionId = options.sessionId ?? randomUUID();
    this.#now = options.now ?? (() => new Date());
  }

  get seq(): number {
    return this.#seq;
  }

  /** 返回值 null 表示本次无新字符；不会为空的读取编造文本。 */
  async next(signal?: AbortSignal): Promise<RxChunk | null> {
    const text = await this.#client.readText(signal);
    if (text.length === 0) return null;
    if (signal?.aborted) throw abortedError();
    this.#seq += 1;
    return {
      source: "fldigi",
      readOnly: true,
      sessionId: this.sessionId,
      seq: this.#seq,
      text,
      receivedAt: this.#now().toISOString(),
    };
  }
}

function abortedError(): FldigiReceiveError {
  return new FldigiReceiveError("aborted", "fldigi receive read was aborted");
}

function failureFor(timedOut: boolean, external: AbortSignal | undefined,
  internal: AbortSignal): FldigiReceiveError {
  if (timedOut) return new FldigiReceiveError("timeout", "fldigi XML-RPC request timed out");
  if (external?.aborted || internal.aborted) return abortedError();
  return new FldigiReceiveError("network", "fldigi XML-RPC request failed");
}

function decodeXml(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new FldigiReceiveError("invalid_xml", "fldigi XML-RPC response is not valid UTF-8");
  }
}

function parseRxPayload(xml: string): string {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) {
    throw new FldigiReceiveError("invalid_xml", "fldigi XML-RPC response contains a forbidden declaration");
  }
  if (XMLValidator.validate(xml) !== true) {
    throw new FldigiReceiveError("invalid_xml", "fldigi XML-RPC response is not well-formed XML");
  }
  let parsed: unknown;
  try {
    parsed = XML_PARSER.parse(xml);
  } catch {
    throw new FldigiReceiveError("invalid_xml", "fldigi XML-RPC response is not well-formed XML");
  }
  const root = asRecord(parsed);
  if (root === null || Object.keys(root).length !== 1) {
    throw new FldigiReceiveError("invalid_result", "fldigi XML-RPC response must have one methodResponse root");
  }
  const response = asRecord(root.methodResponse);
  if (response === null) {
    throw new FldigiReceiveError("invalid_result", "fldigi XML-RPC response has no methodResponse");
  }
  if ("fault" in response) {
    const code = faultCodeOf(response.fault);
    throw new FldigiReceiveError("xml_fault",
      code === null ? "fldigi XML-RPC fault" : `fldigi XML-RPC fault (code ${code})`);
  }
  if (Object.keys(response).length !== 1 || !("params" in response)) {
    throw new FldigiReceiveError("invalid_result", "fldigi XML-RPC response is neither params nor fault");
  }
  const params = asRecord(response.params);
  const param = params?.param;
  if (params === null || Object.keys(params).length !== 1 || !Array.isArray(param) || param.length !== 1) {
    throw new FldigiReceiveError("invalid_result", "fldigi XML-RPC response must contain exactly one param");
  }
  const singleParam = asRecord(param[0]);
  if (singleParam === null || Object.keys(singleParam).length !== 1) {
    throw new FldigiReceiveError("invalid_result", "fldigi XML-RPC param is malformed");
  }
  const value = asRecord(singleParam.value);
  if (value === null || Object.keys(value).length !== 1 || !("base64" in value)) {
    throw new FldigiReceiveError("invalid_result", "fldigi XML-RPC rx.get_data result must be one base64 value");
  }
  const raw = value.base64;
  if (typeof raw !== "string") {
    throw new FldigiReceiveError("invalid_result", "fldigi XML-RPC base64 value is not text");
  }
  const compact = raw.replace(/\s+/g, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) {
    throw new FldigiReceiveError("invalid_base64", "fldigi XML-RPC base64 value is not canonical base64");
  }
  const bytes = Buffer.from(compact, "base64");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new FldigiReceiveError("invalid_utf8", "fldigi received bytes are not valid UTF-8");
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function faultCodeOf(fault: unknown): number | null {
  const value = asRecord(asRecord(fault)?.value);
  const struct = asRecord(value?.struct);
  const members = struct?.member;
  if (!Array.isArray(members)) return null;
  for (const member of members) {
    const record = asRecord(member);
    if (record === null || record.name !== "faultCode") continue;
    const intValue = asRecord(record.value)?.int;
    const text = typeof intValue === "number" ? String(intValue) : intValue;
    if (typeof text === "string" && /^-?\d+$/.test(text)) return Number(text);
  }
  return null;
}
