// 受限 WAV 解析：只接受 Julia 侧生成的单声道 16bit PCM。
// 解析 RIFF 分块（不假设固定 44 字节头），校验格式并解码样本。

import { CwContractError } from "./contracts.js";

export interface ParsedPcm16MonoWav {
  audioFormat: number;
  channels: number;
  sampleRateHz: number;
  bitsPerSample: number;
  dataOffset: number;
  dataBytes: number;
  sampleCount: number;
  durationSeconds: number;
  samples: Int16Array;
}

function fail(code: string, message: string): never {
  throw new CwContractError(code, message);
}

function readChunkId(bytes: Buffer, offset: number): string {
  return bytes.toString("latin1", offset, offset + 4);
}

/** 解析单声道 16bit PCM WAV；其他格式一律拒绝（首版限定格式）。 */
export function parsePcm16MonoWav(bytes: Buffer): ParsedPcm16MonoWav {
  if (bytes.length < 12) fail("invalid_wav", "WAV file is too short");
  if (readChunkId(bytes, 0) !== "RIFF") fail("invalid_wav", "missing RIFF header");
  if (readChunkId(bytes, 8) !== "WAVE") fail("invalid_wav", "missing WAVE form type");
  const riffSize = bytes.readUInt32LE(4);
  if (riffSize + 8 !== bytes.length) {
    fail("invalid_wav", `RIFF size ${riffSize} does not describe the file length ${bytes.length}`);
  }

  let audioFormat = 0;
  let channels = 0;
  let sampleRateHz = 0;
  let byteRate = 0;
  let blockAlign = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataBytes = -1;
  let sawFmt = false;

  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = readChunkId(bytes, offset);
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (body + size > bytes.length) fail("invalid_wav", `chunk ${id} overruns the file`);
    if (id === "fmt ") {
      if (sawFmt) fail("invalid_wav", "duplicate fmt chunk");
      if (size < 16) fail("invalid_wav", "fmt chunk is too small");
      audioFormat = bytes.readUInt16LE(body);
      channels = bytes.readUInt16LE(body + 2);
      sampleRateHz = bytes.readUInt32LE(body + 4);
      byteRate = bytes.readUInt32LE(body + 8);
      blockAlign = bytes.readUInt16LE(body + 12);
      bitsPerSample = bytes.readUInt16LE(body + 14);
      sawFmt = true;
    } else if (id === "data") {
      if (dataOffset >= 0) fail("invalid_wav", "duplicate data chunk");
      dataOffset = body;
      dataBytes = size;
    }
    const padded = size + (size % 2);
    if (body + padded > bytes.length) fail("invalid_wav", `missing padding for chunk ${id}`);
    if (padded < 0 || body + padded <= offset) fail("invalid_wav", "chunk size does not advance");
    offset = body + padded;
  }

  if (offset !== bytes.length) fail("invalid_wav", "trailing incomplete chunk");
  if (!sawFmt) fail("invalid_wav", "missing fmt chunk");
  if (dataOffset < 0 || dataBytes < 0) fail("invalid_wav", "missing data chunk");
  if (audioFormat !== 1) fail("unsupported_wav_format", `audioFormat ${audioFormat} is not PCM(1)`);
  if (channels !== 1) fail("unsupported_wav_format", `expected mono, got ${channels} channels`);
  if (bitsPerSample !== 16) fail("unsupported_wav_format", `expected 16-bit PCM, got ${bitsPerSample}-bit`);
  if (sampleRateHz <= 0) fail("invalid_wav", "invalid sample rate");
  const expectedBlockAlign = channels * (bitsPerSample / 8);
  if (blockAlign !== expectedBlockAlign) {
    fail("invalid_wav", `blockAlign ${blockAlign} does not match ${channels}ch x ${bitsPerSample}bit`);
  }
  if (byteRate !== sampleRateHz * blockAlign) {
    fail("invalid_wav", `byteRate ${byteRate} does not match sampleRate x blockAlign`);
  }
  if (dataBytes % 2 !== 0) fail("invalid_wav", "16-bit PCM data length is not a multiple of 2");

  const sampleCount = dataBytes / 2;
  const samples = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) {
    samples[i] = bytes.readInt16LE(dataOffset + i * 2);
  }

  return {
    audioFormat,
    channels,
    sampleRateHz,
    bitsPerSample,
    dataOffset,
    dataBytes,
    sampleCount,
    durationSeconds: sampleCount / sampleRateHz,
    samples,
  };
}
