# P2-017A Fake 读取超时修正 v1

日期：2026-10-20。作者、实施与复核：Codex，沿用ADR-019用户明确授权的本次Fake流程例外，非DSH独立审议。结论：本次局部Fake离线修正通过，完整P2-017/P2-018与真实设备仍不在本次验收范围。

## 范围与保护

起点为干净main、e08c829。源码仅修改 `packages/device-operation/src/fake-service.ts` 与 `tests/device-operation.test.ts`；更新任务、记忆并新增本报告。公共schema、存储格式、旧入口、生产账本、SQLite及真实串口均未修改。

修改前建立 `.local-backups/20261020-fake-read-scheduling/before.bundle`，完整历史校验exit0；忽略产物dist及logs保存至同目录 `outputs-before.tar`，归档结束后独立tar比较exit0，再编辑和构建。新报告创建前不存在；测试夹具使用系统临时目录。Git提交保护源码/文档，tar保护本次构建与测试涉及的既有产物。未清理用户文件。

复核对象SHA256：

- fake-service.ts：`cf3003e9d8e7cee31df0e32a6f410016ecb06d5a7cb0dce69857ed5253729729`
- device-operation.test.ts：`387f8d803fd76c8f5fa203d193ce1c0e6fe42757ede9f98ab5355f3b0ca6390b`

## 发现与修正

1. S2，refresh的finally直接释放自己的tail：A读取挂起、B排队超时后，C可绕过A，出现两个适配器读取。现将tail串接前序及自身完成屏障；槽位到整条屏障结束才归还，最多两项。挂起时新的调用可收到busy，不无限积累已超时的等待节点。
2. S2，读取超时只结束调用方等待，未通知适配器取消，也未撤销已有批准和缓存。现为每次实际读取使用独立AbortController，连接全局停止/关闭信号；失败时同步撤销批准、清空快照并abort。结果发布前再次检查取消及monotonic期限。忽略取消的Promise即使迟到成功也只能解除屏障，不能更新快照或恢复批准。
3. S2，close仅确认adapter.close，未等待仍在执行的读取，可能过早释放夹具锁。现并行发起adapter.close并等待读取链，在同一期限内两者都完成才portReleased=true；否则返回未确认并保留锁。关闭时清空缓存，迟到结果不能使closed服务恢复上下文。失败关闭结果保持原有单次memoize语义，不后台宣称释放。

不新增fault阶段或其他公共字段。ready表示此Fake服务的生命周期阶段；挂起的底层读取仍受槽位约束，后续请求按busy/timeout失败。恢复读取后也必须重新获取上下文、提案及批准，不能复用已撤销批准。

## 检查点

- 开始前：读取入口/记忆、任务、ADR和R01-R12；确认Git状态、范围及上述保护基线。
- 设计与第一条链路：先添加三个反例，原实现3项全部失败，分别观测越过前序、未abort和错误portReleased；修正后3项通过。
- 资源复核：发现调用方退出立即归还槽位仍会让挂起期间等待链增长，改为屏障完成后归还。首次专项39/40：恢复读取的测试在屏障清理微任务完成前立即请求，正确收到busy；测试等下一事件循环后验证可再次读取，未放宽并发断言。
- 交付前：检查最终源码diff与hash、构建及四模式专项；Linux无相关宿主/设备/交互进程，Windows Win32_Process成功查询matchingProcesses=0。首次Windows查询过滤引号错误，无效结果未采信，改用客户端过滤后exit0。所有本次构建和测试会话已退出。

## 验证

环境：Linux Node v24.18.1；Windows原生Node v24.16.0。所有最终命令exit0，日志位于上述保护目录。

| 命令 | 最终结果 | 日志 |
|---|---|---|
| npm run build | TypeScript通过 | 本轮终端输出 |
| node --import tsx --test tests/device-operation.test.ts | 40通过、0失败、0跳过 | linux-source.log |
| node --test dist/tests/device-operation.test.js | 40通过、0失败、0跳过 | linux-built.log |
| Windows node.exe --import tsx --test tests/device-operation.test.ts | 40通过、0失败、0跳过 | windows-source.log |
| Windows node.exe --test dist/tests/device-operation.test.js | 40通过、0失败、0跳过 | windows-built.log |

新增测试验证排队超时后第三请求被有界拒绝、前序完成后可重新读取；忽略abort时重试不重叠、旧批准不可执行、迟到值不发布；关闭预算耗尽时不能确认释放或解锁。既有停止取消读、写盘挂起停止、撤销、TTL、重放/重启、临时夹具以及编译IPC集成均在这40项中。跨平台同一用例不累计，本轮没有全仓回归；10月19日全仓结果仅见原报告。

## R01-R12

| 标准 | 结果与依据 |
|---|---|
| R01 | 通过：既定Fake局部修正，未扩大设备授权 |
| R02 | 通过：设备服务内调度，宿主和模块依赖未变 |
| R03 | 通过：公共schema及持久化版本无变化，回退基线明确 |
| R04 | 通过：原九值校验保留，新增发布前取消/期限校验 |
| R05 | 通过：失败撤销批准，挂起读取不提前释放所有权 |
| R06 | 通过：超时不代表取消完成，关闭未确认保留锁，无重发 |
| R07 | 通过：最多两个读取槽，等待链不越序，期限及控制槽保留 |
| R08 | 通过：沿用继承IPC，角色和权限边界未变 |
| R09 | 通过：监听器finally移除、Promise成功/拒绝均释放屏障；真实驱动清理未验证 |
| R10 | 通过：三个修复前失败反例、构建和四模式40/40；本轮全仓未验证 |
| R11 | 通过：e08c829、完整bundle与产物归档，最终diff限上述目标 |
| R12 | 通过：记忆及任务更新，历史结果与本次结果分开 |

本范围无未解决S0/S1，三项S2已修正。真实CI-V仲裁、真实驱动忽略取消后的处置、生产日志耐久性、重连与完整迁移仍未验证。没有打开COM17或执行真实发送；本报告不能作为上述范围的验收证据。
