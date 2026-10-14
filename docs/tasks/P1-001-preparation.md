# P1-001 v1：真实设备接入准备审查

状态：准备审查已完成并经 Codex 复核；用户已确认 ICOM IC-7300、USB 直连电脑、Windows 和 Linux 都要支持。实际串口设置与键控分配待确认；公共接口方案待讨论。结果见 docs/evidence/P1-001-readiness.md；设备补充依据见 docs/evidence/IC-7300-connection-notes.md，跨平台草案见 docs/design/windows-linux-usb-plan.md。

## 目标与上下文

Phase 0 的 P0-002 至 P0-005 已验收。按 MEMORY.md 和 ROADMAP.md，下一步先明确电台、CAT、CW KEY/PTT 与设备持有进程，再讨论适配器方案。Codex 负责设计及验收，DSH 负责本次只读代码审查和准备记录。

## 输入与输出

- 输入：MEMORY.md、docs/ROADMAP.md、现有 contracts/core/daemon、apps/daemon.ts 及相关测试。
- 输出：docs/evidence/P1-001-readiness.md，使用中文，列出实际代码路径、准备缺口、设备信息清单及建议的假负载验收顺序。
- 区分已有实现、Fake 测试与尚未实现/真机验证；建议不能写成已批准决定。

## 修改权与依赖

DSH 仅拥有上述输出文件修改权。禁止修改代码、配置、数据库、MEMORY.md、ADR 或其他任务文档；不连接设备、不发射、不安装依赖、不运行 daemon，不调用其他 Agent。Codex 同期只运行既有临时库测试。

## 验收

审查取消/停止确认、断连及频率模式变化、启动/停机恢复、真实后端核查、能力声明、设备唯一持有者及部署边界。每项给出文件及符号依据；避免把 AbortSignal 等同于硬件停止。最多约 100 行，提供最小方案建议和须用户讨论的接口决定，不实现新接口。

## 升级反馈

发现现有代码可能有安全错误时，仅报告触发条件及依据，交 Codex 复核；不得自行扩大修改范围。设备资料不足时明确列为待确认，不能猜测机型或连接方式。
