// Codex 独立审查用例；真实 Julia 生成的低 SNR 文件保存在证据目录。
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./helpers.js";
import { CwContractError } from "../packages/signal/src/contracts.js";
import { verifyTaskResult } from "../packages/signal/src/verify.js";
import { parsePcm16MonoWav } from "../packages/signal/src/wav.js";
import { sha256Hex } from "../packages/signal/src/util.js";
import { buildEnvelope } from "../packages/signal/src/timeline.js";

const taskPath = join(ROOT, "docs/evidence/P0-004-low-snr.task.json");
const bundleDir = join(ROOT, "docs/evidence/P0-004-low-snr-output");

test("Codex: ramp sample rounding matches Julia ties-to-even at 8500 Hz", () => {
  const envelope = buildEnvelope([{ startSample: 0, endSample: 510 }], 510, 5, 8500);
  assert.equal(envelope[42], 1, "5ms at 8500Hz is 42.5 samples; Julia uses 42");
  assert.equal(envelope[41], 0.5 * (1 - Math.cos(Math.PI * 41 / 42)));
});

test("Codex: actual Julia -20 dB signal passes verification despite low clean amplitude", () => {
  const result = verifyTaskResult(taskPath, join(bundleDir, "result.json"));
  assert.equal(result.sampleCount, 26_400);
  assert.ok(Math.abs((result.measuredSnrDb ?? 0) + 20) < 0.2);
});

test("Codex: actual Julia short 60 dB signal allows finite-sample noise variation", () => {
  const result = verifyTaskResult(
    join(ROOT, "docs/evidence/P0-004-short.task.json"),
    join(ROOT, "docs/evidence/P0-004-short-output/result.json"),
  );
  assert.equal(result.sampleCount, 160);
  assert.ok(Math.abs((result.measuredSnrDb ?? 0) - 60) < 1);
});

test("Codex: required gain and peak metadata cannot be malformed", () => {
  const dir = mkdtempSync(join(tmpdir(), "cw-review-"));
  try {
    cpSync(bundleDir, dir, { recursive: true });
    const resultPath = join(dir, "result.json");
    const original = JSON.parse(readFileSync(resultPath, "utf8")) as Record<string, unknown>;
    for (const field of ["normalizationGain", "peakClean", "peakNoisy"]) {
      writeFileSync(resultPath, JSON.stringify({ ...original, [field]: "invalid" }));
      assert.throws(() => verifyTaskResult(taskPath, resultPath), (error: unknown) => {
        assert.ok(error instanceof CwContractError);
        assert.equal(error.code, "metadata_mismatch", `invalid ${field} must be rejected as metadata`);
        return true;
      });
    }
    for (const field of ["peakClean", "peakNoisy"]) {
      writeFileSync(resultPath, JSON.stringify({ ...original, [field]: 0.01 }));
      assert.throws(() => verifyTaskResult(taskPath, resultPath), CwContractError);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex: PCM parser rejects duplicate chunks and incomplete trailing data", () => {
  const original = readFileSync(join(bundleDir, "clean.wav"));
  const fmtChunk = original.subarray(12, 36);
  assert.equal(fmtChunk.toString("ascii", 0, 4), "fmt ");
  const parsed = parsePcm16MonoWav(original);
  const dataChunk = original.subarray(parsed.dataOffset - 8, parsed.dataOffset + parsed.dataBytes);
  const missingPad = Buffer.from([0x4a, 0x55, 0x4e, 0x4b, 1, 0, 0, 0, 0]);
  const candidates = [
    Buffer.concat([original.subarray(0, 36), fmtChunk, original.subarray(36)]),
    Buffer.concat([original, dataChunk]),
    Buffer.concat([original, Buffer.from([1, 2])]),
    Buffer.concat([original, missingPad]),
  ];
  for (const wav of candidates) {
    wav.writeUInt32LE(wav.length - 8, 4);
    assert.throws(() => parsePcm16MonoWav(wav), CwContractError);
  }
});

test("Codex: PCM parser rejects incorrect RIFF size, byte rate and block alignment", () => {
  const original = readFileSync(join(bundleDir, "clean.wav"));
  let fmtOffset = -1;
  for (let offset = 12; offset + 8 <= original.length;) {
    const size = original.readUInt32LE(offset + 4);
    if (original.toString("ascii", offset, offset + 4) === "fmt ") {
      fmtOffset = offset + 8;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  assert.ok(fmtOffset >= 0);
  const wrongSize = Buffer.from(original);
  wrongSize.writeUInt32LE(0, 4);
  const wrongRate = Buffer.from(original);
  wrongRate.writeUInt32LE(1, fmtOffset + 8);
  const wrongAlignment = Buffer.from(original);
  wrongAlignment.writeUInt16LE(1, fmtOffset + 12);
  for (const malformed of [wrongSize, wrongRate, wrongAlignment]) {
    assert.throws(() => parsePcm16MonoWav(malformed), CwContractError);
  }
});

test("Codex: clean carrier must match the pinned synthesis algorithm even with updated hashes", () => {
  const dir = mkdtempSync(join(tmpdir(), "cw-carrier-review-"));
  try {
    cpSync(bundleDir, dir, { recursive: true });
    const resultPath = join(dir, "result.json");
    const result = JSON.parse(readFileSync(resultPath, "utf8"));
    for (const key of ["cleanWav", "noisyWav"]) {
      const artifact = result.artifacts[key];
      const artifactPath = join(dir, artifact.path);
      const wav = readFileSync(artifactPath);
      const parsed = parsePcm16MonoWav(wav);
      for (let i = 0; i < parsed.sampleCount; i += 1) {
        wav.writeInt16LE(-parsed.samples[i]!, parsed.dataOffset + i * 2);
      }
      writeFileSync(artifactPath, wav);
      artifact.sha256 = sha256Hex(wav);
    }
    writeFileSync(resultPath, JSON.stringify(result));
    assert.throws(() => verifyTaskResult(taskPath, resultPath), CwContractError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
