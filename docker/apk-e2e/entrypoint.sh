#!/bin/bash
# Entrypoint: boot AVD with KVM acceleration, install APK at $APK_PATH,
# attach to its WebView devtools, run the e2e test, exit with its code.
#
# Expected mounts/env:
#   /app                   project root with scripts/, package.json, node_modules
#   APK_PATH               path to debug APK to install (default: /apk/inkstone.apk)
#   PKG                    Android package id (default: me.skishore.inkstone)
set -euo pipefail

APK_PATH="${APK_PATH:-/apk/inkstone.apk}"
PKG="${PKG:-me.skishore.inkstone}"
EMU_LOG="${EMU_LOG:-/tmp/emu.log}"

echo "=== Sanity ==="
test -e /dev/kvm || { echo "FATAL: /dev/kvm not available — pass --device /dev/kvm and ensure host has nested virt"; exit 3; }
ls -l /dev/kvm
test -f "$APK_PATH" || { echo "FATAL: APK not at $APK_PATH"; exit 3; }

mkdir -p /root/.android
cp -r /opt/android-sdk-skel/avd /root/.android/ 2>/dev/null || true

# Shrink AVD partitions for CI-sized disks (default tries to allocate ~8 GB
# userdata, which exceeds /var on small runners).
if [ -f /root/.android/avd/testavd.avd/config.ini ]; then
  sed -i \
    -e 's/^disk\.dataPartition\.size=.*/disk.dataPartition.size=2048M/' \
    -e 's/^hw\.ramSize=.*/hw.ramSize=2048/' \
    /root/.android/avd/testavd.avd/config.ini
fi

echo "=== Boot emulator ==="
nohup emulator -avd testavd -no-window -no-audio -no-boot-anim \
  -gpu swiftshader_indirect -accel on -netdelay none -netspeed full \
  -partition-size 2048 \
  > "$EMU_LOG" 2>&1 &
EMU_PID=$!
echo "emu pid $EMU_PID, log $EMU_LOG"

# Wait for boot_completed
for i in $(seq 1 60); do
  out=$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r\n' || true)
  if [ "$out" = "1" ]; then
    echo "boot_completed at t=${i}*5s"
    break
  fi
  sleep 5
done
if [ "$(adb shell getprop sys.boot_completed | tr -d '\r\n')" != "1" ]; then
  echo "FATAL: emulator did not finish booting"
  tail -50 "$EMU_LOG" || true
  exit 4
fi

echo "=== Install APK ==="
adb install -r "$APK_PATH"

echo "=== Launch app ==="
adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null
# Auto-dismiss the notification permission dialog if it shows up
sleep 8
adb shell pm grant "$PKG" android.permission.POST_NOTIFICATIONS 2>/dev/null || true
sleep 3

# Discover the WebView devtools unix socket name
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
cd /app
exec node scripts/test-apk-e2e.cjs "$@"
