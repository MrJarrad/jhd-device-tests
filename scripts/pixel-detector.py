#!/usr/bin/env python3
"""Pixel verdict for a walk: was the footer region disturbed after the measured tap, judged from the simulator recording.

usage: pixel-detector.py <outDir>   (reads trace.json + walk.mp4; writes pixel-verdicts.json and pixel-summary.txt)

Sync is automatic: the measured tap itself paints a magenta band on screen (page-side click listener), as many
pulses as the walk's ordinal in the run (`measure-samples.id`). The first video frame of the band is the tap; the pulse
count tells walks apart. No clock offset is assumed anywhere (the recording's clock drifts against wall time).

Verdict per walk: COVERED when the watched patch is non-flat for a run of >= MIN_RUN_S within WINDOW_S of the tap,
HELD when it stays flat, NO-DATA when the tap's flash is not found (never guessed).
"""
import json, subprocess, sys, os, statistics

FPS = 20
WINDOW_S = 6.0
MIN_RUN_S = 0.2
FLAT_STD = 5.0          # grey-level stdev of the 12x12 patch below which it counts as flat
GROUP_GAP_S = 0.9       # flash pulses closer than this belong to one tap


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


def tap_frames(edges):
    """Group flash edges (pulses of one tap are ~0.6 s apart) -> {pulse count: frame of the first pulse = the tap}."""
    groups, cur = [], []
    for e in edges:
        if cur and e - cur[-1] > GROUP_GAP_S * FPS: groups.append(cur); cur = []
        cur.append(e)
    if cur: groups.append(cur)
    out = {}
    for g in groups: out.setdefault(len(g), []).append(g[0])
    return {n: fs[0] for n, fs in out.items() if len(fs) == 1}   # a count seen twice is ambiguous: not used


def main(out):
    trace, ev = load(out)
    req = trace.get('request', {})
    r = req.get('pixelRegion') or {}
    region = (r.get('x', 0.517), r.get('y', 0.785), r.get('w', 0.03), r.get('h', 0.03))
    video = f'{out}/walk.mp4'
    tmp = f'{out}/.pixel-tmp'; os.makedirs(tmp, exist_ok=True)
    edges, stds = decode(video, region, tmp) if os.path.exists(video) else ([], [])
    builds = {(e['target'], e['walk']): e.get('build') for e in ev.get('build-id', [])}
    walks = [(e['target'], e['walk'], e.get('id')) for e in ev.get('measure-samples', [])]
    taps = tap_frames(edges)
    res = []
    for t, w, wid in walks:
        row = {'target': t, 'walk': w, 'build': builds.get((t, w))}
        k0 = taps.get(wid)
        if k0 is None:
            res.append({**row, 'verdict': 'NO-DATA', 'why': f'no flash with {wid} pulses found in the recording'}); continue
        win = stds[k0:k0 + int(WINDOW_S * FPS)]
        bad = [s >= FLAT_STD for s in win]
        run = best = 0
        for b in bad:
            run = run + 1 if b else 0; best = max(best, run)
        covered = best >= MIN_RUN_S * FPS
        res.append({**row, 'verdict': 'COVERED' if covered else 'HELD', 'coveredSeconds': round(sum(bad) / FPS, 2),
                    'longestRunSeconds': round(best / FPS, 2), 'tapFrame': k0, 'frames': len(win),
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
