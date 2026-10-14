# P1-009 Julia/MWORKS 历史离线分析证据

日期：2026-10-11。

## 验证

- 使用模拟 `rig-statusd` 生成 schema-1 JSONL：6 条记录（启动、4 条快照、停止）。
- Windows MWORKS launcher：

  `C:\Users\Public\TongYuan\julia-1.10.10\bin\julia-ty.bat D:\AI\projects\cwstation\julia\analyze_history.jl <history> <analysis.json>`

  退出码 0，Julia `1.10.10+4`，JSON3 `1.14.3`。
- 输出摘要：`recordCount=6`、`snapshotCount=5`、`eventCounts={service_start:1,snapshot:4,service_stop:1}`、
  `modeCounts={CW:5}`、`frequencyChangeCount=0`、`modeChangeCount=0`、最大快照间隔约 `0.079s`。
- 输出输入字节数 `2271` 与 SHA-256
  `33d48a879cef54da4d0c06dab335b1ac11e29752c4939c33fa37026a0feeae30` 一致，
  `executionControl.transmits=false`。
- 首次运行发现该 MWORKS Julia 版本的 `mktemp` 不接受 `prefix` 关键字，已改用兼容接口后复验通过；
  不影响历史协议或计算结果。

本轮未连接 COM17，未调用状态服务实时端点。保护备份：
`/mnt/d/AI/project-backups/cwstation/20261011-p1-009-julia-history/`。

## 真实 COM17 历史验证（2026-10-11）

- Windows 原生 `rig-statusd` 以 `COM17/19200` 运行约 48 秒，生成项目历史文件
  `logs/rig-status-history.jsonl`；状态服务返回 `ready`，只读快照为 `14176000 Hz / USB / FIL2`。
- 历史含 48 条记录，其中 47 条快照；Julia 分析退出码 0，最大快照间隔约 `1.036s`，
  `frequencyChangeCount=0`、`modeChangeCount=0`、`transmits=false`。本次未操作电台设置或发射。
- 该次采集用强制结束回收进程，故历史没有 `service_stop` 事件；已修正 `rig.sh` Windows 清理为
  先优雅停止并等待 5 秒，超时才强制结束，后续会保留正常停止记录。
- 真实历史输入 SHA-256：`fe87b1ad71536183c06a11b896a2d230c009230ecc38e1c1dc465926f502b32f`。
- 本次运行备份：`/mnt/d/AI/project-backups/cwstation/20261011-real-history-validation/`；
  Windows 清理修正备份：`/mnt/d/AI/project-backups/cwstation/20261011-graceful-history-shutdown/`。
