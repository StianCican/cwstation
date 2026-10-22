# V00-02 fldigi收报薄适配 v1

## 当前执行切片：V00-02-D 实时音频输入

状态：2026-10-21限定验收通过，DSH exit0交回，Codex复核。新专项16/16、旧CLI5/5、build通过；最终编译CLI经真实FFmpeg/WSLg monitor完整解出CQ TEST，主动停止exit0。首次播放器截断失败及诊断保留，给测试播放补尾静音后通过，产品采集/解码参数未变。见docs/evidence/V00-02-D-实时音频输入.md。Windows/电台/物理麦克风/噪声/长时未验，下一切片待定；下方保留实施契约，不自动重复执行。

2026-10-21。用户“可以试试”授权沿现有收报主链补实时采集。唯一目标缺口：目前只能读文件/stdin，不能由项目选择音频输入并管理其生命周期。主链为cwrig receive → 共同receive音频薄适配 → FFmpeg stdout PCM → 原runMultimonReceive → 既有文本事件。复用现有FFmpeg与multimon，不新写驱动/解码器；原PCM模式保持可用，二者只改变同一解码路径的输入源。

最小范围：新增packages/receive/src/audio.ts管理一个FFmpeg采集子进程并调用原runMultimonReceive，index导出；原地扩展CLI与usage、README，新增定向专项。音频参数为--ffmpeg <executable> --audio-backend <pulse|dshow> --audio-device <name>，与--pcm-s16le严格互斥；--decoder/--timeout-ms沿用。用户明确指定设备，不自动捕获默认麦克风。固定格式22050Hz/mono/s16le，固定FFmpeg采集参数，无任意args/shell/网络输入。pulse为Linux，dshow为Windows；设备名作为单个argv传入，不做shell拼接。不自动安装Windows软件，本机Windows PATH无ffmpeg仅作为环境事实，不推断全盘未安装。

资源/错误契约：预算覆盖采集等待与解码；只创建一个采集进程和一个既有解码进程。FFmpeg输出按流背压传入原解码入口，不写原始音频文件、不无界缓存。stderr持续排空，保留上限64KiB，不回显原文。捕获进程缺失/启动失败/自然提前退出（包括0）明确失败，不能以解码空文本/主动取消冒充成功；解码失败或取消必须清理采集进程，捕获失败必须取消解码，停止后无迟到文本。SIGTERM宽限后SIGKILL并确认退出，未确认任一子进程关闭必须失败；预取消不启动任何子进程。原解码器回调与字节校验不另写一套。返回可观察PCM字节计数及会话状态，但计数不等于抄收成功。

新增一个会话内采集子进程，无新可执行入口/常驻服务/协议/持久化格式/设备持有者；不替换历史文件能力，无数据迁移。明确不做GUI、AI、发报、电台设置、自动回退采集源、多设备、发布或泛化插件平台。Windows原生代码路径与实际运行验收分别报告，电台当前未接。Linux实际采集用WSLg回放monitor源，避免采集个人麦克风；同一已验样本通过真实音频播放/采集进入产品CLI，属于新增输入接通验证，不重做旧文件验证。

保护：HEAD2fcfd33和.local-backups/20261021-000636-audio-input/保存dirty补丁、所有原未跟踪文件、修改目标副本、dist及非凭据profile。新audio.ts/专项/evidence事前不存在。DSH独占上述代码、README和新证据；Codex只维护MEMORY/ROADMAP/本任务，交回后复核。DSH不得修改multimon.ts/既有解码专项/依赖/发送/全局配置，不装工具、不用子agent。超出此范围或需要变更公共策略时带证据升级。

验收减负：DSH设计和首条可运行链路合并自查R01-R13，约8-12个新增高价值用例覆盖固定参数/模式互斥、背压、缺失/非零/提前正常退出、任一进程失败清另一方、预取消/中途取消/超时/SIGKILL与未确认关闭；只跑新专项及受影响旧CLI用例、一次build，不跑全仓/设备/多平台矩阵。最终编译CLI的真实monitor采集由Codex另验；DSH约10分钟内优先交付可审稿，保留失败证据，不无限迭代。所有日志/临时目录仅在本项目，不读凭据。

## 历史已完成切片：V00-02-C 后台收报主链接入

状态：限定交付已验收，DSH已退出并交回，Codex修正三项边界并完成真实编译CLI样本验收。最终专项24/24、build exit0，真实multimon-ng从未补静音PCM解出CQ TEST、exit0。证据见docs/evidence/V00-02-C-后台收报主链接入.md；空格单块保留、空输入不补静音、预取消不打开源已覆盖。运行预算含输入等待/解码，超时后另有有界清理宽限。声卡、GUI、AI、Windows及电台不在本切片验收范围。下方实施契约保留供追溯，B切片的“下一切片/尚未迁移”仅为当时状态，已被本次交付替代。

用户已明确同意最小迁移。唯一交付是让本项目CLI实际使用已过探针的后台解码器，供以后GUI复用同一模块；不再停在候选。主链`apps/cwrig.ts receive → apps/rig-receive.ts → packages/receive → 一个multimon-ng子进程`；发送沿ADR-020不动。

输入契约：`cwrig receive --decoder <executable> --pcm-s16le <file|-> [--timeout-ms <1..3600000>]`，默认总运行预算60000ms；`-`为stdin。只接22050Hz、mono、signed16 little-endian PCM（当前x86及目标Windows），拒绝非字节块/奇数字节最终残片；跨块奇数长度须正确拼齐，输入流不得无限缓存。文件转换复用已有ffmpeg在验收时完成，不加WAV解析器/声卡驱动/转换服务。正常输入EOF且有完整数据才补0.5s零值静音，随后关闭引擎stdin；取消/失败不补静音。共同模块接受Readable或AsyncIterable字节源、异步文本回调，处理输入及输出背压；GUI以后直接调用，不解析CLI stdout。

进程契约：shell=false、windowsHide=true，固定参数`-q -c -a MORSE_CW -t raw -`；不暴露任意解码器方法/额外参数，不重启/重试。源格式及source=multimon-ng、readOnly=true、sessionId/seq/text/receivedAt事件语义写清，序号只给非空有效文本，UTF-8跨块解码不丢字符。stdout流式有总字节上限（默认1MiB即可），stderr持续读取但最多保留64KiB且不回显原文；不得因stderr大而无限积累。stdout数据不能等换行才交付，不保证每块是完整字符/词/QSO。

输入错误、引擎缺失/非零/未收到EOF就退出、超时/输出超限明确失败；已有文本可保留但不能报整个输入完成。单会话一个引擎，回调串行await；回调报错也终止并清理。SIGINT/SIGTERM/外部Abort取消后无迟到文本，停输入/销毁拥有的输入源并SIGTERM子进程，约500ms无关闭则SIGKILL，等待/清理有界，释放监听器/timer。预先取消不得spawn；总超时包含输入等待。CLI正常完成0、确认清理的主动取消0、运行/清理失败1、usage2；无文本不得虚报解码成功。输入源生命周期归本次会话，不供多消费者复用。

迁移闭环：原地修改现有runReceive和usage；旧`--endpoint/--once/--interval-ms`参数明确拒绝（usage2，说明fldigi已冻结），不保留第二条生产分支。`packages/receive/src/fldigi.ts`原实现保持冻结；index公共出口改为当前后台能力，旧fldigi客户端测试直接导入冻结文件。旧CLI专属测试随调用者迁移到新专项，原文件/15项历史证据已保护，不能为绿色删除仍有效的客户端测试。保留依赖锁与旧证据，不顺手卸依赖/删历史。回退为恢复本轮相关副本，不能覆盖别的dirty变更或删数据。

DSH修改权：新`packages/receive/src/multimon.ts`、现有index、apps/rig-receive.ts、apps/cwrig.ts仅receive usage；新tests/multimon-receive.test.ts、tests/fldigi-receive.test.ts仅上述迁移；README接收部分、docs/evidence/V00-02-C-后台收报主链接入.md。禁止改MEMORY/ROADMAP/本任务/其他模块/发报链/package依赖/全局配置，禁止装工具、子agent、设备操作。Codex同期只维护状态文档，代码在DSH退出交回后复核。

实施前保护已完成：HEAD2fcfd33与`.local-backups/20261020-230536-receive-migration/`包含dirty补丁、全部未跟踪文件tar、目标原文、dist归档及headless非凭据profile。新目标已确认不存在。DSH在项目cwd工作，所有产物/测试临时目录必须在项目新建临时子目录或其内的mkdtemp（避免上轮每调用私有/tmp），不再往外部工具目录写入。

最小验收：一次build、新后台专项（实际Node短生命周期子进程夹具覆盖固定spawn、流式/背压/对齐与EOF、缺失/非零/提前退出/输入错、取消不晚到、总超时及输出限制，按风险合并约8-12用例）、受迁移影响的冻结客户端测试一次；不跑全仓/设备/四矩阵。真实multimon-ng已过B探针不重复研究；Codex另跑一次最终编译CLI，用已有样本经ffmpeg转换的PCM（保留原WAV），核对CQ TEST与退出，确认实际调用者已切换。记录失败修正、未测范围、R01-R13合并自查和最终证据，不能用夹具代替真实接通。

入口数量不变；后台子进程替代fldigi应用/XML-RPC依赖，不新增网络/IPC服务/持久化格式/设备持有者。明确不做GUI、AI、实时声卡、Windows发布和真实发送。预计一轮局部实现/复核；10分钟内优先可运行并提交证据，需扩大范围或新增平台即带阻塞证据返回，不自行扩张。

## 已完成切片与历史依据

## 历史已完成切片：V00-02-B 无GUI组件探针

状态：候选探针已完成，Codex限定复核通过。DSH受沙箱限制无持久产物，已停止；Codex接手用户态固定版本构建与三个探针，非独立DSH验收。首次末字缺失保留，补0.5秒尾静音后CQ TEST完整、EOF前输出及取消退出通过。报告以`docs/evidence/V00-02-B-后台解码组件探针.md`为准，原始日志已归档；不再等待外部REPORT.md。下面保留原委派范围。

下一切片只准备同一receive入口的后台引擎迁移：复用现有apps/cwrig.ts → apps/rig-receive.ts → packages/receive；薄适配管理一个multimon-ng进程并接受约定PCM，不重写解码器或建插件平台。产品代码/调用者尚未迁移；具体输入参数、取消/错误/背压和旧--endpoint退出安排需在实施前写明，不能将探针通过写成产品验收。

用户已要求继续。目标缺口是独立后台CW解码能力，复用现成multimon-ng而非自行拆改fldigi；主链位置仍为现有cwrig receive/共同receive模块，发送沿ADR-020。此切片只核实候选，尚不更换生产调用者。

最小范围：DSH仅在事前确认不存在的`/home/li0214/DSH/tools/multimon-ng-v00-02/`克隆/固定上游revision、用户态构建、保存日志和`REPORT.md`；可读取项目入口、MEMORY、ROADMAP、既有P0-004样本，不改项目任何文件、现有工具/全局配置，不sudo/安装系统软件，不读凭据、不用子agent。Codex负责审查并更新项目状态，双方修改权不重叠。

验收：真实multimon-ng以MORSE_CW解码`examples/signal/cq-test-out/clean.wav`，用已有ffmpeg做必要PCM转换，记录输入/输出、退出码、版本/hash和格式；用同一样本定向核实stdin实时输出是否在EOF前到达、取消是否退出，不重造样或跑性能/设备矩阵。默认参数若失败，只允许最多两组有源码/帮助依据的必要时序参数试验，保留失败，不反复调到绿色。Windows只核对同版源码构建/依赖边界，不冒充已运行；记录许可证，禁止凭空声明单文件许可覆盖整个程序。

入口/进程/协议/存储增量：本切片无产品增量，仅临时命令行探针，无GUI/X服务器/网络服务/RPC/设备进程。预计一个定向轮次，时间预算6分钟；遇到缺依赖、需要修改上游解码逻辑、明显不满足输出/部署要求，带证据反馈，禁止扩建或换候选。最终报告后退出并交回；不得将样本成功当空口准确率或完整V00-02验收。

保护：`.local-backups/20261020-224014-multimon-probe/`保存本轮目标原文、dirty补丁及DSH非凭据profile；探针目标目录事前不存在。该切片取代下方历史“下一步处理fldigi文件回放”。

## 以下为冻结方案与历史契约

最新纠正（用户确认）：产品只接受独立后台解码组件，用户操作本项目GUI/CLI；无独立组件则另寻方案，不以隐藏完整GUI替代。因此本任务的fldigi应用/XML-RPC实施方案冻结，停止WAV文件框调试。V00-02收报目标继续，当前先核实无GUI组件候选；现有代码/15项专项及空读取证据保留，不删不扩建，不重跑。下方为原方案历史契约，不能作为下一步执行授权。候选调查见V00-01复用报告末节，当前事实以MEMORY/ROADMAP为准。

2026-10-20。状态：DSH实现并交回修改权，Codex已复核及修正真实XML缩进兼容；build与专项15/15通过，真实fldigi4.2.10空读取通过。WAV未验收，当前任务保持进行中；下一步仅处理现有文件回放/音频输入，不重做适配或设备验证。实际环境阻塞与保护见同名evidence。下文保留原实施契约及交接边界。

## 目标、位置与复用

用户可见缺口：无法在既有CLI看到实际CW解码文本。交付 `cwrig receive --endpoint http://127.0.0.1:<port>/RPC2 [--interval-ms ...] [--timeout-ms ...] [--once]`（路径以实机确认，允许/默认规则写明）；共同下层适配器供以后GUI复用。发报仍ADR-020的CwTrialSession，本项不调用、不改动其实现。复用fldigi现成解码能力和P0-004 WAV，不造解码器、音频驱动、Fake台站、RPC服务或第三种界面。

入口增量为现有cwrig子命令，不增可执行入口；引入已有外部fldigi进程/XML-RPC依赖，不新增设备持有者、服务进程或自定义存储格式。内部RxChunk是非持久事件，序号只代表当前接收会话顺序，不证明空口准确性。

## 实施契约

- 新 `packages/receive/src/` 内一个小型fldigi接收客户端（index可选）；新 `apps/rig-receive.ts` 仅承担CLI选项、事件显示/终止，`apps/cwrig.ts` 参照monitor动态导入。GUI以后直接调用同一receive模块，不依赖CLI/stdout解析；暂不建立跨进程扇出服务。
- 固定只读XML-RPC方法：`fldigi.version`（可选握手）、`rx.get_data`。禁止公开任意方法call、TX/清空文本/设置频率/rig/PTT接口；连接仅明确回环127.0.0.1/[::1]，不解析任意域名，不允许URL凭据/query/fragment/重定向。endpoint在本机显式配置，默认不连接电台。
- XML解析复用成熟库fast-xml-parser，已核对npm当前5.11.2；使用精确版本并更新lock。不要自造XML parser；拒绝DTD/实体声明、XML fault/非法结构/非base64结果、限制响应字节数及请求总超时（含body），不得回显服务器原始错误内容。fetch不自动重试/重连，网络异常或结果不确定后结束当前流，不能默默当作无文本。UTF-8按fldigi实际输出处理，非法字节不能静默替换成貌似有效内容。
- 单个客户端最多一项在途读取，循环await完成后才下一次；多个调用者不能争读该实例。仅一个应用实例使用该fldigi端点是首切片操作限制，先不实现跨进程锁平台。每次运行给会话id/递增seq，接收时间为本机观测时间；与未来发送许可无关。
- 有界轮询与响应，空文本表示本次无新字符、不虚构解码成功。失败输出明确不可用并非零退出；SIGINT/SIGTERM停止轮询并abort在途请求，不能取消后迟到输出文本。退出时不关闭用户的fldigi，不发送main.abort等命令。
- CLI以JSONL输出运行状态和非空文本块（source=fldigi, readOnly=true, sessionId/seq/text/receivedAt等字段按实现统一）；--once只读取一次用于脚本/样本；usage错误2，运行失败1，正常停止0。严格参数边界，不引入任意shell/配置平台。

## 修改权与禁止项

DSH可修改：packages/receive/src/**、apps/rig-receive.ts、apps/cwrig.ts、tests/fldigi-receive.test.ts、package.json/lock（仅新增XML库）、README本子命令说明、docs/evidence/V00-02-fldigi收报薄适配.md。除此不改，不碰MEMORY/ROADMAP/AGENTS/本任务/发报链，不安装系统软件，不启动fldigi/电台，不用子agent。不修改既有证据或用户配置。

Codex同期只准备外部fldigi环境/离线样本与状态文档，不修改DSH拥有文件，待其退出交回后复核。启动headless非凭据profile已备份，不读凭据。

## 最小验收与证据

DSH在设计定稿与第一条链路完成时做合并自查，把要点写入同一交付证据，不再循环独立审议。只跑新增专项（约8至12个有意义用例，适当参数化）：实际XML-RPC请求/顺序、CLI连到本机脚本化HTTP服务、空文本、fault/坏XML/base64/过大body、断连/超时、取消不晚到输出、只读方法/endpoint限制。用Node真实HTTP服务/注入fetch即可，不建常驻Fake服务。无受影响设备代码不跑设备套件，不跑全仓/双平台/源码编译四矩阵。

只执行一次必要build；修改前dist/logs/node_modules已归档，可直接使用。若新增失败需修正仅复验受影响项，保持失败证据。测试/build输出在.local-backups/20261020-204508-fldigi-rx/。交付保存命令、结果、范围、自查和未验证项，最终答复后退出交回。

Codex共享DSH最终证据，不重复全套用例。另用真实fldigi+一个P0-004既有WAV验证解码文本进入同一CLI；未接电台，无射频/准确率总体结论。真实输入若受环境阻塞，如实标记适配离线通过/真实样本未完成，不能拿Fake冒充。

保护：HEAD及.local-backups/20261020-204508-fldigi-rx/，保存dirty patch、所有原未跟踪文档、目标源/状态文件副本、dist/logs/node_modules归档、headless非凭据配置副本；新文件事前确认不存在。依赖安装允许npm新增一个精确库，不顺手升级已有依赖。新增文件用apply_patch，外部生成物遵循命令原生方式。
