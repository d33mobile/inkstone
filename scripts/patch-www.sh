#!/bin/bash
set -euo pipefail
# Post-processes www/index.html after Meteor build for Capacitor compatibility.
# Fixes: cordova.js removal, deviceready shim, DDP disable, Keyboard shim.

WWW_DIR="${1:-www}"
INDEX="$WWW_DIR/index.html"

if [ ! -f "$INDEX" ]; then
    echo "Error: $INDEX not found"
    exit 1
fi

# 1. Remove cordova.js script tag
sed -i 's|<script[^>]*src="/cordova.js"[^>]*></script>||g' "$INDEX"

# 2. Fix DDP URL in runtime config (replace localhost:3785 with unreachable addr)
sed -i 's|http%3A%2F%2Flocalhost%3A3785%2F|https%3A%2F%2F0.0.0.0%3A1%2F|g' "$INDEX"

# 3. Remove Android 10.0.2.2 redirect block (no longer needed)
sed -i '/if.*Android.*test.*navigator/,/}$/d' "$INDEX"

# 4. Inject Capacitor compatibility shim before </head>
SHIM='<script type="text/javascript">
// Capacitor compatibility shims for Meteor/Cordova/Ionic
window.WebAppLocalServer = window.WebAppLocalServer || new Proxy({}, {
  get: function(t, p) { return p in t ? t[p] : function(){}; }
});
var _kbShim = {close:function(){},show:function(){},hideKeyboardAccessoryBar:function(){},disableScroll:function(){}};
function _ensureCordova() {
  if (!window.cordova) window.cordova = {};
  if (!window.cordova.plugins) window.cordova.plugins = {};
  if (!window.cordova.plugins.Keyboard) window.cordova.plugins.Keyboard = _kbShim;
  if (!window.cordova.fireWindowEvent) window.cordova.fireWindowEvent = function(){};
}
_ensureCordova();
var _si = setInterval(_ensureCordova, 50);
setTimeout(function() { clearInterval(_si); }, 5000);
document.addEventListener("DOMContentLoaded", function() {
  _ensureCordova();
  document.dispatchEvent(new Event("deviceready"));
});
</script>'

# Escape for sed
SHIM_ESCAPED=$(echo "$SHIM" | sed ':a;N;$!ba;s/\n/\\n/g' | sed 's/&/\\&/g')
sed -i "s|</head>|${SHIM_ESCAPED}</head>|" "$INDEX"

# 5. Copy fonts/graphics/sources to www root (CSS expects them there)
for dir in fonts graphics sources; do
    if [ -d "$WWW_DIR/app/$dir" ] && [ ! -d "$WWW_DIR/$dir" ]; then
        cp -r "$WWW_DIR/app/$dir" "$WWW_DIR/$dir"
    fi
done

echo "Patched $INDEX successfully"
