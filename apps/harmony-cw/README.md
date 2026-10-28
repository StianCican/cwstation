# Harmony CW 实时解码检验器

手机麦克风 → Native OH_AudioCapturer → 有界 PCM 队列 → 单一 worker → 同一份 patched multimon-ng → 原始译文。无 AI、网络、发射或音频持久化。应用本身 GPL-2.0-or-later；第三方声明见 third_party 与 HAP rawfile/licenses。

## 构建

本机 DevEco CLT 26.0.0.851 / SDK 26.0.0.105 / ARM64：

```bash
bash apps/harmony-cw/build.sh
```

其他环境设置 `HARMONY_CLT_HOME` 指向已有的 command-line-tools。本工程不自动安装 SDK。当前构建为未签名 debug HAP，不等于可直接安装；设备签名、授权与安装必须在连接目标手机后验证。不要把私钥、证书、签名密码或 provisioning profile 提交到仓库。

主机解码对照按 [native/README.md](native/README.md)；依赖项目现有 dist/packages/signal 来临时合成标准 PCM。生成音频不进入 HAP。

## 操作与限制

前台点击开始并授权麦克风，显示输入电平和原始译文；停止会释放采集、排空队列并补 0.5 秒零样本完成原解码器收尾。清屏不重置解码时序；可复制文本。退后台或音频中断后停止，不自动恢复。采集丢样、文本截断与错误会显示。

严格要求实际 22050 Hz / mono / S16LE / RAW / MIC，设备不支持时释放报错，不静默改变格式。系统 MIC 音频处理仍可能影响解码效果。0.5 秒合成尾静音可能让被打断的不完整字符也形成输出，译文原样保留。

目标手机由用户报告为 Mate X5 / “鸿蒙7”；实际系统/API、签名安装、权限、采样格式、后台释放与实时 CW 质量均待真机验收。完整状态见项目 MEMORY.md 顶部和 docs/evidence/V00-02-F-Harmony手机端实时解码检验器.md。

## 源码与许可

`third_party/multimon-ng` 是精确上游提交加既有补丁的源码投影，SHA 记录于 PROVENANCE.md，禁止手改。若修改解码算法，应先修改项目唯一补丁、重新投影并重新做 bridge/CLI 同字节对照，避免手机/桌面分叉。

本目录全部新应用代码按 GPL-2.0-or-later 提供，完整许可见 LICENSE。对外分发 HAP 时应同时提供与该 HAP 对应的完整本目录源码、项目 patches/multimon-ng、构建说明及所需接口/脚本（当前测试向量生成还依赖根项目 signal 代码），并保留上游声明；当前不做上架或公开分发。
