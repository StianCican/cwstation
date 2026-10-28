// 临时生成 host 对照用 22050 Hz/mono/S16LE 的 CQ TEST。
// 只读取项目已构建的 packages/signal dist；不写 dist，也不进入 HAP/设备。
// 载波与包络公式来自项目既有实现：
//   packages/signal/src/timeline.ts: buildTimeline/buildEnvelope
//   packages/signal/src/verify.ts: sin(2*pi*tone*i/sr) * envelope
// 不复制任何 Morse 解码算法。

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const sampleRateHz = 22050;
const wpm = 20;
const toneHz = 600;
const rampMs = 5;
const peakCeiling = 0.95;
const tailSeconds = 0.5;

const outputDir = process.argv[2];
if (!outputDir) {
  console.error("usage: make_test_vector.mjs <output-directory>");
  process.exit(2);
}

let signal;
try {
  signal = await import(
    new URL("../../../../dist/packages/signal/src/index.js", import.meta.url).href
  );
} catch (error) {
  console.error(
    "make_test_vector.mjs: cannot read dist/packages/signal; build the project first",
  );
  console.error(String(error));
  process.exit(3);
}

const { encodeCwText, buildTimeline, buildEnvelope } = signal;
const words = encodeCwText("CQ TEST");
const timeline = buildTimeline(words, sampleRateHz, wpm);
const envelope = buildEnvelope(timeline.segments, timeline.sampleCount, rampMs, sampleRateHz);

const base = new Float64Array(timeline.sampleCount);
let peak = 0;
for (let i = 0; i < base.length; i += 1) {
  const value = Math.sin((2 * Math.PI * toneHz * i) / sampleRateHz) * envelope[i];
  base[i] = value;
  const magnitude = Math.abs(value);
  if (magnitude > peak) peak = magnitude;
}
const gain = peak > 0 ? peakCeiling / peak : 1;

const pcm = Buffer.alloc(base.length * 2);
for (let i = 0; i < base.length; i += 1) {
  const scaled = Math.round(base[i] * gain * 32767);
  pcm.writeInt16LE(Math.max(-32768, Math.min(32767, scaled)), i * 2);
}

const tailSamples = Math.round(sampleRateHz * tailSeconds);
const tail = Buffer.alloc(tailSamples * 2);
const withTail = Buffer.concat([pcm, tail]);

mkdirSync(outputDir, { recursive: true });
const noTailPath = join(outputDir, "cq-test.s16le");
const tailPath = join(outputDir, "cq-test-tail.s16le");
writeFileSync(noTailPath, pcm);
writeFileSync(tailPath, withTail);

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const metadata = {
  source: "packages/signal dist: encodeCwText/buildTimeline/buildEnvelope + verify.ts carrier formula",
  text: "CQ TEST",
  sampleRateHz,
  wpm,
  toneHz,
  rampMs,
  peakCeiling,
  tailSeconds,
  sampleCount: timeline.sampleCount,
  tailSamples,
  files: {
    "cq-test.s16le": { bytes: pcm.length, sha256: sha256(pcm) },
    "cq-test-tail.s16le": { bytes: withTail.length, sha256: sha256(withTail) },
  },
};
writeFileSync(join(outputDir, "vector-meta.json"), `${JSON.stringify(metadata, null, 2)}\n`);
console.log(JSON.stringify(metadata));
