# P1-008 只读状态历史与诊断记录证据

日期：2026-10-11。

## 验证

- `npm run build`：通过。
- 模拟服务命令：

  `node dist/apps/rig-statusd.js --endpoint /tmp/<socket> --simulate --interval-ms 50 --history /tmp/<history>.jsonl`

  生成顺序正确的 `service_start`、多个 `snapshot` 和 `service_stop` 记录；每条记录为
  `schemaVersion:1`，包含 `readOnly:true` 和完整模拟快照。
- `node dist/apps/cwrig.js history --file /tmp/<history>.jsonl --tail 3`：返回
  `ok:true` 及最近三条合法记录。
- 历史读取会拒绝空路径、非法 tail、超过 8MiB 文件和版本/事件/report 结构错误。

## 真实设备边界

本轮没有重新打开 COM17；P1-007 已完成真实只读服务、频率跟随、模式跟随、USB 重连和退出释放验收。
P1-008 仅增加诊断记录，不增加任何电台写操作。

保护备份：`/mnt/d/AI/project-backups/cwstation/20261011-p1-008-history/`。
