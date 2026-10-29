# Android CW 实时解码检验器（v1）

这是一个**只读接收**的 Android 检验器：麦克风 → 22050 Hz 单声道 S16LE →
`CwDecoder` → 同一份 patched `demod_morse` → 原始译文字符串。它用于在真实手机上
检查既有 CW 解码算法，不是产品发射端，也不接入 AI、网络、电台控制、录音或文件保存。

## 范围与硬限制

- 目标音调：**600 Hz**，编译期宏 `CW_TARGET_TONE_HZ=600`。算法只对 600 Hz 附近
  的 CW 音调做了前端选择；其他音调不在本版验收范围。
- 采样率固定 **22050 Hz / 单声道 / PCM16**；没有重采样、没有第二解码器、没有
  自动增益或文字纠错。
- 译文是算法原始输出，可能包含 `<SK>`、`<...>` 等原始标记；界面不修改文本。
- 只申请 `RECORD_AUDIO`。没有 `INTERNET`、存储、前台服务或后台服务。
- 不保存 PCM、不录音、不自动开始或自动重启。`onPause` 会请求停止；权限回调在
  应用不处于前台时不会启动采集。
- 音频源优先请求 `UNPROCESSED`；设备不支持或构建失败时显式显示 **MIC 回退**及
  原因。回读的源、采样率、声道和编码必须与请求一致，否则释放并显示实际错误。
  即使请求了 `UNPROCESSED`，也不能据此声称设备实际未做任何 DSP；界面只写源名，
  不写 “RAW”。
- 目标Android16/API36，最低Android8/API26；原生库启用16KB内存页对齐以适配较新ARM手机，未做所有品牌实机验证。无 x86_64 ABI；APK 只含 `arm64-v8a` 与 `armeabi-v7a`。

## 架构

```
MainActivity (Java, dark teal/cream UI)
  └─ control executor ── AudioRecord.stop / prepare (unblocks read)
  └─ single audio worker ── blocking AudioRecord.read
        └─ serial CwNative.nativeFeed → nativeDrain
              └─ apps/harmony-cw/native CwDecoder
                    └─ apps/harmony-cw/third_party/multimon-ng/demod_morse.c
```

JNI 只用不透明递增 handle；handle 通过互斥注册表解析，UI 的 clear 与
worker 的 feed/drain/finish 可并发（核心文本mutex保护），`nativeDestroy` 只删除一次。停止后由 worker 先
`AudioRecord.stop`，再输入 0.5 秒零样本 tail，调用 `finish`，最后 `destroy`。
AudioRecord的start/stop/release由每次采集的锁串行化，read在锁外；应用进程内采集占用标记跨Activity重建保留，只有确认释放才允许新采集。停止3秒未完成显示状态未知，厂商音频若持续阻塞须系统强行停止应用，不强制销毁仍在使用的对象。
UI 在主 looper 每 120 ms 批量取文本/电平，不 join 音频线程，也不在音频回调里调用
JNI。显示有界（约 64 KiB ASCII，UTF-16 安全丢弃旧文本）并显示截断提示；清屏只清
显示和 pending 文本，不重置解码时序/门限。

## 复用源码（不复制、不修改）

本工程通过 CMake **相对路径**直接编译以下既有文件，未复制到 `apps/android-cw`：

| 用途 | 路径 | SHA256 |
|---|---|---|
| 平台无关 C++ 桥 | `apps/harmony-cw/native/decoder_core.cpp` | `7c1dc8d5993570d07b88ef40273cc57158ad22ca98804ef1eb14783569d593a7` |
| 桥接口 | `apps/harmony-cw/native/decoder_core.h` | `6696d26ce0d6d66956a348cd4c2a3cdf36ec672152b9189a17ce1f44d01d4e00` |
| Morse 实现 | `apps/harmony-cw/third_party/multimon-ng/demod_morse.c` | `510957572eefcd3ec3d135345403aaff49e5b8c1c6dbf7d59014b82a44d198e5` |
| 描述符/宏 | `apps/harmony-cw/third_party/multimon-ng/multimon.h` | `8cf590abf25fb73e96d99e2fbe265000ae622c492264f40f300cdba5817e72fe` |

`apps/harmony-cw` 本身不由本工程修改。CMake 同时定义 `NO_X11`、
`MAX_VERBOSE_LEVEL=3`、`CW_TARGET_TONE_HZ=600`，只编译 `demod_morse.c`。

## 构建

前置：JDK 17、Android SDK platform 36、NDK `27.0.12077973`、CMake `3.22.1`、
Gradle 9.1.0 与 AGP 9.0.0 缓存。`build.sh` 默认使用以下本机路径，可用环境变量覆盖：

- `GRADLE_BIN`（默认 `/home/li0214/.gradle/wrapper/dists/gradle-9.1.0-bin/a7zz1zpvyl3jaouarz82m4yky/gradle-9.1.0/bin/gradle`）
- `JAVA_HOME_OVERRIDE`（默认 `/home/li0214/android-toolchain/jdk/usr/lib/jvm/java-17-openjdk-amd64`）
- `ANDROID_HOME_OVERRIDE` / `ANDROID_SDK_ROOT`（默认 `/home/li0214/android-toolchain/sdk`）

```bash
cd apps/android-cw
./build.sh
# 可选：
./build.sh :app:lintDebug
```

脚本使用已有Gradle、`--no-daemon`，不下载wrapper；依赖齐全后可传`--offline`，首次缺依赖时需要联网。额外Gradle参数从第二个参数起传入。

APK：`app/build/outputs/apk/debug/app-debug.apk`

安装（需要已连接的设备与 adb 授权；本仓库本轮未安装手机）：

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n org.cwstation.androidcw/.MainActivity
```

## 状态与限制

- **Device-unverified**：本版只完成构建/静态/打包检查，未在真实 Android 手机上
  安装、授权、采集或试听；真实声学准确率、权限拒绝、音频中断、长时稳定性均待验。
- 600 Hz 限制来自算法前端；没有为其他音调增加算法或运行时参数。
- 手机麦克风/扬声器距离、系统音频处理和现场噪声都会影响结果；本工具不提供录音
  回放或自动评分。
- 若编译需要新增解码算法、重采样或修改 Harmony 源码，应停止并报告，而不是在
  Android 工程内绕过。

## 许可证与对应源码

本工程以 **GPL-2.0-or-later** 分发；完整文本见 `LICENSE`，APK 内为
`assets/licenses/GPL-2.0.txt`。复用的 multimon-ng 投影为 GPL-2.0-or-later，
其 `COPYING`、来源锁定与补丁说明在
`apps/harmony-cw/third_party/multimon-ng/`。对应源码说明见 `NOTICE.md` 与
`app/src/main/assets/licenses/NOTICE.txt`。

构建不包含签名私钥、密码或任何账号凭据；本工程不提交、不推送。
