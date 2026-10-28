# V00-04-A 自动派发与 GUI/CLI 共用契约

会话已暂停（2026-10-28，用户要求本次结束）：下次采用更好的USB线再继续现场对照；本次不再执行设备/发射操作，未决intent保留。

## 当前现场：5%对照完成但收尾失败，继续USB链路定位（2026-10-28）

结果：正文ACK后约6.1秒原生串口Operation aborted，诊断即时退出/原因落盘生效；stop写失败、exit1，正常收尾仍不通过。事后COM17在、PnP OK且只读重开RX成功；未持续掉线不等于链路稳定。暂停新RF，不自动核查新intent，接线条件改善后才对照，见04-A证据/MEMORY。

用户已将功率降至5%以验证USB失联相关性；该百分比未实测瓦数。缺口为原25%多次发送后USB掉线；复用原rig.sh/runner/session/serial及原账本，产品零修改/新入口/协议/schema；不涉及替换。先核对RX/旧进程关闭及原review核查，保持7.009600MHz/CW、20WPM和CQ CQ DE BG2GZA K，仅发一次，记录发送ACK→13625ms窗口→RX观察→stop/close及后续端口状态。失败不自动重发/解intent，不启用GUI真实或连续CW。备份 `.local-backups/cw-5percent-20261028-205930/` 含账本/四文档/dirty/实际编译文件SHA。验收只限此次低功率正常收尾与否，成功不证明USB根因或长时作业完成。


## 当前增量：发送后掉线处理已限定完成，USB原因与收发验收待现场（2026-10-28）

结果：软件修复56/56、build与Windows运行故障注入通过，实际新模块60秒只读通过；DSH v2审议/Codex复核完成。无真实RF复验，USB物理问题未判修复，不能宣称长时间作业完成，见04-A证据。

1. 缺口：真实USB端口消失已观测，原估算等待仍等13.625秒才报泛化stop/close，原始断线原因不显示/未持久化；先使故障立即可见且不误重发，不能将软件改动当USB硬件修复。
2. 主链：原runCwTrial→CwTrialSession→原serial，单一设备持有/原JSONL；Codex独占源码/专项修改，DSH只读设计/差异审议。
3. 最小范围：session估算等待受会话终止取消，runner输出与close detail保留session.error；定向断线/取消/正常收尾回归。不改串口故障隔离，不自动重连/重发/清intent，不实现连续QSO或GUI真实发送。
4. 零新增入口/服务/公共参数/协议/schema，detail使用原自由文本字段；原一次发送/停止/关闭继续。
5. 不涉及替换；长时间作业目标继续沿CLI原链推进，当前先定位USB断连并补此故障闭环，恢复依据后才讨论连续操作语义。
6. 验收：模拟注入断线验证长等待即时取消、原原因输出/持久化/未决保留；正常RX及外部取消回归/build。真实仅零发送检查设备状态，未修复USB前不再RF。保护.local-backups/tx-disconnect-fix-20261028-204021/含源码文档账本/dist/dirty。用户补充手机基本一致，错字倾向和旧解码一致，按用户观察记录，未取得逐字真值。


## 当前现场：串口失效定位（2026-10-28）

真实试发结果：首次及用户单独要求的第二次均正文ACK，但估算等待后会话失效/stop写失败、exit1；第二次后COM17打开File not found。完整收尾未验收，暂停进一步RF，只定位恢复连接；最新intent保留未决。见原04-A证据与MEMORY，未新增生产实现。下方为本次现场执行边界。

缺口：离线通过后的真实自定义正文及20WPM估算收尾未验。主链复用原rig.sh→runner/session→COM17，不修改产品源码。用户已确认20WPM/确切正文并在旧TEST核查提问后要求继续；先用原review入口追加核查，原记录/旧unknown不变，然后原入口一次CQ CQ DE BG2GZA K，预检/重读/intent/估算RX/stop/close全保留。零新入口/协议/schema/服务，无替换。验收取原TTY输出/正式账本/现场听感，异常不自动重发；不启用GUI真实、连续CQ或自动QSO。保护 `.local-backups/custom-tx-live-20261028-201853/`，含正式JSONL/文档副本、dirty及实际编译运行文件SHA。


## 最新收口：自定义短报文 CLI 离线验收（2026-10-28）

限定完成：最终自定义10/10、串口23/23、受影响runner/估算54/54、build及原rig.sh编译入口模拟通过；DSH v2审议与Codex复核完成。真实新正文/码速/切换及GUI真实发送未验，见[04-A证据](../evidence/V00-04-A-GUI切片.md)。

局部范围修正：30字节专项暴露原模拟器32字节parser不足以容纳36字节Command17帧。原模拟器及会话parser限定增至36，不修改通用parser默认值；模拟器修改前已补备份simulator-before.ts。

局部范围修正：DSH交叉检查发现真实串口仍只允许E/TEST，模拟成功不代表生产调用者接通；补齐原serial.ts授权策略的30字节大写Command17正文校验（拒绝^/非ASCII/控制/首尾空白），不改工厂签名或只读策略，tests/serial.test.ts增加原生驱动替身验证。两个文件修改前补备份在同目录。真实RF仍不执行。

局部范围修正：首次build误收手机CMake生成的compiler_depend.ts而失败；在原tsconfig排除独立apps/harmony-cw，沿用两工程原工具链。修改前已补备份tsconfig-before.json，不扩大产品接口。

1. 缺口与完成条件：现有自定义短报文已实现但缺专项验收；完成精确正文确认、30字节边界、取消/停止、账本兼容的离线验证，真实发射另计。
2. 主链与负责人：原 rig.sh → rig-controld → runCwTrial → CwTrialSession；复用 CI-V planner、模拟 transport、原 JSONL。Codex负责边界/源码/文档与验收；DSH仅拥有新增 tests/cw-custom-message.test.ts 并提交审议。
3. 范围：定向测试及必要局部修正、修正文档；不新建发送循环，不启用GUI真实发送，不改解码算法，不执行真实RF。
4. 增减：无新入口、服务、设备协议、记录schema；仅新增专项测试。自动回复继续仅模拟，默认启动继续只读。
5. 替换：不适用，现有调用者和历史账本保留，不自动核查或解除未决intent。
6. 验收与保护：build、受影响发送/账本/估算专项、编译CLI自定义正文模拟及同目录重复阻断；基线 .local-backups/custom-tx-closure-20261028-194541/ 含目标源码文档、dirty补丁和dist。真实TEST沿用10月27日证据，新的正文/实际码速与收发切换未做硬件验收。


## 限定交付：估算发送窗口与RX观测（2026-10-23，用户同意）

1. 缺口：原模拟应答后立即停止，真实CLI没有可选的估算收尾；用户接受估算运行策略，不能把它记录成硬件完成。
2. 主链：原runCwTrial → 原CwTrialSession，复用signal模块encodeCwText/buildTimeline及原1C00查询/单在途槽/停止/JSONL，不造编码器或发送器。
3. 范围：CLI增加显式--estimated-wpm 6..48（操作人提供估算速度，须不高于实际有效速度），会话增加有界等待及单项RX观测；最终编辑正文重新计算。无参数行为兼容。拒绝时间轴库不支持或被规范化改变的正文。
4. 增减：无新入口、服务、进程、协议、依赖或记录schema；策略参数放入原intent detail，观察放原send_result detail，不解除intent。新增CLI选项/进程内方法，不开放GUI真实发送。
5. 验收：仅受影响session/runner专项与build，隔离内存transport验证早期RX不提前结束、TX重置稳定窗、超时不报成功、取消/NG不继续等待、默认原五事件及启用策略时六事件/未决保留；结果及失败修正见原GUI证据。不重跑旧音频/GUI/设备验收。
6. 边界：估算正文时间×1.25＋500ms后才开始600ms连续采样RX窗口，100ms采样，额外观察最多5秒；均为未校准工程默认，不是实测硬件上界。未起发也可能满足，结果仍UNKNOWN。Ctrl+C可取消等待，查询在途最多等原查询超时；查询故障会按原规则锁定/关闭，停止可能无法写出，记录保留未知。无真实设备操作、不自动放行下次发送、不改GUI布局。

下方调查已结束；其“尚未批准实施”由本段替代，证据限制继续有效。

## 当前收口：真实CW结束判定调查（2026-10-23）

1. 缺口：一轮模拟后恢复收听已完成；真实发送尚不能依据命令应答决定恢复时机。
2. 主链/复用：runCwTrial → CwTrialSession.sendMessage/sendStop，复用P2-008原手册调查；只补Hamlib及官方固件资料。
3. 最小范围：证据调查与既有文档收口；没有可靠设备完成接口，不建立空的完成观察器或第二套发送实现。
4. 增减：入口、进程、协议、依赖、存储格式零变更，ACK/UNKNOWN及原账本阻断不变。
5. 验收：固定源码提交，核对官方补充资料及原runner位置；见原GUI证据新段。只读/文档工作不重跑产品测试、构建或旧预检。
6. 不做：不接设备、不发射、不解除旧intent，不以PTT_OFF或计时冒充完成。下一决策是是否接受明确标为估算的运行策略，尚待讨论，无新增代码任务。保护见MEMORY顶部。

下方模拟增量已交付，历史证据继续有效。

## 当前增量：实时收报一轮模拟后恢复（2026-10-23，用户已同意）

状态：限定交付，结果见MEMORY顶部与原GUI证据。本轮只做一轮模拟后恢复接收；原账本继续阻断后续新发送，真实/连续自动通联未完成。DSH代码审议超时未结论，不计独立验收通过。

1. 缺口/完成条件：实时有效提案可人工编辑确认或显式自动模拟一次，原采集/解码清理确认后才能试验，结束恢复同一ReplySession继续收报；stop取消且不恢复。
2. 主链：原runReceive音频分支提供仅进程内pause/resume；原GuiSimulation先pause后走原runCwTrial/绑定/lease/账本。原onEvent完整validated回复触发自动桥，单个simulation.task串行。Codex持有修改权，DSH只读交叉审议。
3. 范围：原receive、GUI adapter/simulation/main/renderer及专项。暂停只中止一段runAudio，ReplySession不销毁，等待清理期间的新电文仍撤销旧提案；同一实际经过时间预算覆盖暂停。失败不自动重试。
4. 增减/兼容：无新IPC/服务/依赖/记录格式/发送器；增加内部音频生命周期回调及paused/resumed事件，CLI默认行为兼容。沿原函数恢复采集进程，不新增常驻进程；不是路径替换。
5. 不做：不接真实设备、不解除历史intent、不建设连续发送/自动核查。一轮成功后恢复接收，原账本使下次发送继续阻断，这项限制保留。独立fixture仅供验收，不作为正式账本恢复。
6. 验收/保护：`.local-backups/20261023-live-roundtrip/`含source-before.tar、dirty、dist、非凭据profile；新增测试/脚本此前不存在。只测受影响暂停清理/停止/失效/编辑/单次派发与一次真实monitor闭环。DSH设计exit0；其要求重复锁/先写回复账本及进程归属的假设与实际同进程/原runner末端校验不符，Codex不采纳；清理确认/单所有者/总预算意见采纳，无新框架。

下方“实时模式禁止所有模拟”是上一增量边界，由本次明确授权替代；其收听证据继续有效。

## 当前增量：GUI实时收听（2026-10-23，用户已同意）

1. 缺口：GUI只能选PCM文件，无法直接收听已有实时音频输入。
2. 主链与复用：原startReceive IPC → runReceive → 既有FFmpeg输入/后台multimon/continuous ReplySession → 原GUI事件投影；停止沿原AbortSignal释放子进程。
3. 最小范围：GUI输入选择、显式设备名/后端/FFmpeg文件；薄参数适配使用原parseReceiveArgs校验，PCM默认兼容。显示新电文/回复，人工草稿继续由原renderer保存。
4. 增减：无新依赖、IPC、服务、协议、记录格式或发送循环；采集进程种类复用已有CLI音频路径。实时模式在界面及核心适配层均禁止人工/自动模拟。
5. 验收：只测GUI受影响边界、构建和一次真实桌面monitor音频→解码/建议→编辑保留→停止释放；用既有样本/mock，无麦克风、电台、付费模型。原生文件返回的测试替代须披露。
6. 不做与保护：不接实时发送、不以停止作为发报、不扩恢复机制，不重验旧解码器/设备/AI。基线`.local-backups/20261023-001943-gui-audio/`含GUI/文档原副本、dirty patch、dist归档；保持原一小时采集超时和连续回复轮数上限。结果见MEMORY顶部及原GUI证据。

下方自动模拟增量已限定完成，保留历史证据，不再作为当前待办。

## 当前增量：GUI会话自动模拟接入（2026-10-23）

1. 缺口：CLI已有一次自动模拟，GUI此前只有逐条完整正文确认；补同一会话显式自动模拟开关，不开放真实设备。
2. 复用：现有setMode IPC→原ReplyDispatchControl；main收报exit0后且adapter为completed/当前有效提案时→GuiSimulation薄适配→原runCwTrial/一次性lease/原记录。也允许收报完成后显式开启即派发一次。
3. 修改：原GUI adapter/simulation/main/renderer、原runner两处仅模拟回复TTY判断和定向测试；非TTY自动模拟必须由原控制器成功授予lease，不能用桌面人工回调代替自动授权。真实TTY限制不变。
4. 增减：零新IPC/依赖/服务/发送循环/设备协议/存储格式，原账本未决规则不变。checkbox只针对当前已启动的会话；新收报重置人工。手改时不能开启自动，进入编辑切人工，编辑正文仍走原人工确认；切人工/stop令旧绑定失效，同提案一次尝试限制沿用。
5. 验收：受影响runner/GUI专项61/61，build、GUI typecheck/build通过；实际隔离Electron窗口默认人工→完成原PCM/真实multimon/mock提案→点击自动开关→无人工prompt自动一次→exit0/五事件/无横溢出，截图已核对。正常EOF后自动入口受exit0和completed双重约束；错误/无提案/未完成/编辑/切人工/stop及重复由专项覆盖。未做真实设备/模型/连续QSO。
6. 保护/不做：`.local-backups/20261023-000131-gui-auto/`含GUI/runner/tests/文档原副本、dirty、dist/profile、runtime脚本和fixture证据。正式账本SHA256不变，不扩恢复机制，不重复人工确认窗口验收。DSH交叉审议exit0但只读行级搜索，结论有未经读取的假设，Codex已逐项以实际代码/测试核对，不计独立审议通过；详见证据。

## 最新收口：GUI人工确认模拟窗口闭环（2026-10-22 23:54）

用户要求停止扩大恢复机制，已在独立fixture工作目录以同一编译GUI和原runner完成编辑→完整正文确认→一次模拟→结果显示，实际截图/五事件通过。正式账本不变，隔离验收不等于现场核查解除；原生文件选择仍用临时dialog返回替代。无产品代码变更，无新入口/服务/格式，不重复build/历史专项。证据及基线`.local-backups/20261022-235144-gui-success/`。此项已完成，不再重排为下一步；整体自动收发/0.0仍未完成，事实以MEMORY顶部为准。

## 当前阻塞处置方案（2026-10-22，用户已同意，限定实现）

用户已明确“同意”上述人工核查方案，现实现原runner的--review-intent/--operator/--note路由与同账本v2 intent_review；原v1读写沿用。发送/核查都获取原目录独占锁并持有至清理结束，不增加服务或第二真源。历史现场记录未解除。以下方案中的“待批准/未实施”措辞为批准前分析历史，由本段和MEMORY顶部当前事实替代。

保护`.local-backups/20261022-211024-intent-review/`：原record/runner/tests/README/MEMORY/ROADMAP/任务/证据、dirty补丁、dist归档和DSH非凭据profile。新增tests/cw-trial-review.test.ts。原记录SHA256不变。首次61/61，补取消/故障后65/65；最终审议修正只重跑受影响核查专项，见证据。本轮无设备/付费模型/GUI改版，不把功能批准视为人工解除现场intent。

可观察缺口是正式GUI在确认前被旧intent阻断；进一步查明原store对任何历史intent永久返回true，成功模拟也如此。不存在可直接调用的当前主链核查入口。Fake核心的resolve-unknown属于冻结的SQLite/daemon路径，不迁入、不重建服务。

现场只读证据：原logs/cw-trial/cw-trial-intent.jsonl共6条记录、1个intent，ID为54120b05-88e4-4a83-9cc9-5c7a5e54ac52，session d276dcb1-04f8-4f05-be83-fecd57247b80，时间2026-10-14T15:20:55.098Z。正文E，随后有send_result、stop_intent、stop_result、session_close；命令应答为FB，关闭确认true。与P2-015现场试验相符，但仍没有报文完成/物理停发证明。文件SHA256为d1de5f1e6894078dd9ab630f27e2cf6227bce9635acbd0e036a79fb0cc3438ac；本轮未写账本。

建议最小增量，以下均为待批准设计，不是既有能力：

1. **复用及范围**：原runCwTrial参数路由、CwTrialRecordStore.scan/append/fsync、同一JSONL；仅增加一个显式人工核查动作，不开transport，不同时发送，不新增服务/依赖/第二账本/设备会话。GUI成功验收仍走既有模拟链。
2. **核查语义**：操作人核对指定旧intent、原试验进程已退出、当前设备状态及隔离依据；填写真实operator/note并完整确认目标ID。Codex不代填事实或代做人工确认。本动作只承认人工承担后续重新操作的决定，不把旧执行标为completed/stopped，也不自动执行或重试旧报文。
3. **记录变化**：在原文件追加一种有版本标记的核查事件，结构化绑定intent ID/原记录内容摘要/operator/note/核查时间；不覆写旧行，不把核查文本藏在session_close.detail中。兼容读既有v1记录；老程序不识别新事件时继续fail closed。具体字段在批准后的局部实现确定，不另建迁移平台。
4. **阻断规则变化**：仅有完整、有效核查且引用同一旧intent内容的记录可结束该条intent对后续操作的阻断；旧操作结果仍unknown。未知ID、错摘要、损坏/不支持版本、遗漏任何其他intent均继续阻断。新intent不受旧核查覆盖；模拟也不自动清除，更不从FB/关闭/经过时间推断解除。
5. **竞争与退出**：核查必须在收发任务全部退出且独占原账本期间完成，写前重读、核对目标并刷盘。现有store只有实例内写队列，没有跨进程独占；实现必须同时约束原runner与核查动作，不能只加核查写锁。只在同一目录使用小范围独占机制；无法可靠保证则停止实施并反馈，禁止用一次检查进程列表代替互锁。
6. **验收/保护/回退**：定向验证核查本身零transport、原行不变、有效核查仅影响指定intent、错误/重复/新intent/损坏/写失败/并发保持预期阻断，真实TTY与原模拟发送不回归。先在fixture上实现验收；现场旧intent须用户另行提供核查事实并显式执行，批准代码不等于批准解除这条记录。恢复旧程序会因不识别新事件继续阻断，账本不回滚、不删核查行；源码按本轮新基线恢复。

代价比较：原地追加核查需要局部扩展记录格式和独占边界，但沿原主链解决实际阻塞；清记录/换目录丢失阻断，禁止；直接按FB/关闭自动解除缺证据，禁止；恢复Fake维护服务增加第二真源且不适配此JSONL，不采用。模拟/真实记录隔离可另行讨论，但当前没有因此重选存储、建立模拟平台或绕过旧intent的授权。

历史审批节点：该方案改变原恢复语义和记录格式，因此曾先提交用户确认；本轮用户明确同意后进入以上限定实现。批准前文档基线`.local-backups/20261022-205032-intent-review-design/`保留。

## 当前增量：GUI人工确认后一次模拟发送（2026-10-22）

状态：实现及55/55定向专项、构建通过；实际窗口已验证原历史intent阻断与草稿/结果显示。确认区和成功结果实际窗口仍待验，DSH审议超时无最终结论；详见GUI证据与MEMORY顶部。当前唯一后续是核对既有历史未决记录的处置边界，不得换目录/删除记录绕过。真实发送、GUI自动发送、0.0未完成。

1. 缺口：GUI可编辑但不能确认正文并运行既有模拟发送；仅接当前已完成PCM会话的有效提案，不发空白无提案草稿。
2. 复用：renderer/preload→同进程薄适配→runCwTrial→CwTrialSession及原simulator/store；新增runner仅模拟桌面确认回调，真实设备仍TTY且不允许此回调，不伪造TTY。
3. 范围：GUI API/adapter/main/renderer和原runner，新增薄确认适配模块与定向测试；同提案只允许一次尝试，候选正文和当前身份绑定，预检后用户输入完整正文再确认。
4. 增减：本机IPC增加startSimulation/confirmSimulation，现有通道没有正文确认语义无法满足需求；无新依赖、后台服务、发送循环、设备协议、记录schema或授权真源。记录沿原logs/cw-trial，未决阻断不绕过。
5. 验收：runner原TTY/真实边界及新增回调定向测试；GUI旧请求/错误正文/重复/取消/失效零派发和一次实际模拟记录；真实窗口确认区及结果显示。stop/关窗沿同一个AbortSignal并等待runner收尾。
6. 不做：不接真机/天线/实时输入，不开放GUI自动发送或任意空白草稿发送，不重开布局/文件入口。保护`.local-backups/20261022-203724-gui-simulation/`含目标副本、dirty、dist和既有logs/cw-trial副本；Codex持有源码修改权，DSH只读设计审议。

## 2026-10-22：文件动作不得覆盖人工草稿

1. 缺口：通用动作run在返回editing:true时重填草稿，取消/选择文件会丢失手改文本。
2. 复用：原renderer run与beginEdit，不动原IPC/收报主链。
3. 最小范围：App.tsx增加显式初始化标志，仅beginEdit传true；保留同一个draft。
4. 入口/进程/依赖/协议/存储/状态真源零增减，不涉及业务链替换。
5. 验收：GUI typecheck/build exit0；真实Electron输入MANUAL DRAFT KEEP→打开原生文件框→Escape取消→草稿原样，已恢复用户原空白草稿。
6. 不做：不改布局、不加文件入口、不接GUI发送。保护`.local-backups/20261022-202644-native-chooser/`含原文件/dirty/产物/用户现场与draft-result.json。

原生选中路径仍因本环境自动操作未成功而待验，打开/取消已有实际证据；不再无限排查同一XTest方式。GUI模拟发送沿原runCwTrial，但须先明确其TTY确认到桌面确认的契约适配，不允许伪造TTY/自动代答或另建发送器。

## 2026-10-22：GUI运行时限定验收

用户授权Codex操作已有窗口，验证PCM收报/建议/人工编辑/停止。既有主链为renderer→受限preload/原IPC→Electron同进程runReceive→multimon/ReplySession；只添加备份目录的一次性检查脚本及更新现有文档，产品源码/依赖/IPC/协议/记录格式不变。复用已有cq-test.s16le、真实multimon和accept-mock.json，零付费模型/设备/发射；验收仅补GUI运行证据，不重跑CLI/设备专项。

当前限定结果：GUI收报显示、mock建议显示、建议带入编辑和人工输入、EOF清理、主动停止解码进程通过。原生文件选择自动操作未成功，后半段明确用临时dialog返回值替代；原生文件选择保持待验，不能称整条GUI操作验收完成。编辑期间新上下文不覆盖草稿也尚未覆盖。保护/用户草稿恢复/证据见MEMORY顶部和GUI证据的本轮记录；不自动扩大到GUI提交/发送实现。

## 2026-10-22：人工干预入口修正

用户再纠正后追加最小修正：空提案状态也必须可直接写草稿；只去掉renderer编辑按钮和编辑框的提案非空条件，复用原`beginEdit`及本地draft，零依赖/IPC/协议/存储/状态真源增量。不实现提交/发送。GUI typecheck/build及真实Electron“点击→聚焦→输入→清空”已通过，草稿现可直接输入；保护`.local-backups/20261022-194822-gui-blank-draft/`。下方空会话未验描述为前轮历史状态，最新范围见MEMORY顶部。

1. 用户可见缺口：底部编辑入口不易发现；保留已获认可左右布局，把编辑动作与回复正文放在一起。
2. 复用位置：renderer按钮仍调用`window.cwstation.beginEdit`，经原IPC/GuiStateAdapter切人工模式；停止仍调用原`stop`。Codex持有修改权。
3. 范围：只改App.tsx和styles.css，移动既有编辑按钮和草稿框；兼修760px下呼号/开始按钮底边不齐。不新增提交、发送、取消功能。
4. 增减：入口、进程种类、依赖、IPC、协议、存储格式、状态真源均无变化；不涉及业务路径替换。
5. 验收：GUI typecheck/build、GUI专项6/6通过；Electron真实窗口CDP、桌面/760px截图、中英文切换、窄窗控件底边一致及无横向溢出通过。编辑实际点击/输入和文件选择/PCM/Stop进程回收仍待验。
6. 保护与边界：`.local-backups/20261022-193940-gui-intervention/`含源码/文档/dirty/dist/profile基线；不改变0.0范围，不宣称草稿可提交或GUI可发送。DSH仅只读交叉审议，无源码修改权。

状态：2026-10-22用户确认A，决定冻结。CLI会话授权首增量已限定验收；GUI已沿现有`runReceive`事件流接入PCM文件收报和AI提案显示，复用multimon、ReplySession与同一`ReplyDispatchControl`。构建、GUI专项及受影响receive/reply专项通过，详见[证据](../evidence/V00-04-A-GUI切片.md)。Electron实际窗口操作及Stop后的运行时进程清理尚待验；不含GUI发送、实时音频/电台、连续自动发射，整个04-A和0.0未完成。

### 2026-10-22：工作区布局重排

1. **用户可见缺口**：设置区横向展开并抢占首屏，核心收报/回复提案不突出，状态与操作也离主要内容较远。
2. **既有调用位置与复用对象**：只调整既有`App.tsx`工作区容器和`styles.css`；控件仍调用同一`window.cwstation` API，后台仍由同一个Electron主进程调用`runReceive`。
3. **最小修改范围**：桌面改为左侧配置栏、右侧收报工作区；900px以下纵向堆叠；压缩配置文件行。未更改业务逻辑或字段。
4. **入口/进程/协议/存储**：无增减，不增加依赖、IPC、状态真源或业务行为。
5. **验收方法**：GUI typecheck/build、GUI边界专项、diff check通过。未安装浏览器自动化截图依赖，本轮未完成Electron截图视觉验收。
6. **明确不做**：不改收发主链、不新增功能、不改0.0范围；Electron文件选择、PCM运行及Stop清理仍待原定一次运行时验收。

保护基线：`.local-backups/20261022-gui-layout-rethink/`。

## 2026-10-22：多语言与界面收敛增量

用户指出原界面层级低级并要求多语言。此增量沿现有Electron/React renderer修改，不改变V00-04-A主链。

1. **用户可见缺口**：原界面英文写死、设置入口靠后且诊断字段抢占主视线；现改为简体中文/英文词典、系统语言初始选择、顶部手动切换并保存单个GUI偏好键。
2. **既有调用位置与复用对象**：继续使用`window.cwstation`现有IPC和`runReceive`状态；新增`renderer/locale.ts`只负责静态产品文案与状态文案映射。呼号、文件名、解码电文、AI正文不翻译。
3. **最小修改范围**：`renderer/App.tsx`、`renderer/styles.css`及词典模块；重排为会话设置→状态→收报/建议→编辑/停止，采用克制的原生桌面视觉，不引入UI框架或新依赖。
4. **入口/进程/协议/存储**：不增加IPC、进程、业务状态真源、设备协议或服务；仅使用浏览器已有`localStorage`保存语言偏好，不保存会话或电台数据。
5. **验收方法**：`gui:typecheck`、`gui:build`、GUI边界专项6/6及`git-local diff --check`；Electron文件选择/PCM/Stop清理仍保持原待验状态。
6. **明确不做**：不扩展语言数量、CLI文案、AI/电报码翻译、发送链、实时设备和安装包；后续新增语言需在版本迭代中单独评估。

### 2026-10-22：玻璃质感与交互动效修正

用户明确指出前版距离预期Apple风格差距很大，缺少玻璃材质、数码质感与运镜。本次沿同一renderer入口重做视觉表现，不重做业务结构。

1. **用户可见缺口**：前版是静态浅色表单，缺少空间层次、材质反馈和运行态动效；现加入暗色空间背景、玻璃层、信号频谱、运行灯、按钮交互和轻视差。
2. **既有调用位置与复用对象**：只改现有`App.tsx`与`styles.css`，所有动作仍调用原`window.cwstation`；用现有`receiveState`决定运行态光效，不制造新状态源。
3. **最小修改范围**：renderer视觉与指针位置带来的CSS变量；响应`prefers-reduced-motion`。无新JS/CSS库。
4. **入口/进程/协议/存储**：零新增入口、进程、IPC、协议、存储格式和业务能力。
5. **验收方法**：GUI typecheck/build、GUI边界专项；检查桌面/窄屏布局及减弱动态效果规则。Electron文件选择/PCM/Stop运行时验收仍独立待办。
6. **明确不做**：动效仅用于视线引导与信号状态反馈，不模拟真实频谱/射频数据；不改界面职责、收发主链、CLI或0.0功能边界。

保护副本：`.local-backups/20261022-gui-glass-motion/`。

### 2026-10-22：视觉复盘后的收敛修正

上述玻璃/HUD视觉增量已被本次修正替代。用户要求研究并反思后，对照 Apple HIG Materials/Motion 与 Microsoft Mica，确认内容层不应铺满玻璃，装饰性频谱/扫描线与鼠标视差没有真实业务含义。仍沿同一renderer入口：材质仅用于导航/控件层，收报与提案用稳定可读内容面，动态反馈只呈现真实状态；无新增入口、依赖、IPC、业务状态或功能。

本轮验收：构建、GUI typecheck/build、GUI专项6/6通过；Electron独立调试实例截图 `/tmp/cwstation-visual-review-current.jpg`（1280x900）已视觉核对；文件选择、PCM运行及Stop后decoder清理仍待交互验收。保护基线：`.local-backups/20261022-gui-visual-review/`。

### 2026-10-22：VibeUI Zapier 视觉参考

用户指定参考 `https://vibeui.top/style.html?slug=zapier&lang=zh`。读取页面与其 Zapier 预览后，提取暖白底、近黑正文、Zapier橙主动作、Inter功能字体、细分隔线和小圆角；将营销品牌样式转译到既有工作台分区，不增加 hero/营销布局。改动限 `renderer/styles.css`，既有入口、控件、IPC、状态真源和收报主链不变。构建、GUI typecheck/build、GUI专项6/6、diff check通过；Electron截图 `/tmp/cwstation-zapier-reference.jpg`已核对。PCM/文件选择/Stop清理仍未验收。保护基线：`.local-backups/20261022-gui-zapier-reference/`。

## 当前事实与缺口

- 产品目标为AI参与的CW自动发射软件；会话自动模式A已冻结，真实设备接入及整体验收仍未完成。
- 已有主链：`cwrig receive → apps/rig-receive.ts → ReplySessionImpl → requestChatCompletion`。模型和本地CQ规则只发布经过校验的提案；不拥有设备执行权限。
- 单次发送已有链：`apps/rig-cw-trial.ts → runCwTrial → CwTrialSession`，含交互确认、预检、确认后重读、intent记录、一次发送、停止和关闭。收报提案当前只衔接模拟发送；实时接收/连续AI尚未获得自动发送授权。
- UI选型已由用户决定为Electron + React + TypeScript、Vite构建；当前实现已存在，沿用共享控制核心。见[ADR-021](../adr/ADR-021-桌面界面与CLI选型.md)。
- 设备现场当前无天线，自动派发离线实现不能伪称真实空口验收。

## 当前桌面增量：真实 PCM 收报与 AI 提案显示

视觉约束（2026-10-21用户纠正）：renderer已完成一次Apple风格视觉重构。此增量接入现有receive/reply主链，不重做视觉或选型。

1. **用户可见缺口**：此前GUI静态演示的缺口已通过本地PCM文件接入原receive/reply链解决；当前待验缺口是Electron实际窗口操作和Stop后的运行时清理。
2. **既有调用位置与复用对象**：Electron主进程直接调用`runReceive`，由其调用`runMultimonReceive`与`ReplySessionImpl`；继续使用同一`ReplyDispatchControl`作为停止/授权对象。不得启动CLI子进程或第二套解码/AI实现。
3. **最小修改范围**：扩展`runReceive`现有结构化输出注入点；主进程增加单次PCM会话编排，preload/API增加文件选择、开始与状态读取，适配器消费原JSONL事件，React页面显示真实接收块/提案及运行状态。发送、编辑后的发送确认仍不在本增量。
4. **入口/进程/协议/存储**：新增本机IPC命令和状态轮询，不增加进程种类、网络服务、设备协议、数据库或持久化格式；主进程以固定argv调用现有`runReceive`，不经shell拼接。解码器、PCM和回复配置由本机文件选择器选择，呼号由界面输入并经既有参数校验。
5. **验收方法**：已用mock模型/解码器证明`runReceive`结构化事件与嵌入回调一致，并通过adapter事件投影专项；Electron实际窗口/本地文件选择及Stop触发子进程清理仍待一次运行时验收。既有GUI/receive专项和构建已按本轮受影响范围验证。
6. **明确不做**：不接电台/天线或实时麦克风，不连接`runCwTrial`到GUI、不发射、不改变TTY限制、不实现编辑提交/人工发送、不做多轮自动通联、打包或第二状态真源。

## 已确定产品选择（比较历史）

| 选择 | 行为 | 结果 |
|---|---|---|
| A. 会话级自动模式（推荐） | 每次会话默认人工模式。用户显式启用自动模式后，所有经确定性校验且仍绑定当前接收上下文的AI/本地提案通过现有执行链自动派发一次。进入编辑立即暂停该提案，编辑后的最终正文必须由用户明确确认；新接收/取消/上下文失效撤销旧派发资格 | 满足自动派发目标，同时保留编辑路径；需要在现有runner上增加受限授权输入，不新增发送状态机 |
| B. 仅本地CQ命中自动派发 | 03-E严格本地规则命中时自动派发；AI回退提案仍逐条人工确认 | 快路径自动化，但一般AI回复仍是人工操作 |
| C. 全部逐条人工确认 | 0.0只提供AI辅助人工发报；所有真实发送继续人工确认 | 改动最小，但不满足自动派发目标，除非用户明确接受该目标收缩 |

用户已选择A；B/C只保留决策比较，不再请求选择。每次会话默认人工模式；不加倒计时。人工编辑入口进入即暂停当前提案，编辑后的确切正文重新走校验和确认。自动范围包括本地CQ和AI回退回复，不包括`wait`、`no_reply`、`end`、非法内容、过期提案或未决intent。该决定授权范围内实现，不代表当前已具备真实空口验收或本次发射许可。

## 实施六项

1. **用户可见缺口**：CLI已有收报/提案和人工编辑模拟发送，没有桌面界面；本任务将已确定的A授权接入现有链。GUI/CLI需一致表达当前模式、收到的文本、提案来源/正文、编辑/撤销、设备执行状态与结果。
2. **既有调用位置与复用对象**：复用`runReceive`/`ReplySessionImpl`、receive/multimon、`runCwTrial`/`CwTrialSession`及原CI-V预检/重读/intent/停止机制。GUI不直接打开串口，不复制发送循环。
3. **最小修改范围**：A已确认；先接入CLI会话授权，再接通同一单对端CW收发流程的Electron操作界面，不做新QSO模板、日志/比赛工具、扩展布局或跨系统安装器。
4. **增减入口/进程/协议/存储**：复用既有CLI和会话核心，不增daemon、网络服务、设备控制器、持久化授权、状态真源或记录格式。Electron主/渲染进程确需IPC时，只允许引入本机、类型受限的GUI边界；具体通道与允许操作写在实施任务卡中，不能承载原始设备命令。
5. **验收方法**：同一业务调用链覆盖PCM/已支持输入→提案→GUI/CLI可见→模式控制/编辑/撤销→既有runner模拟一次发送与原格式记录。自动策略获确认后用mock证明模式门控、上下文撤销、单次派发和未决阻断；真实AI/设备按实际可用条件专项验收。未接天线期间不发射，不把模拟验收写成真实自动发射。
6. **明确不做**：不重跑03-D原68项、历史解码/设备预检/只读证据；本增量只接本地PCM文件与既有receive/AI提案，不接实时电台/天线，不连接`runCwTrial`或发送；不新建第二收报/AI/发送循环、后台服务、缓存服务、网络控制面、记录库；不扩展无人值守、多对端、扫频、比赛、其他版本候选。

## 下一动作与修改权

当前源码增量完成：`runReceive`增加可选`onEvent`而CLI原输出不变；Electron在同进程调用现有接收主链。会话ID过滤晚到事件，新块/no-reply/失效撤销旧提案授权；文件、配置和呼号均为开始条件，自动发送控制不在此GUI操作面提供；停止/窗口关闭复用原取消信号并等待receive结束。构建和GUI 6/6、receive/reply 45/45通过；Electron运行时已确认窗口加载及控件呈现，但文件选择/PCM和Stop后的子进程清理尚未交互验收。

修改前保护：`.local-backups/20261021-193651-session-authorization/`保存dirty补丁、目标源码/未跟踪测试和文档归档、dist、实际headless/cordis.yml非凭据profile及protected哈希。新增文件`apps/reply-dispatch-control.ts`、`tests/reply-dispatch-control.test.ts`、本切片证据在保护前不存在。

首增量修改权已由DSH交回Codex。原授权范围为`apps/reply-dispatch-control.ts`、`apps/rig-cw-trial.ts`、`apps/rig-receive.ts`、`apps/cwrig.ts`以及对应三份定向测试；Codex在交回后修正编辑/停止/最后派发边界与单次消费，双方没有同时编辑源码。

1. 用户可见增量：原`cwrig receive ... --reply-trial-simulate`允许显式`--reply-auto`授权本次操作在正常PCM EOF后自动模拟发送一条当前合法回复；默认无此参数仍人工确认/EDIT。不改变prepared/continuous限制，不开放实时输入或真实设备。
2. 主链接入：`runReceive`创建/接收同一个进程内`ReplyDispatchControl`，显式参数启用自动；传给原`runCwTrial`。控制对象只负责会话授权/撤销/一次消费，不接收流、不构建帧、不打开设备、不写记录、不另造发送状态机，当前CLI必须实际调用，不能仅做候选helper。
3. 授权边界：默认人工；自动授权绑定精确正文、sessionId/turnId/revision及控制代次。模式切换、开始编辑、停止使旧自动授权不可复活；自动开关重新打开不能恢复旧lease。异步预检/重读/intent后检查模式、binding.isCurrent和取消，紧邻send前一次消费。重复使用同一提案不得二次自动派发。控制对象不拥有第二份草稿，人工EDIT仍由原runner处理并重新校验。
4. CLI/嵌入接口：新`--reply-auto`只与原PCM文件/TTY/模拟发送组合；缺前置、重复、stdin/实时/真实组合早拒绝。允许嵌入调用者传入同一个control对象以便未来GUI/CLI在预检期间切回人工、编辑或停止；显式CLI参数只在会话开始启用一次，不在每条提案后覆盖人工撤销。人工模式维持原完整正文确认，旧simulate-confirm不能冒充reply授权。JSONL明确automatic/manual与simulator范围。
5. 最小验收：控制对象默认人工/模式撤销-重开不复活/编辑撤销/停止/精确身份绑定/一次消费；原runner自动零prompt但预检/重读/intent/停止/关闭保留，模式或提案在重读/intent落盘后失效零正文帧、未决保留；人工EDIT行为兼容；同一`runReceive`显式auto，CQ和AI回退两类都通过原runner自动模拟发送，no_reply零发送、缺参数早拒绝。只跑控制、cw-trial及受影响receive专项和一次build，失败有依据修正后定向复验，不重跑解码/设备/全仓/真实模型。
6. 不做及升级条件：本轮不改`CwTrialSession`、真实串口白名单、记录schema/未决解除，不新增依赖/入口/后台/网络/GUI空壳。原runner一次性、真实发送仅E/TEST、未决intent限制是已知未交付范围；后续真实连续操作需沿原链处理，不以删记录或换目录绕过。发现需突破上述边界时带证据反馈，不能自行增加第二链路。
