# BASE-002 v1 测试基线执行与自查

日期：2026-10-15。实施/复核：Codex；DSH未执行成功，不能作为交叉审议记录。
当前状态：续办双平台源码/编译回归零失败，仍待DSH补审，完整任务未验收。以下v1记录保留历史，当前结果见末尾v2续办段。

## 对象与保护

Git起点81ee2d6，开始时工作区干净。修改目标为package.json、scripts/verify-platform.mjs、README、MEMORY、进度文档及本任务/证据。
完整目录保护为`.local-backups/20261015-013904-test-baseline/workspace-before.tar`，SHA-256为`2ecf69be4c6ec03fc63b04af20cce439ec91412ee6bd4cf9c4d1b8b4cdba83db`；建立后tar比较exit0。
前检拒绝产品执行后，比较dist/apps/packages/tests/data/logs/cw-trial/AGENTS与快照无差异、exit0；随后明确单独build，用于编译版专项诊断。
不把原库文件现场快照宣称为SQLite在线一致性备份；没有操作用户库或账本。

最终实现SHA-256：

- scripts/verify-platform.mjs：`0b5de1ddb9298c0c6cecc3c9d0d32ed7b7b72f0105ab6c83562df38582c6076a`
- package.json：`da0f5e858d197432bf8369206551597cc63dc2acf1c100962d050ec9783c796a`

## 已证实发现与处理

| 分类 | 证据与结论 | 处理 |
|---|---|---|
| 环境阻塞 | raw-child-probe.log：Node v24.18.1，spawnSync同时status0/error EPERM/stdout0；异步探针也未收到预期输出 | 不能只检查子进程status；前检明确拒绝继续 |
| 环境阻塞 | preflight-final.log：Unix socket与127.0.0.1监听EPERM | 完整集成测试不可在当前环境验收 |
| S2 测试发现缺口 | 旧npm脚本和平台脚本只遍历tests，漏服务内套件 | 使用同一源码清单映射编译路径，独立glob核对25个文件 |
| S2 验证脚本错误处理 | 旧平台脚本build检查status，error仅打印，存在status0/error非空时继续的可能 | 所有阶段显式拒绝error/signal，非零阶段统一exit1 |
| 待归因 | BASE-001全仓122项失败及8项跳过并未逐项重验 | 不把全部失败归为产品错误，也不宣称全部已解释 |

没有证实新的设备控制产品缺陷；本轮不修改产品协议或发射路径。

## 实现与兼容

已有平台脚本默认仍执行编译版验证，新增--source/--built、--preflight、--list、--help；非法/冲突参数先拒绝。
前检逐项检查Node>=24、同步/异步子进程精确输出、本地IPC和HTTP监听，临时监听与目录在结束时清理。只探测本机，不访问外网或电台。
前检失败返回2，明确testsStarted:false/buildStarted:false；测试或构建失败返回1，不能把环境失败当跳过。
源码/编译版从tests与packages的*.test.ts发现同一清单，编译版以源码为真源映射路径，避免把陈旧dist测试混入。
完整回归保留Node文件隔离、每文件60s上界及原平台入口180s总执行期限；Windows保留native bridge构建步骤，并用于源码验证。

## 实际验证

所有日志位于上述备份目录，环境为当前受限WSL Linux/Node v24.18.1；结果不与历史或彼此相加。

| 命令/日志 | 退出码与结果 |
|---|---|
| node --check scripts/verify-platform.mjs | 0 |
| --source --list / test-plan-source-final.jsonl | 0，25个文件 |
| --built --list / test-plan-built-final.jsonl | 0，25个对应文件 |
| 独立fs.globSync/assert核对 / test-plan-check.log | 0，清单一致、含服务测试、编译文件全部存在 |
| --help | 0，不前检/构建/测试 |
| --source --built / invalid-args-v1.log | 2，冲突参数拒绝，不执行前检 |
| npm run test:preflight / preflight-final.log | 2；Node版本通过，其余4项能力失败 |
| npm test / npm-test-final.log | 2；前检阻塞，未执行源码测试 |
| npm run test:built / npm-test-built-final.log | 2；前检阻塞，未构建或执行编译测试 |
| npm run build / build-v1.log | 0；明确独立构建 |
| 四套件源码定点诊断 / offline-source-v1.log | 0，61通过/0失败/0跳过 |
| 四套件编译版定点诊断 / offline-built-v1.log | 0，61通过/0失败/0跳过 |

定点命令：`node --import tsx --test --test-isolation=none --test-reporter=tap --test-timeout=60000 tests/civ-read-arbiter.test.ts tests/serial.test.ts tests/civ-tx-plan.test.ts tests/civ-context-read.test.ts`。
编译版去掉--import tsx，使用对应dist/tests/*.test.js四个显式文件。关闭隔离仅用于当前环境定点诊断，不能替代正常全仓回归。

关键日志SHA-256：

- preflight-final.log：`054df6e3819f8148ab78d8d741fbbefd9f5e262355db9146cc6170e155091d01`
- offline-source-v1.log：`3091047733f6ebbb78257350a9fde85c90600c93ef13c98dfc16586dec8b1d60`
- offline-built-v1.log：`740af2fd7d015eb8450b6c4e25a6ddbe2a50ecbdaf96b12a5ef62c6c0d34e012`

## DSH执行记录

沿既有DSH_HOME/headless投递BASE-002任务，启动在prepareProfile写全局cordis.yml时遭EROFS，exit1；原始日志dsh-attempt.log。
调用前仅备份非凭据cordis.yml，调用后cmp一致；没有读取/复制凭据，没有更换DSH_HOME或改全局配置。
Codex接手全部修改权。没有DSH报告，因此任务保留待补审，不把配置权限问题误报为凭据、网络或配额错误。

## 检查点与 R01-R12

开始前已读项目入口、记忆、规范、BASE-001和现有脚本，确认Git基线与完整产物保护；修改前明确局部范围。
第一条链路核查：最终npm入口在前检失败处退出，build/tests未启动，快照比较验证其未更改原产物。
本轮无新公共设备接口定稿、无设备/外部服务接入或范围扩大；交付前检查最终diff、保护差异、profile一致性及残留进程。

| 标准 | 结果与依据 |
|---|---|
| R01 | 通过限定局部实现：可复现诊断入口完成；完整基线仍受阻 |
| R02 | 通过：复用现有平台验证脚本，产品模块/调用关系不变 |
| R03 | 通过限定开发工具：默认入口兼容，新增flags和退出码有说明；设备协议/schema不变 |
| R04 | 通过：参数冲突拒绝，子进程error/signal/输出显式检查，测试源清单独立核对 |
| R05 | 通过限定本轮：只运行离线Fake/mock，未打开串口或批准真实发送 |
| R06 | 不适用：不改变发送/停止/unknown实现或证据语义 |
| R07 | 未验证完整IPC：前检准确报告EPERM，不能验收真实IPC并发 |
| R08 | 通过：未解除保护、改凭据、对外联网或扩大控制权限 |
| R09 | 通过限定已运行范围：临时探针目录清理；未发现项目daemon/rig服务残留；成功/超时清理路径未全验收 |
| R10 | 未通过完整门槛：构建和专项通过，成功前检/全仓/Windows/Julia未验证 |
| R11 | 通过：Git基线+忽略产物快照，最终差异复核 |
| R12 | 通过：DSH失败、环境阻塞、定点通过和未验收范围明确分开 |

## 后续门槛

在允许Node子进程输出、本地IPC/HTTP监听的原生环境运行npm run test:preflight、npm test、npm run test:built；成功前检后才能对剩余失败逐项分类。
完整源码/编译回归通过且DSH补审完成后，才能验收本任务并进入依赖该基线的设备回归；统一契约草稿可独立准备，不能跳过相应验收门槛。

## v2 续办：完整回归与默认Fake入口修复

日期2026-10-15，执行与复核Codex，用户要求继续既定工作；DSH未成功产出审议报告。本段替代v1的当前环境阻塞结论，历史失败日志仍保留。

保护：Git起点`fb5cbc2`干净；修改前完整快照`.local-backups/20261015-base002-resume/workspace-before.tar`，SHA256 `b1f97bb21d0322acff6f50f60b1c94b94faf2388830ac9695e5f3484f0ccdfa8`，tar比较exit0。源码修复、文档、构建、测试日志与新增开发依赖均在此保护范围内；新增node_modules/@esbuild/win32-x64原先不存在。

### 发现与修复

Windows编译首轮：331通过、29失败、9跳过、exit1。29项失败日志均含缺失`@esbuild/win32-x64`，集中在默认Fake客户端启动的两套件；客户端不论自身是否编译，都因apps/rig-faked.ts存在而选择tsx源码子服务。其他显式编译入口路径可正常工作。这是已证实的S2启动模式缺陷，不是CI-V或发射状态机缺陷。

`packages/rig-control/src/client.ts`默认入口现随模块模式：源码.ts选择源码入口，编译.js选择dist/apps/rig-faked.js；显式entry不变。编译模式缺产物仍报启动失败，不回退源码。无需改变协议、设备控制或批准/unknown语义。最终SHA256 `52d24986d2d518a615f6726f69f56302c45c8ed07c855e6f07364468f811c3d3`。

Windows编译v2在未安装Windows esbuild时已零失败，证明修复没有被安装依赖掩盖。随后为Windows源码模式下载锁文件已有`@esbuild/win32-x64@0.28.2`，独立计算SHA512与package-lock精确相等后解包；Linux可选包和package/lock保持原样。下载日志、原包保存在本轮备份目录。

### 实际回归

日志均在上述备份目录。Linux Node24.18.1、Windows原生Node24.16.0（D盘node.exe）；所有完整测试保留文件隔离、25个文件、369项，结果不相加。源码/编译和跨平台并未出现产品控制协议差异。

| 命令 / 日志 | 退出码与结果 |
|---|---|
| Linux --preflight（工具输出；完整入口日志亦含五项） | 0，五项均通过 |
| Windows --preflight / windows-preflight-v1.log | 0，五项均通过 |
| npm test / source-v1.log（修复前） | 0，361通过、0失败、8跳过 |
| npm run test:built / built-v1.log（修复前） | 0，361通过、0失败、8跳过 |
| Windows --built / windows-built-v1.log | 1，331通过、29失败、9跳过，失败原始证据保留 |
| npm run build / build-v2.log | 0 |
| npm test / source-v2.log（最终） | 0，361通过、0失败、8跳过 |
| npm run test:built / built-v2.log（最终） | 0，361通过、0失败、8跳过 |
| Windows --built / windows-built-v2.log（最终） | 0，360通过、0失败、9跳过，原生bridge构建成功 |
| Windows --source / windows-source-v2.log（最终） | 0，360通过、0失败、9跳过，原生bridge构建成功 |

Windows命令使用`'/mnt/d/Program Files/nodejs/node.exe' scripts/verify-platform.mjs --built`或`--source`。Linux八项跳过均为Windows桥接专属。Windows九项跳过：三项Unix状态服务IPC、三项Unix配置/文件权限、三项符号链接权限；信号校验另有内部symlink分支诊断跳过。因此不宣称所有Windows分支全覆盖、权限扩展或实机重验。没有打开COM17、发射、改用户数据库/设备账本或运行Julia。

最终四份日志SHA256（顺序对应上表最终源码Linux、编译Linux、编译Windows、源码Windows）：

- source-v2.log：`fb5b578c640e05da8a2785b32937134f7d08b71ade6c507fb1b693a735d595b0`
- built-v2.log：`3350d110accb23da865e30262a505ef70bea3cdcd28d7abfdab3ff55d57f98a6`
- windows-built-v2.log：`e5cbfcf99824e5c59d6776ab7a21a46163ad956dac1d04482b9a69c8b28ca9e2`
- windows-source-v2.log：`b76262f35b33335e8ecbcb09b01a6e251a17d9f2068b6bacf6251c1f85f508b0`

### DSH与阶段自查

调用既有`DSH_HOME=/home/li0214/.dsh dsh --profile headless`只读补审，返回API HTTP 402、exit1，原始日志dsh-review.log；没有报告，不能作为交叉审议。未读取凭据或改全局profile，非凭据cordis.yml与修改前副本cmp一致；不反复重试或解释成已经证实的凭据/配额原因。

开始前核对AGENTS/MEMORY/任务/进度与Git，建立完整保护；第一条完整回归核查前检成功与隔离；Windows失败后证实根因，将单文件局部修复明确纳入任务范围且确认已在基线内；修改后diff及两平台源码/编译复验；交付检查保护差异和进程残留。无公共接口定稿或设备接入检查点。

最终保护比较：`tar -df`逐项核对data、AGENTS、rig.sh、tests、apps、package/lock、scripts、native及node_modules所有基线文件，无差异、exit0（新增可选包单独列明，tar比较不检查额外文件）；Git仅六个预期文件变更，diff --check通过。dist为明确构建输出，logs新增临时测试daemon日志；用户数据与既有测试/设备实现未改。Linux进程查询与Windows CIM查询均无本轮daemon/rig服务/headless残留；已有DSH web进程未操作。四份最终日志独立断言五项前检通过、369项、fail0且没有not ok，exit0。

| 标准 | v2结果与依据 |
|---|---|
| R01 | 通过执行范围：完整回归与单文件启动修复，补审仍未完成 |
| R02 | 通过：复用现有客户端与子服务，无新宿主或旁路 |
| R03 | 通过局部兼容：默认入口随运行模式，显式entry及协议/schema不变 |
| R04 | 通过已有回归：非法参数、帧、响应及启动失败覆盖；未放宽校验 |
| R05 | 通过离线范围：全程Fake/mock与临时数据，无真实设备批准 |
| R06 | 通过已有离线回归：停止/超时/unknown未改；真实停止证据未验证 |
| R07 | 通过已覆盖IPC回归；Windows状态服务Unix专属用例仍跳过 |
| R08 | 通过已覆盖范围：Windowsbridge测试执行；无第二用户/远程登录验收 |
| R09 | 通过已运行故障/生命周期用例与残留检查；全局profilecmp一致 |
| R10 | 通过四种完整回归，无失败；明确平台/权限跳过，不外推设备 |
| R11 | 通过：Git基线、完整快照及最终diff/保护比较 |
| R12 | 通过：保留首轮失败、旧环境和DSH失败，当前状态待补审 |

结论：当前环境与已发现启动缺陷已处理，四种完整回归零失败；BASE-002待DSH补审后再作最终验收。可准备P2-016草案，不能据此跳过公共接口确认或进入真实设备回归。
