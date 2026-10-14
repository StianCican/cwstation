# P2-003b v1 实现与静态审议

日期2026-10-12。DSH初稿实现、DSH最终只读审议，Codex设计/接手修正/独立复核。
结论：实现、类型检查、Bash/PowerShell语法检查与构建完成，可进入人工运行验收。未运行自动测试，未启动新宿主或访问COM17；本轮不宣称真机或跨平台运行通过。

## 范围与实现

- rig.sh保持同一命令与--simulate/CWSTATION_PORT，Windows/WSL用PowerShell -File脚本传参，Linux exec编译宿主。Windows使用仅当前PowerShell进程的ExecutionPolicy Bypass运行本地脚本，不修改用户/机器策略。路径通过WorkingDirectory传递，COM端口单独校验，history采用相对路径。
- 新rig-launch先验证服务参数，再fork编译rig-controld；等待端点与初读完成，10秒启动期限，无自动重启。仅设备服务打开串口。
- 设备服务监听继承IPC关闭命令与父失联；关闭等待启动/重连完成、关闭串口/公开IPC/history，发送stopped及released，宿主同时等待退出码0。共享公开RPC方法仍为status/watch/reconnect。
- 关闭未确认保留为不可重新打开的故障，重复stop也不能清除该结论。晚到的取消open关闭失败会保留错误。
- 监视台经fork继承终端及私有IPC，初始只读status，C才reconnect；连击C不并发。宿主服务失联主动通知FAULT，即使P暂停轮询仍生效。父失联/退出命令恢复rawmode、暂停stdin、关闭客户端、退出IPC。
- Q/正常监视台退出后宿主请求设备关闭，5秒等待；随后必要时定向强杀自家树。taskkill先等待，再fallback；没有确认或强杀均非零及诊断保留。monitor关闭同样有5秒等待与强杀后等待期限。
- 宿主持续消费stdout/stderr，最多8192字符缓存；异常诊断追加logs/rig-launch-diagnostics.jsonl，不删除旧日志/socket。关闭未确认退出3，其他失败非零；服务故障和关闭未确认可以同时成立。

当前不接核心批准管理或RemoteKeyer/Fake发送，不改变serial白名单，不开放真实CW/PTT。

## 保护与检查点

无Git。修改前cp -a完整基线：`/mnt/d/AI/project-backups/cwstation/20261012-rig-supervision/`，包含apps/packages/docs/tests/logs/dist/rig.sh/MEMORY及编译配置。README修改前副本rig-readme-before.md，DSH初稿交接副本dsh-handoff。
新增apps/rig-launch.ts、scripts/rig-launch-windows.ps1、任务及本证据原先不存在。最终diff只含上述源码、rig-status服务关闭路径、README、任务/证据、记忆与对应dist；tests、既有logs、serial.ts、核心/DB/Fake源码未改。

1. 设计检查：复用旧参数校验/设备持有者/受保护端点；私有父子IPC不新增公开关闭权限。明确窗口由用户随后启动。
2. DSH实施：使用指定apply_patch命令；生成初稿并修正类型错误，报告tsc通过。Codex在完整自查证据生成前结束该执行并接手，Harness返回0但无完整证据文件，不算完整交付。
3. Codex接手：保护初稿，修正Windows参数传递、send回调、启动/关闭竞态、关闭失败保留、monitor父失联与主动故障通知、stdin/终端清理、taskkill等待与宿主异常收尾。
4. 范围扩大：增加Windows脚本及共享服务局部关闭修正，仍在已授权统一启动/关闭任务内；已更新任务边界，基线完整。未修改公共契约。
5. 第一条运行链路尚未执行；未启动界面或真机。不能用静态检查代替该检查点。
6. DSH最终只读审议退出0；提出五项S2候选和运行证据缺口。Codex裁决如下，最后局部修正由Codex检查diff与编译。

## DSH发现与裁决

| 发现 | Codex处置 |
|---|---|
| 典型服务崩溃优先返回close_unconfirmed(3)，非service_fault(1) | 保留非零关闭未确认优先级，符合任务未确认不能报告已释放；改诊断同时记录serviceFault与释放未知，避免丢失原因 |
| fork未启动无exit，空等5+2秒 | 修正error且pid不存在时立即结算退出等待；仍返回启动失败 |
| Windows模拟要求CwPipeBridge | 不成立：模拟串口仍使用Windows受保护命名管道，桥接是IPC依赖；保持检查 |
| WSL透传Linux端口路径会被COM校验拒绝 | 预期平台参数不同，不自动把/dev/ttyUSB0映射未知COM；README明确Windows/WSL须COM名称 |
| fault/finish不复位busy/connecting | 保留单在途保护；当前请求有既有客户端期限，finally复位，generation阻止迟到更新；退出会关闭客户端。运行竞态待验证，不因关闭时强行清busy而允许并发 |

DSH未发现S0，未报告明确S1。其审议时未完整读取releaseSession/native；Codex补读关闭路径及Windows桥接的FIRST_PIPE_INSTANCE，确认静态调用关系。DSH提到的1.5秒monitor期限已改为5秒。正常退出、父崩溃、端点争用、管道归一化、WSL TTY、Windows进程树、串口释放仍无本轮运行证据。

## 静态验证

Linux Node24工具链：`npx tsc --noEmit`多轮退出0，`npm run build`最终退出0；`bash -n rig.sh`退出0。
Windows PowerShell原生Parser.ParseFile检查scripts/rig-launch-windows.ps1，无语法错误，退出0。
以上未启动脚本业务或执行测试；构建已更新实际项目dist，但没有启动新运行进程，因此不称策略已运行。

源码SHA-256：

```text
a97d9c06fa13dd5708828418a0e304da06c8061fd0f8abfc1b7fa22e7486a794 rig.sh
c60d415f8ec51ec64ac396100f9faafc7abcebf326c5a157d5e76a03b81209d5 scripts/rig-launch-windows.ps1
5a18b3d50b89ab42fbed526b19f4508b77c991c77485ab7b49e1930141ac9855 apps/rig-launch.ts
2b8f88794f1f553b53dc8402833d983440f873ab5f7567b06825cbd2ebdae1ba apps/rig-statusd.ts
b9f15860cadece0b88d85783d155f4b3bb9dc26edc2b0bffc193690ae6f238e5 apps/rig-service-monitor.ts
15a92ddc12421fe92ef343ef8bfc44a46c0bf853bb8119c4512fe25a5d5fbad8 packages/rig-status/src/service.ts
```

## R01-R12

| 标准 | 结果 |
|---|---|
| R01 | 静态通过：统一bash入口及只读监督，完整授权撤销后续 |
| R02 | 静态通过：宿主不打开串口，复用旧服务/IPC/适配器 |
| R03 | 静态通过：私有版本1消息、旧独立入口兼容、无DB迁移 |
| R04 | 部分通过：旧参数校验、Windows COM校验、端点/版本核对；故障运行矩阵待验 |
| R05 | 静态通过：一个fork设备持有者；真实独占争用待验 |
| R06 | 静态通过：释放证据与退出分开，失败不清除、不自动恢复 |
| R07 | 未运行验证：有界启动/停止/私有IPC路径已实现 |
| R08 | 静态通过：沿用受保护端点、私有shutdown；Windows ACL未重测 |
| R09 | 部分通过：备份与错误保留，实际资源清理/父死子退待验 |
| R10 | 部分通过：类型/语法/构建；未运行自动测试或真机 |
| R11 | 通过：基线/交接副本/最终diff范围核对 |
| R12 | 通过：实现与运行验收分开记录 |

## 人工验收

项目目录运行bash rig.sh，保持原USB SEND/CW/RTTY映射OFF。观察READY，旋钮改频率/模式，拔USB后应STALE/FAULT，插回按C恢复，Q退出后再次启动应能连接。暂停P状态下设备服务崩溃、启动/关闭挂起等故障用离线后续专项覆盖；本任务不以真机强杀来替代全故障矩阵。

### 用户后续反馈与限定验收

2026-10-12，用户在收到上述三项操作步骤后回复“全部通过”。因此记录：

1. 旋钮频率及模式变化，界面同步：用户确认通过。
2. USB拔插，插回按C恢复连接：用户确认通过。
3. Q退出后再次运行bash rig.sh可重新连接：用户确认通过。

来源是用户人工观察；Codex本次没有独立采集运行日志、频率数值、加载hash或退出时的OS句柄证据。不将可重新连接扩大为所有清理细节均已独立核验。限定三项人工验收通过；服务崩溃/父失联、暂停时故障通知、启动/关闭超时、关闭失败保留、跨平台故障矩阵仍未验证。原静态阶段记录保持为历史，不将其未执行说明解释为用户未测试。

本次仅更新任务、证据和记忆；修改前cp -a基线：`/mnt/d/AI/project-backups/cwstation/20261012-p2-003b-user-acceptance/`。差异仅人工反馈及限定验收状态，不改源码或运行设备。
