// V00-02-C：后台 multimon-ng 收报专项。
// 使用项目内临时目录中的实际 Node 短生命周期子进程夹具；不启动真实 multimon-ng、
// 不接电台，也不访问项目外目录。

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MULTIMON_RECEIVE_SILENCE_BYTES,
  MultimonReceiveError,
  runMultimonReceive,
  type MultimonRxChunk,
  type PcmByteSource,
} from "../packages/receive/src/index.js";
import { runReceive } from "../apps/rig-receive.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const NOW = (): Date => new Date("2026-10-20T12:34:56.000Z");
const WINDOWS_SKIP = process.platform === "win32"
  ? "POSIX executable fixtures are not verified on Windows; real Windows support is unclaimed"
  : false;

type JsonRecord = Record<string, unknown>;

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(ROOT, "tests", ".tmp-multimon-"));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  return dir;
}

interface Fixture {
  readonly file: string;
  readonly argvLog: string;
}

async function fixture(t: TestContext, name: string, body: string): Promise<Fixture> {
  const dir = await tempDir(t);
  const file = join(dir, `${name}.mjs`);
  const argvLog = join(dir, `${name}.argv.json`);
  const source = `#!/usr/bin/env node
import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));
${body}
`;
  await writeFile(file, source, "utf8");
  await chmod(file, 0o755);
  return { file, argvLog };
}

function sourceOf(chunks: readonly Uint8Array[]): PcmByteSource {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
      for (const chunk of chunks) yield chunk;
    },
  };
}

interface Collected {
  readonly result: Awaited<ReturnType<typeof runMultimonReceive>>;
  readonly chunks: MultimonRxChunk[];
}

async function collect(
  decoder: string,
  source: PcmByteSource,
  overrides: {
    timeoutMs?: number;
    maxStdoutBytes?: number;
    maxStderrRetainedBytes?: number;
    signal?: AbortSignal;
    onChunk?: (chunk: MultimonRxChunk) => void | Promise<void>;
  } = {},
): Promise<Collected> {
  const chunks: MultimonRxChunk[] = [];
  const result = await runMultimonReceive({
    decoder,
    source,
    sessionId: "session-1",
    timeoutMs: overrides.timeoutMs ?? 5_000,
    now: NOW,
    onChunk: overrides.onChunk ?? ((chunk): void => { chunks.push(chunk); }),
    ...(overrides.maxStdoutBytes === undefined ? {} : { maxStdoutBytes: overrides.maxStdoutBytes }),
    ...(overrides.maxStderrRetainedBytes === undefined
      ? {}
      : { maxStderrRetainedBytes: overrides.maxStderrRetainedBytes }),
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
  });
  return { result, chunks };
}

function isMultimonError(code: string): (error: unknown) => boolean {
  return (error: unknown): boolean => error instanceof MultimonReceiveError && error.code === code;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("standalone word separator survives streaming", { skip: WINDOWS_SKIP }, async (t) => {
  const f = await fixture(t, "word-space", `
process.stdin.resume();
process.stdout.write("CQ");
setTimeout(() => process.stdout.write(" "), 80);
setTimeout(() => process.stdout.write("TEST\\n"), 160);
`);
  const { chunks } = await collect(f.file, sourceOf([new Uint8Array([1, 2])]));
  assert.equal(chunks.map((chunk) => chunk.text).join(""), "CQ TEST");
});

test("empty PCM has no padding or decoded framing", { skip: WINDOWS_SKIP }, async (t) => {
  const f = await fixture(t, "empty-input", `
let total = 0;
process.stdin.on("data", (chunk) => { total += chunk.length; });
process.stdin.on("end", () => {
  fs.writeFileSync(process.argv[1] + ".bytes", String(total));
  process.stdout.write("\\n");
});
`);
  const { chunks } = await collect(f.file, sourceOf([]));
  assert.equal(await readFile(f.file + ".bytes", "utf8"), "0");
  assert.equal(chunks.length, 0);
});

test("pre-aborted CLI never opens input", async () => {
  const controller = new AbortController();
  controller.abort();
  let opened = false;
  const lines: JsonRecord[] = [];
  const code = await runReceive(["--decoder", "/unused", "--pcm-s16le", "/unused"], {
    signal: controller.signal,
    print: (value) => { lines.push(value as JsonRecord); },
    openSource: () => { opened = true; throw new Error("must not open"); },
  });
  assert.equal(opened, false);
  assert.equal(code, 0);
  assert.equal(lines.at(-1)?.state, "stopped");
});

test("fixed spawn args, streaming UTF-8 across stdout chunks, bounded stderr", { skip: WINDOWS_SKIP }, async (t) => {
  const f = await fixture(t, "streaming", `
let total = 0;
process.stdin.on("data", (chunk) => { total += chunk.length; });
process.stderr.write("s".repeat(100000));
process.stdout.write("CQ ");
// 把 “收” 的三字节拆到两个相隔 60 ms 的写事件，验证跨 chunk UTF-8 拼接。
setTimeout(() => process.stdout.write(Buffer.from([0xe6, 0x94])), 20);
setTimeout(() => { process.stdout.write(Buffer.from([0xb6])); process.stdout.write(" TEST"); }, 80);
process.stdin.on("end", () => {
  setTimeout(() => process.stdout.write(" " + total, () => process.exit(0)), 140);
});
`);

  const { result, chunks } = await collect(f.file, sourceOf([new Uint8Array([1, 2])]));
  assert.deepEqual(JSON.parse(await readFile(f.argvLog, "utf8")), [
    "-q", "-c", "-a", "MORSE_CW", "-t", "raw", "-",
  ]);
  assert.deepEqual(chunks.map((chunk) => chunk.seq), [1, 2, 3]);
  assert.equal(chunks.map((chunk) => chunk.text).join(""), "CQ 收 TEST 22052");
  assert.equal(chunks[1]?.text.startsWith("收"), true);
  assert.equal(chunks.map((chunk) => chunk.text).join("").includes("\uFFFD"), false);
  for (const chunk of chunks) {
    assert.equal(chunk.source, "multimon-ng");
    assert.equal(chunk.readOnly, true);
    assert.equal(chunk.sessionId, "session-1");
    assert.equal(chunk.receivedAt, "2026-10-20T12:34:56.000Z");
  }
  assert.equal(result.textChunks, 3);
  assert.equal(result.stderrRetainedBytes, 64 * 1024);
  assert.equal(result.exitCode, 0);
});

test("odd byte chunks are joined and normal EOF appends 0.5 s silence", { skip: WINDOWS_SKIP }, async (t) => {
  const f = await fixture(t, "alignment", `
const all = [];
process.stdin.on("data", (chunk) => { all.push(Buffer.from(chunk)); });
process.stdin.on("end", () => {
  const buffer = Buffer.concat(all);
  const tail = buffer.subarray(buffer.length - ${MULTIMON_RECEIVE_SILENCE_BYTES});
  const zero = tail.every((value) => value === 0);
  const head = [...buffer.subarray(0, 4)].join(",");
  process.stdout.write("RESULT:" + buffer.length + ":" + zero + ":" + head, () => process.exit(0));
});
`);
  const { result, chunks } = await collect(f.file, sourceOf([
    new Uint8Array([1]),
    new Uint8Array([2, 3]),
    new Uint8Array([4]),
  ]));
  assert.equal(chunks.map((chunk) => chunk.text).join(""), "RESULT:22054:true:1,2,3,4");
  assert.equal(result.textChunks, 1);
  assert.equal(MULTIMON_RECEIVE_SILENCE_BYTES, 22050);
});

test("odd final remainder and non-byte chunks fail as input_error without silence", { skip: WINDOWS_SKIP }, async (t) => {
  await t.test("odd final remainder", async (t2) => {
    const f = await fixture(t2, "odd", "process.stdin.resume();");
    await assert.rejects(
      collect(f.file, sourceOf([new Uint8Array([1, 2, 3])])),
      isMultimonError("input_error"),
    );
  });
  await t.test("non-byte chunk", async (t2) => {
    const f = await fixture(t2, "nonbyte", "process.stdin.resume();");
    const source = {
      async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
        yield "not bytes" as unknown as Uint8Array;
      },
    };
    await assert.rejects(collect(f.file, source), isMultimonError("input_error"));
  });
});

test("a missing decoder is an explicit failure and is never retried", { skip: WINDOWS_SKIP }, async (t) => {
  const dir = await tempDir(t);
  const missing = join(dir, "does-not-exist");
  let caught: unknown;
  try {
    await collect(missing, sourceOf([new Uint8Array([1, 2])]));
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof MultimonReceiveError);
  assert.equal(caught.code, "decoder_missing");
  assert.equal(caught.cleanupConfirmed, true);
});

test("premature zero exit and non-zero exit are distinct failures", { skip: WINDOWS_SKIP }, async (t) => {
  await t.test("zero exit before input EOF", async (t2) => {
    const f = await fixture(t2, "premature", "process.exit(0);");
    const source: PcmByteSource = {
      async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
        yield new Uint8Array([1, 2]);
        await new Promise(() => undefined);
      },
    };
    await assert.rejects(collect(f.file, source), isMultimonError("premature_exit"));
  });
  await t.test("non-zero exit after complete input", async (t2) => {
    const f = await fixture(t2, "nonzero", "process.stdin.resume(); process.stdin.on(\"end\", () => process.exit(3));");
    await assert.rejects(collect(f.file, sourceOf([new Uint8Array([1, 2])])), isMultimonError("decoder_failed"));
  });
});

test("cancel discards late text, stops input and confirms SIGTERM cleanup", { skip: WINDOWS_SKIP }, async (t) => {
  const dir = await tempDir(t);
  const signalLog = join(dir, "signal.log");
  const f = await fixture(t, "cancel", `
process.stdin.resume();
process.stdout.write("FIRST");
setTimeout(() => { try { process.stdout.write("LATE"); } catch {} }, 150);
process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(signalLog)}, "sigterm"); process.exit(0); });
setInterval(() => {}, 1000);
`);
  const controller = new AbortController();
  const chunks: MultimonRxChunk[] = [];
  await assert.rejects(
    collect(f.file, {
      async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
        yield new Uint8Array([1, 2]);
        await new Promise(() => undefined);
      },
    }, {
      signal: controller.signal,
      onChunk: (chunk): void => {
        chunks.push(chunk);
        controller.abort();
      },
    }),
    (error: unknown): boolean => {
      assert.ok(error instanceof MultimonReceiveError);
      assert.equal(error.code, "aborted");
      assert.equal(error.cleanupConfirmed, true);
      return true;
    },
  );
  await delay(200);
  assert.deepEqual(chunks.map((chunk) => chunk.text), ["FIRST"]);
  assert.equal(await readFile(signalLog, "utf8"), "sigterm");
});

test("total timeout includes input wait and escalates to SIGKILL within bounds", { skip: WINDOWS_SKIP }, async (t) => {
  const dir = await tempDir(t);
  const signalLog = join(dir, "term.log");
  const f = await fixture(t, "stubborn", `
process.stdin.resume();
process.on("SIGTERM", () => { fs.appendFileSync(${JSON.stringify(signalLog)}, "SIGTERM\\n"); });
setInterval(() => {}, 1000);
`);
  const started = Date.now();
  await assert.rejects(
    collect(f.file, {
      async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
        yield new Uint8Array([1, 2]);
        await new Promise(() => undefined);
      },
    }, { timeoutMs: 120 }),
    (error: unknown): boolean => {
      assert.ok(error instanceof MultimonReceiveError);
      assert.equal(error.code, "timeout");
      assert.equal(error.cleanupConfirmed, true);
      return true;
    },
  );
  assert.ok(Date.now() - started >= 500, "SIGKILL escalation must wait the bounded SIGTERM grace");
  assert.equal(await readFile(signalLog, "utf8"), "SIGTERM\n");
});

test("stdout over the byte limit fails and cleans up", { skip: WINDOWS_SKIP }, async (t) => {
  const f = await fixture(t, "output", `
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write("A".repeat(200), () => process.exit(0));
});
`);
  await assert.rejects(
    collect(f.file, sourceOf([new Uint8Array([1, 2])]), { maxStdoutBytes: 64 }),
    isMultimonError("output_limit"),
  );
});

test("text callbacks that throw or never settle stay bounded", { skip: WINDOWS_SKIP }, async (t) => {
  await t.test("a throwing callback terminates the session", async (t2) => {
    const f = await fixture(t2, "callback", `
process.stdin.resume();
process.stdin.on("end", () => process.stdout.write("X", () => process.exit(0)));
`);
    await assert.rejects(
      collect(f.file, sourceOf([new Uint8Array([1, 2])]), {
        onChunk: (): never => { throw new Error("callback boom"); },
      }),
      isMultimonError("callback_failed"),
    );
  });

  await t.test("timeout bounds a never-settling callback", async (t2) => {
    const f = await fixture(t2, "callback-hang", `
process.stdin.resume();
process.stdin.on("end", () => process.stdout.write("X", () => process.exit(0)));
`);
    const started = Date.now();
    await assert.rejects(
      collect(f.file, sourceOf([new Uint8Array([1, 2])]), {
        timeoutMs: 120,
        onChunk: (): Promise<void> => new Promise(() => undefined),
      }),
      isMultimonError("timeout"),
    );
    assert.ok(Date.now() - started < 3_000, "a hung callback must not extend the total timeout");
  });
});

test("pre-aborted sessions do not spawn the decoder", { skip: WINDOWS_SKIP }, async (t) => {
  const f = await fixture(t, "no-spawn", "process.exit(0);");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    collect(f.file, sourceOf([new Uint8Array([1, 2])]), { signal: controller.signal }),
    isMultimonError("aborted"),
  );
  await assert.rejects(access(f.argvLog));
});

test("receive CLI rejects legacy fldigi flags and other usage errors with 2", async () => {
  const cases: readonly (readonly string[])[] = [
    [],
    ["--endpoint", "http://127.0.0.1:7362/RPC2", "--once"],
    ["--decoder", "/decoder", "--pcm-s16le", "-", "--interval-ms", "500"],
    ["--decoder", "/decoder", "--pcm-s16le", "-", "--bogus"],
    ["--decoder", "/decoder", "--decoder", "/other", "--pcm-s16le", "-"],
  ];
  for (const argv of cases) {
    const lines: JsonRecord[] = [];
    assert.equal(await runReceive(argv, { print: (value): void => { lines.push(value as JsonRecord); } }), 2);
    assert.equal(lines[0]?.code, "usage");
    assert.match(String(lines[0]?.usage), /--decoder/);
  }
  const legacy: JsonRecord[] = [];
  await runReceive(["--endpoint", "http://127.0.0.1:7362/RPC2"], {
    print: (value): void => { legacy.push(value as JsonRecord); },
  });
  assert.match(String(legacy[0]?.error), /fldigi receive path is frozen/);
});

test("receive CLI reports chunks, empty completion, runtime failure and confirmed cancel", { skip: WINDOWS_SKIP }, async (t) => {
  await t.test("success and empty are explicit", async (t2) => {
    const ok = await fixture(t2, "cli-ok", `
process.stdin.resume();
process.stdin.on("end", () => process.stdout.write("CQ TEST", () => process.exit(0)));
`);
    const lines: JsonRecord[] = [];
    const code = await runReceive(["--decoder", ok.file, "--pcm-s16le", "-", "--timeout-ms", "5000"], {
      print: (value): void => { lines.push(value as JsonRecord); },
      sessionId: "cli-ok",
      now: NOW,
      source: sourceOf([new Uint8Array([1, 2])]),
    });
    assert.equal(code, 0);
    const chunk = lines.find((line) => line.type === "chunk");
    assert.equal(chunk?.source, "multimon-ng");
    assert.equal(chunk?.readOnly, true);
    assert.equal(chunk?.sessionId, "cli-ok");
    assert.equal(chunk?.seq, 1);
    assert.equal(chunk?.text, "CQ TEST");
    assert.deepEqual(lines.filter((line) => line.type === "status").map((line) => line.state), ["started", "completed"]);
    assert.equal(lines.at(-1)?.decoded, true);

    const empty = await fixture(t2, "cli-empty", "process.stdin.resume();");
    const emptyLines: JsonRecord[] = [];
    assert.equal(await runReceive(["--decoder", empty.file, "--pcm-s16le", "-"], {
      print: (value): void => { emptyLines.push(value as JsonRecord); },
      sessionId: "cli-empty",
      source: sourceOf([new Uint8Array([1, 2])]),
    }), 0);
    assert.equal(emptyLines.filter((line) => line.type === "chunk").length, 0);
    assert.equal(emptyLines.at(-1)?.state, "completed");
    assert.equal(emptyLines.at(-1)?.decoded, false);
    assert.equal(emptyLines.at(-1)?.empty, true);
  });

  await t.test("runtime failure exits 1 without retry", async (t2) => {
    const dir = await tempDir(t2);
    const lines: JsonRecord[] = [];
    assert.equal(await runReceive(["--decoder", join(dir, "missing"), "--pcm-s16le", "-"], {
      print: (value): void => { lines.push(value as JsonRecord); },
      sessionId: "cli-fail",
      source: sourceOf([new Uint8Array([1, 2])]),
    }), 1);
    const error = lines.find((line) => line.type === "error");
    assert.equal(error?.code, "decoder_missing");
    assert.equal(error?.cleanupConfirmed, true);
  });

  await t.test("confirmed cancel exits 0 and emits no late chunk", async (t2) => {
    const f = await fixture(t2, "cli-cancel", `
process.stdin.resume();
process.stdout.write("FIRST");
setTimeout(() => { try { process.stdout.write("LATE"); } catch {} }, 150);
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`);
    const controller = new AbortController();
    const lines: JsonRecord[] = [];
    const code = await runReceive(["--decoder", f.file, "--pcm-s16le", "-"], {
      print: (value): void => {
        const record = value as JsonRecord;
        lines.push(record);
        if (record.type === "chunk") controller.abort();
      },
      sessionId: "cli-cancel",
      signal: controller.signal,
      source: {
        async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
          yield new Uint8Array([1, 2]);
          await new Promise(() => undefined);
        },
      },
    });
    assert.equal(code, 0);
    assert.deepEqual(lines.filter((line) => line.type === "chunk").map((line) => line.text), ["FIRST"]);
    assert.equal(lines.at(-1)?.state, "stopped");
    await delay(200);
    assert.deepEqual(lines.filter((line) => line.type === "chunk").map((line) => line.text), ["FIRST"]);
  });
});
