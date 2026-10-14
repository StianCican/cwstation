# CW Station

独立的业余无线电 CW 台站自动化项目。目标是稳定、可恢复、便于操作，并能持续增加设备、赛事和自动化功能。

当前已完成离线控制核心、IC-7300 只读监视链路及受控 CW 短报文试验：

- daemon 是唯一拥有 `TxController`、键控适配器和 SQLite 的进程；默认使用进程内FakeKeyer。
- 控制 CLI 只通过本地 IPC（Unix socket 或 Windows 命名管道）请求，不直接打开数据库，也绝不自动批准。
- 提案、批准、执行、结果、审计都持久化到 SQLite，并带显式 schema 迁移。
- 常规发射控制流程仍仅限 Fake；IC-7300 只读监视已完成实机验证。独立受控试验已验证一次命令应答和本机侧音，尚未证明实际报文完成、停止或射频行为。
- 下一阶段将统一设备操作接口接入既有启动与监督链路，默认 `bash rig.sh` 保持只读。

## 文档入口

- `MEMORY.md`：项目要求、设计方向及未决项。
- `docs/PROGRESS-20261015.md`：本次进度核查、验证限制与下一阶段计划。
- `docs/GIT.md`：本地版本基线、Git 操作入口与备份边界。
- `AGENTS.md`：后续开发的上下文入口与工作约束。
- `docs/ROADMAP.md`：Phase 0 起步路线。
- `docs/adr/`：重要架构决策。
- `docs/evidence/P0-002.md`：守护进程与持久化的实现与验证证据。
- `docs/evidence/P0-003.md`：unknown 人工核查与解除的实现与验证证据。
- `docs/evidence/P0-004.md`：Julia/MWORKS CW 合成、噪声与回放文件的实现与验证证据。
- `docs/evidence/P0-005.md`：JSON 配置、离线备份/核查/恢复与存储故障清除的实现与验证证据。
- `docs/evidence/P1-002.md`：Windows/Linux 本地端点、停机和离线维护的验证及权限限制。
- `docs/tasks/P1-008-status-history.md` / `docs/evidence/P1-008-status-history.md`：只读状态历史与诊断记录。
- `docs/tasks/P1-009-julia-history-analysis.md` / `docs/evidence/P1-009-julia-history-analysis.md`：Julia/MWORKS 历史离线分析。
- `examples/signal/`：CW 合成任务示例与可直接校验的 WAV/result 产物。
- `examples/config/`：版本 1 JSON 运行配置示例与字段说明。

## 只读 AI 状态建议（AI-001）

新增独立 `cwai` 入口，不连接 daemon、不读取数据库或串口、不执行模型文本。
开发版需要 Node.js 24，构建后可直接试用本地模拟建议：

```bash
node dist/apps/cwai.js validate-config --config examples/assistant/config.mock.example.json
node dist/apps/cwai.js explain --config examples/assistant/config.mock.example.json --state examples/assistant/state.example.json
```

`mock` 和 `disabled` 不联网。`chat-completions` 支持可配置的文本接口子集，
凭据仅从指定环境变量读取；不保存密钥，不自动重试或切换服务商。
真实服务商尚未验收。模型文本是不可信建议，不能证明设备状态或停止结果；
示例状态文件也不是实时电台状态。具体字段见 `examples/assistant/README.md`。
当前未提供成品界面、系统凭据存储或 Windows 发布包。

## 快速开始（离线 Fake 闭环）

需要 Node.js 24 或更高版本。安装并构建：

```bash
npm install
npm run build
```

终端 1 启动 daemon（前台运行，SIGINT/SIGTERM 优雅停止）：

```bash
npm run daemon
```

可显式选择独立Fake子进程，使用独立数据库和设备账本：

```bash
node dist/apps/daemon.js --db logs/remote-fake-core.sqlite --remote-fake-ledger logs/remote-fake-ledger
```

CLI操作仍使用下面的propose、approve、transmit与stop。Windows用原生Node和本地命名管道，勿用WSL的Linux Node连接Windows管道。该入口与`--rig-endpoint`互斥，不自动启用；禁用dev.state，不接串口。关闭等待子进程，崩溃/超时无自动重启或重发，未确认关闭返回非零。

远程入口status的`keyedCount:null`表示实际执行次数没有可靠计数；`executionMetrics`是当前daemon进程的模拟证据统计，区分sendAttempts、confirmedCompletions、confirmedStops和uncertainAttempts。尝试数不是设备实际执行数，历史以SQLite执行记录与独立设备账本为准。设备账本unknown会阻止新批准，核心resolve-unknown不会清除该账本阻止；不得删除或换账本绕过。

终端 2 用 CLI 完成跨进程流程：

```bash
# 台站状态（纯 JSON）
npm run cwctl -- status

# 创建提案，默认 TTL 60s
npm run cwctl -- propose "CQ TEST DE BD7XXX"

# 用返回的 proposal id 人工批准
npm run cwctl -- approve <proposalId>

# 执行已批准的提案（默认 transmit 不会自动批准）
npm run cwctl -- transmit <proposalId>

# 查询审计、提案、执行记录与自检
npm run cwctl -- audit 20
npm run cwctl -- proposals 20
npm run cwctl -- executions 20
npm run cwctl -- unresolved
npm run cwctl -- doctor

# 正常停机（Windows/Linux 共用）；accepted 仅表示请求已接受
npm run cwctl -- stop

# 人工核查并解除 unknown（详见下节）
npm run cwctl -- resolve-unknown <proposalId> --operator <name> --note <reason> --confirm-stopped
```

`demo` 是显式标记的 Fake-only 端到端演示（输出 `fakeOnly: true`），它才会在一个命令里串联 propose → approve → transmit；默认 `transmit` 始终要求先有服务端批准：

```bash
npm run cwctl -- demo "CQ DEMO"
```

开发时可用 tsx 直接运行源码：

```bash
npm run daemon:dev          # 等价于 tsx apps/daemon.ts
npm run dev -- status       # 等价于 tsx apps/cwctl.ts status
```

## 运行目录、socket 与数据库

默认值（可用环境变量覆盖）：

| 项 | 默认 | 覆盖变量 |
|---|---|---|
| 运行目录 | `$XDG_RUNTIME_DIR/cwstation`，否则 `$TMPDIR/cwstation-<uid>` | `CWSTATION_RUNTIME_DIR` |
| Unix socket | `<运行目录>/cwstation.sock`（0600） | `CWSTATION_SOCKET` |
| SQLite | `./data/cwstation.sqlite` | `CWSTATION_DB` |

只监听本地 Unix socket，不监听公开 TCP。CLI 可通过 `--socket <path>` 指向其他实例。daemon 也接受 `--socket` 与 `--db` 参数：

```bash
npm run daemon -- --socket /tmp/demo/cw.sock --db /tmp/demo/cw.sqlite
CWSTATION_SOCKET=/tmp/demo/cw.sock npm run cwctl -- status
```

### 版本 1/2 JSON 配置（显式 `--config`）

daemon、`cwctl` 与 `cwmaint` 都可用 `--config <file>` 指定 JSON 配置；程序不会自动搜索配置。version1 保留 Linux 路径兼容；version2 增加显式 Unix/管道 endpoint。配置不承载批准、频率、blocked 状态或故障注入变量：

```bash
npm run daemon -- --config examples/config/station.example.json
npm run cwctl  -- --config examples/config/station.example.json status
```

- 优先级（低 → 高）：内置默认 < 配置 < 已有 `CWSTATION_*` 环境变量 < CLI 路径旗标。
- 配置内相对路径以配置文件所在目录解析为绝对路径。
- 严格拒绝未知字段、未来版本、空路径、错误类型与不合理数字（整数、区间、`fakeDurationMs` 允许 0）。
- `cwctl` 只取 socket，但会完整校验配置，因此不要求 daemon 在运行。
- 完整字段、范围与示例见 `examples/config/README.md`。

daemon 会自动创建缺失的数据库父目录。socket 目录仅在由 daemon 新建时收紧为 0700；对用户传入的既有父目录（如 `/tmp`）不做 chmod，socket 自身始终为 0600。`doctor` 在仅挂 `FakeKeyer` 时如实报告 `fakeOnly: true`。SQLite schema 当前为 v4（v1/v2/v3 显式迁移并保留旧数据，未来版本拒绝打开）；核查记录与存储故障分别保存。

测试/故障注入用环境变量（仅影响 FakeKeyer 与超时；不写入普通配置文件）：

| 变量 | 含义 | 默认 |
|---|---|---|
| `CWSTATION_FAKE_DURATION_MS` | Fake 键控时长 | 30 |
| `CWSTATION_FAKE_FAULT` | 到期后抛出的故障信息 | 无 |
| `CWSTATION_FAKE_IGNORE_ABORT` | `1` 时忽略 abort，用于验证 unknown | 关 |
| `CWSTATION_TX_TIMEOUT_MS` | 单次发射超时 | 5000 |
| `CWSTATION_PROPOSAL_TTL_MS` | 提案默认 TTL | 60000 |
| `CWSTATION_APPROVAL_TTL_MS` | 批准有效期上限 | 60000 |
| `CWSTATION_REQUEST_TIMEOUT_MS` | 单请求超时 | 10000 |
| `CWSTATION_ENABLE_DEV_COMMANDS` | `1` 时启用 `dev.state`（测试用状态注入） | 关 |

## 命令与退出码

CLI 输出始终是纯 JSON。成功为 `{"ok":true,"method":...,"result":...}`，失败为 `{"ok":false,"code":...,"error":...}`。

| 退出码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 内部错误 |
| 2 | 用法/参数错误 |
| 3 | 对象不存在 |
| 4 | 冲突：未批准、忙、过期、被阻止、授权无效 |
| 5 | daemon 不可达 |
| 6 | 协议版本不匹配 |
| 7 | 请求超时 |

## 安全与恢复语义

- **一次性批准**：批准绑定不可变内容 hash、频率、模式、generation 和期限；开始执行即消费，同一提案重复 `transmit` 返回已有结果，绝不再次键控。
- **单一在途发射**：同一时间只允许一个发射；`abort` 是独立请求，可抢占在途发射。发射在独立的有界超时内完成，后端永不返回时判 `unknown`，迟到的完成或异常绝不覆盖已确定的 `unknown`。
- **fail closed**：持久化 intent 失败则不键控，并阻止后续执行；超时、后端断连、频率/模式变化或无法证明停止进入 `unknown`，并阻止后续发射。事务回滚时内存真值保持一致。
- **重启恢复**：daemon 成功独占 socket 后才执行恢复；数据库批量终止全部开放提案（无 LIMIT），遗留 `executing` 记为 `unknown`，不自动重试。仅当确有开放授权需要失效时才递增 generation，重复恢复幂等。只有**未解除**的 `unknown` 会阻止发射，已解除的不再阻止。
- **单一持有者**：数据库锁 + socket 锁 + 独占 bind，防止两个 daemon 操作同一数据库。锁的检查/回收/创建由短生命周期 mkdir guard 串行化；空/损坏锁与残留 guard 一律 fail closed，等待人工处理，只有确认持有进程已退出才原子移走陈旧锁。
- **安全边界**：同一 OS 用户。CLI 请求只证明该用户发起了请求，不能证明真实人类批准；不接 AI，不监听公开 TCP。

## unknown 人工核查与解除（仅 Fake 阶段）

完整分类操作见[Fake异常恢复操作规程](docs/design/Fake异常恢复操作规程.md)，涵盖核心unknown、Remote Fake账本阻止、存储故障与锁残留。下述解除仅处理核心记录；Remote Fake设备账本unknown没有解除接口，不能删账本或切换后端绕过。

`unknown` 表示无法证明发射已停止。系统保留原执行记录（绝不改写为 `completed`/`cancelled`），并新增独立的 `execution_resolutions` 核查记录。只有人工核查确认停机后，才允许解除阻止。

```bash
# 查看未解除的 unknown（含本进程是否可解除、是否需重启）
npm run cwctl -- unresolved

# 核查解除（三个条件缺一不可）
npm run cwctl -- resolve-unknown <proposalId> \
  --operator <name> --note <reason> --confirm-stopped
```

规则与限制：

- `--confirm-stopped` 必须是严格的裸旗标，`--operator`/`--note` 必须非空且有长度上限；多余位置参数、未知旗标一律拒绝（退出码 2）。
- 只有**本次启动恢复完成时已存在**的 `unknown` 才能解除；本次 daemon 启动后新产生的 `unknown` 必须先停止并重启，等待原进程的 FakeKeyer 迟到操作不再可能发生。
- 解除在单个事务中完成：写入核查记录、撤销全部开放授权、终止开放提案、`generation + 1`、更新阻止状态、追加审计 `tx.unknown_resolved`。仍有其他未解除 `unknown` 时保持阻止；最后一条解除后才允许重新提案。
- 解除后原提案重试仍返回原 `unknown`，绝不重新键控，也绝不自动重发或自动批准；新发射必须重新创建提案并单独批准。
- intent/outcome/state/解除持久化故障会显式闩锁，`resolve-unknown` 被拒绝；故障尝试独立落盘，已落盘的故障在重启后仍阻止解除。数据库完全不可写时只能保证本进程闩锁。排查恢复存储后可用离线 `cwmaint clear-storage-fault` 核查解除；不能用 unknown 核查清除，也不要手改数据库。
- `status`/`doctor` 暴露 `unknownReview`（未解除计数、本进程可解除数、需重启数、故障闩锁、是否已恢复）；`doctor.unknownReviewPolicy` 说明重启核查限制。
- **请勿手改数据库**。手工删除执行记录或改写状态会破坏审计与阻止语义，恢复流程以本命令为准。

安全边界：同一 OS 用户的 `--confirm-stopped` 只是操作人声明，**不证明真人参与，也不证明真实设备已停止**。真实设备后端的核查步骤留待 Phase 1 设计，不能直接复用离线声明作为物理停发证明。

## 离线备份、核查与恢复（维护 CLI）

`cwmaint` 是不进入发射路径的维护 CLI，纯 JSON 输出、明确退出码。它**不会自动启动或停止 daemon**：若 daemon 正持有同一数据库锁（含通过符号链接别名解析到的同一路径），维护命令一律拒绝。路径全部绝对规范化，输出先写独占临时目录、校验后再发布，失败只清理本次临时产物，绝不动既有用户路径。

```bash
# 一致性快照备份到新目录（使用 node:sqlite VACUUM INTO，包含 WAL 数据）
npm run cwmaint -- backup --db data/cwstation.sqlite --out /backups/2026-10-05

# 只读核查：manifest 类型/版本/大小/SHA256、固定文件名、无 symlink/目录逃逸、
# integrity_check、foreign_key_check、schema 结构、计数与台站状态一致性
npm run cwmaint -- inspect --bundle /backups/2026-10-05

# 恢复到全新数据库路径（主文件与 -wal/-shm 必须都不存在）
npm run cwmaint -- restore --bundle /backups/2026-10-05 --db data/restored.sqlite

# 清除已持久化的存储故障（Fake 离线库；需人工确认已停机）
npm run cwmaint -- clear-storage-fault --db data/cwstation.sqlite \
  --operator alice --note "checked disk and restarted" --confirm-stopped
```

规则与限制：

- **备份**在锁内用 `VACUUM INTO` 生成一致性快照，包含 WAL 中已提交的数据；不裸 copy 主文件，也不用会迁移数据库的 `SqliteJournal` 打开备份源。manifest 记录 schema、时间、数据库文件名/大小/SHA256、数据计数与台站状态；输出目录已存在则拒绝。
- **核查**是只读的：不写 bundle、不迁移源；bundle 被篡改、未来版本、目录逃逸、内部 symlink、坏库、缺表或伪造列、计数/状态与 manifest 不符都会拒绝。
- 备份包必须是独立快照，拒绝数据库 WAL/SHM/journal 伴生文件。版本和台站状态必须各有唯一记录，检查必要主键与外键，拒绝自定义触发器与视图。源数据库不支持硬链接别名；可用符号链接，锁会解析到真实路径。已有输出包括悬空符号链接都不能覆盖。
- **恢复**只允许全新路径，取得目标锁后再检查；从一致快照创建临时库，执行已有显式迁移与恢复：撤销全部批准、终止开放提案、`running → unknown`、`generation + 1`、追加审计 `maintenance.restored`。保留原执行与核查记录，不重发、不重新批准；`storage_fault` 与未核查 `unknown` 继续阻止。失败清理临时文件并释放锁，绝不覆盖源库或就地覆盖。
- **clear-storage-fault** 只处理本项目离线库，且要求 daemon 已停止。先做只读完整性/版本/结构检查，再成功生成不可覆盖的“故障解除前备份”（返回其路径），随后在显式写事务中撤销全部批准、取消开放提案、`running → unknown`、`generation + 1`、显式清空 `storage_fault`、按全部未核查 `unknown` 重设阻止，并追加审计 `maintenance.storage_fault_cleared`（含原故障、operator/note、备份路径与 hash）。没有 `storage_fault` 返回冲突且不写审计；写/提交失败事务回滚、故障保留；不清理 `unknown` 或其他不明阻止原因。
- 该命令只验证恢复后的存储可写性并记录人工核查，**不声称修复损坏数据库、磁盘或硬件故障**。`SqliteJournal.saveState` 的 COALESCE 保留语义不变，专用清除入口只存在于维护模块。
- 不明阻止原因与故障/unknown 并存时，恢复或故障解除会保守拒绝，原原因不被改成可解除的 unknown。需单独排查并明确处理该原因。
- **恢复步骤**：先 `npm run cwmaint -- inspect --bundle <bundle>` 确认备份可用，再把目标指向全新路径 `restore`，检查返回结果后切换配置的 `dbPath`，启动 daemon 并用 `status` 核查。不要就地覆盖正在使用的数据库。
- **程序回退**：本版 `restore` 会迁移新库到 schema4；切换旧程序前，必须确认它支持该 schema。不能读取时，应使用与旧程序兼容的备份和维护版本恢复到另一新路径，保留当前程序、数据库和备份。
- **失败说明**：锁被持有（daemon 运行中）返回 `locked`（退出码 4）；输出目录已存在返回 `output_exists`（4）；输出/目标父目录不存在返回 `output_parent_missing`（4）；源库缺失返回 `not_found`（3）；用法/旗标错误返回 2；bundle 校验失败返回 4；内部错误返回 1。所有命令输出单行纯 JSON。

## CW 合成、噪声与回放文件（Julia/MWORKS，离线）

P0-004 增加了与发射控制完全隔离的离线计算路径：TS 的 `cwwave` CLI 只生成/校验
版本化任务与结果文件，真正的波形合成在已有 MWORKS Julia 环境内的
`julia/CWSignal.jl` 中完成。两者通过任务/结果 JSON 衔接，不建立常驻服务、不进入
发报安全路径、不自动启动 Julia。

```bash
# 直接验证已附带的实际 Julia 产物
npm run cwwave -- verify --task examples/signal/cq-test.task.json \
  --result examples/signal/cq-test-out/result.json

# 重新生成时使用未占用的任务和输出路径
npm run cwwave -- prepare --text "CQ TEST" --out examples/signal/demo.task.json --snr 10

# 2) 在 MWORKS Julia 中合成（launcher 自带 depot/PATH；WSL 下用 wslpath -w 转换路径）
TASK_WIN=$(wslpath -w "$PWD/examples/signal/demo.task.json")
OUT_WIN=$(wslpath -w "$PWD/examples/signal/demo-out")
cmd.exe /c "C:\\Users\\Public\\TongYuan\\julia-1.10.10\\bin\\julia-ty.bat D:\\AI\\projects\\cwstation\\julia\\run_task.jl $TASK_WIN $OUT_WIN"

# 3) TS 校验任务、WAV 与元数据
npm run cwwave -- verify --task examples/signal/demo.task.json \
  --result examples/signal/demo-out/result.json
```

- 文本编码复用固定版本 `@ozdemirburak/morse-code-translator@7.0.0`（MIT、无运行依赖），按字符
  编码并严格拒绝不支持字符；首版支持 A-Z、0-9、空格及已验证的 `/?.,`。
- 任务契约 `contractVersion=1`、算法 `algorithmVersion=1.0.0`；`snrDb=null` 为干净场景。
- 合成约定：点 1、划 3、元素间隔 1、字符间隔 3、词间隔 7；点长 `1.2/wpm` 秒；
  样本边界整数量化；关键段落由实际样本边界生成；载波乘短余弦沿；无多余末尾间隔。
- 噪声使用整段报文（含间隔）的实测功率与固定 seed；clean/noisy 同比例归一化到
  峰值 ≤ 0.95，避免截幅破坏 SNR。
- `cwwave verify` 不只看 JSON：重算 task/artifact SHA256、独立推导关键段落、解析
  WAV 格式、检查峰值与间隔静音、重算实测 SNR，并拒绝绝对/越界路径、目录外 symlink、
  未来版本与错配元数据。

完整命令、环境与限制见 `examples/signal/README.md` 和 `docs/evidence/P0-004.md`。

`demo.task.json` 和 `demo-out/` 已存在时请使用另一组新路径，工具不会覆盖它们。

## 已知限制

- Windows 原生通过受保护管道桥接通信：创建时限定当前用户与SYSTEM、拒绝NETWORK/远程，读回ACL后就绪；客户端在同一HANDLE上核对服务用户与ACL。Linux保留Unix socket。管理员和同用户shell仍属于信任边界，CLI不能证明真人批准。真实第二用户/远程登录测试尚未进行。
- Windows 备份先独占创建输出目录，再链接已验证快照，manifest 最后发布；进程中途退出可能留下不完整包，`inspect` 会拒绝。已有目录不覆盖；Linux 保留目录原子重命名发布。两平台恢复均到新路径。
- 本机 Windows 源码模式需要 Windows 自己安装的 tsx/esbuild 依赖；不能混用 WSL 的原生依赖。本轮 Windows 验证使用编译产物，控制核心双平台不意味着 Julia 已在 Linux 验证。

- 仅 `FakeKeyer`，未接触真实电台，也未做真机验证。
- 核查解除仅适用于 Fake 阶段：只能处理启动恢复时已存在的 `unknown`；本次启动后新增的 `unknown` 必须停机重启。数据库不可写等存储故障会闩锁解除路径，需人工排查，不能靠重试或删记录绕过。
- 仅支持 CW 单一模式与单一频点；`dev.state` 是测试钩子，默认关闭。
- 优雅关闭时无法在有限时间内确认停止的在途发射会记为 `unknown`，不会记为 `completed`。
- 备份/核查/恢复/故障清除都是离线维护操作：要求 daemon 已停止（或未持有数据库锁），不会自动停 daemon。恢复生成的是新数据库，需重新批准方可发射；`clear-storage-fault` 只验证恢复后的存储可写性，不修复损坏数据库或硬件故障。
- Julia 合成/噪声只在已确认的 MWORKS 环境（Julia 1.10.10、TyCommunication 1.0.7、
  JSON3 1.14.3、WAV 1.2.0）实测；`seed` 复现范围限于该记录环境，跨版本不保证逐样本一致。
  该路径是离线计算，未接入发射，也未验证真实音频设备回放。

## 测试

```bash
npm run test:preflight  # 检查子进程输出、本地 IPC 和本机 HTTP 监听能力
npm test               # 前检通过后，以 tsx 运行源码测试
npm run test:built     # 前检通过后，构建并运行同一批编译版测试
node scripts/verify-platform.mjs --source --list  # 只列出测试，不启动前检或构建

# 两平台原生构建及编译测试，不依赖 shell 展开 glob
node scripts/verify-platform.mjs
```

源码与编译版从同一份清单发现 `tests/` 和 `packages/` 下的 `*.test.ts`，包含服务内测试。
前检失败返回2并标记 `environment_unavailable`，不会启动构建或产品测试；这表示环境阻塞，不能当作测试通过。
构建或测试失败返回1；列清单和帮助返回0。完整回归保留 Node 的文件隔离；关闭隔离的定点诊断不替代全仓验收。

Windows PowerShell 可直接运行 `node scripts/verify-platform.mjs`。本机 WSL 验证 Windows
原生运行时使用 `node.exe scripts/verify-platform.mjs`，运行时输出应为 `platform=win32`。
Windows验证入口会先构建C#管道桥接。仅运行`npm run build`时另需执行
`node scripts/build-native-windows.mjs`；产物为`dist/native/CwPipeBridge.exe`，
运行时不编译，缺少产物拒绝连接。当前使用Windows自带.NET Framework 4.x和
Framework64 csc，不要求接收者安装编译器；发布包尚未制作或在干净机器验收。
Windows 示例入口：`node dist/apps/daemon.js --config examples/config/station.windows.example.json`；
另一终端用相同配置调用 `node dist/apps/cwctl.js --config examples/config/station.windows.example.json status` 或 `stop`。

测试只使用临时目录与临时数据库，不触碰用户数据；daemon 子进程在测试结束时会被 SIGTERM/SIGKILL 清理，进程退出时还有兜底清理。测试期 daemon 的 stdout/stderr 同时写入工作区 `logs/daemon-<pid>.log`，便于失败取证。

当前覆盖：跨进程 propose/approve/execute、未批准拒绝、重复执行只键控一次、并发互斥、取消、TTL、频率/模式变化、`unknown`、有界超时与迟到结果、写失败 fail closed、崩溃后恢复、第二 daemon 拒绝、无效协议输入、锁的并发/陈旧回收、schema v1/v2/v3 迁移到 v4、`unknown` 核查解除（严格校验、重启限制、幂等、部分解除、撤销授权、写失败回滚、故障闩锁）、跨 CLI/RPC 退出码、`doctor` 自检和 CLI 退出码；以及 CW 信号契约、Morse 复用、时间轴 E/T 与间隔、`cwwave prepare/verify` 的 SHA256/WAV 格式/路径安全/篡改拒绝。P0-005 新增：配置优先级/相对路径/严格拒绝与 `cwctl` 无 daemon 校验；备份含 WAL 数据、原库不变、输出不覆盖、活动 daemon 与 symlink 别名锁拒绝；bundle 篡改/未来版本/目录逃逸/symlink/坏库/缺表/伪造列拒绝；恢复到新库的撤销批准、`running → unknown`、旧 `unknown`/故障保留、核查记录保留、旧版迁移与失败无残留；故障清除的先备份/审计/generation/阻止保留/失败回滚与重启后重新授权。Julia 侧的 E/T 与间隔、边沿、量化误差、固定 seed 复现、SNR 估计与失败无半成品由 `julia/test/runtests.jl` 覆盖（命令见 `examples/signal/README.md`）。

本项目不依赖 WorkBuddy 工作区。
