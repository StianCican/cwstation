// P2-003a rig-controld：统一设备入口的只读起步；P2-015 增加显式 --cw-trial。
//
// 设计边界（docs/tasks/P2-003a-只读设备入口.md）：
//  - 复用 apps/rig-statusd.ts 的 main 与参数校验，共用同一个 RigStatusService
//    和受保护的本地 NDJSON IPC；不另开串口、不另写 CI-V 轮询器。
//  - 旧入口 apps/rig-statusd.ts 继续保留并兼容。
//  - stdout 源标识保持 "rig-statusd" 以兼容旧监视台；启动记录 readOnly:true，
//    当前入口不接 TxController，也不声明发送/停止/PTT 能力。
//  - 直接执行检测在本文件独立实现，导入本模块不会启动服务。
//  - `--cw-trial` 显式路由到 apps/rig-cw-trial.ts 的受控试验入口；普通服务与
//    rig.sh 仍只读。试验模式替代普通服务运行，不新增公共 IPC/TCP 监听。
//
// 当前切片是统一持有者迁移的只读起点，尚不是完整生产控制服务。

import { pathToFileURL } from "node:url";
import { RIG_STATUS_SOURCE } from "../packages/rig-status/src/index.js";
import { RIG_STATUSD_USAGE, main as runReadOnlyStatusService } from "./rig-statusd.js";

export const RIG_CONTROLD_USAGE =
  "rig-controld [read-only status service options] | " +
  "rig-controld --cw-trial --simulate [--message E|TEST] ... | " +
  "rig-controld --cw-trial --port <COMx> --confirm-keying-off [--message E|TEST] ...";

/** rig-controld 入口：默认复用只读服务；`--cw-trial` 显式进入受控试验。 */
export async function main(argv: readonly string[]): Promise<number> {
  if (argv[0] === "--cw-trial") {
    const { runCwTrial } = await import("./rig-cw-trial.js");
    return await runCwTrial(argv.slice(1));
  }
  return await runReadOnlyStatusService(argv);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return pathToFileURL(entry).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stdout.write(
        `${JSON.stringify({ source: RIG_STATUS_SOURCE, readOnly: true, event: "error", code: "internal", error: message(error) })}\n`,
      );
      process.exitCode = 1;
    });
}
