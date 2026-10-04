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
# tools were installed by scripts/install.sh in a step without secrets
for t in appium ffmpeg; do command -v $t >/dev/null || { echo "ERROR: $t missing (install step did not run)"; exit 4; }; done
ffmpeg -version | head -1 >> "$OUT/env.txt"; appium --version >> "$OUT/env.txt"
# appium is third-party code: start it without the Access secrets; only walk.mjs gets them
env -u CF_ACCESS_CLIENT_ID -u CF_ACCESS_CLIENT_SECRET appium --log-no-colors >"$OUT/appium.log" 2>&1 &
APPIUM_PID=$!
for i in $(seq 1 30); do curl -sf http://127.0.0.1:4723/status >/dev/null && break; sleep 1; done
# Cloudflare Access: exchange the service token (repo secrets) for the CF_Authorization cookie. Never printed or published.
if [ -z "$(node -p "require('./request.json').mechanics?1:''")" ]; then
  if [ -z "${CF_ACCESS_CLIENT_ID:-}" ] || [ -z "${CF_ACCESS_CLIENT_SECRET:-}" ]; then
    echo "ERROR: preview is behind Cloudflare Access; repo secrets CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET are not set" | tee "$OUT/AUTH-MISSING.txt"; kill $APPIUM_PID; exit 3
  fi
  # the walk exchanges the token per target host itself (cookie value never leaves the runner)
fi
# walk output stays in the file (published encrypted); the public Actions log gets no page text
node scripts/walk.mjs "$UDID" "$OUT" >"$OUT/walk.log" 2>&1
RC=$?
unset CF_ACCESS_CLIENT_ID CF_ACCESS_CLIENT_SECRET   # nothing after the walk needs them
echo "walk exit code: $RC"
# scrub any JWT that appium logged
sed -i.bak -E "s/eyJ[A-Za-z0-9_.-]{20,}/<redacted>/g" "$OUT"/*.log "$OUT"/trace.json 2>/dev/null; rm -f "$OUT"/*.bak
# pixel verdict from the recording (automatic sync marker); output stays in the results dir, summary lines are non-sensitive
python3 scripts/pixel-detector.py "$OUT" >"$OUT/pixel-detector.log" 2>&1 || echo "pixel detector failed (see sealed pixel-detector.log)"
# frames to jpeg (publishing limit: a results branch file must stay under 100MB)
for f in "$OUT"/*.png; do [ -f "$f" ] && sips -s format jpeg -s formatOptions 72 "$f" --out "${f%.png}.jpg" >/dev/null 2>&1 && rm -f "$f"; done
kill $APPIUM_PID 2>/dev/null || true
exit $RC
