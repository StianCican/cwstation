# P2-002b v1：核心授权接入Fake IPC

状态：v2经DSH定点审议与Codex最终复核，限定离线集成验收通过。Linux84/84、Windows隔离编译50/50、时钟边界定点30/30；默认生产入口和真实设备未接入。证据与未完成项见P2-002b证据、REV-004-Codex复核。

日期2026-10-12。用户同意继续核心授权集成；Codex设计/复核，DSH实施、自查和证据。仅Fake离线，不接串口、不修改默认daemon、core、contracts、rig.sh。不将此任务当作完整生产P2-002验收。

v2补充：Windows复跑复现同机父子墙钟精度差触发future快照拒绝。Codex限定允许20ms采样偏差，超过20ms和超过2秒旧快照仍拒绝；不续期授权。新增20/21ms边界用例与Windows重复运行，不把墙钟容差替代生产动态上下文事件。

基线：/mnt/d/AI/project-backups/cwstation/20261012-000600-p2-002b/，cp -a保存packages/apps/tests/docs/MEMORY。项目无Git。

## 修改权与输入

DSH只可新增packages/rig-control/src/remote-keyer.ts、tests/remote-keyer.test.ts、docs/evidence/P2-002b-RemoteKeyer.md，并局部修改packages/rig-control/src/fake-service.ts的核心stateGeneration处理。不改其他文件。Codex等待交接再修改。apply_patch编辑，无依赖安装、无凭据读取、无设备访问、无其他Agent。
读项目AGENTS、任务自查规范、P2-002 v3、REV-003及Keyer/TxRequest契约、TxController.runKeyer；直接开始实现，不重复全量探索。

## 既定实现设计

1. RemoteKeyer实现既有Keyer接口，构造接收FakeRigClient，仅模拟后端。客户端生命周期仍由宿主持有；不自动重启/重连/重发，不增加公共write入口。以现有TxController+SqliteJournal+真实Fake子进程测试集成；暂不改生产daemon选择项。
2. transmit前复核Proposal/Approval的proposalId/hash/频率/模式/stateGeneration一致、当前期限、手册字符/长度。expiresAt取提案/批准较小值，剩余超过60秒则保守拒绝（不能重新续期）。初始aborted及副作用前异常返回unknown；不能推断取消成功，不抛KeyerAbortError。
3. 执行前获取capabilities与snapshot并运行时核对fake/simulation标记、稳定设备/启动身份、频率CW/代次、可靠证据/最大长度/字符集，以及快照时效（<=2秒，不接受未来采样）。本次send用捕获的设备上下文，不能用过期缓存。此切片Fake频率静态；生产动态状态事件与daemon监督另验收。
4. 核心stateGeneration与设备connection/permission代次分开。修正fake-service初始化readonly0的错误假设：stateGeneration改为最后接受的核心代次，初始0，新操作拒绝回退（小于已接受代次），只在intent成功刷盘后提升；同键重放仍按摘要与旧记录优先处理。P/A一致及当前核心状态由TxController和RemoteKeyer核对，不把设备代次替换成核心代次。服务snapshot的stateGeneration是诊断值，RemoteKeyer不能要求它与新的核心代次相等。局部私有实现修正，不改线协议或公共核心契约。
5. operationId固定proposal.id。发送与停止响应除协议校验外，适配器必须核对operationId/deviceInstanceId/serviceInstanceId/hash/text/频率/mode/三种代次与本次请求完全一致。completed只凭backend_completed，cancelled只凭backend_stopped且目标相符；其他结果unknown。将模拟证据写入TxResult.detail，核心自动持久化，禁止伪称射频证据。
6. 注册AbortSignal并覆盖预检阶段竞态；预检abort不得发send。send已同步派发后abort立即一次cw.stop(stopId随机、operationId稳定)，不受send过期影响。多次abort/超时只发一次stop。停止证据可靠才cancelled；停止失败/关联错误/证据不足unknown。abort与send完成竞争必须保守，不因send已accepted或异常且signal.aborted就cancelled。
7. IPC send超时/异常立即锁定本次unknown，尝试一次stop；停止的后续成功不覆写unknown。适配器有界（TxRequest.timeoutMs为上限），timer/listener完整清理，stop自身有客户端请求期限。核心超时/状态变化/断线仍用已有unknown规则，迟到结果或operation.get不得修改核心SQLite unknown。

## 验证与审议

新增测试包含跨进程与SQLite：未批准零intent；批准完成一次/同ID返回旧结果；操作员abort可靠停止cancelled；无停止证据unknown禁发；核心超时unknown落盘且迟到完成/查询不清除；状态变化撤销旧批准且在途unknown；设备崩溃unknown/恢复零重发；非零核心generation可完成；响应错误operationId/设备/上下文拒绝（可客户端方法显式测试替身，不把替身当跨进程证据）；预检abort零intent。所有临时目录清理，关闭服务/核心，测试有界。
授权专项remote-keyer、rig-control、controller、resolution测试及tsc --noEmit；不跑全量，不构建dist。首条可运行集成后阶段自查，再故障测试。报告实际结果/命令/退出码、R01-R12、SHA、未覆盖项。完成后退出并交回修改权。总执行控制为8分钟，先交代码及专项结果，不进行长篇假想BUG枚举。
