# P1-001 v1 真实设备接入准备审查

任务日期：2026-10-05。执行：DSH 只读代码审查，Codex 复核；DSH 未连接设备、未发射、未启动 daemon、未运行测试。范围：本文件是准备记录，不是已批准设计；下列建议不得当作 Phase 1 决定。

## 一、审查基准（实际代码）

| 层 | 文件/符号 | 当前事实 |
|---|---|---|
| 契约 | packages/contracts/src/index.ts `CONTRACT_VERSION=1`、`StationState` | 仅 CW；无设备能力字段 |
| 核心 | packages/core/src/tx-controller.ts `TxController` | 一次性批准、单在途、有界超时、unknown |
| 键控 | packages/core/src/keyer.ts `Keyer`/`FakeKeyer` | 仅 Fake；`keyedCount?` 可选 |
| 存储端口 | packages/core/src/storage.ts `TxJournalStore` | 核心不直接依赖 SQLite |
| daemon | apps/daemon.ts、packages/daemon/src/server.ts | 唯一持有 controller/FakeKeyer/SQLite；`fakeOnly:true` |
| 独占 | packages/daemon/src/lock.ts、paths.ts | DB 锁 + socket 锁 + bind |
| 核查 | docs/adr/0002-unknown核查与解除.md、`resolveUnknown` | 仅 Fake；声明不等于物理停发 |

未实现/未真机：无 CAT、KEY/PTT、音频真实后端；`packages/devices`、`modes`、`decoders` 尚不存在。

## 二、逐项审查

### 取消/停止确认
- 已有：`TxController.abort()`（tx-controller.ts:724）置 `abortReason="operator"`、调用 `AbortController.abort()`、审计 `tx.abort_requested`；`runKeyer()`（:647-721）将操作员取消后的 `KeyerAbortError` 判 `cancelled`（:708），也接受后端返回的 `cancelled`；键控器报 `timed_out` 判 `unknown`（:699），其它异常判 `unknown`（:716），超时后的迟到完成/异常不覆盖（:681、:707）。代码未把 `signal.aborted` 当停发证明（:716 注释）。
- Fake 测试：tests/controller.test.ts:144、:348；tests/daemon.test.ts:152。
- 未实现：无硬件停发确认；`Keyer`（keyer.ts:7）未声明是否响应取消、能否确认停止；`resolve-unknown` 仅 `fakeOnly`（server.ts:286）。真实后端若在硬件未停时返回 `KeyerAbortError`，会被记为 `cancelled`——这是接口义务，尚无真实用例约束。

### 断连及频率/模式变化
- 已有：`setState()`（:734）识别 `frequencyChanged/modeChanged/disconnecting`（:742-744），调用 `invalidate(..., abortReason)`（:762）；`invalidate()`（:778）先抢占在途（:780-783），再在事务内撤销全部批准、终止开放提案、`generation+1`（:787-803）；失败时回滚内存真值并阻止（:763-772）。
- Fake 测试：tests/controller.test.ts:172、:316、:109；tests/daemon.test.ts:298。
- 未实现：无真实 CAT 读写与断连检测；`dev.state` 是测试钩子且默认关闭（server.ts:293-295）；`TxController.loadState()`（:132）把 `backendConnected` 默认置 `true`（:139），启动时不探测硬件。

### 启动/停机恢复
- 已有：apps/daemon.ts 顺序为 DB 锁→打开/迁移→socket 锁→`server.start()`→`recoverOnStartup()`（:119-143）；`recoverOnStartup()`（:206）running→unknown（:225）、撤销批准（:237）、无 LIMIT 终止开放提案（:240）、仅在确有开放工作时 `generation+1`（:244-248）、重复调用幂等（:207）。停机：`server.stop(onClosing)` 先置 `closing` 停止接单（server.ts:357-386），`controller.shutdown()` 有界等待、超时记 unknown 并阻止（:815-850）；apps/daemon.ts:163 另有看门狗兜底。
- Fake 测试：tests/daemon.test.ts:242、:278；tests/controller.test.ts:184、:217、:424、:462。
- 未实现：真实键控中的断电/崩溃未验证；看门狗 `process.exit(0)`（daemon.ts:163）在极端关闭挂起时可能先于 unknown 落盘退出，触发条件交 Codex 复核。

### 真实后端核查
- 已有：`fakeOnly` 在 apps/daemon.ts:138 硬编码 `true`；`doctor` 如实报告（server.ts:311-339）；核查接口拒绝非 Fake（server.ts:286）。
- 未实现：无真实后端、无设备探测、无“停止已确认”的设备侧证据；`doctor.securityModel` 是静态字符串（server.ts:334）。

### 能力声明
- 设计方向要求设备显式报告取消、完成回执、队列清理、状态读取等能力（MEMORY.md:60），但契约无对应字段：`Keyer`（keyer.ts:7）仅有 `transmit` 与可选 `keyedCount`；`StationState`（contracts/src/index.ts:31）无能力集合。
- 建议：真实适配器接入前明确能力声明及版本兼容方式；本次不实现，交 Codex/用户讨论最小接口。

### 设备唯一持有者及部署边界
- 已有：DB 锁（paths.ts:64，daemon.ts:119）、socket 锁（paths.ts:71，daemon.ts:128）、独占 bind 与陈旧 socket 检查（server.ts:62-92）、mkdir guard 串行化（lock.ts:69）；socket 0600（server.ts:80），不监听 TCP（server.ts:337 `listensOnTcp:false`）。
- 未实现：上述锁只约束 CW Station daemon 之间，不锁定 `/dev/tty*`、声卡等真实设备节点；rigctld、fldigi、N1MM、cwdaemon 等仍可同时占用。部署系统（WSL/Linux 还是 Windows 原生、串口归属）未定；ADR0001 仅规定 Julia 不在发射路径。

## 三、设备信息清单（须用户确认，不得猜测）
1. 电台型号/固件；CAT 协议与串口参数（端口、波特率、流控）及命令集版本。
2. KEY/PTT 方式：串口 DTR/RTS、WinKeyer、内置键或 VOX；哪一路是唯一键控出口。
3. 音频设备/声卡与 CAT 是否共用；采样率、通道、播放归属。
4. 设备唯一持有进程与部署系统；现有会占用同口/同声卡的程序。
5. 停止手段与回执：`T 0`/`RX`/PTT 释放能否确认；断连检测方式（轮询/心跳/USB 拔插）。
6. 频率/模式能否由 CAT 读取及其变化检测方式。
7. 日志真源与 TLF/N1MM 的只读角色。

## 四、建议的假负载验收顺序（建议，非已批准）
1. 只读接入：假负载/最低功率，daemon 独占设备并读取频率/模式，确认无其它进程持有。
2. 能力门禁：核对取消、停止确认和状态读取能力，不满足接入条件则拒绝真实发射；`fakeOnly` 必须始终如实标识后端，不能用它代表设备就绪状态。
3. PTT 单项：短时 PTT 通断与超时回落，不接音频。
4. KEY 单项：假负载极短点划，验证取消立即停与停止回执。
5. 断连/改频：拔 USB、断 CAT、改频/改模式，验证撤销授权、在途→unknown、阻止新发射。
6. 停机/重启：SIGTERM/SIGINT、SIGKILL，重启后 running→unknown 与人工核查流程。
7. 急停演练：物理急停与软件 abort 的一致性。
8. 以上全部通过后，才在有人在场、假负载下做一次受控短报文。

## 五、须用户讨论的接口决定（本次不实现）
- 设备能力声明：硬件取消、停止确认、队列清理、状态读取、独占设备。
- `backendConnected` 的初始化与更新来源（启动探测 vs 心跳）；`loadState` 默认值是否改为 false/unknown。
- “操作员 abort 但键控器报 completed”的结果语义（当前 runKeyer:704 会记 completed）。
- 真实后端是否保留 unknown 核查（ADR0002 已注明 Phase 1 重定）。
- 设备节点是否需 OS 级独占锁/独立持有进程，与 rigctld/cwdaemon 的边界。
- 部署系统与串口归属。

## 六、未决项摘要
- 电台/键控/音频路线与部署系统未定（MEMORY.md:92-98）。
- 无真实后端、无能力声明、无设备独占锁；Phase 1 验收未开始。
- 三个待 Codex 复核项：`loadState` 默认 `backendConnected=true`（tx-controller.ts:139）；abort 与 completed 冲突语义（:704）；关闭看门狗可能先于 unknown 落盘退出（daemon.ts:163）。
- 本文件仅准备审查，不构成接口变更或验收批准。

## 七、Codex 复核与基线
- 独立运行 `npm run test:built`：构建成功，139/139 通过，失败/取消/跳过均为 0。仅既有临时库测试，未操作用户数据库或真实设备；本轮测试 daemon 已退出。
- 确认默认连接状态、状态来源和设备能力缺口。Fake 的默认连接状态符合当前阶段，真实适配器必须以设备探测结果为准。
- 操作员取消后返回 completed 可能表示取消前已经完成，尚不能仅凭代码断言错误；需在真实后端契约中明确完成与取消竞争及其证据。
- 看门狗先退出时持久化 running 会在重启恢复为 unknown，不能据此声称恢复绕过；物理停止仍无保证，真机方案需独立验证。
- 进入带电 PTT/KEY 验收前先核对设备手册、假负载额定值、功率、人工急停和现场人员；PTT 本身可能产生射频，不能因无音频而视为只读操作。
- 当前目录没有 Git 仓库，未提交版本记录。设备回答到达后再细化接入设计与正式验收任务。
