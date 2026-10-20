#!/usr/bin/env bash
set -euo pipefail

# Compatibility alias; runtime selection and argument forwarding live in rig.sh.
project_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
exec bash "$project_root/rig.sh" --cw-trial "$@"
