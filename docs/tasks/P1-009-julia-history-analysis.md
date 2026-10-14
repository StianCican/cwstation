# P1-009：Julia/MWORKS 历史离线分析接口

状态：已实现并通过 Windows MWORKS/Julia 实际运行验证。

## 目标

把 `rig-statusd` 的只读 JSONL 历史作为 Julia/MWORKS 的离线输入，生成可复现的统计结果。
Julia 只读文件，不打开串口、IPC、数据库或音频设备，不进入发射路径。

## 交付

- `julia/RigStatusHistory.jl`：校验 schema-1 历史并输出分析 JSON。
- `julia/analyze_history.jl`：MWORKS/Julia 命令行入口。
- 结果包含输入路径/大小/SHA-256、记录/快照数量、事件/状态/模式计数、频率范围/均值、
  频率和模式变化次数、最大快照间隔、Julia/JSON3 版本和 `transmits:false`。
- 输入限制：8MiB、单行64KiB、最多100000条；结果文件独占创建并通过同目录临时文件发布。

## 使用

```bat
julia-ty.bat D:\AI\projects\cwstation\julia\analyze_history.jl ^
  D:\AI\projects\cwstation\logs\rig-status-history.jsonl ^
  D:\AI\projects\cwstation\logs\rig-status-analysis.json
```

分析接口只处理历史快照；图表、频谱和更复杂的信号算法另立任务，不放入电台控制路径。
