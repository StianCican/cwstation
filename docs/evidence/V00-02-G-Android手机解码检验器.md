# V00-02-G Android CW只读检验器 v1（2026-10-29）

状态：debug APK已构建/验签与专项JNI通过；最终lint0错误20警告，限定离线交付，Android实机未验。用户要求面向多种较新手机，不绑定某一机型。target/compile36（Android16）、min26（Android8），同APK内ARM64/ARM32，ELF LOAD均16KB对齐、APKzipalign16KB通过。不声称所有品牌/Android版本都已运行。

## 截图与当前目标

先完成用户Windows桌面CW解码8图手工计分：按文件名01-08，每两图上下滚动重叠合并，安静15/20WPM在前、干扰15/20在后。全135非空格字符，保留首尾错码，失败<...>作一字符。新版安静15/20 CER28.148%/6.667%（38/9编辑），干扰15/20为22.963%/20.741%（31/28编辑）；非同PCM A/B、音量距离等条件未独立锁定，不能宣称600Hz整体改善/已调好，也不能据此归因退步。干扰15失败序列点划数量不确定，按前次同一计分约定一个失败字符。源图未改，SHA/安全缩图/转写/score.json及screenshot-report.md在本轮保护目录。通知内容不进入应用或交付。

用户随后明确赶紧做Android，故当前唯一任务转为薄平台适配，不继续改时序/门限，不把鸿蒙可靠验收虚记完成。安卓也是只读算法检验器，不计入0.0发射产品。

## 实际调用链与边界

`MainActivity权限/前台门禁 → AudioRecord22050monoPCM16 → 单cw-audio worker → CwNative JNI → 原apps/harmony-cw/native/CwDecoder → 原third_party/demod_morse（600Hz）`。

CMake用相对路径直接编译既有C++桥和C实现，无算法复制/迁移/手机平台分叉；补丁唯一真源仍固定上游加patch，鸿蒙/桌面代码未改。新增一个用户要求的Android安装入口、一个应用进程，无网络/持久化音频/新协议/服务/AI/发射。只声明RECORD_AUDIO，APK不带音频/凭据。GPL及来源/对应源码说明打包。

平台适配：AudioManager公开属性探测UNPROCESSED，构造不支持时明确显示MIC回退原因；读回音源/采样率/声道/PCM16，不匹配释放报错，不重采样。参数是API应用侧格式，不证明底层HAL无DSP或无重采样。权限回调核对前台，onPause请求停止，不自动恢复。

单worker按序feed/drain/finish0.5秒合成尾静音/destroy；JNI用互斥handle注册表/shared_ptr保证UI clear与销毁并行不悬空，核心自己的text_mutex保护append/drain/clear/计数。UTF8按字节过JNI，Java显式UTF8解码。64KiB原核心文本、32768UTF16显示/待显示上限，完整代理对边界截断，显示截断提示；清屏不重置滤波/时序。UI只更新有新增文本时setText，120ms只轮询不等于每120ms总重绘32768字符。

停止由非UI control执行，AudioRecord start/stop/release共用每run锁、read锁外，避免stop与release穿插；原生decoder始终worker销毁。进程级采集slot跨Activity重建保留，确认释放才准新采集。3秒未收尾提示状态未知，若厂商stop/read阻塞不强销仍在使用的资源；需系统强行停止，不声称已释放。onDestroy停止请求后允许worker收尾，不UI join；系统若持续阻塞仍有可能保留资源，这是明确待真机验证的限制。

## 保护与交接

Git本地入口main基线79461d8且已有上一轮dirty。开工`.local-backups/android-cw-20261029-215910/dirty-before.patch`与before/保存状态文档及未跟踪benchmark，apps/android-cw创建前不存在；DSH负责新目录，Codex负责截图/状态，交接后Codex修正/验证。`android-dsh-handoff.tar`、`android-pre-final-review.tar`保留每阶段源码，不覆写原Harmony/账本。另观察到其他会话新增社团进度简报，保留未纳入本任务。

工具链：原WSL JDK17/SDK36/Gradle9.1/AGP9；缺NDK27/CMake3.22.1。SDK管理器直连/代理下载慢，停止精确PID，保留部分包后镜像下载，用官方SDK仓库XML规定大小/SHA1验证：NDK663957918字节/5e5cd517bdb98d7e0faf2c494a3041291e71bdcc，CMake22308647字节/fd0a48b4a758310df8c7aa51f59840ed48fe7ed8。安装到原WSL SDK目录，新目标之前仅有失败下载的.installer，原partial目录保留，未装C盘/未改系统代理或全局Gradle。记录sdk-install-verified.json。DSH沙箱Gradle缓存只读导致复制尝试，Codex停止该无必要复制，原缓存/凭据未动；主Agent原入口构建，临时复制保留在保护目录，不计产品能力。

## 验证与实证

- 首次离线构建缺Kotlin/AGP传递依赖失败；显式联网补齐后assembleDebug exit0（5m46s）。Java-only关闭内置Kotlin，不引入Kotlin运行时代码。后续源码/manifest/16KB对齐/生命周期修正均定向重建，最终`android-lifecycle-final-build.log` exit0/18s。
- `bash apps/android-cw/tests/run_jni_host_test.sh 新目录`编译实际生产JNI、原CwDecoder和同一600Hz C算法；仅Android log为host shim，运行JVM真实JNI：第二实例拒绝/null/越界count/正常feed/drain/finish幂等/EOF后拒绝/clear/stale handle/double destroy/再建全部通过，完整20WPM135字符非空格逐字一致。`jni-host.log`与jni-host/score.json保存，不是Android AudioRecord或UI运行。
- `apksigner verify --verbose` exit0、v2签名通过；`zipalign -c -P16 -v4` exit0。两ABI原生LOAD均16384，初查发现32位NDK默认4096后加显式linker16384并重建，最终通过；CMake同时启用ANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES。
- aapt确认package/target36/min26，唯一权限RECORD_AUDIO，无service/网络/存储；ARM64+v7a两lib。真实编译参数CW_TARGET_TONE_HZ=600、NO_X11、MAX_VERBOSE_LEVEL=3，编译输入为原Harmony两个文件（compile_commands/build.ninja记录）。源文件SHA未改变，既有算法/截断/CLI证据复用，不机械重跑。
- lint首次offline缺lint-gradle32失败；联网补依赖后实际检查发现MissingPermission与API27主题属性两错误。构造前再次checkSelfPermission并删除超出API26主题项，最终offline lint exit0/19s，0错误20警告，无屏蔽/baseline。最终修正APK重建exit0/22s，不影响共享算法或JNI，不重复无变化算法测试。界面XML/构建/insets静态核对，没模拟器或Android真机截图，不宣称视觉实机验收。
- LinuxADB当前无设备；未安装/启动/申请权限/采集Android实际音频。多品牌格式支持、音源DSP、后台/中断/旋转/驱动停止、真实准确性/延迟/长期稳定性均未验。

## DSH审议与Codex裁决

DSH v1实现后因沙箱缓存复制被主Agent停止（不计完整自测报告），v2只读100秒超时无最终报告；v3两文件审议exit0，对其初稿自审、Codex修改交叉审议。报告和上下文均保留本轮目录。

- DSH称core.clear/feed无mutex为S1，未读共享实现即推断。Codex核对decoder_core.cpp append/drain/clear/truncated全部text_mutex，native Session共享持有保证生命周期，不采纳该S1；不另加全解码锁阻塞UI。DSH称jni-host.log不存在与实际保存/主Agent执行不符，不采用其证据判断。
- 采纳stop/release跨线程顺序风险，改为每run锁串行化start/stop/release，read锁外；进程采集slot阻止旧资源未释放时新Activity开第二采集。无音频HAL真机故障注入，不将静态收敛称为硬件通过。
- 采纳主动取消误报红色error、无停止等待提示、待显示截断未计数、activeRun可见性和Android16insets问题，均局部修复；取消释放失败仍锁定，不自动清故障。
- “UNPROCESSED回读不符应回退MIC”不采纳为本轮缺陷：契约要求回读不符明确拒绝，不静默继续；只有构造失败才带可见原因回退。未授权添加重采样或新算法。
- 驱动长期不响应属于真实限制，3秒提示未知而非超时假成功；不强销仍使用对象。不承诺全品牌可靠停止，需Android现场补证。

| 标准 | 最终范围 |
|---|---|
| R01/R02/R13 | 用户要求的平台入口，直接复用同核心，未建第二算法真源，入口新增有用户需求依据 |
| R03 | 无数据/协议迁移；构建SDK/ABI/签名/对应源码明确 |
| R04 | 运行时权限/音频格式/参数/有界输出，JNI拒绝无效输入；厂商行为待验 |
| R05 | 发射不适用，Android无设备控制入口 |
| R06/R07/R09 | 静态收敛停止/生命周期；实际JNI host通过；Android音频/后台实机未验 |
| R08 | 包唯一麦克风权限，无网络/存储/服务，不录音 |
| R10 | 构建/JNI/签名/ABI/16KB有证据；lint0错误20警告通过；无Android真机验收 |
| R11/R12 | dirty/source阶段保护、明确源码/产物/手机证据边界，状态同步 |

## 交付

APK：`data/android-cw-20261029/cw-decoder-600hz.apk`，1171679字节，SHA256 `f20f388d787b12edfc8b59762002b52f0e7c4b5b1fa094f74fd3ee7bcf877115`。完整相关源码/第三方/构建说明ZIP同目录，SHA256 `1c2eed8df4aa60178d252332646f8eba2bf7187ca76b9becec0f3b391749c793`；manifest/中文使用说明齐备。debug本机测试签名，不上传商店；秘钥未进入源码或源码ZIP，不要求用户提供任何签名信息。

回退/保护使用上述本地目录及旧HAP，Android首次交付不存在旧APK需替换；如安装用户已有同包应用需adb -r且签名匹配，不卸载/清数据绕过。此次无提交/推送，无RF/账本操作。下一步Android手机安装并用同600Hz15/20WPM对照，未授权继续改时序/阈值。

## 最终交付核对（2026-10-29）

最后两项lint修正仅Java权限检查/主题样式，最终构建22s、lint19s均exit0；最终APK/源码ZIP已重建并重新验签/zipalign，manifest见delivery-final-manifest.json。0错误20警告主要为固定竖屏/Android16横竖屏建议、allowBackup新备份规则建议、背景overdraw、硬编码文本/对齐/i18n、Gradle选项弃用；本轮中文手机检验器、无持久化数据，按S3记录不屏蔽，不宣称零警告。大屏/横屏/布局视觉实测仍待设备。

最终源码ZIP再次逐文件与现有源码比对，无build/.gradle/.cxx/签名密钥，第三方原文/来源与匹配补丁齐备。旧交付包在delivery-before-lintfix保留，不覆盖未备份产物。所有共享解码四文件SHA与开始一致；Android新增入口实际接入共享源码，不是候选算法。状态入口MEMORY/ROADMAP/任务与本证据同步。
