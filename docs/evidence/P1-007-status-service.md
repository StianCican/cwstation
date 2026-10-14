# P1-007 独立只读状态服务核心

日期：2026-10-11。当前里程碑完成核心服务，并完成监视台 IPC 客户端化；真实 COM17 服务接管仍待现场验收。

## 已完成

- 新增 `packages/rig-status/src/service.ts`、`index.ts`、mock测试和
  `apps/rig-statusd.ts`。现有 `cwrig`、监视台、daemon、数据库和控制核心未改。
- `RigStatusService` 单独持有一个 CI-V transport，使用现有只读 03/04 查询；
  状态为 disconnected/connecting/ready/stale/fault，显式 reconnect，不自动重连。
- Unix socket NDJSON IPC，64KiB帧上限；RPC仅status/watch/reconnect，拒绝未知方法、
  顶层额外字段、全部请求参数和TCP端点。客户端断开不影响服务。
- 服务停止先关闭 transport/session，再关闭 socket；关闭失败记录为 stale/fault，
  不再静默报告完全成功。
- Windows 命名管道现已复用既有受保护 `WindowsBridge`，服务端以 `Duplex` 共用同一
  NDJSON 路由；既有 WindowsBridge ACL/身份验证继续负责权限边界。

## 验证

```text
npm run build                                      exit 0
node --test --test-timeout=60000 \
  dist/packages/rig-status/src/service.test.js      9/9 passed
```

测试使用模拟 transport 和临时 Unix socket，没有打开 COM17，也没有访问真实电台。
覆盖首读快照、单 transport、故障后显式重连、停止释放、IPC白名单、64KiB限制、
客户端断开不影响服务和端点解析。

Windows 原生 Node24.16.0 的 `rig-statusd --simulate --endpoint \\\\.\\pipe\\cwstation-rig-status-smoke`
冒烟通过：命名管道监听、status 请求返回 `ready` 和 `readOnly:true`，随后进程已停止。

客户端迁移首步：`cwrig status --endpoint <path>` 通过 `RigStatusClient` 请求状态，
Unix socket 与 Windows 命名管道模拟均返回 `ok:true/source:rig-statusd/readOnly:true/status:ready`。
请求帧只含 `id/method/params:{}`；曾出现的 source 顶层字段错误已修正。

`cwrig read` 现在也接受 `--endpoint <path>`，返回状态服务缓存；该模式与直接串口
参数互斥，直接串口模式暂时保留作过渡。

`cwrig monitor --endpoint <path>` 已改为只连接 `RigStatusClient`，不再打开串口；C/D/R/P/G/Q
操作分别对应服务重连/本地断开/读取 watch/暂停轮询/诊断显示/退出。`rig.sh` 已改为启动
`rig-statusd` 后再启动服务监视台，Linux 使用临时 Unix socket 和退出清理，Windows 使用
固定本地命名管道并在监视台退出时停止状态服务。

本轮新增验证：`npm run build` exit 0；Linux 模拟 `rig-statusd` + `cwrig status --endpoint`
与 `cwrig read --endpoint` 均返回 `ok:true/status:ready/readOnly:true`；`bash -n rig.sh` exit 0。

## 未完成

- 真实 COM17 只读服务验收：先退出旧 direct monitor，再由 `rig.sh` 或 `rig-statusd` 持有
  COM17，验证调频/模式跟随、拔插后的显式 C 重连、Q 退出释放；不得发送写设置或发射命令。

保护基线：`/mnt/d/AI/project-backups/cwstation/20261011-194533-status-service/`。
本里程碑新增代码由 DSH 实现，Codex 审查并修正关闭失败不能被吞掉的问题、客户端类型映射和启动生命周期。
本轮保护备份：`/mnt/d/AI/project-backups/cwstation/20261011-continue-status-client/`。

## 真实 COM17 服务验收（2026-10-11）

- Windows 原生 Node24.16.0 启动 `rig-statusd`，端点为
  `\\.\pipe\cwstation-rig-status-live`，端口 `COM17`，波特率 `19200`，并带
  `--confirm-keying-off`；服务进程 PID `34756`。
- 服务首个有效快照：`14204000 Hz / USB / FIL2`，报告 `ready`、`readOnly:true`、
  `portPath:COM17`、`baudRate:19200`。服务轮询期间通过 Windows 命名管道读取 status 成功。
- 通过客户端 RPC `reconnect` 显式关闭并重新打开 COM17，重连后的快照仍为
  `14204000 Hz / USB / FIL2`，状态仍为 `ready`；没有发送写频率、写模式、CW、PTT 或 SEND 命令。
- 停止 PID `34756` 后，Windows 原生 `cwrig read --port COM17 --baud 19200 --confirm-keying-off`
  成功重新打开并读取同一快照，证明服务退出释放了串口句柄。
- 本次未自动操作电台旋钮，也未执行物理 USB 拔插；调频跟随和拔插后按 C 的现场观察仍需在
  服务监视台窗口中完成。实机功率/TX 状态未读取，不能据此推断射频行为。

本次运行保护备份：`/mnt/d/AI/project-backups/cwstation/20261011-live-status-service-acceptance/`。

## 动态轮询稳定性观察（2026-10-11）

- 重新启动真实 COM17 状态服务后，通过 Windows 命名管道连续请求 `watch` 25 次，约 25 秒内每次均为
  `ready/stale=false`，快照均为 `14204000 Hz / USB`。
- 测试期间未观察到电台旋钮或模式变化，因此本轮证明轮询稳定和快照持续更新，不宣称调频跟随通过。
  状态服务已停止，未留下串口占用。原始输出保留在本次会话记录中。
- 本轮保护备份：`/mnt/d/AI/project-backups/cwstation/20261011-follow-test/`。

## 现场调频跟随确认（2026-10-11）

- 通过 `rig.sh` 启动 Windows 服务模式监视台，真实 `COM17` 由 `rig-statusd` 独占；用户在电台上
  转动旋钮，确认监视台频率可以更新。该结果确认服务轮询到界面的动态链路有效。
- 当前监视台仍保持运行，用户应在完成操作后按 `Q`，由脚本停止状态服务并释放 COM17。
- 本次保护备份：`/mnt/d/AI/project-backups/cwstation/20261011-follow-confirmed/`。

## 现场模式跟随确认（2026-10-11）

- 用户在 IC-7300 触摸屏切换模式后，服务监视台的 `MODE/FIL` 正确更新；频率跟随和模式跟随均已由
  用户在真实 COM17 服务模式下确认通过。
- 监视台和 `rig-statusd` 当前仍运行，待下一步 USB 拔插与按 `C` 重连测试后退出。
- 本次保护备份：`/mnt/d/AI/project-backups/cwstation/20261011-mode-follow-confirmed/`。

## 现场 USB 拔插与重连确认（2026-10-11）

- 用户完成 USB 拔出、重新插入，并在服务监视台按 `C`；状态服务重新打开 `COM17` 后恢复正常状态，
  频率与模式重新显示，测试通过。
- 真实服务模式的频率跟随、模式跟随、USB 拔插后显式重连均已确认；全程保持只读边界。
- 当前 `rig-statusd` 与监视台进程仍在运行，完成后按 `Q` 退出并释放 COM17。
- 本次保护备份：`/mnt/d/AI/project-backups/cwstation/20261011-usb-reconnect-confirmed/`。

## 最终退出释放确认（2026-10-11）

- 用户在监视台按 `Q` 退出；Windows 进程检查未发现 `rig-statusd` 或 `cwrig monitor` 残留，COM17 已释放。
- P1-007 真实设备验收闭环完成：只读状态服务、频率跟随、模式跟随、USB 拔插显式重连和退出释放均已确认。
- 本次保护备份：`/mnt/d/AI/project-backups/cwstation/20261011-final-release-confirmed/`。
