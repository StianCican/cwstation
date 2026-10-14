# P1-002 Codex 审查记录

状态：Codex 已收回修改权并完成复核。最终结果见 docs/evidence/P1-002.md。

## 初步复核

- Windows Node 24.16.0、Windows 10.0.26200 已直接运行；开发用 Linux Node 24.18.1。
- Codex 对临时 Windows Node 管道执行 `scripts/windows-pipe-acl.ps1`：实际 DACL 包含 SYSTEM/Administrators/当前用户 full access，以及 Everyone/Anonymous read access。与 Unix 0600 不等价，不应声称所有 Windows 实例已动态验证同用户访问。
- 核对停机 flush：回调只能绑定 `daemon.stop` 响应，不能因另一个较早请求完成而提前关闭停机响应连接。
- 核对平台配置优先级：高层有效端点覆盖低层地址时，应按声明的优先级选择最终端点再检查平台兼容；配置结构校验仍完整执行。
- 补足 RPC 停机期间的在途 Fake 键控与重启 unknown 验证；不能仅以无在途停机替代。
- 独立验证 Windows 同 pipe 不同 DB 的第二实例拒绝、强制结束恢复、维护结果，以及跨平台测试的实际跳过理由。

## 尚待执行

已修正停机响应绑定、最终端点优先级、Windows测试模式/清理、SQLite初始化异常关闭和Windows备份发布；独立Linux编译161/161、Windows原生155通过/6明确跳过，无失败。Windows默认DACL不等价于Unix0600，需后续权限方案与实测，未授权真实控制。用户数据库与电台未参与。
