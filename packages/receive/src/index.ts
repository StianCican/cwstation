// packages/receive 公共出口：当前后台收报能力（multimon-ng 子进程）。
//
// GUI/CLI 复用同一会话函数，直接接收文本回调，不解析 CLI stdout。
// 旧的 fldigi 客户端实现保留在 ./fldigi.ts 作为冻结历史，不再从公共出口导出。

export {
  MULTIMON_RECEIVE_DEFAULT_MAX_STDOUT_BYTES,
  MULTIMON_RECEIVE_DEFAULT_TIMEOUT_MS,
  MULTIMON_RECEIVE_MAX_STDERR_RETAINED_BYTES,
  MULTIMON_RECEIVE_MAX_TIMEOUT_MS,
  MULTIMON_RECEIVE_SAMPLE_RATE_HZ,
  MULTIMON_RECEIVE_SILENCE_BYTES,
  MULTIMON_RECEIVE_SILENCE_MS,
  MultimonReceiveError,
  runMultimonReceive,
} from "./multimon.js";

export type {
  MultimonReceiveErrorCode,
  MultimonReceiveOptions,
  MultimonReceiveResult,
  MultimonRxChunk,
  PcmByteSource,
} from "./multimon.js";

export {
  AUDIO_RECEIVE_CHANNELS,
  AUDIO_RECEIVE_MAX_STDERR_RETAINED_BYTES,
  AUDIO_RECEIVE_SAMPLE_FORMAT,
  AUDIO_RECEIVE_SAMPLE_RATE_HZ,
  AUDIO_RECEIVE_TERMINATION_GRACE_MS,
  AudioReceiveError,
  audioBackendMatchesPlatform,
  buildFfmpegCaptureArgs,
  runAudioReceive,
} from "./audio.js";

export type {
  AudioBackend,
  AudioReceiveErrorCode,
  AudioReceiveErrorDetails,
  AudioReceiveOptions,
  AudioReceiveResult,
} from "./audio.js";
