// P2-015 受控 CW 试验的离线模拟 transport（纯内存，不打开串口、不发射）。
//
// 独立于只读 simulator：它理解八条固定预检查询，并对 Command 17 的报文/停止
// 回复 FB 或 FA（或按配置不回复）。它只是演示/测试入口，不是权限隔离，也
// 不能证明真实电台行为。

import {
  CIV_COMMAND_NG,
  CIV_COMMAND_OK,
  CIV_COMMAND_READ_FREQUENCY,
  CIV_COMMAND_READ_MODE,
  CIV_DEFAULT_CONTROLLER_ADDRESS,
  CIV_DEFAULT_RADIO_ADDRESS,
  CIV_EOM,
  CIV_PREAMBLE,
  CivFrameParser,
  CivTransportError,
  civModeToCode,
  encodeFrequencyBcd,
  type CivFilter,
  type CivMode,
  type CivTransport,
} from "../../devices/src/index.js";
import type { BreakInMode } from "../../devices/src/civ-context-read.js";

export interface CwTrialSimulatorOptions {
  /** 显示/TX 频率，默认 14_030_000 Hz。 */
  readonly frequencyHz?: number;
  /** TX 频率；默认与显示频率一致。 */
  readonly txFrequencyHz?: number;
  readonly mode?: CivMode;
  readonly filter?: CivFilter;
  readonly txStatus?: "RX" | "TX";
  readonly splitEnabled?: boolean;
  readonly ritEnabled?: boolean;
  readonly xitEnabled?: boolean;
  readonly breakIn?: BreakInMode;
  /** Command 17 的应答；默认 ok。 */
  readonly ack?: "ok" | "ng" | "none";
  /** 是否回显请求，默认 true。 */
  readonly echo?: boolean;
  /** 每次 onData 的字节数，默认 1（逐字节拆包）。 */
  readonly chunkSize?: number;
  /** 回复延迟，默认 0ms。 */
  readonly latencyMs?: number;
}

export interface CwTrialSimulatorTransport extends CivTransport {
  readonly requests: readonly Uint8Array[];
  readonly closed: boolean;
}

function frameBytes(to: number, from: number, command: number, data: readonly number[]): number[] {
  return [CIV_PREAMBLE, CIV_PREAMBLE, to, from, command, ...data, CIV_EOM];
}

/**
 * 创建受控 CW 试验的离线模拟 transport。默认上下文满足预检（CW、RX、
 * TX=显示频率、Split/RIT/XIT 关闭、Break-in FULL）。
 */
export function createCwTrialSimulatorTransport(
  options: CwTrialSimulatorOptions = {},
): CwTrialSimulatorTransport {
  const frequencyHz = options.frequencyHz ?? 14_030_000;
  const txFrequencyHz = options.txFrequencyHz ?? frequencyHz;
  const mode = options.mode ?? "CW";
  const filter = options.filter ?? 2;
  const txStatus = options.txStatus ?? "RX";
  const splitEnabled = options.splitEnabled ?? false;
  const ritEnabled = options.ritEnabled ?? false;
  const xitEnabled = options.xitEnabled ?? false;
  const breakIn = options.breakIn ?? "FULL";
  const ack = options.ack ?? "ok";
  const echo = options.echo ?? true;
  const chunkSize = options.chunkSize ?? 1;
  const latencyMs = options.latencyMs ?? 0;
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 1024) {
    throw new CivTransportError(`chunkSize must be an integer in [1, 1024], got ${chunkSize}`);
  }
  if (!Number.isInteger(latencyMs) || latencyMs < 0 || latencyMs > 60_000) {
    throw new CivTransportError(`latencyMs must be an integer in [0, 60000], got ${latencyMs}`);
  }
  // 提前校验编码，构造失败早于任何查询。
  const frequencyData = encodeFrequencyBcd(frequencyHz);
  const txFrequencyData = encodeFrequencyBcd(txFrequencyHz);
  const modeData = [civModeToCode(mode), filter];
  const breakInCode = breakIn === "OFF" ? 0x00 : breakIn === "SEMI" ? 0x01 : 0x02;

  const dataListeners = new Set<(chunk: Uint8Array) => void>();
  const closeListeners = new Set<(error?: Error) => void>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const requests: Uint8Array[] = [];
  const parser = new CivFrameParser();
  let closed = false;

  function emitSequentially(bytes: readonly number[]): void {
    let offset = latencyMs;
    for (let index = 0; index < bytes.length; index += chunkSize) {
      const chunk = bytes.slice(index, index + chunkSize);
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (closed) return;
        const data = Uint8Array.from(chunk);
        for (const listener of [...dataListeners]) listener(data);
      }, offset);
      timers.add(timer);
      offset += 1;
    }
  }

  function replyFor(command: number, data: readonly number[]): number[] | null {
    switch (command) {
      case CIV_COMMAND_READ_FREQUENCY:
        return frameBytes(CIV_DEFAULT_CONTROLLER_ADDRESS, CIV_DEFAULT_RADIO_ADDRESS, command, frequencyData);
      case CIV_COMMAND_READ_MODE:
        return frameBytes(CIV_DEFAULT_CONTROLLER_ADDRESS, CIV_DEFAULT_RADIO_ADDRESS, command, modeData);
      case 0x1c:
        if (data[0] === 0x03) {
          return frameBytes(CIV_DEFAULT_CONTROLLER_ADDRESS, CIV_DEFAULT_RADIO_ADDRESS, command, [
            0x03,
            ...txFrequencyData,
          ]);
        }
        if (data[0] === 0x00) {
          return frameBytes(CIV_DEFAULT_CONTROLLER_ADDRESS, CIV_DEFAULT_RADIO_ADDRESS, command, [
            0x00,
            txStatus === "TX" ? 0x01 : 0x00,
          ]);
        }
        return null;
      case 0x0f:
        return frameBytes(CIV_DEFAULT_CONTROLLER_ADDRESS, CIV_DEFAULT_RADIO_ADDRESS, command, [
          splitEnabled ? 0x01 : 0x00,
        ]);
      case 0x21:
        if (data[0] === 0x01) {
          return frameBytes(CIV_DEFAULT_CONTROLLER_ADDRESS, CIV_DEFAULT_RADIO_ADDRESS, command, [
            0x01,
            ritEnabled ? 0x01 : 0x00,
          ]);
        }
        if (data[0] === 0x02) {
          return frameBytes(CIV_DEFAULT_CONTROLLER_ADDRESS, CIV_DEFAULT_RADIO_ADDRESS, command, [
            0x02,
            xitEnabled ? 0x01 : 0x00,
          ]);
        }
        return null;
      case 0x16:
        if (data[0] === 0x47) {
          return frameBytes(CIV_DEFAULT_CONTROLLER_ADDRESS, CIV_DEFAULT_RADIO_ADDRESS, command, [
            0x47,
            breakInCode,
          ]);
        }
        return null;
      case 0x17:
        if (ack === "none") return null;
        return frameBytes(
          CIV_DEFAULT_CONTROLLER_ADDRESS,
          CIV_DEFAULT_RADIO_ADDRESS,
          ack === "ng" ? CIV_COMMAND_NG : CIV_COMMAND_OK,
          [],
        );
      default:
        return null;
    }
  }

  function respondTo(data: Uint8Array): void {
    const replies: number[][] = [];
    for (const frame of parser.push(data)) {
      if (frame.to !== CIV_DEFAULT_RADIO_ADDRESS || frame.from !== CIV_DEFAULT_CONTROLLER_ADDRESS) continue;
      const reply = replyFor(frame.command, frame.data);
      if (reply !== null) replies.push(reply);
    }
    if (replies.length === 0) return;
    const stream = echo ? [...data, ...replies.flat()] : replies.flat();
    emitSequentially(stream);
  }

  return {
    requests,
    get closed() {
      return closed;
    },
    write(data: Uint8Array): Promise<void> {
      if (closed) return Promise.reject(new CivTransportError("CW trial simulator is closed"));
      const copy = Uint8Array.from(data);
      requests.push(copy);
      respondTo(copy);
      return Promise.resolve();
    },
    onData(listener: (chunk: Uint8Array) => void): () => void {
      dataListeners.add(listener);
      return () => {
        dataListeners.delete(listener);
      };
    },
    onClose(listener: (error?: Error) => void): () => void {
      closeListeners.add(listener);
      return () => {
        closeListeners.delete(listener);
      };
    },
    close(): void {
      if (closed) return;
      closed = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const listener of [...closeListeners]) listener();
    },
  };
}
