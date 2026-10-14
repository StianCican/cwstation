# examples/signal — CW 合成任务示例

本目录提供 P0-004 的简短、可复现示例：TS 侧生成版本化任务 JSON，Julia/MWORKS 侧
合成 clean/noisy WAV 与 result.json，TS 侧再校验两者。

- `cq-test.task.json`：`CQ TEST`、20 WPM、600 Hz、8 kHz、SNR 10 dB、seed 42 的任务。
- `cq-test-out/`：由上述任务在 MWORKS Julia 环境实际生成：
  `clean.wav`、`noisy.wav`、`result.json`（单声道 16bit PCM）。

## 环境（不依赖全局 Julia PATH）

本项目只使用已确认的 MWORKS/Syslab 环境，不安装新的 Julia 包：

- MWORKS Syslab 26.3.0.7476（安装标识 Syslab 2026a）
- Julia 1.10.10，launcher `C:\Users\Public\TongYuan\julia-1.10.10\bin\julia-ty.bat`
- 活动环境 `C:\Users\Public\TongYuan\.julia\environments\v1.10`
- 已安装并实际使用：`TyCommunication 1.0.7`、`JSON3 1.14.3`、`WAV 1.2.0`

`julia-ty.bat` 自行设置 depot 与 PATH，因此不需要把 Julia 加入系统 PATH，也不要用
系统里可能存在的其他 Julia。**共享环境的可用性不代表所有工具箱都已验证**；本示例只
声明上表列出的包。

## 从 WSL 运行（本仓库位于 `/mnt/d/...`）

Windows Julia 不认识 `/mnt/d/...` 路径，需要 `wslpath -w` 转换；launcher 通过
`cmd.exe` 调用。**`prepare` 与 `run_task` 都拒绝覆盖已有数据**；先验证已附产物，
重新生成则使用新的任务和输出路径（重复运行需再换新路径）：

```bash
cd /mnt/d/AI/projects/cwstation

# 0) 直接验证现成产物
npm run cwwave -- verify --task examples/signal/cq-test.task.json --result examples/signal/cq-test-out/result.json

# 1) TS 生成任务（独占写入，不会覆盖已有文件）
npm run cwwave -- prepare --text "CQ TEST" --out examples/signal/demo.task.json --snr 10

# 2) 转换路径并调用 Windows Julia 合成
TASK_WIN=$(wslpath -w "$PWD/examples/signal/demo.task.json")
OUT_WIN=$(wslpath -w "$PWD/examples/signal/demo-out")
cmd.exe /c "C:\\Users\\Public\\TongYuan\\julia-1.10.10\\bin\\julia-ty.bat D:\\AI\\projects\\cwstation\\julia\\run_task.jl $TASK_WIN $OUT_WIN"

# 3) TS 校验音频与元数据（SHA256、WAV 格式、关键段落、实测 SNR）
npm run cwwave -- verify --task examples/signal/demo.task.json --result examples/signal/demo-out/result.json
```

`run_task` 要求输出目录不存在、父目录存在；失败只清理本次新建的临时目录。

## 在 Windows / Syslab 中直接调用

在 Syslab 或 Julia REPL 中 include 模块后调用：

```julia
include("D:/AI/projects/cwstation/julia/CWSignal.jl")
result = CWSignal.run_task(
    "D:/AI/projects/cwstation/examples/signal/demo.task.json",
    "D:/AI/projects/cwstation/examples/signal/demo-syslab-out",
)
```

或直接运行入口脚本：

```bat
C:\Users\Public\TongYuan\julia-1.10.10\bin\julia-ty.bat ^
  D:\AI\projects\cwstation\julia\run_task.jl ^
  D:\AI\projects\cwstation\examples\signal\demo.task.json ^
  D:\AI\projects\cwstation\examples\signal\demo-cli-out
```

## Julia 自测

```bat
C:\Users\Public\TongYuan\julia-1.10.10\bin\julia-ty.bat D:\AI\projects\cwstation\julia\test\runtests.jl
```

从 WSL：

```bash
cmd.exe /c 'C:\Users\Public\TongYuan\julia-1.10.10\bin\julia-ty.bat D:\AI\projects\cwstation\julia\test\runtests.jl'
```

## seed 复现范围

`seed` 通过 `TyCommunication.awgn(signal, snr, "measured", seed)` 固定 `MT19937ar`
随机流。已记录环境下，相同任务文件可逐字节复现 clean/noisy WAV 与逐样本噪声。
**跨 Julia / TyCommunication 版本不保证逐样本一致**；复现以 `result.json` 中记录的
`environment` 版本为准。
