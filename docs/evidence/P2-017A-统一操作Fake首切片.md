# P2-017A v1 Fake 首切片实现与 Codex 复核

日期：2026-10-19。作者/执行/复核：Codex。用户已明确授权本次以 Codex 单独复核替代 DSH，确认修订契约并推进 Fake；本报告不是独立交叉审议，也不把 BASE-002 历史补审改为通过。

结论：通过本次Fake离线首切片验收；完整P2-017迁移、P2-018生产故障矩阵和真实接入不在此结论内。

## 对象与保护

- 修改前 main 干净，Git 基线 `058b1f0`。保护目录 `.local-backups/20261019-p2-017-fake/`，含 `before.bundle`、完整 `workspace-before.tar`；归档完成后 `tar -df` exit0。快照包括忽略产物、依赖、数据与日志，不是运行中 SQLite 一致性备份。
- 按 P2-016 v0.3 和 ADR-019，新增统一协议、Fake 服务、夹具记录、宿主转发、设备服务路由、继承 IPC 交互端与专项测试。既有默认只读路径仅增加显式模式分支；未改真实串口工厂、旧 Fake 私有协议、核心批准或 SQLite schema。
- 账本夹具独立命名 `simulation-fixture.jsonl`、`fakeFixtureVersion:1`，不是生产账本格式。宿主创建临时目录、明确初始化、退出保留路径；CLI 没有目录覆盖参数。旧CW试验/设备账本与用户数据库不导入、不重写。
- 运行现有全仓测试会由 `tests/helpers.ts` 向 `logs/daemon-<pid>.log` 追加诊断，部分PID复用使旧诊断文件增长。最终逐一核对快照中的2193个旧日志：17个增长，全部旧字节前缀完整保留，没有覆盖旧记录；新增诊断保留，结果见final-log-prefix-check.log。`data/`、`node_modules/`、`AGENTS.md` 与快照最终单独比对 exit0，见final-protected-state-compare.log。

## 实现和首链路检查点

`rig.sh --mode cw-trial --simulate -> rig-launch -> rig-controld --operation-fake-fixture`；宿主另外启动 `cw-operation`，只接受该实际子进程句柄的五键操作请求。内部九键请求由宿主添加 actor/channelId/deadlineNs/remainingMs，服务只处理父继承IPC；没有公共控制端点或真实transport实例。

精确键/UUID/序号/角色/消息大小/深度/逐方法参数与结果均有运行校验。宿主重映射请求并核对服务实例，普通4槽、stop/close独立保留槽；服务读取容量2。期限使用同主机hrtime，启动链路校验时钟值落在宿主fork前与接收后的区间；不足预算不重新加满。

固定E/TEST、九值上下文、八查询能力字面量、独立摘要向量、approve/execute主动重读、一次批准、30秒期限、过期质量、intent先fsync再派发由服务集中执行。这里的读取是Fake域快照，不是物理CI-V八查询/parser调度。

attempt在revoke/stop/close/TTL/通道失效时不可逆作废。intent排队之后失败保留unknown；迟到flush不复活许可。原operationId在内存批准之前查重，换proposal/approval冲突。已知活动操作的一次stop不需批准；记录等待最多500ms，存储挂起继续尽力模拟停止并锁存storageFault/unknown。

Fake的完成/停止是显式simulation证据，FB/RX/端口关闭不参与。关闭独立报告portReleased/recordsFlushed/rfStopEvidence；释放未确认时保留所有权锁，宿主要求stopped证据与进程exit0。父通道EOF关闭服务并释放正常夹具锁；强制退出不是确认释放。

## 发现、修正与验证

构建初稿因TypeScript在await前后过度收窄state及回调内unknown收窄失败而exit2，已修正并保留build各版本日志。初轮专项28/28，补充阶段33/33；最终专项包含37项，最终结果以本节后续表为准。

首轮Linux全仓源码402项：392通过、2失败、8跳过。新演示链路在客户端disconnect先于exit、关闭服务抢先退出时返回1，已修正：关闭请求幂等复用，已请求关闭时等待交互端实际退出，不将正常关闭当服务故障。另有既有approval-gate只读CLI测试3秒启动等待超时；隔离复查与新专项合计70/70通过，完整重跑405项397通过/0失败/8跳过，未改旧测试等待或验证器并发。该单次超时仍提示高负载敏感性，不能据此宣称时序永不波动。

在首链路与交付自查又补齐：批准读取期间的通道失效、已到期期限消耗序号、成功响应的实例/请求关联、容量预留、存储故障后禁止继续追加、慢日志停止预算、交互异步执行不阻塞stop、关闭未确认保留锁。未以测试绿色取代这些代码路径检查。

Windows首次编译全仓406项：396通过、1失败、9跳过，新增专项均通过；失败为既有daemon的500毫秒独立abort测试。隔离daemon+新专项60项仍57通过/1失败/2跳过，因此不将其仅归因于并发。源码定位到 `DaemonClient.connect` 在Windows等待新桥进程ready，原测试在发送开始后才创建abort连接，可能已错过发送窗口。改为提前建立第二连接，仍验证独立连接abort、500毫秒发送和cancelled结果；Windows源码定点1/1通过。保护副本为daemon-test-before-connection-fix.ts，失败日志final-windows-built.log、recheck-windows-built.log原样保留。

现有验证器文件并发上限收敛为4，保留隔离与所有断言/产品期限，另存verify-platform-before-concurrency.mjs；这是对原Linux启动等待高负载敏感性的局部处理，不作为Windows桥启动问题的替代修复。准备阶段的operationId也纳入内存去重：并发重放返回prepared，不重复读取或派发。

最终验证均exit0，26个测试文件、406项；原始日志均在保护目录，不以早期回归替代最终结果。Linux Node24.18.1，Windows原生Node24.16.0；四种模式五项前检全部通过，编译模式构建通过。

| 验证 | 结果 | 日志 |
|---|---|---|
| Linux 编译全仓 | 398通过、0失败、8跳过 | verified-linux-built.log |
| Linux 源码全仓 | 398通过、0失败、8跳过 | verified-linux-source.log |
| Windows 原生源码全仓 | 397通过、0失败、9跳过 | verified-windows-source.log |
| Windows 原生编译全仓 | 397通过、0失败、9跳过 | verified-windows-built.log |

测试不累计跨模式的相同用例。最后将TTL向量与请求期限分开：批准20秒后刷新并开始execute，在批准31秒时释放flush，执行请求仍有预算，明确得到expired且零发送。此为测试夹具强化，产品代码未再改变；Linux最终全仓含此强化，Windows随后源码/编译专项各37/37再次通过，日志verified-windows-focused-source.log、verified-windows-focused-built.log。

Windows9项顶层跳过为3项Unix状态IPC、3项Unix配置/权限、3项符号链接权限；新夹具符号链接创建EPERM及既有维护/信号用例的内部symlink支路另有diagnostic，不能当作已覆盖。Linux8项为Windows专属分支。Julia与真实设备本轮不验收。源码套件中的新宿主集成会启动编译子进程，故须先build；README已列此前置条件。

## T01-T08 对应

| 向量 | 本切片证据 | 未覆盖 |
|---|---|---|
| T01 | 双通道精确键、伪造字段/角色拒绝、期限不重置、真实继承IPC | 未做恶意同用户进程隔离声明 |
| T02 | 关闭夹具锁后新服务读旧unknown，同ID返回且零新记录/零发送 | 生产schema恢复与真实崩溃矩阵 |
| T03 | 同ID换proposal/approval冲突，文件不增长 | 生产导入后重复历史 |
| T04 | 注入flush挂起期间revoke/stop/close/TTL/channelLost分别零发送；短deadline未知 | 真实磁盘/驱动故障 |
| T05 | 模拟flush成功后、服务await续体前作废，零派发 | 真实硬件驱动时点 |
| T06 | 发送等待期间模拟stop、只派发一次、记录挂起仍在预算内停止 | CI-V串行write、迟到FB归属尚未实现 |
| T07 | 重启服务新stop拒绝旧操作；同连接stop重放只读 | reconnect unavailable，尚无新代次实测 |
| T08 | 夹具空/截断/重复/非法行、双持有、硬链接/可创建时符号链接拒绝 | 生产manifest与平台目录耐久性 |

## R01-R12 复核

| 标准 | 结论与范围 |
|---|---|
| R01 | 用户明确例外与Fake授权有ADR记录；未扩大真实授权 |
| R02 | 唯一设备子进程、宿主仅监督转发；旧控制核心未搬迁 |
| R03 | 新操作版本独立、夹具版本独立；旧入口迁移未完成且已列依赖 |
| R04 | 双通道、结果、能力/摘要、来源、UUID/上限/未知键/关联有校验与反例 |
| R05 | 九值绑定、一次消费、intent fsync、重启先查重、失效attempt不可复活 |
| R06 | Fake证据明确；未知不以ACK/退出解除；停止与释放分开 |
| R07 | 有界请求表/控制槽/期限/读取消/EOF；真实仲裁与强杀矩阵仍待后续 |
| R08 | 只来自真实继承句柄；操作员角色宿主生成，无AI批准句柄；同用户信任边界明确 |
| R09 | 夹具锁/容量/串行写入/损坏拒绝/关闭锁保留；生产耐久性和导入未验收 |
| R10 | 专项及双平台全仓结果单列，首轮失败保留，平台跳过不隐瞒 |
| R11 | 058b1f0+bundle+完整快照；最终diff/保护范围逐项核对 |
| R12 | 仅首切片离线成果；非独立审议、完整P2-017/P2-018或实机验收 |

## 后续门槛

本切片可以继续开发与离线试用。生产账本的manifest/Binding/legacy来源归档、崩溃点矩阵、Windows目录持久化、重连与真实单槽CI-V调度、公共只读投影及旧受控入口迁移均未完成。完整P2-017/P2-018验收仍待后续，不进入P2-019、不打开COM17、不把临时新目录当解除真实unknown的方法。BASE-002历史独立补审仍保留原状态。

交付资源核查：Linux进程列表没有本项目rig-launch/rig-controld/cw-operation；Windows原生Win32_Process筛选这三个入口的node.exe得到matchingProcesses=0，记录final-windows-process-check.log。已等待所有本轮验证会话退出，不操作既有DSH web或其他项目进程。最终源码对象SHA256见final-reviewed-source-sha256.txt，shell语法检查exit0；Git差异限定上述源码、测试/验证器与文档，提交后以仓库HEAD和repository.bundle定位完整交付。
