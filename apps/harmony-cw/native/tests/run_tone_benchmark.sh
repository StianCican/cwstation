#!/usr/bin/env bash
# TONE-600 reproducible host benchmark.
#
# Builds two independent projections from the canonical patched multimon-ng
# source: CW_TARGET_TONE_HZ=0 (legacy) and =600 (phone frontend).  Both the
# bridge/harness and the full CLI are compared byte-for-byte, then the known
# 15/20 WPM PCM plus deterministic same-PCM interference / tone-offset cases
# are decoded and scored.  Synthetic cases are host-only algorithm probes,
# not speech, microphone, or phone acceptance.
#
# Usage:
#   run_tone_benchmark.sh OUTDIR [CANONICAL_PATCHED_SOURCE] [REFERENCE_DIR]
set -euo pipefail

OUT=${1:?output directory}
CANON=${2:-}
REF=${3:-"$(cd "$(dirname "$0")/../../../.." && pwd)/data/cw-reference-20261028-145552"}
TESTS_DIR=$(cd "$(dirname "$0")" && pwd)
NATIVE_DIR=$(cd "${TESTS_DIR}/.." && pwd)
APP_ROOT=$(cd "${NATIVE_DIR}/.." && pwd)
REPO_ROOT=$(cd "${APP_ROOT}/../.." && pwd)

[[ -e "${OUT}" ]] && { echo "refusing to overwrite ${OUT}" >&2; exit 1; }
mkdir -p "${OUT}"/{build-legacy,build-600,cli-legacy,cli-600,transcripts,vectors}
OUT=$(cd "${OUT}" && pwd)

echo "== build bridge/harness (legacy and 600) =="
cmake -S "${NATIVE_DIR}" -B "${OUT}/build-legacy" \
  -DCW_TARGET_TONE_HZ=0 -DCW_MULTIMON_CLI="${OUT}/cli-legacy/multimon-ng" >/dev/null
cmake --build "${OUT}/build-legacy" --parallel >/dev/null
cmake -S "${NATIVE_DIR}" -B "${OUT}/build-600" \
  -DCW_TARGET_TONE_HZ=600 -DCW_MULTIMON_CLI="${OUT}/cli-600/multimon-ng" >/dev/null
cmake --build "${OUT}/build-600" --parallel >/dev/null

if [[ -n "${CANON}" ]]; then
  echo "== build canonical CLIs (legacy and 600) =="
  for cfg in legacy 600; do
    flags=""
    [[ "${cfg}" == 600 ]] && flags="-DCW_TARGET_TONE_HZ=600"
    cmake -S "${CANON}" -B "${OUT}/cli-${cfg}" \
      -DCMAKE_BUILD_TYPE=Release -DX11_SUPPORT=OFF \
      -DPULSE_AUDIO_SUPPORT=OFF -DSDL3_SCOPE=OFF -DBUILD_TESTING=OFF \
      -DCMAKE_C_FLAGS="${flags}" >/dev/null
    cmake --build "${OUT}/cli-${cfg}" --parallel >/dev/null
  done
  echo "== bridge/CLI byte contracts (CQ TEST, short/random/one-sample chunks) =="
  bash "${NATIVE_DIR}/tests/run_host_tests.sh" \
    "${OUT}/build-legacy/cw_decode_harness" "${OUT}/build-legacy/cw_bridge_selftest" \
    "${OUT}/testdata-legacy" "${OUT}/cli-legacy/multimon-ng" "${NATIVE_DIR}" \
    >"${OUT}/host-legacy.log" 2>&1
  bash "${NATIVE_DIR}/tests/run_host_tests.sh" \
    "${OUT}/build-600/cw_decode_harness" "${OUT}/build-600/cw_bridge_selftest" \
    "${OUT}/testdata-600" "${OUT}/cli-600/multimon-ng" "${NATIVE_DIR}" \
    >"${OUT}/host-600.log" 2>&1
  echo "PASS: legacy and 600 bridge/CLI contracts (logs in ${OUT})"
else
  echo "SKIP: canonical source not supplied; CLI byte contracts not run" >&2
fi

V="${OUT}/vectors"
cp "${REF}/cw-15wpm-600hz.s16le" "${V}/clean-15wpm.s16le"
cp "${REF}/cw-20wpm-600hz.s16le" "${V}/clean-20wpm.s16le"

echo "== deterministic same-PCM interferers (out-of-band tones) =="
python3 - "${V}/clean-20wpm.s16le" "${V}" <<'PY'
import math, struct, sys
src, out = sys.argv[1], sys.argv[2]
raw = open(src, 'rb').read()
pcm = list(struct.unpack('<%dh' % (len(raw)//2), raw))
for hz, name in ((1000.0, 'int-1000hz'), (1500.0, 'int-1500hz')):
    peak = int(0.18 * 32767)
    mixed = bytearray()
    for i, s in enumerate(pcm):
        v = s + int(peak * math.sin(2*math.pi*hz*i/22050.0))
        mixed += struct.pack('<h', max(-32768, min(32767, v)))
    open(f'{out}/{name}.s16le', 'wb').write(mixed)
PY

echo "== 590/610 Hz target-offset vectors (reuse existing signal encoder) =="
cat > "${OUT}/gen_offset.mjs" <<'JS'
import {readFileSync, writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const [refDir, outDir, repoRoot] = process.argv.slice(2);
const {encodeCwText, buildTimeline, buildEnvelope} =
  await import(pathToFileURL(`${repoRoot}/dist/packages/signal/src/index.js`));
const text = readFileSync(`${refDir}/expected.txt`, 'utf8').trim();
const sr = 22050, wpm = 20, amp = 0.45;
for (const tone of [590, 610]) {
  const t = buildTimeline(encodeCwText(text), sr, wpm);
  const e = buildEnvelope(t.segments, t.sampleCount, 5, sr);
  const pad = sr * 3;
  const pcm = Buffer.alloc((t.sampleCount + pad*2) * 2);
  for (let i = 0; i < t.sampleCount; i++)
    pcm.writeInt16LE(Math.round(32767*amp*e[i]*Math.sin(2*Math.PI*tone*i/sr)), (i+pad)*2);
  writeFileSync(`${outDir}/tone-${tone}hz-20wpm.s16le`, pcm);
}
JS
node "${OUT}/gen_offset.mjs" "${REF}" "${V}" "${REPO_ROOT}"

echo "== decode and score =="
python3 - "${OUT}" "${REF}" <<'PY'
import json, os, subprocess, sys
out, ref = sys.argv[1], sys.argv[2]
cases = [
    ('clean-15wpm', 'clean-15wpm.s16le'),
    ('clean-20wpm', 'clean-20wpm.s16le'),
    ('offset-590hz-20wpm', 'tone-590hz-20wpm.s16le'),
    ('offset-610hz-20wpm', 'tone-610hz-20wpm.s16le'),
    ('interferer-1000hz-20wpm', 'int-1000hz.s16le'),
    ('interferer-1500hz-20wpm', 'int-1500hz.s16le'),
]
rows = []
for name, vector in cases:
    row = {'case': name}
    for variant in ('legacy', 'tone600'):
        harness = f'{out}/build-{ "legacy" if variant == "legacy" else "600" }/cw_decode_harness'
        txt = f'{out}/transcripts/{name}.{variant}.txt'
        with open(txt, 'wb') as fh:
            subprocess.run([harness, f'{out}/vectors/{vector}'], stdout=fh, check=True)
        scored = json.loads(subprocess.run(
            ['python3', f'{ref}/score.py', txt], capture_output=True, text=True, check=True).stdout)
        s = scored['letters_and_digits']
        row[variant] = {'cer': s['character_error_rate_percent'],
                        'edit_distance': s['edit_distance'],
                        'sub': s['substitutions'], 'del': s['deletions'],
                        'ins': s['insertions'], 'exact': s['exact_match']}
    row['delta_cer'] = round(row['tone600']['cer'] - row['legacy']['cer'], 3)
    rows.append(row)
with open(f'{out}/benchmark.json', 'w') as fh:
    json.dump(rows, fh, indent=2)
with open(f'{out}/benchmark.md', 'w') as fh:
    fh.write('| case | legacy CER % | 600 Hz CER % | delta pp | legacy edits | 600 edits |\n')
    fh.write('|---|---|---|---|---|---|\n')
    for r in rows:
        l, t = r['legacy'], r['tone600']
        fh.write(f"| {r['case']} | {l['cer']:.3f} | {t['cer']:.3f} | {r['delta_cer']:+.3f} | "
                 f"{l['edit_distance']} | {t['edit_distance']} |\n")
print(open(f'{out}/benchmark.md').read())
PY
python3 - "${OUT}/benchmark.json" <<'PYGATE'
import json, sys
rows = json.load(open(sys.argv[1]))
for row in rows:
    if row['case'].startswith('clean-') and row['delta_cer'] > 0:
        raise SystemExit('FAIL: clean input regressed: ' + row['case'])
print('PASS: clean input CER did not regress; synthetic results do not establish phone quality')
PYGATE
echo "PASS: tone benchmark complete; see ${OUT}/benchmark.json"
