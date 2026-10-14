# P2-002a v2：Fake IPC 实现与验证

日期：2026-10-11。实现：DSH v1，Codex修正v2；最终审议另见REV-003。

## 范围与保护

新增packages/rig-control/src/{protocol,fake-service,client}.ts、apps/rig-faked.ts、tests/rig-control.test.ts。
仅受监督Fake子进程、私有stdin/stdout NDJSON和显式目录账本；不连接串口、不接core/daemon、不改变rig.sh。
模拟结果不代表电台发射或停止已验证。真实设备统一持有者与RemoteKeyer尚未实现。

项目无Git，修改前cp -a基线为：
`/mnt/d/AI/project-backups/cwstation/20261011-231732-p2-review-fixes/`。
该目录apps/packages/tests/docs/MEMORY.md/dist是任务开始前副本；根部rig-control/、rig-faked.ts、rig-control.test.ts是DSH v1交接后、Codex修改前副本，不能混同两组时间点。
任务文件收尾前另备份为同目录P2-002a-task-before-close.md。

## 检查点

1. 设计基线：P2-002 v3与REV-002-Codex复核，限定第一条Fake链路。
2. 第一条链路：DSH实现后测试挂起，Codex终止DSH及其测试进程并收回修改权。首版自报类型通过，未提交完整证据，不能作为验收。
3. 故障定位：独立timeout 25s运行退出124，9项通过、2项失败、1项取消。200ms握手超时后未清理子进程；测试解绑request失去this。
4. 修正：启动失败有界清理、握手独立5秒期限；运行时响应校验、16KiB行限与32普通请求/1控制槽；复用既有acquireLock；账本8MiB/10000条、短写循环、字段/摘要校验、重复/外来记录拒绝；请求频率核对Fake当前上下文；无停止证据能力如实声明；stdout背压与关闭期限。
5. 交付前：专项通过后DSH只读审议、Codex复核，结论以REV-003为准。

## 可复现验证

环境：WSL Linux、Node24.18.1，现有依赖，无安装操作。

```bash
cd /mnt/d/AI/projects/cwstation
timeout 40s node --import tsx --test tests/rig-control.test.ts
npx tsc --noEmit
```

最终修正后20/20通过，0失败/取消/跳过，专项退出0，约19.4秒；类型检查退出0。
包括正常完成/原帧、幂等重放/冲突、过期授权停止、unknown禁发、客户端超时不重发、SIGKILL重启恢复、token/内容拒绝、字节帧超限、关闭释放、频率不匹配、空/坏/存活锁保留、完成记录跨重启、损坏/重复/外来账本、模拟账本写失败、异常/超限子响应及过大账本。
补充历史CI-V地址变更后帧不变、断线许可代次变化；异常子响应明确验证PID不存在。大部分验证真实子进程和字节通道；响应校验有纯函数用例，断线代次有服务单元用例。账本全部使用临时目录并清理。

DSH定点复核后修正的代码已包含于上述20项运行：intent记录执行时civAddress、加载核对终态帧，查询优先用持久化帧；断线递增permissionGeneration并关闭会话；stop追加失败回unknown并保留ledger_fault。
账本schema1在未发布的实现期间新增civAddress，旧中间产物缺字段会禁发；不自动迁移或删除，当前测试临时账本已清理，没有生产账本迁移。正式分发前必须固定schema并设计迁移。

## R01-R12

| 项 | 状态 | 依据 |
|---|---|---|
| R01 | 通过（切片） | 新Fake链路，范围与未完成项明确 |
| R02 | 通过（切片） | 复用规划器、contentHash及锁，不改核心契约 |
| R03 | 通过（切片） | 协议/账本version1，未知版本拒绝；存储迁移未实现 |
| R04 | 通过（切片） | 请求与响应运行时校验、长度及账本限制 |
| R05 | 通过（Fake） | 单账本持有者、HMAC上下文绑定、稳定业务键；真机未验证 |
| R06 | 通过（Fake） | 模拟可靠证据才completed/cancelled，失联未决unknown |
| R07 | 通过（基本链路） | 关联/超时/幂等/重启验证；全并发故障矩阵未验证 |
| R08 | 通过（声明） | 私有继承流，同OS用户为信任边界，无对同用户任意shell的隔离保证 |
| R09 | 通过（所测范围） | 清理与坏账本、模拟写失败已测；真实磁盘终态fsync失败未覆盖 |
| R10 | 通过（切片） | 命令/失败记录与实际通过计数；Windows和编译入口未验证 |
| R11 | 通过 | 双时间点副本及逐目录diff，既有变化仅P2-001字符集及设计审议文档 |
| R12 | 通过（切片） | 明确实现/离线验收/真机未验收，最终审议独立记录 |

## 后续范围

P2-002b接RemoteKeyer与核心批准/撤销/unknown持久化，补完整IPC故障矩阵、Windows与编译入口。
stop终态/stop记录分别fsync失败、终态帧篡改和崩溃恢复时配置变更的专门用例仍待补齐，不能将基础20项当作完整故障矩阵。
Fake代次初始化0，未提供重连或真实上下文变化，不能把此客户端直接用于真实设备。
账本到限禁发；轮换/归档、迁移和长期历史索引另设计，不能删除账本后自动重放。
此次未构建Fake dist、不运行全量套件。真实串口迁移、控制线与发射命令需要独立验收。
