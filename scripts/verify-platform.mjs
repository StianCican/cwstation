import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
console.log(JSON.stringify({ platform: process.platform, node: process.version, executable: process.execPath }));
if (process.platform === "win32") {
  const native = spawnSync(process.execPath, [join(root, "scripts/build-native-windows.mjs")], {
    cwd: root, stdio: "inherit", timeout: 60_000,
  });
  if (native.status !== 0) process.exit(native.status ?? 1);
}
const build = spawnSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"], {
  cwd: root, stdio: "inherit", timeout: 120_000,
});
if (build.error) console.error(build.error.message);
if (build.status !== 0) process.exit(build.status ?? 1);
const files = readdirSync(join(root, "dist/tests")).filter((name) => name.endsWith(".test.js")).sort();
const result = spawnSync(process.execPath, ["--test", "--test-timeout=60000", ...files.map((name) => join(root, "dist/tests", name))], {
  cwd: root, stdio: "inherit", timeout: 180_000,
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
