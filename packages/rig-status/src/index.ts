// packages/rig-status 公共出口：只读电台状态服务与本地 NDJSON IPC。
//
// 只导出只读状态能力；不导出任何写命令构造器、控制字段或设备授权入口。

export {
  RIG_STATUS_SOURCE,
  RIG_STATUS_MAX_FRAME_BYTES,
  RIG_STATUS_DEFAULT_POLL_INTERVAL_MS,
  RIG_STATUS_DEFAULT_QUERY_TIMEOUT_MS,
  RIG_STATUS_LOCAL_PIPE_PREFIX,
  RIG_STATUS_MAX_PIPE_NAME_LENGTH,
  RIG_STATUS_PROTOCOL_VERSION,
  RigStatusError,
  RigStatusService,
  RigStatusIpcServer,
  parseRigStatusEndpoint,
  rigStatusEndpointAddress,
  isRigStatusMethodAllowed,
} from "./service.js";

export type {
  RigStatusEndpoint,
  RigStatusPhase,
  RigStatusSnapshot,
  RigStatusReport,
  RigStatusOwnerMetadata,
  RigStatusCapabilities,
  RigStatusErrorCode,
  RigStatusTransportContext,
  RigStatusTransportFactory,
  RigStatusServiceOptions,
  RigStatusRpcError,
  RigStatusResponse,
  RigStatusIpcServerOptions,
  RigStatusHistoryEvent,
  RigStatusHistorySink,
} from "./service.js";

export { RigStatusClient, RigStatusClientError } from "./client.js";

export {
  RIG_STATUS_HISTORY_SCHEMA_VERSION,
  RIG_STATUS_HISTORY_MAX_READ_BYTES,
  RIG_STATUS_HISTORY_MAX_TAIL,
  RigStatusHistoryWriter,
  readRigStatusHistory,
} from "./history.js";

export type { RigStatusHistoryRecord } from "./history.js";
