# P2-002b v2：RemoteKeyer离线核心集成

日期2026-10-12。实现DSH首版/Codex修正；交叉审议DSH REV-004、最终裁决Codex。

## 交付范围

新增packages/rig-control/src/remote-keyer.ts、tests/remote-keyer.test.ts；局部修改fake-service.ts的核心代次处理。
既有TxController与SqliteJournal通过RemoteKeyer驱动真实Fake子进程；每次执行前核对P/A与新获取的设备上下文，使用稳定proposal.id，完成/停止只接受匹配目标与能力覆盖的模拟证据。
总deadline覆盖预检、send与stop；超时或异常立即unknown，send失败尝试一次stop，不重发，后续停止成功不能覆写unknown。
核心代次与设备代次分开；服务仅在intent成功刷盘后接受更高核心代次，并从账本恢复最高已接受值。

没有生产daemon配置/CLI切换入口，默认FakeKeyer不变。未接真实串口、未打开COM17、未改变rig.sh、core/contracts、SQLite schema或线协议版本。用户界面和真实持有者迁移仍未实现。

## 保护与检查点

无Git。开始前读取入口/记忆/设计/规范和既有核心契约，git status确认非仓库；cp -a保护：
`/mnt/d/AI/project-backups/cwstation/20261012-000600-p2-002b/`。

- packages/apps/tests/docs/MEMORY.md：任务开始前副本。
- 根部rig-control与remote-keyer.test.ts：DSH中断交回后、Codex修正前副本。
- remote-keyer-reviewed-v2.ts：DSH正式审议时的代码，最终仅修正两处detail文案。
- windows-stage：首次不存在的隔离编译/验证输出；生产dist未构建或覆盖，node_modules未修改。
- logs-after-validation：首次两轮验证后的诊断现场副本，随后最终回归前已保存。**首轮基线遗漏了既有resolution测试helper会追加的logs，不能将此副本当作首轮日志前态备份。**未删除或覆盖这些诊断；源码、配置和数据库基线不受此缺口影响。规范已补验证持久化输出检查，后续任务须在测试前保护logs。

阶段记录：

1. 设计：任务v1限定核心契约与Fake切片，未增加公共核心接口。
2. 首条链路：DSH生成代码并运行测试，修正断言时SSE中断退出1，无完整自测交付，不计通过。首版还存在总deadline不含预检、send异常未stop、stop同步抛错逃逸。
3. Codex接手：确认无DSH/测试残留、保护首版，然后修正异常分支、增加运行时响应复验、可靠停止能力约束和代次恢复；IPC请求数改名sendRequestCount，不伪称实际键控数。
4. 第一轮独立测试14/15；失败断言把consumed提案写成cancelled，已按核心现有语义修正。随后15/15通过，增加7项回归。
5. 平台：Windows源码测试因共享node_modules仅含Linux esbuild而退出1，4个测试文件均未进入功能验证。未安装依赖；通过隔离编译目录运行Windows原生测试。
6. 交付审议：DSH正常退出0并创建REV-004；Codex处理F1-F3并复跑受影响验证，最终结果如下。

## 验证

Linux Node24.18.1：

```bash
cd /mnt/d/AI/projects/cwstation
timeout 60s node --import tsx --test tests/remote-keyer.test.ts tests/rig-control.test.ts tests/controller.test.ts tests/resolution.test.ts
npx tsc --noEmit
```

最终84/84通过，0失败/取消/跳过；其中RemoteKeyer23项、既有核心27项、解除核查14项、Fake IPC20项；类型检查与最终隔离编译退出0。
模拟主链路使用真实子进程字节流、临时SQLite和JSONL；错误关联/挂起/异常回复等显式客户端替身用例不视作跨进程证明。

Windows Node24.16.0：

```bash
npx tsc --outDir /mnt/d/AI/project-backups/cwstation/20261012-000600-p2-002b/windows-stage/dist
cd /mnt/d/AI/project-backups/cwstation/20261012-000600-p2-002b/windows-stage
'/mnt/d/Program Files/nodejs/node.exe' --test dist/tests/remote-keyer.test.js dist/tests/controller.test.js
```

stage根目录只复制package.json，未复制源码/依赖；FakeRigClient在该目录使用编译服务入口。
最终编译退出0；原生50/50通过，0失败/取消/跳过，覆盖RemoteKeyer23项与核心27项。不是完整Windows平台套件、生产daemon或成品分发验收。

Windows早期49/49通过后复跑曾48/49，新增detail诊断后定点30次复现2次正常快照被判未来，均在intent前拒绝。确认同机父子墙钟采样精度偏差，限定放宽20ms，21ms及明显未来拒绝，2秒旧快照仍拒绝，批准期限不延长。补边界测试后50/50及定点30/30通过；DSH另一次只读补审正常退出0，认为该有界Fake兼容修正未引入S0/S1。正式动态设备时钟仍另验收。

定点重复命令：Windows Node的spawnSync重复30次`node --test --test-name-pattern '非零核心' dist/tests/remote-keyer.test.js`，汇总`runs:30,failures:0`，退出0。

覆盖：未批准零intent、批准消费、稳定ID重复零重发、操作员停止cancelled、无停止证据unknown禁发、核心超时落盘、迟到完成/operation.get不能解除、状态改变撤销/在途unknown、服务崩溃/重启、非零代次/回退/恢复、响应设备/业务ID/内容/代次不符、预检abort、期限/字符、预检挂起与迟到零dispatch、send同步/异步失败一次stop、stop挂起不延长总期限、stop同步抛错、完成/abort竞争、异常快照与无停止能力伪造取消。

## R01-R12

| 项 | 结果 | 依据/限制 |
|---|---|---|
| R01 | 通过（切片） | 完成授权集成，明确默认入口/设备未迁移 |
| R02 | 通过（切片） | 核心依赖既有Keyer契约，适配器复用协议与规划器；批准前能力检查的生产接入尚待完成 |
| R03 | 通过 | 无schema/协议字段改动，既有数据保护；正式账本迁移仍属P2-002a未验收项 |
| R04 | 通过（所测范围） | 运行时复验P/A、能力/快照/操作与停止结果 |
| R05 | 通过（Fake） | 核心消费批准、服务单持有者、稳定ID与核心/设备代次分别核对 |
| R06 | 通过（Fake） | 证据不足unknown、状态变化即使停止成功核心仍unknown，不自动重发 |
| R07 | 通过（所测范围） | 整次有界、一处stop守卫，迟到不覆写；进程监督/满队列全矩阵仍待完成 |
| R08 | 通过（边界声明） | 私有继承通道；同OS用户信任边界沿用，未新增权限声明 |
| R09 | 通过（所测范围） | timer/listener清理与双账本恢复测试；真实刷盘各阶段故障未覆盖 |
| R10 | 通过（切片） | Linux83、Windows编译49及失败过程可复现；未跑完整套件 |
| R11 | 源码通过；日志基线缺口已记录 | 修改前源码与文档副本、首版副本、diff；首轮日志前态不能追溯，保留现场并补规范 |
| R12 | 通过（限定范围） | simulation detail、运行/审议状态区分；指标歧义按REV-004裁决保留至入口接入前 |

## 未完成项

生产daemon/CLI显式选用RemoteKeyer、动态设备上下文事件与监督、批准前完整设备能力检查、用户可见实际执行计数、退出崩溃/满队列/各阶段刷盘故障全矩阵，均不在本次验收结论内。Fake服务接真实串口和IC-7300停止/完成证据仍需另设计与真机验收。
Adapter不提供Keyer.keyedCount；现有核心对可选缺失值回退0，因此该值在本切片不表示执行次数。sendRequestCount是请求尝试数；实际模拟效果以设备intent与核心execution证据为准。
