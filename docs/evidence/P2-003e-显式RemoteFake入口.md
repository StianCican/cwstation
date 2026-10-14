# P2-003e v1 离线实现与Codex复核

2026-10-13补审：DSH REV-006a正常交付，Codex复核见`docs/reviews/REV-006-Codex复核.md`。限定离线实现及已验证范围通过，下文“待DSH审议”保留为交付时历史状态。S3后续项：设备账本blocked与核心unknown分离的专项未覆盖；重复rig-endpoint参数处理不一致；Windows继承的外部Job仍可能强杀子进程；session.close自身无独立超时，依赖client RPC期限及宿主watchdog。未声称完整故障矩阵或硬件验收。

日期：2026-10-13。作者/实现/自查/复核：Codex。DSH交叉审议：未交付。
结论：离线实现和下列运行验证完成，待DSH交叉审议，不标最终验收。没有真实设备或射频验收。

## 保护与范围

非Git项目，修改前cp -a完整基线：
`/mnt/d/AI/project-backups/cwstation/20261012-2350-remote-fake-entry/`。
包含apps、packages、docs、tests、logs、dist、MEMORY.md、README.md；修正前态另存codex-v1/codex-v2。
新task、ADR、fake-session、专项测试和本证据创建前不存在。手工编辑使用apply_patch。
Linux/Windows测试仅临时隔离DB、账本、随机端点，未读取用户运行DB，未打开COM17。

最终diff -qr核对：既有apps仅daemon.ts；packages仅core/keyer与tx-controller、daemon/server、rig-control/client与remote-keyer，并新增fake-session；tests仅RawService编译入口修正及新增remote-fake-daemon。docs新增ADR/task/证据，README/MEMORY按入口与状态更新，dist为对应构建产物，logs为本任务证据。daemon/lock.ts与原基线完全相同。没有修改真实服务、serial白名单、rig.sh、Fake线协议或SQLite schema。

## 检查点记录

1. 开始前：读取项目入口、记忆、审议规范；确认仅离线授权和完整基线。
2. 设计定稿：task及ADR 0009确定显式入口、设备账本、授权观察与当前进程指标语义。
3. 第一条链路：新入口正常批准/发送/重复/关闭测试通过；校验fakeOnly、禁dev.state和无证据计数null。
4. 扩展修正：Windows编译RawService误用TS，局部修正入口；保留启动stderr并脱敏会话密钥。随后Windows重复崩溃发现Job强杀清理竞态，保留现场、定位、修正并重复复验。
5. 持久化/IPC接入：隔离DB/账本，启动持有DB及端点锁后才创建子进程；固定设备身份，无后台批准/重启/重发。
6. 交付前：复核最终diff、SHA-256、两平台结果及进程；沉淀文档和记忆，DSH未交付如实保留待审议。

## R01-R12

| 标准 | Codex结果 | 依据与限制 |
|---|---|---|
| R01 | 通过 | 实现已批准的显式Remote Fake、监督、批准预检、指标；全程离线 |
| R02 | 通过 | CLI/daemon持有核心，RemoteKeyer执行，session只观察；符合ADR 0009及既有设备设计 |
| R03 | 通过 | 默认数值响应保持，新后端keyedCount可null；可选version1模拟指标；线协议/DB schema无变更 |
| R04 | 通过 | validateResponse与既有上下文/字符/长度检查复用；启动诊断有界且会话密钥脱敏 |
| R05 | 通过 | DB/端点/设备账本单持有者；核心一次批准，发送前二次预检；重复/重启无重放 |
| R06 | 通过 | 只有关联证据记完成/停止；失联/timeout为unknown并阻止；强杀/未确认关闭非零 |
| R07 | 通过 | refresh合并及close丢弃晚到；request失败通知；既有IPC关联及迟到门禁回归通过 |
| R08 | 通过 | 私有子进程NDJSON，fakeOnly；无raw.write/串口；不声称隔离同用户恶意进程 |
| R09 | 通过 | 有界停止/子进程退出；Windows父死修正后30/30；锁不明仍拒绝人工检查 |
| R10 | 通过（限定范围） | 下列实际两平台离线测试；未覆盖全部故障矩阵或真实设备 |
| R11 | 通过 | 完整cp -a基线、修正前副本、失败现场、最终差异与哈希 |
| R12 | 问题/待补审 | DSH多次SSE失败没有有效交叉审议；本任务及P2-003d不标最终验收 |

## 发现与修正

- S1，已修正：Windows父死触发libuv默认Job的KILL_ON_JOB_CLOSE，子进程收到EOF开始释放锁后可能被强杀，导致guard残留。增加rmSync重试没有解决；恢复原锁代码。FakeRigClient.launch仅Windows detached=true，使子进程不加入宿主默认Job；仍保持ChildProcess引用、私有stdio、无unref、宿主等待/超时强杀。Linux不改变spawn语义。子进程靠私有管道断开本地禁发/刷盘/退出。参考libuv `src/win/process.c` 的uv__init_global_job_handle注释和Job配置；本次环境Node Windows24.16.0。定位时trace在guard-acquired后中断，未到lock-release-read，支持强制终止而非删除失败。
- S2，已修正：编译测试RawService硬编码TS导致Windows误用Linux esbuild；按测试运行类型选择.js并去掉tsx。真实产品daemon也显式传同类型rig-faked入口。
- S2，已修正：远程入口核心关闭/审批撤销/数据库刷盘异常可能仍exit0；这些catch在Remote Fake模式设置exit1，关闭确认仅指设备响应加子进程exit0，未确认/强杀/失联均exit1。
- S2，未完成：DSH交叉审议通道多次STREAM_CLOSED。由Codex负责恢复通道后补审，不以自查或测试冒充DSH报告。

## 验证命令与结果

Linux Node24.18.1，Windows原生Node24.16.0。构建命令`npm run build`最终退出0。
源码用`node --import tsx --test --test-timeout=60000`，编译用`node --test --test-timeout=60000`。
套件：remote-fake-daemon、approval-gate、controller、daemon、resolution、remote-keyer、rig-control；编译闭环另加lock。
Windows根目录用`--test-concurrency=1`运行前五项及lock；RemoteKeyer/rig-control在仅dist+package.json的windows-stage-v3副本运行，避免旧默认client优先TS。副本位于本基线目录，不作为最终源码真源。

| 日志 | 退出/结果 |
|---|---|
| P2-003e-linux-closure-corrected.log | 0，148/148 |
| P2-003e-linux-built-closure.log | 0，153/153，含lock5项 |
| P2-003e-windows-closure.log | 0，108通过，2项Unix目录/socket权限按平台跳过 |
| P2-003e-windows-ipc-closure.log | 0，43/43 |
| P2-003e-windows-parent-fixed.log | 0，单独parent crash测试循环30次，FAILURES=0 |
| P2-003e-linux-shutdown-final.log | 0，最后关闭退出码修正后7/7 |
| P2-003e-windows-shutdown-final.log | 0，最后关闭退出码修正后7/7 |
| P2-003e-dsh-final-review.log | 1，STREAM_CLOSED，无报告 |

7项新入口测试覆盖：显式跨进程完成及重复、非法字符零intent/禁dev.state/指标、正常关闭；空闲子死撤销且无自动重启；父死子退及同账本重启零重放；timeout无停止证据unknown/设备blocked；参数互斥启动前拒绝；在途子死unknown；可靠停止cancelled。既有套件覆盖核心授权、迟到RPC零副作用、持久化和IPC失败。不是完整硬件故障矩阵。

保留早期失败日志：Windows首轮混合回归101通过2失败2跳过（旧长连接与父死重启）；顺序复验103通过2跳过。独立IPC初轮41通过2失败，修正后43通过。父死循环10次2失败；删除重试后20次4失败；现场保留循环20次3失败、跟踪循环20次4失败。修正后30次全过。这些日志均保留，不用复验覆盖首次失败。
一次Linux命令误写tx-controller.test.ts，记录于P2-003e-linux-closure.log；它没有覆盖controller套件，已用上述corrected全套重跑，不引用为完整回归。

40个父死定位临时目录已cp -a保存在基线的`parent-crash-evidence/`（包括失败及成功现场），其中rf-parent-YVpeEu与rf-parent-PsBvxe保留锁释放中断trace。测试可用`CWSTATION_PRESERVE_TEST_EVIDENCE=1`显式保留父死临时目录；最终产品无trace代码或新增诊断环境入口。

## 最终对象SHA-256

```text
5edbeb676e0124e4ac937fa1e0c5f7ce296ade1e226ce7899e79362bc39486c9 apps/daemon.ts
29363681622ce06830e31b68697f3e8d29cc8864a8433747a3b32a602331b5a9 packages/core/src/keyer.ts
d40ec128a16fca8817d14c30782cc93ffd27239494aba533c1dc0c580b837105 packages/core/src/tx-controller.ts
e0c4626989d6a6882b89f5d83357d5f17f99b699304ffd1d6e82ce187fc313d0 packages/daemon/src/server.ts
62462307332e432fba4beb02bd28473ae90817d9e6952eba11bad6ecd1a4fa8e packages/rig-control/src/client.ts
affd73e971595ddcc644831c4c5f65b653fd64f4df0482ab5494887c1dac3141 packages/rig-control/src/fake-session.ts
2eb745645a133e724e6bff727224491318247597f58b2c0b3e71bf823862b749 packages/rig-control/src/remote-keyer.ts
ff8bc68f065fcc5620cb3a80774d287c0af7987088a0754285a6e10d2b733e84 tests/remote-fake-daemon.test.ts
0779ef2f83e54346d1eaa42690f7d89d54550c19347d63967b77fbce03da6e46 tests/rig-control.test.ts
```

最终进程检查：Linux `ps -eo pid,comm,args`匹配cwstation仅命中检查命令本身；Windows Get-CimInstance筛选node.exe并匹配cwstation/windows-stage-v3/rig-faked无结果。所有本轮工具会话已结束。

## 限制与下一步

没有打开真实发送，没有验证真实CW/PTT/停止/射频。任意子进程强杀发生在锁临界区仍可能保留guard，设计继续拒绝不明锁，不声称任意崩溃均可自动恢复。不能通过换设备ID/删除账本解除unknown。当前执行指标不重构历史或推断实际射频。
Windows detached子进程正常/EOF退出已测，操作系统崩溃、外部继承stdio阻止EOF或恶意同用户进程不在本次验证范围。
先补DSH交叉审议，再规划恢复操作及真实适配器，实际发送另需设计与现场验收。
