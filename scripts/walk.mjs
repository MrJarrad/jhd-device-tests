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
  'appium:wdaConnectionTimeout': 300000, 'appium:newCommandTimeout': 300,
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
    opacity: getComputedStyle(e).opacity, onTop: top === e || e.contains(top) || (top && top.contains(e) && false)};
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

try {
  rec = spawn('xcrun', ['simctl', 'io', udid, 'recordVideo', '--codec=h264', '--force', `${out}/walk.mp4`], { stdio: 'ignore' });
  await sleep(1500);
  log({ ev: 'record-start' });
  await wd('POST', S('/url'), { url: req.url });
  log({ ev: 'navigated', url: req.url });
  await sleep(4000);
  shot('00-load'); log({ ev: 'shot', n: '00-load', sample: await js(SAMPLE) });

  // lock row 35 path: load -> Next -> Next -> Projects -> card -> Next
  await tap('text', 'Next', 'next-1'); await sleep(3500); shot('01-after-next-1');
  await tap('text', 'Next', 'next-2'); await sleep(3500); shot('02-after-next-2');
  await tap('text', 'Projects', 'projects'); await sleep(3500); shot('03-home');
  await tap('href', req.card, 'card-yardsale'); await sleep(req.cardWaitMs ?? 3000); shot('04-before-next-3');
  await tap('text', 'Next', 'next-3-row35');
  await watch('05-row35', 3500);
  await sleep(1000); shot('06-settled'); log({ ev: 'settled', sample: await js(SAMPLE) });
} catch (e) {
  log({ ev: 'error', message: String(e) });
  try { shot('99-error'); } catch {}
  process.exitCode = 1;
} finally {
  if (rec) { rec.kill('SIGINT'); await new Promise((r) => rec.on('exit', r)); }
  try { await wd('DELETE', S('')); } catch {}
  writeFileSync(`${out}/trace.json`, JSON.stringify(trace, null, 1));
}
