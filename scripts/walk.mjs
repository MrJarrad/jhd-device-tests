// Drives real Mobile Safari in a booted iOS Simulator through Appium (XCUITest),
// taps with native touches, and records the whole simulator screen.
// Usage: node scripts/walk.mjs <udid> <outDir>   (reads request.json for url + path)
import { spawn, execFileSync, execFile } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const [udid, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const req = JSON.parse(readFileSync(new URL('../request.json', import.meta.url), 'utf8'));
const APPIUM = 'http://127.0.0.1:4723';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const trace = { request: req, udid, events: [] };
const T0 = Date.now();
const log = (e) => { trace.events.push({ t: Date.now() - T0, ...e }); console.log(JSON.stringify({ t: Date.now() - T0, ...e })); };

import http from 'node:http';
// node:http, no client timeout: session creation (WDA launch) can take several minutes on the runner
function wd(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(APPIUM + path, { method, headers: { 'content-type': 'application/json', ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let t = ''; res.on('data', (c) => (t += c));
      res.on('end', () => {
        let j; try { j = JSON.parse(t); } catch (e) { return reject(new Error(`${method} ${path}: bad json ${t.slice(0, 100)}`)); }
        if (j.value && j.value.error) return reject(new Error(`${method} ${path}: ${j.value.error}: ${j.value.message}`));
        resolve(j.value);
      });
    });
    if (path !== '/session') r.setTimeout(90000, () => r.destroy(new Error(`${method} ${path}: client timeout 90s`)));
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

// full-screen simulator frame (includes Safari chrome / toolbar)
function shot(name) {
  const f = `${out}/${name}.png`;
  execFileSync('xcrun', ['simctl', 'io', udid, 'screenshot', '--type=png', f], { stdio: 'ignore' });
  return f;
}

const caps = {
  platformName: 'iOS', browserName: 'Safari',
  'appium:automationName': 'XCUITest', 'appium:udid': udid,
  'appium:deviceName': 'iPhone 16 Pro', 'appium:nativeWebTap': true,
  'appium:safariIgnoreFraudWarning': true, 'appium:wdaLaunchTimeout': 300000,
  'appium:wdaConnectionTimeout': 300000, 'appium:newCommandTimeout': 300, 'appium:webviewConnectTimeout': 60000,
  'appium:includeSafariInWebviews': true, 'appium:safariInitialUrl': req.targets ? `https://${new URL(req.targets[0].url).host}/cdn-cgi/trace` : req.url, 'appium:wdaStartupRetries': 3, 'appium:wdaStartupRetryInterval': 5000,
};

let rec;
const sess = (await wd('POST', '/session', { capabilities: { alwaysMatch: caps } }));
const sid = sess.sessionId;
const S = (p) => `/session/${sid}${p}`;
const js = (script, args = []) => wd('POST', S('/execute/sync'), { script, args });
log({ ev: 'session', caps: sess.capabilities });

// pill = footer action / link by exact visible text; card = project link by href
const FIND = `
const [kind, key] = arguments;
document.querySelectorAll('[data-dt]').forEach(e => e.removeAttribute('data-dt'));
const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
const list = kind === 'href' ? [...document.querySelectorAll('a[href="' + key + '"]')] : [...document.querySelectorAll('a,button')].filter(e => e.textContent.trim() === key);
const el = list.find(vis);
if (!el) return null;
if (kind === 'href') el.scrollIntoView({block:'center', inline:'center'});
el.setAttribute('data-dt', '1');
const r = el.getBoundingClientRect();
return {x: r.x + r.width/2, y: r.y + r.height/2, w: r.width, h: r.height, n: list.length};`;

const SAMPLE = `
const labels = ['Next','Projects','Profile','Email'];
const vv = window.visualViewport;
const pills = [...document.querySelectorAll('a,button')].filter(e => labels.includes(e.textContent.trim())).map(e => {
  const r = e.getBoundingClientRect();
  const top = document.elementFromPoint(r.x + r.width/2, r.y + r.height/2);
  return {label: e.textContent.trim(), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
    opacity: getComputedStyle(e).opacity, inView: r.bottom > 0 && r.top < innerHeight && r.width > 0,
    onTop: !!top && (top === e || e.contains(top)),
    topEl: top ? (top.tagName + '.' + String(top.className).slice(0, 50)) : null};
});
return {path: location.pathname, innerH: innerHeight, vvH: vv && vv.height, vvTop: vv && vv.offsetTop, scrollY, pills};`;

async function tap(kind, key, label) {
  const found = await js(FIND, [kind, key]);
  if (!found) throw new Error(`tap target not found: ${kind} ${key}`);
  await sleep(300);
  const f2 = await js(FIND, [kind, key]); // re-read (and re-mark) after scrollIntoView settles
  if (!f2) throw new Error(`tap target vanished: ${kind} ${key}`);
  const target = await wd('POST', S('/element'), { using: 'css selector', value: '[data-dt]' });
  const id = Object.values(target)[0];
  log({ ev: 'tap', label, rect: f2 });
  await wd('POST', S(`/element/${id}/click`), {});
}

// page-side sampler: Appium round trips are too slow (about 7s per tap) to catch a 2.5s transition, so the page samples itself.
const INSTALL = `
const labels = ['Next','Projects','Profile','Email'];
window.__dt = {c: null, s: []};
document.addEventListener('click', () => { if (window.__dt.c === null) window.__dt.c = performance.now(); }, true);
const id = setInterval(() => {
  const pills = [...document.querySelectorAll('a,button')].filter(e => labels.includes(e.textContent.trim())).map(e => {
    const r = e.getBoundingClientRect(); if (!(r.width > 0 && r.height > 0)) return null;
    const top = document.elementFromPoint(r.x + r.width/2, r.y + r.height/2);
    return {l: e.textContent.trim(), y: Math.round(r.y), o: +getComputedStyle(e).opacity, on: !!top && (top === e || e.contains(top)),
      top: top && !(top === e || e.contains(top)) ? (top.tagName + '.' + String(top.className).slice(0, 40)) : null};
  }).filter(Boolean);
  window.__dt.s.push({t: Math.round(performance.now()), p: location.pathname, pills});
  if (window.__dt.s.length > 400) clearInterval(id);
}, 40);
return true;`;

// frame loop that runs while the click is in flight (simctl screenshot, jpeg)
function frameLoop(prefix) {
  let stop = false; const t0 = Date.now(); const done = (async () => {
    for (let i = 0; !stop; i++) {
      const f = `${out}/${prefix}-f${String(i).padStart(2, '0')}-${Date.now() - t0}ms.jpg`;
      await new Promise((r) => execFile('xcrun', ['simctl', 'io', udid, 'screenshot', '--type=jpeg', f], () => r()));
      await sleep(50);
    }
  })();
  return async () => { stop = true; await done; };
}

async function finish() {
  if (rec) { rec.kill('SIGINT'); await new Promise((r) => rec.on('exit', r)); rec = null; }
  try { await wd('DELETE', S('')); } catch {}
  writeFileSync(`${out}/trace.json`, JSON.stringify(trace, null, 1));
  return 0;
}
const targets = req.targets || [{ name: 'target', url: req.url }];
const walks = req.walks || 1;
const verdicts = [];

async function authFor(url) {
  const id = process.env.CF_ACCESS_CLIENT_ID, secret = process.env.CF_ACCESS_CLIENT_SECRET;
  const r = await fetch(url, { redirect: 'manual', headers: { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret } });
  const c = (r.headers.getSetCookie?.() || []).map((x) => x.match(/^CF_Authorization=([^;]*)/)).find(Boolean);
  log({ ev: 'auth-exchange', status: r.status, cookie: !!c });
  return c ? c[1] : null;
}

async function openTarget(t) {
  if (req.mechanics) return;
  const host = new URL(t.url).host;
  const cookie = await authFor(t.url);
  if (!cookie) throw new Error('Access did not return a CF_Authorization cookie for ' + host);
  await wd('POST', S('/url'), { url: `https://${host}/cdn-cgi/trace` });
  await sleep(1500);
  await wd('POST', S('/cookie'), { cookie: { name: 'CF_Authorization', value: cookie, path: '/', secure: true, httpOnly: true } });
  log({ ev: 'access-cookie-set', host });
}

// row-35 verdict, from page-side samples after the click: only visible footer pills count (the leaving Home footer is zero-sized).
// covered = a visible pill with something else at its centre, or fewer than four pills present, or opacity below 1.
function verdictOf(dt) {
  const c = dt.c; const s = dt.s.filter((x) => c !== null && x.t >= c && x.t <= c + 3500).map((x) => ({ ...x, rel: x.t - c }));
  if (!s.length) return { verdict: 'NO-DATA', clickAt: c };
  const bad = (x) => x.pills.length < 4 || x.pills.some((p) => !p.on || p.o < 1);
  const b = s.filter(bad);
  const lastBad = b.length ? b[b.length - 1].rel : null;
  return { verdict: b.length ? 'COVERED/NOT-PERSISTENT' : 'HELD', samples: s.length, badSamples: b.length, firstBadMs: b[0]?.rel ?? null, lastBadMs: lastBad,
    coveredBy: [...new Set(b.flatMap((x) => x.pills.map((p) => p.top).filter(Boolean)))].slice(0, 4), minPills: Math.min(...s.map((x) => x.pills.length)) };
}

const DEADLINE = Date.now() + 17 * 60 * 1000;
async function oneWalk(t, n) {
  if (Date.now() > DEADLINE) { log({ ev: 'skipped-deadline', target: t.name, walk: n }); return; }
  const pre = `${t.name}-w${n}`;
  const mark = trace.events.length;
  try {
    await js('try{sessionStorage.clear();localStorage.clear()}catch(e){}').catch(() => {});
    await wd('POST', S('/url'), { url: t.url });
    log({ ev: 'navigated', target: t.name, walk: n, url: t.url });
    await sleep(4000);
    shot(`${pre}-00-load`);
    await tap('text', 'Next', 'next-1'); await sleep(3500);
    await tap('text', 'Next', 'next-2'); await sleep(3500); shot(`${pre}-02-after-next-2`);
    await tap('text', 'Projects', 'projects'); await sleep(3500); shot(`${pre}-03-home`);
    await tap('href', t.card || req.card, 'card'); await sleep(req.cardWaitMs ?? 3000); shot(`${pre}-04-before-next-3`);
    await js(INSTALL);
    const stopFrames = frameLoop(`${pre}-05-row35`);
    await tap('text', 'Next', 'next-3-row35');
    await sleep(4500);
    await stopFrames();
    const dt = JSON.parse(await js('return JSON.stringify(window.__dt)'));
    writeFileSync(`${out}/${pre}-row35-samples.json`, JSON.stringify(dt));
    log({ ev: 'row35-samples', target: t.name, walk: n, clickAt: dt.c, count: dt.s.length });
    shot(`${pre}-06-settled`);
    const v = verdictOf(dt);
    verdicts.push({ target: t.name, walk: n, ...v }); log({ ev: 'verdict', target: t.name, walk: n, ...v });
  } catch (e) {
    log({ ev: 'error', target: t.name, walk: n, message: String(e) });
    try { shot(`${pre}-99-error`); } catch {}
  }
  if (!verdicts.find((x) => x.target === t.name && x.walk === n)) { const v = { target: t.name, walk: n, verdict: 'NO-DATA' }; verdicts.push(v); log({ ev: 'verdict', ...v }); }
  writeFileSync(`${out}/verdicts.json`, JSON.stringify(verdicts, null, 1)); writeFileSync(`${out}/trace.json`, JSON.stringify(trace, null, 1));
}

try {
  rec = spawn('xcrun', ['simctl', 'io', udid, 'recordVideo', '--codec=h264', '--force', `${out}/walk.mp4`], { stdio: 'ignore' });
  await sleep(1500);
  log({ ev: 'record-start' });
  if (req.mechanics) {
    await wd('POST', S('/url'), { url: req.url }); await sleep(4000); shot('00-load');
    await tap('text', req.mechanics.tapText, 'mechanics-tap'); await sleep(3000); shot('01-after-tap');
    process.exit(0 + (await finish()));
  }
  for (const t of targets) {
    await openTarget(t);
    for (let n = 1; n <= walks; n++) await oneWalk(t, n);
  }
  writeFileSync(`${out}/verdicts.json`, JSON.stringify(verdicts, null, 1));
  if (verdicts.every((v) => v.verdict === 'NO-DATA')) process.exitCode = 1;
} catch (e) {
  log({ ev: 'error', message: String(e) });
  try { shot('99-error'); } catch {}
  process.exitCode = 1;
} finally {
  await finish();
}
