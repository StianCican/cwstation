# REV-V00-02-F Harmony 手机端解码检验器设计审议

日期：2026-10-28。版本：首轮设计审议。审议者：Codex；输入包含 DSH headless 只读源码/API 审议。首轮状态：方向可行，设计未闭合；首轮不通过。此为历史审议，第二轮复核及实施状态见末尾追加记录。

## 审议范围与基线

用户目标是用手机麦克风实时验证 CW 解码算法，HarmonyOS 为目标平台示例。任务限定为只读检验器，不属于 CW Station 0.0 自动发射产品功能；不接 AI、ReplySession、台站设备、发射、网络或音频持久化。任务卡为 [V00-02-F](../tasks/V00-02-F-Harmony手机端实时解码检验器.md)，全局 R01-R13 定义见[任务自查与审议规范](../design/任务自查与审议规范.md:50)。

初始保护基线为 `6711b59`，当时工作区干净。任务卡和 MEMORY 的后续未提交修改在 `.local-backups/20261028-v00-02-f-design-close/` 留有副本。设备状态：本机 `hdc list targets` 返回空；项目没有 Harmony HAP 工程，未构建、未安装、未采集手机音频。

## 主要结论

### 解码器嵌入

当前 multimon-ng 1.6.2 Morse 解调器可以在同一进程内复用，不必改现有 decoder interface。`demod_morse` 描述符提供 init/demod/deinit 函数指针，配置为 `float_samples=false`、22050 Hz、overlap 0；`buffer_t` 中的 `short*` 是输入，`length` 单位为样本。`morse_demod` 自身为静态符号，但通过 `demod_morse.demod` 可调用。见外部解码树 `demod_morse.c:15,254-261,353-392`、`multimon.h:241-259,290-304`。

输出通过 `_verbprintf` 写 stdout，没有输出回调参数。CLI 中 `_verbprintf` 的实现位于 `unixinput.c:268-310`。手机端可在原生桥接库内提供同名 `_verbprintf` shim，仅缓存 level 0 UTF-8 文本；不要重定向进程 stdout，也不要为此改动 Morse 解码函数接口。CLI 编译时定义 `MAX_VERBOSE_LEVEL=3`，桥接应保持该定义并将统计级别与译文分开（`CMakeLists.txt:238-240`）。`cw_dit_length`、`cw_gap_length`、`cw_threshold` 和自动模式开关是全局变量，不支持并行多实例（`demod_morse.c:38-42`）；首版固定默认值并限制单实例。

### 收尾与输出证据

现有 C CLI 使用固定参数 `-q -c -a MORSE_CW -t raw -`，patched CLI 输入 22050 Hz mono s16le PCM。当前外部 `cq-test-tail.s16le` SHA256 为 `484c844d…`，CLI stdout 字节为 `43 51 20 54 45 53 54 20 0a`（`CQ TEST \n`）；无尾静音的 `cq-test.s16le` 输出 `CQ TES\n`。历史探针 `probe-tail.jsonl` 记录首个输出约 805 ms，且在 EOF 前已出现译文。这些结果说明流式输出可用，但结束时要尊重解码器的时序判定。实现应在停止后按约定输入 0.5 秒合成静音，再调用 deinit；中断中的不完整字符可能被判为字符，界面必须保留原样，不做修正。源码见 `demod_morse.c:303-326,376-388`；既有探针见 `.local-backups/20261020-224014-multimon-probe/probe.jsonl` 与 `probe-tail.jsonl`。

当前 CQ PCM 位于 `/home/li0214/DSH/tools/multimon-ng-v00-02/`，未跟踪入项目。仓库 `examples/signal` 的固定例子为 8 kHz，不能直接作为此 decoder 的 22050 Hz 标准样本。实施时须用既有确定性合成能力临时生成 22050 Hz vector，并用相同 bytes 分别输入 host C ABI harness 和 patched CLI；测试音频不放入 HAP 或手机。

### Harmony API 与工具链

本机 CLT 为 26.0.0.851，SDK API 26.0.0.105、hvigor 6.26.8、ohpm 26.0.0.630（`/home/li0214/deveco-clt-26.0.0/command-line-tools/version.txt:1-13`）。SDK 有 CMake toolchain、N-API 头文件、`libohaudio.so`、`libace_napi.z.so`，hvigor schema/task 支持 `externalNativeOptions` 和 CMake。此为本机构建能力的静态证据，不是 HAP 构建通过。

Harmony SDK 提供 22050 Hz enum，但明确说明采样率支持因设备而异；S16LE、mono、RAW 也有显式类型（`@ohos.multimedia.audio.d.ts:890,937,1036-1082,1414-1447`）。Native AudioCapturer 提供采样率、声道、sample format、回调帧大小和 overflow 查询，以及读取音频 callback 的 API（`native_audiocapturer.h:186-200,248-260,294-324`）。由于 ArkTS `readData` 声明未说明回调线程，首版选 Native `OH_AudioCapturer`：原生回调只复制 PCM 到有界队列，不调用 N-API；单 worker 负责解码。Native API 启停应由异步 N-API 控制，避免阻塞 UI。

权限使用 `ohos.permission.MICROPHONE`，定义为 user-grant（`PermissionDefinitions.json:5260-5269`）；manifest 声明及运行时请求/拒绝路径必须实现并实测（`module.json:2460-2512`、`@ohos.abilityAccessCtrl.d.ts:259,304,340`）。AudioCapturer 文档说明 `readData` 回调中不得调用 AudioCapturer API，且开始后约 100 ms 数据通常静音（`@ohos.multimedia.audio.d.ts:7735-7755`）。

### 关键缺口与设计方向

| 编号 | 发现 | 严重度 | 修订方向 |
|---|---|---|---|
| F1 | 输出捕获与单实例全局参数未固定 | S1 | `_verbprintf` shim、UTF-8 有界缓冲、固定默认值、单活动 decoder |
| F2 | AudioCapturer 回调线程与 N-API 调用边界未确认 | S1 | Native 捕获 callback 只复制至有界队列；单 worker 解码 |
| F3 | 实际采样格式门禁未规定 | S1 | 启动时读取实际 22050/mono/S16LE/RAW；不匹配即释放并报错；不静默重采样 |
| F4 | stop/deinit 与最后字符语义未规定 | S1 | 停采集、消费队列、补 0.5 秒零样本、deinit/join/drain；失败不显示正常 stopped |
| F5 | 标准 PCM 对照不可在仓库复现 | S1 | 临时生成同一确定性 PCM，host bridge 与 CLI 原始输出字节比较 |
| F6 | HAP 尚无可离线编译的锁定 decoder source projection | S1 | 从固定 upstream commit+patch 生成 vendored files，记录文件 SHA；禁止手改 |
| F7 | GPL/cJSON 分发说明尚未落实到 HAP | S2 | 保留 GPL COPYING、cJSON MIT 声明；任何对外分发先确定对应源代码与应用许可证 |
| F8 | 麦克风权限、退后台与中断状态未闭合 | S2 | 仅申请 MICROPHONE；拒绝时不启动；退后台停止；中断不自动恢复 |

## R01-R13 标记

| R | 结果 | 说明 |
|---|---|---|
| R01 | 通过 | 用户可见目标、只读范围与不计入 0.0 已明确。 |
| R02 | 问题 S1 | C ABI/N-API 输出桥、decoder 全局状态约束待冻结。 |
| R03 | 问题 S2 | 无协议/持久化；GPL 源码交付和应用许可证待落实。 |
| R04 | 问题 S1 | 实际采样率、格式、声道及字节边界校验待落实。 |
| R05 | 不适用 | 无发射、设备控制或台站执行链。 |
| R06 | 问题 S1 | 合成尾静音、释放失败与 stopped 状态语义待落实。 |
| R07 | 问题 S1 | 回调、ring buffer、worker 和 N-API 并发边界待落实。 |
| R08 | 问题 S2 | 麦克风权限、拒绝、撤销和后台停止待落实。 |
| R09 | 问题 S1 | capturer/worker/queue/UI timer/文本上限清理待实现。 |
| R10 | 问题 S1 | 只有 CLI 外部样本证据；host bridge、HAP 与真机均未验。 |
| R11 | 通过（仅本轮） | 初始基线可定位；实现前还须保护当前未提交 docs diff。 |
| R12 | 问题 S2 | 设计结论与未验证范围须在二审及实现后继续同步。 |
| R13 | 方向通过 | 新增 HAP 诊断入口是明确需求；桌面主链不变；vendored 源码需锁定防分叉。 |

## 结论与未验证范围

无 S0。F1-F6 对应 S1 均未关闭，故首轮不通过；结论为“方向可行、设计未闭合”。本审议无代码修改和 HAP 构建。任务卡现已按上述方向修订，需第二次 DSH/Codex 设计复审后才进入实现。

未验证：用户手机型号/API、目标设备 22050 实际支持、原生采集格式/时钟、麦克风权限提示、音频中断/退后台、Native/HAP 构建与签名安装、host C ABI 与 CLI 对照、真机实时 CW 质量、GPL 分发安排。

## 第二轮设计复核与首实现（2026-10-28）

任务卡按 F1-F6 修订后，DSH 定向复核结论为“host 范围无真实 S0/S1 阻塞，设计通过”。Codex核对 C 描述符/输出桥、单实例、严格格式门禁、有界队列、停止收尾及源码投影，接受该范围设计。首轮“未闭合”仅保留历史，未将未实现/未连接设备等同设计缺陷。

实际主链为 `ArkTS Index → 异步 N-API → CaptureSession → Native AudioCapturer 回调/有界 PCM 队列 → 单 worker → cwstation::CwDecoder → vendored demod_morse`。采集回调不调用 N-API；start/stop 在异步工作中用生命周期锁串行化，stop 请求使待执行 start 的代次失效；GC finalizer 将共享会话交给清理线程，Release 失败时保留回调 userdata。权限返回后仍检查前台/页面有效性，防止进入后台后继续启动。

主机 C++ 桥接已实现并通过实际 patched CLI 完整字节对照（带/不带尾静音、合成收尾、固定/随机/单样本块）。首个 ARM64 未签名 HAP 已完成界面、原生库与打包。第一条链路的采集生命周期故障注入及交叉审议已完成；DSH未发现S0/S1，三项S2由Codex修正并通过受影响host回归。最终HAP重建通过，最终 R01-R13、结论与证据集中见 [实施证据](../evidence/V00-02-F-Harmony手机端实时解码检验器.md)。

原生采集、系统真实格式、权限提示、系统/API、签名安装和现场质量仍未验证，不据离线结果宣称真机可用。DSH完整原始结果保存于 `.local-backups/harmony-implementation-20261028-132057/dsh-result.log`；不得把它当真机证据。
