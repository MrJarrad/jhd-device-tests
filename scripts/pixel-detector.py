#!/usr/bin/env python3
"""Pixel verdict for a walk: was the footer region disturbed after the measured tap, judged from the simulator recording.

usage: pixel-detector.py <outDir>   (reads trace.json + walk.mp4; writes pixel-verdicts.json and pixel-summary.txt)

Sync is automatic and clock-free where it can be: walk.mjs paints bands whose column across the screen width encodes the
walk's ordinal in the run. A cyan band is painted by the tap itself (its first video frame IS the tap). A magenta band is
painted shortly before the tap at a logged wall time; if the cyan band was lost to a recorder stall, the tap is placed
from the magenta band plus the page's wall-clock gap between the two (seconds, so drift is negligible). The recording's
clock runs tens of seconds behind the runner's and is not linear against it, so no absolute offset is ever assumed.

Verdict per walk: COVERED when the watched patch is non-flat for a run of >= MIN_RUN_S within WINDOW_S of the tap,
HELD when it stays flat, NO-DATA when no band for that walk is found (never guessed).
"""
import json, subprocess, sys, os, statistics

FPS = 20
WINDOW_S = 6.0
MIN_RUN_S = 0.2
FLAT_STD = 5.0          # grey-level stdev of the 12x12 patch below which it counts as flat


def load(out):
    ev = {}
    trace = json.load(open(f'{out}/trace.json'))
    for e in trace['events']:
        ev.setdefault(e['ev'], []).append(e)
    return trace, ev


N_IDS = 12              # band columns across the screen width; the column is the walk ordinal
BAND_ROWS = 30          # rows of the band strip (top 5%-30% of the screen)


def band_id(scores):
    """Walk ordinal from a frame's band strip: the column with the strongest colour score, provided no other column is within
    60% of it and it is clearly coloured (a photo or text gives weak, spread-out scores). None = no band."""
    top = max(scores)
    if top < 100 or sum(1 for v in scores if v >= 0.6 * top) != 1: return None
    return scores.index(top) + 1


def first_runs(store):
    """ordinal -> first frame of its band, only when the band shows as one burst (a second burst >1.5 s later = ambiguous)."""
    out = {}
    for bid, ks in store.items():
        bursts = 1 + sum(1 for a, b in zip(ks, ks[1:]) if b - a > 1.5 * FPS)
        if bursts == 1: out[bid] = ks[0]
    return out


def decode(video, region, tmp):
    x, y, w, h = region
    fc = (f'[0:v]fps={FPS},split[a][b];'
          f'[a]crop=iw:ih*0.25:0:ih*0.05,format=rgb24,scale={N_IDS}:{BAND_ROWS}:flags=area,format=rgb24[m];'
          f'[b]crop=iw*{w}:ih*{h}:iw*{x}:ih*{y},scale=12:12,format=gray[p]')
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', video, '-filter_complex', fc,
                    '-map', '[m]', '-f', 'rawvideo', f'{tmp}/band.raw', '-map', '[p]', '-f', 'rawvideo', f'{tmp}/pill.raw'], check=True)
    band = open(f'{tmp}/band.raw', 'rb').read()
    pill = open(f'{tmp}/pill.raw', 'rb').read()
    fs = N_IDS * BAND_ROWS * 3
    magenta, cyan = {}, {}                  # walk ordinal -> frames the band is showing
    for k in range(len(band) // fs):
        fr = band[k * fs:(k + 1) * fs]
        colour = [[(fr[(r * N_IDS + c) * 3], fr[(r * N_IDS + c) * 3 + 1], fr[(r * N_IDS + c) * 3 + 2]) for r in range(BAND_ROWS)] for c in range(N_IDS)]
        for score, store in ((lambda r, g, b: min(r, b) - g if r > 150 and b > 150 else 0, magenta),
                             (lambda r, g, b: min(g, b) - r if g > 150 and b > 150 else 0, cyan)):
            bid = band_id([max(score(*px) for px in col) for col in colour])
            if bid: store.setdefault(bid, []).append(k)
    stds = [statistics.pstdev(pill[i:i + 144]) for i in range(0, len(pill) - 143, 144)]
    return first_runs(magenta), first_runs(cyan), stds


def main(out):
    trace, ev = load(out)
    req = trace.get('request', {})
    r = req.get('pixelRegion') or {}
    region = (r.get('x', 0.517), r.get('y', 0.785), r.get('w', 0.03), r.get('h', 0.03))
    video = f'{out}/walk.mp4'
    tmp = f'{out}/.pixel-tmp'; os.makedirs(tmp, exist_ok=True)
    marks, clicks, stds = decode(video, region, tmp) if os.path.exists(video) else ({}, {}, [])
    builds = {(e['target'], e['walk']): e.get('build') for e in ev.get('build-id', [])}
    mwall = {(e['target'], e['walk']): e['wall'] for e in ev.get('sync-marker', [])}
    walks = [(e['target'], e['walk'], e.get('id'), e.get('clickWall')) for e in ev.get('measure-samples', [])]
    res = []
    for t, w, wid, cw in walks:
        row = {'target': t, 'walk': w, 'build': builds.get((t, w))}
        if wid in clicks:                                   # the tap's own band: no clock involved
            k0, sync = clicks[wid], 'tap-band'
        elif wid in marks and cw and (t, w) in mwall:       # pre-tap band + the page's wall-clock gap to the click
            k0, sync = marks[wid] + round((cw - mwall[(t, w)]) / 1000 * FPS), 'marker+gap'
        else:
            res.append({**row, 'verdict': 'NO-DATA', 'why': f'no sync band for walk {wid} found in the recording'}); continue
        win = stds[k0:k0 + int(WINDOW_S * FPS)]
        bad = [s >= FLAT_STD for s in win]
        run = best = 0
        for b in bad:
            run = run + 1 if b else 0; best = max(best, run)
        covered = best >= MIN_RUN_S * FPS
        res.append({**row, 'verdict': 'COVERED' if covered else 'HELD', 'coveredSeconds': round(sum(bad) / FPS, 2),
                    'longestRunSeconds': round(best / FPS, 2), 'sync': sync, 'tapFrame': k0, 'frames': len(win),
                    'timeline': ''.join('.' if b else 'P' for b in bad)})
    json.dump(res, open(f'{out}/pixel-verdicts.json', 'w'), indent=1)
    with open(f'{out}/pixel-summary.txt', 'w') as f:
        for v in res:
            f.write(f"walk {v['target']} w{v['walk']} {v['verdict'].lower()}"
                    + (f" covered={v['coveredSeconds']}s sync={v['sync']}" if 'coveredSeconds' in v else '')
                    + f" build={(v.get('build') or 'unknown').replace(chr(34), '')}\n")
        for t in dict.fromkeys(v['target'] for v in res):
            vs = [v['verdict'] for v in res if v['target'] == t]
            f.write(f"target {t} held={vs.count('HELD')} covered={vs.count('COVERED')} no-data={vs.count('NO-DATA')} of {len(vs)}\n")
    for fn in os.listdir(tmp): os.remove(f'{tmp}/{fn}')
    os.rmdir(tmp)
    print(open(f'{out}/pixel-summary.txt').read(), end='')


if __name__ == '__main__':
    main(sys.argv[1])
