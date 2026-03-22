#!/bin/bash
set -euo pipefail

# Browser-level test: serves www/ and checks for 404s, JS errors, and DOM rendering.
# Catches asset loading issues that static analysis misses.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
WWW_DIR="$PROJECT_DIR/www"
PORT=8770
PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

echo "=== Browser Asset Loading Test ==="
echo ""

# Start HTTP server
cd "$WWW_DIR"
python3 -m http.server $PORT > /tmp/inkstone-server.log 2>&1 &
SERVER_PID=$!
sleep 1

cleanup() { kill $SERVER_PID 2>/dev/null; }
trap cleanup EXIT

# --- Test 1: Key asset URLs return 200 ---
echo "[1] Asset URL checks"
ASSETS=(
    "/fonts/ionicons.ttf"
    "/fonts/anke-calligraphic-2.00.ttf"
    "/fonts/arphic-gukai.ttf"
    "/graphics/background.jpg"
    "/graphics/foreground.jpg"
    "/graphics/swash.svg"
    "/assets/characters.txt"
    "/assets/radicals.json"
    "/assets/characters_v2/100"
    "/assets/lists/nhsk1.list"
    "/assets/lists/demo.list"
)
for asset in "${ASSETS[@]}"; do
    STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT$asset")
    if [ "$STATUS" = "200" ]; then
        pass "$asset → $STATUS"
    else
        fail "$asset → $STATUS (expected 200)"
    fi
done

# --- Test 2: Load app in headless Chromium, check for errors ---
echo ""
echo "[2] Headless browser load"
BROWSER_LOG=$(mktemp)
BROWSER_DOM=$(mktemp)

timeout 20 chromium --headless --disable-gpu --no-sandbox \
    --enable-logging=stderr \
    --dump-dom \
    "http://localhost:$PORT/index.html" \
    > "$BROWSER_DOM" 2> "$BROWSER_LOG" || true

# Check for JS console errors
JS_ERRORS=$(grep "CONSOLE.*error\|CONSOLE.*Error\|CONSOLE.*Uncaught" "$BROWSER_LOG" 2>/dev/null | grep -v "favicon" || true)
if [ -z "$JS_ERRORS" ]; then
    pass "No JS console errors"
else
    fail "JS console errors found:"
    echo "$JS_ERRORS" | head -5 | sed 's/^/    /'
fi

# Check for 404 responses in server log
FOUR_OH_FOURS=$(grep " 404 " /tmp/inkstone-server.log 2>/dev/null | grep -v "favicon" || true)
if [ -z "$FOUR_OH_FOURS" ]; then
    pass "No 404 responses (excluding favicon)"
else
    fail "404 responses found:"
    echo "$FOUR_OH_FOURS" | head -10 | sed 's/^/    /'
fi

# Check DOM rendered app-specific elements
if grep -q "ion-nav-view\|ion-header-bar\|ion-content\|layout" "$BROWSER_DOM" 2>/dev/null; then
    pass "App DOM rendered (found Ionic elements)"
else
    fail "App DOM did not render (no Ionic elements found)"
fi

rm -f "$BROWSER_LOG" "$BROWSER_DOM"

# --- Test 3: Screenshot ---
echo ""
echo "[3] Screenshots"
SCREENSHOT="/tmp/inkstone-screenshot.png"
timeout 15 chromium --headless --disable-gpu --no-sandbox \
    --window-size=400,800 \
    --screenshot="$SCREENSHOT" \
    "http://localhost:$PORT/index.html" 2>/dev/null || true

if [ -f "$SCREENSHOT" ] && [ -s "$SCREENSHOT" ]; then
    SIZE=$(du -h "$SCREENSHOT" | cut -f1)
    pass "Screenshot captured ($SCREENSHOT, $SIZE)"
else
    fail "Screenshot not captured"
fi

# --- Summary ---
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
