# P2-003b v1 rig.sh统一启动与监督

状态：已实现、DSH静态审议和Codex复核/构建完成；用户确认指定三项真机人工验收通过，完整故障矩阵仍待验证。用户授权更新bash rig.sh，实现设备服务/监视台生命周期，随后通知用户手动旋钮及USB测试。
Codex设计与复核，DSH实现与静态自查；修改权交给DSH至退出。

## 基线及范围

非Git，cp -a完整基线已建立：/mnt/d/AI/project-backups/cwstation/20261012-rig-supervision/，含apps/packages/docs/tests/logs/dist/rig.sh/MEMORY及编译配置。
允许修改rig.sh、apps/rig-statusd.ts、apps/rig-service-monitor.ts，新增apps/rig-launch.ts及docs/evidence/P2-003b-rig启动监督.md。必要时apps/rig-controld.ts可局部修改。Codex复核后局部扩大：新增scripts/rig-launch-windows.ps1传递Windows参数，修正packages/rig-status/src/service.ts的关闭等待与关闭失败保留；两者均在统一启动/关闭的已授权范围，原文件基线已保护，新脚本原先不存在。不得改serial.ts、core/contracts、公共设备RPC白名单、SQLite、Fake发送协议。不得打开真实串口、运行测试或新增测试，MEMORY交Codex更新。可tsc --noEmit，不能生成dist（Codex之后构建）。
全部手动写入必须apply_patch。Harness若无工具，可用shell命令/home/li0214/.codex/tmp/arg0/codex-arg0JyeNZH/apply_patch；不可用则反馈，不用edit/write替代。

## 设计

新增TS宿主rig-launch（同进程宿主不打开串口），显式调用已有参数解析器验证服务参数。只启动编译后rig-controld，私有fork IPC；stdout/stderr必须持续消费，有界诊断缓存（例如8KiB），需要落盘时显式保留文件，不删除已有历史。服务未建立IPC端点前不启动监视台；启动总期限10秒，错误/版本/意外退出均有界失败，不自动启动重试。

rig-statusd的main可增加可选监督参数（默认旧模式不变），或在已有process.send通道时启用监督：服务经私有进程IPC发送{version:1,event:"listening"}（端点就绪）和初读完成ready（可带失败状态）。宿主至少等初读完成再启动监视台，避免旧monitor初始化reconnect与service.start竞争。

宿主发{version:1,command:"shutdown"}请求服务关闭；该消息只允许继承IPC，绝不扩展公开status/watch/reconnect端点。service关闭串口、IPC/history后发送{version:1,event:"stopped",released:boolean,error?:string}并disconnect，让子进程结束。关闭失败必须released:false、诊断保留及非零退出。父IPC断开同样执行关闭。旧SIGINT/SIGTERM关闭路径同样处理并明确错误，不能吞掉关闭失败报告成功。shutdown必须幂等，错误不能阻止done结束；挂起由宿主期限处理。服务启动/关闭竞态不允许发虚假ready/stopped。

宿主启动cwrig monitor --endpoint <相同端点>，stdin/out/err继承控制台。Windows由rig.sh通过PowerShell Start-Process启动一个交互式rig-launch窗口，-Wait取exit code；Linux直接exec node rig-launch。所有路径和端口参数需要正确引用，Windows含空格项目路径可用，保持CWSTATION_PORT和--simulate；无长命令字符串拼接。不用cmd执行用户参数。rig.sh检查编译入口及Windows bridge，停止旧的直接启动rig-statusd逻辑；不要删除固定socket或别人的日志。

宿主观察service异常exit/disconnect/error：记录诊断与失败退出状态，但监视台继续展示故障（现有轮询已fault/灰色），不重启服务、不补发、不另开串口。服务故障后用户退出界面，宿主返回失败。monitor退出或宿主SIGINT/SIGTERM时请求shutdown，等待stopped与进程退出（上限5秒），超时定向强杀自家进程树（Windows含CwPipeBridge），等退出最多2秒。强杀/缺stopped/关闭失败均报告“关闭未确认”、非零；不能宣布已释放。进程已正常退出仍必须检查stopped证据，而非exit0当释放证据。

宿主异常退出时service继承IPC断开须自动关闭；正常退出不留下timer/listener/子进程。monitor响应SIGINT/SIGTERM并恢复rawMode/终端；其connect和finish竞态不能留下客户端/连接，C连击不得启动并发reconnect。初始连接只请求status；用户C才显式reconnect。stop/finish后tick不得再挂timer，关闭中状态不能被晚到回复更新。无需改界面布局。

## 审议与交付

按任务自查规范记录设计、首条链路未运行（本轮不测试）、实现diff、R01-R12和源码hash。静态自查重点父死子退、启动失败、端点争用、monitor先退、service先死、shutdown失联/失败/超时、rawmode/定时器与Windows引用。重大设计/公共接口扩大先反馈。提交准确的“实现待运行验收”；不声称通过真机/平台测试。完成后退出，Codex复核。
