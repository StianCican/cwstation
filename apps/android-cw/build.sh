#!/usr/bin/env bash
# Build the Android CW debug APK with the task-specific toolchain.
# No Gradle wrapper download and no changes outside apps/android-cw.
set -euo pipefail
cd "$(dirname "$0")"

export ANDROID_HOME="${ANDROID_HOME_OVERRIDE:-${ANDROID_SDK_ROOT:-/home/li0214/android-toolchain/sdk}}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export JAVA_HOME="${JAVA_HOME_OVERRIDE:-/home/li0214/android-toolchain/jdk/usr/lib/jvm/java-17-openjdk-amd64}"
GRADLE_BIN="${GRADLE_BIN:-/home/li0214/.gradle/wrapper/dists/gradle-9.1.0-bin/a7zz1zpvyl3jaouarz82m4yky/gradle-9.1.0/bin/gradle}"
TASK="${1:-:app:assembleDebug}"

if [[ ! -x "$GRADLE_BIN" ]]; then
  echo "Gradle 9.1.0 executable not found: $GRADLE_BIN" >&2
  echo "Set GRADLE_BIN to the existing Gradle 9.1.0 binary." >&2
  exit 2
fi
if [[ ! -x "$JAVA_HOME/bin/java" ]]; then
  echo "JDK 17 not found: $JAVA_HOME" >&2
  echo "Set JAVA_HOME_OVERRIDE to an existing JDK 17." >&2
  exit 2
fi
if [[ ! -d "$ANDROID_HOME/platforms/android-36" ]]; then
  echo "Android SDK platform 36 not found under: $ANDROID_HOME" >&2
  exit 2
fi

echo "Gradle: $GRADLE_BIN"
echo "JAVA_HOME: $JAVA_HOME"
echo "ANDROID_HOME: $ANDROID_HOME"
echo "Task: $TASK"

exec "$GRADLE_BIN" --no-daemon "$TASK" "${@:2}"
