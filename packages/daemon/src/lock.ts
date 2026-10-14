// 受限锁文件：保证同一运行目录/同一数据库只有一个 daemon。
// 并发安全：整个“检查 / 回收 / 创建”过程由短生命周期 mkdir guard 串行化。
//  - guard 已存在 → fail closed（可能另一启动者正在临界区，或上次异常残留，需人工检查）。
//  - 无效/空锁文件 → fail closed，绝不自动判定持有者已死。
//  - 确认持有者已死才原子 rename 走陈旧锁，保留证据，不盲目 unlink。

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";

export interface LockHandle {
  readonly path: string;
  release(): void;
}

export class LockedError extends Error {}

interface LockContent {
  pid: number;
  label: string;
  at: string;
  socketPath?: string;
  dbPath?: string;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EPERM 表示进程存在但属于其他用户：仍视为存活。
    return code === "EPERM";
  }
}

function readLock(path: string): LockContent | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LockContent>;
    if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0) {
      return {
        pid: parsed.pid,
        label: typeof parsed.label === "string" ? parsed.label : "unknown",
        at: typeof parsed.at === "string" ? parsed.at : "",
        ...(typeof parsed.socketPath === "string" ? { socketPath: parsed.socketPath } : {}),
        ...(typeof parsed.dbPath === "string" ? { dbPath: parsed.dbPath } : {}),
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 获取 guard：mkdir 是原子操作，天然互斥。
 * guard 残留（进程在临界区内崩溃）不被自动清理，需人工确认后删除。
 */
function acquireGuard(guardPath: string): void {
  try {
    mkdirSync(guardPath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new LockedError(
        `lock guard ${guardPath} already exists; another acquire may be in progress or a previous one crashed. ` +
          "Refusing to guess; inspect and remove the guard directory manually.",
      );
    }
    throw error;
  }
}

function releaseGuard(guardPath: string): void {
  try {
    rmSync(guardPath, { recursive: true, force: true });
  } catch {
    // guard 删除失败会让下次启动 fail closed；这是刻意的保守行为。
  }
}

/**
 * 获取锁。已存在且持有者存活 → 抛 LockedError（不删除）。
 * 已存在但持有者已退出 → 原子移走陈旧锁后重试（不盲目 unlink 当前锁）。
 * 已存在但内容无效/为空 → fail closed，等待人工处理。
 */
export function acquireLock(path: string, label: string, extra: { socketPath?: string; dbPath?: string } = {}): LockHandle {
  const guardPath = `${path}.guard`;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    acquireGuard(guardPath);
    try {
      if (existsSync(path)) {
        const existing = readLock(path);
        if (!existing) {
          // 不可把空/损坏锁当作“持有者已死”而移除：可能正处于写入窗口。
          throw new LockedError(
            `lock ${path} exists but is empty or malformed; refusing to auto-remove it. ` +
              "Inspect the file and remove it manually if the owner is gone.",
          );
        }
        if (isPidAlive(existing.pid)) {
          throw new LockedError(`lock ${path} is held by live pid ${existing.pid} (${existing.label}); refusing to start`);
        }
        // 持有者已不在：原子重命名走开，避免与并发的启动者互相删除。
        const stale = `${path}.stale.${Date.now()}.${process.pid}`;
        try {
          renameSync(path, stale);
        } catch (renameError) {
          if ((renameError as NodeJS.ErrnoException).code !== "ENOENT") throw renameError;
        }
        // 保留陈旧锁文件供事后排查，不静默丢弃。
      }

      const content = JSON.stringify({
        pid: process.pid,
        label,
        at: new Date().toISOString(),
        ...(extra.socketPath ? { socketPath: extra.socketPath } : {}),
        ...(extra.dbPath ? { dbPath: extra.dbPath } : {}),
      });

      const fd = openSync(path, "wx", 0o600);
      try {
        writeSync(fd, content);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }

      return {
        path,
        release(): void {
          // release 也在 guard 内执行，避免与另一启动者的回收逻辑竞争。
          try {
            acquireGuard(guardPath);
          } catch {
            // guard 被占用/残留：留给下次启动按陈旧锁检查，绝不冒险删除。
            return;
          }
          try {
            const current = readLock(path);
            if (current && current.pid === process.pid) unlinkSync(path);
          } catch {
            // 释放失败不掩盖主流程；陈旧锁会在下次启动时被检查。
          } finally {
            releaseGuard(guardPath);
          }
        },
      };
    } catch (error) {
      if (error instanceof LockedError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // openSync('wx') 在 guard 内的罕见 EEXIST：重试。
    } finally {
      releaseGuard(guardPath);
    }
  }
  throw new LockedError(`could not acquire lock ${path} after repeated stale-lock races`);
}
