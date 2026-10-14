#!/usr/bin/env bash
set -euo pipefail

# Explicit, interactive-only CW trial entry. The default rig.sh path remains read-only.
project_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
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
