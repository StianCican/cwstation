# cwrig：IC-7300 只读 CI-V

`cwrig` 是 IC-7300 只读 CI-V 的独立命令行入口：

```text
cwrig simulate
cwrig read --port COM17 --baud 19200 --confirm-keying-off --timeout-ms 2000
cwrig monitor --simulate
cwrig monitor --port COM17 --baud 19200 --confirm-keying-off
cwrig history --file logs/rig-status-history.jsonl --tail 20
```

`simulate` 不打开串口；`read` 只查询频率和模式。不读取数据库或启动 daemon。
输出是单行 JSON，标注 `source: "simulation"` 或 `source: "serial"` 与 `readOnly: true`。

## 构建

需要 Node.js >= 24。在项目根目录执行：

```bash
npm install
npm run build
```

Windows（PowerShell 或 cmd）使用完全相同的命令；`npm run build` 会生成
`dist/apps/cwrig.js`。`dist/` 是可重新生成的构建产物。

## 运行模拟

Linux / macOS：

```bash
npm run cwrig -- simulate
# 或开发模式（无需先构建）：
npm run cwrig:dev -- simulate
```

Windows：

```powershell
npm run cwrig -- simulate
npm run cwrig:dev -- simulate
```

等价的手工调用：`node dist/apps/cwrig.js simulate`。

输出示例：

```json
{"ok":true,"source":"simulation","readOnly":true,"frequencyHz":14025000,"mode":"CW","filter":1,"note":"offline simulation only; no serial port was opened and no transmission is possible"}
```

模拟 transport 会按请求回显、把回显与回复逐字节拆包，并固定回复
频率 14 025 000 Hz、模式 CW、FIL1。未知、重复或多余参数都会被拒绝
（退出码 2，JSON `code: "usage"`）。

## 只读接口边界

- `CivReadOnlyClient` 只提供 `readFrequency()` 与 `readMode()`；CLI 没有
  raw/send/write/PTT 入口。串口 transport 的 write 严格检查固定03/04帧。
- 读取频率/模式是**非原子快照**，不代表 `txBusy`、授权状态或可发射。
- CI-V 没有事务 ID：超时、写失败、断连或无效期望回复都会关闭并锁死当前
  会话，后续查询被拒绝，不自动重试或重连。
- 默认 CI-V 地址为电台 `0x94`、控制端 `0xE0`；显式地址必须避开广播
  `0x00` 与保留/控制端范围。请求固定为 `FE FE 94 E0 03|04 FD`。

## 真实串口读取

Windows 原生 Node（PowerShell，项目根目录）：

```powershell
node dist/apps/cwrig.js read --port COM17 --baud 19200 --confirm-keying-off --timeout-ms 2000
```

Linux 在设备已映射为实际串口时：

```bash
node dist/apps/cwrig.js read --port /dev/ttyUSB0 --baud 19200 --confirm-keying-off
```

WSL 不能直接使用 Windows COM17；本机实机验收使用 Windows 原生 Node。
Linux 当前只通过 mock 验收，尚未验证真实设备映射。

连接前须确认：

- IC-7300 菜单中 USB SEND / USB CW / USB RTTY 等键控映射设为 OFF，
  `--confirm-keying-off` 是操作员确认，不是自动检查菜单；
- 实际串口设备路径、波特率/CI-V 地址与固件版本；
- 打开端口本身可能在控制线上产生电平变化，需先核对电台设置。

串口固定8N1、无流控，打开后拉低DTR/RTS、两次flush及50ms稳定等待。
baud默认19200，仅接受4800/9600/19200/38400/57600/115200；timeout默认2000ms，
接受1..60000。每次先读频率再读模式，有界关闭，不自动重试。

同进程相同端口名拒绝重复打开；跨进程独占由 serialport/OS 执行，路径别名
不能只靠同进程字符串登记识别。Windows使用系统独占打开；Linux采用库的
lock机制，不声称阻止一切绕过锁的外部程序。CI-V无事务ID，flush不能证明
随后回复必然属于本次请求。断连/无效回复使会话失效。

关闭失败不会输出成功，未确认关闭时保留占用及错误监听。独立CLI会在有界
清理完成或报错后退出，由OS收回进程句柄；错误输出不等于确认设备关闭。
开口瞬间可能改变控制线，软件set(false)不能消除该风险。

2026-10-10 COM17/19200实机先读取14651000Hz，最终复核14742000Hz，
均为USB、FIL2，端口确认关闭。频率是当时快照，没有写频率命令。
这不是TX状态探测、daemon集成或发射验收。证据见`docs/evidence/P1-005.md`；
模拟器原验收见`docs/evidence/P1-004.md`。

## 终端监视台

最短Bash入口（项目根目录；WSL会打开Windows原生终端窗口）：

```bash
bash rig.sh
```

默认COM17/19200，沿用操作员已确认的USB SEND/CW/RTTY映射OFF。
只看模拟界面用`bash rig.sh --simulate`。脚本可从任意目录按绝对路径启动，
自动定位项目；`CWSTATION_PORT=COM18 bash rig.sh`可覆盖端口。
原生Linux默认/dev/ttyUSB0，在当前终端启动；Windows/WSL使用Windows Node。
脚本不自动安装依赖或构建，缺构建产物时提示先执行npm run build。
`rig.sh`现由`rig-launch`统一管理`rig-controld`和监视台：服务初读完成后打开界面，
Q或Ctrl-C退出时经私有进程通道关闭设备服务。关闭超时或未确认时返回非零，
诊断追加到`logs/rig-launch-diagnostics.jsonl`，不自动重启或重发。
服务失联会主动通知界面，即使暂停轮询也显示FAULT；需退出后重新运行脚本。
服务模式的D只断开监视客户端，释放串口须用Q退出整个宿主。
Windows/WSL的`CWSTATION_PORT`必须是COM名称；原生Linux使用Linux设备路径。

独立监视模式（不与`rig.sh`同时运行），Windows原生PowerShell或Windows Terminal：

```powershell
node dist/apps/cwrig.js monitor --port COM17 --baud 19200 --confirm-keying-off
```

先查看离线界面：

```bash
node dist/apps/cwrig.js monitor --simulate
```

Windows可双击本目录`monitor-demo.cmd`进入模拟监视台。需要交互式终端，
不支持重定向到文件；脚本采集继续使用`read`的JSON输出。

顶部显示CW STATION、IC-7300、数据来源和连接状态；频率按三位分组，
同时显示北京时间（Asia/Shanghai，UTC+8）与UTC时间；宽屏包含日期，
窄屏采用紧凑时间格式。正常轮询保持绿色READY，只更新变化行，不周期清屏。
同时显示模式、FIL编号、端口/波特率、更新时间、近期事件。窄终端自动堆叠，
最低24列/8行，建议80列/24行。界面使用ASCII英文标签及状态颜色，
`NO_COLOR`环境变量可关闭颜色。

- C：连接或手动重连；D：断开；R：立即刷新。
- P：暂停/恢复自动刷新；G：展开/收起原始CI-V字节诊断。
- Q或Ctrl-C：有界清理并退出，恢复终端与光标。

启动时打开一次会话，默认每次读完后间隔1000ms查询一次；使用
`--interval-ms 250..60000`调整间隔。查询不重叠，轮询不会反复打开端口。
断连或读取失败停止轮询，保留最后读数并标STALE，不自动重连；
按C显式重新连接时恢复POLL ON；P暂停只作用于当前连接会话。
关闭不确定时阻止重连，显示错误。P暂停后数据超过max(3秒,3倍间隔)也标STALE。
刷新频率和模式仍是非原子快照，不表示TX状态。脚本服务模式由`rig-controld`独占串口，
监视台和`cwrig read --endpoint`通过本地IPC读取缓存；`rig.sh`默认写入
`logs/rig-status-history.jsonl`。历史文件是版本化JSONL，只记录只读快照和生命周期事件，
可用`cwrig history --file <path> --tail N`读取最近记录，读取上限为8MiB/1000条。

## Julia/MWORKS 离线分析

历史文件可以交给现有 MWORKS/Julia 环境做统计分析，不连接电台：

```bat
C:\Users\Public\TongYuan\julia-1.10.10\bin\julia-ty.bat ^
  D:\AI\projects\cwstation\julia\analyze_history.jl ^
  D:\AI\projects\cwstation\logs\rig-status-history.jsonl ^
  D:\AI\projects\cwstation\logs\rig-status-analysis.json
```

入口会校验历史版本、只读标记和记录结构，并独占创建结果文件。WSL 调用时先用
`wslpath -w` 转换输入和输出路径。结果包含输入 SHA-256、事件/状态/模式计数、频率变化统计、
环境版本和 `transmits:false`。
