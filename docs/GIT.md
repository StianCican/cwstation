# 本地 Git 与恢复基线

## 当前仓库

本环境把项目 `.git` 挂载为只读空目录，标准 `git init` 返回 `Read-only file system`。
可写元数据保存在项目 `.git-local/`，工作树仍是项目根目录，分支为 `main`。
使用下面的固定入口，避免误操作其他仓库：

```bash
bash scripts/git-local.sh status --short --branch
bash scripts/git-local.sh log --oneline -5
bash scripts/git-local.sh diff
bash scripts/git-local.sh add <明确文件路径>
bash scripts/git-local.sh commit -m "docs: describe the change"
```

这是真实 Git 仓库，但普通 `git status`、自动发现 `.git` 的 IDE 和工具在当前环境不能识别它。
也可使用 `git --git-dir="$PWD/.git-local" --work-tree="$PWD" <命令>`。
解除环境限制后的标准 `.git` 迁移留待单独核查，当前没有覆盖或移动受保护目录。

初始源码基线为 `14a4e92`，包含 253 个文件。提交只表示版本快照，不表示全仓或设备验收。
当前仅配置仓库本地作者 `CW Station Contributors <cwstation@localhost>`，未修改全局 Git 配置。
未配置远端、未发布。提交建议使用 `chore:`、`docs:`、`feat:`、`fix:`、`test:` 前缀和具体行为描述。

本轮全部提交另导出至 `.local-backups/20261015-011147-progress-git/repository.bundle`，
可用 `git clone <bundle绝对路径> <全新目录>` 恢复为标准仓库；运行数据需从独立备份恢复。

## 文件边界

源码、依赖锁文件、任务/审议/证据文档、示例及固定 WAV 样例纳入版本管理。
`node_modules/`、`dist/`、`logs/`、`data/`、本地环境与凭据、`.git-local/`、`.local-backups/` 不入库。
忽略不会删除文件，也不解除 `unknown` 或设备账本阻止。运行记录仍须独立保护。

修改前完整工作目录快照：
`.local-backups/20261015-011147-progress-git/workspace-before.tar`。
归档保留原文件模式和时间，包含构建产物、依赖、日志和数据；排除了新建备份目录及四个空的受保护目录。
建立后 `tar -df` 无差异、exit 0；快照不是 SQLite 在线一致性备份，不替代 `cwmaint backup`。

后续源码修改先检查 `status`，有未提交修改时保存相关补丁及未跟踪文件。
运行数据或构建输出变更前另做文件保护；不得以 Git 忽略规则替代备份。
