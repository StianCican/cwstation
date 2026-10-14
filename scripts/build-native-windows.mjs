// 显式构建 Windows 原生管道桥接 helper（不在 daemon 启动时编译）。
//
// 仅在 Windows 原生 Node 上运行；Linux 不需要也不需要该产物（Linux 保留 Unix socket）。
// 编译器默认使用 in-box Framework64 csc（C# 5，.NET Framework 4.x），可用
// CWSTATION_CSC 覆盖。产物写入 dist/native/CwPipeBridge.exe。
//
// 用法：
//   node scripts/build-native-windows.mjs            # 仅 Windows
//   node scripts/build-native-windows.mjs --check    # 已存在且源更旧则跳过

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, "native", "windows", "CwPipeBridge.cs");
const outDir = join(root, "dist", "native");
const outExe = join(outDir, "CwPipeBridge.exe");
const defaultCsc = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const webExtensions = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\System.Web.Extensions.dll";

const checkOnly = process.argv.includes("--check");
const csc = process.env.CWSTATION_CSC ?? defaultCsc;

function fail(code, message) {
  process.stderr.write(JSON.stringify({ event: "native-build", ok: false, code, message }) + "\n");
  process.exit(1);
}

if (process.platform !== "win32") {
  fail("unsupported-platform", `native Windows bridge is only built on Windows (current: ${process.platform})`);
}
if (!existsSync(source)) fail("missing-source", `missing ${source}`);
if (!existsSync(csc) && process.env.CWSTATION_CSC === undefined) {
  fail("missing-compiler", `Framework64 csc not found at ${csc}; set CWSTATION_CSC`);
}

if (checkOnly && existsSync(outExe)) {
  const sourceTime = statSync(source).mtimeMs;
  const exeTime = statSync(outExe).mtimeMs;
  if (exeTime >= sourceTime) {
    process.stdout.write(JSON.stringify({ event: "native-build", ok: true, skipped: true, exe: outExe }) + "\n");
    process.exit(0);
  }
}

mkdirSync(outDir, { recursive: true });
const result = spawnSync(
  csc,
  [
    "/nologo",
    "/target:exe",
    "/platform:anycpu",
    "/optimize+",
    "/warn:4",
    `/out:${outExe}`,
    `/reference:${webExtensions}`,
    source,
  ],
  { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 60_000 },
);

if (result.error) fail("spawn-failed", result.error.message);
if (result.status !== 0) {
  fail("compile-failed", `${result.stderr?.toString() ?? ""}${result.stdout?.toString() ?? ""}`.trim());
}
if (!existsSync(outExe)) fail("missing-artifact", `compiler reported success but ${outExe} is missing`);

const bytes = readFileSync(outExe);
const sha256 = createHash("sha256").update(bytes).digest("hex");
process.stdout.write(
  JSON.stringify({
    event: "native-build",
    ok: true,
    skipped: false,
    compiler: csc,
    exe: outExe,
    bytes: bytes.length,
    sha256,
  }) + "\n",
);
