# V00-02-F Harmony 手机端实时解码检验器

日期：2026-10-29。状态：初版2026-10-28真机已安装采集；本轮TONE-600 v1限定离线验收完成，最终调试签名HAP及SDK验签通过，新版已于10月29日原地安装启动，准备接收，声学质量待试听。此工具不计入0.0自动发射产品功能。

最新现场：2026-10-29用户连接后，最终HAP覆盖安装/启动成功，UID与首次安装时间未变，UI准备接收；未开始麦克风采集。后续顺序为本版调好后再做Android，共用同一算法补丁，不并行扩建。安装证据及保护见实施证据顶部。

## TONE-600 v1：600 Hz 目标音调前端（2026-10-29，限定离线交付）

用户已同意先推进手机解码质量：本轮只实施原备忘第一项，不修改时序或门限；下方早期“未安装/未验”是历史，2026-10-28已安装采集及安静/人声计分以MEMORY为准。

1. 用户可见缺口：安静环境仍有开头漏码/局部错码，人声条件错误更多。交付600 Hz目标音调试听构建，先以同PCM新旧对照核对干净输入不退步及带外干扰改善；不预先承诺手机CER下降。
2. 主链与复用：`OH_AudioCapturer → 原有界队列/worker → CwDecoder → 同一 demod_morse`。唯一算法真源仍是上游固定提交加项目既有补丁，手机third_party由该补丁再投影，禁止另写手机Morse解码器。Codex设计/复核，DSH负责补丁、投影、编译选项与专项自测；Codex负责状态文档和打包，两者不同时修改同一真源。
3. 最小修改：在原整流包络前增加600 Hz窄带检测，拟采用中心增益1、Q=5的稳定二阶带通（约120 Hz带宽，中心群延迟约2.7ms），滤波状态保留在原decoder并随init复位。原码速跟踪、阈值、迟滞、字符表、采集和界面保持既有实现。不做自动选频、录音、文字纠错或周期重置。DSH先自查设计可行性，Codex复核后收口。
4. 数量变化：无新增应用入口、进程、服务、协议、依赖或持久化格式。原补丁新增编译期选项，默认0保持旧桌面行为，手机构建显式600；这不是新增可独立运行解码路径。
5. 迁移与回退：不替换桌面已运行二进制。手机调用者通过原CMake接入该前端；有证据才能称手机构建已接入。可由原Git基线及原HAP回退，保留原源码、签名副本和产物，不清理设备记录。
6. 验收与保护：Git干净基线79461d8；`.local-backups/harmony-tone-20261029-021422/before.tar`包含手机源码及既有构建输出、补丁、MEMORY/ROADMAP与本任务/证据原文件。复用既有15/20WPM标准PCM和计分工具，全段首尾错误均计；人工合成干扰单独标记，不冒充人声/手机输入。检查旧宏0字节兼容、手机宏600与相同CLI同字节、CQ TEST/尾静音/不同分块及受影响采集worker，再构建HAP。真机质量须用户试听，未连接不虚记验收；不启动麦克风或RF。

最终结果：同PCM干净15/20WPM CER仍0.741%/0%；590/610Hz无错码；合成1000/1500Hz连续干扰由135编辑降至0编辑。双配置CLI/bridge/分块、实际worker故障回归、HAP及验签通过。真实手机准确率待验。证据及最终HAP/SHA见[V00-02-F实施证据](../evidence/V00-02-F-Harmony手机端实时解码检验器.md)。

## 目标与边界

用户要在手机上实时接收 CW 音频并查看原始解码文本，以便检验 multimon-ng 门限补丁。首个目标按本机 HarmonyOS API 26 工具链，输入按手机麦克风；用户已报告 Mate X5 / “鸿蒙7”；实际系统/API 未读取。用户最新告知手机断开，电脑端继续推进，安装与麦克风验收时再通知连接。

1. **用户可观察缺口与完成条件**：当前 Electron GUI 已有实时解码，但依赖 Node 启动 FFmpeg 与 multimon-ng 子进程，项目没有可在 Harmony 手机上运行的解码界面。完成时，手机应用能申请麦克风权限、开始/停止实时 CW 接收、显示原始解码字符及输入电平；停止后释放采集和解码资源。界面不修饰、不补全、不把乱码改写成建议。
2. **既有路径与复用对象**：核心沿用 `patches/multimon-ng/README.md` 锁定的 multimon-ng 1.6.2 上游提交 `b5f7d71c5e9b5a76093ba55c515968dc40f92804` 及 `multimon-threshold-hysteresis.patch`。现有桌面路径 `runReceive → runAudioReceive → runMultimonReceive → 一个 multimon-ng` 不变；手机只增加调用同一 C 解码实现所需的薄原生桥接，不复制 Morse 解码逻辑。
3. **最小范围**：新增一个 ArkTS/ArkUI Harmony 应用和同进程 Native C/C++ 模块。ArkTS 只请求麦克风权限、控制界面并轮询结果；原生 `OH_AudioCapturer` 直接采集，采集回调只将 PCM 复制进有界环形队列，单一解码 worker 顺序调用 `demod_morse`。N-API 只暴露异步 start/stop、快速 drain 与 clear，不从音频回调调用 N-API。输入固定请求 22050 Hz、单声道、S16LE、RAW，并在启动时读取原生 AudioCapturer 实际采样率/声道/格式/编码；任一不符即释放并报错，不送入解码器。手机不支持 22050 Hz 时本任务停止并提交可靠重采样的独立设计，不静默换格式。
4. **入口/进程/协议/存储变化**：新增一个仅供本地解码验收的 Harmony HAP 应用入口及应用内原生模块；不新增 daemon、网络协议、独立进程、共享记录格式或持久化。采集和解码都在应用进程内；音频不上传、不写入设备存储。桌面与 CLI 入口不变。
5. **替换与迁移**：不替换现有桌面解码调用者；手机应用是用户明确要求的独立诊断入口，验收通过也不意味着接入 0.0 主产品。失败或放弃时删除手机应用文件即可回退，保留既有桌面主链和补丁。
6. **验收与保护基线**：本任务初始 Git 基线 `6711b59`；当前 `MEMORY.md` 和本任务卡是本轮未提交修改，开始代码实现前须备份这两项及当前 diff。先将现有确定性 CW 合成能力用于临时生成 22050 Hz 单声道 s16le `CQ TEST` 对照 PCM，不将测试音频放入 HAP 或设备；host C ABI harness 与 patched multimon CLI 必须得到相同完整输出字节。参考结果要求固定 0.5 秒尾静音并输出 `CQ TEST \n`；移除尾静音会输出 `CQ TES\n`，作为收尾回归。再构建 Harmony API 26 HAP。真机验收需连接设备后覆盖权限拒绝/批准、格式核验、实时输入电平和译文、停止释放、再次启动、退后台停止及队列溢出显示。当前无 HDC 设备，因此不能预先声称麦克风/现场验收通过。每阶段由 DSH 自测并交付命令/结果，Codex复核。

## 解码器集成契约

- 从上游提交 `b5f7d71c5e9b5a76093ba55c515968dc40f92804` 应用现有 `patches/multimon-ng/multimon-threshold-hysteresis.patch`，为 HAP 提供可离线构建的精确源码投影；记录来源提交、补丁 SHA 和 vendored `demod_morse.c`、`multimon.h`、`cJSON.h` SHA。源码投影不得手工偏离上游+补丁，不修改桌面二进制或 `packages/receive`。
- C 解码核心只编译 Morse demod 所需的 `demod_morse.c`，通过公开 `demod_morse` 描述符调用 init/demod/deinit；`buffer_t` 输入为 16-bit samples、长度单位为 samples。读取 `demod_morse.samplerate` 和 `float_samples`，不另写/复制 Morse 算法，不链接 `unixinput.c`、CLI main、FFmpeg 或其他 demodulator。
- `demod_morse.c` 的字符输出通过桥接库自有的 `_verbprintf` 接收。该 shim 只把 level 0 的完整 UTF-8 片段追加到有界文本缓冲；不重定向 stdout。固定默认全局码速/门限参数并限制单一活动 decoder。`MAX_VERBOSE_LEVEL=3` 与 patched CLI 对齐；统计级别不混入译文。
- Native 回调只复制 PCM 和更新峰值/RMS；环形队列固定上限，溢出计数显示在界面，不静默丢失。解码线程持有唯一 `demod_state`，文本缓冲上限 64 KiB；溢出时保留最新文本并显示截断标记。clear 只清待显示文本，不重置 decoder。
- stop 先停止并释放 AudioCapturer，再令 worker 消费完队列、输入 0.5 秒合成静音以按 multimon EOF 语义结束当前字符/词间隔、调用 deinit 并 join；最后 drain 收尾文本。合成尾静音可能令中断中的不完整字符被判成字符，这是原始解码结果，不做纠正。任何停止/释放失败都不得显示为正常 stopped。退后台触发相同 stop；中断后不自动重启。
- ArkTS 只声明/请求 `ohos.permission.MICROPHONE`，拒绝时不创建采集器；开始采集前完成权限确认。音源使用 `SOURCE_TYPE_MIC` 并在界面诊断状态中记录；系统音频处理对结果的影响尚未测量，不做静默 source fallback。
- N-API handle 有效期由 JS 对象持有并设置 finalizer；显式 stop 幂等，异步等待 AudioCapturer 释放与 worker join。`readData` N-API 不适用，因为本设计使用 Native AudioCapturer 回调。
- `third_party` 源码及 HAP 按 GPL-2.0-or-later 保留对应源文件、补丁来源、`COPYING` 和 cJSON MIT 声明。任何 HAP 对外分发前须确定完整对应源码交付方式和应用代码许可证；不实现应用内更新或发布服务。

## 明确不做

- 不接 `ReplySession`、AI、呼号、回复建议、QSO 状态、台站账本、任何发射或设备控制。
- 不加入第二套 CW 算法；不改变现有 multimon-ng 参数或默认桌面二进制。
- 不建设网络服务、云转写、用户账户、音频归档、安装更新平台或 App Store 发布流程。
- 不把模拟 PCM 对照描述为手机麦克风或真实空口质量验收。

## 设计审议记录

- 第一次审议：Codex/DSH 确认算法可通过 `demod_morse` 描述符嵌入且不需改 decoder interface；发现 `_verbprintf` 输出桥、输入采样校验、音频线程/停止生命周期、可复现 PCM、许可/源码锁定等设计缺口。结论为方向可行、设计未闭合；S1 未关闭前不实现。具体 R01-R13 检查及 SDK/源码证据记录于本轮审议结果。
- 本次修订关闭方向决议：采用 Native `OH_AudioCapturer` 回调与原生 worker，N-API 仅作异步控制/查询；严格格式门禁；0.5 秒合成静音收尾；源码投影带 SHA；测试音频只临时生成、不进入 HAP/设备。第二次设计复核已完成：DSH 确认修订设计在 host 范围无 S0/S1 阻塞，F1-F6 在设计上已闭合，Codex核对后进入实现。N-API 异步工作持有共享生命周期对象，finalizer 异步清理；采集释放失败保留回调用户数据供重试，不伪报 stopped。实现和限定验证见 [实施证据](../evidence/V00-02-F-Harmony手机端实时解码检验器.md)。真机/API/签名与麦克风仍未验证。
