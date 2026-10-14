# P2-001：IC-7300 CW 报文干运行

状态：已完成（2026-10-11）

## 目标

为 IC-7300 真实发射适配器建立第一条可验证的离线边界：能够根据文本生成 CI-V `0x17` CW 报文，能够生成 `0xFF` 停止规划，但绝不打开串口或写入 COM17。

## 实现

- `packages/devices/src/civ-tx-plan.ts`
  - 默认使用 IC-7300 `0x94` / 控制端 `0xE0`。
  - 限制为可打印单字节 ASCII，最多 30 字节。
  - 支持消息规划和停止规划。
  - 结果带 `dryRun: true`、`executable: false`，帧字节和 payload 均冻结。
- `apps/cwrig.ts`
  - 新增 `cwrig tx --dry-run --text <ASCII>`。
  - 新增 `cwrig tx --dry-run --stop`。
  - 缺少 `--dry-run` 或同时指定消息/停止均拒绝。
- `tests/civ-tx-plan.test.ts`
  - 精确帧、停止字节、字符/长度校验和 CLI 边界。

## 安全边界

- 未修改 `packages/devices/src/serial.ts` 的只读白名单。
- 没有真实串口、PTT、SEND、DTR/RTS、CAT 写入或射频验收。
- 本任务不证明 IC-7300 已接受报文、消息已完成或已停止。

## 验收

```text
npm run build
node --import tsx --test tests/civ-tx-plan.test.ts
node --import tsx apps/cwrig.ts tx --dry-run --text "CQ TEST"
node --import tsx apps/cwrig.ts tx --dry-run --stop
```

备份基线：`/mnt/d/AI/project-backups/cwstation/20261011-p2-tx-dry-run-baseline/`。
