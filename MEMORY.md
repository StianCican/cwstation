# CW Station 项目记忆

更新日期：2026-10-15。

## BASE-002 可复现测试入口（2026-10-15）

- 用户同意后续规划，当前执行测试基线第一项。Git起点81ee2d6干净；忽略产物另做`.local-backups/20261015-013904-test-baseline/workspace-before.tar`完整目录快照，tar比较exit0；没有修改AGENTS、产品源码、测试源码、用户库或试验账本。
- 已证实当前环境的最小Node子进程探针可同时返回`status=0`、`error.code=EPERM`、空stdout；异步Node子进程同样空输出，本地socket/HTTP监听EPERM。这解释一类空JSON/子服务退出假象，但不宣称逐项关闭此前全部失败。
- 复用scripts/verify-platform.mjs统一源码/编译版验证入口，加入环境前检、清单/帮助/参数拒绝和启动错误检查；两个模式发现同一25个测试文件，包含此前遗漏的服务内套件。npm test/test:built前检失败exit2，不build/跑产品测试；新增npm run test:preflight。正常成功路径和Windows路径本轮未验收。
- 实际build exit0；四套件civ-context-read/civ-read-arbiter/serial/civ-tx-plan以关闭隔离方式做定点诊断，源码61/61与编译版61/61，无跳过，不相加或外推全仓通过。最终前检/源码/编译入口均exit2准确报告环境阻塞，清单独立glob核对exit0。
- DSH调用沿已有DSH_HOME/headless，启动写cordis.yml遭EROFS、exit1；配置cmp不变，无任务执行/审议，不改凭据或全局profile，Codex接手局部修正。任务`docs/tasks/BASE-002-test-baseline.md`与证据`docs/evidence/BASE-002-test-baseline.md`；状态待DSH补审，完整回归基线未验收，不能进入设备回归。

## 进度核查与 Git 基线（2026-10-15）

- 用户要求检查进度、建立 Git 并规划后续。本轮只改版本管理入口和进度文档，不改产品源码/tests/控制协议，不接真实电台。AGENTS.md 保持原文，其 Phase 0 描述不代表当前进度。
- `.git` 被当前环境挂载为只读空目录，标准初始化失败；已在 `.git-local/` 建立 main 分支，初始源码提交 `14a4e92`。用 `bash scripts/git-local.sh status` 等操作，普通 Git 自动发现暂不可用；无远端/发布。本地临时作者为 `CW Station Contributors <cwstation@localhost>`。
- 非 Git 修改前完整目录保护：`.local-backups/20261015-011147-progress-git/workspace-before.tar`，`tar -df` exit0 无差异；包含既有源码、产物、依赖、日志和数据，不是 SQLite 在线一致性备份。运行数据/账本保留但不入库，后续仍须单独备份。
- 本轮 build exit0，仲裁/serial/tx-plan 专项36/36通过；npm test 与编译版全仓均失败。关闭测试隔离的源码诊断共360项，230通过/122失败/8跳过；服务内单独9项为6通过/3失败。部分为本地socket监听EPERM，另有子进程提前退出/空输出等待归因，不能标记全仓通过。Windows/Julia/实机未在本轮重验。
- 已更新 README/ROADMAP，新增 `docs/PROGRESS-20261015.md`、`docs/GIT.md` 和 `docs/evidence/BASE-001-progress-git.md`。下一步先复现并分类回归失败，再按已确认方向设计统一操作契约、接入既有宿主、Fake故障矩阵、受控实机回归；规划尚未作DSH设计审议，不作为公共契约定稿。

## P2-015 受控 CW 发送闭环（2026-10-15）

- 按用户要求合并推进：P2-014 八查询仲裁新增离线动态验证 6/6；新增显式 `rig-controld --cw-trial` 受控试验入口和 `scripts/cw-trial.sh`，默认 `rig.sh` 与只读服务不变。
- 新增 `openCwTrialSerialTransport`，要求 `confirmKeyingOff:true`，固定 19200/8N1、唯一串口生命周期；只放行八项固定读取、Command 17 的 `E`/`TEST` 和 `17 FF` 停止。原 `openSerialCivTransport` 仍只读，未开放任意 raw write、PTT、设置、重试或重连。
- `packages/cw-trial` 使用单 transport/parser/在途槽，发送前读取显示频率、模式、TX频率/TX状态、Split、RIT、XIT、Break-in，用户确认后重读并绑定实例/报文/上下文；一次会话最多一条报文，可显式请求停止。FB/FA、RX、功率0、时间估计均不作为完成/停止证明。
- 发送 intent 写入 JSONL 后 `fsync` 才允许写串口；任何 intent、损坏或超限记录均保持 unresolved，重启不会自动清除或再次发送。记录、预检和停止结果均保守保留 unknown 语义。
- 验证：`tests/civ-read-arbiter.test.ts`、`tests/serial.test.ts`、`tests/civ-tx-plan.test.ts` 定点回归 36/36；`npm run build` exit0；模拟 `E` + `17 FF` 流程 exit0，同记录目录再次运行 exit3；`bash -n scripts/cw-trial.sh` 和帮助输出通过。WSL脚本调用 D 盘 Windows 原生 Node，可用 `CWSTATION_WINDOWS_NODE` 覆盖。未打开 COM17、未触发真实写入、未做射频验收。证据 `docs/evidence/P2-015-受控CW发送闭环.md`，任务 `docs/tasks/P2-015-受控CW发送闭环.md`。
- 保护基线：`/mnt/d/AI/project-backups/cwstation/20261014-234652-consolidated-cw/`。DSH 在完成仲裁实现和 6/6 后因配额退出，Codex 接手审查并补齐启动脚本/证据/记忆；真实电台试验仍需用户明确允许并提前核对 IC-7300 设置。
- 现场短报文试验已完成：用户通过 `bash scripts/cw-trial.sh --port COM17 --confirm-keying-off --message E` 接入 IC-7300。实读 `14250000 Hz / CW / FIL2`、TX频率一致、TX状态 RX、Split/RIT/XIT OFF、Break-in SEMI，8项预检全部通过；用户输入 `E` 后发送结果 `ack_observed`，随后输入 `S`，停止帧 `17 FF` 结果也是 `ack_observed`，最后 `Q` 退出。两次 FB 只证明 CI-V 命令应答，不能证明实际 CW 键控完成或已停止；功率0也不构成停止证明。COM17 应已由脚本释放，仍不把本次结果推广为射频完成/停止验收。现场文档追加前备份：`/mnt/d/AI/project-backups/cwstation/20261015-real-cw-trial-docs/`。
- 用户随后确认听到 IC-7300 侧音。该观察将证据提升为“本机 CW 键控路径有可听反应”，与 `FB` 和停止命令应答相互吻合；侧音不是外部射频监测，仍不能单独证明天线端实际发射、报文完成或停止时刻。追加文档前备份：`/mnt/d/AI/project-backups/cwstation/20261015-audible-reaction/`。
- 后续实现必须遵守统一设备操作接口：CLI、未来 UI、AI 提案和 Fake 适配器只能调用同一版本化操作契约；真实串口由唯一设备持有者持有，试验 CLI 不得继续形成旁路。批准、预检、发送、停止、记录和 unknown 语义集中在接口实现/设备服务边界，Julia/MWORKS 只做离线分析与向量，不直接访问电台。统一接口迁移是下一完整阶段，不把当前实机试验入口直接扩展成第二套公共协议。该记忆追加前备份：`/mnt/d/AI/project-backups/cwstation/20261015-unified-interface-note/`。
- 后续实施规划已确定：先把统一设备操作接口接入既有 `rig.sh -> rig-launch -> rig-controld` 链路；`bash rig.sh` 默认继续只读，受控 CW 通过显式模式进入，设备持有、监督、退出释放和错误状态仍由既有宿主负责，不新增第二串口进程或旁路协议。随后用 Fake 完整验证状态读取、批准、发送、停止、故障和 `unknown` 阻断；再用当前零功率 COM17 回归验证预检、`E`、侧音、`17 FF` 和退出释放。上述通过后才扩展短报文和记录查询。该规划写入前备份：`/mnt/d/AI/project-backups/cwstation/20261015-rig-plan-memory/`。

## P2-014 A 离线统一查询仲裁（2026-10-14）

- 用户继续，新增内部civ-read-arbiter.ts及context-projection.ts；显式start初对03/04、八查询单槽、两外部操作、批次间插状态对、AbortSignal取消、固定期限TTL/过期锁存/有界关闭已静态实现。背景每状态对一次context机会，不连续空转；source恒simulation，无串口工厂/重连/发送。
- DSH实施与最终只读审议exit0，Codex保存交接稿并修正生命周期/期限/后台节奏。首轮typecheck泛型错误日志保留，修正后typecheck/build exit0。未新增或运行测试、会话/服务/串口/DB，无Windows/硬件验收；候选投影仅类型/能力摘要，未实现IPC校验、维护或监视台映射。
- 保护基线/mnt/d/AI/project-backups/cwstation/20261014-p2-014-arbiter/含源码/产物/文档/日志/记忆及非凭据Harness配置，另存dsh-handoff/pre-type-fix。packages仅两新模块，dist六新产物，apps/tests/真实serial/rig.sh/批准契约不变。哈希/R01-R12见P2-014证据及REV-015。
- DSH工具无apply_patch而用create-only write，创建方式偏离已记录，无既有文件覆盖；下轮委派先提供可用外部apply_patch，无法使用则只读反馈由Codex落地。所有Codex修正用apply_patch。
- 下一步B为明确授权的离线时序专项测试，C再接真实只读服务。需要电台时提前通知用户，当前不需要接入；静态/编译结果不是功能或设备验收。

## P2-013 只读接入契约细化（2026-10-14）

- 用户请求细化。新增实施契约v3.1，经DSH三轮只读交叉审议、Codex收口，通过离线候选设计验收；最终哈希b8040e25ad342c73feab182b429655cf51f266002d939ee5784b696e0574a546，见REV-014。
- 查询槽全局1、外部操作容量2，03/04可插入六项批次；目标1s轮询非完成保证，query2s/operation30s、status TTL3s/context TTL6s。维护10s总deadline、close2s/open5s阶段min剩余预算，pending-open未释放不再开口。
- 能力schema与摘要、unverified身份、收包monotonic过期规则、继承维护IPC的sequence/deadlineNs字段已明确。hrtime跨进程同源必须B验证，不通过禁维护；真实批准/发送继续全禁，不伪造硬件身份。
- 非Git修改前基线/mnt/d/AI/project-backups/cwstation/20261014-p2-013-contract/及各审议稿保存；本轮仅文档/日志/记忆，无源码/tests/dist/rig.sh改动，无测试/build/服务/串口/DB操作。下一步A离线候选实现；B动态验证另授权，C实际电台接入时提前通知用户，当前不需要接入。

## P2-012 真实只读接入方向审议（2026-10-14）

- 用户继续；Codex形成唯一设备持有者的接入方向设计v4，DSH四轮只读交叉审议完成，最后无未解决S0/S1/S2。Codex只验收后续设计输入，未冻结公共契约，见REV-013。
- 明确03/04与六项查询共用仲裁/解析/在途槽位，公共source及协议v1保持，新增context独立；候选C重连拟经受监督维护RPC，尚未实现，不改变当前rig.sh行为。
- 实施前仍须确定队列上限、轮询/批次截止规则、TTL、维护RPC认证、能力schema和设备身份来源；本地ID不能证明物理回复归属。重连开始就撤销旧结果，真实端口释放探测同样须提前通知。
- 本轮仅新增/修订文档及审议日志，没有测试/build、源码修改、COM17开口或数据库操作。保护基线为20261014-211211-context-session/p2-012-pre-edit；需要电台时提前通知用户，当前不需要接入。

## P2-011 离线上下文读取会话与展示（2026-10-14）

- 用户同意继续，并要求需要接入电台时提前通知。本轮按设计v2完成注入式 `CivContextReadSession` 和监视台可选 `SIM CONTEXT` 字段；固定六项只读查询、单操作互斥、迟到回调隔离、故障锁定、有界关闭及 monotonic TTL 已实现。
- 新会话不从 index 导出，不接 serial/IPC/service/批准/rig.sh；监视台没有日常服务赋值，新字段不是实机数据。`source=simulation`，不能作为批准、完成或停止证据。
- DSH实施并静态自查，Codex复核；源码哈希与R01-R12见 `docs/evidence/P2-011-离线会话与展示.md`、`docs/reviews/REV-012-P2-011-Codex复核.md`。非Git修改前基线 `/mnt/d/AI/project-backups/cwstation/20261014-211211-context-session/`，交接稿在 `dsh-handoff/`。
- `tsc --noEmit` 和 `npm run build` 均 exit0；本轮没有新增/运行测试、没有打开COM17或接入真实电台。下一步先做离线时序验证，再设计统一设备持有者的真实只读接入；到需要电台时通知用户具体步骤。

## P2-010 上下文读取离线测试（2026-10-14）

- 用户明确要求测试。新增tests/civ-context-read.test.ts专项25项，独立手册报文/频率样例、六种解码、所有枚举、五位置全部BCD字节、非法结构/容器/kind、稀疏及原型索引、长度前置检查、plan副本保护及原串口门不扩展。最终测试v2 SHA256 fc91ad055b1880ff84fda385cfc6861c10c164f41be63a85e46492bf93a58e1b。
- Linux Node24.18.1源码/编译、Windows原生Node24.16.0编译三套件均62/62，无跳过（含专项25与civ/tx-plan37，不相加重复结果）；v1专项单独25/25。最终类型检查/构建exit0，v2日志保存exit，Windows保存win32/execPath。没有全仓/硬件验收。
- 首轮61通过1失败为Codex人工BCD样例错一位，解码正确；修正测试数据为00 80 10 14 00对应14108000Hz，不改产品。失败日志/测试首稿保留。DSH首轮审议及v2定点复审均exit0，Codex补getter证明先检查长度、更多容器拒绝和全parser切点，最后无剩余实质缺陷；限定离线测试通过，见REV-011。
- 产品packages无差异，源码仍3adb63a1…；tests仅新增专项；dist仅新增模块/测试各.js/.map/.d.ts。非Git修改前基线/mnt/d/AI/project-backups/cwstation/20261014-204824-context-tests/包含packages/tests/docs/logs/dist/MEMORY和非凭据headless配置，修正前稿亦保存。日志全部分版本保留，无串口/服务/用户DB账本操作。
- 下一步可设计并实现读取会话中的新命令串行调度、响应关联/过期与状态展示；实际串口白名单仍03/04，不直接启用新查询或发送。真实返回/固件/Split与∂TX关系及完成/停止证据尚待验证。

## P2-009 上下文读取离线编解码（2026-10-14）

- 用户同意继续。按P2-008输入完成单独内部纯函数模块packages/devices/src/civ-context-read.ts，六种kind为txFrequency/txStatus/splitEnabled/ritEnabled/xitEnabled/breakIn。固定94/E0，plan输出副本及dryRun:true/executable:false，精确白名单禁止任何设置数据；严格响应地址/命令/子命令/长度/枚举校验，TX频率复用既有BCD解码。
- DSH设计交叉审议exit0无实质缺陷后实施唯一新源码并静态自查；Codex接手前保存dsh-handoff，再补响应data上限32及数组自身索引检查，设计升v2。DSH定点复审exit0无具体缺陷，Codex限定静态交付验收，见REV-010；最终源码SHA256为3adb63a1e3dcd395e881bfc0a9ed96e6becf5b396624260b0d9552e1da538afd。
- 未添加/运行测试、typecheck/build、项目服务或设备；编译和运行行为未验证。新模块不从index导出，无CLI/daemon/串口引用，原serial.ts仍只放行03/04，真实发送门禁不变。null不是默认RX/false，也不能证明当前事务归属、完成或停止。
- 非Git基线/mnt/d/AI/project-backups/cwstation/20261014-184922-context-codec/保护原packages/docs/logs/MEMORY及非凭据headless配置，dsh-handoff保存DSH源码/原设计/任务。三次Harness均退出，日志分开保留；既有产品源码未改。
- 下一步先进行明确授权的离线专项测试/类型检查，覆盖六报文、非法输入、稀疏/原型索引、长度上限、枚举/BCD、计划副本不改变白名单；通过后再设计读取会话/仲裁及实际设备接入。不能把本轮静态验收当作电台已能读取新字段。

## P2-008 先查说明书的发送证据调查（2026-10-14）

- 用户要求先查说明书。Codex读取同一原PDF并保存摘录/哈希；DSH只读交叉审议exit0，无S0/S1/S2。Codex保存v1、补FB格式来源并修订v2，限定静态调查通过，见REV-009及P2-008证据；未测试/build/接串口或实施新能力。
- 手册明确1C 03读TX频率（19-7/19-9）、1C 00读RX/TX（19-7）；0F读Split、21 01/02读RIT/∂TX开关、16 47读BK-IN；25/26读Selected/Unselected VFO频率/模式，不等于固定A/B。14 0C速度级别仅给6/48WPM端点，不据此线性估计完成。
- Full Break-in抬键即RX（4-16），Semi延时回RX（4-15）；RX不证明消息完成。17 FF手册说明停止消息，但未建立操作关联/队列清空证据。19-8脚注说明CW下TRANSMIT/外部TX或Break-in ON时电脑消息会发射，不能假定没软件PTT就不会发射。
- DSH F3建议07纳入只读调查，Codex根据19-3 Select/Equalize/Exchange设置语义纠正，07不纳入只读白名单；1C 02是TX频率monitor设置，后续可调查读取，不替代1C 03。当前serial.ts仍仅03/04，真实发送门禁不变。
- 基线/mnt/d/AI/project-backups/cwstation/20261014-183545-manual-investigation/含原docs/logs/MEMORY及非凭据headless配置，另存修改前P2-008 v1。下一步优先形成扩展只读命令编解码/精确白名单的离线方案；实机返回、完成/停止证据及其他官方补充资料仍待核查。

## P2-007 IC-7300真实适配器设计审议（2026-10-14）

- 用户同意本轮设计与DSH审议。新增P2-007真实适配器设计v2，已限定验收为后续设计输入，不是实现基线/真实写入授权。阶段A证据调查、B离线与公共契约专门设计、C只读迁移、D单独受控证据试验、E产品发送各有门禁；当前E禁止。
- 明确现状rig-controld仍是rig-statusd只读委托，rig-faked才是私有Fake子服务。建议扩展前者作真实唯一串口持有者，后者保留无串口模拟替身，公共状态与私有控制通道分离。真实v2独立于Fake v1，不放宽现有来源/证据检查。
- 实际TX上下文/证据能力版本需显式摘要持久化并绑定批准，公共契约/schema变更另确认。未关联FB仅ack_observed；write/FB/FF/RX瞬间均不能证明完成或停止。真实keyedCount缺证据默认null，不能复用simulation计数。设备账本缺失检测/unknown解除及证据路线未解决前不能开放产品发送。
- DSH首轮与v2定点复审均exit0，S2入口映射/手册追溯修正；S3修正或交A/B/E门禁，无新S0/S1/S2。Codex最终限定设计输入验收，见REV-008；日志P2-007-dsh-design-review和P2-007-dsh-v2-recheck保留。没有自动测试/build、串口/设备/用户DB或账本操作，产品源码/tests/dist/rig.sh未改。
- 原PDF静态再核查：Command17命令表印刷页19-4，字符表及FF/^在19-13。旧历史MEMORY/connection-notes的19-3页引错误，以docs/evidence/P2-007-手册复核.md及摘录日志为准；保留历史原文，不把手册停止表述推广为可靠停止证据。
- 非Git修改前备份docs/logs/MEMORY及非凭据headless配置到/mnt/d/AI/project-backups/cwstation/20261014-173313-real-adapter-design/；首稿及reviewed-v2也存入此目录。DSH子进程排除代理，未改全局配置/凭据；下一步先调查真实完成/停止证据和TX上下文，不直接实现或启用真实发送。

## P2-006 设备禁发隔离与Fake恢复演练（2026-10-14）

- 用户继续既定离线验证/恢复任务。新增独立用例：原Fake账本unknown、同身份重启，全新核心blockedReason=null且unresolved=0仍因设备blocked拒绝批准，无approval/send；核心解除因backendDisconnected拒绝，原operation unknown/账本全文不变。全新核心仅测试隔离，不是生产恢复绕过。REV-006a-F1测试缺口已关闭。
- DSH源码四套件48/48并交叉审议；Codex最终源码48/48、Windows最终remote8/8。本轮Windows首版四套件合计47通过1项symlink跳过（包含remote八项，不与最终remote再相加），Linux编译首轮48/48；最终构建exit0。首轮测试cleanup挂起已修正，失败日志/现场保留。运行产品源码未改，dist仅测试产物更新。
- 新`tests/recovery-drill.mjs`实际Linux Fake CLI演练：父死保存DB/WAL/锁现场、一致backup/inspect、restore到新文件并只读核查unknown/有效批准0；原DB重启恢复及人工解除后原ID仍unknown/keyedCount0；合成guard锁拒绝、保存/隔离后重新备份核查。最后脚本exit0，具体步骤验收通过；恢复新库未启动、完整人工归属/WindowsCLI/真实磁盘/设备停止未验证。
- DSH两次定点复审exit0，Codex按最终哈希/日志/差异裁决限定P2-006通过，见REV-007-Codex复核。保留S3：早失败/tmp证据自动归档hook、新库切换启动、clear-storage-fault持锁拒绝专项等；不能把本轮推广为整套恢复规程或实际发射验收。
- 基线`/mnt/d/AI/project-backups/cwstation/20261014-device-block-test/`包含修改前apps/packages/tests/docs/logs/MEMORY/README及构建前dist。最终演练产物归档cli-drill-v5.tar，失败现场也保留；socket本体数据盘不支持，另存stat元数据，其他产物已核对。不操作用户DB/账本/锁、不打开COM17。Linux/Windows本轮测试服务已退出。
- 下一步形成真实IC-7300发送适配器设计稿并DSH设计审议，明确唯一持有者、执行/停止证据与unknown；尚未实施真实写入或开放真实发送。

## P2-005 DSH通道恢复与审议闭环（2026-10-13）

- 用户同意诊断DSH并补审。相同无工具单句任务：继承HTTP_PROXY/HTTPS_PROXY（172.24.160.1:18060）exit1/STREAM_CLOSED；仅DSH子进程移除大小写代理变量后exit0/DSH_OK。由此取得可用直连路径，未定位代理内部原因，未改全局代理/DSH配置或模型，未读取/复制凭据。后续项目DSH调用可沿用env -u六个代理变量的单次方式，原DSH_HOME/profile不变。
- DSH REV-006a/b均exit0有效交付，Codex独立核对对象哈希、源码依据和报告；无已证实S0/S1/S2行为缺陷。DSH复核P2-003d七份日志哈希与计数；P2-003e动态证据沿用此前实际日志，本轮只读审议未重跑。恢复规程五项S3已修正，REV-006c定点复审exit0/PASS且哈希一致。
- Codex裁决：P2-003d限定离线动态验证、P2-003e限定离线实现及已验证运行范围、P2-004文档范围验收通过；补审不再待完成。原段落的待审状态保留历史，下方task/evidence均加更新注记。真实设备/射频、恢复演练及完整故障矩阵没有通过本轮验收。
- S3后续：设备账本blocked需要与核心unknown分离的专项用例；重复rig-endpoint处理维护；Windows继承的外部Job仍可能强杀；session.close受client期限和宿主watchdog约束；账本无完整防篡改/缺失检测。负责人Codex设计/复核、DSH执行，先补隔离验证与恢复演练再进入真实适配器设计。
- 基线`/mnt/d/AI/project-backups/cwstation/20261013-dsh-diagnosis/`含MEMORY/docs/logs和非凭据headless-profile，最终profile内容diff无差异。headless --help在profile保护前调用的保护证据不足已记P2-005，未主动改配置。产品源码/tests/dist未改，无测试/build/串口或用户数据操作；DSH调用均退出。
- 任务/证据P2-005，最终裁决`docs/reviews/REV-006-Codex复核.md`；原始报告日志REV-006a/b、复审REV-006c及代理/直连对照均保留。

## P2-004 恢复规程与补审（2026-10-13）

- 用户同意先补DSH审议并完善异常恢复。新增`docs/design/Fake异常恢复操作规程.md`，分类核心unknown、Remote Fake账本unknown/ledger_fault、存储故障、锁/guard残留；明确停机/进程确认、原始现场及一致快照、原配置重启、核心人工核查与停止条件，README增加入口。
- Remote Fake账本unknown当前没有解除接口；核心resolve-unknown不能解除设备阻止，不能换DB/后端/设备ID或删除账本绕过。锁残留只在冻结所有启动、确认进程归属及完整备份后人工隔离确认为残留的guard/坏锁；本轮未实际操作用户锁或数据。
- Codex静态核对命令及源码完成，没有改运行代码、tests、dist，没有测试/build或设备接入。DSH REV-005a/b两次缩小范围只读调用仍exit1/STREAM_CLOSED，均无报告；P2-003d/e与本轮保留待交叉审议，不标最终验收。下一步需诊断Harness流失败再补审，暂不进入真实发送实施。
- 非Git修改前cp -a保护MEMORY/README/docs/logs到`/mnt/d/AI/project-backups/cwstation/20261013-recovery-review/`。任务/证据P2-004，复核`docs/reviews/REV-005-Codex补审记录.md`；新日志REV-005a/b保留，所有DSH进程已退出。

## P2-003e 显式Remote Fake入口与监督（2026-10-13）

- 用户同意离线继续，今天不接电台。daemon新增显式`--remote-fake-ledger <dir>`，与真实只读`--rig-endpoint`互斥；独占核心DB/端点后启动私有Fake子进程，固定模拟设备身份，禁止dev.state，无自动重启/重发。默认进程内Fake和真实只读入口保持。
- RemoteFakeSession合并能力/快照刷新、后台观察并撤销过期批准；批准和执行均检查设备上下文，RemoteKeyer执行前独立预检。设备账本unknown继续阻止新批准，核心resolve-unknown不能解除设备阻止。状态keyedCount为null表示无实际执行次数证据，executionMetrics只记录当前进程已确认的模拟结果/发送尝试。
- 关闭要求设备关闭响应、子进程exit0且无强杀/失联；核心关闭、刷盘或监督失败非零退出。Windows父死测试暴露libuv默认Job强杀子进程打断EOF锁释放；Fake客户端仅Windows使用detached spawn，仍保持引用、私有管道和宿主有界等待，不unref。原锁算法未改，不自动清除未知guard；修正后父死/重启专项30/30通过且零重放。
- Linux源码回归148/148、编译含锁测试153/153；Windows原生核心/daemon/批准门禁/新入口/锁108通过2项Unix权限跳过，隔离编译RemoteKeyer/设备IPC43/43。最后关闭退出码修正后的新入口两平台各7/7；构建通过。测试全用隔离DB/账本/随机端点，没有COM17或实际发射。最终未发现本项目Linux/Windows服务残留。
- Codex完成最终差异与R01-R12复核；DSH实施及交叉审议多次STREAM_CLOSED，无有效报告。状态为离线实现与Codex复核完成/待DSH交叉审议，未标最终验收；P2-003d补审也仍待完成。下一步先补审，再完善恢复操作和真实适配器设计，不能直接打开真实发送。
- 非Git基线`/mnt/d/AI/project-backups/cwstation/20261012-2350-remote-fake-entry/`，含apps/packages/docs/tests/logs/dist/MEMORY/README；codex-v1/v2保存修正前态，parent-crash-evidence保留失败现场。任务/ADR/证据分别为P2-003e、0009和`docs/evidence/P2-003e-显式RemoteFake入口.md`。

## P2-003d 批准门禁离线动态验证（2026-10-12）

- 用户同意验收，并明确今天不能接电台。新增34项approval-gate专项，真实本地IPC/隔离SQLite/模拟报告源，历史批准由测试控制器显式预置；未操作COM17、真实设备或用户数据库。
- Linux源码/编译及Windows原生编译专项各34/34，覆盖频率/实际模式/连接代次/实例变更撤销、稳定采样、非法报告、refresh合并/close晚到、持久化故障/unknown保留、核心guard及三方法RPC迟到零副作用、显式daemon子进程只读绑定。类型检查/构建通过，产品源码与本轮基线无差异。
- DSH执行Linux既有回归87/87。Windows首次混合回归71通过14失败2跳过，Fake子进程优先源码触发共享Linux-only esbuild环境限制；保留失败证据。按既有隔离编译方法core/RemoteKeyer 50/50，核心/daemon/resolution另62通过2平台跳过，包含重复core用例不相加。
- Codex独立复核完成，DSH最终只读交叉审议三次均STREAM_CLOSED无交付，任务为离线验证完成/待交叉审议，不标已验收。完整故障矩阵、实际电台动态批准管理、实际发射仍未验收；今天不启动真机步骤。
- 修正P2-003c启动文档：Windows命名管道须Windows原生Node，不能在WSL Linux Node直接连接。保护基线/mnt/d/AI/project-backups/cwstation/20261012-approval-runtime/；tests/dist仅新增专项，logs由测试生成或追加。任务与证据P2-003d-批准门禁动态验收，详列哈希、命令、结果及待审议状态。

## P2-003c 核心设备批准门禁（2026-10-12）

- 用户同意状态变化撤销批准及批准前设备能力检查。核心新增可选同步approvalGuard，批准幂等返回前/执行intent前均检查；终态执行查询保留。沿用setState/invalidate持久代次，无协议/DB schema变更。
- daemon显式--rig-endpoint读取现有rig-statusd IPC，后台合并轮询；实例、连接代次、频率、真实模式及可用上下文改变撤销旧批准。相同指纹只更新采样时刻；非法/过期/无owner均拒绝。核心mode仍为操作契约CW，deviceMode才是设备观测。
- 显式绑定使用ReadOnlyRejectingKeyer，能力cwSend/cwStop/ptt=false，批准固定拒绝，keyedCount=0；Fake默认入口保持，绑定时fakeOnly=false/dev.state禁用。没有接真实发送，不启动第二串口持有者，不改rig.sh。
- Codex接手DSH初稿，修正采样时间不更新、初始/恢复撤销、RPC超时/断开晚到、IPC故障后清理及启动等待竞态。类型检查与构建退出0，源码/dist已更新；本轮无自动测试、无IPC运行或电台操作，动态撤销/跨平台故障验收待执行。任务P2-003c、证据docs/evidence/P2-003c-设备批准门禁.md。DSH只读交叉审议正常退出，源码修正确认；初稿哈希已更新，启动未就绪期间停机保守退出1记为后续退出分类优化。Codex裁决实现/静态审议完成，运行验收未执行。
- 非Git项目cp -a基线：/mnt/d/AI/project-backups/cwstation/20261012-approval-device-gate/，含源码/docs/tests/logs/dist/MEMORY，DSH交接前态保存在子目录dsh-handoff。最终diff确认四个既有源码及新增gate、相关dist/doc；tests/logs无差异。

## P2-003b rig.sh统一启动与监督（2026-10-12）

- 用户授权更新bash rig.sh。现调用rig-launch，私有fork设备持有者rig-controld与交互监视台；先端点/初读就绪再打开界面。初始monitor只status，C才reconnect。服务故障主动通知，即使P暂停也显示FAULT，无自动重启/重发。
- Q/监视台退出请求设备shutdown；服务等待启动/重连结束，关闭串口/IPC/history并提交released证据，宿主还要求exit0；超时/强杀/关闭失败均非零，保留logs/rig-launch-diagnostics.jsonl。关闭失败在同服务实例保留，不能重复stop清除或再次开口；父IPC断开触发本地清理。
- Windows/WSL经scripts/rig-launch-windows.ps1启动交互宿主窗口，参数用-File传递，COM名称校验，执行策略仅当前PowerShell进程Bypass。Linux直接exec同TS宿主。CWSTATION_PORT/--simulate保留；Windows模拟仍需IPC桥接。
- DSH初稿经Codex接手修正，最终DSH只读审议正常退出，Codex裁决与R01-R12见docs/evidence/P2-003b-rig启动监督.md。类型、Bash/PowerShell语法及构建通过；本轮未运行自动测试、未打开COM17或启动新界面，旋钮/拔插/退出释放与故障矩阵待运行验收。不要将P2-003a早先真机证据当成本轮新宿主运行证据。
- 完整cp -a基线/mnt/d/AI/project-backups/cwstation/20261012-rig-supervision/，交接副本dsh-handoff，README另有rig-readme-before.md。改启动/服务关闭/monitor与对应dist；串口白名单、核心批准管理、Fake发送协议、SQLite未改。
- 后续用户反馈“全部通过”：按上一轮明确的三项步骤，记录旋钮频率/模式同步、USB拔插后C恢复、Q退出后重新运行可连接的人工验收通过。证据来源为用户观察，Codex未独立采集此次运行日志或核验进程/端口句柄；不扩大为服务崩溃、父死子退、关闭失败或超时故障矩阵通过。记录更新前备份：/mnt/d/AI/project-backups/cwstation/20261012-p2-003b-user-acceptance/。下一阶段为核心设备状态映射、旧批准撤销及批准前能力检查，真实发送仍未开放。

## P2-003a 统一设备入口只读起步（2026-10-12）

- 用户同意真机只读与Fake故障验证并行推进。新增rig-controld兼容入口，复用旧RigStatusService与IPC；status/watch增加可选owner，声明服务实例、连接代次和只读能力。当前不接核心批准，不支持CW/PTT/停止，无持久硬件身份声明。
- DSH两次SSE中断留下源码，第三次静态自查正常退出；Codex复核并修正既有轮询故障遇关闭异常时未处理拒绝。类型检查和构建通过；未运行自动测试、未启动服务、未打开COM17，运行与真机验收待执行。
- 证据与审议裁决：docs/evidence/P2-003a-只读设备入口.md。修改前完整源码/logs/dist基线：/mnt/d/AI/project-backups/cwstation/20261012-readonly-owner-baseline/。DSH编辑工具偏离apply_patch要求已记录，不能隐去。rig.sh及串口白名单不变；手动新入口没有父进程监督，关闭监视台后需单独退出服务。
- 尚待实现：宿主监督、核心设备状态映射和批准撤销、批准前能力检查、显式Fake远程入口。P2-003a不是上述整体完成，也不是实际发射授权。
- 后续用户要求继续并说明电台连接：Windows原生新入口COM17/19200实测14.108MHz、USB、FIL2，10次watch/9份不同快照均ready，显式重连代次1→3；强杀服务树后重启实例变化，再次清理后原cwrig read可重新开口读取。DSH限定证据审议正常退出，Codex限定只读运行验收；未测旋钮变化/拔插/优雅关闭/关闭失败回归/批准撤销或发射。无项目服务残留，端口可用。备份20261012-readonly-live-check，详细证据与尾段原始输出见P2-003a记录；未改源码、dist、原logs或DB。

## 阶段自查与审议要求（2026-10-11）

- 用户要求每个任务结束审议，并在推进到关键阶段时自查项目是否偏离规范。正式标准为 `docs/design/任务自查与审议规范.md`，已接入AGENTS.md。
- Codex制定边界并最终复核；DSH执行实施自查或交叉审议，提交可定位发现及可复现证据。自报完成不等于验收；设计草案、已实现、离线验收和真实设备验收分别记录。
- P2-002首轮“设计完成”标记过早，已按审议修订v3作为Fake实现基线；完整故障矩阵与真实设备接入仍未验收。
- 已委派DSH执行REV-001静态交叉审议，报告 `docs/reviews/REV-001-DSH-P2审议.md` 已交付；Harness退出时SSE中断，Codex独立确认报告可读且24个对象哈希匹配。最终复核见 `docs/reviews/REV-001-Codex复核.md`：P2-002未通过实现基线验收，P2-001字符集符合性待核对修正。不得将DSH附条件建议或模拟结果当成最终验收。

## P2-001 IC-7300 发射准备干运行（2026-10-11）

- 后续审议修正：原始PDF19-13的Command17字符表已由Codex独立核对；DSH将全可打印ASCII改为77个手册码位（包含^控制字符），专项8/8和类型检查经双方验证，Codex构建通过。真源见 `docs/evidence/IC-7300-CW字符表核对.md`、P2-001-v2证据；早期“全部可打印ASCII”描述是历史实现，不再是当前允许集。
- P2-002设计已修订v3，Codex处理REV-002意见后作为Fake IPC阶段基线；真实串口迁移/写入另验收。P2-002a第一条跨进程Fake IPC链路已通过限定离线验收，见下节；默认daemon仍用FakeKeyer。

- 用户同意按“先离线规划、再真实适配器、最后封装”的顺序准备发射；当前电台保持零功率，但本轮仍不向 COM17 写入真实发射命令。
- 新增 `packages/devices/src/civ-tx-plan.ts`：根据 IC-7300 手册规划 CI-V `0x17` CW 消息和 `0xFF` 停止载荷，限制为最多30字节及手册Command17字符表；结果固定标记 `dryRun:true`、`executable:false`，无 transport/串口入口。
- `cwrig tx --dry-run --text <ASCII>` 与 `cwrig tx --dry-run --stop` 仅输出十六进制规划，不打开串口；`packages/devices/src/serial.ts` 的只读写白名单未修改。
- ADR见 `docs/adr/0008-IC-7300发射准备与干运行边界.md`，任务见 `docs/tasks/P2-001-ic7300-tx-dry-run.md`。下一步先处理统一设备持有者/IPC，再设计真实适配器、preflight、abort和unknown验收；不要直接把规划帧接到现有只读串口。

- P2-002 设备持有者设计已记录在 `docs/design/P2-002-设备持有者与受控写入.md`：禁止第二进程抢占 COM17，推荐由统一设备服务独占串口，daemon 的 `TxController` 通过受限 `RemoteKeyer` 调用结构化 `cw.send/cw.stop`，不提供 raw.write。该设计尚未实现真实写入。

## P2-002a Fake IPC第一条链路（2026-10-11）

- 新增packages/rig-control的协议、Fake服务及受监督客户端、apps/rig-faked.ts和专项测试。私有stdin/stdout NDJSON、会话HMAC、上下文/频率核对、稳定操作ID去重；停止不依赖已过期send token。
- intent刷盘后才模拟执行；JSONL恢复未决为unknown并禁发，不重放。账本限8MiB/10000条，复用既有单写者锁；损坏/外来/重复记录禁发。执行时CI-V地址持久化，历史帧不随当前配置重算。
- DSH首版测试挂起，Codex接手修正。全量只读审议超时未完成；随后DSH定点复核四项修正并正常退出，Codex独立20/20专项及类型检查通过。最终范围和R01-R12见docs/evidence/P2-002a-Fake-IPC.md与docs/reviews/REV-003-P2-002a复核.md。
- 仅限定Fake离线验收，未接核心RemoteKeyer、未改daemon/rig.sh/serial只读入口、未打开COM17；真实统一设备持有者/发射未实现。Windows、编译入口、全并发故障矩阵、stop各刷盘失败及schema迁移未验收。
- 下一步P2-002b：接入核心批准/撤销/unknown持久化，补矩阵并分开Windows验证；不直接将Fake通道接真实串口。未发布中间账本缺civAddress会禁发，不自动删除或迁移。
- cp -a保护基线：/mnt/d/AI/project-backups/cwstation/20261011-231732-p2-review-fixes/；包含任务前副本、DSH v1与Codex v2修正前副本，详见证据。进程已清理。

## P2-002b 核心授权与Fake IPC集成（2026-10-12）

- 用户同意继续；RemoteKeyer实现既有Keyer契约，TxController与SqliteJournal通过真实Fake子进程完成批准消费、发送、可靠停止cancelled、不确定unknown落盘与禁发、稳定ID重复零重发。预检复核P/A、能力/快照和响应关联；总deadline覆盖整次操作，send异常一次stop，无自动重连/重发。
- Fake服务核心stateGeneration改为最高已接受代次，intent成功刷盘后提升、账本恢复、拒绝回退；设备connection/permission代次独立，不等同核心当前授权。
- DSH首版SSE中断，Codex备份接手修正；DSH REV-004正式定点审议与时钟补审均正常退出，Codex最终Linux84/84、Windows原生隔离编译50/50、类型/编译通过。Windows正常快照被误判未来曾30次复现2次，限定20ms同机采样容差后定点30/30通过；21ms及过期快照拒绝，不延长批准期限。
- 最终限定离线集成验收；默认daemon仍FakeKeyer，无Remote选择CLI、动态状态事件、生产监督或真实串口迁移，未打开COM17。下一阶段先显式Fake远程入口/监督、批准前设备能力检查、执行计数未知表示及完整故障矩阵，再讨论真实适配器。
- RemoteKeyer.sendRequestCount仅IPC尝试数；不提供可选keyedCount，现有core缺值回退0有歧义，当前不接生产状态展示。执行证据以设备intent/核心execution为准，入口启用前须处理该指标。
- 任务/证据：docs/tasks/P2-002b-RemoteKeyer.md、docs/evidence/P2-002b-RemoteKeyer.md；裁决docs/reviews/REV-004-Codex复核.md。保护基线/mnt/d/AI/project-backups/cwstation/20261012-000600-p2-002b/。初轮测试日志前态未提前备份，已保留现场并补规范，不能把后态logs副本充当前态；源码、配置、数据库保护范围未缺失。无测试/DSH残留。

## P1-004 IC-7300只读协议与模拟（2026-10-06）

- 用户同意推进USB只读方向；本轮仅离线协议/模拟，未打开串口、未访问电台、未发射。新增packages/devices和独立cwrig simulate，只发03读取频率、04读取模式；保留CW/CW-R与FIL1..3，输出明确source:simulation。未接入daemon或改变授权/核心契约。
- DSH实现并自测后退出交接，Codex收回修改权，修正五字节BCD容量（初稿69.999999MHz上限错误，规格含74.8MHz）、非法字节、帧结束符长度边界、连续FE重同步、关闭后的异步写失败状态。流解析缓存有界，忽略回显/其它地址/transceive；单查询，超时/断连/写失败/无效回复锁死会话，无自动重试或重连。
- 独立新增测试29/29；完整Linux构建206通过/8 Windows专有跳过，Windows原生208通过/6明确跳过，均214项、0失败/取消；Windows另一个symlink子检查无权限而跳过。任务docs/tasks/P1-004.md、证据docs/evidence/P1-004.md、入口examples/rig/README.md。
- 下一步：评估并固定真实串口库版本、两端控制线/独占持有与分发条件，再实现端口适配。开口前需确认USB SEND、USB Keying(CW/RTTY) OFF及实际COM/路径、波特率/地址、占用软件。仅发送读命令不能保证开口时DTR/RTS无副作用。当前未安装串口依赖，模拟成功不是设备连接或射频证据；新会话残留字节归属与重新接入策略尚未验收。

## AI-001 只读建议开发入口（2026-10-06）

- 用户同意稳步实现，按ADR0005新增 `packages/assistant/` 与独立 `cwai validate-config/explain`。仅使用显式状态文件；disabled/mock离线，chat-completions文本接口可配置，不连接daemon/DB/串口，不提供执行或批准工具。示例见 `examples/assistant/README.md`。
- 配置version1，凭据只在联网前从指定环境变量读取，不落盘；URL/输入严格校验，重定向拒绝、有界超时/响应，不自动重试/换服务商。模型文本为不可信建议，不能证明真实设备状态或停止结果。
- DSH首版测试未通过，Codex停止该次headless并收回修改权，修复同步测试阻塞及运行时入口校验、错误响应清理、异常脱敏和凭据回显拒绝。独立新增源码测试16/16；完整Linux构建177/177，Windows原生构建171通过/6明确跳过，无失败。证据 `docs/evidence/AI-001.md`。
- 无真实云端调用、真实凭据或USB访问；服务商、界面、系统凭据存储与成品打包仍待实现/验收。AI-001验收时Windows权限尚未完成，后续管道v2状态以下节为准；只读AI模块不依赖该端点。

## P1-003 权限实验审查（2026-10-06）

后续授权：用户在确认下一步先完成Windows权限适配、再推进USB只读后回复“同意”。
已接受ADR0006的创建时受保护管道桥接方向，执行任务`docs/tasks/P1-003-v2.md`。
v1实验记录仍保留；v2已实现并通过开发机离线验收。本轮不连接电台。

v2结果：C#桥接在创建时应用protected ACL（NETWORK deny在前、当前token用户与SYSTEM允许）、拒绝远程，逐ACE读回；客户端同HANDLE核对server token用户/ACL后发送。共享TS RPC复用Duplex，helper失联走现有撤销/有界关闭，父退出不留下服务。原生AccessCheck当前用户通过、禁用用户SID的受限token拒绝，真实第二用户/远程登录未测。Linux177通过/8 Windows专有跳过；Windows179通过/6明确跳过，无失败。证据`docs/evidence/P1-003-v2.md`。

DSH产出C#首版与构建脚本后未完成接入，Codex结束headless并收回全部修改权，补严格ACL、重叠I/O、写ack、有界处理、TS接入与8项原生测试。Windows验证入口显式预编译dist/native/CwPipeBridge.exe，运行不编译，无默认DACL降级。发布包/干净机器与专门的helper启动挂起、持续写阻塞故障注入仍未验收；接收者不需要编译器的成品交付目标不变。下一步为IC-7300只读串口适配设计/模拟验证，开口前需核对控制线和电台设置，不自动进行真实发射。

- 用户同意完善 Windows 本地控制隔离，仍不授权 USB 接入或发射。
- 原生 Windows Node24.16.0 实测：修改进程 token 默认 DACL 不改变 Node 创建的管道默认权限；同名多个实例共享 ACL，但创建后收紧不能撤销先前授予的句柄权限，固定等待不能证明安全。
- v1阶段DSH撤回自己的未验收源码，实验保存在 `logs/p1-003-exp/`。当时生产代码保持P1-002，权限未完成；后续v2结果以上述记录为准。历史证据 `docs/evidence/P1-003.md`。
- 桥接方向后续获确认，决定ADR0006、设计`docs/design/windows-pipe-creation-security.md`，v2结果如上。
- Codex 独立回归：Linux Node24.18.1 构建及161/161通过；Windows原生Node24.16.0构建及155通过/6明确跳过，无失败。这些验证仅证明既有离线功能未回退，不证明权限问题已解决。

## 项目归属与当前状态

用户要求新建独立项目，不再以 WorkBuddy 项目为工作入口。

- 项目根目录：`D:\AI\projects\cwstation`。
- WSL 路径：`/mnt/d/AI/projects/cwstation`。
- 本文件是后续项目记忆的维护入口。
- 当前处于 Phase 0 离线实现：P0-002/003/004 已验收，包含 TS daemon/CLI、持久化授权与核查，以及 Julia CW 合成/噪声/回放文件；未连接电台或进行射频验证。数据库当前 schema4。
- 审阅报告：`docs/reviews/CW台站方案_审阅意见_20261005.md`。
- 原审阅材料留存在 `/mnt/d/AI/projects/cw-station-review-20261005/review_pack/`，仅供历史证据查阅；项目运行不依赖该目录。

## Syslab / Julia 环境基线（2026-10-05）

已通过 Syslab MCP 检测成功。后续 Julia 计算任务优先复用此环境，不另行假设系统 Julia：

- MWORKS Syslab：`26.3.0.7476`（安装目录标识 `Syslab 2026a`）。
- Julia：`1.10.10`，运行入口 `julia-ty.bat`。
- 活动环境：`C:\Users\Public\TongYuan\.julia\environments\v1.10`。
- Julia depot：`C:\Users\Public\TongYuan\.julia`。
- 当前环境支持 `TyRF 1.0.3`、`TySignalProcessing 1.0.11`、`TyDSPSystem 1.0.5`、`TyMathFFT 1.0.7`、`TyInstrumentControl 1.0.6`、`TyCommunication 1.0.7`、`TySignalAnalyzer 1.0.2`、`TyWavelet 1.0.3`、`TyDeepLearning 1.0.6`、`TyMachineLearning 1.0.5`、`TyStatistics 1.0.2`、`TyPlot 1.0.47` 等相关工具箱。
- 同一环境还已有 `DSP 0.7.10`、`FFTW 1.9.7`、`WAV 1.2.0`、`CSV 0.10.16`、`DataFrames 1.5.0`、`WebSockets 1.6.0`、`YAML 0.4.12`、`Unitful 1.23.1` 等通用包。

Julia 计算模块优先使用 Ty 库；Ty 不足时优先使用该环境已有包，只有两者都不能满足时才评估新增依赖。绘图默认使用 TyPlot。首批适合 Julia/MWORKS 的工作：CW 波形合成、频谱/滤波、信道噪声仿真、解码评估和 RF 参数分析。TS 台站核心仍通过版本化任务/结果接口调用 Julia，计算进程不得阻塞发射控制。

## 用户明确要求

2026-10-06 用户确认：主要交付 Windows 成品，分发给同学和学弟使用；Linux 支持要求继续保留。交付面向普通使用者，不要求他们安装 Node.js、编译器或开发环境。需要可直接启动的发布包、日常操作界面、首次设备配置、个人配置与日志保护、诊断导出，以及无开发工具的 Windows 环境验收。CLI 继续用于开发、诊断和自动验证，不作为最终分发体验的唯一入口。

Windows 安装包或便携包、界面技术、支持的 Windows 版本和 CPU 架构仍需选型；便携版是 Codex 的优先建议，不视为用户指定的包装形式。接收者不能依赖开发机的 Node/MWORKS/Syslab 环境；Julia 计算组件的分发与许可需单独评估，基础运行不得默认要求安装 Syslab。电台 USB 驱动作为设备前置条件明确检查和说明，不承诺无需驱动即可连接。

2026-10-06 用户补充：Linux 主要由自己使用，也会对外公布；Windows 仍为主要分发目标。用户同意首版 AI 方向：优先支持使用者自备云端 API 凭据并承担调用费，预留本地模型接口，基础台站不依赖 AI/网络，首版不建设作者统一托管服务。AI 只建议或提案，不获得批准、任意 shell 或设备权限。决定见 ADR0005，方案见 `docs/design/ai-distribution-options.md`。具体服务商、模型、适配接口与凭据存储实现仍待选型，AI 功能尚未实现；本次同意不代表管道桥接或真实发射获授权。

产品交付要求已确认，不等于新的管道桥接架构或真实发射已获确认。发布验收要求见 `docs/design/windows-distribution-requirements.md`。

“确保我们日后可以便利地丰富功能，有良好的可维护和可更新的结构。”

这意味着：

1. 易扩展、可维护、可更新是架构约束，不能只交付一次性原型。
2. 新增设备、比赛、解码器、模式、策略或界面，应尽量局限在对应模块。
3. 升级要保护用户配置、通联日志和个人规则，具备兼容性检查、迁移、备份与恢复路径。
4. 后续设计、任务拆分和验收持续考虑上述要求。

此前开发方向为 CLI 优先；现已确认最终交付需面向普通用户提供操作界面。继续复用开源组件、不 fork 应用、N1MM 作为可选只读来源。重大架构、公共接口和平台建设取舍先讨论，常规局部实现自主推进。

用户已确认设备与平台要求（2026-10-05）：ICOM IC-7300，目前 USB 直连电脑；Windows 和 Linux 都要支持。Windows 原生与 Linux 原生作为拟定验收目标，具体跨平台接口方案仍需讨论；不能仅用 WSL 测试代替 Windows 验收。

## 设计方向

先建设稳定、可恢复、操作直观的 CW 操作台，再逐步加入 AI 调度。核心采用模块化单体，一个守护进程承载确定性控制；重解码器及已有外部服务按需独立运行。有实际需求时再拆进程或建设插件发现机制。

以下为 Codex 提出的结构方向，具体接口和选型仍需实施前细化，不视为用户已逐项确认。

| 模块 | 职责 |
|---|---|
| contracts | 命令、事件、结果、接口及能力声明 |
| core | 会话、状态机、调度、授权、急停、故障恢复 |
| devices | CAT、键控、音频设备适配 |
| modes | CW、FT8 等模式的通联流程与时序 |
| contests / rulepacks | 交换校验、重复判断、计分、宏及导出布局 |
| decoders | 解码后端适配、结果时间和置信度 |
| journal | 通联存储、修改历史、查询、审计及迁移 |
| strategies | 自动 CQ、波段建议和 AI 提案 |
| interfaces / frontend | CLI、本地 API 与操作界面 |

依赖方向：核心依赖契约，适配器实现契约；CLI、界面及 AI 使用同一入口。设备显式报告取消、完成回执、队列清理、状态读取等能力。不同模式允许不同状态机，不能强行让 FT8 时隙适配 CW 消息流程。

当前实际代码目录为 `apps/` 与 `packages/{contracts,core,journal,daemon}/src/`，另有 `tests/` 和 `docs/adr/`。后续模块按需求加入 `packages/`；不要照旧建议另建一套 `src/cwstation/`。

## 扩展与维护约束

- 程序文件、用户配置、数据库、规则包分别管理；更新不得覆盖个人数据。
- 本地 API、事件、数据库及规则包分别声明版本，不兼容时明确拒绝加载。数据库变化通过迁移完成。
- 当前会话冻结规则和实体库，保存版本及内容 hash；更新可以下载和检查，切换须在停止发射后进行。
- 升级流程：停止发射并撤销授权 → 备份数据 → 检查兼容性 → 迁移 → 自检 → 人工重新启用台站。
- 保留上一程序版本及迁移前备份。回退应明确恢复哪份数据，不能假设旧程序能直接读取新数据库。
- 外部模块通过 Fake、协议模拟器或回放替换；不要求机械地为每个类复制 Dummy。
- 新设备验证适配器契约，新比赛验证交换及逐 QSO 计分；共享核心变化重点验证授权、取消、断连、迟到回执及重启恢复。
- 重要决定写 ADR，记录理由和适用边界。局部功能若牵动多个无关模块，应检查接口设计。
- 配置覆盖已定义的规则能力，特殊比赛允许受控策略模块；不承诺所有比赛永远只加 YAML，不执行配置中的任意表达式。

## 发射、恢复与 AI 的边界

- 发射执行器是唯一出口。确定性的授权、互锁、急停和恢复不能被模型仲裁器替换；AI 可提案、排序或建议。
- 批准绑定具体内容、频率、模式和有效期。可以设计单条消息、有限 CQ 循环或单通 QSO 等批准范围，须明确取消条件。
- 设备断连、频率/模式变化和重启后撤销原授权。发射结果未知时暂停核查，禁止自动重发，也不能自动记为成功通联。
- KEY、PTT 和 CAT 发码队列分别处理；`T 0` 不作为所有 CW 后端的停发保证。
- 首次接真机前完成授权、急停及故障恢复验证。
- 发完消息与完成 QSO 是两个状态；通联日志依据完整交换与确认条件生成。
- AI 若能任意执行 shell，仅删除 CLI 的直接发射命令不能形成访问隔离；实际权限边界应与部署一致。

## 首版建议与未决项

建议先覆盖 WAPC-CW 中国参赛台与日常 CW，一台电台、一种键控路线。WAPC 接收同时支持中国省码和国外流水号。

建议 SQLite 自有日志作为唯一真源，TLF/N1MM 作为可选对账工具；界面倾向本地 Web。解码先提供抄收建议，稳定后再加入 QSO 辅助、AI 策略和多模式。

实施前仍需明确：

- 电台机型已确认 ICOM IC-7300；键控方式待确认。
- CAT、KEY/PTT 和音频设备的唯一持有进程及部署系统。
- 日志真源与外部日志器角色。
- 首版范围和界面形态。
- 批准单位、期限、取消条件及故障恢复动作。

这些是建议与未决项，不能因写入记忆而当成已实施或已逐项拍板。

## 审阅后需纠正的旧前提

- Hamlib #1748 已有修复提交，不能直接作为目标版本或原 N1MM 掉线根因。
- TLF 支持 Cabrillo 导入，不等于 WAPC 对账配置已经建立。
- WAPC 原示例漏了国外流水号；Python 标准正则命名组需使用其支持的语法。
- cwdaemon 完成回执不是可靠事务或射频确认；UDP 超时可能表示结果未知。
- 进程隔离有助于组件独立，不能自动保证 GPL/AGPL 义务隔离。
- FT8 软件支持 Auto Seq 不能单独证明赛事合规。
- 不用 300–500 行作为可靠编排系统的实施预算。

细节与上游出处见项目内审阅报告。旧方案为历史输入，后续主文档应呈现唯一当前方案。

## 当前起步决定（2026-10-05）

- 实施路线已写入 `docs/ROADMAP.md`，从 Phase 0 离线确定性闭环开始。
- 已接受 ADR `docs/adr/0001-起步架构.md`：TypeScript/Node.js 负责台站核心，Julia/MWORKS 负责独立计算和仿真。
- `P0-002 v1` 已验收：常驻 daemon 唯一持有控制器、FakeKeyer 和 SQLite；CLI 通过本地 Unix socket 跨进程操作，提案、一次性批准、执行与审计持久化。协议版本 1，数据库 schema 2，显式迁移保留 v1 审计。
- 用户再次强调 DSH 协同。项目延续 Codex 设计、准备任务与审查，DSH 实现、自测与提交证据的流程；DSH 使用全局 headless profile，独立于 WorkBuddy 和 Codex 内置子 Agent。本次 DSH 完成两轮实现/修正，Codex 交接后补上三处边界修正。任务见 `docs/tasks/P0-002.md`，证据见 `docs/evidence/P0-002.md`。
- DSH 自测源码与编译模式各 56/56 通过；Codex 最终独立运行 `npm run test:built`，构建通过、59/59 测试通过，无测试 daemon 残留。增加覆盖停机拒绝已有连接的新请求、后端 timeout 转 unknown、状态落盘失败仍取消在途键控。
- 核心通过 `TxJournalStore` 接口使用存储，不直接依赖 SQLite；新后端与计算模块应保持该依赖方向。
- 当前仅 WSL/Linux、FakeKeyer、单一 CW 模式；同一 OS 用户是访问边界，CLI 批准不能证明真实人类参与。未接 AI、真实设备或射频。
- P0-003 已实现 unknown 人工核查与解除，不能通过删记录或重发绕过阻止。数据库完全不可写时仅能保证当前进程内闩锁；已落盘存储故障在重启后仍保留。锁 guard 异常残留需人工核查。TTL 暂使用系统墙钟，时钟跳变处理待完善。
- P0-004 已实现 Julia/MWORKS CW 合成、噪声与回放文件接口。P0-005 已完善离线配置、备份、恢复与存储故障核查流程。真实设备路线仍需用户确定后进入 Phase 1。

## 后续实施授权（2026-10-05）

- 用户同意推进 unknown 核查与解除、Julia/MWORKS CW 合成和回放。任务分别为 `docs/tasks/P0-003.md`、`docs/tasks/P0-004.md`，延续 DSH 实现/自测、Codex 审查的流程。
- unknown 核查设计见 ADR 0002：保留原执行 unknown，独立核查记录；本次进程新 unknown 必须先停机重启，逐条解除，撤销旧授权并重新批准新提案。离线核查声明不等于真实设备停止证明。
- Julia 首版使用独立任务/结果 JSON 文件，不进入发报安全路径，不另建常驻服务。TyCommunication.awgn 已在 Julia 1.10.10 实测：10dB、seed=42 的 8000 样本输出重复完全一致；TyCommunication 1.0.7、JSON3 1.14.3、WAV 1.2.0 可用。TyMath 未提供 audiowrite，因此音频写入采用已安装 WAV 库。
- P0-003、P0-004 现已完成 Codex 验收；任务和证据文件已更新状态。

## 本轮验收结果（2026-10-05）

- P0-003：`cwctl unresolved` 查询未核查记录；`resolve-unknown <id> --operator <name> --note <reason> --confirm-stopped` 写独立核查记录、撤销旧授权、递增 generation。unknown 原执行不改写、不重发；本次进程新 unknown 须先停机重启。非 Fake daemon 拒绝该离线核查。schema3 保存核查表，schema4 独立保存 storage_fault，unknown 核查不能清除存储故障；存储故障现有P0-005独立离线核查入口。
- P0-004：`packages/signal` 和独立 `cwwave prepare/verify`，`julia/CWSignal.jl`/`run_task.jl`/`test/runtests.jl`。任务/结果契约版本1、算法1.0.0；Julia 不依赖 daemon、不直接访问发射或音频设备。通过 JSON 任务文件衔接，不阻塞控制器。
- Morse 复用精确固定 `@ozdemirburak/morse-code-translator@7.0.0`（MIT、无运行依赖）；只使用文字编码，不使用其浏览器音频功能。Node 基线>=24。Julia 继续复用 MWORKS，TyCommunication.awgn、JSON3、WAV，无新增 Julia 包。
- 支持 CW 点划1:3、元素/字符/词间隔1/3/7，短余弦沿，固定seed高斯噪声；产物为 PCM16 clean/noisy WAV、实际样本段及带环境/参数/hash 的结果。TS 独立检查文字编码、时序、载波、音频格式/哈希/SNR/峰值及路径；ramp样本采用与 Julia 一致的 .5 取偶。
- DSH P0-003 自测各73项、P0-004最终自测TS各97项/Julia67项是其交付版本结果。Codex 最终独立 `npm run test:built` 构建通过、99/99通过，Syslab MCP 实际运行Julia73/73通过，CQ TEST及20ms/60dB短报文音频校验通过。理论噪声方差按原始载波功率推导，避免误拒绝短样本的正常统计波动。无本轮测试daemon/headless DSH残留。
- 样例入口 `examples/signal/README.md`，现成任务 `cq-test.task.json` 与 `cq-test-out/`，CQ TEST 长3.3s、26400样本。命令和输出拒绝覆盖，重新生成用新的路径。用户可以直接验证现成产物。
- 仍未接真机、音频设备、解码器或AI；没有QSO日志规则与计分，不能将发完消息视为完成QSO。后续先完善配置/备份/故障修复，确定电台型号与KEY/PTT/CAT路线，再按Phase1真机验证。

## P0-005 已验收（2026-10-05）

- 用户同意推进配置、备份与存储故障修复流程。设计见 ADR0003、任务 `docs/tasks/P0-005.md`；版本化JSON配置和独立离线维护CLI，恢复到新数据库路径，故障解除前必须备份、撤销旧批准并审计。
- DSH通过全局headless入口完成首版实现与自测：源码128/128通过，编译模式一轮127通过/1超时取消并留下测试daemon，不能作为验收通过。Codex清理该临时进程并结束本次headless任务，收回修改权后修正发布/结构/阻止状态边界与测试清理，最终独立源码及编译模式各139/139通过。当前无本轮测试daemon/headless任务残留；用户DSH web/Syslab服务未停止。
- 配置version1，显式`--config`，默认→配置→环境→CLI；相对路径按配置目录。配置不承载批准/频率/故障状态。入口 `examples/config/README.md`。
- `cwmaint backup/inspect/restore/clear-storage-fault`独立于daemon RPC和发射路径；备份只读一致快照含WAL数据，manifestVersion1记录hash/结构/计数/状态。schema仍4，无新增依赖，Julia未改动。
- 维护取同一DB锁，活动daemon拒绝；符号链接规范化，数据库硬链接别名拒绝。已有路径及悬空链接不覆盖，备份包不能带SQLite伴生文件或自定义触发器/视图。恢复仅写新路径，撤销旧批准、running转unknown、generation增加并审计；存储故障及未核查unknown保留阻止。
- 故障解除前必须成功备份并人工确认停机，原子清fault/撤销批准/更新generation/审计，写失败回滚；不明阻止与故障/unknown并存时拒绝。命令验证可写性及记录核查，不修复损坏DB/磁盘/硬件。程序回退另核对旧程序schema兼容性，不能假定本版恢复到schema4的库可直接给旧程序使用。
- 任务/审查/证据分别为 `docs/tasks/P0-005.md`、`docs/tasks/P0-005-review-notes.md`、`docs/evidence/P0-005.md`；ADR0003记录决定。后续仍遵循Codex设计/审查、DSH实现/自测，不混用WorkBuddy和内置Agent通道。
- 真实电台路线尚未实施，电台机型与连接方式仍待明确；离线任务不依赖该回答。

## Phase 1 接入准备（2026-10-05）

- 用户要求继续项目；按路线图完成 P1-001 准备审查，DSH 只读审查、Codex 复核，见 `docs/tasks/P1-001-preparation.md` 与 `docs/evidence/P1-001-readiness.md`。这不是已批准的适配器设计或真机验收。
- Codex 重新运行 `npm run test:built`：构建成功，139/139 通过，无本轮测试 daemon 残留；未连接真实设备或修改用户数据库。
- 真实接入需明确状态探测、取消/停止确认及能力声明；当前 DB/socket 锁不能保证电台串口唯一持有。具体公共接口与部署取舍待设备路线确定后讨论。
- 用户已确认电台为 ICOM IC-7300（不是 IC-7300MK2），目前 USB 直连电脑，要求同时支持 Windows 和 Linux。实际串口、CI-V/USB 菜单设置、CW KEY/PTT 分配与固件版本仍待确认；未实施真实发射。当前目录尚无 Git 仓库。
- 官方 USB 设置指南确认 IC-7300 支持 USB CI-V，以及 DTR/RTS 映射 USB SEND/CW 键控；具体键控路线尚非已批准方案。接入依据和只读串口控制线注意事项见 `docs/evidence/IC-7300-connection-notes.md`。
- 用户已同意跨平台最小方案与顺序，决定见 ADR0004 和 `docs/design/windows-linux-usb-plan.md`：共享核心、Linux Unix socket / Windows 命名管道，先两端 Fake 闭环再只读 USB CI-V，键控后续讨论；不授权真实发射。

## P1-002 双平台离线功能（2026-10-05）

- DSH 完成首版平台端点、配置和停机实现，Linux自测158/158；Windows测试未完成。Codex结束该次headless、收回修改权，修正跨平台清理/编译CLI、停机响应绑定、端点优先级、SQLite初始化异常句柄及Windows备份目录发布。最终Linux源码/编译各161/161，Windows原生Node24.16.0构建及编译155通过/6明确跳过，无失败；最终新增断言源码另3/3通过。
- version1 Linux配置兼容；version2增加显式Unix/pipe端点。`cwctl stop`/`daemon.stop`仅接受空参数，accepted不等于已退出；立即拒绝新工作，走撤销授权/有界取消/关闭存储。协议1、schema4不变，核心发射状态机未改动。
- Windows默认管道DACL实测owner/SYSTEM/Administrators完整权限、Everyone/Anonymous读权限，不能声称与Unix0600等价；doctor明示未运行时验ACL。离线功能通过，Windows同用户访问隔离未完成，真实控制须先解决权限条件，后续最小方案需设计/验证。
- Windows备份独占创建输出目录、链接校验快照、manifest最后发布；中断可能留下不完整包，inspect拒绝，不自动覆盖。Linux保留目录原子发布；恢复仍只写新路径。
- 证据与运行命令见 `docs/evidence/P1-002.md`，入口`node scripts/verify-platform.mjs`，Windows配置样例`examples/config/station.windows.example.json`。Windows源码tsx依赖尚未验收，Julia/Linux计算不在本轮范围；未连接USB或电台，无本轮测试daemon/headless残留。

## IC-7300手册与接入方向补充（2026-10-09）

- 用户再次确认ICOM IC-7300，提供微信文件目录中的`IC-7300_ENG_FM_12b(1).pdf`，认为是CAT接入。CAT具体协议为CI-V；既有USB直连及Windows/Linux目标仍沿用，实际端口与菜单未确认。
- 本地手册印刷页19-3/19-13确认CI-V 0x17内置CW发码（最多30字符/命令），0xFF数据停止发码；12-11确认DTR/RTS的USB SEND/CW/RTTY映射及开口误触发注意事项。优先评估USB CI-V内置发码是当前建议，尚未批准键控接口或真实发射；命令OK不证明发码完成、清队列或射频停止。
- 工作区已有P1-004只读CI-V模拟器，任务/证据文件显示双平台离线验收完成；此前记忆未逐项收录这一后续里程碑。本次未重跑其测试、未打开设备或变更代码。下一步确认固件、COM/Linux路径、CI-V/USB设置，再设计真实只读transport任务；键控独立验收。
- 依据和说明见`docs/evidence/IC-7300-connection-notes.md`。本次只改该文档与MEMORY.md；无Git仓库，先cp -a备份到`/mnt/d/AI/project-backups/cwstation/20261009-225929-manual-review/`，随后diff核对预期变更。

## 本机IC-7300端口枚举（2026-10-09）

- 用户要求自行查端口与设置。Windows系统只读枚举确认当前COM17，实例`USB\VID_10C4&PID_EA60\IC-7300_01009552`，CP210x状态OK，驱动11.3.0.176。Windows注册表保存9600,n,8,1，但不是电台CI-V实际波特率证据。WSL没有ttyUSB/ttyACM设备。
- 未发现常见电台控制软件进程匹配，不等于证明端口未占用。电台固件和CI-V/USB菜单仍无法靠系统枚举确认，未打开串口、改变控制线或发射；不要把COM17识别写成CI-V真机查询成功。
- 详情见接入记录。修改前文件备份`/mnt/d/AI/project-backups/cwstation/20261009-230639-port-enumeration/`，目标仅MEMORY.md与接入记录，随后diff核对；无代码变更或测试。

## IC-7300 CI-V 只读链路探测（2026-10-10）

- 用户明确只测试控制链路，功率设为0，不进行实际发射。脚本保持DTR/RTS关闭、无硬件流控，只发送读取频率/模式命令，未发送CW/停止/PTT/SEND。
- 历史失败探测：COM17按4800/9600/19200/38400/57600/115200逐一打开、8N1；Codex误用`FE FE E0 94 ... FD`作为请求，全部0字节回复。这是地址方向错误，不能据此判断波特率或驱动异常。正确请求为`FE FE 94 E0 ... FD`，回复为`FE FE E0 94 ... FD`。
- 结论仅为Windows串口可打开；CI-V响应未建立。不能把端口打开当作电台连接成功，也不能据此决定实际波特率或地址。软件设计需区分端口、写帧、有效响应、已知电台状态；无响应有界失败且不自动发码。
- 依据与原始探测摘要见`docs/evidence/IC-7300-connection-notes.md`。下一步核对电台USB Serial Function/CI-V USB Port/波特率/地址及USB SEND/Keying映射保持OFF，再重试只读帧。本次无代码、数据库或电台设置变更。
- 修改前备份：`/mnt/d/AI/project-backups/cwstation/20261010-000807-civ-probe/`；无Git仓库，修改后应与备份逐项diff。

## IC-7300只读实机链路已建立（2026-10-10）

- 用户确认USB波特率保持19200、其他建议菜单设置已修改；USB SEND/CW/RTTY映射OFF，CI-V地址94h等按用户声明记录，不冒充协议读取结果。
- Windows原生PowerShell独立探测COM17/19200/8N1，无流控，DTR/RTS=false，正确03/04请求收到有效目标回复。频率14547000Hz（14.547MHz），模式USB，FIL2；端口已关闭。仅只读查询，未发送写设置/CW/PTT/SEND，未验证TX状态或射频功率。
- 先前Codex把地址方向纠正反了，已明确修正历史记录。现有civ.ts请求/响应方向正确，不改代码。本次不是cwrig真实串口transport/daemon集成验收；后续可基于实机原始帧设计受限串口transport，沿用DSH实现与Codex审查流程。
- 修改目标仅MEMORY.md与接入记录；cp -a备份`/mnt/d/AI/project-backups/cwstation/20261010-002654-civ-success/`，diff核对预期变更。原始帧见接入记录。

## P1-005 真实串口只读接入（2026-10-10）

- 用户授权“接入”。任务P1-005限定独立cwrig读取频率/模式；serialport精确固定13.0.0，按需加载原生绑定。devices串口适配器复用现有CI-V解析及client；核心、daemon、数据库、Julia未变更。
- DSH沿用全局headless执行，两次SSE连接中断，留下串口初稿；Codex收回修改权、审查修正关闭/超时/延迟open/不可变白名单/缓冲区复制/写入完成后交付回复，补CLI、mock测试与证据。不能把DSH中断视为其自测或交付通过。
- cwrig read显式port，默认19200/8N1/无流控，要求--confirm-keying-off；初始化拉低DTR/RTS、flush/50ms/flush，只允许FE FE 94 E0 03或04 FD，查询结束关闭。非法参数不打开，错误不报成功、不重试；Ctrl-C包含初始化阶段的有界清理。无法确认关闭时保留登记/错误监听并报错，独立CLI退出后OS回收句柄。
- Windows原生Node24.16.0在COM17/19200实际读取14651000Hz（14.651MHz）、USB/FIL2。直接CLI成功；另一会话记录原始03/04请求及回复，isClosed=true、closeError=null，证明端口可再次打开和正常释放。未发CW/PTT/SEND/写设置，未探测TX状态或射频功率。用户菜单声明不是自动读取验证。
- 最终构建再次实机复核时读到14742000Hz（14.742MHz）、USB/FIL2，关闭确认仍成功。频率是每次读取时的快照，可能随电台操作改变；没有写频率命令。
- Linux Node24.18.1和Windows原生构建通过，各51/51针对性测试通过（含既有CI-V和新串口测试）；Linux真实串口未映射、未实机验收。命令入口examples/rig/README.md，原始数据/运行产物hash/限制见docs/evidence/P1-005.md。此轮不是daemon接入或发射能力验收。
- 无Git，修改前cp -a备份到`/mnt/d/AI/project-backups/cwstation/20261010-003023-serial-integration/`，另补dist-before-build；与基线对比确认仅任务代码、依赖及文档变更。下一步可设计只读状态接入操作界面；键控与发射继续独立讨论和验收。

## P1-006 CLI终端监视台（2026-10-10）

- 用户选择先做CLI显示界面。新增cwrig monitor --simulate及显式串口模式，现有simulate/read继续JSON。交互终端中显示分组频率、模式/FIL、来源/状态、数据年龄、近期事件和可展开原始字节；ASCII英文标签、颜色可关闭、窄窗口堆叠。
- 一个UI持有单个串口会话，默认读完间隔1秒刷新，查询不重叠。C连接/D断开/R刷新/P暂停轮询/G诊断/Q或Ctrl-C退出；读取故障停止轮询、旧数据STALE、手动重连。无法确认关闭保留阻止；开口清理未知要求退出重启。仅03/04只读，不显示猜测的功率或TX状态。
- DSH完成纯显示模块并正常交回，Codex修正窄布局/诊断空间、实现会话及输入退出流程。任务/交付证据为docs/tasks/P1-006-cli-monitor.md及docs/evidence/P1-006-cli-monitor.md。不涉及设备公共契约、daemon、核心、Julia或依赖改变；尚未实现共享状态服务。
- Linux与Windows原生TypeScript构建通过；本轮未添加/运行测试，未实机运行新监视台，不引用上一轮51项为其验收。已请求启动Windows离线模拟窗口，examples/rig/monitor-demo.cmd可再次打开；实际操作与视觉效果尚未验收。
- 无Git，改动前cp -a保护apps/docs/examples/MEMORY/AGENTS/tsconfig/dist于`/mnt/d/AI/project-backups/cwstation/20261010-005731-terminal-monitor/`，交付前与基线比较；入口与使用命令见examples/rig/README.md。

## 监视台显示修正（2026-10-10）

- 用户观察到绿色/黄色状态不断交替导致闪烁，并要求北京时间与UTC。正常轮询保留READY，仅首次等待回复使用READING；终端改为比较前后帧，只重绘变化行，启动时清屏一次。故障/断开状态仍独立显示。
- 新增Intl.DateTimeFormat固定Asia/Shanghai和UTC双时钟，每秒显示时间，宽屏包含日期，窄屏紧凑格式，避免依赖本地时区。无串口协议/查询行为变化。
- 此小范围修正由Codex直接完成。修改前cp -a备份到`/mnt/d/AI/project-backups/cwstation/20261010-010716-monitor-clock/`；包含apps/dist/MEMORY及相关说明/证据。构建和交付详情见P1-006证据补充；本轮未添加/运行测试或真实设备验证。

## Bash快捷启动（2026-10-10）

- 用户要求缩短启动命令；新增项目根rig.sh，`bash rig.sh`默认COM17/19200只读监视，沿用已确认的键控映射OFF。`--simulate`启动模拟，CWSTATION_PORT可覆盖端口。
- WSL/Git Bash调用Windows PowerShell启动原生Node终端，避免interop管道导致TTY检查失败；原生Linux使用当前终端及默认/dev/ttyUSB0。脚本定位自身项目路径，不自动安装/构建，不改监视台或串口实现。
- 修改前cp -a保护MEMORY及rig README于`/mnt/d/AI/project-backups/cwstation/20261010-011405-bash-launcher/`；rig.sh为新增文件，基线中不存在。修改后diff核对仅快捷入口说明和记忆追加。本轮未运行测试、脚本或真实设备。

## P1-007 独立只读状态服务核心（2026-10-11）

- 用户同意将串口所有权集中到独立`rig-statusd`，不并入现有发射控制daemon。服务复用CI-V只读03/04，客户端通过本地IPC读取缓存状态。
- DSH新增`packages/rig-status/src`与`apps/rig-statusd.ts`，Unix socket核心和mock测试完成；状态含ready/stale/fault/disconnected、快照时间、错误和只读标记。RPC仅status/watch/reconnect，64KiB帧限制，拒绝控制参数/TCP。
- Codex审查发现关闭错误初稿会吞掉，已改为记录stale/fault并抛出；没有真实设备访问。构建exit0，新增服务测试9/9通过。
- Windows命名管道已复用既有受保护WindowsBridge，原生Node模拟冒烟监听和status请求通过；下一步把cwrig read/monitor改成IPC客户端并做真实COM17服务验收。当前真实监视台仍直接持有串口，服务尚未接管实机。
- 新增`RigStatusClient`及`cwrig status --endpoint <path>`作为客户端迁移第一步。Unix socket和Windows命名管道模拟均返回ready只读快照；修正请求帧不能携带source顶层字段。现有read/monitor仍直接持有串口，未做真实COM17服务验收。
- `cwrig read --endpoint <path>`已切换为读取`rig-statusd`缓存；endpoint模式与直接串口参数互斥，直接模式暂保留。下一步迁移monitor并用服务真正接管COM17。
- 修改前cp -a备份`/mnt/d/AI/project-backups/cwstation/20261011-194533-status-service/`；新增任务/ADR/服务代码/证据，未修改既有daemon/core/CLI/数据库。

## P1-007 监视台 IPC 客户端化（2026-10-11）

- `cwrig monitor --endpoint <path>` 已迁移为 `RigStatusClient` 客户端，只显示 `rig-statusd` 缓存，
  不再直接打开 COM17；C 请求服务 `reconnect`，D 为本地断开，R 请求 `watch`，P 控制本地轮询，
  G 切换诊断，Q/Ctrl-C 退出。服务状态 `stale` 映射为灰色过期快照，快照时间使用服务提供的时间。
- `rig.sh` 现在负责启动状态服务再启动监视台，退出时清理服务：Linux 使用临时 Unix socket，
  Windows 使用 `\\.\pipe\cwstation-rig-status` 和 PowerShell `Start-Process -Wait`。状态服务是唯一串口持有者。
- `npm run build`、Linux 模拟 status/read IPC 冒烟和 `bash -n rig.sh` 已通过；尚未用该新路径接管真实 COM17，
  下一步需现场验证调频/模式跟随、USB拔插后 C 重连及退出释放。保护备份：
  `/mnt/d/AI/project-backups/cwstation/20261011-continue-status-client/`。

## P1-007 真实 COM17 服务验收（2026-10-11）

- Windows 原生 Node24.16.0 用 `rig-statusd` 独占 `COM17`、`19200`、命名管道
  `\\.\pipe\cwstation-rig-status-live`，状态为 `ready/readOnly:true`，实机快照
  `14204000 Hz / USB / FIL2`。
- 通过客户端 `reconnect` RPC 显式关闭并重开串口成功，重连后快照和状态有效；全程没有写频率/模式、
  CW、PTT 或 SEND。停止服务后 direct `cwrig read` 能再次打开 COM17，证明句柄已释放。
- 现场旋钮调频跟随、物理 USB 拔插后按 C 的观察尚未在新服务监视台窗口完成；功率/TX 状态未读取。
  保护备份：`/mnt/d/AI/project-backups/cwstation/20261011-live-status-service-acceptance/`。

## P1-007 动态轮询观察（2026-10-11）

- 真实 COM17 服务连续约 25 秒收到 25 次 `watch`，全部 `ready/stale=false`，快照保持
  `14204000 Hz / USB`；服务随后已停止。
- 测试期间没有实际旋钮或模式变化，不能据此宣称调频跟随通过；仍需用户在监视台运行时操作电台确认。
  保护备份：`/mnt/d/AI/project-backups/cwstation/20261011-follow-test/`。

## P1-007 现场调频跟随确认（2026-10-11）

- 用户在 `rig.sh` 启动的真实服务监视台中转动 IC-7300 旋钮，确认频率能够更新；服务轮询到界面的
  动态链路通过。当前监视台仍运行，完成后按 `Q` 释放 COM17。
- 保护备份：`/mnt/d/AI/project-backups/cwstation/20261011-follow-confirmed/`。

## P1-007 现场模式跟随确认（2026-10-11）

- 用户通过 IC-7300 触摸屏切换模式，确认真实服务监视台的 `MODE/FIL` 能更新；频率和模式跟随均已通过。
- 当前 `rig-statusd` 与服务监视台仍运行，下一步执行 USB 拔插后按 `C` 的重连验证。
  保护备份：`/mnt/d/AI/project-backups/cwstation/20261011-mode-follow-confirmed/`。

## P1-007 现场 USB 重连确认（2026-10-11）

- 用户完成 USB 拔出、重新插入并按 `C`，状态服务重新打开 `COM17` 后恢复正常，频率和模式重新显示，
  USB 重连测试通过。频率跟随、模式跟随和显式重连均已完成真实设备验证。
- 当前服务和监视台仍运行，完成后按 `Q` 释放 COM17。保护备份：
  `/mnt/d/AI/project-backups/cwstation/20261011-usb-reconnect-confirmed/`。

## P1-007 最终退出释放确认（2026-10-11）

- 用户按 `Q` 退出后，Windows 进程检查未发现 `rig-statusd` 或 `cwrig monitor` 残留，COM17 已释放。
- 真实设备验收闭环完成：只读状态服务、频率跟随、模式跟随、USB 拔插显式重连和退出释放均通过。
  保护备份：`/mnt/d/AI/project-backups/cwstation/20261011-final-release-confirmed/`。

## P1-008 只读状态历史与诊断记录（2026-10-11）

- 已在 `rig-statusd` 内加入版本化 JSONL 历史写入：`service_start`、`snapshot`、`fault`、
  `reconnect`、`service_stop`，每条包含 `schemaVersion:1`、完整 `RigStatusReport` 和写入时间。
- 写入器串行追加并在服务停止时刷盘；磁盘写入失败只进入诊断记录错误，不改变只读串口安全边界。
  `rig-statusd --history <path>` 显式启用，`rig.sh` 默认写入 `logs/rig-status-history.jsonl`。
- `cwrig history --file <path> --tail N` 提供受限读取，校验版本/事件/report，最大读取8MiB、1000条。
  模拟服务已验证启动、轮询快照、停止刷盘及CLI读取；未改变daemon、数据库或发射路径。
- 任务与证据：`docs/tasks/P1-008-status-history.md`、`docs/evidence/P1-008-status-history.md`。
  保护备份：`/mnt/d/AI/project-backups/cwstation/20261011-p1-008-history/`。

## P1-009 Julia/MWORKS 历史离线分析（2026-10-11）

- 新增 `julia/RigStatusHistory.jl` 与 `julia/analyze_history.jl`，读取 `rig-statusd` schema-1
  JSONL，校验只读来源和记录结构，输出输入 SHA-256、事件/状态/模式计数、频率范围/均值、
  频率/模式变化次数、最大快照间隔、Julia/JSON3 环境版本及 `transmits:false`。
- 输入限制 8MiB/单行64KiB/100000条；结果独占创建并通过同目录临时文件发布。只读文件分析，
  不打开串口、IPC、数据库或音频设备，不进入发射路径。
- Windows MWORKS launcher 实际运行模拟历史通过：6条记录、5条快照、JSON3 1.14.3、Julia
  1.10.10+4；修正该版本 `mktemp` 不接受 `prefix` 的兼容问题后复验成功。
- 任务与证据：`docs/tasks/P1-009-julia-history-analysis.md`、`docs/evidence/P1-009-julia-history-analysis.md`。
  保护备份：`/mnt/d/AI/project-backups/cwstation/20261011-p1-009-julia-history/`。

## P1-009 真实历史分析验证（2026-10-11）

- Windows `rig-statusd` 以 COM17/19200 运行约48秒，生成真实历史：48条记录、47条快照，
  `14176000 Hz / USB / FIL2`，全部 ready；Julia 分析成功，最大快照间隔约1.036秒，
  无频率/模式变化，`transmits:false`。未操作写设置或发射。
- 本次采集强制结束服务，未产生 `service_stop`；已修正 `rig.sh` Windows 清理为先优雅停止、
  等待5秒，超时才强制结束。运行备份：`/mnt/d/AI/project-backups/cwstation/20261011-real-history-validation/`；
  修正备份：`/mnt/d/AI/project-backups/cwstation/20261011-graceful-history-shutdown/`。

## 实机反馈及重连轮询修正（2026-10-11）

- 用户确认调频/模式跟随与Q退出后重启均通过。随后USB拔插、C重新连接成功，但显示READY/STALE/POLL OFF，只有R更新并短暂恢复青色。定位为fault关闭polling后connect未恢复；不是频率读取协议故障。
- Codex局部修复：每次显式建立新会话恢复polling=true，失败继续由fault关闭。P暂停作用于当前会话；仍不自动重连、不发射、不写电台设置。灰色继续表示过期数据。
- 修改前cp -a保护源码/dist/MEMORY/相关说明证据到`/mnt/d/AI/project-backups/cwstation/20261011-003027-reconnect-poll/`；修改后diff检查。构建结果见P1-006证据补充；修正版USB拔插恢复须由用户重新验证，现有监视进程需Q退出再bash rig.sh加载新版。
