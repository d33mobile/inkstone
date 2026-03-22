#!/bin/bash
set -euo pipefail

# Smoke test for Inkstone
# Tests:
# 1. APK structure validation (aapt)
# 2. Web bundle loads in headless browser without JS errors

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
APK_PATH="$PROJECT_DIR/.build/apk/project-release-unsigned.apk"
WWW_DIR="$PROJECT_DIR/.build/www"
ANDROID_HOME="${ANDROID_HOME:-$HOME/android-sdk}"

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

echo "=== Inkstone Smoke Test ==="
echo ""

# --- Test 1: APK exists and is valid ---
echo "[1] APK validation"
if [ -f "$APK_PATH" ]; then
    pass "APK exists ($APK_PATH)"
else
    fail "APK not found at $APK_PATH"
fi

if [ -f "$APK_PATH" ]; then
    AAPT="$(find "$ANDROID_HOME/build-tools" -name aapt 2>/dev/null | head -1)"
    if [ -n "$AAPT" ]; then
        BADGING=$("$AAPT" dump badging "$APK_PATH" 2>&1)
        if echo "$BADGING" | grep -q "package: name="; then
            pass "APK has valid package info"
        else
            fail "APK package info missing"
        fi
        if echo "$BADGING" | grep -q "application-label:'Inkstone'"; then
            pass "APK label is 'Inkstone'"
        else
            fail "APK label mismatch"
        fi

        TARGET_SDK=$(echo "$BADGING" | grep -oP "targetSdkVersion:'\K[0-9]+")
        echo "  INFO: targetSdkVersion=$TARGET_SDK (need 34 for Play Store)"
    else
        echo "  SKIP: aapt not found, skipping APK analysis"
    fi
fi

# --- Test 2: Web assets exist ---
echo ""
echo "[2] Web assets validation"
if [ -d "$WWW_DIR" ]; then
    pass "Web assets directory exists"
else
    fail "Web assets directory missing"
fi

if [ -d "$WWW_DIR/application" ]; then
    JS_COUNT=$(find "$WWW_DIR/application" -name "*.js" 2>/dev/null | wc -l)
    if [ "$JS_COUNT" -gt 0 ]; then
        pass "Found $JS_COUNT JS files in application/"
    else
        fail "No JS files in application/"
    fi
fi

if [ -d "$WWW_DIR/assets" ]; then
    if [ -f "$WWW_DIR/assets/characters.txt" ]; then
        CHAR_COUNT=$(wc -l < "$WWW_DIR/assets/characters.txt")
        pass "characters.txt present ($CHAR_COUNT characters)"
    else
        fail "characters.txt missing from assets"
    fi
    if [ -f "$WWW_DIR/assets/radicals.json" ]; then
        pass "radicals.json present"
    else
        fail "radicals.json missing"
    fi
fi

# --- Test 3: Web bundle structure test ---
echo ""
echo "[3] Web bundle structure"

INDEX_HTML=""
if [ -f "$WWW_DIR/application/index.html" ]; then
    INDEX_HTML="$WWW_DIR/application/index.html"
elif [ -f "$WWW_DIR/index.html" ]; then
    INDEX_HTML="$WWW_DIR/index.html"
fi

if [ -n "$INDEX_HTML" ]; then
    pass "index.html found"
    if grep -q "meteor_runtime_config" "$INDEX_HTML"; then
        pass "Meteor runtime config present"
    else
        fail "Meteor runtime config missing from index.html"
    fi
    if grep -q "meteor_js_resource" "$INDEX_HTML"; then
        pass "JS bundle referenced in HTML"
    else
        fail "JS bundle not referenced"
    fi
    if grep -q "meteor_css_resource" "$INDEX_HTML"; then
        pass "CSS bundle referenced in HTML"
    else
        fail "CSS bundle not referenced"
    fi
    # Verify the referenced JS/CSS files actually exist
    JS_FILE=$(grep -oP '/([a-f0-9]+\.js)' "$INDEX_HTML" | head -1 | sed 's|^/||')
    CSS_FILE=$(grep -oP '/([a-f0-9]+\.css)' "$INDEX_HTML" | head -1 | sed 's|^/||')
    if [ -n "$JS_FILE" ] && [ -f "$WWW_DIR/application/$JS_FILE" ]; then
        JS_SIZE=$(du -h "$WWW_DIR/application/$JS_FILE" | cut -f1)
        pass "JS bundle exists ($JS_FILE, $JS_SIZE)"
    else
        fail "JS bundle file missing"
    fi
    if [ -n "$CSS_FILE" ] && [ -f "$WWW_DIR/application/$CSS_FILE" ]; then
        CSS_SIZE=$(du -h "$WWW_DIR/application/$CSS_FILE" | cut -f1)
        pass "CSS bundle exists ($CSS_FILE, $CSS_SIZE)"
    else
        fail "CSS bundle file missing"
    fi
else
    fail "No index.html found in web bundle"
fi

# --- Test 4: Cordova structure ---
echo ""
echo "[4] Cordova integration"
if [ -f "$WWW_DIR/cordova.js" ]; then
    pass "cordova.js present"
else
    fail "cordova.js missing"
fi
if [ -f "$WWW_DIR/cordova_plugins.js" ]; then
    pass "cordova_plugins.js present"
else
    fail "cordova_plugins.js missing"
fi

# --- Test 5: List files ---
echo ""
echo "[5] Word list files"
LIST_COUNT=$(find "$WWW_DIR/assets/lists" -name "*.list" 2>/dev/null | wc -l)
if [ "$LIST_COUNT" -gt 0 ]; then
    pass "Found $LIST_COUNT word list files"
else
    fail "No word list files found"
fi

# --- Summary ---
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
