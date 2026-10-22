import { parseReceiveArgs } from "../rig-receive.js";

/** Translate the existing closed GUI request into the shared receive CLI contract. */
export function buildGuiReceiveArgs(payload: unknown, paths: ReadonlyMap<string, string>): {
  argv: string[]; inputMode: "pcm" | "audio";
} {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid receive setup");
  const input = payload as Record<string, unknown>;
  if (Object.keys(input).some(key => !["ownCall", "peerCall", "inputMode", "audioBackend", "audioDevice"].includes(key))
      || typeof input.ownCall !== "string" || typeof input.peerCall !== "string") throw new Error("invalid receive setup");
  const inputMode = input.inputMode ?? "pcm";
  if (inputMode !== "pcm" && inputMode !== "audio") throw new Error("invalid receive input mode");
  const decoder = paths.get("decoder"), config = paths.get("reply-config");
  if (!decoder || !config) throw new Error("choose decoder and reply config first");
  const argv = ["--decoder", decoder, "--reply-config", config, "--own-call", input.ownCall, "--peer-call", input.peerCall];
  if (inputMode === "pcm") {
    if (input.audioBackend !== undefined || input.audioDevice !== undefined) throw new Error("PCM cannot include audio setup");
    const pcm = paths.get("pcm");
    if (!pcm) throw new Error("choose a PCM file first");
    argv.push("--pcm-s16le", pcm);
  } else {
    const ffmpeg = paths.get("ffmpeg");
    if (!ffmpeg || (input.audioBackend !== "pulse" && input.audioBackend !== "dshow")
        || typeof input.audioDevice !== "string" || !input.audioDevice.trim()) throw new Error("choose FFmpeg, audio backend and explicit input device");
    argv.push("--ffmpeg", ffmpeg, "--audio-backend", input.audioBackend, "--audio-device", input.audioDevice,
      "--timeout-ms", "3600000", "--reply-continuous");
  }
  parseReceiveArgs(argv);
  return { argv, inputMode };
}
