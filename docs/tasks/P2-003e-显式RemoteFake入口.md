# P2-003e v1 显式Remote Fake入口与监督

2026-10-13状态更新：REV-006a交叉审议及Codex复核完成，限定离线实现及已验证范围通过；S3剩余项、边界与后续负责人见REV-006-Codex复核，不等于完整故障矩阵/真实电台验收。

用户同意仅离线：显式Fake远程发送入口、进程监督、批准前能力检查与执行计数语义。Codex设计/宿主整合/验证，DSH实现指定适配模块并交叉审议。P2-003d补审再次SSE中断，保留待审议，不能静默标验收。

基线：非Git cp -a /mnt/d/AI/project-backups/cwstation/20261012-2350-remote-fake-entry/（apps/packages/docs/tests/logs/dist/MEMORY/README）。新task/ADR/fake-session/test/evidence创建前不存在。全部手工编辑apply_patch。

## 接入与维护边界

- CLI仅新增--remote-fake-ledger <dir>，与--rig-endpoint互斥，无环境自动启用。账本目录规范化，与核心DB/端点分离；固定deviceInstanceId，不允许换ID绕过unknown。默认Fake/只读IC-7300入口保持。不修改真实服务、serial白名单、rig.sh、Fake线协议、SQLite schema。
- daemon取得DB和endpoint锁后启动FakeRigClient，初始模拟频率使用已持久核心频率。显式传入与daemon当前运行类型一致的rig-faked.ts/js路径，编译入口不会误选TS或依赖Linux esbuild。
- 新RemoteFakeSession(controller, client, keyer)提供start/refresh/close/checkApproval/view。client生命周期由daemon持有；session只停止自身poll/订阅，不能自行启动、重启、reconnect、send、stop。后台1秒；refresh合并；晚到/close结果丢弃；失联同步setState backendConnected=false及invalidate(reason,true)，不能抹去unknown/fault latch。通过client.subscribeFailure同步通知（Codex新增API）；callback异常不可变成未处理拒绝。
- refresh取得caps及snapshot并validateResponse运行时校验，fake/simulation/身份/频率CW/连接许可代次相符/快照2秒未来20ms。指纹包括设备/服务身份、频率mode、connection/permission、相关能力和blocked，不含采样时刻或设备接受核心最高stateGeneration；后者由服务执行校验，不能每次send后撤销新批准。相同指纹更新缓存。任意新指纹setState未提升代次则invalidate；故障仅撤销一次，恢复不复用旧批准。
- checkApproval同步调用keyer.checkApproval(proposal,caps,snapshot)（Codex新增，复用既有checkDeviceContext），要求会话已start未close、client.connected、缓存新鲜；禁止后台自动创建提案或批准。core approve/transmit继续共享guard。RemoteKeyer执行前依旧主动刷新再检。
- server onTransportReady可返回Promise，await恢复并start session后才admit RPC；beforeDeviceCommand调用refresh，沿用既有取消判定。remote附着禁dev.state，fakeOnly=true如实声明模拟；doctor/device暴露backendKind/evidenceSource/子PID/能力/错误，不暴露密钥或token。实时poll不改变核心批准真源。
- 正常shutdown先停止接单/关闭session，撤销批准并controller.shutdown，再调用client.deviceClose/close且等待子进程。关闭诊断区分干净关闭、被强杀和未确认；remote超时/关闭失败非零退出，不以watchdog exit0伪装成功。parent crash由stdin EOF本地禁发处理，无自动重启/重放。

## 计数兼容

core.status不再将缺失keyedCount伪造0。字段number|null，默认Fake和只读Keyer已有数值不变；null仅出现在新显式远程后端或缺证据适配器。RPC信封/Proposal/Approval版本不变，因为既有默认模式响应不变，新增后端调用者须接受null。Keyer新增可选executionMetrics（version1、source simulation、sendAttempts、confirmedCompletions、confirmedStops、uncertainAttempts）；RemoteKeyer按关联证据终态计数，unknown不记完成，attempt非设备实际执行次数。计数仅当前daemon进程，不替代持久账本/核心execution，不从历史重构不可靠值。

## 修改权交接

DSH仅实现新增packages/rig-control/src/fake-session.ts，按上述API，可读其它文件；禁止改其它文件、禁止运行测试/build、禁止设备。Codex同时负责apps/daemon、client、RemoteKeyer、Keyer/core status、server、测试与文档，双方不改同一文件。DSH如SSE中断且无交付，Codex检查/备份现场后接手。

## 验证与审议

Codex现场局部修正范围：tests/rig-control的RawService编译模式使用rig-faked.js，避免Windows误选TS依赖；FakeRigClient启动失败返回有界且会话密钥脱敏的stderr诊断。Windows父死重启10次2次、20次4次复现ledger.lock.guard残留，删除重试未解决。保留现场并临时跟踪确认释放临界区被中断，结合libuv Windows Job关闭强杀普通子进程的实现，修正Fake客户端spawn仅Windows detached，仍保持引用/私有管道/有界关闭，不unref；30次重启全部通过。临时锁跟踪和删除重试均已撤回，lock.ts与原基线一致，不改变未知guard的保守拒绝。DSH实施未留下文件，Codex检查后接手；最终只读审议也SSE中断无有效交付。

当前状态（2026-10-13）：离线实现与Codex复核完成，待DSH交叉审议，未最终验收。最终证据见docs/evidence/P2-003e-显式RemoteFake入口.md。正常关闭中核心关闭/刷盘/服务stop错误在Remote Fake模式非零退出。所有测试离线隔离，无真实设备接入。

用户同意的故障验证包含本任务新增和运行专项测试：正常跨进程批准/发送/账本完成、重复不重发、能力/字符预检拒绝零intent、停机释放、子死撤销/unknown、父死EOF/重启无重放、回执丢失/timeout不覆盖、指标null与已确认区分、参数互斥与默认兼容。隔离DB/账本/随机端点，禁止用户运行数据或COM17。必要回归core/daemon/remote/approval-gate，两平台编译原生；环境失败保留并复验，不推广真机。DSH最终只读审议R01-R12，Codex复核最终diff/哈希/进程并沉淀MEMORY。
