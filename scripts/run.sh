#!/usr/bin/env bash
# Boots iPhone 16 Pro, starts Appium, runs the walk. Output dir = $1.
set -uo pipefail
OUT="${1:-out}"; mkdir -p "$OUT"
RT_PREFIX=$(node -p "require('./request.json').runtime||''")
# pick runtime (prefer requested major, else newest) that has an iPhone 16 Pro
read -r UDID RTNAME < <(xcrun simctl list devices available -j | node -e '
const j=JSON.parse(require("fs").readFileSync(0,"utf8")); const pre=process.argv[1];
const rts=Object.keys(j.devices).filter(k=>k.includes("iOS")).map(k=>({k,v:k.match(/iOS-(\d+)-(\d+)/)})).filter(x=>x.v).sort((a,b)=>(b.v[1]-a.v[1])||(b.v[2]-a.v[2]));
const has=x=>j.devices[x.k].find(d=>d.name==="iPhone 16 Pro");
let pick=rts.filter(x=>pre&&x.v[1]===pre).find(has)||rts.find(has);
const d=has(pick); console.log(d.udid, pick.k.split(".").pop());' "$RT_PREFIX")
echo "simulator: $UDID ($RTNAME)" | tee "$OUT/env.txt"
sw_vers | tee -a "$OUT/env.txt"; xcodebuild -version | tee -a "$OUT/env.txt"
xcrun simctl boot "$UDID" || true
xcrun simctl bootstatus "$UDID" -b
open -a Simulator --args -CurrentDeviceUDID "$UDID" || true
sleep 5
xcrun simctl spawn "$UDID" defaults write com.apple.mobilesafari WebKitDeveloperExtrasEnabledPreferenceKey -bool true || true
xcrun simctl spawn "$UDID" defaults write com.apple.mobilesafari WebInspectorEnabled -bool true || true
sleep 5
npm i -g appium@latest >"$OUT/appium-install.log" 2>&1
appium driver install xcuitest >>"$OUT/appium-install.log" 2>&1
appium --log-no-colors >"$OUT/appium.log" 2>&1 &
APPIUM_PID=$!
for i in $(seq 1 30); do curl -sf http://127.0.0.1:4723/status >/dev/null && break; sleep 1; done
node scripts/walk.mjs "$UDID" "$OUT" 2>&1 | tee "$OUT/walk.log"
RC=${PIPESTATUS[0]}
kill $APPIUM_PID 2>/dev/null || true
exit $RC
