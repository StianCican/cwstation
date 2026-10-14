// packages/devices 公共出口：只读 CI-V 窄接口与离线模拟 transport。
//
// 刻意不导出 buildReadRequest 或任何通用 CI-V 命令构造器；包外只能通过
// CivReadOnlyClient 的 readFrequency/readMode 发起 03/04 读取。

export {
  CIV_PREAMBLE,
  CIV_EOM,
  CIV_DEFAULT_RADIO_ADDRESS,
  CIV_DEFAULT_CONTROLLER_ADDRESS,
  CIV_MAX_ENCODED_FREQUENCY_HZ,
  CIV_COMMAND_READ_FREQUENCY,
  CIV_COMMAND_READ_MODE,
  CIV_COMMAND_NG,
  CIV_COMMAND_OK,
  CivError,
  CivConfigError,
  CivBusyError,
  CivSessionError,
  CivTimeoutError,
  CivProtocolError,
  CivTransportError,
  CivFrameParser,
  encodeFrequencyBcd,
  decodeFrequencyBcd,
  civModeFromCode,
  civModeToCode,
  decodeModeReading,
  CivReadOnlyClient,
} from "./civ.js";

export type {
  CivMode,
  CivFilter,
  CivFrame,
  CivFrameParserOptions,
  CivTransport,
  CivReadOnlyClientOptions,
  CivModeReading,
  CivClientState,
} from "./civ.js";

export { createSimulatedCivTransport } from "./simulator.js";
export type { SimulatedCivTransport, SimulatedCivTransportOptions } from "./simulator.js";

export { openSerialCivTransport, SERIAL_ALLOWED_BAUD_RATES, SERIAL_DEFAULT_BAUD_RATE } from "./serial.js";
export type { SerialCivTransport, OpenSerialCivTransportOptions } from "./serial.js";

// Dry-run only: builds IC-7300 CW frames but has no transport and cannot write.
export {
  CIV_COMMAND_SEND_CW,
  CIV_CW_STOP_BYTE,
  CIV_CW_MAX_MESSAGE_BYTES,
  CivTxPlanError,
  planCivCwMessage,
  planCivCwStop,
  civPlanHex,
} from "./civ-tx-plan.js";
export type { CivCwPlan, CivCwPlanOptions } from "./civ-tx-plan.js";
