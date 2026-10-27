# CW Station

外部 CW 解码器的补丁、固定上游版本及构建步骤见 [multimon-ng 补丁说明](patches/multimon-ng/README.md)。真实空口可靠抄收仍未验收。

独立的AI CW自动发射软件项目。目标是让AI参与CW内容与操作提案，由确定性的控制逻辑校验并执行，逐步形成稳定、可恢复、便于操作的自动化软件。

当前0.0目标草案、冻结规则、里程碑和唯一当前任务见[版本交付路线](docs/ROADMAP.md)。自动化边界待用户确认；确认后直至0.0完成，范围外需求只留作后续版本候选。

接续开发先读 `AGENTS.md` 的单主轴约束和ADR-020。下方保留多种历史入口的使用说明，不代表多条开发路线同时推进；设备执行沿用既有单次CW试验链，AI回复已接入人工确认后的模拟发送，真实AI回复发射尚未接通，当前状态见MEMORY顶部。重复链路原因见 `docs/reviews/REV-020-重复链路根因与项目规范.md`。

已做/未做及证据范围统一查看[MEMORY当前事实清单](MEMORY.md)，提下一步前先核对；当前用户未连接电台不影响已有历史实机验收结论。

当前已完成离线控制核心、IC-7300 只读监视链路及受控 CW 短报文试验：

- daemon 是唯一拥有 `TxController`、键控适配器和 SQLite 的进程；默认使用进程内FakeKeyer。
- 控制 CLI 只通过本地 IPC（Unix socket 或 Windows 命名管道）请求，不直接打开数据库，也绝不自动批准。
- 提案、批准、执行、结果、审计都持久化到 SQLite，并带显式 schema 迁移。
- 常规发射控制流程仍仅限 Fake；IC-7300 只读监视已完成实机验证。独立受控试验已验证一次命令应答和本机侧音，尚未证明实际报文完成、停止或射频行为。
- 统一设备操作接口已接入既有宿主的 Fake 首切片，默认 `bash rig.sh` 保持只读；生产账本、旧入口迁移与真实接入仍待后续验收。

## 当前主链路：单次设备试验

当前已实现的设备执行基础为既有 `CwTrialSession`：一个设备会话、一次人工确认、一次固定短报文，复用相同的模拟/真实CI-V代码；不需要另启动daemon、SQLite或IPC设备服务。它尚非AI自动发报成品，新增工作以0.0冻结范围为准。默认 `bash rig.sh` 仍是只读监视。

```bash
npm run build
bash rig.sh --cw-trial --help
# 离线试验：指定仅供模拟使用的独立记录目录；有intent的目录再次运行会阻断。
bash rig.sh --cw-trial --simulate --simulate-confirm E --record-dir logs/cw-trial-simulation
```

流程：八查询预检 → 人工确认（模拟为显式simulate-confirm）→ 重读核对 → intent刷盘 → 一次E/TEST → 停止请求 → 退出释放。`scripts/cw-trial.sh`仅作为此入口的兼容转发。真实设备仍需现场单独授权、显式端口与keying-off确认及交互TTY，本次整顿不执行真实试验。

可选`--estimated-wpm <6..48>`沿同一runner增加估算收尾：收到发送应答后，按最终正文复用现有Morse时间轴，等待估算时长×1.25＋500ms，再每100ms观察RX，连续采样满足600ms后请求原停止并退出。额外观察上限5秒，TX/超过300ms的观测空档重置稳定窗；超时/异常非零退出，Ctrl+C取消等待并走原停止/关闭（在途查询最多等待原查询超时）。查询失败仍按原规则锁定/关闭会话，此时停止可能unavailable，不能保证停止帧写出或电台停发。速度由操作人提供，应不高于实际有效键速；程序未读取或设置电台速度，系数/余量未做硬件校准。此项结果始终标为`completion=unknown`，不能证明起发、整条完成或物理停发，不自动解除intent。开启时原记录追加一条send_result保存估算观测，无新schema；默认不启用，不改变GUI真实发送禁用状态。

退出0仅表示命令流程观察到应答且清理完成，不能证明报文完成或物理停发；退出6表示关闭未确认，7表示发送/停止未观察到应答，其他非零值表示拒绝或失败。intent默认阻断，不得换目录或删除记录绕过。现阶段是单次受控试验，不是自动连续操作系统。

### 显式人工核查历史 intent

用户核对原进程全部退出、当前设备状态与隔离依据后，可沿原入口执行以下动作（替换占位值，必须交互TTY）：

```bash
bash rig.sh --cw-trial --review-intent "<intent-id>" --operator "<name>" --note "<actual-review-basis>" --record-dir "<original-record-dir>"
```

程序展示目标原记录及SHA256摘要，要求完整输入`REVIEW <intent-id> <digest>`。它只在原JSONL追加v2 `intent_review`记录并fsync，原v1行不变、旧报文完成/停止仍UNKNOWN；不打开transport、不重试旧报文、不同时发送。核查只解除该条intent对后续新提案的阻断，其他/新intent仍阻断，后续发送仍经过原预检与确认。不得代填未经核实的设备状态。旧版不认识v2时保持阻断，不能让旧版与新版同时运行。

发送与核查在原目录全程共用`.cw-trial.lock`目录锁。遇到锁占用应先退出竞争任务；崩溃遗留锁不自动抢占。人工恢复前必须核查全部旧进程已退出、备份原账本并检查完整性；尤其核查写盘结果UNKNOWN时，不能盲删锁重试。确认无活跃持有者且核查行及持久化结果已人工厘清后，才可人工移除该空锁目录；不删除/改写JSONL，不以PID或经过时间自动判定安全。文件损坏或版本不支持时先保留现场，不通过移除锁解除账本阻断。本功能Linux离线验证通过，Windows文件系统/串口现场尚未验证。

发送前intent写盘失败不发送；发送尝试后的结果记录或停止记录写盘失败，仍通过同一会话尽力请求一次停止并关闭，不重复发送/停止，也不解除intent。退出码优先级为关闭未确认6、记录故障1、无应答7；记录故障即使伴随无应答也不返回0。此处仅处理记录操作已返回失败的情况；会话已故障关闭时不保证停止帧能写出，也不保证文件系统永久挂起时的停止时延。P2-017C已完成双平台离线专项、DSH审议修正复核及Codex限定验收，未做本轮实机验收。

## 接收 CW 解码文本（V00-02-D，文件/PCM 或 FFmpeg 实时音频）

当前生产调用链为 `cwrig receive → apps/rig-receive.ts → packages/receive →（实时音频时一个 FFmpeg 采集子进程）→ 一个 multimon-ng 子进程`。用户只操作本项目 CLI；解码器在后台以固定参数 `-q -c -a MORSE_CW -t raw -` 运行，不启动/关闭完整 fldigi GUI，也不暴露任意解码器参数、网络服务或设备控制。旧的 fldigi XML-RPC 客户端源码与历史证据保留但已冻结，`--endpoint`/`--once`/`--interval-ms` 会以退出码 2 明确拒绝。

2026-10-27 已在同一 multimon-ng 解码器实现中加入噪声底跟踪和迟滞门限；`-x -o 2600 -d 65 -g 65 -y` 仍因单样本退化和增益敏感而否决。新二进制已通过 multimon CTest 5/5，并在既有 clean/noisy/CQ TEST 样本上完整解出 `CQ TEST`；现场录音仍需人工真值和 GUI 实收确认，暂不宣称可靠抄收。证据见 [V00-02-E](docs/evidence/V00-02-E-CW解码质量诊断.md) 和 `MEMORY.md` 顶部。

输入两种模式严格互斥，且必须显式选择一种：

- `--pcm-s16le <file|->`：读取 **22050 Hz、mono、signed-16 little-endian PCM** 字节流；不支持 WAV 头、其他采样率。`-` 表示 stdin。本程序不加 WAV 解析器或音频服务。
- `--ffmpeg <executable> --audio-backend <pulse|dshow> --audio-device <name>`：启动一个 FFmpeg 采集子进程，把指定设备转成同一 PCM 格式后送入同一个解码会话。`pulse` 只用于 Linux，`dshow` 只用于 Windows；设备名必须显式给出，不采集默认麦克风。dshow 设备以单个 `audio=<name>` argv 传入，不做 shell 拼接。

实时模式固定使用 `-hide_banner -loglevel error -nostdin`、`-f pulse|dshow -i <device>`、无视频、`-ac 1 -ar 22050 -c:a pcm_s16le -f s16le pipe:1`。不接受任意 FFmpeg 参数、shell 命令或网络输入，不保存原始音频文件。

```bash
npm run build
node dist/apps/cwrig.js receive --decoder /path/to/multimon-ng --pcm-s16le capture.s16le
ffmpeg -i sample.wav -f s16le -acodec pcm_s16le -ac 1 -ar 22050 capture.s16le
node dist/apps/cwrig.js receive --decoder /path/to/multimon-ng --pcm-s16le -
node dist/apps/cwrig.js receive --decoder /path/to/multimon-ng \
  --ffmpeg /path/to/ffmpeg --audio-backend pulse --audio-device <source-name>
```

运行预算默认 60000 ms（`--timeout-ms` 1..3600000，包含采集启动、PCM 传输和解码）；触发后另有有界清理宽限。PCM 模式沿用原语义：正常读到输入 EOF、有实际完整采样且没有残片时才补 0.5 s 零值静音，然后关闭引擎 stdin；空输入、取消或失败不补静音。输入按字节流校验偶数长度，跨块奇数长度会拼齐，最后仍剩半个采样则明确失败；输入不做无界缓存，实时 PCM 按流背压传递。

实时采集进程自然退出（包括退出码 0）是不预期失败 `capture_failed`，不会伪装成正常完成；FFmpeg 缺失是单独的 `capture_missing`。采集失败会取消解码器；解码失败、回调失败、超时或外部取消会停止采集器。任一子进程按 500 ms SIGTERM 宽限、必要时 500 ms SIGKILL 清理，不重试；预取消不启动任何进程。采集 stderr 持续排空但最多保留 64 KiB，不回显原文。

输出为 JSONL。状态行含 `type:"status"`、`state`、`source:"multimon-ng"`、`readOnly:true`、`sessionId` 等；实时模式另含 `audioBackend`、`audioDevice`、`audioSampleRateHz`、`audioChannels`、`audioSampleFormat`，完成/停止/失败时含 `pcmBytes` 与 `captureStderrRetainedBytes`。每个非空文本块为 `{"ok":true,"type":"chunk","source":"multimon-ng","readOnly":true,"sessionId":...,"seq":...,"text":...,"receivedAt":...}`。`seq` 只对本次会话交付的非空文本递增，`pcmBytes` 只表示交给解码器的字节数，二者都不是空口准确率或完整 QSO 证明；stdout 数据按块流式交付，不等待换行，单块也不保证是完整字符/词/报文。无文本时以 `state:"completed"`、`decoded:false`、`empty:true` 结束，不虚报解码成功。

单会话仍只有一个解码引擎，不重启、不重试；实时模式另外只有本次会话的一个采集进程。stdout 总字节上限默认 1 MiB，stderr 持续读取但最多保留 64 KiB 且不回显原文。输入错误、引擎/FFmpeg 缺失、非零退出、采集提前退出、超时或输出超限都以非零退出并给出明确 `code`；已交付的文本保留，但不表示整个输入完成。`SIGINT`/`SIGTERM`/外部取消后不再交付迟到文本，停止输入并清理两个子进程；只有解码器与采集器都确认清理的主动取消才退出 0，任一清理未确认即退出 1。退出码：正常完成 0、确认清理的主动取消 0、运行/清理失败 1、参数错误 2。

输出去除引擎 CR/LF 帧边界，保留单独到达的词间空格；只有实际非空白内容才报告 `decoded:true`。

### 收报回复提案（V00-03-A，单轮，不自动发射）

`receive` 可选接入 assistant 的单轮回复提案。三个回复参数必须同时给出；不给出时完全保持上面的原收报语义，不会默认联网：

```bash
node dist/apps/cwrig.js receive --decoder <multimon-ng> --pcm-s16le capture.s16le \
  --reply-config <assistant-config.json> --own-call B1AA --peer-call B2BB \
  [--reply-idle-ms 2500]
```

- 配置沿用 `cwai` 的 version1 文件；联网前严格加载校验，不打印凭据。`--own-call`/`--peer-call` 为 2..12 位大写 ASCII 字母/数字/斜线，各至少一个字母和一个数字，且不能相同。
- 同一 `sessionId` 最多一个 turn、最多一次模型调用。收到非空白字符后重新计时，默认 2500 ms（1000..10000）无新非空白字符即收口；正常 PCM EOF 立即收口。空格保留在组报文本中，缓冲上限 1024 字符，超限明确失败且不调用模型。
- 模型在途时出现新非空白文本会撤销该 turn、中止请求并抑制迟到结果，不重试；提案发布后出现新非空白文本会发出 `type:"invalidated"`，使当前提案失效，不发起第二轮。
- 事件为 JSONL：`type:"utterance"` 含 `receivedText`/`boundary`；`type:"reply"` 含 `provider`/`model`/`validated`/`action`/`text`/`reason`。所有事件都带 `sessionId`、`turnId`、`revision`、`advisoryOnly:true`，不携带原始模型文本、凭据或执行帧。
- 模型必须返回严格 JSON `{"action":"reply"|"no_reply","text":string,"reason":string}`，不得有额外字段、代码围栏或说明文字。回复正文必须已是 uppercase ASCII、非空、不超过 30 字节、禁止 `^`，并复用 IC-7300 Command 17 的纯校验器；不截断、不替换、不规范化。非法输出以 `validated:false` 明确失败。
- 官方 `https://api.deepseek.com` 的 `deepseek-flash`/`deepseek-v4-pro` 回复请求显式使用非思考与 JSON 输出模式；其他端点及原状态解释保持默认请求行为，配置仍为 version1。JSON 模式不替代本地严格校验。回复事件可带 `diagnostics`：结束原因白名单、正文/思考字符数和固定校验失败分类；不包含原始模型正文或思考内容。明确未完成的响应即使局部 JSON 合法也会拒绝。
- `disabled` 明确返回 `no_reply` 且不联网；`mock` 在本地确定性生成合法短回复，输出 `provider:"mock"`，不代表真实模型。所有提案都只是显示内容，不能授权发射；本入口不打开设备 transport。
- 单轮提案不是完整自动通联，也不证明空口抄收准确率。真实 DeepSeek 服务已完成一次修正后限定验收：既有样本→同一解码/回复链→真实模型→合法提案，约1.9秒；首次格式失败与修正证据均保留。无密钥产品配置可用 `data/assistant.deepseek.json`；运行时仍需提供其指定的环境变量，验收临时授权不构成自动读取 DSH 凭据的产品功能。详见[回复提案证据](docs/evidence/V00-03-A-收报回复提案.md)。

### 回复衔接模拟发送（V00-03-B，仅 PCM 文件 + 交互 TTY）

在 03-A 的单轮回复之外，可显式要求把一条已校验的 `action:"reply"` 提案交给既有单次 CW 试验链，但**只使用模拟 transport**：

```bash
node dist/apps/cwrig.js receive --decoder <multimon-ng> --pcm-s16le capture.s16le \
  --reply-config <assistant-config.json> --own-call B1AA --peer-call B2BB \
  --reply-trial-simulate --reply-trial-record-dir logs/cw-trial
```

- 两个 `--reply-trial-*` 必须同时给出，且必须同时给出三个回复参数；只接受 `--pcm-s16le <file>`，拒绝 stdin（`-`）和实时音频。没有自动确认参数，必须由交互 TTY 完整键入最终正文本身；新增编辑方式及其验收状态见下方03-D。无 TTY、`no_reply`、失败/取消或提案未发布都零派发。
- 实际执行复用 `apps/rig-cw-trial.ts` 的 `runCwTrial`/`CwTrialSession`/模拟 transport，不复制预检、确认后重读、intent fsync、一次发送、停止或关闭循环；仍为 16 条预检查询、一次 Command 17 正文和一次停止。进入该模式的完成状态行标记 `readOnly:false`，表示本次会话不再是纯只读收报；`replyTrial.performed` 只表示已进入 `runCwTrial`，是否实际写入正文看 `exitCode` 与记录，不能用 `performed:true` 单独证明已派发。
- 提案只在进程内绑定：正文再次经过大写/字符/长度校验；记录继续使用既有 schema 的 `message:null`，在 `detail` 保存精确正文、`sessionId`、`turnId`、`revision` 和既有帧信息。不改记录格式、不删记录；同目录未解决 intent 仍阻断重跑。
- 提案绑定保留当前有效性检查；确认后重读、意图落盘后均再次检查。收报入口取消会中止等待中的确认，不能在取消后补输入而恢复派发。
- 真实入口与既有 E/TEST 试验限制不变；本路径不向真实入口开放任意文本，也不打开串口或调用真实模型。退出码沿用 `runCwTrial`（0 成功、2 用法/无 TTY、3 未确认/拒绝、4 预检拒绝、5 上下文变化、6 关闭未确认、7 发送/停止未观察到应答）。

本切片最终验收：受影响专项49/49、build通过；编译CLI+既有真实multimon/PCM解出CQ TEST，经本地mock回复及PTY完整正文确认，将B1AA DE B2BB K交给既有模拟发送/停止/关闭，exit0，记录完整。未调用真实模型或电台，不代表真实发射或完整QSO。见[03-B证据](docs/evidence/V00-03-B-回复衔接模拟发送.md)。

### AI 连续上下文与通联时延（V00-03-C，只提案，不发送）

同一 `receive` 可显式开启连续 AI 模式。它仍走原来的 `apps/rig-receive.ts → packages/assistant/src/reply.ts` 会话和唯一 `chat.requestChatCompletion` 传输；只是会话不再在第一轮后关闭：

```bash
node dist/apps/cwrig.js receive --decoder <multimon-ng> --pcm-s16le capture.s16le \
  --reply-config <assistant-config.json> --own-call B1AA --peer-call B2BB \
  --reply-continuous [--reply-wpm 20] [--reply-budget-ms 5000]
```

- 模型看到的是同一会话内的历史：真实 `received` 轮次与明确标注 `proposal NOT SENT` 的旧提案；旧提案永远不被当作已发送，也不含执行帧或批准。模型每轮自主返回严格 JSON `{action:"reply"|"wait"|"end",text,reason}`：`reply` 正文仍走原来的 30 字节/大写/字符/`^` 校验；`wait`/`end` 正文必须为空。`wait` 不会自动重试同一收报文本；`end` 后不再请求。
- 新非空白收报会中止在途请求、把待收文本合并到下一轮，并在下一 idle 只用一次新请求；被中止或晚到的结果不会发布。已经发布的旧提案在新输入后标记为 invalidated，但仍明确不是已发送。
- 硬上限：至多 12 次收口尝试（含在途撤销）、渲染上下文至多 12000 字符；预留有界回复空间，可能提前停止，到限输出 `type:"ended"`，不静默删除历史。正常 PCM EOF 以 `reason:"eof"` 结束；采集失败/取消保持 canceled，不伪装成正常收口。
- `--reply-wpm` 只允许 5..60（默认 20），是声明值而不是对实际码速的测量；发报时长按现有 `packages/signal` 的 `encodeCwText`/`buildTimeline` 估算，合法但不在该编码表内的字符显示为不可估，不改变提案合法性。`--reply-budget-ms` 100..10000（默认 5000）从本轮 boundary 起算，超预算会取消并抑制迟到结果；既有 `--reply-idle-ms` 仍为 1000..10000（默认 2500）。
- 事件仍为 JSONL：连续 `type:"reply"` 增加 `continuous:true`、`turnIndex` 和 `timing`（`idleMs`/`modelMs`/`totalMs`/`budgetMs`/`wpm`/`estimatedDurationMs`），时间用单调时钟；`type:"ended"` 给出 `reason`、`turns` 和保留的 `historyChars`。完成状态行增加 `replyTurns`、`replyEndReason` 等字段。
- `turnIndex` 是收口尝试编号，撤销后合并文本可保留重复前缀快照。`ended.receivedText` 是尚未处理的缓冲，正常结束可为空；完整报文见前序 `reply.receivedText`。
- 普通连续模式与 03-B 的 `--reply-trial-simulate` 仍互斥；03-D仅为显式prepared模式增加正常文件EOF后一条模拟发送接入，见下节。没有多轮发送路径，不自动清 intent、不重复发送、不打开设备。不是完整 QSO 或真实发射。

本切片最终验收见[V00-03-C证据](docs/evidence/V00-03-C-AI连续上下文与时延.md)；测试使用本地脚本化 HTTP 和既有解码夹具，不调用真实模型、凭据或电台。

最终回复专项32/32、原发送专项28/28、build和编译CLI两轮接通通过；最终CLI使用既有真实multimon/PCM及本机脚本化HTTP。示例正文声明20WPM预计8.22秒。idle只是文本收口启发式，不能证明空口已空闲；真实多轮AI质量、实际码速识别、收发切换及连续发射仍未验。

实时音频既有验收（V00-02-D，沿用）：实时音频专项16/16、旧CLI5/5、build通过；Linux/WSLg真实FFmpeg回放monitor进入编译CLI，完整解出CQ TEST、主动停止exit0。测试播放器首次截断的失败/包络诊断已保留，补播放尾静音后通过，产品参数未调。PCM文件/stdin沿用C证据。Windows原生、物理麦克风、电台、噪声及长时未验。详见[实施证据](docs/evidence/V00-02-D-实时音频输入.md)。

### AI预备回复与人工编辑（V00-03-D）

03-D整句预测曾作为机制实验限定验收，真实适用性未验；其AI候选语义已由03-E替换，历史边界见[03-D证据](docs/evidence/V00-03-D-预备回复与人工编辑.md)。03-E已在同一prepared入口接入严格CQ本地快速回复，非命中仍走原AI，并复用既有EDIT与一次模拟发送runner。定向专项38/38、build通过；不代表真实命中率或整体空口提速。规则、限制和验证记录见[03-E证据](docs/evidence/V00-03-E-CQ快速回复模板.md)。

仅PCM文件加原`--reply-trial-simulate --reply-trial-record-dir <原记录目录>`及交互TTY时，可把正常EOF的最后一条当前有效reply交给同一runner模拟发送一次；前面各轮只是NOT SENT提案，end/超限/取消不发送。不会为多轮发送清除intent或更换目录。真实E/TEST白名单不变。

模拟回复确认可输入`EDIT <大写CW正文>`修改当前草稿，再完整键入展示的最终正文确认。正文仍不得超过30字节，不允许`^`；非法编辑不会发送。AI不覆盖人工草稿，失效/取消会撤销派发资格，记录与设备帧使用最终确认正文；这不是已经发送内容的撤回功能。CLI现有入口先接通，GUI尚未实现。

会话默认人工；在上述PCM文件、交互TTY及模拟发送参数组合中追加`--reply-auto`，可让最后一条合法本地CQ或AI回复经同一预检、重读、intent落盘自动模拟发送一次，跳过完整键入确认。`no_reply`、无效/过期提案不发送，原目录未决intent仍阻断，不支持stdin/实时输入或真实自动发射。JSONL标注`dispatch`、`scope: simulator`和控制代次。嵌入端复用同一`ReplyDispatchControl`：编辑切回人工，停止终止本会话并取消原等待；自动派发开始后不能抢改正文。CLI/GUI状态契约见[04-A证据](docs/evidence/V00-04-A-GUI切片.md)。

桌面演示壳已可构建：`npm run build && npm run gui:build && npm run gui`。它显示演示收报、提案和会话授权状态，操作仍通过同一`ReplyDispatchControl`；当前不接真实receive、模型、电台或发送，Electron/React/Vite尚未做安装包和跨平台验收。

## 保留的 Fake IPC 实验

此三进程链路暂停扩展，保留既有行为和测试；它不是当前设备主链路，也不接真实串口。

```bash
npm run build
bash rig.sh --mode cw-trial --simulate
# 或运行一次明确的离线自动演示：
bash rig.sh --mode cw-trial --simulate --demo E
```

交互命令为 `status`、`propose E` / `propose TEST`、`approve`、`execute`、`stop`、`get`、`quit`。普通交互需显式批准；`--demo` 仅用于模拟自动演示。发送等待期间仍可输入停止。独立启动交互端没有继承IPC时拒绝控制。

此入口只支持模拟，拒绝端口参数。宿主stderr报告本次临时夹具路径，退出后保留记录；夹具不是生产账本，不能作为真实历史恢复或可靠射频停止证明。新模式尚不支持重连，旧试验入口尚待迁移。范围与证据见 `docs/adr/ADR-019-统一操作Fake首切片.md` 和 `docs/evidence/P2-017A-统一操作Fake首切片.md`。

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

- daemon常规发射控制仍仅使用Fake；真实只读与独立受控试验的历史验证范围见本文开头，未证明实际报文完成或射频停止。
- 核查解除仅适用于 Fake 阶段：只能处理启动恢复时已存在的 `unknown`；本次启动后新增的 `unknown` 必须停机重启。数据库不可写等存储故障会闩锁解除路径，需人工排查，不能靠重试或删记录绕过。
- 仅支持 CW 单一模式与单一频点；`dev.state` 是测试钩子，默认关闭。
- 优雅关闭时无法在有限时间内确认停止的在途发射会记为 `unknown`，不会记为 `completed`。
- 备份/核查/恢复/故障清除都是离线维护操作：要求 daemon 已停止（或未持有数据库锁），不会自动停 daemon。恢复生成的是新数据库，需重新批准方可发射；`clear-storage-fault` 只验证恢复后的存储可写性，不修复损坏数据库或硬件故障。
- Julia 合成/噪声只在已确认的 MWORKS 环境（Julia 1.10.10、TyCommunication 1.0.7、
  JSON3 1.14.3、WAV 1.2.0）实测；`seed` 复现范围限于该记录环境，跨版本不保证逐样本一致。
  该路径是离线计算，未接入发射，也未验证真实音频设备回放。

## 测试

```bash
npm run build          # 新宿主集成用例会启动 dist 下的编译版子进程
npm run test:preflight  # 检查子进程输出、本地 IPC 和本机 HTTP 监听能力
npm test               # 前检通过后，以 tsx 运行源码测试
npm run test:built     # 前检通过后，构建并运行同一批编译版测试
node scripts/verify-platform.mjs --source --list  # 只列出测试，不启动前检或构建

# 两平台原生构建及编译测试，不依赖 shell 展开 glob
node scripts/verify-platform.mjs
```

源码与编译版从同一份清单发现 `tests/` 和 `packages/` 下的 `*.test.ts`，包含服务内测试。
前检失败返回2并标记 `environment_unavailable`，不会启动构建或产品测试；这表示环境阻塞，不能当作测试通过。

验证器保留每文件隔离，并将并发测试文件限制为4，避免集成测试同时创建大量子进程挤占短时序检查；用例断言和产品期限不放宽。
构建或测试失败返回1；列清单和帮助返回0。完整回归保留 Node 的文件隔离；关闭隔离的定点诊断不替代全仓验收。

2026-10-15续办验证：Linux源码/编译各361通过、0失败、8项平台跳过；Windows原生源码/编译各360通过、0失败、9项平台/权限跳过。编译版Fake客户端已修正为启动编译后的子服务。共享WSL依赖目录运行Windows源码模式需要锁文件中的Windows esbuild可选包；编译版无需tsx。详细日志、跳过范围与待DSH补审状态见`docs/evidence/BASE-002-test-baseline.md`。

2026-10-19 Fake首切片验证：新增37项专项，全仓26文件406项。Linux源码/编译各398通过、0失败、8跳过；Windows原生源码/编译各397通过、0失败、9跳过，内部符号链接权限分支另有诊断。旧abort用例提前建立第二连接，避免桥进程启动占用发送窗口；产品时限不变。失败修正及边界见`docs/evidence/P2-017A-统一操作Fake首切片.md`。

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
