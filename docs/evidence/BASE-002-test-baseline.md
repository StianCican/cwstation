# BASE-002 v1 测试基线执行与自查

日期：2026-10-15。实施/复核：Codex；DSH未执行成功，不能作为交叉审议记录。
状态：局部验证入口已修正，待DSH补审及完整回归；未验收完整测试基线。

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
