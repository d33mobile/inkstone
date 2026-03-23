#!/bin/bash
set -euo pipefail
# Post-processes www/index.html after Meteor build for Capacitor compatibility.

WWW_DIR="${1:-www}"
INDEX="$WWW_DIR/index.html"

if [ ! -f "$INDEX" ]; then
    echo "Error: $INDEX not found"
    exit 1
fi

# Use Node.js for reliable HTML patching (available in our Docker image)
node -e "
const fs = require('fs');
let html = fs.readFileSync('$INDEX', 'utf-8');

// 1. Remove cordova.js script tag
html = html.replace(/<script[^>]*src=[\"']\/cordova\.js[\"'][^>]*><\/script>/g, '');

// 2. Fix DDP URL to unreachable address
html = html.replace(/http%3A%2F%2Flocalhost%3A3785%2F/g, 'https%3A%2F%2F0.0.0.0%3A1%2F');

// 3. Remove Android 10.0.2.2 redirect block
html = html.replace(/if\s*\(\/Android\/i\.test[\s\S]*?}\s*}\s*\n/g, '');

// 4. Inject Capacitor shim before </head>
const shim = \`<script type=\"text/javascript\">
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
document.addEventListener(\"DOMContentLoaded\", function() {
  _ensureCordova();
  document.dispatchEvent(new Event(\"deviceready\"));
});
</script>\`;

html = html.replace('</head>', shim + '</head>');

fs.writeFileSync('$INDEX', html);
console.log('Patched $INDEX successfully');
"

# 5. Copy fonts/graphics/sources to www root
for dir in fonts graphics sources; do
    if [ -d "$WWW_DIR/app/$dir" ] && [ ! -d "$WWW_DIR/$dir" ]; then
        cp -r "$WWW_DIR/app/$dir" "$WWW_DIR/$dir"
    fi
done
