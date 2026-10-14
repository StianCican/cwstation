// 运行时路径约定：daemon、CLI 与维护命令必须一致。
// 仅使用用户可写的运行目录与本地 Unix socket；不监听公开 TCP。
//
// 环境变量与配置的优先级由 packages/daemon/src/config.ts 处理；这里只提供：
//  - 不含 CWSTATION_* 覆盖的“基础默认值”；
//  - 现有环境变量兼容入口 defaultSocketPath()/defaultDbPath()；
//  - 锁文件路径与符号链接安全的 canonicalPath()。

import { existsSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export type PathEnv = NodeJS.ProcessEnv;

/** XDG/tmp 基础运行目录；不读取 CWSTATION_* 覆盖变量。 */
export function baseRuntimeDir(env: PathEnv = process.env): string {
  const xdg = env.XDG_RUNTIME_DIR;
  if (xdg) return join(xdg, "cwstation");
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return join(tmpdir(), `cwstation-${uid}`);
}

/** 基础 socket 路径（仅 XDG/tmp 默认，不含 CWSTATION_* 覆盖）。 */
export function baseSocketPath(env: PathEnv = process.env): string {
  return join(baseRuntimeDir(env), "cwstation.sock");
}

/** 基础数据库路径（相对当前工作目录，不含 CWSTATION_DB 覆盖）。 */
export function baseDbPath(): string {
  return resolve("data/cwstation.sqlite");
}

/**
 * 现有环境变量对 socket 的覆盖：
 * `CWSTATION_SOCKET` 优先于 `CWSTATION_RUNTIME_DIR`。
 * 返回 undefined 表示没有环境覆盖。
 */
export function envSocketOverride(env: PathEnv = process.env): string | undefined {
  if (env.CWSTATION_SOCKET) return resolve(env.CWSTATION_SOCKET);
  if (env.CWSTATION_RUNTIME_DIR) return join(resolve(env.CWSTATION_RUNTIME_DIR), "cwstation.sock");
  return undefined;
}

/** 现有环境变量对数据库的覆盖；返回 undefined 表示没有环境覆盖。 */
export function envDbOverride(env: PathEnv = process.env): string | undefined {
  return env.CWSTATION_DB ? resolve(env.CWSTATION_DB) : undefined;
}

/** 兼容入口：与原行为一致（环境变量优先于基础默认）。 */
export function defaultSocketPath(env: PathEnv = process.env): string {
  return envSocketOverride(env) ?? baseSocketPath(env);
}

/** 兼容入口：与原行为一致（环境变量优先于基础默认）。 */
export function defaultDbPath(env: PathEnv = process.env): string {
  return envDbOverride(env) ?? baseDbPath();
}

/** 原名称保留：等价于 baseRuntimeDir()。 */
export function defaultRuntimeDir(env: PathEnv = process.env): string {
  return env.CWSTATION_RUNTIME_DIR ? resolve(env.CWSTATION_RUNTIME_DIR) : baseRuntimeDir(env);
}

export function dbLockPath(dbPath: string): string {
  if (existsSync(dbPath) && statSync(dbPath).nlink > 1) {
    throw new Error("database hard links are unsupported; use a single database file path");
  }
  return `${dbPath}.lock`;
}

export function socketLockPath(socketPath: string): string {
  return `${socketPath}.lock`;
}

/**
 * 绝对规范化路径，并解析已有部分的符号链接。
 *
 * 目的：让 daemon、CLI 与维护命令对“同一文件”得到同一个锁路径，
 * 避免用 symlink/相对路径别名绕过数据库锁。目标不存在时（例如新建数据库、
 * 新建 socket），逐个向上找到最近的真实祖先目录再拼接剩余段。
 */
export function canonicalPath(input: string): string {
  const absolute = resolve(input);
  const segments: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const real = realpathSync(current);
      return segments.length === 0 ? real : join(real, ...segments.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return absolute;
      segments.push(basename(current));
      current = parent;
    }
  }
}

/**
 * 目标主文件及其 SQLite 伴生文件（-wal/-shm）是否都存在。
 * 维护命令用它判断“新数据库路径”是否已被占用。
 */
export function sqliteSidecarPaths(dbPath: string): string[] {
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
}

export function anyPathExists(paths: readonly string[]): boolean {
  return paths.some((path) => existsSync(path));
}
