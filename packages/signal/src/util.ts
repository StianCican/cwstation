// 文件与路径工具：SHA256、限额读取、artifact 路径安全解析。

import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { CwContractError } from "./contracts.js";

export function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** 读取普通文件并强制字节上限；缺失/非普通文件/超限分别报明确错误。 */
export function readFileCapped(filePath: string, maxBytes: number, label: string): Buffer {
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    throw new CwContractError("file_not_found", `${label} not found: ${filePath}`);
  }
  if (!stat.isFile()) {
    throw new CwContractError("file_not_found", `${label} is not a regular file: ${filePath}`);
  }
  if (stat.size > maxBytes) {
    throw new CwContractError("file_too_large", `${label} exceeds ${maxBytes} bytes`);
  }
  return readFileSync(filePath);
}

const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;

/**
 * 将 result.json 中的相对 artifact 路径解析为真实文件路径：
 *  - 拒绝绝对路径（POSIX、Windows 盘符、UNC）；
 *  - 拒绝 '..'/'.'/空路径段；
 *  - realpath 必须仍在 result 所在目录内（拒绝目录外 symlink）；
 *  - 必须是普通文件。
 */
export function resolveArtifactPath(resultDir: string, rel: unknown): string {
  if (typeof rel !== "string" || rel.length === 0) {
    throw new CwContractError("artifact_path_unsafe", "artifact path must be a non-empty string");
  }
  if (path.isAbsolute(rel) || WINDOWS_ABSOLUTE.test(rel) || rel.startsWith("\\\\") || rel.startsWith("//")) {
    throw new CwContractError("artifact_path_unsafe", `artifact path must be relative: ${rel}`);
  }
  const segments = rel.replace(/\\/g, "/").split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new CwContractError("artifact_path_unsafe", `artifact path contains unsafe segments: ${rel}`);
  }
  const resolved = path.resolve(resultDir, ...segments);
  let realDir: string;
  let real: string;
  try {
    realDir = realpathSync(resultDir);
    real = realpathSync(resolved);
  } catch {
    throw new CwContractError("artifact_missing", `artifact not found: ${rel}`);
  }
  if (real !== realDir && !real.startsWith(realDir + path.sep)) {
    throw new CwContractError("artifact_path_unsafe", `artifact escapes the result directory: ${rel}`);
  }
  if (!statSync(real).isFile()) {
    throw new CwContractError("artifact_missing", `artifact is not a regular file: ${rel}`);
  }
  return real;
}
