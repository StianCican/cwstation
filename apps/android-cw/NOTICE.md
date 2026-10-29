# 对应源码与第三方说明

本 APK（`org.cwstation.androidcw`）包含 GPL-2.0-or-later 代码。完整许可证见
`LICENSE`（APK 内 `assets/licenses/GPL-2.0.txt`）。

## 对应源码位置

- Android 平台入口、JNI、资源、构建脚本：`apps/android-cw/`（本目录）。
- 复用的平台无关解码桥：`apps/harmony-cw/native/decoder_core.cpp` 与
  `decoder_core.h`。
- 复用的 multimon-ng 投影：`apps/harmony-cw/third_party/multimon-ng/`
  （`demod_morse.c`、`multimon.h`、`cJSON.h`、`COPYING`、`PROVENANCE.md`）。
- 上游 multimon-ng：<https://github.com/EliasOenal/multimon-ng>，锁定提交
  `b5f7d71c5e9b5a76093ba55c515968dc40f92804`。
- 补丁：`patches/multimon-ng/multimon-threshold-hysteresis.patch`。

这些文件通过 CMake 相对源路径编译进 `libcwdecoder_jni.so`，没有在
`apps/android-cw` 内复制算法源码。获取完整对应源码请使用本仓库同一提交/工作树；
构建方法见 `README.md`，依赖为 JDK 17、SDK 36、NDK 27.0.12077973、CMake 3.22.1、
Gradle 9.1.0、AGP 9.0.0。对应源码不包含签名私钥或凭据。

## 来源摘要

| 文件 | SHA256 |
|---|---|
| `apps/harmony-cw/native/decoder_core.cpp` | `7c1dc8d5993570d07b88ef40273cc57158ad22ca98804ef1eb14783569d593a7` |
| `apps/harmony-cw/native/decoder_core.h` | `6696d26ce0d6d66956a348cd4c2a3cdf36ec672152b9189a17ce1f44d01d4e00` |
| `apps/harmony-cw/third_party/multimon-ng/demod_morse.c` | `510957572eefcd3ec3d135345403aaff49e5b8c1c6dbf7d59014b82a44d198e5` |
| `apps/harmony-cw/third_party/multimon-ng/multimon.h` | `8cf590abf25fb73e96d99e2fbe265000ae622c492264f40f300cdba5817e72fe` |

`demod_morse.c` 原作者将其置于 public domain；本投影按 multimon-ng 整体以
GPL-2.0-or-later 分发。cJSON 为 MIT，见
`apps/harmony-cw/third_party/multimon-ng/LICENSES/cJSON-MIT.txt`；本工程不编译
cJSON 实现。
