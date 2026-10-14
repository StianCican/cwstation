# 版本 1/2 JSON 运行配置示例

`station.example.json` 是 daemon、`cwctl` 与 `cwmaint` 共用的版本 1 配置示例。配置
只覆盖已存在的运行参数，独立于程序文件与数据库；必须由 CLI 显式 `--config <file>`
指定，程序不会自动搜索任何默认路径。

`station.windows.example.json` 使用 version2，省略 endpoint 以选择按用户区分的默认
Windows 命名管道。它使用另一数据库路径，仍只连接 FakeKeyer，不打开电台 USB。

## 平台端点

version1 的 `socketPath` 保留 Unix 文件路径语义。version2 可使用显式端点；
`endpoint` 与 `socketPath` 不能同时配置，管道名不按配置目录解析：

```json
{"version":2,"endpoint":{"kind":"pipe","name":"cwstation-your-user"},"dbPath":"./station.sqlite"}
```

Linux 的 version2 对应 `{"kind":"unix","path":"./run/cw.sock"}`。两平台均支持省略
端点使用本平台默认值；最终选中的不兼容端点会拒绝，不能把 Unix 文件地址静默改成管道。
`--socket`/`CWSTATION_SOCKET` 在 Windows 接受完整本地地址 `\\.\pipe\name`，拒绝远程管道。
Linux旧配置不必改动。Windows现由创建时限定ACL的原生桥接服务，运行时核查
权限，客户端核查实际连接的服务身份。需预先构建dist/native/CwPipeBridge.exe，
详见P1-003-v2证据；P1-002的默认ACL结果保留为历史依据。

```bash
# 直接复制为实际配置后按需修改
cp examples/config/station.example.json /path/to/station.json

# daemon 用配置启动（相对路径以 station.json 所在目录解析）
npm run daemon -- --config /path/to/station.json

# cwctl 只取 socket，但同样完整校验配置；不要求 daemon 在运行
npm run cwctl -- --config /path/to/station.json status

# 维护命令也可用配置提供 dbPath 默认；--db 显式覆盖
npm run cwmaint -- --config /path/to/station.json inspect --bundle /path/to/bundle
```

## 字段

`version` 必填；其余字段可选，未出现的字段使用下一层优先级的默认值。

| 字段 | 类型 | 合法范围 | 含义 |
|---|---|---|---|
| `version` | 整数 | `1` 或 `2` | 配置版本；未来版本直接拒绝 |
| `socketPath` | 字符串 | 非空 | 本地 Unix socket 路径 |
| `endpoint` | 对象 | version2；严格字段 | Unix `kind/path` 或管道 `kind/name` |
| `dbPath` | 字符串 | 非空 | SQLite 数据库路径 |
| `txTimeoutMs` | 整数 | `[1, 600000]` | 单次发射超时 |
| `requestTimeoutMs` | 整数 | `[1, 600000]` | 单请求超时；实际值不低于 `txTimeoutMs + 2000` |
| `proposalTtlMs` | 整数 | `[1000, 600000]` | 提案默认有效期 |
| `approvalTtlMs` | 整数 | `[1000, 600000]` | 批准有效期上限 |
| `maxFrameBytes` | 整数 | `[256, 16777216]` | NDJSON 单帧最大字节数 |
| `fakeDurationMs` | 整数 | `[0, 600000]` | Fake 键控时长；允许 `0` |
| `shutdownTimeoutMs` | 整数 | `[1, 60000]` | 关闭时等待在途发射的上限 |
| `shutdownWatchdogMs` | 整数 | `[1, 600000]` | 关闭兜底看门狗 |

## 解析规则

- 优先级（低 → 高）：内置默认值 < 配置文件 < 已有 `CWSTATION_*` 环境变量 < CLI 路径旗标
  （`--socket`/`--db`）。数值参数没有 CLI 旗标，环境变量优先于配置。
- 配置文件内的相对路径以**配置文件所在目录**为基准解析为绝对路径。
- 严格拒绝：未知字段、未来版本、空路径、错误类型、非整数或越界数字；未知字段不会被忽略。
- 配置不承载故障注入变量（`CWSTATION_FAKE_FAULT`、`CWSTATION_FAKE_IGNORE_ABORT`、
  `CWSTATION_ENABLE_DEV_COMMANDS`）与频率、批准、blocked 状态，这些仍由环境变量或运行时接口管理。
- 本示例不含故障注入字段，可直接作为日常运行配置的基础。
