# jhd-device-tests

A standing gate: run a tap path on a preview in real Mobile Safari (iPhone 16 Pro, iOS Simulator, free GitHub-hosted macOS runner) and get a pixel verdict back. Test scripts only; no site code. Public repo, so runner minutes are free.

What one run does: opens each target, replays the tap path with native touches, records the whole simulator screen (Safari toolbar included), and judges the last (measured) tap from the recording's pixels. DOM probes are not the verdict: they cannot see a paint bug (a DOM sampler said "held" on a build whose footer was visibly covered).

## Trigger (from a cloud lane, no GitHub API token)
1. Branch from main as `run/<name>`.
2. Edit `request.json`, commit, `git push origin run/<name>`. Only `run/**` branches and manual dispatch trigger; main does not.
3. Wait. Status without auth: `curl -s "https://api.github.com/repos/MrJarrad/jhd-device-tests/actions/runs?per_page=1"` (`status`, `conclusion`, `head_sha`).

Minutes per run: about 5 fixed (simulator boot, Appium and WebDriverAgent start, ffmpeg install) plus about 3 per walk. Measured: 1 target x 3 walks = 13.5 min wall. Hard limits: walks stop at 17 min, the walk step at 24, the job at 30, so keep targets x walks at 6 or fewer.

## Request format (`request.json`)
```json
{
  "targets": [ { "name": "fix", "url": "https://<preview host>/projects/yardsale", "card": "/projects/yardsale" } ],
  "walks": 3,
  "cardWaitMs": 3000,
  "runtime": "18",
  "path": [ { "tapText": "Next" }, { "tapText": "Next", "measure": true } ],
  "probe": "\"fp-\\d+\"",
  "pixelRegion": { "x": 0.517, "y": 0.785, "w": 0.03, "h": 0.03 }
}
```
- `targets`: one entry per build to compare; `name` labels the verdict lines (public, keep it free of secrets), `url` is the page each walk starts from, `card` is the href the default path taps on Home.
- `walks`: repeats per target (transitions are timing sensitive; use 3).
- `path` (optional): ordered tap steps, each `tapText` (exact visible text of a link or button) or `tapHref` (a link by href), with optional `waitMs` after it (default 3500). Exactly one step carries `"measure": true`: the tap whose aftermath is judged. Omitted, the path is the footer row-35 path: Next, Next, Projects, card (`card`), Next (measured).
- `probe`: regex for the build id to log (searched in the page's script files); default `"fp-\d+"`. The matched text is logged per walk as `build=`.
- `pixelRegion`: the patch of screen (fractions of width/height) whose pixels are watched. Default is the strip where the row-35 footer pills sit on iPhone 16 Pro; a different path or defect needs its own region.
- `runtime`: iOS major to prefer. `mechanics` (`{ "tapText": "..." }`): public-page driver check, no verdict.

## Reading results
`git fetch origin results/run-<name>-<first 7 of sha>` then `git archive FETCH_HEAD out | tar -x -C <dir>`. `out/summary.txt` needs no decryption:
```
outcome: success
walk fix w1 held covered=0.0s build=fp-5
walk fix w2 covered covered=1.6s build=fp-2
target fix held=1 covered=1 no-data=0 of 2
```
- `held`: the watched patch stayed flat after the tap (footer not disturbed). `covered`: it was disturbed for at least 0.2 s within 6 s of the tap; `covered=` is the total seconds disturbed. `no-data`: the sync marker or tap time was missing; never guessed, re-run.
- `build=` is the probe id the target actually served on that walk (`probe-timeout` or `none` if the page did not yield one).
- `outcome` is whether the walk script ran; a `covered` verdict does not fail the run.

## Decrypt (previews are behind Access and this repo is public, so results are sealed)
`out/` holds `results.tar.age` (sealed to the public key `age-public-key.txt`), or `results.tar.age.part-aa`, `-ab`, ... when over 90 MB (a full recording is about 100 MB). Private key: vault `estate/device-tests/age-private-key.txt` (`apt-get install -y age`).
- One file: `age -d -i <key> out/results.tar.age | tar -x -C <dir>`
- Split: `cat out/results.tar.age.part-* | age -d -i <key> | tar -x -C <dir>`

Sealed contents: `pixel-verdicts.json` (per walk: verdict, covered seconds, longest run, a 0.05 s timeline, `P` flat and `.` disturbed), `pixel-summary.txt`, `verdicts.json` (the DOM sampler, kept for comparison only), `walk.mp4` (recording), jpeg frames, `trace.json`, `walk.log`, `appium.log`, `env.txt`. Vault media is capped at 50 MB per file: cut clips from `walk.mp4` (`ffmpeg -ss <t> -t 8 ...`) before banking.

## How the verdict is made
- Each measured tap is preceded by a magenta band flashed on screen at a known wall-clock instant (the runner and simulator share one clock). The detector (`scripts/pixel-detector.py`, run on the runner with ffmpeg) finds those bands in `walk.mp4`, matches them to walks by their spacing, and so places every tap in the video with no hand-calibrated offset. The recording starts tens of seconds after the runner logs it, which is why no absolute offset is assumed.
- The tap's own moment comes from the page (`click` capture listener, wall time). The watched patch is sampled at 20 fps for 6 s after it.

## Previews behind Cloudflare Access
The runner exchanges the service token for the `CF_Authorization` cookie per host and sets it in Safari (`/cdn-cgi/trace` on the same host is served without a login). Needs repo secrets `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` (the `claude-testing` token). Without them the run stops with `out/AUTH-MISSING.txt`. The cookie is redacted from published logs. The public Actions log carries no walk output; never add `tee`/`cat` of results to the workflow. `summary.txt` carries only target names, verdicts, covered seconds and the probe id.

## What it does not show
Simulator, not a phone: no real GPU compositing, finger feel or scroll physics, no hardware. The runner image decides the iOS runtimes available. The verdict is only as good as the watched region: it sees disturbance in that patch, not the whole screen.
