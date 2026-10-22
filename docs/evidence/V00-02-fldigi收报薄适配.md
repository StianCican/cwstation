# V00-02 fldigi 收报薄适配：实施与专项证据

2026-10-20。当前状态：适配/CLI已实现，Codex复核修正后build、专项15/15通过，真实fldigi4.2.10空读取exit0；WAV解码文本未验收，V00-02仍进行中。下文DSH原始交付描述保留其阶段范围，末节记录Codex接续结果并取代“真实fldigi未验证”的旧状态。未接电台，无射频或整体0.0验收结论。

## 交付范围

用户可见增量：现有 `cwrig` 新增 `receive` 子命令，从本机 fldigi XML-RPC 读取解码文本，以 JSONL 显示状态和非空文本块。

```bash
node dist/apps/cwrig.js receive --endpoint http://127.0.0.1:<port>/RPC2 \
  [--interval-ms 250..60000] [--timeout-ms 1..120000] [--once]
```

- 未新增可执行入口：仍是 `apps/cwrig.ts` 的 `receive` 子命令；`apps/rig-receive.ts` 只做参数、显示和终止。
- 未新增设备持有者、常驻服务、自定义 IPC/协议或存储格式；fldigi 仍是用户自行启动的外部进程。
- 未调用、未修改 `CwTrialSession` 或发报链；未打开串口、未操作 fldigi、未启动电台。
- `packages/receive` 暴露 `FldigiReceiveClient`、`FldigiReceiveSession`、`RxChunk`，GUI 以后可直接复用，不依赖 CLI/stdout 解析。

## 实现要点

- 固定只读方法：请求体只包含 `rx.get_data`；没有公开任意方法调用，也没有 `main.*`、`text.*`、`rig.*`、PTT 或清空文本入口。未实现可选的 `fldigi.version` 握手。
- 端点仅允许显式 `http://127.0.0.1:<port>/RPC2` 或 `http://[::1]:<port>/RPC2`；拒绝域名、非回环地址、https、凭据、query、fragment、非 `/RPC2` 路径、缺省端口和首尾空白。`fetch` 使用 `redirect: "error"`，不自动重试/重连。
- 统一请求超时覆盖连接与 body；响应字节上限默认 1 MiB（客户端可配，最大 16 MiB）；超过即失败。
- XML 使用 `fast-xml-parser` 精确版本 `5.11.2`（新增唯一直接依赖，lock 仅新增），先拒绝 DTD/ENTITY 声明，再用 `XMLValidator` 校验良构；只接受单个 `methodResponse`、单个 `param`、单个 `<base64>`。XML fault、非法结构、非 base64、非法 UTF-8 均显式失败；HTTP/fault 错误只报告状态码/faultCode，不回显服务器原文。
- 每个客户端同一时间最多一项在途读取，并发调用返回 `busy`；空 base64 解码为空字符串，表示本次无新字符，不产生 chunk、不记成功。
- 会话 `sessionId` 每次运行生成，`seq` 仅在本会话内递增；`receivedAt` 是解码完成后的本机时间。空读取不消耗序号。
- `SIGINT`/`SIGTERM` 中止轮询和在途 fetch；取消后即使响应迟到也不会转成文本块。退出不关闭用户的 fldigi。
- 退出码：usage 2、运行失败 1、正常停止或 `--once` 完成 0。

## 文件

新增：

- `packages/receive/src/fldigi.ts`
- `packages/receive/src/index.ts`
- `apps/rig-receive.ts`
- `tests/fldigi-receive.test.ts`
- `docs/evidence/V00-02-fldigi收报薄适配.md`（本文件）

修改：

- `apps/cwrig.ts`（usage、动态导入 `receive`、独立运行收尾）
- `package.json` / `package-lock.json`（仅新增 `fast-xml-parser@5.11.2` 及其传递依赖）
- `README.md`（本子命令的用法、边界、退出码）

未修改：`MEMORY.md`、`ROADMAP.md`、`AGENTS.md`、任务单、发报链、既有证据、用户配置。基线中已有的其他 dirty 文件不属于本轮改动。

保护：`.local-backups/20261020-204508-fldigi-rx/` 原有 dirty 补丁、未跟踪文档、目标副本、dist/logs/node_modules 归档和 headless 非凭据配置保持不动；本轮只向该目录新增 build/测试/冒烟日志。未安装系统工具、未启动 fldigi 或电台、未使用子 agent、未跑全仓或设备套件。

## 命令与结果

所有输出保存在 `.local-backups/20261020-204508-fldigi-rx/`。

1. 新增依赖（精确版本）：

```bash
npm install fast-xml-parser@5.11.2 --save-exact --no-audit --no-fund --ignore-scripts
# added 8 packages, removed 1 package; package.json/lock 只新增直接依赖与传递依赖
```

2. build：

```bash
npm run build
```

- 第一次：exit 2，`TS2353`：`ignoreComments` 不是 `fast-xml-parser` v5 的 `X2jOptions` 字段。失败记录：`build-first-failure.log`（按终端输出转录，`build.log` 已被最终通过运行覆盖）。
- 修正：移除该选项（注释默认不进入解析结果）。
- 第二次：exit 0。
- 首轮专项：exit 1，`XMLParser` 对未闭合 XML 不报错（`<methodResponse><params>` 解析成 `{params:""}`），专项因此返回 `invalid_result` 而非 `invalid_xml`。失败记录：`fldigi-receive-test-first-failure.log`（13 pass / 1 fail，按 TAP 输出转录；`fldigi-receive-test.log` 已被最终通过运行覆盖）。
- 修正：解析前增加 `XMLValidator.validate`。
- 最终 build：exit 0。日志：`build.log`。

3. 新增专项（只跑本文件，不跑全仓/设备套件）：

```bash
node --import tsx --test --test-reporter=tap --test-timeout=60000 tests/fldigi-receive.test.ts
```

最终：12 个顶层用例、14 个测试（含 2 个子用例），14 passed、0 failed、0 skipped，exit 0；约 2.1 s。日志：`fldigi-receive-test-final.log`。

覆盖：端点允许/拒绝矩阵；实际 XML-RPC 请求方法/路径/顺序；并发 busy；空文本与序号；fault 不回显原文；坏 XML/DTD/非 base64/多 param/坏根/非法 UTF-8；超限 body；超时含 body；断连一次失败不自动重试；取消丢弃迟到响应；CLI `--once` 正常/空结果；循环取消不再读；运行失败退出 1 与 usage 退出 2。

4. 最终 build 的入口冒烟（本机脚本化 HTTP 服务，不是 fldigi）：

```bash
node dist/apps/cwrig.js receive --endpoint http://127.0.0.1:<ephemeral>/RPC2 --once
```

结果：exit 0；服务端只收到 1 次 `POST /RPC2`，body 含 `rx.get_data`；stdout 为 started 状态、1 个 `type:"chunk"`（`text":"CQ TEST DE BD7XXX"`，`seq:1`）和 read 状态。日志：`cli-smoke.log`。

## 自查（设计定稿 + 第一条链路）

- 主链位置：现有 `cwrig` 入口 → 新增 `receive` 分支 → `runReceive` → `FldigiReceiveSession` → `FldigiReceiveClient` → 固定 `rx.get_data` → 本机 fldigi。发报主链未动。
- 范围：只交付“看到实际解码文本”的单一闭环；没有把收报接入 AI、GUI、自动通联或发送许可。
- 入口/进程/协议/记录格式：可执行入口数量不变；无新增服务进程；只新增对既有 fldigi XML-RPC 的只读客户端；无自定义持久化格式。
- 候选是否接入：未接入 RemoteFake、独立读取仲裁、N1MM/DXLog、GUI 或其他候选。
- 历史文档状态：未改 MEMORY/ROADMAP/任务单；本证据只记录本轮实现与验证，不替代 Codex 复核或用户验收。
- 依赖边界：明确新增一个直接库 `fast-xml-parser@5.11.2` 和外部 fldigi/XML-RPC 依赖，不宣称零增量。

## 未验证项与限制

- **真实 fldigi 未验证**：本机未启动 fldigi；未确认实际版本、XML-RPC bind/路径是否就是 `/RPC2`、`rx.get_data` 的实际 base64 形态、UTF-8 行为及 fault 形态。Codex 用真实 fldigi + 既有 WAV 的样本验证尚未完成；Fake/脚本化 HTTP 不能冒充该样本。
- **WAV/音频链路未验证**：WAV 如何进入 fldigi、解码延迟、文本切分与空口准确率均未测；P0-004 样本本身不是本适配的验收证据。
- **未接电台**：无射频、信噪比、实际 QSO 或 IC-7300 音频路由结论。
- **未做跨平台/性能矩阵**：只在当前 Linux/Node 24 环境运行；Windows 原生、并发实例、长时间轮询、内存/CPU、fldigi 重启后的会话恢复均未覆盖。
- **单消费者限制**：只在进程内保证一个客户端一项在途读取；没有跨进程锁，两个应用同时使用同一 fldigi 端点仍可能互相排空。
- **分发/license 未定**：未捆绑 fldigi，未处理 GPLv3 分发边界；本切片只假设用户自装。
- **物理语义**：`seq`/`receivedAt` 仅表示本机接收顺序和时间，不是空口准确性、完成或可发送授权证明。

## 交接

DSH 已完成任务限定的实现、自测和证据，交回修改权。Codex 下一步：不重复全套用例，使用真实 fldigi + 一个既有 P0-004 WAV 验证解码文本进入同一 CLI；如实记录实际 fldigi 版本、启动参数、WAV 输入方式、stdout 文本与可见延迟。若环境阻塞，标记“适配离线通过/真实样本未完成”，不得用脚本化 HTTP 或 Fake 冒充真实样本。复核通过后再由 Codex 更新 MEMORY/ROADMAP 状态。

## Codex接续复核与实际环境（2026-10-20）

保护：HEAD `2fcfd33`及原保护目录继续有效；新增`codex-review-before/`保存DSH交付后、Codex修改前的源码/测试/证据/README/状态/任务副本。未覆盖已有dirty变更。

真实软件为官方Ubuntu包`fldigi 4.2.10-1`，用户态解压在`/home/li0214/DSH/tools/fldigi-4.2.10/`，研究源码4.2.13不等于实际运行版本。使用独立`runtime/home`和`runtime/config`，未系统安装、未修改用户原有fldigi配置。用户已确认可见窗口；可见窗口不等于音频/解码通过。

实测启动参数`--xmlrpc-server-address 127.0.0.1 --xmlrpc-server-port 17362`仍监听`0.0.0.0:17362`，因此停止首次实例，在`unshare -Urn`中仅启用lo运行；方法白名单为`fldigi.version|rx.get_data|text.get_rx|text.get_rx_length`，不开放TX/rig/PTT。通过`nsenter -t <pid> -U -n --preserve-credentials`运行同一编译CLI。namespace只是测试隔离，不是新增产品服务/默认部署方案。真实监听必须核对，不能将客户端回环限制误认为服务端绑定保证。

首次真实CLI读取exit1：`invalid_result / fldigi XML-RPC param is malformed`。实际合法响应含`<param>\r\n\t<value>...`；`trimValues:false`使缩进进入`#text`，与严格结构检查冲突。失败按终端输出转录于本段，无原始失败日志。Codex仅改为`trimValues:true`，保留严格结构/DTD/base64检查；新增真实响应形态的空/非空回归，确认解码后前后空格保留。并修正“上次成功读取以来”的误导注释：排空请求的响应丢失可能已经消耗文本，不能假定可重读。

由于真实兼容修正影响全部XML响应，定向重跑本文件并重建产物；未跑全仓/设备/Windows矩阵：

```bash
npm run build
node --import tsx --test tests/fldigi-receive.test.ts
```

均exit0；专项15/15、0失败/跳过。日志`codex-build.log`、`codex-tests.log`。真实CLI `--once` exit0，输出started、empty（chunks=0）而非虚构chunk，见`real-fldigi-once.jsonl`；真实轮询至SIGTERM正常退出0，见`real-fldigi-cli.jsonl`。这证明真实XML-RPC/空缓冲接通，**不证明实际解码文本通过**。

WAV验收未完成：准备复用`examples/signal/cq-test-out/clean.wav`（CQ TEST、20WPM、600Hz、8000Hz采样）。在CW模式进入File → Audio → Playback，但WSLg文件框交互未确认成功载入文件，也未确认600Hz调谐生效；始终无chunk。环境同时报告默认ALSA声卡不可用、GTK符号错误，因果尚未查明，不能直接归因于解码器或WAV。未尝试新造解码器/注入假文本来替代验收。界面JPEG与日志保留在上述外部工具目录`runtime/`。

清理：接收CLI SIGTERM退出0；仅停止本轮拥有的隔离fldigi（SIGTERM，宿主exit143），未调用远端关闭/TX方法，保留配置与现场。MEMORY、ROADMAP和任务已同步为“适配已实现、真实空读取通过、WAV待验收”。下一步仅处理该实例的文件回放/音频输入并取得同一CLI文本；15/15和历史设备证据直接沿用，不重复普查或验证。

整体收敛：现有cwrig入口新增receive分支，下层供未来GUI直接复用；外部fldigi/XML-RPC依赖有增量，无新设备链/自定义服务/存储真源。发送源码与测试哈希与任务开始时一致。完整自动QSO、AI回复接通、GUI和真实音频/设备仍未交付，不因本项测试通过而升级范围。
