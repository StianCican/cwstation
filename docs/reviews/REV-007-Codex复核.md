# REV-007 P2-006 v3 Codex复核

日期：2026-10-14。DSH执行/交叉审议，Codex设计与复核。原始报告保存于logs/P2-006-dsh-execution-review.log、P2-006-dsh-final-recheck.log、P2-006-dsh-v3-recheck.log；三次有效调用均exit0，无编辑/设备/凭据操作。采用原headless profile，仅子进程排除代理。首轮源码48/48由DSH实际执行；其后定点报告为只读审议，未冒称复跑。

Codex独立核对最终测试/脚本SHA256与DSH最后报告一致：c93ed151… / 5f446695…。源码48/48、Windows最后remote8/8、CLI-v5 exit0/零重放，日志及完整哈希见P2-006 evidence。产品apps/packages无差异、dist仅测试变化。没有真实电台或发射。

## 发现及处置

- 首轮测试重复关闭数据库导致挂起：已修正firstClosed、提前注册hook、嵌套finally，首服务与第二服务均断言closeReport.confirmed。保留首轮日志与现场，明确清理本轮旧进程。
- 核心unknown与设备blocked混淆：新增空核心unresolved=0、device blocked错误、无approval/send、断开时核心解除拒绝、原账本全文不变与operationGet unknown断言，关闭REV-006a-F1覆盖缺口。
- CLI恢复产物/guard/计数证据：已补readOnly恢复库unknown及有效批准0；guard存在/隔离后不存在与quarantined存在；测得keyedCount=0。DSH最后未发现S0/S1/S2行为缺陷。
- DSH首轮R12缺交付文档的S2：报告发生于编写过程，当前任务/evidence/记忆/本复核完整，处置完成。不是产品执行缺陷。
- S3保留：首阶段早失败时保留/tmp目录，尚无统一自动归档hook；本轮失败目录已复制到D盘基线，不残留进程。由Codex下次测试维护处理，不以“目录干净”掩盖现场。
- S3保留：restore产物只有只读SQL核查，没有启动该恢复库；演练实际启动的是原DB的崩溃恢复。结论仅覆盖前者内容核查与后者重启，不宣称新库切换启动验收。
- S3保留：Windows CLI完整演练、实际外部进程归属判断/冻结、真实磁盘故障、Remote Fake设备账本解除和射频均未验证；无技术防篡改承诺。clear-storage-fault持锁拒绝还缺独立用例。
- 日志版本绑定：本轮结果与测试/脚本SHA保存在最终evidence，不要求修改既有日志头；v1/v2和失败日志完整保留。DSH首轮声称/tmp无残留不成立（保留首轮失败现场），Codex采用实际进程检查与明确产物记录，不照抄该句话。

## 验收边界

R01/R02/R04/R05/R06/R07/R10/R11/R12在P2-006证据的限定范围通过；R03无接口/schema变更不适用；R08未新增权限验证；R09只对具体Fake步骤通过，完整人工规程/磁盘故障未验证。没有未解决S0/S1，S3有明确处置和负责人。

Codex裁决：设备账本禁发隔离专项验收通过；Linux Fake具体CLI演练（保存现场、一致备份/inspect、restore文件核查、原DB恢复/解除、合成guard隔离再获取）验收通过。并非整套人工恢复规程、Windows演练或真机验收。P2-006限定范围完成。

下一阶段可以形成真实IC-7300发送适配器的设计稿，先明确唯一设备持有者、能力与完成/停止证据，再交DSH设计审议；实际写命令和现场发射另行授权与验证。
