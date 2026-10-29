# V00-02-G Android手机只读解码检验器 v1

2026-10-29，用户明确要求实施；状态：APK构建/JNI/签名/16KB专项通过，最终lint0错误20警告，限定离线交付，Android真机未验。独立手机检验器，不是0.0发射产品。

1. 用户可见缺口：已有鸿蒙手机检验器，Android没有安装入口；交付能构建/安装的debug APK，麦克风权限、开始/停止/电平/原文/清屏复制，真机结果未验须明确。
2. 主链/复用/责任：Android AudioRecord单worker→JNI→原apps/harmony-cw/native/CwDecoder→原third_party/demod_morse；两份共享源码按路径编译，唯一算法真源仍固定上游+patch。DSH负责新apps/android-cw，Codex不并写其文件，交接后复核；Codex负责状态/截图/任务证据。
3. 最小范围：原生Java Activity、AudioRecord22050monoPCM16、JNI生命周期及CMake编译600Hz；麦克风无处理支持时显示UNPROCESSED，不支持则明确显示MIC。读回格式，不静默重采样；后台停止、权限回调核对前台、串行feed/finish/delete、停止不在UI阻塞join，清屏不重置算法。沿用鸿蒙色系原文界面，不引新UI框架。明确不调算法/门限/码速，不录音/网络/AI/发射。
4. 数量：新增一个用户要求的Android应用入口与平台适配，仍一个应用进程；不新增服务/协议/音频存储格式，不复制解码器。仅RECORD_AUDIO权限。用户新平台需求无法由Harmony HAP直接安装满足；原地改Harmony不能交付APK，故采用薄平台适配，比另写算法成本低且可同核心对照。
5. 替换：不替换鸿蒙/桌面，不迁移用户数据、不删除旧HAP/账本；APK安装更新保留签名/数据，未连接Android设备不自动安装。回退保留源码及原产物。
6. 验收/基线：.git-local基线79461d8含已有dirty，修改前.local-backups/android-cw-20261029-215910/dirty-before.patch与before/保存；apps/android-cw创建前不存在。复用既有核心离线证据，不重跑无变化算法；编译、lint/包权限/ABI/600宏与直接复用路径、JNI/采集生命周期静态审查及必要针对测试。真机采集/音频处理/停止/准确性没有设备即未验证。工具链已有Gradle9.1/AGP9/JDK/SDK36，缺NDK/CMake装WSL原工具链，安装日志保留。DSH自查与Codex复核后限定交付。

设计检查：AudioRecord阻塞读由非UI停止控制解除，worker唯一持有decoder；避免stop/read/delete竞态和迟到UI。启动必须前台/权限已批，onPause同原停止语义，不自动重启。输出/队列有界，UTF-8正确处理。格式不支持报错释放，不另造重采样器；需改变范围先带证据反馈。

实现/审议与交付见[证据](../evidence/V00-02-G-Android手机解码检验器.md)，当前APK及对应源码在data/android-cw-20261029。

最终补充：用户多品牌较新系统要求已落实target36/min26/ARM双ABI/16KB，最后构建exit0/22s、lintexit0/19s。两项lint错误（构造前权限与API27主题项）已实修，无屏蔽；警告及真机边界详见证据。
