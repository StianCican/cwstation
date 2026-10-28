#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
clt_root="${HARMONY_CLT_HOME:-/home/li0214/deveco-clt-26.0.0/command-line-tools}"
if [[ ! -x "$clt_root/bin/hvigorw" || ! -x "$clt_root/bin/ohpm" ]]; then
  echo "Set HARMONY_CLT_HOME to an existing DevEco command-line-tools directory" >&2
  exit 2
fi
"$clt_root/bin/ohpm" install
"$clt_root/bin/hvigorw" assembleHap --no-daemon -p product=default -p buildMode=debug "$@"
