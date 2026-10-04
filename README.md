# jhd-device-tests

Real Mobile Safari in an iOS Simulator (iPhone 16 Pro, iOS 18.x) on a free GitHub-hosted macOS runner. It opens a URL, taps a scripted path with native touches, and records the whole simulator screen (Safari toolbar included). Test scripts only; no site code. Public repo, so runner minutes are free.

## Run it (from a cloud lane, no GitHub API token needed)
1. Branch from main as `run/<name>`.
2. Edit `request.json` (template for the footer path: `request.row35.json`), commit, `git push origin run/<name>`.
3. Wait about 7 minutes (one run measured at 6m50s of macOS time). Status without auth:
   `curl -s "https://api.github.com/repos/MrJarrad/jhd-device-tests/actions/runs?per_page=1"` (`status`, `conclusion`, `head_sha`).
4. Read it: `git fetch origin results/run-<name>-<first 7 of sha>` then `git archive FETCH_HEAD out | tar -x -C <dir>`.
   Contents of `out/`: numbered `.png` frames (full screen), `walk.mp4` (recording), `trace.json` (tap timestamps and a footer/viewport sample per frame), `walk.log`, `appium.log`, `env.txt` (runtime, Xcode), `summary.txt`.
   Extract recording frames with `ffmpeg -i walk.mp4 -vf fps=10 f-%03d.png`.
`request.json` fields: `url`, `card` (href of the project card tapped on Home), `cardWaitMs`, `runtime` (iOS major to prefer), `mechanics` (public-page driver check: `{ "tapText": "..." }`).

## Previews behind Cloudflare Access
Preview hosts redirect to an Access login. The runner exchanges the service token for the `CF_Authorization` cookie and sets it in Safari (`/cdn-cgi/trace` on the same host is served without a login, so the cookie can be set there). Needs repo secrets `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` (the `claude-testing` token). Without them the run stops with `out/AUTH-MISSING.txt`. The cookie is redacted from published logs.

## What it does not show
Simulator, not a phone: no real GPU compositing, finger feel or scroll physics, no hardware. Runner image decides the iOS runtimes available.
