# P1-007：独立只读电台状态服务

状态：状态服务核心、Windows 命名管道、`cwrig status`、`cwrig read --endpoint`、`cwrig monitor --endpoint` 和 `rig.sh` 服务生命周期已实现；COM17 服务验收待现场执行。

目标：实现 `rig-statusd`，由它独占 IC-7300 串口；客户端通过本地 IPC 获取状态。

## DSH 执行范围

DSH 独占新增 `packages/rig-status/src/` 和 `apps/rig-statusd.ts`。不得修改现有
`apps/cwrig.ts`、`apps/rig-monitor.ts`、daemon/core、数据库或已有测试。不得访问真实设备。

实现要求：

- 复用 `openSerialCivTransport`、`CivReadOnlyClient`，只读03/04。
- 抽象 `RigStatusSnapshot`、`RigStatusService`，状态为 disconnected/connecting/ready/stale/fault。
- 提供本地 NDJSON IPC server，Unix socket 与 Windows 命名管道均使用显式端点；不监听 TCP。
- RPC 白名单仅 `status`、`watch`（短轮询快照）和 `reconnect`；拒绝未知方法和所有控制字段。
- 一个服务内只持有一个 transport；客户端断开不影响服务；服务停止先关闭 transport，再关闭端点。
- 默认显式串口、19200、1秒轮询；不自动重连。所有客户端收到 `source: rig-statusd`、`readOnly: true`、snapshotTime/status/stale。
- mock transport/IPC 测试，不读真实串口；构建并报告证据。

交接后 Codex 审查 IPC 帧限制、端点权限、生命周期和只读边界，再修改客户端与启动脚本。
