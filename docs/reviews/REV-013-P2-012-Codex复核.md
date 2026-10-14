# REV-013 P2-012 接入方向审议

日期2026-10-14。Codex设计/复核；DSH只读交叉审议四轮，日志分别为logs/P2-012-dsh-design-review.log、P2-012-dsh-v2-review.log、P2-012-dsh-v3-review.log、P2-012-dsh-v4-review.log。四个headless执行均已结束。

首轮发现单transport仲裁设计缺失及公共/私有版本、能力身份、维护权限和通知门歧义；逐轮修订后DSH最后建议通过，无未解决S0/S1/S2。Codex保留更窄结论：通过接入方向设计，不能冻结公共契约或实施真实迁移。

R01/R02/R03/R05/R06/R07/R12在设计方向范围通过；R04/R08/R09实际实现未验证；R10仅静态审议，未新增/运行测试、编译或硬件操作；R11采用非Git文件备份，见下。最终裁决段明确队列上限、截止期冲突、TTL、维护RPC载体、能力schema、身份来源必须在实施前解决。本地ID不能证明同形物理回复归属，旧结果必须在重连开始前失效；读请求write失败是有效只读故障。

基线/mnt/d/AI/project-backups/cwstation/20261014-211211-context-session/p2-012-pre-edit/保存相关既有文档和MEMORY；P2-012-v2.md保存v2。新设计、任务、审议文档和四份日志创建前不存在。源码/apps/packages/tests/dist/rig.sh未改；没有打开COM17或操作用户数据库。当前任务限定为文档，不宣称新服务、维护RPC或新监视字段已经工作。
