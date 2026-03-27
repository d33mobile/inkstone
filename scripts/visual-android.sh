#!/bin/bash
set -euo pipefail
# Mirror Android emulator via scrcpy → noVNC, optimized for mobile viewing.
# Usage:
#   ./scripts/visual-android.sh
#   ssh -L 6080:localhost:6080 user@host
#   open http://localhost:6080/vnc_lite.html?autoconnect=true&resize=scale

ANDROID_SDK="${ANDROID_SDK_ROOT:-/mnt/HC_Volume_103952790/android/sdk}"
export PATH="${ANDROID_SDK}/platform-tools:${PATH}"

XDISPLAY=98
VNC_PORT=5900
HTTP_PORT=6080
NOVNC_DIR=/usr/share/novnc
# scrcpy max-size: half the 1080x1920 device → 540x960 window
SCRCPY_MAX=540
# Xvfb just big enough for the scrcpy window
XRES="${SCRCPY_MAX}x$((SCRCPY_MAX * 1920 / 1080))"

PIDS=()
cleanup() {
  echo "Cleaning up..."
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# 1. Fresh Xvfb sized to the scrcpy window
pkill -f "Xvfb :${XDISPLAY}" 2>/dev/null || true
sleep 0.5
echo "Starting Xvfb :${XDISPLAY} at ${XRES}..."
Xvfb ":${XDISPLAY}" -screen 0 "${XRES}x24" +extension RANDR &
PIDS+=($!)
sleep 1
export DISPLAY=":${XDISPLAY}"

# 2. scrcpy: portrait, no audio, downsized
echo "Starting scrcpy (max-size=${SCRCPY_MAX})..."
scrcpy --no-audio --max-size="${SCRCPY_MAX}" \
       --window-x=0 --window-y=0 --window-borderless &
PIDS+=($!)
sleep 3

# 3. x11vnc
echo "Starting x11vnc..."
x11vnc -display ":${XDISPLAY}" -rfbport "${VNC_PORT}" \
       -localhost -shared -forever -nopw -noxdamage -q &
PIDS+=($!)
sleep 1

# 4. websockify + noVNC
echo "Starting noVNC on port ${HTTP_PORT}..."
websockify --web="${NOVNC_DIR}" "${HTTP_PORT}" "localhost:${VNC_PORT}" &
PIDS+=($!)
sleep 1

cat <<EOF

=== Ready ===
On your local machine:
  ssh -L ${HTTP_PORT}:localhost:${HTTP_PORT} user@<this-host>

Then open (works on phone too):
  http://localhost:${HTTP_PORT}/vnc_lite.html?autoconnect=true&resize=scale&quality=6&compression=2

Press Ctrl+C to stop.
EOF
wait
