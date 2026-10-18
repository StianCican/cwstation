# BASE-002 v1 可复现测试基线

状态：双平台源码/编译回归零失败，DSH待补审，完整任务尚未验收。授权：用户于2026-10-15同意进度规划并要求继续，当前执行第一项离线验证基线。

## 输入与目标

读取AGENTS、MEMORY、任务自查规范、BASE-001证据和scripts/verify-platform.mjs。
Git起点81ee2d6，工作区开始时干净；产物/日志/数据保护为`.local-backups/20261015-013904-test-baseline/workspace-before.tar`。
最小探针已发现spawnSync返回error.code=EPERM但status=0；普通Node子进程console.log输出丢失。现有全仓失败不能简单归因产品。

复用已有平台验证脚本，为源码/编译版提供同一验证入口，补入packages/rig-status/src/service.test.ts，环境不满足时明确失败且不继续产品测试。
不修改产品协议、串口、发送路径、真实数据、AGENTS或全局设置，不接电台。

## DSH修改权与输出

DSH仅可修改scripts/verify-platform.mjs、package.json，新增docs/reviews/BASE-002-DSH-review.md；其他文件由Codex持有。
入口保留默认编译版平台验证，并提供--source、--built、--preflight、--list和--help；参数非法时先拒绝。
前检检查Node>=24、同步/异步Node子进程的启动错误与精确stdout、Unix socket或Windows命名管道监听及本机HTTP监听；输出逐项JSON结果。网络探针仅本机临时监听，不访问外网。
前检失败应退出非零、不build/跑产品测试，不把失败改为跳过或通过。list/help不能启动服务或build。
源码与编译版明确列出全部测试，包含服务内套件；Windows源码模式也需现有native bridge。完整测试命令保留文件隔离，不以关闭隔离伪造正常全仓通过。

全部手工编辑使用apply_patch；不可用则只读反馈，不用其他写入工具替代。先检查实现范围和现有脚本，再落地。日志和自动构建输出可正常生成。
若Harness权限/配额/网络失败，报告实际错误，不反复重试、不读取凭据、不改全局profile。

## 验收与升级

DSH启动exit1：写全局headless/cordis.yml遭EROFS，尚未执行任务，文件cmp与修改前副本一致；Codex已收回全部修改权。原始日志保存在本轮备份目录dsh-attempt.log。没有更换DSH_HOME或复制凭据。

提交精确命令/退出码、文件hash、阶段检查和R01-R12报告；区分环境阻塞与已确认产品/测试缺陷。
Codex复核修改、测试发现列表、实际失败前检、残留进程和保护差异。不能因前检准确失败而宣称全仓测试通过。
若不能运行DSH，Codex可完成局部修复和诊断，但审议状态保持待DSH补审，不直接验收。
重大工具架构或公共接口变更反馈Codex，超出本任务不实施。

## v2 续办与局部范围调整（2026-10-15）

起点`fb5cbc2`工作区干净，完整保护`.local-backups/20261015-base002-resume/workspace-before.tar`；建立后tar比较exit0。当前Linux与Windows前检均通过，允许完整隔离回归。
Windows编译首轮29项失败证实`FakeRigClient`默认优先源码，与编译模式不一致；Codex将局部修复范围纳入`packages/rig-control/src/client.ts`，沿源码/编译模式选择默认子服务。该文件及所有构建/日志/依赖产物在修改前快照中已保护；没有公共契约或发送/停止/unknown语义变化。
Windows源码模式需要的`@esbuild/win32-x64@0.28.2`目录原先不存在；下载既有锁版本并核对SHA512后新增到node_modules，保留Linux包，不改package/lock。Windows编译成功在新增该包之前完成，避免开发依赖掩盖修复效果。
最终四种回归均exit0，详细结果与平台缺口见证据续办段。DSH只读补审调用exit1/API HTTP 402，无报告；Codex持有全部修改权并完成自查，仍待DSH补审，不自动升级为设备回归授权。
