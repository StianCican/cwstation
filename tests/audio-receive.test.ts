// V00-02-D：实时音频输入专项。
// 使用项目临时目录中的真实 Node 短生命周期子进程分别扮演 FFmpeg 与 multimon-ng；
// 不调用真实 FFmpeg/声卡/电台，不写外部目录，也不访问网络或凭据。

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUDIO_RECEIVE_CHANNELS,
  AUDIO_RECEIVE_SAMPLE_FORMAT,
  AUDIO_RECEIVE_SAMPLE_RATE_HZ,
  AudioReceiveError,
  audioBackendMatchesPlatform,
  buildFfmpegCaptureArgs,
  runAudioReceive,
  type AudioBackend,
  type MultimonRxChunk,
} from "../packages/receive/src/index.js";
import { parseReceiveArgs, runReceive } from "../apps/rig-receive.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const NOW = (): Date => new Date("2026-10-21T01:02:03.000Z");
const WINDOWS_SKIP = process.platform === "win32"
  ? "POSIX executable fixtures are not verified on Windows; real Windows support is unclaimed"
  : false;

type JsonRecord = Record<string, unknown>;

interface Fixture {
  readonly file: string;
  readonly argvLog: string;
  readonly dir: string;
}

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(ROOT, "tests", ".tmp-audio-"));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  return dir;
}

async function nodeFixture(t: TestContext, name: string, body: string, dir?: string): Promise<Fixture> {
  const base = dir ?? (await tempDir(t));
  const file = join(base, `${name}.mjs`);
  const argvLog = join(base, `${name}.argv.json`);
  const source = `#!/usr/bin/env node
import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));
${body}
`;
  await writeFile(file, source, "utf8");
  await chmod(file, 0o755);
  return { file, argvLog, dir: base };
}

function isAudioError(code: string): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(error instanceof AudioReceiveError);
    assert.equal(error.code, code);
    return true;
  };
}

async function rejection(promise: Promise<unknown>): Promise<AudioReceiveError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AudioReceiveError) return error;
    throw error;
  }
  assert.fail("expected the audio receive session to fail");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("FFmpeg arguments are fixed per backend and platform", () => {
  assert.deepEqual(buildFfmpegCaptureArgs("pulse", "RDPSource"), [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    "-f", "pulse", "-i", "RDPSource",
    "-vn", "-ac", "1", "-ar", "22050", "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1",
  ]);
  assert.deepEqual(buildFfmpegCaptureArgs("dshow", "Test Mic"), [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    "-f", "dshow", "-i", "audio=Test Mic",
    "-vn", "-ac", "1", "-ar", "22050", "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1",
  ]);
  assert.equal(audioBackendMatchesPlatform("pulse", "linux"), true);
  assert.equal(audioBackendMatchesPlatform("dshow", "win32"), true);
  assert.equal(audioBackendMatchesPlatform("pulse", "win32"), false);
  assert.equal(audioBackendMatchesPlatform("dshow", "linux"), false);
  assert.throws(() => buildFfmpegCaptureArgs("alsa" as AudioBackend, "x"), isAudioError("invalid_options"));
  assert.throws(() => buildFfmpegCaptureArgs("pulse", " padded "), isAudioError("invalid_options"));
});

test("live PCM streams to the same decoder, reports metadata, and confirms both cleanups", { skip: WINDOWS_SKIP }, async (t) => {
  const ffSignal = join(await tempDir(t), "ffmpeg-term.log");
  const decSignal = join(await tempDir(t), "decoder-term.log");
  const ff = await nodeFixture(t, "ffmpeg", `
process.stderr.write("s".repeat(100000));
process.stdout.write(Buffer.alloc(22052, 1));
process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(ffSignal)}, "SIGTERM"); process.exit(0); });
setInterval(() => {}, 1000);
`);
  const dec = await nodeFixture(t, "decoder", `
let total = 0;
process.stdin.on("data", (chunk) => {
  total += chunk.length;
  if (total >= 22052) process.stdout.write("CQ TEST\\n");
});
process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(decSignal)}, "SIGTERM"); process.exit(0); });
setInterval(() => {}, 1000);
`);

  const controller = new AbortController();
  const chunks: MultimonRxChunk[] = [];
  const error = await rejection(runAudioReceive({
    decoder: dec.file,
    ffmpeg: ff.file,
    backend: "pulse",
    device: "RDPSource",
    sessionId: "audio-stream",
    timeoutMs: 5_000,
    platform: "linux",
    now: NOW,
    signal: controller.signal,
    onChunk: (chunk): void => {
      chunks.push(chunk);
      controller.abort();
    },
  }));

  assert.equal(error.code, "aborted");
  assert.equal(error.cleanupConfirmed, true);
  assert.equal(error.pcmBytes, 22052);
  assert.equal(error.captureStderrRetainedBytes, 64 * 1024);
  assert.equal(error.message.includes("s".repeat(100)), false);
  assert.deepEqual(chunks.map((chunk) => chunk.text), ["CQ TEST"]);
  assert.equal(chunks[0]?.source, "multimon-ng");
  assert.equal(chunks[0]?.readOnly, true);
  assert.equal(chunks[0]?.sessionId, "audio-stream");
  assert.equal(chunks[0]?.receivedAt, "2026-10-21T01:02:03.000Z");
  assert.deepEqual(JSON.parse(await readFile(ff.argvLog, "utf8")), buildFfmpegCaptureArgs("pulse", "RDPSource"));
  assert.deepEqual(JSON.parse(await readFile(dec.argvLog, "utf8")), [
    "-q", "-c", "-a", "MORSE_CW", "-t", "raw", "-",
  ]);
  assert.equal(await readFile(ffSignal, "utf8"), "SIGTERM");
  assert.equal(await readFile(decSignal, "utf8"), "SIGTERM");
  assert.equal(AUDIO_RECEIVE_SAMPLE_RATE_HZ, 22_050);
  assert.equal(AUDIO_RECEIVE_CHANNELS, 1);
  assert.equal(AUDIO_RECEIVE_SAMPLE_FORMAT, "s16le");
});

test("dshow is a valid parser mode and its argv is exercised with injected platform", { skip: WINDOWS_SKIP }, async (t) => {
  const parsed = parseReceiveArgs([
    "--decoder", "/decoder", "--ffmpeg", "/ffmpeg", "--audio-backend", "dshow", "--audio-device", "Test Mic",
  ]);
  assert.equal(parsed.mode, "audio");
  assert.equal(parsed.mode === "audio" ? parsed.audioBackend : "", "dshow");

  const ffSignal = join(await tempDir(t), "dshow-term.log");
  const ff = await nodeFixture(t, "dshow", `
process.stdout.write(Buffer.alloc(4, 1));
process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(ffSignal)}, "SIGTERM"); process.exit(0); });
setInterval(() => {}, 1000);
`);
  const dec = await nodeFixture(t, "decoder", `
process.stdin.once("data", () => process.stdout.write("OK\\n"));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`);
  const controller = new AbortController();
  const error = await rejection(runAudioReceive({
    decoder: dec.file,
    ffmpeg: ff.file,
    backend: "dshow",
    device: "Test Mic",
    sessionId: "audio-dshow",
    timeoutMs: 5_000,
    platform: "win32",
    signal: controller.signal,
    onChunk: (): void => controller.abort(),
  }));
  assert.equal(error.code, "aborted");
  assert.equal(error.cleanupConfirmed, true);
  assert.deepEqual(JSON.parse(await readFile(ff.argvLog, "utf8")), buildFfmpegCaptureArgs("dshow", "Test Mic"));
  assert.deepEqual(JSON.parse(await readFile(ff.argvLog, "utf8")).slice(6, 8), ["-i", "audio=Test Mic"]);
  assert.equal(await readFile(ffSignal, "utf8"), "SIGTERM");

  const mismatch = await rejection(runAudioReceive({
    decoder: dec.file,
    ffmpeg: ff.file,
    backend: "dshow",
    device: "Test Mic",
    sessionId: "audio-mismatch",
    platform: "linux",
    onChunk: (): void => undefined,
  }));
  assert.equal(mismatch.code, "invalid_options");
  assert.equal(mismatch.cleanupConfirmed, true);
});

test("CLI rejects mixed, incomplete, duplicate and invalid audio arguments before spawning", async (t) => {
  const ff = await nodeFixture(t, "never-spawn", "setInterval(() => {}, 1000);");
  const cases: readonly (readonly string[])[] = [
    ["--decoder", "/decoder", "--pcm-s16le", "-", "--ffmpeg", ff.file, "--audio-backend", "pulse", "--audio-device", "x"],
    ["--decoder", "/decoder", "--ffmpeg", ff.file, "--audio-backend", "pulse"],
    ["--decoder", "/decoder", "--ffmpeg", ff.file, "--audio-backend", "alsa", "--audio-device", "x"],
    ["--decoder", "/decoder", "--ffmpeg", ff.file, "--ffmpeg", ff.file, "--audio-backend", "pulse", "--audio-device", "x"],
    ["--decoder", "/decoder"],
    [],
  ];
  for (const argv of cases) {
    const lines: JsonRecord[] = [];
    assert.equal(await runReceive(argv, { print: (value): void => { lines.push(value as JsonRecord); } }), 2);
    assert.equal(lines[0]?.code, "usage");
    assert.match(String(lines[0]?.usage), /--pcm-s16le/);
    assert.match(String(lines[0]?.usage), /--ffmpeg/);
  }
  await assert.rejects(access(ff.argvLog), "invalid CLI arguments must not spawn FFmpeg");
});

test("a missing FFmpeg is capture_missing and does not start the decoder", { skip: WINDOWS_SKIP }, async (t) => {
  const dec = await nodeFixture(t, "decoder", "setInterval(() => {}, 1000);");
  const dir = await tempDir(t);
  const error = await rejection(runAudioReceive({
    decoder: dec.file,
    ffmpeg: join(dir, "missing-ffmpeg"),
    backend: "pulse",
    device: "RDPSource",
    sessionId: "audio-missing-ffmpeg",
    timeoutMs: 5_000,
    platform: "linux",
    onChunk: (): void => undefined,
  }));
  assert.equal(error.code, "capture_missing");
  assert.equal(error.cleanupConfirmed, true);
  await assert.rejects(access(dec.argvLog), "the decoder must not start when FFmpeg is missing");
});

test("a pre-aborted audio session spawns neither process", { skip: WINDOWS_SKIP }, async (t) => {
  const ff = await nodeFixture(t, "ffmpeg", "setInterval(() => {}, 1000);");
  const dec = await nodeFixture(t, "decoder", "setInterval(() => {}, 1000);");
  const controller = new AbortController();
  controller.abort();
  const error = await rejection(runAudioReceive({
    decoder: dec.file,
    ffmpeg: ff.file,
    backend: "pulse",
    device: "RDPSource",
    sessionId: "audio-preabort",
    platform: "linux",
    signal: controller.signal,
    onChunk: (): void => undefined,
  }));
  assert.equal(error.code, "aborted");
  assert.equal(error.cleanupConfirmed, true);
  await assert.rejects(access(ff.argvLog));
  await assert.rejects(access(dec.argvLog));
});

test("natural capture exit, including 0, fails and cancels the decoder", { skip: WINDOWS_SKIP }, async (t) => {
  for (const [name, exitCode] of [["zero", 0], ["nonzero", 2]] as const) {
    await t.test(`capture exits with ${exitCode}`, async (t2) => {
      const dir = await tempDir(t2);
      const decSignal = join(dir, "decoder-term.log");
      const ff = await nodeFixture(t2, `ffmpeg-${name}`, `
process.stdout.write(Buffer.alloc(2, 1));
setTimeout(() => process.exit(${exitCode}), 150);
`, dir);
      const dec = await nodeFixture(t2, "decoder", `
process.stdin.resume();
process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(decSignal)}, "SIGTERM"); process.exit(0); });
setInterval(() => {}, 1000);
`, dir);
      const error = await rejection(runAudioReceive({
        decoder: dec.file,
        ffmpeg: ff.file,
        backend: "pulse",
        device: "RDPSource",
        sessionId: `audio-capture-exit-${name}`,
        timeoutMs: 5_000,
        platform: "linux",
        onChunk: (): void => undefined,
      }));
      assert.equal(error.code, "capture_failed");
      assert.equal(error.cleanupConfirmed, true);
      assert.equal(await readFile(decSignal, "utf8"), "SIGTERM");
    });
  }
});

test("decoder failure cancels the live capture and is not reported as abort", { skip: WINDOWS_SKIP }, async (t) => {
  const dir = await tempDir(t);
  const ffSignal = join(dir, "ffmpeg-term.log");
  const ff = await nodeFixture(t, "ffmpeg", `
process.stdout.write(Buffer.alloc(2, 1));
process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(ffSignal)}, "SIGTERM"); process.exit(0); });
setInterval(() => {}, 1000);
`, dir);
  const dec = await nodeFixture(t, "decoder", "process.exit(4);", dir);
  const error = await rejection(runAudioReceive({
    decoder: dec.file,
    ffmpeg: ff.file,
    backend: "pulse",
    device: "RDPSource",
    sessionId: "audio-decoder-fail",
    timeoutMs: 5_000,
    platform: "linux",
    onChunk: (): void => undefined,
  }));
  assert.equal(error.code, "premature_exit");
  assert.equal(error.decoderErrorCode, "premature_exit");
  assert.equal(error.cleanupConfirmed, true);
  assert.equal(await readFile(ffSignal, "utf8"), "SIGTERM");
});

test("timeout covers capture start and escalates both stubborn children within bounds", { skip: WINDOWS_SKIP }, async (t) => {
  const dir = await tempDir(t);
  const ffSignal = join(dir, "ffmpeg-term.log");
  const decSignal = join(dir, "decoder-term.log");
  const ff = await nodeFixture(t, "stubborn-ffmpeg", `
process.on("SIGTERM", () => { fs.appendFileSync(${JSON.stringify(ffSignal)}, "SIGTERM\\n"); });
setInterval(() => {}, 1000);
`, dir);
  const dec = await nodeFixture(t, "stubborn-decoder", `
process.on("SIGTERM", () => { fs.appendFileSync(${JSON.stringify(decSignal)}, "SIGTERM\\n"); });
setInterval(() => {}, 1000);
`, dir);
  const started = Date.now();
  const error = await rejection(runAudioReceive({
    decoder: dec.file,
    ffmpeg: ff.file,
    backend: "pulse",
    device: "RDPSource",
    sessionId: "audio-timeout",
    timeoutMs: 150,
    platform: "linux",
    onChunk: (): void => undefined,
  }));
  assert.equal(error.code, "timeout");
  assert.equal(error.cleanupConfirmed, true);
  assert.ok(Date.now() - started >= 400, "the 500 ms SIGTERM grace must elapse before SIGKILL");
  assert.ok(Date.now() - started < 5_000, "cleanup must stay bounded");
  assert.equal(await readFile(ffSignal, "utf8"), "SIGTERM\n");
  assert.equal(await readFile(decSignal, "utf8"), "SIGTERM\n");
});

test("a never-settling callback is bounded by the shared timeout", { skip: WINDOWS_SKIP }, async (t) => {
  const dir = await tempDir(t);
  const ffSignal = join(dir, "ffmpeg-term.log");
  const ff = await nodeFixture(t, "ffmpeg", `
process.stdout.write(Buffer.alloc(2, 1));
process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(ffSignal)}, "SIGTERM"); process.exit(0); });
setInterval(() => {}, 1000);
`, dir);
  const dec = await nodeFixture(t, "decoder", `
process.stdin.once("data", () => process.stdout.write("X\\n"));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`, dir);
  const started = Date.now();
  const error = await rejection(runAudioReceive({
    decoder: dec.file,
    ffmpeg: ff.file,
    backend: "pulse",
    device: "RDPSource",
    sessionId: "audio-hung-callback",
    timeoutMs: 150,
    platform: "linux",
    onChunk: (): Promise<void> => new Promise(() => undefined),
  }));
  assert.equal(error.code, "timeout");
  assert.equal(error.cleanupConfirmed, true);
  assert.ok(Date.now() - started < 3_000, "a hung callback must not extend the shared timeout");
  assert.equal(await readFile(ffSignal, "utf8"), "SIGTERM");
});

test("slow decoder applies backpressure instead of buffering unbounded audio", { skip: WINDOWS_SKIP }, async (t) => {
  const dir = await tempDir(t);
  const ffSignal = join(dir, "ffmpeg-term.log");
  const ff = await nodeFixture(t, "fast-ffmpeg", `
process.stdout.on("error", () => undefined);
const block = Buffer.alloc(65536, 1);
for (let index = 0; index < 64; index += 1) process.stdout.write(block);
process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(ffSignal)}, "SIGTERM"); process.exit(0); });
setInterval(() => {}, 1000);
`, dir);
  const dec = await nodeFixture(t, "slow-decoder", `
process.stdin.once("data", () => process.stdin.pause());
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`, dir);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 250);
  const error = await rejection(runAudioReceive({
    decoder: dec.file,
    ffmpeg: ff.file,
    backend: "pulse",
    device: "RDPSource",
    sessionId: "audio-backpressure",
    timeoutMs: 5_000,
    platform: "linux",
    signal: controller.signal,
    onChunk: (): void => undefined,
  }));
  assert.equal(error.code, "aborted");
  assert.equal(error.cleanupConfirmed, true);
  assert.ok(error.pcmBytes > 0, "some PCM must have been delivered");
  assert.ok(error.pcmBytes < 1024 * 1024, `delivered PCM should stay bounded, got ${error.pcmBytes}`);
  assert.equal(await readFile(ffSignal, "utf8"), "SIGTERM");
});

test("CLI reports audio metadata and exits 0 only for confirmed cancellation", { skip: WINDOWS_SKIP }, async (t) => {
  await t.test("confirmed cancel", async (t2) => {
    const dir = await tempDir(t2);
    const ffSignal = join(dir, "ffmpeg-term.log");
    const decSignal = join(dir, "decoder-term.log");
    const ff = await nodeFixture(t2, "ffmpeg", `
process.stdout.write(Buffer.alloc(2, 1));
process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(ffSignal)}, "SIGTERM"); process.exit(0); });
setInterval(() => {}, 1000);
`, dir);
    const dec = await nodeFixture(t2, "decoder", `
process.stdin.once("data", () => process.stdout.write("CQ TEST\\n"));
process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(decSignal)}, "SIGTERM"); process.exit(0); });
setInterval(() => {}, 1000);
`, dir);
    const controller = new AbortController();
    const lines: JsonRecord[] = [];
    const code = await runReceive([
      "--decoder", dec.file,
      "--ffmpeg", ff.file,
      "--audio-backend", "pulse",
      "--audio-device", "RDPSource",
      "--timeout-ms", "5000",
    ], {
      print: (value): void => {
        const record = value as JsonRecord;
        lines.push(record);
        if (record.type === "chunk") controller.abort();
      },
      sessionId: "cli-audio",
      now: NOW,
      signal: controller.signal,
    });
    assert.equal(code, 0);
    assert.deepEqual(lines.map((line) => line.state).filter(Boolean), ["started", "stopped"]);
    const chunk = lines.find((line) => line.type === "chunk");
    assert.equal(chunk?.text, "CQ TEST");
    const stopped = lines.at(-1)!;
    assert.equal(stopped.stoppedBy, "signal");
    assert.equal(stopped.pcmBytes, 2);
    assert.equal(stopped.audioBackend, "pulse");
    assert.equal(stopped.audioDevice, "RDPSource");
    assert.equal(stopped.audioSampleRateHz, 22050);
    assert.equal(stopped.audioChannels, 1);
    assert.equal(stopped.audioSampleFormat, "s16le");
    assert.equal(stopped.pcmS16le, undefined);
    assert.equal(await readFile(ffSignal, "utf8"), "SIGTERM");
    assert.equal(await readFile(decSignal, "utf8"), "SIGTERM");
  });

  await t.test("unconfirmed cleanup on cancellation is nonzero", async (t2) => {
    const lines: JsonRecord[] = [];
    const code = await runReceive([
      "--decoder", "/decoder",
      "--ffmpeg", "/ffmpeg",
      "--audio-backend", "pulse",
      "--audio-device", "RDPSource",
    ], {
      print: (value): void => { lines.push(value as JsonRecord); },
      runAudio: async (): Promise<never> => {
        throw new AudioReceiveError("aborted", "receive was aborted", { cleanupConfirmed: false, pcmBytes: 7 });
      },
    });
    assert.equal(code, 1);
    const error = lines.find((line) => line.type === "error");
    assert.equal(error?.code, "aborted");
    assert.equal(error?.cleanupConfirmed, false);
    assert.equal(error?.pcmBytes, 7);
  });
});
