// Drives real Mobile Safari in a booted iOS Simulator through Appium (XCUITest),
// taps with native touches, and records the whole simulator screen.
// Usage: node scripts/walk.mjs <udid> <outDir>   (reads request.json for url + path)
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const [udid, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const req = JSON.parse(readFileSync(new URL('../request.json', import.meta.url), 'utf8'));
const APPIUM = 'http://127.0.0.1:4723';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const trace = { request: req, udid, events: [] };
const T0 = Date.now();
const log = (e) => { trace.events.push({ t: Date.now() - T0, ...e }); console.log(JSON.stringify({ t: Date.now() - T0, ...e })); };

async function wd(method, path, body) {
  const r = await fetch(APPIUM + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (j.value && j.value.error) throw new Error(`${method} ${path}: ${j.value.error}: ${j.value.message}`);
  return j.value;
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
  'appium:includeSafariInWebviews': true, 'appium:safariInitialUrl': (req.targets ? req.targets[0].url : req.url),
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
let el;
if (kind === 'href') el = document.querySelector('a[href="' + key + '"]');
else el = [...document.querySelectorAll('a,button')].find(e => e.textContent.trim() === key && e.getBoundingClientRect().width > 0);
if (!el) return null;
if (kind === 'href') el.scrollIntoView({block:'center'});
const r = el.getBoundingClientRect();
return {x: r.x + r.width/2, y: r.y + r.height/2, w: r.width, h: r.height};`;

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
  await sleep(150);
  const f2 = await js(FIND, [kind, key]); // re-read after scrollIntoView settles
  const els = await wd('POST', S('/elements'), { using: 'css selector', value: kind === 'href' ? `a[href="${key}"]` : 'a,button' });
  let target;
  if (kind === 'href') target = els[0];
  else {
    for (const e of els) {
      const id = Object.values(e)[0];
      const txt = (await wd('GET', S(`/element/${id}/text`))).trim();
      const vis = await wd('GET', S(`/element/${id}/displayed`));
      if (txt === key && vis) { target = e; break; }
    }
  }
  const id = Object.values(target)[0];
  log({ ev: 'tap', label, rect: f2 });
  await wd('POST', S(`/element/${id}/click`), {});
}

async function watch(prefix, ms, everyMs = 250) {
  const end = Date.now() + ms; let i = 0;
  while (Date.now() < end) {
    const s = await js(SAMPLE).catch((e) => ({ err: String(e) }));
    const f = shot(`${prefix}-${String(i).padStart(2, '0')}`);
    log({ ev: 'sample', prefix, i, sample: s });
    i++; await sleep(everyMs);
  }
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

// row-35 verdict from the watch samples: covered = a footer pill in the DOM but something else on top at its centre
function verdictOf(samples) {
  const s = samples.filter((x) => x.pills);
  const bad = s.filter((x) => x.pills.length < 4 || x.pills.some((p) => !p.onTop || +p.opacity < 1));
  const firstClear = s.findIndex((x, i) => s.slice(i).every((y) => y.pills.length >= 4 && y.pills.every((p) => p.onTop && +p.opacity >= 1)));
  return { samples: s.length, badSamples: bad.length, verdict: bad.length ? 'COVERED/NOT-PERSISTENT' : 'HELD', firstClearSample: firstClear };
}

async function oneWalk(t, n) {
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
    await tap('text', 'Next', 'next-3-row35');
    await watch(`${pre}-05-row35`, 3500);
    await sleep(1000); shot(`${pre}-06-settled`);
  } catch (e) {
    log({ ev: 'error', target: t.name, walk: n, message: String(e) });
    try { shot(`${pre}-99-error`); } catch {}
  }
  const samples = trace.events.slice(mark).filter((e) => e.ev === 'sample' && e.prefix === `${pre}-05-row35`).map((e) => e.sample);
  const v = { target: t.name, walk: n, ...verdictOf(samples) };
  if (!samples.length) v.verdict = 'NO-DATA';
  verdicts.push(v); log({ ev: 'verdict', ...v });
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
