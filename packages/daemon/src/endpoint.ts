// 本地控制端点抽象：Linux/类 Unix 文件 socket 与 Windows 本地命名管道。
//
// 设计边界（P1-002 / ADR0004）：
//  - 端点不是普通文件路径。命名管道绝不经过 resolve/realpath/chmod/rename，
//    也绝不当作可 stat/exists 的文件；文件系统锁与“陈旧 socket 文件”逻辑只适用于 unix。
//  - 只接受本地命名管道 `\\.\pipe\<name>`。远程管道（`\\host\pipe\...`）、
//    `\\?\pipe\...`、路径分隔符、控制字符与其它危险/不支持格式一律明确拒绝。
//  - 管道名在 Windows 上大小写不敏感：锁 key 统一小写规范化，避免别名绕过。
//  - 管道锁文件放在实际用户运行目录，而不是管道名所在的全局命名空间。
//  - 不静默把用户给出的 Unix 文件路径转换成 Windows 管道（反之亦然），
//    平台不兼容地址直接报错。

import { createHash } from "node:crypto";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { baseSocketPath, canonicalPath, type PathEnv } from "./paths.js";

export type EndpointKind = "unix" | "pipe";

export type Endpoint =
  | { readonly kind: "unix"; readonly path: string }
  | { readonly kind: "pipe"; readonly name: string };

export type EndpointErrorCode =
  | "endpoint_invalid"
  | "endpoint_unsupported_platform"
  | "endpoint_remote_pipe"
  | "endpoint_pipe_name_invalid"
  | "endpoint_unix_on_windows"
  | "endpoint_pipe_on_unix"
  | "endpoint_config_invalid";

export class EndpointError extends Error {
  constructor(
    readonly code: EndpointErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EndpointError";
  }
}

/** Windows 本地命名管道的规范前缀。 */
export const LOCAL_PIPE_PREFIX = "\\\\.\\pipe\\";
/** 管道名最大长度；Windows 管道名总长上限 256（含前缀）。 */
export const MAX_PIPE_NAME_LENGTH = 200;

type ClassifiedAddress = { kind: "local-pipe"; name: string } | { kind: "filesystem"; path: string };

function classifyAddress(raw: string): ClassifiedAddress {
  const trimmed = raw.trim();
  const slashed = trimmed.replace(/\//g, "\\");
  const localPipe = /^\\\\\.\\pipe\\/i.exec(slashed);
  if (localPipe) {
    return { kind: "local-pipe", name: trimmed.slice(localPipe[0].length) };
  }
  if (/^\\\\\?\\/.test(slashed)) {
    throw new EndpointError(
      "endpoint_unsupported_platform",
      "unsupported endpoint format: \\\\?\\ pipe paths and NT device paths are not supported; use \\\\.\\pipe\\<name>",
    );
  }
  if (slashed.startsWith("\\\\")) {
    throw new EndpointError(
      "endpoint_remote_pipe",
      `remote or UNC endpoints are not supported (${JSON.stringify(trimmed)}); only the local pipe \\.\\pipe\\<name> or a local Unix socket path is allowed`,
    );
  }
  return { kind: "filesystem", path: trimmed };
}

/**
 * 校验并规范化命名管道名（前缀之后的部分）。
 * 采用保守字符集，明确拒绝路径分隔、控制字符与 `..`，避免危险/不支持格式。
 */
export function validatePipeName(raw: string): string {
  const name = raw.trim();
  if (name.length === 0) {
    throw new EndpointError("endpoint_pipe_name_invalid", "named pipe name must not be empty");
  }
  if (name.length > MAX_PIPE_NAME_LENGTH) {
    throw new EndpointError(
      "endpoint_pipe_name_invalid",
      `named pipe name exceeds ${MAX_PIPE_NAME_LENGTH} characters`,
    );
  }
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new EndpointError(
      "endpoint_pipe_name_invalid",
      `named pipe name contains unsupported characters: ${JSON.stringify(name)} (allowed: A-Z a-z 0-9 . _ -)`,
    );
  }
  if (name === "." || name === ".." || name.includes("..")) {
    throw new EndpointError("endpoint_pipe_name_invalid", `named pipe name must not contain "..": ${name}`);
  }
  return name;
}

/**
 * 解析用户提供的端点地址（环境变量、CLI、默认值）。
 *
 * platform 显式传入以便测试；实际调用使用 process.platform。
 * 返回的 unix 端点路径已按当前工作目录解析为绝对路径；配置文件的相对路径
 * 由配置加载器按配置文件目录先行解析。
 */
export function parseEndpointAddress(raw: string, platform: NodeJS.Platform = process.platform): Endpoint {
  const value = raw.trim();
  if (value.length === 0) throw new EndpointError("endpoint_invalid", "endpoint address must not be empty");

  const classified = classifyAddress(value);
  if (classified.kind === "local-pipe") {
    if (platform !== "win32") {
      throw new EndpointError(
        "endpoint_pipe_on_unix",
        `Windows named pipes are not supported on ${platform}; use a Unix socket path instead (got ${JSON.stringify(value)})`,
      );
    }
    return { kind: "pipe", name: validatePipeName(classified.name) };
  }

  if (platform === "win32") {
    throw new EndpointError(
      "endpoint_unix_on_windows",
      `Unix socket file paths are not supported on Windows; use a local named pipe \\.\\pipe\\<name> or a version2 endpoint config (got ${JSON.stringify(value)})`,
    );
  }
  return { kind: "unix", path: resolve(classified.path) };
}

/** 端点用于连接/监听的地址字符串。 */
export function endpointAddress(endpoint: Endpoint): string {
  return endpoint.kind === "unix" ? endpoint.path : `${LOCAL_PIPE_PREFIX}${endpoint.name}`;
}

/**
 * 端点唯一 key：用于锁与重复实例判断。
 * unix 解析符号链接避免别名；pipe 仅按小写规范化，因为 Windows 管道名大小写不敏感。
 */
export function endpointKey(endpoint: Endpoint): string {
  return endpoint.kind === "unix" ? canonicalPath(endpoint.path) : endpoint.name.toLowerCase();
}

/** 在真正打开端点前规范化端点：unix 解析别名，pipe 原样（绝不走文件系统）。 */
export function canonicalEndpoint(endpoint: Endpoint): Endpoint {
  return endpoint.kind === "unix" ? { kind: "unix", path: canonicalPath(endpoint.path) } : endpoint;
}

function userToken(env: PathEnv): string {
  let raw = env.USERNAME ?? env.USER ?? env.LOGNAME ?? "";
  if (raw.length === 0) {
    try {
      raw = userInfo().username;
    } catch {
      raw = "user";
    }
  }
  const readable =
    raw
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "user";
  const digest = createHash("sha256").update(raw.toLowerCase()).digest("hex").slice(0, 8);
  return `${readable}-${digest}`;
}

/**
 * 管道锁文件所在目录：实际用户运行目录，而不是管道命名空间。
 * 优先级：CWSTATION_RUNTIME_DIR（仅作为目录）> 平台临时目录/cwstation-<用户令牌>。
 */
export function pipeRuntimeDir(env: PathEnv = process.env): string {
  if (env.CWSTATION_RUNTIME_DIR) return resolve(env.CWSTATION_RUNTIME_DIR);
  return join(tmpdir(), `cwstation-${userToken(env)}`);
}

/** 管道名的规范化锁 key：小写 + 短哈希，避免截断/清洗后的碰撞。 */
export function pipeLockKey(name: string): string {
  const normalized = name.toLowerCase();
  const readable = normalized.replace(/[^a-z0-9._-]+/g, "-").slice(0, 48) || "pipe";
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return `${readable}-${digest}`;
}

/**
 * 端点的锁文件路径。
 *  - unix：与既有行为一致，规范化路径 + `.lock`；
 *  - pipe：实际用户运行目录中的单个锁文件，名字来自规范化管道 key。
 */
export function endpointLockPath(endpoint: Endpoint, env: PathEnv = process.env): string {
  if (endpoint.kind === "unix") return `${canonicalPath(endpoint.path)}.lock`;
  return join(pipeRuntimeDir(env), `pipe-${pipeLockKey(endpoint.name)}.lock`);
}

/** 默认端点：Windows 用区分用户的本地管道；其它平台沿用 Unix socket 默认。 */
export function defaultEndpoint(platform: NodeJS.Platform = process.platform, env: PathEnv = process.env): Endpoint {
  if (platform === "win32") {
    return { kind: "pipe", name: validatePipeName(`cwstation-${userToken(env)}`) };
  }
  return { kind: "unix", path: baseSocketPath(env) };
}
