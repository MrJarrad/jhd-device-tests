#!/usr/bin/env python3
"""Pixel verdict for a walk: was the footer region disturbed after the measured tap, judged from the simulator recording.

usage: pixel-detector.py <outDir>   (reads trace.json + walk.mp4; writes pixel-verdicts.json and pixel-summary.txt)

Clock sync is automatic: walk.mjs paints a magenta band at a known wall-clock instant before each measured tap
(trace event `sync-marker`). The band's first video frame gives that walk's video-clock offset; the tap's
position in the video follows from the page-side click wall time (`measure-samples.clickWall`).

Verdict per walk: COVERED when the watched patch is non-flat for a run of >= MIN_RUN_S within WINDOW_S of the tap,
HELD when it stays flat, NO-DATA when the marker or the tap time is missing (never guessed).
"""
import json, subprocess, sys, os, statistics

FPS = 20
WINDOW_S = 6.0
MIN_RUN_S = 0.2
FLAT_STD = 5.0          # grey-level stdev of the 12x12 patch below which it counts as flat
PAIR_TOL_S = 2.0        # marker-to-marker spacing in the video must match the wall clock within this


def load(out):
    ev = {}
    trace = json.load(open(f'{out}/trace.json'))
    for e in trace['events']:
        ev.setdefault(e['ev'], []).append(e)
    return trace, ev


def decode(video, region, tmp):
    x, y, w, h = region
    fc = (f'[0:v]fps={FPS},split[a][b];'
          f'[a]crop=iw:ih*0.10:0:ih*0.36,scale=1:1,format=rgb24[m];'
          f'[b]crop=iw*{w}:ih*{h}:iw*{x}:ih*{y},scale=12:12,format=gray[p]')
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', video, '-filter_complex', fc,
                    '-map', '[m]', '-f', 'rawvideo', f'{tmp}/band.raw', '-map', '[p]', '-f', 'rawvideo', f'{tmp}/pill.raw'], check=True)
    band = open(f'{tmp}/band.raw', 'rb').read()
    pill = open(f'{tmp}/pill.raw', 'rb').read()
    marks = [band[i:i + 3] for i in range(0, len(band) - 2, 3)]
    is_mark = [m[0] > 180 and m[2] > 180 and m[1] < 110 for m in marks]
    edges = [k for k in range(len(is_mark)) if is_mark[k] and (k == 0 or not is_mark[k - 1])]
    stds = [statistics.pstdev(pill[i:i + 144]) for i in range(0, len(pill) - 143, 144)]
    return edges, stds


def pair_markers(markers, edges):
    """Match each marker (wall ms) to its video edge (frame). The recording starts an unknown, slow-to-boot time after
    the runner logs it, so no absolute offset is assumed: pick the offset at which the most markers line up with an
    edge within PAIR_TOL_S, trying each edge as the first marker's."""
    ms = sorted(markers.items(), key=lambda kv: kv[1])
    if not ms or not edges: return {}
    best = (-1, None)
    for e in edges:
        off = e - ms[0][1] / 1000 * FPS
        got = {}
        for key, wall in ms:
            c = min(edges, key=lambda k: abs(k - (wall / 1000 * FPS + off)))
            if abs(c - (wall / 1000 * FPS + off)) <= PAIR_TOL_S * FPS: got[key] = c
        if len(got) > best[0]: best = (len(got), got)
    return best[1]


def main(out):
    trace, ev = load(out)
    req = trace.get('request', {})
    r = req.get('pixelRegion') or {}
    region = (r.get('x', 0.517), r.get('y', 0.785), r.get('w', 0.03), r.get('h', 0.03))
    rec = (ev.get('record-start') or [{}])[0].get('wall')
    t0 = trace['t0Wall']
    video = f'{out}/walk.mp4'
    tmp = f'{out}/.pixel-tmp'; os.makedirs(tmp, exist_ok=True)
    edges, stds = decode(video, region, tmp) if os.path.exists(video) and rec else ([], [])
    markers = {(e['target'], e['walk']): e['wall'] for e in ev.get('sync-marker', [])}
    builds = {(e['target'], e['walk']): e.get('build') for e in ev.get('build-id', [])}
    walks = [(e['target'], e['walk'], e.get('clickWall')) for e in ev.get('measure-samples', [])]
    seen = set((t, w) for t, w, _ in walks)
    for (t, w) in markers:                      # walks that reached the marker but not the tap sample
        if (t, w) not in seen: walks.append((t, w, None))
    pair = pair_markers(markers, edges)
    res = []
    for t, w, cw in walks:
        row = {'target': t, 'walk': w, 'build': builds.get((t, w))}
        tm = markers.get((t, w))
        if tm is None or cw is None or not edges:
            res.append({**row, 'verdict': 'NO-DATA', 'why': 'no marker or click time or recording'}); continue
        km = pair.get((t, w))
        if km is None:
            res.append({**row, 'verdict': 'NO-DATA', 'why': 'no marker edge in the recording matches this walk'}); continue
        k0 = km + round((cw - tm) / 1000 * FPS)  # frame of the tap
        win = stds[k0:k0 + int(WINDOW_S * FPS)]
        bad = [s >= FLAT_STD for s in win]
        run = best = 0
        for b in bad:
            run = run + 1 if b else 0; best = max(best, run)
        covered = best >= MIN_RUN_S * FPS
        res.append({**row, 'verdict': 'COVERED' if covered else 'HELD', 'coveredSeconds': round(sum(bad) / FPS, 2),
                    'longestRunSeconds': round(best / FPS, 2), 'markerFrame': km, 'frames': len(win),
                    'timeline': ''.join('.' if b else 'P' for b in bad)})
    json.dump(res, open(f'{out}/pixel-verdicts.json', 'w'), indent=1)
    with open(f'{out}/pixel-summary.txt', 'w') as f:
        for v in res:
            f.write(f"walk {v['target']} w{v['walk']} {v['verdict'].lower()}"
                    + (f" covered={v['coveredSeconds']}s" if 'coveredSeconds' in v else '')
                    + f" build={(v.get('build') or 'unknown').replace(chr(34), '')}\n")
        for t in dict.fromkeys(v['target'] for v in res):
            vs = [v['verdict'] for v in res if v['target'] == t]
            f.write(f"target {t} held={vs.count('HELD')} covered={vs.count('COVERED')} no-data={vs.count('NO-DATA')} of {len(vs)}\n")
    for fn in os.listdir(tmp): os.remove(f'{tmp}/{fn}')
    os.rmdir(tmp)
    print(open(f'{out}/pixel-summary.txt').read(), end='')


if __name__ == '__main__':
    main(sys.argv[1])
