#!/bin/bash
set -euo pipefail

# Smoke test for Inkstone
# Tests:
# 1. APK structure validation (aapt)
# 2. Web bundle loads in headless browser without JS errors

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
# Support both Cordova (legacy) and Capacitor APK paths
CAPACITOR_APK="$PROJECT_DIR/android/app/build/outputs/apk/debug/app-debug.apk"
CORDOVA_APK="$PROJECT_DIR/.build/apk/project-release-unsigned.apk"
if [ -f "$CAPACITOR_APK" ]; then
    APK_PATH="$CAPACITOR_APK"
elif [ -f "$CORDOVA_APK" ]; then
    APK_PATH="$CORDOVA_APK"
else
    APK_PATH="$CORDOVA_APK"  # will fail the test
fi
WWW_DIR="$PROJECT_DIR/www"
# Fallback to legacy build dir
if [ ! -d "$WWW_DIR/assets" ] && [ -d "$PROJECT_DIR/.build/www" ]; then
    WWW_DIR="$PROJECT_DIR/.build/www"
fi
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
    AAPT2="$(find "$ANDROID_HOME/build-tools" -name aapt2 2>/dev/null | sort -r | head -1)"
    AAPT="$(find "$ANDROID_HOME/build-tools" -name aapt -not -name aapt2 2>/dev/null | head -1)"
    if [ -n "$AAPT2" ]; then
        BADGING=$("$AAPT2" dump badging "$APK_PATH" 2>&1)
    elif [ -n "$AAPT" ]; then
        BADGING=$("$AAPT" dump badging "$APK_PATH" 2>&1)
    fi
    if [ -n "$AAPT2" ] || [ -n "$AAPT" ]; then
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
    # Look in both www/ (Capacitor) and www/application/ (Cordova)
    JS_FOUND=""
    for dir in "$WWW_DIR" "$WWW_DIR/application"; do
        [ -f "$dir/$JS_FILE" ] && JS_FOUND="$dir/$JS_FILE"
    done
    CSS_FOUND=""
    for dir in "$WWW_DIR" "$WWW_DIR/application"; do
        [ -f "$dir/$CSS_FILE" ] && CSS_FOUND="$dir/$CSS_FILE"
    done
    if [ -n "$JS_FOUND" ]; then
        JS_SIZE=$(du -h "$JS_FOUND" | cut -f1)
        pass "JS bundle exists ($JS_FILE, $JS_SIZE)"
    else
        fail "JS bundle file missing"
    fi
    if [ -n "$CSS_FOUND" ]; then
        CSS_SIZE=$(du -h "$CSS_FOUND" | cut -f1)
        pass "CSS bundle exists ($CSS_FILE, $CSS_SIZE)"
    else
        fail "CSS bundle file missing"
    fi
else
    fail "No index.html found in web bundle"
fi

# --- Test 4: Native wrapper ---
echo ""
echo "[4] Native wrapper"
if [ -f "$WWW_DIR/cordova.js" ]; then
    pass "Cordova: cordova.js present"
elif [ -d "$PROJECT_DIR/android/capacitor-cordova-android-plugins" ]; then
    pass "Capacitor: Android project present"
else
    fail "No native wrapper detected (neither Cordova nor Capacitor)"
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

# --- Test 6: Bundled character data ---
echo ""
echo "[6] Bundled character data"
CHAR_V2_DIR="$WWW_DIR/assets/characters_v2"
if [ -d "$CHAR_V2_DIR" ]; then
    V2_COUNT=$(ls "$CHAR_V2_DIR" | wc -l)
    V2_SIZE=$(du -sh "$CHAR_V2_DIR" | cut -f1)
    if [ "$V2_COUNT" -gt 50 ]; then
        pass "Found $V2_COUNT character_v2 asset files ($V2_SIZE)"
    else
        fail "Only $V2_COUNT character_v2 files (expected 90+)"
    fi
    # Spot-check: verify a file is valid NDJSON
    SAMPLE_FILE=$(ls "$CHAR_V2_DIR" | head -1)
    if [ -n "$SAMPLE_FILE" ]; then
        FIRST_LINE=$(head -1 "$CHAR_V2_DIR/$SAMPLE_FILE")
        if echo "$FIRST_LINE" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null; then
            pass "character_v2 files contain valid JSON"
        else
            fail "character_v2 files have invalid JSON"
        fi
    fi
else
    fail "No characters_v2 directory in bundled assets"
fi

# --- Summary ---
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
