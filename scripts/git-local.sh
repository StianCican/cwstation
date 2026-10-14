#!/usr/bin/env bash
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
exec git --git-dir="$root/.git-local" --work-tree="$root" "$@"
