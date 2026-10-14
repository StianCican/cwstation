// packages/cw-trial 公共出口：受控 CW 试验会话、离线模拟器和记录目录。
//
// 本出口只供离线试验 app 使用；不接 serial/IPC/service/rig.sh，也不改变
// 只读入口或发射路径。

export * from "./session.js";
export * from "./simulator.js";
export * from "./record.js";
