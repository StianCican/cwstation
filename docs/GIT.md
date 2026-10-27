# 本地 Git 与恢复基线

当前可见性：2026-10-27按用户明确要求，原 `StianCican/cwstation` 仓库已转为公开，GitHub查询确认PUBLIC；下方私有描述保留为首次上传历史。

## GitHub 上传（2026-10-23）

用户要求上传至StianCican账号。目标仓库为`https://github.com/StianCican/cwstation`，默认私有，沿现有main及完整历史，不做0.0发布或标签。当前推送状态以MEMORY顶部为准；本地提交不等于远端上传成功。

首次上传已完成：源码提交`141255f`已推送，origin为`https://github.com/StianCican/cwstation.git`，main跟踪origin/main。335个文件及既有历史上传，77个文件包含此前未提交进展；仅额外去除旧专项末尾一空行，不改变产品逻辑。后续同步仍用原Git入口；本机可按单次命令复用Windows credential helper，不复制凭据：

```bash
bash scripts/git-local.sh -c credential.helper= -c 'credential.helper=!"/mnt/c/Program Files/GitHub CLI/gh.exe" auth git-credential' push
```

本机Windows GitHub CLI已登录对应账号，WSL gh未登录；Git推送使用Windows gh的credential helper，不读取/复制token，不改全局Git配置。项目继续用原`scripts/git-local.sh`及`.git-local`，普通clone得到标准Git仓库，不迁移本地元数据。

上传前基线`.local-backups/20261023-github-upload/`含repository-before.bundle（完整9提交历史且bundle verify通过）、worktree-before.tar（335个源码/文档/示例文件）、dirty-before.patch及原config/index。扫描当前候选文件及320个历史唯一blob，未发现所检查的常见token/私钥/硬编码凭据模式；非完整秘密检测保证。源码边界检查无logs/data/dist/node_modules/本地备份，最大单文件不足0.2MB。产品验证沿用MEMORY已有受影响证据，不因上传重复跑设备/GUI/全仓测试。

下方“未配置远端、未发布”为初始本地基线历史，由本节和MEMORY顶部当前状态替代。

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
