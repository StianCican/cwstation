# Codex 初审发现（DSH 实现期间只读检查）

本文件是审查记录，不是已验收状态。请 DSH 在本轮完成前读取并修正以下问题，再提交证据。

1. `setState` 计算 nextFrequency/nextMode 后未写入 state，频率变化未更新真值；频率变化也应取消在途，不能仅断连取消。增加状态值和新提案频率断言。
2. `runKeyer` 只设 abort timer 并 await 后端，后端永不返回则发射永远停留 running。需要独立有界 timeout/race，结果 unknown 后绝不被迟到完成覆盖。后端任意异常不能只因 signal.aborted 就推断取消成功；验证 result 的 requestId 与 outcome。
3. `DaemonServer.stop` 先 await server.close 再 destroy 连接会在长连接上死锁。应先标 closing/close listener，取消控制器在途任务，再有限关闭连接，避免 SIGTERM 挂死。
4. core 目前 type-import 具体 SqliteJournal，journal 又 type-import core AuditSink。改成核心定义最小存储接口，SQLite 实现它，核心不依赖 SQLite 类。
5. 锁创建 wx 后尚未写入 PID 的短窗口，另一个启动者会把空锁当陈旧锁移走。多个启动者检查陈旧 PID 后 rename 也可能移走新持有者锁。需要序列化整个检查/创建/回收过程（可用短生命周期 mkdir guard；guard 存在则 fail closed，guard 异常残留需显式人工处理），无效/空锁不能自动判定持有者死亡。
6. daemon 打开 DB 锁前确保 DB 父目录存在；不能 chmod 用户提供 socket 的任意既有父目录（如 /tmp 或项目根）为0700。
7. doctor fakeOnly 当前是 false，但只有 FakeKeyer，应为 true。
8. 写入失败应阻止后续执行；修复事务回滚与内存 state 不一致情况。增加 intent/outcome 写失败故障用例。
9. 启动恢复当前 LIMIT 100000可能遗漏旧批准；用数据库批量更新全部开放提案或无上限分页。重复 recovery 不应无故增加 generation。

测试问题请用失败证据修复，不将测试自报通过当验收。所有测试用守护进程须停止。
