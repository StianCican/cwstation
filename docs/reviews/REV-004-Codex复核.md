# REV-004：RemoteKeyer最终复核

日期2026-10-12。对象P2-002b v2；DSH报告REV-004-DSH-RemoteKeyer.md，Codex独立裁决。

## 发现与处置

- S1已修正：首版deadline在send后才开始，预检挂起和stop等待可越界。现在单个deadline覆盖全部异步阶段，预检迟到不得派发；新增回归通过。
- S1已修正：send异常/错误响应没有始终stop，stop同步异常可能逃逸。现在保守视为可能派发，尝试一次stop并立即unknown；停止证据不能追认旧unknown，异常捕获及回归通过。
- S1已修正：完成与abort竞争可能返回完成。现在该竞争unknown，核心状态改变/超时的原有锁定规则不变。
- S2已修正：恢复时核心代次固定0。Fake保存最高已接受核心代次、intent成功后更新并从账本恢复；三种代次不替代。非零/回退/恢复已验证。
- DSH F2/F3已修正：异步send失败不再写stop=not-requested，同步异常不再断言before dispatch。最终只改这两处detail，相关测试重新运行。
- DSH F1保留至生产入口接入前：Keyer.keyedCount本身可选，缺失符合现有接口；核心默认回退0存在歧义。不能把completed次数代替实际执行次数，也不能把RPC请求次数当实际键控数。当前默认daemon未使用RemoteKeyer，切片仅核心集成测试，批准此限定范围并明确status.keyedCount不支持、以账本为准。下一阶段在用户可见Remote入口启用前处理“未知/不支持”的状态表示，不能展示成零执行。
- 执行规范缺口：DSH首版使用过sed进行局部编辑，违反任务apply_patch约束；Codex已按备份逐项复核差异。初轮测试未提前保护logs诊断输出，后态副本不能补作前态；保留现场并在规范中补检查条款。此缺口不扩散为源码或用户数据库丢失证据。

## 审议证据与限制

DSH正常退出0，定点审议认为未发现S0/S1、七项修正成立，并明确未独立运行测试或验收Windows。
Codex最终Linux84/84、Windows原生编译50/50、类型/隔离编译退出0；命令和R01-R12详见docs/evidence/P2-002b-RemoteKeyer.md。
Windows复跑曾48/49，增加detail定位后30次复现2次正常采样未来拒绝。Codex限定20ms同机采样偏差，新增20/21ms边界回归，修正后定点30/30通过。DSH补充定点只读审议正常退出0，确认该修正未引入S0/S1；2秒时效与批准期限仍保留，生产时钟另验收。
DSH R07“单在途”由核心TxController和Fake服务共同保证，不应推广为适配器可替代核心授权；R08等未读范围由Codex结合现有P2-002a证据核对，未增加隔离承诺。

最终SHA-256：

```text
remote-keyer.ts d099f29c94d17686b5311dd02dda76df964c1f2f706cbba4c86d6c4320165f79
fake-service.ts 04350ee2d902ba2829fdaf7328329483e88a356d758b89eeef8fab63d0c793e8
test            9d5365e307e4b373a916155faf611956f5b1337e2c604dbc84cb496e3dbe8516
```

保护目录：/mnt/d/AI/project-backups/cwstation/20261012-000600-p2-002b/。
最终diff为新RemoteKeyer与测试、Fake核心代次局部修正、任务/审议/记忆及规范补充；core/contracts/apps/rig.sh/serial.ts未修改，生产dist未覆盖。

**裁决：P2-002b RemoteKeyer与既有核心的离线集成通过限定验收。**
无未解决S0/S1；F1及日志基线缺口按上述范围和行动明确处置。未完成项阻止用户可见生产入口、完整P2-002或真实写串口验收，不阻止继续离线开发。
