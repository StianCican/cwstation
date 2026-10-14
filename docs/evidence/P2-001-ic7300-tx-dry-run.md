# P2-001 证据：IC-7300 CW 报文干运行

日期：2026-10-11

## 结果

- `npm run build`：通过。
- `node --import tsx --test tests/civ-tx-plan.test.ts`：4/4 通过。
- `npm test`：240 项，232 通过，8 项 Windows 专项按环境跳过，0 失败。
- `node --import tsx apps/cwrig.ts tx --dry-run --text "CQ TEST"`：输出
  `fe fe 94 e0 17 43 51 20 54 45 53 54 fd`，并标记
  `dryRun:true`、`executable:false`。
- `node --import tsx apps/cwrig.ts tx --dry-run --stop`：输出
  `fe fe 94 e0 17 ff fd`，并标记 `dryRun:true`、`executable:false`。
- `node --import tsx apps/cwrig.ts tx --text "CQ TEST"`：以 usage 错误拒绝，
  明确提示真实发射尚未实现。

## 差异检查

- `packages/devices/src/serial.ts` 与 `packages/devices/src/civ.ts` 与修改前备份逐字节一致。
- 没有打开 COM17，没有调用真实串口，没有发送 `0x17`、`0xff`、PTT、SEND 或 DTR/RTS 控制。
- 没有启动 daemon，也没有留下设备服务进程。

## 基线

无 Git 仓库。本轮修改前备份位于：
`/mnt/d/AI/project-backups/cwstation/20261011-p2-tx-dry-run-baseline/`。
