#!/usr/bin/env bash
# Host JVM loads actual production JNI adapter; only Android logging is stubbed.
# No Android audio/UI/device claims. OUT must not already exist.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
OUT=${1:?new output directory}
[[ ! -e "$OUT" ]] || { echo 'Output already exists' >&2; exit 2; }
mkdir -p "$OUT/include/android" "$OUT/classes"
OUT=$(cd "$OUT" && pwd)
TASK_JDK=${JAVA_HOME_OVERRIDE:-/home/li0214/android-toolchain/jdk/usr/lib/jvm/java-17-openjdk-amd64}
cat > "$OUT/include/android/log.h" <<'HEADER'
#pragma once
#define ANDROID_LOG_ERROR 6
static inline int __android_log_print(int level,const char* tag,const char* fmt,...) { return 0; }
HEADER
VENDOR="$ROOT/apps/harmony-cw/third_party/multimon-ng"
BRIDGE="$ROOT/apps/harmony-cw/native"
cc -fPIC -O2 -DNO_X11 -DMAX_VERBOSE_LEVEL=3 -DCW_TARGET_TONE_HZ=600 -I"$VENDOR" \
  -c "$VENDOR/demod_morse.c" -o "$OUT/morse.o"
c++ -shared -fPIC -O2 -std=c++17 -DNO_X11 -DMAX_VERBOSE_LEVEL=3 -DCW_TARGET_TONE_HZ=600 \
  -I"$BRIDGE" -I"$VENDOR" -I"$OUT/include" -I"$TASK_JDK/include" -I"$TASK_JDK/include/linux" \
  "$ROOT/apps/android-cw/app/src/main/cpp/jni_bridge.cpp" "$BRIDGE/decoder_core.cpp" \
  "$OUT/morse.o" -pthread -lm -o "$OUT/libcwdecoder_jni.so"
"$TASK_JDK/bin/javac" -d "$OUT/classes" \
  "$ROOT/apps/android-cw/app/src/main/java/org/cwstation/androidcw/CwNative.java" \
  "$ROOT/apps/android-cw/tests/JniSmoke.java"
"$TASK_JDK/bin/java" -Djava.library.path="$OUT" -cp "$OUT/classes" org.cwstation.androidcw.JniSmoke \
  "$ROOT/data/cw-reference-20261028-145552/cw-20wpm-600hz.s16le" "$OUT/actual.txt"
python3 "$ROOT/data/cw-reference-20261028-145552/score.py" "$OUT/actual.txt" > "$OUT/score.json"
python3 - "$OUT/score.json" <<'GATE'
import sys,json
s=json.load(open(sys.argv[1]))
assert s['letters_and_digits']['exact_match'],s
print('PASS: JNI transcript exactly matches all135 expected non-space characters')
GATE
