# ADR-019 统一操作契约的 Fake 首切片

当前适用范围（2026-10-20）：Fake实现及其证据保留，功能扩建暂停。下方“后续依赖”与旧试验迁入新服务的方向已由ADR-020替代，不作为当前任务或主链前置条件；历史正文保留追溯。

日期：2026-10-19。决定：用户明确同意“本次由 Codex 单独复核替代 DSH，确认修订后的契约后推进 Fake 离线实现”。这次例外仅覆盖 P2-016 复核与 P2-017A 的 Fake 实现，不等于 DSH 独立审议通过，也不追溯验收 BASE-002 或授权真实设备。

设计输入为 P2-016 v0.3（确认前 SHA256：73c2e0e145abc9673f55591390bdb3d0493baccb72160840150b137e84334040）。Codex 复核其两段精确请求、宿主派生角色、绝对期限、去重顺序、intent 失效矩阵后，接受其作为 Fake 首切片的接口依据。真实初始化、导入和设备调度仍须后续实现与验收。

采用既有 `rig.sh -> rig-launch -> rig-controld`，显式 `--mode cw-trial --simulate` 进入新链路。宿主另 fork 交互端 `cw-operation`，只转发它实际继承的 IPC，设备子进程独占模拟适配器、上下文、批准和记录。新链路没有监听端点，没有真实 transport 工厂或客户端串口入口。未指定模式的原只读启动路径兼容。

本切片用 `fakeFixtureVersion:1` 的临时 JSONL 夹具，而不是冒充 P2-016 第9节生产账本。夹具由宿主在独占临时目录显式初始化，首行 initialized，追加串行并 fsync，唯一锁，空日志/损坏/别名拒绝，操作可在模块重启后只读去重。宿主每次新建夹具只适用于模拟；不能以此规避真实历史 unknown。夹具路径写 stderr、退出后保留，不读取/迁移/删除用户旧账本。CLI 不接受路径覆盖。

首切片已支持 describe/status/refresh/create/approve/revoke/execute/stop/get/close；reconnect 明确 unavailable。固定九值模拟快照通过同一批准、执行重读和写前检查，模拟完成/停止证据明确为 simulation。这里没有 CI-V transport/parser，故不构成八查询物理仲裁或迟到 FB 验收。

后续依赖：生产 manifest/Binding/legacy 导入、完整逐事件恢复与平台持久化、重连与旧代次停止向量、实际 CI-V 单槽调度、公共只读投影，以及旧 `--cw-trial`/`scripts/cw-trial.sh` 迁移。旧入口本次未改造，统一迁移尚未完成，不能扩展其旁路功能。上述通过前新模式禁止真实设备组装。

回退依据：Git 基线 058b1f0、`.local-backups/20261019-p2-017-fake/before.bundle` 与已比对完整快照 `workspace-before.tar`；不回写旧记录，不要求数据库迁移。验证与 R01-R12 见 P2-017A 证据。
