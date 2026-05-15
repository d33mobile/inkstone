#!/bin/bash
# Shared test orchestration script used by both the docker entrypoint (for
# local SSH testing) and the GitLab CI shell runner. Expects:
#
#   $ANDROID_SDK_ROOT      Android SDK location (cmdline-tools/emulator/platform-tools below it)
#   $APK_PATH              path to the debug APK to install
#   $PKG                   Android package id (default: me.skishore.inkstone)
#   $AVD_NAME              AVD to boot (default: testavd)
#   $EMU_LOG               where to write emulator log (default: /tmp/emu.log)
#
# Steps: boot AVD with KVM, wait for boot_completed, install APK, launch app,
# grant POST_NOTIFICATIONS, forward WebView devtools to localhost:9222, run
# scripts/test-apk-e2e.cjs, propagate its exit code.
set -euo pipefail

: "${ANDROID_SDK_ROOT:?ANDROID_SDK_ROOT must be set}"
: "${APK_PATH:?APK_PATH must point to the debug APK to install}"
PKG="${PKG:-me.skishore.inkstone}"
AVD_NAME="${AVD_NAME:-testavd}"
EMU_LOG="${EMU_LOG:-/tmp/emu.log}"

export PATH="$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$ANDROID_SDK_ROOT/emulator:$ANDROID_SDK_ROOT/platform-tools:$PATH"

echo "=== Sanity ==="
test -e /dev/kvm || { echo "FATAL: /dev/kvm not available"; exit 3; }
ls -l /dev/kvm
test -f "$APK_PATH" || { echo "FATAL: APK not at $APK_PATH"; exit 3; }

# Shrink AVD partitions for CI-sized disks (default tries ~8 GB userdata).
AVD_CONF="$HOME/.android/avd/${AVD_NAME}.avd/config.ini"
if [ -f "$AVD_CONF" ]; then
  sed -i \
    -e 's/^disk\.dataPartition\.size=.*/disk.dataPartition.size=2048M/' \
    -e 's/^hw\.ramSize=.*/hw.ramSize=2048/' \
    "$AVD_CONF"
fi

echo "=== Boot emulator ==="
nohup emulator -avd "$AVD_NAME" -no-window -no-audio -no-boot-anim \
  -gpu swiftshader_indirect -accel on -netdelay none -netspeed full \
  -partition-size 2048 \
  > "$EMU_LOG" 2>&1 &
EMU_PID=$!
echo "emu pid $EMU_PID, log $EMU_LOG"
trap 'kill -9 "$EMU_PID" 2>/dev/null || true' EXIT

# Wait for boot_completed (up to 5 min)
for i in $(seq 1 60); do
  out=$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r\n' || true)
  if [ "$out" = "1" ]; then
    echo "boot_completed at t=$((i * 5))s"
    break
  fi
  sleep 5
done
if [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r\n')" != "1" ]; then
  echo "FATAL: emulator did not boot within 5 minutes"
  tail -50 "$EMU_LOG" || true
  exit 4
fi

echo "=== Install APK ==="
adb install -r "$APK_PATH"

echo "=== Launch app and grant notification permission ==="
adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null
sleep 8
adb shell pm grant "$PKG" android.permission.POST_NOTIFICATIONS 2>/dev/null || true
sleep 3

echo "=== Forward WebView devtools to localhost:9222 ==="
WEBVIEW_SOCK=""
for i in $(seq 1 12); do
  WEBVIEW_SOCK=$(adb shell cat /proc/net/unix 2>/dev/null \
                  | awk '/webview_devtools_remote/ {print $NF; exit}' \
                  | tr -d '\r')
  if [ -n "$WEBVIEW_SOCK" ]; then break; fi
  sleep 2
done
if [ -z "$WEBVIEW_SOCK" ]; then
  echo "FATAL: WebView devtools socket not exposed — APK may not be debuggable"
  adb shell dumpsys package "$PKG" | grep -i debug || true
  exit 5
fi
echo "WebView socket: $WEBVIEW_SOCK"
adb forward tcp:9222 "localabstract:${WEBVIEW_SOCK#@}"

echo "=== Run e2e test ==="
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/test-apk-e2e.cjs" "$@"
