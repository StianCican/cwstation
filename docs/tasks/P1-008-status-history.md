# P1-008：只读状态历史与诊断记录

状态：已实现并完成离线模拟验证。

## 目标

为 `rig-statusd` 增加可回放的只读状态历史，不改变串口所有权、CI-V 命令边界或现有
发射 daemon。记录采用版本化 JSONL，便于后续 Julia/MWORKS 分析和故障复盘。

## 交付

- `RigStatusHistoryWriter`：串行追加写入，自动创建父目录，停止时等待队列刷盘。
- 记录事件：`service_start`、`snapshot`、`fault`、`reconnect`、`service_stop`。
- 每条记录包含 `schemaVersion: 1`、写入时间、事件名和完整 `RigStatusReport`。
- `rig-statusd --history <path>` 显式启用历史；`rig.sh` 默认写入
  `logs/rig-status-history.jsonl`。
- `cwrig history --file <path> --tail N` 读取并校验最近记录；读取上限为 8MiB 和 1000 条。
- 历史写入失败只保留诊断错误，不改变只读串口会话的安全状态。

## 边界

历史文件不承载写频率、模式、PTT、CW、SEND 或发射授权字段；当前不做数据库写入和跨进程
日志聚合。文件轮转、压缩和 Julia 分析输入适配作为后续任务。
