#!/usr/bin/env bash
# Host 对照测试：同一 PCM 字节分别进入 CwDecoder 桥接与已打补丁的
# multimon-ng CLI，比较完整 stdout 字节；并覆盖单实例/clear 生命周期。
set -euo pipefail

HARNESS=${1:?harness path}
SELFTEST=${2:?selftest path}
OUTDIR=${3:?output directory}
CLI=${4:-}
NATIVE_DIR=${5:?native source directory}

GEN="${NATIVE_DIR}/tools/make_test_vector.mjs"

if ! command -v node >/dev/null 2>&1; then
  echo "FAIL: node is required to generate the temporary CQ TEST vector" >&2
  exit 1
fi
if [[ -z "${CLI}" ]]; then
  echo "FAIL: CW_MULTIMON_CLI is empty; pass -DCW_MULTIMON_CLI=<patched multimon-ng>" >&2
  exit 1
fi
if [[ ! -x "${CLI}" ]]; then
  echo "FAIL: patched multimon-ng CLI is not executable: ${CLI}" >&2
  exit 1
fi

mkdir -p "${OUTDIR}"
node "${GEN}" "${OUTDIR}" > "${OUTDIR}/vector-meta.stdout.json"

printf 'CQ TEST \n' > "${OUTDIR}/expected-tail.bin"
printf 'CQ TES\n' > "${OUTDIR}/expected-notail.bin"

run_cli() {
  local input=$1
  local output=$2
  "${CLI}" -q -c -a MORSE_CW -t raw - < "${input}" > "${output}"
}

compare() {
  local name=$1
  local left=$2
  local right=$3
  if ! cmp -s "${left}" "${right}"; then
    echo "FAIL: ${name}" >&2
    echo "left (${left}):" >&2
    od -An -tx1 "${left}" >&2
    echo "right (${right}):" >&2
    od -An -tx1 "${right}" >&2
    exit 1
  fi
  echo "PASS: ${name}" >&2
}

run_cli "${OUTDIR}/cq-test.s16le" "${OUTDIR}/cli-notail.bin"
run_cli "${OUTDIR}/cq-test-tail.s16le" "${OUTDIR}/cli-tail.bin"

# 1) 相同字节：文件自带 0.5 秒尾静音，桥接不再合成尾静音。
"${HARNESS}" --no-tail "${OUTDIR}/cq-test-tail.s16le" \
  > "${OUTDIR}/harness-tailfile.bin"
compare "tail-in-file: bridge(no-tail) vs CLI" \
  "${OUTDIR}/harness-tailfile.bin" "${OUTDIR}/cli-tail.bin"
compare "tail-in-file: expected CQ TEST + newline" \
  "${OUTDIR}/harness-tailfile.bin" "${OUTDIR}/expected-tail.bin"

# 2) 相同字节：无尾静音，双方都在 EOF 收尾。
"${HARNESS}" --no-tail "${OUTDIR}/cq-test.s16le" \
  > "${OUTDIR}/harness-notail.bin"
compare "no-tail: bridge(no-tail) vs CLI" \
  "${OUTDIR}/harness-notail.bin" "${OUTDIR}/cli-notail.bin"
compare "no-tail: expected CQ TES + newline" \
  "${OUTDIR}/harness-notail.bin" "${OUTDIR}/expected-notail.bin"

# 3) 桥接自合成 0.5 秒尾静音，必须与 CLI 读入带尾静音文件一致。
"${HARNESS}" "${OUTDIR}/cq-test.s16le" > "${OUTDIR}/harness-synth-tail.bin"
compare "synthesized-tail: bridge(default) vs CLI(tail file)" \
  "${OUTDIR}/harness-synth-tail.bin" "${OUTDIR}/cli-tail.bin"
compare "synthesized-tail: expected CQ TEST + newline" \
  "${OUTDIR}/harness-synth-tail.bin" "${OUTDIR}/expected-tail.bin"

# 4) 固定短块。
"${HARNESS}" --no-tail --chunk 37 "${OUTDIR}/cq-test-tail.s16le" \
  > "${OUTDIR}/harness-chunk37.bin"
compare "short chunk 37: bridge vs CLI" \
  "${OUTDIR}/harness-chunk37.bin" "${OUTDIR}/cli-tail.bin"

# 5) 随机块长（确定性种子）。
"${HARNESS}" --no-tail --chunk random:20261028 "${OUTDIR}/cq-test-tail.s16le" \
  > "${OUTDIR}/harness-random.bin"
compare "random chunks (seed 20261028): bridge vs CLI" \
  "${OUTDIR}/harness-random.bin" "${OUTDIR}/cli-tail.bin"

# 6) 单样本块，覆盖极短分段。
"${HARNESS}" --no-tail --chunk 1 "${OUTDIR}/cq-test.s16le" \
  > "${OUTDIR}/harness-chunk1.bin"
compare "one-sample chunks: bridge vs CLI" \
  "${OUTDIR}/harness-chunk1.bin" "${OUTDIR}/cli-notail.bin"

# 7) 随机块 + 桥接合成尾静音。
"${HARNESS}" --chunk random:7 "${OUTDIR}/cq-test.s16le" \
  > "${OUTDIR}/harness-random-synth-tail.bin"
compare "random chunks + synthesized tail: bridge vs CLI" \
  "${OUTDIR}/harness-random-synth-tail.bin" "${OUTDIR}/cli-tail.bin"

# 8) 单实例拒绝与 clear 不重置 decoder。
"${SELFTEST}" "${OUTDIR}/cq-test.s16le"

echo "PASS: all host bridge contract checks" >&2
