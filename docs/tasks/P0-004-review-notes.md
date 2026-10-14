# P0-004 Codex 初审候选（实现中）

最终交付前检查；Codex 尚未修改 DSH 负责的 signal/Julia 代码。

1. verify 中固定 `minSegmentPeak >=0.05` 会误拒绝合法低 SNR：clean/noisy 共同归一化时 -20dB 噪声占优，clean 峰值自然更小。需用 normalizationGain/量化分辨率的合理条件或直接校验期望载波包络，测试 -20、0、60dB。
2. 16bit PCM 高 SNR 量化影响显著：实测噪声不能用未量化的理想值作绝对承诺。verify 与结果应说明/处理量化误差，并覆盖60dB及短报文。
3. WAV 解析必须校验 RIFF 声明长度、byteRate/blockAlign 和分块边界/填充，拒绝重复 fmt/data、截断或多余尾字节；校验 hash 不能代替格式检查（攻击者可以更新 hash）。
4. verify 应检查 normalizationGain、peakClean/peakNoisy、noiseVariance 等必需字段的类型、范围与音频一致性；目前部分字段未读取。需测试篡改为字符串/负数/缺失。
5. 仅检查包络区间存在能量不能验证载波频率，错误 tone 仍可通过。可重建确定性 clean 信号并按 PCM16 量化误差校验（无需自己实现噪声器），或使用可信频率估计并测试错tone音频；以实际 Julia 合成公式为准。
6. Julia 必须在输入过量分配前限制 Morse 总元素数和报文时长；确保规范文本与原始文本一致。Morse文字一致性由 TS 库重编码验证，不能声称 Julia 独立验证了它未检查的内容。
7. Codex 已修正 P0-003：schema 当前为4，故障有独立持久字段，非 Fake 无法调用离线解除；README 最终应同步。不要修改 core/journal/daemon，修改权仍属 Codex。
8. Julia 共同归一化应使用 max(peakClean, peakNoisy) 作为基准，不能只用 noisy 峰值；短报文高 SNR 时噪声可能使 noisy 峰值略低，导致 clean 超过0.95。
9. 若 verify 重建包络，注意 Julia `round(Int, rampMs*sampleRate/1000)` 默认 ties-to-even，而 JS Math.round 是半值向上；例如5ms/8500Hz=42.5。统一 ramp 样本舍入约定并覆盖该边界。
10. 示例已有 task/output 时文档应先提供 verify 现成产物；重新生成需用新的任务/输出路径，不能把会报 EEXIST 的命令写成无需说明的快速开始。

## Codex 独立复现

用 CLI prepare 生成 `docs/evidence/P0-004-low-snr.task.json`，snr=-20、CQ TEST、seed42；Syslab MCP 实际运行当前 Julia 模块生成 `docs/evidence/P0-004-low-snr-output/`。样本26400，实测SNR=-20.027678316372626，clean峰值0.04724116380452269。当前 verify 拒绝为 `audio_segment_silent`，直接确认第1项。这些是 Codex 审查证据，不删除；修正后应能够验过。

Codex 已另建 `tests/signal-review.test.ts`，针对真实低 SNR、必需元数据类型、RIFF/byteRate/blockAlign 写了独立回归用例；该文件由 Codex 维护，DSH 应修正生产代码而非改该用例。
