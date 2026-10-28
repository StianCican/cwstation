#!/usr/bin/env bash
# Host-only lifecycle/concurrency checks for the real capture_session.cpp.
# Generates the deterministic CQ TEST PCM with the existing native tool; this
# does not build, install, run, or claim anything about a HarmonyOS device.
set -euo pipefail

TESTS_DIR=$(cd "$(dirname "$0")" && pwd)
APP_ROOT=$(cd "${TESTS_DIR}/.." && pwd)
BUILD_DIR="${TESTS_DIR}/build"
TESTDATA="${BUILD_DIR}/testdata"

if ! command -v node >/dev/null 2>&1; then
  echo "FAIL: node is required by native/tools/make_test_vector.mjs" >&2
  exit 1
fi
if [[ ! -f "${APP_ROOT}/../../dist/packages/signal/src/index.js" ]]; then
  echo "FAIL: dist/packages/signal is missing; run the project build that produces it first" >&2
  exit 1
fi

mkdir -p "${TESTDATA}" "${BUILD_DIR}"
node "${APP_ROOT}/native/tools/make_test_vector.mjs" "${TESTDATA}" \
  > "${TESTDATA}/vector-meta.stdout.json"

cmake -S "${TESTS_DIR}" -B "${BUILD_DIR}"
cmake --build "${BUILD_DIR}" --parallel

"${BUILD_DIR}/capture_session_host_test" "${TESTDATA}/cq-test.s16le"
