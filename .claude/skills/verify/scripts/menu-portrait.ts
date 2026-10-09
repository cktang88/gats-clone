/// <reference types="node" />
/**
 * The front page held upright on a phone (and on a tablet, a desktop and a phone on its side, to prove those did not move).
 *
 *   CHROME=... node .claude/skills/verify/scripts/menu-portrait.ts <run-dir> <out-dir> [WxH[i] ...]
 *
 * One headless Chrome emulates an iPhone in Safari (touch, DPR 3, an iOS user agent, no page fullscreen, so the home-screen tip
 * shows) at each size, as a guest and then signed in, on the mode step and the loadout step. A trailing `i` on a size adds an
 * iPhone's safe-area insets (59px top for the Dynamic Island, 34px bottom). Widths of 600px or more run as a desktop or a phone on
 * its side. For every screen it checks, and logs `ok` or `FAIL`:
 *   - no two runs of text overprint each other, and no text runs over a button or field it does not belong to;
 *   - no text spills past the screen's sides or is cut off by a box that clips it (an ellipsis on purpose is logged, not failed);
 *   - the page never scrolls sideways;
 *   - on the guest's mode step in portrait, the mode dropdown and Next sit above the fold (the bottom inset taken off).
 * Screenshots go to <out-dir>/<who>-<step>-<W>x<H>.png. Exits non-zero on any FAIL.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openPage, serversListed, sleep } from './lib/browser.ts';

const [RUN, OUT, ...sizeArgs] = process.argv.slice(2);
if (!RUN || !OUT) { console.error('usage: menu-portrait.ts <run-dir> <out-dir> [WxH[i] ...]'); process.exit(2); }
const BASE = `http://localhost:${readFileSync(join(RUN, 'port'), 'utf8').trim()}`;
mkdirSync(OUT, { recursive: true });
const DEFAULT = ['320x568', '320x667', '360x780', '375x667', '390x844', '393x852i', '393x700', '414x896', '430x932i', '768x1024', '932x370', '1024x768', '1280x800', '1440x900'];
const sizes = (sizeArgs.length ? sizeArgs : DEFAULT).map((s) => {
  const m = /^(\d+)x(\d+)(i?)$/.exec(s);
  if (!m) throw new Error(`bad size ${s}`);
  return { w: +m[1]!, h: +m[2]!, insets: m[3] === 'i' };
});
const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const log: string[] = [];
let failed = 0;
const say = (line: string) => { console.log(line); log.push(line); };
const expect = (what: string, ok: boolean, detail = '') => { if (!ok) failed++; say(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` (${detail})` : ''}`); };

const page = await openPage({ profile: 'tinwar-portrait-', onProblem: (kind, d) => say(`note ${kind}: ${d.slice(0, 200)}`) });
const { cdp, js } = page;
// Safari on an iPhone: no element fullscreen, so the page shows its Add to Home Screen tip.
await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `
  for (const k of ['requestFullscreen', 'webkitRequestFullscreen']) try { Object.defineProperty(Element.prototype, k, { value: undefined, configurable: true }); } catch {}
  try { Object.defineProperty(Document.prototype, 'fullscreenEnabled', { get: () => false, configurable: true }); } catch {}
` });

type Size = (typeof sizes)[number];
async function emulate(s: Size) {
  const phone = s.w < 600 || s.h < 520;
  const desk = !phone && s.w >= 1024 && s.h < s.w;
  await cdp('Emulation.setDeviceMetricsOverride', { width: s.w, height: s.h, deviceScaleFactor: desk ? 1 : 3, mobile: !desk, screenOrientation: { type: s.w > s.h ? 'landscapePrimary' : 'portraitPrimary', angle: s.w > s.h ? 90 : 0 } });
  await cdp('Emulation.setTouchEmulationEnabled', { enabled: !desk, maxTouchPoints: desk ? 0 : 5 });
  await cdp('Emulation.setEmitTouchEventsForMouse', { enabled: !desk, configuration: 'mobile' });
  await cdp('Emulation.setUserAgentOverride', desk ? { userAgent: '' } : { userAgent: IOS_UA, platform: 'iPhone' });
}
async function load(s: Size) {
  await emulate(s);
  await cdp('Page.navigate', { url: `${BASE}/` });
  await sleep(300);
  await serversListed(page, 8000);
  if (s.insets) await js(`(() => { const st = document.createElement('style'); st.id = 'inset-sim'; st.textContent = ':root { --st: 59px !important; --sb: 34px !important; }'; document.head.append(st); })()`);
  await js(`document.fonts.ready.then(() => true)`);
  await sleep(700);
}
async function shot(name: string) {
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
}

/** Every visible run of text in the menu, line by line, with what clips it, and every button and field. */
const MEASURE = `(() => {
  const menu = document.getElementById('menu');
  const vw = innerWidth, vh = innerHeight;
  const sb = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sb')) || 0;
  const label = (e) => (e.id ? '#' + e.id : e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\\s+/)[0] : e.tagName.toLowerCase());
  const visible = (e) => e.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  const runs = [];
  const walk = document.createTreeWalker(menu, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (!n.textContent.trim()) continue;
    const el = n.parentElement;
    if (!el || !visible(el) || el.closest('[hidden], .mode-list, .menu-backdrop, svg')) continue;
    // Read by a screen reader only (a 1px clipped label).
    const own = el.getBoundingClientRect();
    if (own.width <= 1 || own.height <= 1) continue;
    const r = document.createRange(); r.selectNodeContents(n);
    const rects = [...r.getClientRects()].filter((q) => q.width > 1 && q.height > 1);
    if (!rects.length) continue;
    runs.push({ el, text: n.textContent.trim().slice(0, 40), rects });
  }
  const problems = [];
  // A sticky or fixed plate (Deploy at the foot of the loadout) rides over the page as it scrolls, by design.
  const floats = (e) => { for (let a = e; a && a !== menu; a = a.parentElement) { const p = getComputedStyle(a).position; if (p === 'sticky' || p === 'fixed') return true; } return false; };
  const hit = (a, b, pad = 1) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > pad && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > pad;
  // Text over text: two runs whose glyph boxes cross.
  for (let i = 0; i < runs.length; i++) for (let j = i + 1; j < runs.length; j++) {
    const a = runs[i], b = runs[j];
    if (a.el === b.el || floats(a.el) !== floats(b.el)) continue;
    if (a.rects.some((p) => b.rects.some((q) => hit(p, q, 2)))) problems.push('text over text: "' + a.text + '" (' + label(a.el) + ') x "' + b.text + '" (' + label(b.el) + ')');
  }
  // Text over a control it is not part of.
  const controls = [...menu.querySelectorAll('button, input, a.top-btn, .mode-trigger')].filter((c) => visible(c) && !c.closest('[hidden], .mode-list'));
  for (const run of runs) for (const c of controls) {
    if (c.contains(run.el) || run.el.contains(c) || floats(c) !== floats(run.el)) continue;
    const box = c.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) continue;
    if (run.rects.some((p) => hit(p, box, 2))) problems.push('text over control: "' + run.text + '" (' + label(run.el) + ') x ' + label(c));
  }
  // Off screen, or cut off by a clipping box.
  const ellipsis = [];
  for (const run of runs) {
    for (const p of run.rects) if (p.left < -0.5 || p.right > vw + 0.5) { problems.push('text past the screen edge: "' + run.text + '" (' + label(run.el) + ') ' + Math.round(p.left) + '..' + Math.round(p.right)); break; }
    for (let a = run.el; a && a !== menu; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      const box = a.getBoundingClientRect();
      // Nothing to cut when the box holds all its content (italic overhang and trailing letter-spacing poke out harmlessly).
      const full = a.scrollWidth <= a.clientWidth + 1 && (cs.overflowY === 'auto' || cs.overflowY === 'scroll' || a.scrollHeight <= a.clientHeight + 1);
      const cut = !full && run.rects.some((p) => p.left < box.left - 1.5 || p.right > box.right + 1.5 || (cs.overflowY !== 'visible' && cs.overflowY !== 'auto' && cs.overflowY !== 'scroll' && (p.top < box.top - 1 || p.bottom > box.bottom + 1)));
      if (cut) { (cs.textOverflow === 'ellipsis' || getComputedStyle(run.el).textOverflow === 'ellipsis' ? ellipsis : problems).push('text clipped: "' + run.text + '" (' + label(run.el) + ') by ' + label(a)); }
      break;
    }
  }
  const box = (id) => { const e = document.getElementById(id); if (!e || !visible(e)) return null; const r = e.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom) }; };
  return { problems: [...new Set(problems)], ellipsis: [...new Set(ellipsis)], vw, vh, sb,
    sideScroll: Math.max(document.documentElement.scrollWidth, menu.scrollWidth) - vw,
    trigger: box('mode-trigger'), next: box('mode-next'), play: box('play'), enlist: box('enlist'), scrollH: menu.scrollHeight,
    tip: box('a2hs'), top: box('menu-tabs') };
})()`;

async function check(name: string, s: Size, step: 'menu' | 'gear', guest: boolean) {
  await js(`document.getElementById('menu').scrollTo(0, 0)`);
  await sleep(150);
  await shot(name);
  const m = await js(MEASURE);
  for (const e of m.ellipsis) say(`note ${name}: ${e}`);
  expect(`${name}: no overprinted or clipped text`, m.problems.length === 0, m.problems.slice(0, 6).join('; '));
  expect(`${name}: no sideways scroll`, m.sideScroll <= 0, `${m.sideScroll}px`);
  if (step === 'menu' && s.w < 600) {
    const fold = m.vh - m.sb;
    say(`info ${name}: tip ${JSON.stringify(m.tip)} enlist ${JSON.stringify(m.enlist)} trigger ${JSON.stringify(m.trigger)} next ${JSON.stringify(m.next)} fold ${fold}`);
    expect(`${name}: mode dropdown above the fold`, !!m.trigger && m.trigger.bottom <= fold, `bottom ${m.trigger?.bottom} / ${fold}`);
    expect(`${name}: Next above the fold`, !!m.next && m.next.bottom <= fold, `bottom ${m.next?.bottom} / ${fold}`);
  }
  if (step === 'gear') say(`info ${name}: Deploy at ${JSON.stringify(m.play)} of ${m.scrollH}px`);
  void guest;
}

async function pass(who: 'guest' | 'signed') {
  for (const s of sizes) {
    await load(s);
    const tag = `${s.w}x${s.h}${s.insets ? 'i' : ''}`;
    if (who === 'guest') {
      const tip = await js(`!document.getElementById('a2hs').hidden`);
      if (s.w < 600) expect(`guest-menu-${tag}: the home-screen tip shows`, tip);
      const enlist = await js(`!document.getElementById('enlist').hidden`);
      expect(`guest-menu-${tag}: the enlist plate shows`, enlist);
    }
    await check(`${who}-menu-${tag}`, s, 'menu', who === 'guest');
    await js(`document.getElementById('mode-next').click()`);
    await sleep(500);
    await check(`${who}-gear-${tag}`, s, 'gear', who === 'guest');
  }
}

await emulate(sizes[0]!);
await cdp('Page.navigate', { url: `${BASE}/` });
await serversListed(page, 8000);
await js(`localStorage.clear(); sessionStorage.clear()`);
await pass('guest');
// The register form, inline, at the first size; then every size again signed in.
await load(sizes[0]!);
await js(`document.getElementById('enlist-create').click()`);
await sleep(300);
await check(`guest-register-${sizes[0]!.w}x${sizes[0]!.h}`, sizes[0]!, 'gear', true);
const name = `Port${Date.now() % 100000}`;
await js(`(() => { document.getElementById('enlist-name').value = '${name}'; document.getElementById('enlist-pass').value = 'verify-pass'; document.getElementById('enlist-submit').click(); })()`);
for (let i = 0; i < 50 && !(await js(`!!document.querySelector('#top-me')`)); i++) await sleep(100);
expect('registered from the enlist plate', await js(`!!document.querySelector('#top-me')`));
await pass('signed');
say(failed ? `RESULT FAIL (${failed})` : 'RESULT PASS');
writeFileSync(join(OUT, 'menu-portrait.log'), log.join('\n') + '\n');
page.close();
process.exit(failed ? 1 : 0);
