# P2-002a v1：第一条Fake IPC链路

交付状态（2026-10-11）：DSH首版未完成自测，Codex接手修正；最终20/20专项、类型检查通过，DSH定点复核完成。REV-003裁决为限定Fake离线验收通过。完整P2-002和RemoteKeyer/真机未验收；下一步P2-002b。

DSH实施并自查；Codex复核。基线/mnt/d/AI/project-backups/cwstation/20261011-231732-p2-review-fixes/含apps/packages/tests/docs/dist。工作目录/mnt/d/AI/projects/cwstation。先读AGENTS、规范、P2-002设计v3和REV-002-Codex复核。

此切片交付版本化有界NDJSON、受监督Fake子进程和一次send/stop/查询闭环。全矩阵及核心RemoteKeyer集成列P2-002b，不谎称本切片已完成全部设计。默认daemon、COM17、rig.sh、core、contracts不变。

仅可新增packages/rig-control/src/protocol.ts、fake-service.ts、client.ts、apps/rig-faked.ts、tests/rig-control.test.ts、docs/evidence/P2-002a-Fake-IPC.md，不修改其他文件。目录/文件创建前确认不存在；若已存在停止写并反馈。新文件基线为不存在，根目录与现有相关文件已经备份。使用apply_patch，不装依赖、不读凭据、不接设备、不调用其他Agent。

实现要求：
1. 精确对象式protocolVersion1信封，hello私下交付会话密钥，16KiB字节行上限、未知字段/方法/类型拒绝；没有raw方法。客户端处理请求id关联、关闭/错误/超时，stdout只协议，stderr不含密钥。复用标准Node流/crypto/fs，不自写平台管道桥。
2. Fake服务仅模拟CW30字节，复用planCivCwMessage/contentHash，HMAC及字段按v3。设备标识配置稳定、启动标识随机。能力标记fake/simulation。不导入真实serialport/serial工厂。一个send在途；保留stop优先槽。停止只凭已握手控制会话，不受send授权过期限制。
3. 显式目录账本JSONL，intent刷盘后才计一次后端调用，终态追加。恢复未决为unknown并阻止新send，同键重放零副作用、不同摘要冲突，损坏/写失败禁发。消息不截断。stop后证据模拟stopped则cancelled，否则unknown；迟到完成不覆盖终态。客户端超时不自动重发。
4. client启动node --import tsx apps/rig-faked.ts子进程（编译入口可参数指定，不假设只有源码），stdin/stdout私有通道，关闭有界等待/终止，EOF子服务有界退出。不改生产daemon；客户端是测试/后续RemoteKeyer的通道层，别伪装已接核心Keyer。
5. 最少测试正常完成/原帧、同键防重复和冲突、停止及授权过期后停止、超时/无自动重发、服务重启恢复unknown、错误token、字节帧上限、退出无残留。必须包含实际子进程字节流，测试账本全在系统临时目录并清理；故障注入仅Fake内显式测试选项。

授权node --import tsx --test tests/rig-control.test.ts及tsc --noEmit；不构建dist、不跑全套。实现first链路后记录阶段自查，再完成上述测试。证据含实际退出码、计数、R01-R12、diff、未覆盖矩阵项，不记录密钥。有设计阻塞只给具体证据/最小方案；无阻塞自主实现，避免重复全量探索。完成报告并退出交回修改权。
