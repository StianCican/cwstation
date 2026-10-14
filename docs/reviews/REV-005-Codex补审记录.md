# REV-005 v1 补审与Codex文档复核

日期：2026-10-13。对象：P2-003d/P2-003e待补审范围及P2-004恢复规程。
作者：Codex。DSH：没有交付，不能作为通过审议。

## 实际调用

已确认`/home/li0214/.nvm/versions/node/v24.18.1/bin/dsh`和`/home/li0214/.dsh`，项目工作目录`/mnt/d/AI/projects/cwstation`。
以`DSH_HOME=/home/li0214/.dsh dsh --profile headless`调用两次，只读、禁止修改/测试/build/设备/凭据；输出分别保留`logs/REV-005a-dsh-review.log`和`logs/REV-005b-dsh-review.log`。

- REV-005a：缩小为fake-session及daemon整合，审批撤销/持久化故障/有界停止，要求带文件行号发现及R01-R12。
- REV-005b：恢复规程对照核心resolveUnknown、锁和设备恢复实现，以及P2-003d离线证据范围。

两次均退出1，唯一结果`STREAM_CLOSED: SSE stream ended without [DONE]`，没有报告或修改。没有检查凭据，也没有改动DSH配置、工具或协作平台。范围缩小未恢复通道，继续补审需要另行诊断Harness流失败。

## Codex独立核对

恢复规程SHA-256：`b9687b35fef99589f4d16e2f242d5502355172b289ba5e3a9c5c7fde421cac5e`。

| 规程主张 | 对应源码/已有证据 |
|---|---|
| CLI全局socket参数、只读诊断、stop/abort | apps/cwctl.ts parseGlobal及run分支；stop注释说明accepted不等于exited |
| 核心解除只处理启动恢复时unknown、须连接/无在途/无故障 | packages/core/src/tx-controller.ts resolveUnknown，eligibleUnknownIds/recovered/faultLatch/backendConnected检查 |
| 解除追加resolution/撤销授权/提升代次，原unknown不改写 | 同方法journal.transaction；历史终态幂等见P2-003e测试 |
| 设备账本未完成intent恢复为unknown、不重放 | packages/rig-control/src/fake-service.ts recoverUnfinished |
| 设备blocked导致核心断开并拒绝解除 | fake-session.ts read的backendConnected:!caps.blocked；resolveUnknown拒绝断开 |
| 已死有效锁由程序原子改名stale；guard/坏锁不自动清理 | packages/daemon/src/lock.ts acquireLock/acquireGuard |
| backup/inspect/restore/clear-storage-fault是既有命令 | apps/cwmaint.ts严格解析、packages/maintenance/src/index.ts及README既有规范 |

规程要求启动冻结、进程归属确认、完整备份后才人工隔离确认残留的guard/坏锁，不提供批量删除或自动恢复命令；设备unknown继续禁发。没有发现规程与上述源码不符的事项。该结论仅为Codex静态复核，不是恢复演练、DSH交叉审议或硬件验收。

结论：P2-004文档完成、Codex复核完成；DSH补审未完成。P2-003d/P2-003e保留待交叉审议，暂不进入真实发送实施。
