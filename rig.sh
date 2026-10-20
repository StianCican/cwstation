#!/usr/bin/env bash
set -euo pipefail

# Default: supervised read-only monitoring. Explicit --cw-trial reuses the
# one-shot session directly; its legacy script forwards here.

project_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if [[ "${1:-}" == --cw-trial ]]; then
  shift
  if [[ ! -f "$project_root/dist/apps/rig-controld.js" ]]; then
    printf 'Build missing: run npm run build in %s first.\n' "$project_root" >&2
    exit 1
  fi
  cd -- "$project_root"
  if [[ -n "${WSL_INTEROP:-}" || -r /proc/sys/fs/binfmt_misc/WSLInterop ]]; then
    windows_node="${CWSTATION_WINDOWS_NODE:-/mnt/d/Program Files/nodejs/node.exe}"
    if [[ ! -x "$windows_node" ]]; then
      printf 'Windows Node not found: %s\n' "$windows_node" >&2
      exit 1
    fi
    windows_root=$(wslpath -w "$project_root")
    exec "$windows_node" "$windows_root\\dist\\apps\\rig-controld.js" --cw-trial "$@"
  fi
  exec node dist/apps/rig-controld.js --cw-trial "$@"
fi
if [[ "${1:-}" == --mode ]]; then
  # Frozen IPC experiment, retained for compatibility and regression tests.
  cd -- "$project_root"
  exec node dist/apps/rig-launch.js "$@"
fi
simulate=false
case "${1:-}" in
  "") ;;
  --simulate) simulate=true ;;
  -h|--help)
    printf 'Usage: bash rig.sh [--simulate]\n       bash rig.sh --cw-trial <trial options; --help for details>\n       bash rig.sh --mode cw-trial --simulate [--demo E|TEST] (frozen IPC experiment)\nDefault: IC-7300, COM17 on Windows/WSL, 19200 baud, read-only.\nHistory: logs/rig-status-history.jsonl\n'
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
