// IC-7300 只读 CI-V 的离线模拟 transport。
//
// 用于在没有串口、没有电台的情况下验证 parser 与只读会话：
//  - 收到合法读请求后先回显请求字节，再回复数据；
//  - 回显与回复都按 chunkSize 拆包（默认逐字节），以覆盖拆包路径；
//  - 不打开任何设备、不发射；simulator 是测试/演示入口，不是权限隔离。

import {
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
} from "./civ.js";

export interface SimulatedCivTransportOptions {
  /** 模拟频率，默认 14_025_000 Hz。 */
  frequencyHz?: number;
  /** 模拟模式，默认 CW。 */
  mode?: CivMode;
  /** 模拟过滤器，默认 1（FIL1）。 */
  filter?: CivFilter;
  radioAddress?: number;
  controllerAddress?: number;
  /** 是否回显请求，默认 true。 */
  echo?: boolean;
  /** 每次 onData 的字节数，默认 1（逐字节拆包）。 */
  chunkSize?: number;
  /** 首个 chunk 的延迟，默认 0ms。 */
  latencyMs?: number;
}

export interface SimulatedCivTransport extends CivTransport {
  /** 已接收的请求字节副本，仅用于观测。 */
  readonly requests: readonly Uint8Array[];
  readonly closed: boolean;
}

function frameBytes(to: number, from: number, command: number, data: readonly number[]): number[] {
  return [CIV_PREAMBLE, CIV_PREAMBLE, to, from, command, ...data, CIV_EOM];
}

/**
 * 创建一个纯内存的模拟 CI-V transport。参数非法时抛出 CivConfigError
 * （由 encodeFrequencyBcd 与地址校验间接保证）。
 */
export function createSimulatedCivTransport(options: SimulatedCivTransportOptions = {}): SimulatedCivTransport {
  const frequencyHz = options.frequencyHz ?? 14_025_000;
  const mode = options.mode ?? "CW";
  const filter = options.filter ?? 1;
  const radioAddress = options.radioAddress ?? CIV_DEFAULT_RADIO_ADDRESS;
  const controllerAddress = options.controllerAddress ?? CIV_DEFAULT_CONTROLLER_ADDRESS;
  const echo = options.echo ?? true;
  const chunkSize = options.chunkSize ?? 1;
  const latencyMs = options.latencyMs ?? 0;
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 1024) {
    throw new CivTransportError(`chunkSize must be an integer in [1, 1024], got ${chunkSize}`);
  }
  if (!Number.isInteger(latencyMs) || latencyMs < 0 || latencyMs > 60_000) {
    throw new CivTransportError(`latencyMs must be an integer in [0, 60000], got ${latencyMs}`);
  }
  // 提前校验频率/模式编码，构造失败早于任何查询。
  const frequencyData = encodeFrequencyBcd(frequencyHz);
  const modeData = [civModeToCode(mode), filter];

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
      offset += 1; // 保序：同延迟下也按注册顺序触发。
    }
  }

  function respondTo(data: Uint8Array): void {
    const replies: number[][] = [];
    for (const frame of parser.push(data)) {
      if (frame.to !== radioAddress || frame.from !== controllerAddress) continue;
      if (frame.command !== CIV_COMMAND_READ_FREQUENCY && frame.command !== CIV_COMMAND_READ_MODE) continue;
      replies.push(
        frame.command === CIV_COMMAND_READ_FREQUENCY
          ? frameBytes(controllerAddress, radioAddress, CIV_COMMAND_READ_FREQUENCY, frequencyData)
          : frameBytes(controllerAddress, radioAddress, CIV_COMMAND_READ_MODE, modeData),
      );
    }
    if (replies.length === 0) return;
    // 一次写入的所有回复（含回显）必须作为一个连续字节流按序发出；
    // 否则多个拆包序列会交错，破坏帧边界。
    const stream = echo ? [...data, ...replies.flat()] : replies.flat();
    emitSequentially(stream);
  }

  return {
    requests,
    get closed() {
      return closed;
    },
    write(data: Uint8Array): Promise<void> {
      if (closed) {
        return Promise.reject(new CivTransportError("simulated CI-V transport is closed"));
      }
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
