# AI-001 v1：只读台站建议示例

本目录演示 `cwai` 的最小只读闭环。`cwai` 不连接 daemon、不读数据库，也不调用
`approve`/`transmit`/`resolve`/shell/串口。输出仅供阅读，程序不解析或执行模型文本。
提示词要求不输出命令，但不能保证模型遵守；不要把建议当作真实设备验证结果。

## 命令

```bash
# 严格校验 version1 配置；不联网、不要求凭据
npm run cwai -- validate-config --config examples/assistant/config.mock.example.json

# disabled / mock：本地确定性输出，不联网
npm run cwai -- explain --config examples/assistant/config.disabled.example.json --state examples/assistant/state.example.json
npm run cwai -- explain --config examples/assistant/config.mock.example.json --state examples/assistant/state.example.json

# chat-completions：向配置端点 POST 状态快照（示例使用保留域名，不会真的可用）
npm run cwai -- explain --config examples/assistant/config.chat-completions.example.json --state examples/assistant/state.example.json
```

输出始终是单行 JSON。成功为 `{"ok":true,"method":...,"result":...}`，失败为
`{"ok":false,"code":...,"error":...}`。

## 配置 version1

配置只允许以下字段，出现未知字段直接拒绝：

| 字段 | 必填 | 说明 |
|---|---|---|
| `version` | 是 | 必须为 `1` |
| `provider` | 是 | `disabled` / `mock` / `chat-completions` |
| `endpoint` | chat-completions 必填 | 完整请求 URL（含路径） |
| `model` | chat-completions 必填 | 发送给后端的模型名 |
| `apiKeyEnv` | 否 | 只写环境变量名；联网时才读取其值 |
| `timeoutMs` | 否 | 100–120000，默认 30000；覆盖包括读取响应体在内的整个请求 |
| `maxOutputTokens` | 否 | 1–4096，默认 256，作为请求的 `max_tokens` |

端点规则：HTTPS 允许任意主机；HTTP 只允许 `localhost`/`127.0.0.1`/`[::1]`。
拒绝 URL 内嵌用户名/密码、query、fragment、非 http/https scheme，以及后端返回的
重定向。配置不保存凭据值，`validate-config` 不读取环境变量。

## 状态快照

`--state` 只接受固定字段，未知字段、非有限数值、布尔冒充数值、错误模式或过长
阻止原因都会被拒绝：

```json
{
  "frequencyHz": 14030000,
  "mode": "CW",
  "txBusy": false,
  "backendConnected": true,
  "generation": 3,
  "blockedReason": null
}
```

用户显式选择该文件，即表示同意只把这个最小状态发送给所配置后端；`cwai` 不会
上传其它文件、日志或环境变量，也不会写入任何文件。

## 边界

- 不保存密钥；凭据只从 `apiKeyEnv` 指定的环境变量在联网前读取。
- 不泄露后端错误 body、`Authorization`、环境凭据或原始 fetch 异常消息。
- 超时、HTTP 错误、重定向、非法 JSON、空输出或超大响应都以确定性错误码失败；
  不重试、不自动切换服务商。
- 断网或 AI 不可用时人工操作仍可使用；基础台站不依赖 AI。
- 本轮只有开发版 CLI 与模拟服务验收；没有成品界面、系统凭据存储或真实服务商验收。
