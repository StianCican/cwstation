# multimon-ng CW 门限修正补丁

本目录保存 CW Station 当前使用的外部解码器补丁，供源码复现。沿用现有 `runReceive → 一个 multimon-ng` 主链，无第二解码器或新产品入口。

- 上游：https://github.com/EliasOenal/multimon-ng
- 精确基线：`b5f7d71c5e9b5a76093ba55c515968dc40f92804`，该提交 CMake 声明版本 1.6.2。
- 补丁：`multimon-threshold-hysteresis.patch`，修改 `demod_morse.c`、`multimon.h`。
- 补丁 SHA256：`e665984dd6d7e226bdfa9d64793ee8549a2fd8a407ee253683a2f8edfa6160dd`。
- 内容：噪声底跟踪、40%/28% 双门限迟滞、较快峰值衰减和最低信号裕量；保留固定门限模式原语义。
- 可选目标音调前端：编译期宏 `CW_TARGET_TONE_HZ`，默认 `0`（不开滤波，保持旧行为）；非零值在整流/包络前插入一个 0 dB 峰值增益、Q=5 的 RBJ 带通双二阶，状态随 `demod_state` 初始化。手机工程明确定义 `600`；无运行时参数。
- 许可证：上游整体 GPL-2.0-or-later，原文件声明保留；本补丁按 GPL-2.0-or-later 分发。许可证全文见本目录 `COPYING`。

## Linux/WSL 源码构建

需已安装 Git、CMake（至少3.15）、C/C++编译器和构建工具。在新的独立目录操作，先把 `PATCH` 改为本仓库补丁的绝对路径：

```bash
PATCH=/absolute/path/to/cwstation/patches/multimon-ng/multimon-threshold-hysteresis.patch
git clone https://github.com/EliasOenal/multimon-ng.git multimon-ng-cwstation
cd multimon-ng-cwstation
git checkout --detach b5f7d71c5e9b5a76093ba55c515968dc40f92804
git apply --check "$PATCH"
git apply "$PATCH"
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DX11_SUPPORT=OFF -DPULSE_AUDIO_SUPPORT=OFF -DSDL3_SCOPE=OFF -DBUILD_TESTING=ON
cmake --build build --parallel 2
ctest --test-dir build --output-on-failure
```

构建后在本项目既有 GUI 解码器选择框或 CLI `receive --decoder` 中显式选择 `build/multimon-ng`。保持既有 `-q -c -a MORSE_CW -t raw -` 参数和 22050 Hz 单声道 s16le PCM；FFmpeg 仍由本项目采集，不依赖解码器内置 PulseAudio。不会自动替换本机解码器。Windows原生构建未验收。

## 证据与限制

2026-10-27 本机原构建通过，CTest 5/5，既有 clean/noisy/CQ TEST 样本完整解出 `CQ TEST`。现场样本仍有错码，后续一次现场接收无文本；真实空口可靠抄收尚未验收。详见 [质量诊断](../../docs/evidence/V00-02-E-CW解码质量诊断.md)。上传补丁不代表解码质量问题已解决，不新增发射授权。现场录音、运行账本和二进制未随本补丁上传。

2026-10-28 补传验证：在隔离目录从上述精确上游提交应用补丁，两个文件与本机源码逐字节一致；按本说明完成 Release 构建，CTest 5/5。该内置测试集主要覆盖 FLEX，不能替代 CW 现场质量验收。本轮未重跑设备或现场收音。
