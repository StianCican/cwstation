# P0-005 Codex 审查关注点

状态：2026-10-05 已完成修正与复核，最终源码/编译模式各139/139通过。下列内容保留审查过程；当前修改权已归Codex，DSH headless任务已退出。

- daemon与维护工具必须用相同规范化DB路径取锁，不能只规范化维护端。硬链接另行明确拒绝或检查，不能声称realpath解决硬链接别名。
- 新输出存在性检查须包含悬空符号链接；existsSync不够。发布不能覆盖已经存在的文件/目录/链接，失败清理仅限本任务独占创建的临时产物。
- 配置内所有数值严格校验；已有合法环境变量优先级保持。defaultRuntimeDir的CWSTATION_RUNTIME_DIR既有语义不应无意丢失。
- bundle检查同时审查schema_version记录数量、必要主键/外键/状态记录，以及不支持的触发器等会在写恢复时执行的结构。检查所有integrity_check结果，而非只取第一行。
- clear-storage-fault不能因为出现unknown而无条件覆盖不明blocked_reason；事务前状态须再次检查，与备份的原fault/审计对应。
- 恢复产物发布前应确认已关闭并持久化WAL；不能依赖SqliteJournal.checkpoint吞错后只移走主文件。

## 首版阅读发现（等待DSH自测后交回修正）

1. clearStorageFault计算nextGeneration但调用的journal.clearStorageFault只清字段，没有saveState或SQL递增generation，返回值/审计将与落盘状态不一致。必须原子落盘并覆盖测试。
2. assertStructure仅检查列名；schema_version多行、缺station_state、缺主外键、触发器等伪结构可能通过。维护恢复不能把这些视作本项目有效库。
3. clear发生unknown时覆盖任何blocked_reason，可能丢失不明阻止；应在修改前发现非fault/非精确unknown原因时拒绝，不把不明阻止降级成可解除unknown。
4. 默认运行目录函数已改为忽略CWSTATION_RUNTIME_DIR，应恢复兼容入口语义。
5. 备份目录rename允许覆盖已存在空目录；恢复rename允许覆盖文件。发布需独占输出所有权/不覆盖操作，不仅事前existsSync判断。
6. inspect必须拒绝bundle数据库-wal/-shm等伴生文件；只hash主文件却SQLite读取WAL会让检查内容和hash不一致。
7. cwmaint help示例把--config放命令前，但run把argv[0]直接作command；须支持示例语法或统一命令后格式。维护路径也须遵循已定配置/环境/CLI优先级，不能静默忽略CWSTATION_DB。无显式--db/--config的隐式库拒绝可保留。
8. DSH交付前built run的CLI综合用例30s超时，注册清理太晚导致测试daemon残留、测试runner不退出；Codex确认PID30686仅为该临时测试daemon后SIGTERM清理，得到127通过/1取消/exit1。后续用例必须采用try/finally和取消感知，编译模式实际运行dist/apps命令，不能只增加超时掩盖清理问题。

## 处理结果

- generation问题由DSH自测发现并修正，专用存储入口在事务中同时更新generation。
- Codex补齐主外键、版本/状态单例与状态范围检查，拒绝自定义触发器/视图。回滚测试改为受控审计写入故障注入。
- 备份发布先独占预留输出目录，再原子替换本任务预留的空目录；恢复通过同文件系统硬链接独占发布，清理临时目录后只有目标文件。已有路径/悬空链接不覆盖，源库硬链接别名拒绝。
- bundle拒绝SQLite伴生文件；原库只读一致快照，保存WAL数据；恢复只移除临时库的空WAL，非空WAL拒绝发布。
- 故障解除与恢复遇到不明阻止原因并存时拒绝，原状态保留；配置前置旗标、环境/CLI优先级与默认运行目录兼容入口修正。
- 编译模式测试实际使用dist daemon与维护CLI，子CLI有15s执行上限；综合用例用try/finally及取消感知清理daemon。最终综合用例正常完成，没有测试进程残留。
