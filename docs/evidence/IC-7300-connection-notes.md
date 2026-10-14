# IC-7300 接入依据与待确认项

任务日期：2026-10-05。用户确认型号：ICOM IC-7300，不能混用 IC-7300MK2 文档。Codex 本次只查询官方资料并更新文档，没有连接串口或发射。

用户后续确认：Windows 和 Linux 都要支持，目前电台 USB 直连电脑。尚未确认 USB SEND/CW 键控实际分配，也未确认外置键控器的有无。

## 官方资料与已核对事实

- [Full Manual (English)](https://www.icomjapan.com/support/manual/2271/)：2026-10-06 下载官方 Full Manual 12b，仅在临时目录提取文字核对，不将PDF纳入仓库。第19-2页确认默认地址94h/控制器E0h及帧结构；第19-3页确认03读取频率、04读取模式；第19-9页确认5字节低位在前BCD、CW/CW-R独立编码及FIL1..3。本阶段实施范围见P1-004，不包含真实串口。
- [Tips for the USB port settings](https://www.icomjapan.com/support/manual/2574/)：已下载 PDF 并用 `pdftotext -layout` 核对文字。版本 Ver.1.0，适用设备表包含 IC-7300。
- USB 指南第 1 节（印刷页 4–5）：USB 可使用 CI-V；IC-7300 支持将 DTR/RTS 分配到 `USB SEND`、`USB Keying (CW)` 和 `USB Keying (RTTY)`。软件与电台配置需对应；SEND 与 CW 键控是不同控制职责。
- 第 2 节（印刷页 6）：`CI-V USB Port` 的 Link/Unlink to [REMOTE] 会影响串口速度；Unlink 可到 115200 bps。这不是当前用户设置，不预设波特率。
- 操作系统与串口驱动是否支持、控制线时序是否可靠、取消后能否确认停止，均未实测。官方支持功能不等于现有软件已实现适配器。

## 最小接入建议（待讨论）

1. 用户确认部署系统、实际连线、固件及现有占用电台的程序。
2. 先核对电台设置，隔离键控功能，再通过唯一设备持有进程做 CI-V 只读频率/模式探测。串口打开可能改变 DTR/RTS；只发送读取命令不能单独保证没有发射副作用。首次探测前确认 `USB SEND`、`USB Keying (CW/RTTY)` 为 OFF，并核对其它发射触发设置。
3. 根据连接条件比较 USB DTR/RTS、外置键控器等路线，明确时序、取消、停止确认、重启及拔插行为后讨论接口。当前 Node/WSL 核心不意味着已支持 Windows 串口或 USB 透传。
4. 真机键控只在另行确定的假负载验收中进行。Julia WAV 合成不等于 IC-7300 的 CW KEY 驱动，不能直接将播放音频当作已验证键控。

## 尚需用户提供

- 后续接入时：固件版本、Windows COM/Linux 设备路径与 CI-V/USB 菜单设置、现有控制软件及端口持有者。
- 真机键控前：USB SEND/CW 键控实际分配、是否另有外置键控器、停止确认和假负载条件。

本记录为资料核对和方案输入，不是接口决定、命令实现或真机验收证据。

## 用户提供的完整手册核对（2026-10-09）

用户再次确认 ICOM IC-7300，并提供 `D:\xwechat_files\wxid_sgs7o8m5f4ye12_8080\msg\file\2026-10\IC-7300_ENG_FM_12b(1).pdf`，认为连接应为 CAT。Codex以pdftotext只读核对该PDF，不复制PDF、不打开串口。CAT在此设备上的具体协议是Icom CI-V；USB CI-V数据命令与同一USB串口的DTR/RTS控制线应分别处理。

- 印刷页12-10至12-11：默认CI-V地址94h；USB串口功能默认CI-V；USB Port的Link/Unlink决定所用波特率设置，Unlink的USB Baud Rate支持4800至115200及Auto。默认值不是用户当前设置。
- 印刷页12-11：USB SEND、USB Keying (CW)、USB Keying (RTTY)可映射DTR/RTS，默认OFF；SEND与CW键控不能选同一控制线。Inhibit Timer at USB Connection默认ON，说明书明确提示USB连接及虚拟串口建立可能触发意外SEND/Keying。
- 印刷页19-3、19-13：CI-V命令0x17支持发送CW消息，一次最多30字符；内容为手册所列ASCII字符。0xFF数据停止发送CW消息（是字节FF，不是字符串"FF"）；^表示无字符间隔的连续发码串。后续适配器不能直接沿用Julia/Morse库字符集合或假定长消息分块语义。
- 手册19-2的FB/FA分别是OK/NG应答。本次查阅没有建立“CW消息完成通知、停止后的队列处理及射频停止证明”的充分依据，不能把FB或延时估计当作completed或已停止。

建议优先评估USB CI-V内置CW发码，以电台自身产生点划时序；USB DTR/RTS作为待比较路线。该建议不是已批准键控接口或真机验收。下一步仍先完成只读串口接入准备，确认固件、COM/设备路径、CI-V地址/波特率、USB Port/Transceive/Echo Back及控制线映射；保持SEND/CW/RTTY映射OFF后再安排只读探测。发码/取消/停发证据另行设计假负载任务。

本次文档修改前采用同数据盘cp -a保留属性的文件备份：`/mnt/d/AI/project-backups/cwstation/20261009-225929-manual-review/`。目标仅本文件与MEMORY.md；完成后与备份逐项diff。没有修改代码或运行测试。

## 本机系统枚举（2026-10-09）

用户要求自行查询。通过Windows PowerShell只读查询Win32_SerialPort、PresentOnly PnP、SerialPort.GetPortNames及注册表，没有调用SerialPort.Open或发送CI-V命令。

- 当前串口：COM17，Silicon Labs CP210x USB to UART Bridge，Status=OK。硬件实例`USB\VID_10C4&PID_EA60\IC-7300_01009552`明确含IC-7300标识，非仅凭CP210x名称猜测。
- 驱动：Silicon Laboratories Inc.，11.3.0.176，INF=oem104.inf；系统映射`\Device\Silabser0 → COM17`。
- Windows Ports注册表的COM17默认配置为`9600,n,8,1`。仅是Windows保存的串口默认参数，不代表电台当前菜单波特率、实际通信成功或端口空闲。
- 当前也枚举到USB Audio CODEC（VID08BB/PID2901）及输入/输出端点，未单独验证音频设备与电台的归属或音频工作状态。
- 常见电台控制软件进程名称筛查未发现匹配；这不是完整句柄占用检查，不能证明COM17无人持有。
- WSL未发现`/dev/ttyUSB*`或`/dev/ttyACM*`；当前不能将COM17当作WSL串口路径使用。

电台固件、CI-V实际地址/波特率、USB Port/Transceive/Echo Back及USB SEND/CW/RTTY映射仍未知。注册表不能查询电台菜单。由于手册明确提示虚拟串口建立可能触发控制线，未确认映射前没有尝试开口或扫描波特率。

修改目标为本文件与MEMORY.md；修改前cp -a保留属性备份到`/mnt/d/AI/project-backups/cwstation/20261009-230639-port-enumeration/`，修改后逐项diff检查。没有修改设备设置、代码或运行测试。

## CI-V 只读链路探测（2026-10-10）

用户明确本次只做电台控制链路测试，发射功率设为0，不进行实际发射。功率为0不能证明不会进入TX，因此探测脚本保持DTR=false、RTS=false、Handshake=None，只打开串口、发送读取命令，随后关闭串口；没有发送0x17 CW、0xFF停止、PTT或SEND命令。

历史失败探测：Windows PowerShell对COM17依次测试4800、9600、19200、38400、57600、115200，8N1。Codex当时错误地将以下反向地址帧当作控制器请求；它们不是正确请求，不能用于推断实际波特率：

```text
FE FE E0 94 03 FD   # 当时误发，地址方向错误
FE FE E0 94 04 FD   # 当时误发，地址方向错误
```

六种波特率均可打开COM17，DTR/RTS均为false；每个查询等待约1.2秒，全部收到0字节。端口按顺序关闭，无错误。此前9600/115200用94 E0方向亦无回复，但发生在用户调整设置之前。本轮E0 94方向错误，已在下节纠正；此前失败不能证明驱动或电台端口异常。

软件设计应区分`port_open`、`frame_written`、`valid_civ_response`和`radio_state_known`；无回复应为有界超时并锁死本次会话，不能自动扫地址/重连，更不能开放发码。下一步需在电台面板核对USB Serial Function=CI-V、CI-V USB Port=Link/Unlink、CI-V USB Baud Rate、CI-V Address=94h以及USB SEND/Keying映射保持OFF，再复测同一只读帧。

本节修改前备份：`/mnt/d/AI/project-backups/cwstation/20261010-000807-civ-probe/`。本次未修改设备设置、代码或数据库；串口探测输出仅记录于本节。

## 19200实机只读查询成功（2026-10-10）

用户确认CI-V USB Baud Rate保持19200，其他建议设置已修改：SEND/CW/RTTY映射OFF、USB Serial Function=CI-V、地址94h、Echo Back/Transceive OFF、USB Port Unlink、连接抑制定时器ON。这些菜单值来自用户声明，未逐项通过协议读取。

COM17，19200，8N1，Handshake=None，DTR=false、RTS=false。第一次仍误发E0 94无回复；随后采用正确目标在前/源地址在后的请求，得到：

```text
TX FE FE 94 E0 03 FD
RX FE FE E0 94 03 00 70 54 14 00 FD
TX FE FE 94 E0 04 FD
RX FE FE E0 94 04 01 02 FD
```

五字节低位在前BCD解码：14547000Hz（14.547MHz）；模式01=USB，滤波器02=FIL2。两个读取不是原子快照。端口在finally关闭、Dispose；未发送写频率/模式、CW、PTT、SEND或停止命令。没有验证射频功率、TX状态、音频、CW完成/取消或断连恢复。

现有packages/devices/src/civ.ts按radioAddress在前构造请求、controllerAddress在前校验回复，方向正确，无需因本次脚本错误改代码。实机成功来自独立PowerShell探测，不代表应用已有真实串口transport或daemon实机闭环。

本次修正文档与MEMORY.md前cp -a保留属性备份到`/mnt/d/AI/project-backups/cwstation/20261010-002654-civ-success/`；随后逐项diff，仅更新历史错误与实机证据。未修改软件代码、数据库或电台设置。
