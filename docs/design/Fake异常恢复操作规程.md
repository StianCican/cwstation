# Fake异常恢复操作规程 v1

适用：当前默认进程内Fake与显式Remote Fake。实现依据P2-003e和现有cwctl/cwmaint；本规程不适用于真实电台停止或发射许可。操作人声明不等于物理停发证明。

## 快速判断

| 现象 | 核查入口 | 当前处理 |
|---|---|---|
| 核心unknown，设备正常 | status、doctor、unresolved、executions | 确认旧进程已退出，保存证据，按核心解除流程核查 |
| Remote Fake capabilities.blocked=true | doctor/status的device.capabilities及账本 | 保持禁发；设备账本没有解除接口 |
| storage_fault或故障闩锁 | doctor/unknownReview与维护诊断 | 先停机和排查存储，再使用已有clear-storage-fault |
| 启动提示live pid | 报错锁路径、锁内pid、同系统进程 | 找到已有持有者，不清锁、不启动第二实例 |
| 启动提示guard或损坏锁 | 报错完整路径、持有者及启动器 | 冻结启动、保存现场、人工确认归属后隔离残留 |
| 子进程失联或关闭未确认 | daemon日志、device.pid、exitCode | 禁发并核查进程；stop已接收不等于已退出 |

## 1. 记录并停止

停止创建提案、批准和transmit。不要用demo诊断，它会自动走提案/批准/执行链路。
记录本次启动命令、Node平台/版本、完整DB/账本/endpoint路径、时间、daemon与设备PID、服务实例、操作ID、错误及退出码。不把会话密钥或其他凭据写入证据。

服务可访问时，以**实际运行端点**执行只读请求。下面`<endpoint>`是占位符，须替换；Windows命名管道必须用Windows原生Node，WSL Linux Node不能直接连接。

```bash
node dist/apps/cwctl.js --socket <endpoint> status
node dist/apps/cwctl.js --socket <endpoint> doctor
node dist/apps/cwctl.js --socket <endpoint> unresolved
node dist/apps/cwctl.js --socket <endpoint> executions 100
node dist/apps/cwctl.js --socket <endpoint> audit 100
```

100条仅是当前取样，不代表完整历史。服务不可访问时保留报错，不循环尝试发送。
如有在途模拟操作，可显式请求abort；响应不能单独证明已停止。然后请求stop：

```bash
node dist/apps/cwctl.js --socket <endpoint> abort
node dist/apps/cwctl.js --socket <endpoint> stop
```

核查daemon已退出、Remote Fake子PID已退出以及日志中的关闭结果。退出1、强杀、超时或没有确认均记录为未确认关闭，不改写为正常完成。Windows需在Windows进程表核查，Linux用Linux进程表；权限不足、PID归属不明或进程仍在时停止恢复。不要根据PID不存在推断历史操作完成。

## 2. 保存可恢复现场

所有相关进程停止、启动入口被冻结后，在D盘或WSL数据盘创建带时间戳且不存在的证据目录。保留文件属性，复制DB及其现有-wal/-shm/-journal、设备账本整个目录、相关锁/guard、日志、配置和启动参数。记录原始路径、操作人、时间及文件SHA-256；不覆盖原文件，不只复制SQLite主文件后声称一致备份。

原始拷贝用于事故证据，不替代可校验的一致数据库备份。锁允许、存储可读时，另用维护入口生成独立快照：

```bash
node dist/apps/cwmaint.js backup --db <original-db> --out <new-bundle-directory>
node dist/apps/cwmaint.js inspect --bundle <new-bundle-directory>
```

维护命令不会自动停机；live pid、空/损坏锁或残留guard会导致拒绝，先执行第5节。内容有效、持有者已退出且没有guard的锁可由程序原子改名后继续。磁盘故障、空间不足、复制不全或校验失败时保留现场并停止，不继续解除。

## 3. 核心unknown

默认进程内Fake：使用原DB和原配置重启一次，等待daemon.ready和启动恢复完成；不要改变DB路径、后端或模拟故障配置来冒充恢复。检查status/doctor/unresolved。
仅启动恢复时已存在的unknown允许解除；本次运行新出现的unknown必须再次停机、核查旧进程退出后再恢复。故障闩锁、在途操作、未恢复或backendConnected=false会拒绝。

```bash
node dist/apps/cwctl.js --socket <endpoint> resolve-unknown <proposalId> \
  --operator <operator-name> --note <actual-review-evidence> --confirm-stopped
```

operator/note填写真实人工核查依据，不照抄示例。解除追加核查记录、撤销全部开放批准、取消全部开放提案并提升核心代次，原执行仍为unknown；重试原ID仍返回历史结果，不发送。检查unresolved、executions和audit，不执行transmit验证恢复。仍有其他unknown则继续阻止；允许新操作后也必须新提案并单独批准。

Remote Fake：先检查设备capabilities.blocked。设备账本unknown/ledger_fault会令backendConnected=false并拒绝核心解除，当前不能走上述解除。设备正常而仅核心unknown时，才可按核心条件人工核查；核心记录与账本必须按同一operationId检查，不能以发送尝试计数推断完成。

## 4. Remote Fake账本unknown或损坏

设备未知与核心未知是两个持久化真源。重启使用原DB、原账本和固定设备身份；未完成intent会恢复为unknown而不重放，账本已记录unknown则持续blocked。启动读取账本可能追加recovered_unfinished终态，因此第2节必须在重启前保存原始现场。

当前没有设备账本人工解除或修复接口。即使核心已有resolution，也不能消除设备阻止。保持禁发，交付操作ID、核心执行/核查、账本intent/terminal/stop、服务实例、关闭证据和错误给后续恢复设计任务。
禁止删除/编辑ledger.jsonl、裁剪intent或unknown、换设备ID/账本目录、改用默认Fake或新DB来绕过。新隔离模拟实验须另立任务、明确不是原台站恢复，保留原阻止与证据。
此限制依赖操作纪律；当前没有账本缺失或完整防篡改检测，同用户可写文件者可以破坏记录。不能将上述禁令解释为技术上已阻止人为篡改。

## 5. 锁和guard残留

先冻结所有启动器、监视任务、手工启动及维护入口，确认不会并发新启动。查报错的**确切规范路径**，不要根据文件名猜锁归属。

- 锁内容有效且pid仍存在：检查同一OS中的命令行、启动时间和归属，定位持有者。拒绝清理；PID复用、权限不足等无法确认时也保留。
- 锁内容有效、持有者已退出且没有guard：下一次获取锁的daemon/维护进程会原子改名为stale证据，无需人工删锁。
- guard存在：guard无持有者元数据，邻近锁pid已死不足以证明没有另一获取者。必须确认所有使用该DB/账本/endpoint的进程和启动者都已停止；无法确认就保持阻止。
- 锁空/损坏：同样不能推断持有者已死，先查进程及现场，不能手工补写pid。

第2节证据完整、归属已确认、启动仍冻结后，人工将**仅确认为残留的guard或空/损坏锁**同盘改名到一个不存在的带时间戳隔离路径，记录原路径、新路径、依据、操作人及时间。不是删除整个运行目录；不要移动DB、WAL、设备账本或正常锁，也不要清理其他实例的Unix socket或Windows pipe锁。此步骤不自动化，不在本任务实际操作用户锁。

再次仅启动一个原配置实例，观察锁获取、恢复和状态；再次失败则保存新证据并停止，不循环移动锁。锁恢复成功不代表unknown解除或旧批准有效。

## 6. 存储故障

先停机并排查空间、权限、文件系统、完整性，按第2节保存证据。已有维护命令只处理核心Fake库：

```bash
node dist/apps/cwmaint.js clear-storage-fault --db <original-db> \
  --operator <operator-name> --note <actual-storage-review> --confirm-stopped
```

命令必须先成功生成独立备份才进入清除事务；事务会撤销全部批准、取消开放提案、将遗留running记为unknown、提升generation并追加维护审计。不清已有unknown或其他不明阻止原因，也不修复磁盘/损坏数据库/设备账本。锁、备份或完整性核查失败时停止。必要时inspect已知一致快照再restore到新路径；恢复版本必须兼容，Remote Fake原账本仍必须保留，不能用旧快照/new DB作为设备禁发绕过。

## 7. 收尾

核查原操作没有重发、原unknown保留、resolution/维护审计存在、旧批准失效、剩余阻止原因明确；记录进程/退出结果与证据位置。不用发一条测试消息证明恢复。
无法恢复的Remote Fake账本unknown记为“诊断完成，保持禁发，待设备核查接口设计”，不记“已恢复”。恢复规程的审查不替代实际故障演练或DSH交叉审议。
