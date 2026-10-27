# V00-04-A GUI最小垂直切片

## 2026-10-27：现场输入首次收音（内容未验收）

用户已连接电台/端馈，并确认Windows声音输入选择USB Audio CODEC。仅授权收音，不执行串口/发送。复用现有WSL GUI、FFmpeg pulse/RDPSource、原multimon-ng及mock回复配置，无产品源码/接口/依赖/构建变更。Windows端点此前枚举存在；RDPSource是Windows默认输入转接，本次没有独立验证信号来源相关性。

实际GUI startReceive沿原runReceive，session `4adb243d-e15b-484d-a863-c4a77486ef5c`，人工模式。一次性操作脚本传入B1AA/B2BB占位呼号，仅满足现有接收参数校验，未填入界面，不代表实际身份；原模拟未启动，未调用真实模型。FFmpeg PID3009、multimon PID3010存在；停止前/proc IO显示解码器rchar约2.84MB，与采集输出相符（IO计数并非精确PCM业务统计）。GUI出现`ISE SEE E HI H5TITE ... <ERR_6> ...`等零散文本，proposal=null。没有已知清晰CW作参照，不据乱码认定正确抄收或音频源已确证。

沿原stop后，初次返回stopped=true但receiveState仍running（异步清理未完成）；随后state确认为stopped，ps确认两PID均消失。GUI留在停止结果供用户查看，无后台继续收音，无自动发送。正式旧JSONL SHA256仍d1de5f1e6894078dd9ab630f27e2cf6227bce9635acbd0e036a79fb0cc3438ac。

保护/现场材料：`.local-backups/20261027-radio-rx/`含dirty-before.patch、MEMORY-before-listen.md、evidence-before-listen.md、listening-state.json、gui-state.json及gui-rx.mjs。本轮仅更新文档，无需产品测试或构建，不重复历史monitor/预检。准备阶段使用临时dialog返回路径并恢复原函数，不计原生选中文件通过。现场音频传输/GUI文字/停止释放有限通过；CW内容准确率、端到端信号归属、真实AI与自动收发未验证。当前等待用户确认扬声器听到的是清晰CW还是底噪/数字声，再定位有效信号，不能把本次文本当作有效通联。

## 2026-10-23：CLI估算发送窗口与RX观测（限定交付）

用户同意上轮候选后，Codex沿原runCwTrial/CwTrialSession落地显式--estimated-wpm，无新入口/进程/协议/依赖/schema。GUI真实发送禁用不变，未将GUI reply-wpm当成设备键速。真实设备/音频恢复未验收，不宣告自动收发或0.0完成。

主链变化：复用既有signal/morse编码库和timeline，要求最终正文与规范文本完全一致，不支持字符直接拒绝，不静默折叠空白。估算速度6..48由操作人提供，不高于实际有效速度属于使用前提，程序不读取/设置键速。正文时间×1.25＋500ms后才开始RX观测；100ms采样，TX或超过300ms的响应空档重置600ms稳定窗。额外5秒预算也收紧最后一条查询超时。未曾起发也可能满足，estimated_rx_window及退出0仅为运行策略/命令流程，所有完成和物理停发仍UNKNOWN。参数进原intent/send_result detail，观察追加原send_result；启用时六行，默认仍原五行，未决阻断不变。

Ctrl+C、调用者取消及输入关闭取消估算等待；若取消时查询在途，先等该查询成功/原超时，再走原停止/关闭，避免重叠查询。查询故障按原failSession锁定/关闭，随后停止可能unavailable或write_failed，不能承诺停止帧写出，更不能保证物理停发。保持原故障隔离，不在该增量重写设备生命周期。正常估算窗口后仍请求一次原停止；没有重发或自动解除intent。

保护与对象：基线ad08541，开工已有上一轮四份文档dirty；`.local-backups/20261023-estimated-rx/dirty-before.patch`及source-before.tar保存相关源码/README/四文档，Harness非凭据profile亦已备份。修改源码仅apps/rig-cw-trial.ts、packages/cw-trial/src/session.ts；新增tests/cw-estimated-rx.test.ts，无用户文件覆盖。正式JSONL SHA256仍d1de5f1e6894078dd9ab630f27e2cf6227bce9635acbd0e036a79fb0cc3438ac。build产物未在本轮构建前单独归档，源码有上述可恢复基线；不将其描述为完整产物备份。

验证记录（同目录日志）：
- 首受影响测试tests.log 50/50（原runner45＋新增5），build.log通过。收紧观察查询预算/输入关闭取消后，tests-final.log为52/53：唯一失败是新增silent用例错误要求故障关闭后仍写出停止帧；修正为silent仅正文一帧、失败保留未决。没有改产品故障机制。
- 仅重跑新增专项estimate-final.log为7/8：同一silent用例又过度限定stop outcome必须unavailable，实际关闭竞态也可能write_failed，二者均符合原会话语义；修正断言接受这两种失败，silent-final.log定向1/1通过。保留两次失败，不称全程一次全绿。
- 后补“取消发生于RX查询在途”测试，query-cancel.log定向1/1，确认查询结算后才写一次停止。最终覆盖原45项及新增9项；原45项沿tests-final通过结果复用，不重复全套。覆盖估算/文本/参数、早期RX等待、TX重置、永TX/无应答、NG、等待中取消及输入关闭、在途取消、六事件/未决保留。
- 产品最终源码build-final.log通过；之后仅改测试/文档，typecheck-final.log核对新增测试类型；diff --check通过。不跑无变化GUI构建/窗口、历史收音/模型/设备预检。

DSH只读交叉审议60秒exit124，无最终报告，不计独立通过；推理过程中对在途取消可能导致pending阻止停止的疑问，Codex核对实际await查询后才抛取消，并新增定向用例通过，未据假设重构。无第二次审议。Codex已复核相对source-before的预期差异、调用接入、故障分支、记录不解除与文档限制。

阶段检查：设计六项先写原任务；第一条原runner链50/50后检查取消/预算边界；发现silent预期错误保留失败并只定向修正；交付核对diff/正式hash/当前记忆。R01/R02/R04/R05/R06/R07/R09/R11/R12/R13在限定CLI/内存范围通过，R03原schema无变化、R08无新增权限接口；R10定向证据以上，硬件/实测速率/真实GUI未验证，独立DSH审议未完成。结论仅为CLI估算策略限定交付，无新候选发送路径或额外实施任务。

下方为本次策略前的调查，限制沿用，“候选待批准”已由用户同意及本段实施替代。

## 2026-10-23：真实CW结束判定补充调查

本轮对象：原runCwTrial/CwTrialSession及新增外部资料。Codex调查与复核；复用[P2-008](P2-008-说明书发送证据调查.md)，不重查同一手册。产品代码未改，无设备操作。

- Hamlib固定提交`2b5608a0a038dee3049206f40b1e4d30c6023680`：[IC-7300 caps](https://github.com/Hamlib/Hamlib/blob/2b5608a0a038dee3049206f40b1e4d30c6023680/rigs/icom/ic7300.c)使用icom_send_morse/icom_stop_morse/rig_wait_morse。[通用等待](https://github.com/Hamlib/Hamlib/blob/2b5608a0a038dee3049206f40b1e4d30c6023680/src/rig.c#L7660)先等200ms，再每轮查PTT并等50ms，首次OFF或loops超过600退出且返回OK；不是操作关联的CW队列清空证明。Full break-in间隙问题沿用P2-008，不将此结论泛化为Hamlib所有设备/版本无用。
- [Icom固件1.42](https://www.icomjapan.com/support/firmware_driver/4102/)（2024-05-15）及[官方补充资料](https://www.icomjapan.com/support/manual/2188/)：1.42新增16 66 TX Inhibit及IC-PW2联动，未提供CW完成/停止凭据；补充文件含1.40/1.41等历史变更，已核对相关CI-V章节。IC-7300MK2不是本机型，不混用资料。直接PDF地址403，官方页面所列download API成功取回并pdftotext。
- 原`packages/cw-trial/src/session.ts`的sendMessage/sendStop只有ack_observed；`apps/rig-cw-trial.ts`应答后模拟立即调用停止，真实分支等待TTY停止/退出。直接把GUI模拟参数换为真实可能截断电文，不能算接通自动发送。

结论：本调查范围内不足以实现可靠整条发送完成判定，保持UNKNOWN和真实GUI禁用，不增加无真实实现的观察模块。最小候选是按最终正文/已知速度估算保守窗口再结合持续RX观测，须明确仅属运行策略、不能证明射频停发或自动解除intent；需与用户讨论后才实施。没有重开设备选型或增加另一发送链。

保护：Git基线ad08541（修改前干净）；`.local-backups/20261023-tx-completion/docs-before.tar`包含修改前四份文档。下载文件在同目录，master初次下载与固定提交逐文件cmp一致。SHA256：ic7300.c=`a41d62a6112c28ace5e2d2235d282c49ebf5680b461a956f339d42e198b1a4f2`；icom.c=`fe27e196744a0b6bb8f3224470c8c273b25e545fbae3fff1cba9bee62726f29f`；rig.c=`5c85072fb8cbecb34622f719dd63d8fd2bbb4dd123c2360b1e4187576a1f5f92`；官方PDF=`4fcca913fe483593fe556164781d000e10a6393d21057f0f40cf7e91f6defc03`。

DSH只读交叉审议exit0（45秒上限内完成，dsh-review.log），核对三个指定文件，认可限定结论；补充首次OFF也可能从未起发，且固件增量资料只能说明没有新增证据，不能推出全表不存在完成指示。Codex采纳上述边界，不扩大结论。Harness非凭据profile已先备份，无凭据读取。

检查点：开工复用既有记忆/证据；发现缺少硬件完成依据后停止产品扩建；交付核对文档diff及外部源码，diff --check通过，正式JSONL SHA256仍为d1de5f1e6894078dd9ab630f27e2cf6227bce9635acbd0e036a79fb0cc3438ac，不跑构建/测试。R01/R02/R06/R11/R12/R13在本调查范围满足；R03/R04/R05/R07/R08/R09无产品变化、不适用；R10仅资料核对，设备行为仍未验证。真实自动回收及0.0不通过，文档调查收口。

## 2026-10-23：实时收报一轮模拟后恢复（限定交付）

作者/复核Codex，DSH只读交叉审议。对象为`.local-backups/20261023-live-roundtrip/source-before.tar`到当前原receive、GUI和新专项；备份另含dirty、dist、非凭据profile，新增tests/live-roundtrip.test.ts及脚本此前不存在。没有变更正式JSONL或原runner代码。本段替代下方“实时模式禁止所有模拟”，其余旧证据仍有效。

原startReceive→runReceive→runAudioReceive/multimon/continuous ReplySession不变；增加进程内pause/resume。在同一音频分支等待runAudio的aborted且cleanupConfirmed后才确认暂停，随后原GuiSimulation先复核binding再调用原runCwTrial；人工原完整正文确认、自动原lease/末端校验/消费。ReplySession保留而采集/解码进程停止，恢复沿原函数创建新子进程；总实际经过时间预算不重置，暂停等待也受stop/期限限制。pause失败不启动runner且不resume；stop后不恢复。原onEvent发布完整validated回复后可触发同一自动桥，simulation.task单任务串行。新电文/编辑使旧绑定失效，失败不重试。

检查点：启动核对当前MEMORY/任务/ADR/源码及基线；设计审议DSH exit0，采纳清理、单所有者、预算意见，其新锁/回复先落账/跨进程推测与真实同进程及原runner检查不符，Codex不采纳；首链专项通过后检查原runner和音频cleanup交接；实窗用隔离fixture不修改现场数据；交付核对diff/正式hash/进程/记忆。未扩展设备、真实发送、账本解除或连续发送机制。

验证：`node --import tsx --test tests/live-roundtrip.test.ts tests/gui-receive-setup.test.ts tests/gui-slice.test.ts tests/gui-simulation.test.ts tests/audio-receive.test.ts`43/43。后补3个核心暂停失败/停止/超时用例及最终“pause未成功不resume”防护，仅重跑live-roundtrip 10/10。初build暴露新测试chunk缺source/readOnly及闭包变量TS窄化，已修正；最终build、gui:typecheck、gui:build通过。不重跑旧设备/模型/全仓专项。

实际隔离窗口check.mjs：原dialog临时返回FFmpeg/解码器/mock路径，pulse/RDPSink.monitor真实接收已有clean.wav，得到CQ TEST/有效提案。手改B1AA DE B2BB TNX K，点击模拟，原捕获的采集/解码PID已消失才进入confirming且audioPaused:true；输入完整正文确认后原runner exit0，原五行JSONL含确切编辑文本/原reply身份，恢复到running/非paused及新PID。再播放得到turn-2，草稿不变。confirming.jpg/resumed.jpg已逐张视觉核对。

首次脚本最后直接读DOM时早于250ms轮询，sendDisabled仍true而exit1；failure.json记录核心已经turn-2/idle/running，前面的原runner、记录、PID及恢复断言已通过。保留失败，不称全程exit0。只补`check.mjs --tail-only`，同一fixture/账本保持原五行，无第二次模拟；实际收到提案/编辑后等待DOM按钮启用，再点击停止，记录的采集/解码PID均退出，tail-result.json及tail-stopped.jpg对应exit0。最后小改仅把resume限制为pause成功，10专项覆盖，不重做成功的实窗发送。测试实例已退出，普通GUI最新编译重开并恢复用户现场。

DSH代码交叉审议75秒exit124，已阅读/分析但未最终报告，不计独立通过，无第三次审议；日志dsh-code.log保留。Codex相对source-before核对实现及原runner末端检查，实窗/专项证据以上。正式账本SHA256保持d1de5f1e6894078dd9ab630f27e2cf6227bce9635acbd0e036a79fb0cc3438ac。自动分支本轮只有专项及代码证据，实窗验证人工分支；真实模型/电台/Windows/物理侧音隔离和真实发送完成未知。一轮模拟后的新发送仍被原未决规则阻断；不清理、换正式目录或虚称连续自动通联。暂停期间是收不到音频的半双工隔离，不声称无漏收。

审议标准：R01/R02/R04/R05/R06/R07/R09/R11/R12/R13在本次模拟范围由授权、同链绑定、失败/清理专项、备份及实窗证据支持；R03无持久化变更，R08既有受限IPC无新权限；R10专项及人工实窗有证据，独立代码审议、自动实窗和设备范围未验证。结论：Codex限定交付一轮模拟恢复收听，不宣告整体04-A/0.0或独立审议通过。

## 2026-10-23：GUI实时收听限定验收

用户同意“直接听”走实时输入。本轮只把现有音频主链接入原GUI：startReceive→buildGuiReceiveArgs/原parseReceiveArgs→runReceive→既有FFmpeg/multimon/continuous ReplySession→原adapter。新增输入模式、后端、明确设备名和FFmpeg选择，PCM默认兼容；无新IPC、服务、依赖、设备协议、存储格式或发送循环。实时模式UI、simulationBinding、setMode及automatic bridge均禁止派发；停止沿同一AbortSignal，不作为发报许可。

保护`.local-backups/20261023-001943-gui-audio/`：修改前GUI/文档副本、dirty补丁、dist归档、DSH非凭据profile及新增脚本/结果。目标为GUI、薄参数适配、受影响专项及原任务/记忆/证据。相对gui-before的diff仅含预期修改；没有接触正式旧intent。

定向`node --import tsx --test tests/gui-receive-setup.test.ts tests/gui-slice.test.ts tests/gui-simulation.test.ts`20/20，build、gui:typecheck、gui:build通过。覆盖PCM兼容、同一parser的pulse/dshow参数、缺失/额外/混用参数拒绝、实时建议更新/编辑态保留及完成后仍禁止模拟；原GUI人工/自动一次模拟专项沿用此次受影响回归，无重跑旧音频/模型/设备专项。

真实Electron测试（check.mjs/result.json）：仅测试进程临时替代dialog返回三个既有文件路径，然后点击真实GUI按钮；不代表原生选择通过。选择pulse/RDPSink.monitor，原FFmpeg采集/真实multimon解码；两次播放examples/signal/cq-test-out/clean.wav，均使用3秒静音尾防止播放截断，得到CQ TEST CQ TEST和两个不同turn的mock建议。首个建议后仍running，编辑MANUAL DRAFT KEEP后第二轮和轮询均不覆盖，automatic/manual发送按钮禁用。点击停止，记录的真实FFmpeg与multimon PID均退出，simulation仍idle、mode人工。测试进程退出，无麦克风、电台、付费AI或真实发送。

截图listening.jpg已核对，发现设置栏增高将操作栏挤出首屏，追加纯CSS底部固定操作栏及页面尾部留白。只重建并验受影响布局，不重复音频：layout.mjs/layout.json及layout-980.jpg/layout-760.jpg为980×733中文、760×560英文，无横溢出，停止按钮在视口内，单张JPEG核对。此前音频截图未包含最终CSS，明确区分。普通GUI从正式目录重新打开最新构建，runtime.mjs restore已确认用户原草稿/呼号恢复，未启动采集。

DSH只读审议已读指定六文件，继续扩查核心导致60秒exit124；仅整理既有日志的30秒调用仍exit124，无最终结论，不计独立审议通过。过程未发现有确定证据的派发绕过，Codex另以实际diff、20项及实窗复核；日志保留，不以推理片段代替报告。profile与备份cmp相等。

限制：显式设备名，无枚举；沿用一小时采集预算和12轮连续回复上限；Windows dshow/物理输入/真实模型GUI未验，实时轮次到发送未接。正式账本SHA256保持d1de5f1e6894078dd9ab630f27e2cf6227bce9635acbd0e036a79fb0cc3438ac，旧intent继续阻断。整体04-A/0.0未完成。下方“GUI实时输入未实现”属于历史阶段，不重排为待办。

## 2026-10-23：GUI会话自动模拟限定验收

沿原setMode/ReplyDispatchControl增加当前已启动会话checkbox；默认人工，新收报重置人工。main只在receive任务exit0收尾后调用startAutomaticIfReady，后者还要求completed/当前提案/未编辑/自动模式/idle/非停止；收报完成后显式开启也可触发一次。该薄适配复用原runner lease及预检/重读/intent/停止/关闭；不传桌面人工确认回调、不伪造TTY。原runner非TTY只在模拟reply绑定且原控制器成功签发lease后走自动分支，真实模式TTY要求不变。手改禁止开启自动，编辑/切人工/stop撤销原绑定；同提案失败后也不自动重试，限制沿用。

`node --import tsx --test tests/gui-simulation.test.ts tests/gui-slice.test.ts tests/cw-trial.test.ts`61/61；build、gui:typecheck/build通过。实际独立fixture cwd、Electron CDP9227/main9231运行同一编译程序；原multimon解CQ TEST，mock提案B1AA DE B2BB K，页面默认manual、完成后点击自动checkbox，无人工确认框、原runner exit0、日志consumed once、原五事件及精确正文、无横溢出；completed.jpg单张核对。开始/收报中自动启用后EOF触发由同一main路径和专项条件核对，未另外做窗口第二遍；当前实窗覆盖完成后开启路径，不宣称连续自动通联。

DSH日志dsh-review.log exit0：仅行级搜索，报告称binding可能有授权副作用、startAutomaticIfReady忙碌抛错、模拟无停止、两IPC为本轮新增。Codex核对实际binding纯投影、startAutomaticIfReady忙碌/非idle直接返回、同一AbortSignal连原runner/关窗adapter.stop，以及IPC相对备份零变化，以上不成立。关于TTY两阶段：前段模式仅准入，authorize失败直接返回3，后段实际lease检查，真实模式仍先拒绝reply绑定并强制TTY；编辑generation由原control推进。报告提到永久挂起关闭无全局超时是已知未覆盖，不在本轮扩建。该审议不是独立通过，保留原报告及核对说明。

保护/证据`.local-backups/20261023-000131-gui-auto/`。新测试实例正常退出，临时dialog替代销毁；原生文件选中仍未验，只有测试进程dialog返回替代。正式账本SHA256仍d1de5f1e6894078dd9ab630f27e2cf6227bce9635acbd0e036a79fb0cc3438ac，未解除/发射/付费调用。原正常窗口用户草稿保存后重启最新程序并恢复。零新IPC/依赖/服务/记录格式/发送器，未扩恢复机制。

## 2026-10-22 23:54：GUI人工确认模拟闭环窗口验收完成

用户明确同意只补现有GUI编辑→确认→模拟→结果，隔离测试数据且保留正式账本。未改产品源码；从独立fixture cwd启动同一dist/apps/gui/main.js，原runner相对logs/cw-trial只写fixture。此隔离验收并非正式记录解除/换目录恢复产品操作。真实multimon解原PCM，mock生成提案，页面点击编辑并输入B1AA DE B2BB TNX K，点击模拟后进入原预检/确认阶段；空白及WRONG输入时确认按钮禁用，完整Input.insertText输入最终正文后点击确认，原runner exit0，原intent/send_result/stop_intent/stop_result/session_close五事件正确，原intent.detail含手改正文。页面显示完成、草稿不丢、无横向溢出；confirmation.jpg与completed.jpg为980x733小JPEG，逐张核对通过。

一次性脚本/实际状态/记录在`.local-backups/20261022-235144-gui-success/`；同目录有文档修改前副本/dirty。原生选择文件仍通过测试进程临时dialog返回值替代，实际按钮/主进程文件处理仍原代码，不记为原生选择成功。测试进程正常退出，替代销毁；普通GUI从正式项目目录重开。正式账本SHA256保持d1de5f1e6894078dd9ab630f27e2cf6227bce9635acbd0e036a79fb0cc3438ac，无电台/发射/付费模型。未改代码所以不重跑build/55项等历史测试。下方确认区/成功结果待验为历史限制，已由本次隔离窗口结果替代；正式旧intent阻断及真实发送/自动模式/实时现场边界仍保留。

## 2026-10-22：显式人工核查限定实现（用户同意后）

原runCwTrial路由增加--review-intent/--operator/--note，仅TTY且禁止混合发送/reply回调；展示旧intent及内容摘要、操作人/依据，要求完整输入REVIEW ID DIGEST。原CwTrialRecordStore增加v2 intent_review结构化事件；v1原事件/行不变，旧结果UNKNOWN，逐条解除后续阻断，新intent继续阻断。新旧事件同一JSONL，无服务/设备协议/第二账本/发送器。旧版源码parseRecord只接受v1，scan遇v2置corrupted，hasUnresolvedIntent继续true；旧程序不遵守新锁，不允许新旧并行。

原runner与核查同目录全程mkdir独占锁；realpath消除目录别名，lstat拒绝symlink/hardlink账本，无自动stale回收。核查写前重读摘要、再检查取消，写后fsync；若写入结果不确定，保留目录锁且非零报告UNKNOWN，不保证磁盘永久挂起有界。缺失/重复/错引用/错摘要/损坏/未知版本均阻断；普通旧操作不能自动消除intent。

修改前保护`.local-backups/20261022-211024-intent-review/`：源码、文档、dirty、dist及DSH非凭据profile。定向runner+GUI模拟+核查65/65；随后补同目录核查→新模拟→新intent再次阻断及DSH修正后核查专项18/18，build通过。跨进程竞争、目录别名/硬链接、取消等待/最终重读、目标变化、写失败/写全后报错、原行不变、逐条处理均有fixture证据。测试仅用独立临时fixture，不拿换正式记录目录冒充现场解除。

DSH交叉审议exit0，日志dsh-review.log；指出锁占用诊断/人工恢复说明不足、写入后刷盘失败的结果表述不清，Codex补提示、README规程及不确定写入保锁专项。未知版本/额外字段整个目录阻断属预期兼容策略，未放宽。Codex复核实际锁在原runner获取并清理、记录同源及旧源码fail closed。无GUI改动，无设备/付费AI，不重复图形/解码验收；Windows文件系统/串口、进程被强杀后人工恢复尚未实测。

现场原JSONL SHA256仍为d1de5f1e6894078dd9ab630f27e2cf6227bce9635acbd0e036a79fb0cc3438ac；没有核查/解除/发送记录写入。功能批准不代替现场人工核查，下一项待真实核查事实及TTY确认后补正式GUI成功路径。旧ADR“永久阻断”当前语义由本次用户明确批准的追加核查替代，其余单主轴及unknown证据限制仍有效。

## 2026-10-22：历史intent阻塞原因核对（只读）

原store.hasUnresolvedIntent为corrupted或任意intent即true，没有核查解除，任何一次成功模拟也留下永久阻断。现场JSONL结构化读取共6条/1个intent：54120b05-88e4-4a83-9cc9-5c7a5e54ac52，session d276dcb1-04f8-4f05-be83-fecd57247b80，2026-10-14T15:20:55.098Z，E。同行会话完整五事件，FB应答和closeConfirmed=true与P2-015吻合，不证明完成/物理停发。原文件SHA256 d1de5f1e6894078dd9ab630f27e2cf6227bce9635acbd0e036a79fb0cc3438ac，本轮未改。

已比较现有Fake核查能力，其SQLite/daemon与当前JSONL不同，冻结保留，不迁入；原store只串行同实例写入，人工核查新增时必须解决与runner的最小跨进程独占，不能无条件追加clear。最小方案写入现有04-A任务顶部，记录版本及恢复语义变更待用户批准；只读分析不是方案实施/现场解除或独立审议通过。文档保护`.local-backups/20261022-205032-intent-review-design/`，无业务源码变化，不重复测试或设备预检。

## 2026-10-22：GUI模拟发送接入与未决阻断

沿原runner增加仅模拟replyProposal可用的桌面完整正文确认回调；GUI薄适配绑定session/turn/revision、原提案对象及控制generation，同提案只允许一次尝试。start/confirm两IPC，零新服务/依赖/设备协议/记录schema。真实TTY分支不放宽，关窗与stop沿原AbortSignal等待收尾。

`node --import tsx --test tests/cw-trial.test.ts tests/gui-slice.test.ts tests/gui-simulation.test.ts`最终55/55；首次50/55发现预检后TTY检查遗漏，修正后通过。覆盖原链16查询、完整正文一次发送与stop、五类记录、错误/空确认、真实/缺绑定/自动拒绝、确认等待取消、intent后失效、旧token与重复确认、同提案重复及同目录未决阻断。npm build、gui:typecheck、gui:build和diff check通过。

实际新Electron窗口沿原收报链产生mock提案并手改，点击模拟后显示exit3/历史未决intent，草稿保持，无横溢出；runtime-blocked.json/jpg留证，JPEG已单张核对。logs/cw-trial与备份cmp相同，无记录变更。真实文件返回仍用仅测试进程dialog替代，不代表原生选择通过。当前目录在确认前阻断，因此实际窗口确认区/成功回显待验，不能以专项通过替代。无设备、真实发射或付费AI。

保护与脚本`.local-backups/20261022-203724-gui-simulation/`。DSH设计60秒、代码审议90秒exit124，过程涉及TTY/失效/重复/共享记录限制但无最终报告，不计审议通过。Codex复核相对基线差异，无第二发送链；当前应核对历史未决记录，禁止换目录绕过。测试进程退出，普通GUI恢复用户草稿，见restored.json。以下“GUI发送未实现”仅为此前历史状态，真实发送仍未实现。

## 2026-10-22：原生对话框取消与人工草稿保护

源码检查发现App.run原先对所有editing:true的返回都setDraft(proposal正文)，所以手改文本在选择/取消文件后会丢失。最小修正为仅显式beginEdit初始化draft，原文件动作/停止不重填；不加状态源、IPC、依赖或业务链。

修改前保护`.local-backups/20261022-202644-native-chooser/`含App.tsx/现有文档/dirty及renderer-before.tar。GUI typecheck/build exit0；draft-check.mjs通过真实Electron页面与原生Open File，输入MANUAL DRAFT KEEP、打开选择器、XTest Escape取消、等待原IPC返回，草稿保持完全相等，最后恢复user-before.json的用户原空白草稿；draft-result.json留证。无产品界面布局改动，故复用此前视觉证据，不重跑设备/解码专项。

原生路径选中仍未成功：DOM复制剪贴板返回false；系统GTK剪贴板/XTest粘贴未填入地址框；系统AT-SPI仅返回空desktop树。上述是自动化工具限制证据，未证明用户手动选择失效，未替换产品对话框。取消已完成，窗口无模态残留；不把该结果算作原生选择成功。

最终现场收尾补充：追加一次粘贴排查后原生框再次滞留，Escape未退出；已终止该空闲测试Electron PID8215，未运行收报，无设备。重启普通Electron并恢复用户空白编辑态，CDP核实draft为空、busy:false，X树仅CW Station，无Open File。首次重启后立即连接CDP曾ECONNREFUSED，等待窗口就绪后确认成功，不把启动命令本身视为窗口已可用。

已核查原runner，replyProposal要求TTY完整正文确认。GUI发送需后续在原runner增加明确桌面确认适配，不能伪造TTY或复用自动代答来绕过；本轮没有接入发送，范围保持草稿保护修复。Codex复核最终两处调用差异及实际回调保留结果，通过该局部修正；完整04-A仍未验收。

## 2026-10-22：实际GUI收报、编辑与停止限定验收

保护目录`.local-backups/20261022-195537-gui-runtime/`：修改前MEMORY/任务卡/本证据/dirty补丁、用户原草稿与呼号/语言现场`user-state.json`；新增一次性check.mjs/native-input.py/main-inspect.mjs，不是产品入口。产品源码未改，不重复构建/后台专项。

1. 原生文件选择：真实按钮打开Open File，X11窗口与单张JPEG确认；自动键盘操作未取得文件返回，第一次脚本超时exit1。后续继续排查仍未成功，保留原生选择待验，未将此失败宣称通过。
2. 后半段隔离验收：退出卡在原生对话框的无收报实例，启用Electron本地主进程调试；仅在测试进程中临时替代dialog.showOpenDialog返回既有路径，逐次点击真实页面的选择文件按钮，文件处理仍走原主进程代码，每次结束恢复dialog。没有修改磁盘产品源码或注入UI假电文。该测试边界不覆盖原生选择器。
3. `node .../check.mjs receive` exit0：既有真实multimon解码原cq-test.s16le得到`CQ TEST `；原runReceive/ReplySession用已有mock配置生成`B1AA DE B2BB K`，不是付费/真实AI调用。页面点击编辑，草稿与建议精确一致；Input.insertText改为`B1AA DE B2BB TNX K`，等待1秒未变化，手动模式且无横溢出；自然EOF后无解码残留。结果receive-result.json/edit-result.json与receive-edit.jpg，截图逐张核对，小于1280px/0.5MB。此样本不覆盖收报中新上下文对草稿的影响。
4. `node .../check.mjs stop` exit0：新增stop-input.s16le为原PCM前缀和512MiB稀疏静音尾，只为捕获活跃解码器取消，原样本未改。先捕获真实multimon PID8131，再点击页面停止；确认进程消失、stopped:true/receiveState:stopped。stop-result.json的displayed在首个轮询前仍为正在收报，后续单独CDP复核标签已停止、底部会话ID、stopDisabled:true，非最终状态冲突。未进行射频操作，进程退出不推广为电台停发证明。
5. 收尾：测试实例退出exit0，dialog替代随进程销毁；重新启动无main inspector的普通GUI，仅保留本地renderer调试端口9226，恢复用户原空白草稿并验证相等，restored-result.json留证；无Open File模态框、无multimon残留。

结论：收报显示、mock建议、建议初始化编辑、EOF/主动Stop子进程清理已有实际窗口证据；原生文件选择、编辑中接收新上下文、真实模型GUI及发送未覆盖。整项04-A未通过，不新增发送功能、不重开视觉路线。原“有提案编辑/PCM/Stop均未验”描述由上述限定范围替代，其余限制仍有效。Codex自查：保护与范围、唯一主链/真实运行、清理及文档限制已核对；无新增产品链路或状态源，不将mock/dialog替代当作真实模型/native选择证据。

## 2026-10-22：人工干预入口修正

### 追加修正：空白人工草稿可编辑

用户反馈无法直接编辑；实际Electron状态为idle、proposal:null、editing:false，按钮禁用且无textarea。只修改App.tsx两处条件：空提案也允许原`beginEdit`，编辑态无需依赖proposal存在。仍受busy/stopped禁用约束；有建议时沿原run函数初始化正文。没有新增状态源、IPC、协议、依赖、存储或发送行为。

GUI typecheck/build exit0。真实Electron 9226加载新构建后，CDP点击页面按钮，经原preload/IPC成功进入编辑；确认textarea自动聚焦，Input.insertText输入CQ TEST成功，mode:manual、editing:true、无横向溢出。通过Backspace清空测试文本，窗口保留可输入空白框。editor.jpg（980x733，小于0.5MB）已视觉核对。本轮是两处renderer条件修正，不重复后台专项；有建议初始化/提交/发送、PCM/Stop清理仍不在该通过范围。基线`.local-backups/20261022-194822-gui-blank-draft/`含修改前源码/文档/dirty补丁及renderer产物归档。下方空提案禁用是被此修正替代的历史行为。

Codex沿既有renderer把编辑按钮从底部移至回复建议面板，现有草稿框原位替换建议正文并自动聚焦；原`beginEdit`/`stop`及业务控制不变。未新增提交/发送功能。760px检查发现呼号输入框和开始按钮底边不齐，追加`align-items:end`局部修正，最终测得三者底边均为389px。

GUI typecheck/build、GUI专项6/6通过；最终CSS修正后仅重做受影响build/窄窗几何检查。实际Electron独立端口9226已启动，X窗口树确认CW Station可见且无Open File模态框；CDP确认新编辑按钮在回复面板、空提案禁用、preload API存在、980px及760px无横溢出，中英文切换正常。桌面和窄窗JPEG逐张核对，均小于1280px和0.5MB，保存在`.local-backups/20261022-193940-gui-intervention/`。此前无Playwright包不构成Electron截图阻塞，本轮复用原CDP路径补齐。

保护同目录含目标原文件、dirty补丁、dist-before.tar及DSH非凭据profile副本。真实模型、文件选择完成、PCM和Stop后子进程清理、有提案时编辑点击/输入均未在本轮验证；不得将空会话截图推广为这些验收通过。GUI人工草稿提交/发送仍未实现。

DSH只读交叉审议90秒超时exit124，没有最终报告，不计审议通过；过程日志为同目录`dsh-review.log`。Codex已核对最终源码差异、边界专项、窗口和截图，仅确认入口展示改动，无新增业务链；编辑运行态与完整04-A保持待验。DSH过程中提到编辑时新提案可能覆盖原建议展示的疑虑，未完成定性，留待原运行态验收核查，不据此扩建新状态机制。

日期：2026-10-21。范围是Electron主进程、受限preload、React/Vite渲染页和纯UI适配器；不是完整GUI产品、真实收报接线或0.0验收。随后完成一次 Apple Human Interface Guidelines 取向的 renderer 视觉重构，只改布局和样式，未新增依赖。

### 2026-10-22：材质与动效复盘修正

用户反馈上一轮玻璃动效仍显低级。对照 Apple HIG Materials/Motion 和 Microsoft Mica 后确认：玻璃铺满内容层、伪频谱/扫描线、全局鼠标视差都没有对应产品信息，造成 HUD 化与视觉噪声。沿现有 renderer 主链移除这些装饰；顶部导航和操作层保留克制半透明材质，收报/提案改用稳定标准内容表面，状态只由真实标签和短反馈表达。未新增依赖、IPC、进程、状态真源或业务行为。

验证：`npm run build`、`npm run gui:typecheck`、`npm run gui:build`、GUI 专项 6/6、`git diff --check` 通过。独立 Electron 调试端口 9223 截图 `/tmp/cwstation-visual-review-current.jpg`（1280x900，72 KB）已核对桌面布局与窄视图前的可读性。文件选择、PCM 实际收报、Stop 后解码器清理、实时电台/天线仍未验收。

### 2026-10-22：Zapier 风格参考收敛

用户指定参考 VibeUI Zapier 条目（`https://vibeui.top/style.html?slug=zapier&lang=zh`）。读取其预览与样式后吸收暖白 `#fffefb`、近黑 `#201515`、橙色 `#ff4f00` 单一行动色、Inter、细边框和 4–8px 圆角；没有复制营销页面 Hero，仅转译为本工作台的设置、状态、收报和提案分区。沿同一 renderer 主链修改 `styles.css`，不改变 IPC、状态或业务行为。

验证：`npm run build`、`npm run gui:typecheck`、`npm run gui:build`、GUI 专项 6/6、`git diff --check`通过；独立 Electron 9224 截图 `/tmp/cwstation-zapier-reference.jpg`（1280x900，72 KB）已核对。文件选择、PCM 运行、Stop 后解码器清理及电台/天线仍未验收。

## 主链与边界

（历史状态，2026-10-22已被下方PCM接线增量替代。）当时桌面主进程创建`GuiStateAdapter`，适配器注入既有`ReplyDispatchControl`；文本和提案来自演示种子，真实receive/AI尚未接入。

停止调用既有控制对象的AbortSignal并保持终止；编辑先撤销授权并切换人工；自动模式授权状态直接从控制对象读取，不建立第二状态真源。IPC未知频道、额外参数和非法模式均拒绝。页面显示人工/自动、armed/not-armed、generation、收报、提案和编辑草稿状态。

本轮新增桌面入口和Electron内部IPC，但没有新增网络服务、设备协议、记录格式、发送循环或持久化状态。CLI入口继续不变。

## 验证

- `npm run build`：exit 0。
- `npm run gui:typecheck`：exit 0。
- `npm run gui:build`：exit 0，生成`dist/gui/renderer/index.html`及单一CSS/JS资源。
- `node --import tsx --test tests/gui-slice.test.ts`：4/4通过；覆盖适配器与唯一授权对象、编辑/停止终止语义、封闭IPC频道、冻结preload API、渲染层无设备/解码导入。
- 视觉重构后重复运行同一 GUI 边界测试：4/4通过；`git diff --check`通过。页面改为浅色中性材质、细分隔线、侧边状态摘要、收报/提案双栏和紧凑操作栏，未改变五个IPC动作或状态真源。
- `timeout 8s env ELECTRON_DISABLE_SANDBOX=1 npm run gui -- --no-sandbox`：进程持续运行至超时exit124，日志无启动错误；当前WSL会话未提供可复用截图/视觉点击证据，因此只记启动检查，不记视觉验收。

保护基线：`.local-backups/20261021-220000-gui-slice/source-before.tar`、`worktree-before.patch`、`dsh-profile-before.yml`。本轮日志、构建产物和测试输出同目录。DSH在依赖/适配器初始阶段因余额不足退出，未形成独立交付；Codex接回并完成主进程、渲染页、配置、测试和文档收口。

## 首切片当时未交付（后续状态见下方增量）

真实receive/ReplySession/AI提案进入GUI、真实模拟runner按钮、实时音频、真实设备、安装包、Windows/Linux视觉和跨平台验收仍未完成。下一增量继续沿这条主链接入真实会话，不另建GUI状态库或发送器。

## 2026-10-22：本地PCM收报与AI提案显示接线

沿用原`runReceive`，新增可选`onEvent`结构化事件回调；默认CLI `print` 路径及JSONL对象不变。Electron主进程在进程内调用同一个`runReceive`，由本机文件选择器选择PCM、multimon-ng可执行文件及assistant配置；文件路径留在主进程，renderer仅传文件角色/双方呼号并显示所选文件名。renderer轮询现有显示状态，停止复用`ReplyDispatchControl.signal`传入的外部取消路径。没有新增解码器、AI会话、CLI子进程、shell命令、网络服务或存储格式。GUI初始状态改为空会话，不再使用演示文本；仅显示经过校验的`reply`提案，`no_reply`及失效事件不会留下可见旧提案。

验证结果：初始实现阶段`npm run build`、`npm run gui:typecheck`、`npm run gui:build`均exit 0；GUI 5/5、receive/reply 45/45通过（两组共50项）。Electron仅做启动烟测，未做文件选择/点击验收；下方增量收敛了源代码缺陷，但仍未完成Electron内实际PCM操作及Stop后子进程清理验收。没有真实电台/天线/发射验收。

修改前保护：`.local-backups/20261022-gui-real-receive/`保存本轮目标源码与文档副本及初始dirty patch。原工作区存在大量用户既有未提交改动，本轮仅变更`apps/rig-receive.ts`、`apps/gui/`、`tests/gui-slice.test.ts`、`tests/receive-reply.test.ts`及本证据/任务/路线/记忆入口；未覆盖其他改动。

### 2026-10-22：主链状态审查与退出收尾

移除了通用IPC中仅改显示状态的文件选择/接收占位处理，实际操作只由主进程文件对话框和单一`runReceive`调用处理。事件投影绑定当前sessionId；接收新块、`no_reply`、invalidated和接收错误会清除旧提案并撤销现存lease，终态/旧session的迟到事件不再改变显示。停止及窗口关闭均沿既有AbortSignal；关闭窗口会等待receive promise收尾后再关闭。GUI不展示无发送器支撑的自动派发入口，reply配置及双方呼号成为开始条件。

验证：`npm run build`、`npm run gui:typecheck`、`npm run gui:build`均通过；GUI 6/6、receive/reply 45/45（合计51/51）通过；`git diff --check`通过。Electron经CDP启动并读取真实页面DOM，确认标题和接收页面加载且无自动发送按钮。未操作native文件选择器，未在Electron内跑PCM，也未观察Stop后decoder实际回收，因此这些运行时验收保持待完成。

本轮保护：原目标文件副本及初始dirty patch见`.local-backups/20261022-gui-real-receive/`；补充目标`apps/gui/renderer/styles.css`与`tests/receive-reply.test.ts`在编辑前复制到`.local-backups/20261022-gui-receive-closeout/`。工作区原有的其他改动未覆盖。

### 2026-10-22：多语言与视觉重构

按用户新要求完成窄范围renderer增量：`apps/gui/renderer/locale.ts`提供`zh-CN`与`en`词典，默认读取系统语言，顶部选择器允许手动切换并以`cwstation.ui.locale`保存偏好。`App.tsx`将界面主次重排为会话设置、状态、收报、回复建议和编辑/停止；`styles.css`采用浅色中性材质、明确编号、紧凑表单与更高信息层级。没有新增依赖、IPC、服务、解码/AI/发送链或第二状态真源。动态CW文本、呼号、路径和AI正文保持原样。

验证：`npm run gui:typecheck` exit 0；`npm run gui:build` exit 0；`node --import tsx --test tests/gui-slice.test.ts` 6/6；`bash scripts/git-local.sh diff --check` exit 0。保护副本：`.local-backups/20261022-i18n-gui-redesign/`。Electron实际文件选择、PCM运行及Stop后解码器清理仍未验收。

### 2026-10-22：工作区布局重排

用户认可Zapier暖白风格方向，但指出布局需重新考虑。原布局将会话设置放在全宽顶部，首屏空间被文件选择和呼号输入占用，收报/回复提案较弱。沿既有renderer改为桌面左侧会话配置、右侧状态及收报/提案区；900px以下纵向堆叠；压缩配置项排列。字段、窗口操作、IPC、状态真源和`runReceive`调用不变，无新增依赖或入口。

验证：`npm run gui:typecheck` exit 0；`npm run gui:build` exit 0；GUI专项6/6；`bash scripts/git-local.sh diff --check` exit 0。当前环境未安装Playwright/Puppeteer，未做本轮Electron截图视觉确认；构建/测试通过不等同于视觉验收。文件选择、PCM运行和Stop后decoder清理仍待原定运行时验收。保护基线：`.local-backups/20261022-gui-layout-rethink/`。

### 2026-10-22：玻璃质感、数码状态与轻视差

用户反馈前版与预期Apple风格差距明显，缺乏玻璃、科技感与运镜。本轮仅修改`App.tsx`/`styles.css`：在深色空间底上加入半透明模糊层、克制网格/轨道、信号状态灯、装饰性频谱与提案扫描线；鼠标位置驱动低幅度视差，卡片和按钮有悬停/按压反馈；`prefers-reduced-motion`会弱化动画。频谱纯装饰，不代表采样数据。多语言与`window.cwstation`调用维持原样，没有依赖或业务链变更。

验证：GUI typecheck、GUI build通过，GUI边界专项6/6。Electron真实窗口的截图/视觉验收、本地文件选择与PCM/Stop清理仍未完成，不以构建结果代替视觉验收。保护副本：`.local-backups/20261022-gui-glass-motion/`。
