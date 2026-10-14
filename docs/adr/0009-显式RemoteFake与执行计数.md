# ADR 0009 显式Remote Fake与执行计数

日期：2026-10-12。状态：接受设计，限定Fake实现；验收见P2-003e。

用户同意将已有RemoteKeyer接成显式可选入口并监督进程。--remote-fake-ledger与--rig-endpoint互斥，默认进程内Fake不变，不能从真实IC-7300只读能力推导发送许可。daemon持有Fake子进程及核心批准，私有NDJSON会话、稳定账本与既有操作ID复用，失联/状态变化撤销批准，无自动重启/重发。

当前core把没有keyedCount证据的适配器当成0会误导新远程入口。将status.keyedCount改为number|null：已存在默认Fake/只读模式保持数值响应，新远程后端明确返回null。新增version1 executionMetrics区分IPC发送尝试、已确认模拟完成/停止及不确定尝试。指标仅当前进程，持久execution/设备账本仍是操作真源；不得将模拟完成推广到实际射频。RPC信封、P/A契约及DB版本不变，新后端调用者须处理null，不依赖计数做授权。

Fake设备独立账本unknown不能由核心resolve-unknown抹除；核心核查后设备仍blocked时批准检查继续拒绝。不增加设备账本解除或迁移接口，不删除或替换账本恢复许可。

本决定不改变serial白名单、rig.sh、真实设备服务或IC-7300发送权限。阶段审议断线时记录待审议，不以通过测试替代交叉审议。
