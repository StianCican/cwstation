# REV-004 DSH 定点交叉审议：P2-002b RemoteKeyer v2

| 项目 | 内容 |
|---|---|
| 任务 | P2-002b v2 定点交叉审议（只读） |
| 审议对象 | `packages/rig-control/src/remote-keyer.ts`、`packages/rig-control/src/fake-service.ts`（stateGeneration 局部）、`tests/remote-keyer.test.ts`（新增回归） |
| 对象 SHA-256 | remote-keyer.ts `179481e751b188ddb5bed23b0188a82fbe0c1df74c071b3e28f1932b55d8f9a0`；fake-service.ts `04350ee2d902ba2829fdaf7328329483e88a356d758b89eeef8fab63d0c793e8`；remote-keyer.test.ts `a688f6c15530f368c52208c40632e0237b9b4680b7956d9335af0326fb6cb39f` |
| 首版基线 | `/mnt/d/AI/project-backups/cwstation/20261012-000600-p2-002b/rig-control`（含 src 四个文件；首版 remote-keyer.ts `f620cd18…`、fake-service.ts `de904581…`，与当前不同，确为可复核基线） |
| 审议者 | DSH（实现与自测方） |
| 日期 | 2026-10-12 |
| 方法 | 仅读上述三处授权范围；未改源码、未跑测试、未接设备、未读凭据。发现只记录所读代码可确认的事实，不枚举无依据假想。 |

## 1. 范围与限制

- 只读授权文件：remote-keyer.ts 全文；fake-service.ts `stateGeneration` 相关的加载/恢复/发送段（330–689）；tests/remote-keyer.test.ts 新增回归（285–732）。
- 未重读项目其余部分，未复跑测试，未验证 Windows 隔离编译/运行；`protocol.ts`、`client.ts`、`controller.ts`、journal、测试 harness 未读，其行为只按调用点推断。
- 本审议仅新建本文件，未修改任何源码或既有文档。

## 2. 修正项核对

| # | 声称修正 | 所读证据 | 判定 |
|---|---|---|---|
| C1 | 单个总 deadline 覆盖预检/send/stop | remote-keyer.ts:181-183 建 deadline；198/203（预检）、271（send）、287（stop）同一 promise；294 finally 清 timer | 成立 |
| C2 | send 同步抛错 / 异步失败 / 错误响应均尝试一次 stop 且立即 unknown | 184-186 `requestStop` 幂等守卫；265-268 同步抛出；272-275 异步拒绝；280-283 响应校验失败；均 `finish("unknown", …)` | 成立（detail 见 F2/F3） |
| C3 | stop 同步抛错被捕获 | 427-443 `performStop` try/catch，同步抛出返回 `{ok:false}` | 成立 |
| C4 | 完成与 abort 竞争 → unknown | 285-288：`abortRequested` 时先 `requestStop`，若 send 已 completed 则强制 unknown | 成立 |
| C5 | runtime 响应校验与可靠停止能力核对 | 199/204/277/434 调 `validateResponse`；86-104 `checkOperationResult` 全字段核对；322 无 `reliableStopEvidence` 时 cancelled 映射降级 unknown；392 要求可靠完成证据 | 成立（所读范围） |
| C6 | 核心 generation 允许单调增并从账本恢复 | fake-service.ts:413 `Math.max` 恢复；616-618 更旧代次在 intent 前 `conflict`；664 intent 刷盘成功后才赋值 | 成立 |
| C7 | 误名 `keyedCount` 改 `sendRequestCount`，不把 RPC 次数当执行次数 | remote-keyer.ts:146-149 改名并加注释；测试改用 `sendRequestCount`（384/400/404/677）；全仓已无 RemoteKeyer 侧 `keyedCount` | 命名语义成立，但引入 F1 |

新增回归覆盖：deadline 覆盖挂起预检（293）、失败尝试一次 stop（305）、超时不等待挂起 stop（319）、完成/abort 竞争与 stop 同步抛错（329）、快照时效/未来/NaN 与伪造取消（339）、状态变化撤销（350）、代次账本恢复（362）、非零代次完成与回退拒绝（588）、响应关联矩阵（610）、停止响应目标不符（634）、预检/初始 abort 零 intent（665/683）、期限/字符/长度拒绝（699/717）。首版已指出的 consumed/cancelled 断言、快照代次与核心 detail 覆盖在 424/521、339/610/621、399/448/675 中可见，已修正。

## 3. 发现（按严重度）

### S0（可能未授权发射、错误停止声明、丢数据、泄凭据）
无。

### S1（违反关键接口/所有权/恢复契约，或核心行为无法正确验收）
所读范围内未发现实际 S1。C1–C6 的停止/完成/unknown 与代次语义成立；未把任意异常或 abort 推断为取消成功。

### S2（局部功能/兼容/证据/文档缺陷，验收前修正）
- **F1 `keyedCount` 契约面被静默降级。** `packages/core/src/keyer.ts:9` 仍声明可选 `keyedCount`，`packages/core/src/tx-controller.ts:161` 以 `keyer.keyedCount ?? 0` 写入 StationState/状态/日志；RemoteKeyer 改名后不再提供该 getter，故接入 RemoteKeyer 后控制器恒报 `keyedCount: 0`，即使已真实派发 send。改名本身语义正确（send 请求数 ≠ 执行数），但直接删除 getter 会把“不夸大”变成“恒为零”的信息丢失，影响状态/审计证据。
  - 建议（不改源码，交 Codex 裁决）：或让 RemoteKeyer 以“已确认 completed 的发射”实现 `keyedCount`，或在 core 明确区分 `sendRequestCount` 与 `keyedCount` 并同步 status 消费方；至少保留 `keyedCount` 为不提供（undefined）的显式约定，避免与真实 0 混淆。

### S3（维护性建议，无当前行为错误）
- **F2 异步 send 失败路径的 detail 误标 stop。** 272-274 先 `requestStop()`，却把 `stop=null` 传给 `decideSend`，经 `unknownDetail`（445-447）输出 `stop=not-requested`，与“已尝试一次 stop”不符。仅 detail 文案，outcome 已正确为 unknown。
- **F3 同步抛出文案与状态不符。** 258-259 已置 `dispatched=true` 并自增计数，267 的 detail 却写 `cw.send threw before dispatch`；若后端“先写帧后抛”即为不实描述。建议改为“sync throw; stop attempted-once”。

## 4. R01–R12 对应结果（仅本审议可确认范围）

| 编号 | 条款 | 结果 | 依据/限制 |
|---|---|---|---|
| R01 | 用户目标、授权、范围 | 通过（切片） | 仅审授权三处；修正点与 P2-002b 边界一致 |
| R02 | ADR、模块边界、真源 | 通过（切片） | 适配器只依赖既有契约与 Fake 客户端，未越界；ADR 原文未复读 |
| R03 | 协议/配置/存储/更新 | 不适用（所读范围） | 未改协议；stateGeneration 沿用既有版本字段 |
| R04 | 输入与外部结果运行时校验 | 通过（所读范围） | 响应/能力/快照均过 `validateResponse`，操作结果逐字段核对 |
| R05 | 发射许可与设备所有权 | 通过（所读范围） | 授权一致性预检；代次回退在 intent 前拒绝 |
| R06 | 停止/超时/断线/unknown 语义 | 通过（所读范围） | completed 仅 backend_completed；cancelled 仅 backend_stopped 且目标相符；其余 unknown；无自动重发 |
| R07 | IPC 与并发失败有界 | 通过（所读范围） | 单在途、stop 幂等一次、迟到完成不覆盖 unknown；全故障矩阵未验证 |
| R08 | 权限声明与隔离 | 未验证 | 通道/ACL 不在授权阅读范围 |
| R09 | 资源与持久化失败可恢复 | 部分（所读范围） | timer/listener 清理、代次账本恢复可见；ledger 故障路径与 690+ 未读 |
| R10 | 验证与风险匹配 | 未验证 | 按要求未跑测试，82 项与新增恢复测试结论未复现 |
| R11 | 修改受保护且范围可复核 | 通过 | 首版备份路径与文件存在且 SHA 与当前不同；本审议仅新增本文件 |
| R12 | 状态/文档/证据准确 | 通过（切片，附 F2/F3） | 离线与真机未验收分开；F2/F3 的 detail 文案不够准确 |

## 5. 未验证范围

- 测试未运行：Codex 所述四组 82 项通过、新增代次恢复用例、Windows 隔离编译运行均未在本机复现。
- fake-service.ts 690–932（stop/close/operationGet 尾部）未读；其与代次恢复、禁发的交互未逐行确认。
- protocol.ts、client.ts、controller.ts、journal、测试 harness/工具函数未读；响应校验器与 `sendRequestCount` 消费方的实现细节按调用点推断。
- 真机、串口、凭据、实际发射路径完全未涉及。

## 6. 结论

- 就指定审查的七项修正而言：C1–C7 中六项在代码与新增回归层面成立；C7 命名语义成立但引出 F1（S2）。
- 未发现实际 S0/S1。
- 建议：**有条件通过**——F1（S2）在进入真机/接入状态展示前处置或由 Codex 明确记录保留理由；F2/F3（S3）可随后续文案清理处理。最终裁决由 Codex 复核。

## 7. 修正与复核记录

- 本报告为只读审议产物，未改动被审议源码；本文件为新增，无既有基线。
- 待 Codex 对 F1 给出裁决后，本文件可增补复核结论。
