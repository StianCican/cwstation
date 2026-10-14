# BASE-001 进度核查与 Git 建立

日期：2026-10-15。执行与复核：Codex。范围：现状检查、本地 Git、离线验证、后续规划；没有产品实现任务或新公共接口定稿。

## 保护与差异

- 起点 `git status --short --branch` 返回128：不是 Git 仓库。`.git` 是环境只读空目录。
- 修改前保存 `.local-backups/20261015-011147-progress-git/workspace-before.tar`；`tar -df` exit0 无差异。保留文件属性，排除新备份目录与 `.git/.agents/.codex/.aws` 四个空受保护目录。
- 快照 SHA-256：`949a1b595c8a0b81951ce3be268dd660b6114918e47c7d2af3514d25f46275e8`。数据库只是文件现场保存，未宣称应用一致性备份。
- `git init -b main` 因 `.git/hooks/` 只读返回1；改用显式 `--git-dir=.git-local --work-tree=.` 建立真实仓库。没有尝试解除环境保护。
- 初始提交 `14a4e92`，253个文件，main分支；之后的文档改动以该提交为回退基线。未伪造先前历史，未配置远端/推送。
- 修改目标：`.gitignore`、`scripts/git-local.sh`、README、ROADMAP、MEMORY及新增进度/Git/本证据文档。应用源码和测试不改；build更新忽略的dist，测试可能新增忽略的logs。
- AGENTS原文保留，SHA-256：`5a9e9f10e6bd1056d0f3290a8dd612bd5f9e20d6d26ba62ab2f418a0320aa670`。
- 最终针对apps/packages/tests/data/logs/cw-trial/AGENTS执行`tar -df`返回0，无差异；`git diff --check`及`git fsck --full`返回0。源码、用户库和试验账本未改变。

## 实际验证

环境：WSL Linux，Node v24.18.1，当前受限沙箱。以下日志全部保存在上述备份目录中；结果不与历史测试相加。

| 命令/日志 | 退出码与结果 |
|---|---|
| `npm run build` / build.log | 0 |
| `npm test` / test-source.log | 1；默认隔离模式仅报告24文件级结果，12通过/12失败，不能作为用例级计数 |
| `node --test --test-reporter=tap --test-timeout=60000 dist/tests/*.test.js` / test-built.log | 1；24文件级结果，12通过/12失败 |
| `node --import tsx --test --test-isolation=none --test-reporter=tap --test-timeout=60000 tests/*.test.ts` / test-diagnostic.log | 1；360项，230通过/122失败/8跳过，仅用于详细诊断 |
| 同上无隔离方式，限定 civ-read-arbiter、serial、civ-tx-plan 三套件 / test-focused.log | 0；36/36，无跳过 |
| 同上无隔离方式，限定 packages/rig-status/src/service.test.ts / test-status-service.log | 1；9项，6通过/3失败 |
| `bash -n scripts/git-local.sh rig.sh scripts/cw-trial.sh` | 0 |
| `node dist/apps/cwrig.js simulate` 和 `node --import tsx apps/cwrig.ts simulate` | 均0，simulation只读快照，无设备访问 |

另保留 `test-civ-diagnostic.log`（单文件隔离运行失败）和 `test-civ-direct.log`（直接运行27通过/2失败），用于进一步定位子进程输出问题。
已确认详细日志含 `listen EPERM`（Unix socket及localhost HTTP），说明当前沙箱无法完成相关集成验证。
仍有子进程提前退出、JSON空输出、Fake子服务提前退出等失败，尚未独立归因，不以EPERM解释全部问题。
全仓命令不包含服务内测试；本次已单独补跑。没有Windows、Julia或真实串口回归。

关键日志SHA-256：

- test-diagnostic.log：`dafe2fa0beb2870b002e89243770d22b21a54c32afec551e37b5f748226fbf9f`
- test-focused.log：`d4b45b3029123ccb6d9d08c82f15e490edcc569c94f442cd7b17e8663252ae6f`
- test-status-service.log：`ee1d0bc634f4ae213f756a75ed5c3b79c13eea3a450bae02cf88cb3202e89a37`

## 检查点与 R01-R12

开始前已读AGENTS、MEMORY、执行规范、近期任务/复核/源码，确认原目录状态并先保护；无新运行链路设计、无设备接入或范围扩大。交付前核查差异及残留进程。

| 标准 | 结果与依据 |
|---|---|
| R01 | 通过：用户要求的检查、版本基线、规划已提供 |
| R02 | 通过：后续沿已有宿主和唯一持有者方向；未改模块依赖 |
| R03 | 不适用：未变更公共协议、应用配置和存储schema |
| R04 | 不适用：未新增应用输入解析或外部结果处理 |
| R05 | 通过限定本轮：不访问串口，不新增批准/发送能力 |
| R06 | 通过限定文档：FB和侧音仍不声称完成/停止 |
| R07 | 未验证：IPC集成受EPERM限制，未作并发能力验收 |
| R08 | 通过限定本轮：不解除只读目录保护、不读取凭据、不联网发布 |
| R09 | 通过限定本轮：先保护数据和产物；检查未发现项目daemon/rig服务残留 |
| R10 | 未通过全仓门槛：专项通过，全仓失败如实保存并列为下一项 |
| R11 | 通过：修改前tar快照，初始Git提交，后续diff检查 |
| R12 | 通过：现状、历史、建议规划与实机限制分开记录 |

## 结论

版本基线与进度整理可交付。全仓回归未通过，统一操作接口仍是待设计审议阶段；不据此验收新产品行为或真实发送能力。
本轮未调用DSH，规划需在下一项设计任务中交叉审议；本报告为Codex现状核查，不冒充DSH审议。
