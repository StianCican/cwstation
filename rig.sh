#!/usr/bin/env bash
set -euo pipefail

# P2-003b: rig.sh 只负责检查编译产物并把服务参数交给 rig-launch 宿主。
# 串口由 rig-launch fork 出的 rig-controld 独占；rig.sh 不再直接启动
# rig-statusd，也不删除固定 socket 或他人的日志。

project_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
simulate=false
case "${1:-}" in
  "") ;;
  --simulate) simulate=true ;;
  -h|--help)
    printf 'Usage: bash rig.sh [--simulate]\nDefault: IC-7300, COM17 on Windows/WSL, 19200 baud, read-only.\nHistory: logs/rig-status-history.jsonl\nThe host forks dist/apps/rig-controld.js and runs cwrig monitor on the same endpoint.\n'
    exit 0 ;;
  *) printf 'Usage: bash rig.sh [--simulate]\n' >&2; exit 2 ;;
esac
if (( $# > 1 )); then
  printf 'Too many arguments. Usage: bash rig.sh [--simulate]\n' >&2
  exit 2
fi

for entry in dist/apps/rig-launch.js dist/apps/rig-controld.js dist/apps/cwrig.js; do
  if [[ ! -f "$project_root/$entry" ]]; then
    printf 'Build missing: %s. Run npm run build in %s first.\n' "$entry" "$project_root" >&2
    exit 1
  fi
done

windows=false
if [[ -n "${WSL_INTEROP:-}" || -r /proc/sys/fs/binfmt_misc/WSLInterop ]]; then
  windows=true
  windows_root=$(wslpath -w "$project_root")
elif [[ "${OS:-}" == Windows_NT ]]; then
  windows=true
  windows_root=$(cygpath -w "$project_root")
fi

if "$windows"; then
  if [[ ! -f "$project_root/dist/native/CwPipeBridge.exe" ]]; then
    printf 'Build missing: dist/native/CwPipeBridge.exe (run the native Windows bridge build first).\n' >&2
    exit 1
  fi
  launch_mode=Serial
  if "$simulate"; then
    launch_mode=Simulation
  fi
  status=0
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$windows_root\scripts\rig-launch-windows.ps1" \
    -ProjectRoot "$windows_root" -Mode "$launch_mode" -Port "${CWSTATION_PORT:-COM17}" || status=$?
  exit "$status"
else
  endpoint="/tmp/cwstation-rig-status-${UID}.sock"
  history="$project_root/logs/rig-status-history.jsonl"
  service_args=(--endpoint "$endpoint" --history "$history")
  if "$simulate"; then
    service_args+=(--simulate)
  else
    service_args+=(--port "${CWSTATION_PORT:-/dev/ttyUSB0}" --baud 19200 --confirm-keying-off)
  fi
  cd -- "$project_root"
  exec node dist/apps/rig-launch.js "${service_args[@]}"
fi
