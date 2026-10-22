// V00-02：fldigi 只读收报薄适配专项。
// 使用 Node 本机脚本化 HTTP 服务/注入 fetch，不启动 fldigi、不建常驻 Fake 服务。

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
// V00-02-C：fldigi 生产调用者已退出；本文件只验证冻结的客户端实现本身。
// 此文件直接导入冻结文件，不从公共出口导出旧能力。
import {
  FldigiReceiveClient,
  FldigiReceiveError,
  FldigiReceiveSession,
  parseFldigiReceiveEndpoint,
} from "../packages/receive/src/fldigi.js";

const XML_DECL = '<?xml version="1.0"?>';

interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

type JsonRecord = Record<string, unknown>;

function rpcBase64(base64: string): string {
  return `${XML_DECL}<methodResponse><params><param><value><base64>${base64}</base64>` +
    "</value></param></params></methodResponse>";
}

function rpcText(text: string): string {
  return rpcBase64(Buffer.from(text, "utf8").toString("base64"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function serve(
  t: TestContext,
  handler: (request: RecordedRequest, response: ServerResponse) => void | Promise<void>,
): Promise<{ url: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      const recorded: RecordedRequest = {
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        body,
      };
      requests.push(recorded);
      Promise.resolve(handler(recorded, response)).catch(() => {
        if (!response.headersSent) response.writeHead(500);
        if (!response.destroyed) response.end();
      });
    });
    request.on("error", () => undefined);
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { url: `http://127.0.0.1:${address.port}/RPC2`, requests };
}

function isReceiveError(code: string): (error: unknown) => boolean {
  return (error: unknown): boolean => error instanceof FldigiReceiveError && error.code === code;
}

test("receive endpoint is limited to explicit loopback http /RPC2", () => {
  const ipv4 = parseFldigiReceiveEndpoint("http://127.0.0.1:7362/RPC2");
  assert.deepEqual({ host: ipv4.host, port: ipv4.port }, { host: "127.0.0.1", port: 7362 });
  assert.equal(parseFldigiReceiveEndpoint("http://[::1]:7362/RPC2").host, "[::1]");
  const invalid = [
    "http://localhost:7362/RPC2",
    "http://192.168.1.2:7362/RPC2",
    "https://127.0.0.1:7362/RPC2",
    "http://user:password@127.0.0.1:7362/RPC2",
    "http://127.0.0.1:7362/RPC2?x=1",
    "http://127.0.0.1:7362/RPC2#fragment",
    "http://127.0.0.1:7362/other",
    "http://127.0.0.1/RPC2",
    " http://127.0.0.1:7362/RPC2",
  ];
  for (const endpoint of invalid) {
    assert.throws(() => parseFldigiReceiveEndpoint(endpoint), isReceiveError("invalid_endpoint"), endpoint);
  }
});

test("client posts only rx.get_data and completes each read before the next", async (t) => {
  let count = 0;
  const fixture = await serve(t, (_request, response) => {
    count += 1;
    response.writeHead(200, { "content-type": "text/xml; charset=utf-8" });
    response.end(count === 1 ? rpcText("CQ TEST") : rpcBase64(""));
  });
  const client = new FldigiReceiveClient({ endpoint: fixture.url, timeoutMs: 1000 });
  assert.equal(await client.readText(), "CQ TEST");
  assert.equal(await client.readText(), "");
  assert.equal(fixture.requests.length, 2);
  for (const request of fixture.requests) {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/RPC2");
    assert.match(request.headers["content-type"] ?? "", /^text\/xml/i);
    assert.equal((request.body.match(/<methodName>/g) ?? []).length, 1);
    assert.match(request.body, /<methodName>rx\.get_data<\/methodName>/);
    assert.doesNotMatch(request.body, /main\.|text\.|rig\.|tune|abort/);
  }
});

test("actual fldigi response whitespace supports empty and non-empty buffers", async (t) => {
  let count = 0;
  const fixture = await serve(t, (_request, response) => {
    response.writeHead(200, { "content-type": "text/xml" });
    const payload = count++ === 0 ? "" : Buffer.from(" CQ TEST ").toString("base64");
    response.end(`${XML_DECL}\r\n<methodResponse><params><param>\r\n\t` +
      `<value><base64>${payload}</base64></value>\r\n</param></params></methodResponse>\r\n`);
  });
  const client = new FldigiReceiveClient({ endpoint: fixture.url });
  assert.equal(await client.readText(), "");
  assert.equal(await client.readText(), " CQ TEST ");
});

test("one client rejects a concurrent read as busy", async (t) => {
  const fixture = await serve(t, (_request, response) => {
    setTimeout(() => {
      if (!response.destroyed) {
        response.writeHead(200, { "content-type": "text/xml" });
        response.end(rpcText("A"));
      }
    }, 50);
  });
  const client = new FldigiReceiveClient({ endpoint: fixture.url, timeoutMs: 1000 });
  const first = client.readText();
  await assert.rejects(client.readText(), isReceiveError("busy"));
  assert.equal(await first, "A");
  assert.equal(fixture.requests.length, 1);
});

test("empty reads produce no chunk while non-empty chunks advance the session sequence", async (t) => {
  let count = 0;
  const fixture = await serve(t, (_request, response) => {
    count += 1;
    response.writeHead(200, { "content-type": "text/xml" });
    response.end(count === 1 ? rpcBase64("") : rpcText("DE BD7XXX"));
  });
  const client = new FldigiReceiveClient({ endpoint: fixture.url, timeoutMs: 1000 });
  const session = new FldigiReceiveSession({
    client,
    sessionId: "session-1",
    now: () => new Date("2026-10-20T12:00:00.000Z"),
  });
  assert.equal(await session.next(), null);
  assert.equal(session.seq, 0);
  assert.deepEqual(await session.next(), {
    source: "fldigi",
    readOnly: true,
    sessionId: "session-1",
    seq: 1,
    text: "DE BD7XXX",
    receivedAt: "2026-10-20T12:00:00.000Z",
  });
  assert.equal(session.seq, 1);
});

test("an XML-RPC fault is rejected without echoing server fault text", async (t) => {
  const secret = "server-internal-detail";
  const fault = `${XML_DECL}<methodResponse><fault><value><struct>` +
    "<member><name>faultCode</name><value><int>7</int></value></member>" +
    `<member><name>faultString</name><value><string>${secret}</string></value></member>` +
    "</struct></value></fault></methodResponse>";
  const fixture = await serve(t, (_request, response) => {
    response.writeHead(200, { "content-type": "text/xml" });
    response.end(fault);
  });
  const client = new FldigiReceiveClient({ endpoint: fixture.url, timeoutMs: 1000 });
  let caught: unknown;
  try { await client.readText(); } catch (error) { caught = error; }
  assert.ok(caught instanceof FldigiReceiveError);
  assert.equal(caught.code, "xml_fault");
  assert.match(caught.message, /code 7/);
  assert.doesNotMatch(caught.message, new RegExp(secret));
});

test("malformed XML, DTD, non-base64, wrong shapes and invalid UTF-8 are rejected", async (t) => {
  let responseBody = "";
  const fixture = await serve(t, (_request, response) => {
    response.writeHead(200, { "content-type": "text/xml" });
    response.end(responseBody);
  });
  const client = new FldigiReceiveClient({ endpoint: fixture.url, timeoutMs: 1000 });
  const cases: Array<{ name: string; body: string; code: string }> = [
    { name: "malformed XML", body: "<methodResponse><params>", code: "invalid_xml" },
    { name: "DTD", body: `<!DOCTYPE methodResponse [<!ENTITY x "y">]>${rpcText("X")}`, code: "invalid_xml" },
    {
      name: "non-base64 result",
      body: `${XML_DECL}<methodResponse><params><param><value><string>X</string>` +
        "</value></param></params></methodResponse>",
      code: "invalid_result",
    },
    { name: "invalid base64", body: rpcBase64("@@@"), code: "invalid_base64" },
    {
      name: "multiple params",
      body: `${XML_DECL}<methodResponse><params>` +
        "<param><value><base64>QQ==</base64></value></param>" +
        "<param><value><base64>Qg==</base64></value></param>" +
        "</params></methodResponse>",
      code: "invalid_result",
    },
    { name: "missing root", body: "<foo/>", code: "invalid_result" },
    {
      name: "invalid UTF-8",
      body: rpcBase64(Buffer.from([0xff, 0xfe]).toString("base64")),
      code: "invalid_utf8",
    },
  ];
  for (const item of cases) {
    responseBody = item.body;
    await assert.rejects(client.readText(), isReceiveError(item.code), item.name);
  }
});

test("an oversized XML-RPC response is rejected at the configured limit", async (t) => {
  const fixture = await serve(t, (_request, response) => {
    response.writeHead(200, { "content-type": "text/xml" });
    response.end(rpcText("A".repeat(200)));
  });
  const client = new FldigiReceiveClient({ endpoint: fixture.url, timeoutMs: 1000, maxResponseBytes: 64 });
  await assert.rejects(client.readText(), isReceiveError("response_too_large"));
});

test("timeout and disconnect end the current stream with explicit failures", async (t) => {
  await t.test("timeout covers a body that never completes", async (t2) => {
    const fixture = await serve(t2, (_request, response) => {
      response.writeHead(200, { "content-type": "text/xml" });
      response.write(`${XML_DECL}<methodResponse><params><param><value><base64>QQ`);
    });
    const client = new FldigiReceiveClient({ endpoint: fixture.url, timeoutMs: 80 });
    const started = Date.now();
    await assert.rejects(client.readText(), isReceiveError("timeout"));
    assert.ok(Date.now() - started >= 50);
  });

  await t.test("network failure is reported once without automatic retry", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      throw new TypeError("fetch failed");
    };
    const client = new FldigiReceiveClient({
      endpoint: "http://127.0.0.1:7362/RPC2",
      timeoutMs: 1000,
      fetch: fetchImpl,
    });
    await assert.rejects(client.readText(), isReceiveError("network"));
    assert.equal(calls, 1);
  });
});

test("abort discards a late response instead of emitting text", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    await sleep(80);
    return new Response(rpcText("LATE"), { status: 200, headers: { "content-type": "text/xml" } });
  };
  const client = new FldigiReceiveClient({
    endpoint: "http://127.0.0.1:7362/RPC2",
    timeoutMs: 1000,
    fetch: fetchImpl,
  });
  const session = new FldigiReceiveSession({ client, sessionId: "abort-session" });
  const controller = new AbortController();
  const pending = session.next(controller.signal);
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, isReceiveError("aborted"));
  await sleep(120);
  assert.equal(calls, 1);
  assert.equal(session.seq, 0);
});
