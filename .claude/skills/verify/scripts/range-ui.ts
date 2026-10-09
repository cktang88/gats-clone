/// <reference types="node" />
// Usage: node range-ui.ts <run-dir> <out-dir>
// Opens a private shooting range through the menu card in headless Chrome, picks a loadout in the panel, shoots a paper target until it falls,
// watches it stand up again about four seconds later, and screenshots each state: the menu card, the range from the booth, the loadout panel,
// the readout mid-fire, the fall and the spring back. Reads gameplay from the page's own socket frames, never from client state.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Snapshot } from '../../../../src/shared/protocol.ts';
import { MAPS } from '../../../../src/shared/maps.ts';
import { fillSnapshot } from '../../../../src/shared/wire.ts';
import { openPage, sleep, hold, serversListed, type Dir } from './lib/browser.ts';

const [RUN, OUT] = process.argv.slice(2);
if (!RUN || !OUT) { console.error('usage: node range-ui.ts <run-dir> <out-dir>'); process.exit(2); }
const VIEW = { w: Number(process.env.W ?? 1600), h: Number(process.env.H ?? 900) };
const BASE = existsSync(join(RUN, 'url')) ? readFileSync(join(RUN, 'url'), 'utf8').trim().replace(/\/$/, '') : `http://localhost:${readFileSync(join(RUN, 'port'), 'utf8').trim()}`;
mkdirSync(OUT, { recursive: true });
const log: string[] = [];
const say = (line: string) => { console.log(line); log.push(line); };
let failed = false;
const check = (ok: boolean, what: string) => { say(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed = true; };

let myId: number | null = null;
let full = null as Snapshot | null;
const frames: { t: number; targets: number[] | undefined; shots: number; tick: number }[] = [];
const page = await openPage({
  profile: 'skirmish-range-',
  viewport: { width: VIEW.w, height: VIEW.h },
  onEvent: (method, params) => {
    if (method !== 'Network.webSocketFrameReceived') return;
    const msg = JSON.parse(params.response.payloadData);
    if (msg.t === 'welcome') { myId = msg.id; full = null; }
    if (msg.t === 'snap') {
      full = fillSnapshot(msg, full) ?? full;
      if (full) frames.push({ t: Date.now(), targets: full.targets, shots: full.range?.shots ?? 0, tick: full.tick });
    }
  },
});
const { cdp, js } = page;
const me = () => full?.players.find((p) => p.id === myId);
const shot = async (name: string) => {
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
  say(`saved ${name}.png`);
};
const mouse = (type: string, x: number, y: number) => cdp('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
const keyTap = async (code: string, k: string, vk: number) => {
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', code, key: k, windowsVirtualKeyCode: vk });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', code, key: k, windowsVirtualKeyCode: vk });
};
const clickText = (selector: string, text: string) => js(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(selector)})].find((n) => n.textContent.trim().toLowerCase().startsWith(${JSON.stringify(text.toLowerCase())})); if (!b) return false; (b.closest('button') ?? b).click(); return true; })()`);

/** Out along the back of the booth and up to the firing line level with `y`: the short dividers at each bay's edge block a straight walk. */
async function goLane(y: number) {
  await goTo(200, me()?.y ?? y);
  await goTo(200, y);
  await goTo(330, y);
}

async function goTo(x: number, y: number, tol = 14) {
  for (let i = 0; i < 160; i++) {
    const self = me();
    if (!self) { await sleep(100); continue; }
    const dirs: Dir[] = [];
    if (Math.abs(x - self.x) > tol) dirs.push(x > self.x ? 'right' : 'left');
    if (Math.abs(y - self.y) > tol) dirs.push(y > self.y ? 'down' : 'up');
    if (!dirs.length) return;
    const far = Math.hypot(x - self.x, y - self.y) > 120;
    await hold(page, dirs, far ? 220 : 60);
    await sleep(60);
  }
  say(`gave up walking to (${x}, ${y}) from (${Math.round(me()?.x ?? 0)}, ${Math.round(me()?.y ?? 0)})`);
}

// ---- the menu card
await cdp('Page.navigate', { url: `${BASE}/?dev` });
await serversListed(page, 8000);
check(!!(await js(`!!document.querySelector('#range-card #range-start')`)), 'the menu has a Shooting range card with a button');
check((await js(`document.querySelector('#range-card .range-title b')?.textContent`)) === 'Shooting range', 'the card is titled');
check(!(await js(`[...document.querySelectorAll('#servers .server')].some((s) => s.textContent.includes('RNG'))`)), 'ranges stay off the public server list');
await js(`document.getElementById('range-card').scrollIntoView({ block: 'center' })`);
await sleep(500);
await shot('01-menu-card');

// ---- into the range
const [bx, by] = await js(`(() => { const b = document.getElementById('range-start'); const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: bx, y: by, button: 'left', clickCount: 1 });
await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: bx, y: by, button: 'left', clickCount: 1 });
for (let i = 0; i < 100 && !(full?.targets && me()); i++) await sleep(100);
check(!!full?.targets && full.targets.length === MAPS.range.range!.targets.length, `joined a range with ${full?.targets?.length ?? 0} targets`);
check(full?.match.mode === 'RNG', 'the room is mode RNG');
check((full?.players.length ?? 0) === 1, 'no bots share the range');
check(!!(await js(`!document.getElementById('range-hud').hidden`)), 'the readout shows');
await sleep(1200);
await shot('02-range-booth');

// ---- the loadout panel
await keyTap('KeyL', 'l', 76);
await sleep(500);
check(!!(await js(`!document.getElementById('range-panel').hidden`)), 'L opens the loadout panel');
const gunTiles = await js(`document.querySelectorAll('#range-panel .rp-tile').length`);
const perkChips = await js(`document.querySelectorAll('#range-panel .rp-chip').length`);
say(`panel offers ${gunTiles} guns and ${perkChips} perk and armor chips`);
await shot('03-loadout-panel');
await clickText('#range-panel .rp-tile b', 'Hailstorm');
await sleep(150);
await clickText('#range-panel .rp-chip b', 'Grip');
await clickText('#range-panel .rp-chip b', 'Steady hands');
await clickText('#range-panel .rp-chip b', 'Frag grenade');
await clickText('#range-panel .rp-chip b', 'Medium');
await sleep(700);
check(me()?.gun === 'hailstorm', `the server put on the Hailstorm (${me()?.gun})`);
check(JSON.stringify(full?.self.perks) === JSON.stringify({ 1: 'grip', 2: 'steadyHands', 3: 'fragGrenade' }), `and the perks (${JSON.stringify(full?.self.perks)})`);
await shot('04-loadout-picked');
await keyTap('KeyL', 'l', 76);
await sleep(300);
check(!!(await js(`document.getElementById('range-panel').hidden`)), 'L closes it');

// ---- shoot the nearest paper target in the field (100 px out)
const layout = MAPS.range.range!;
const idx = layout.targets.findIndex((t) => t.kind === 'paper' && t.x === layout.line + 100);
const t = layout.targets[idx]!;
await goLane(t.y);
await mouse('mouseMoved', VIEW.w / 2 + 420, VIEW.h / 2);
await sleep(300);
await mouse('mousePressed', VIEW.w / 2 + 420, VIEW.h / 2);
let downAt = 0;
for (let i = 0; i < 80; i++) {
  await sleep(40);
  if (i === 6) await shot('05-shooting-readout');
  if ((full?.targets?.[idx] ?? 10) === 0) { downAt = Date.now(); break; }
}
await mouse('mouseReleased', VIEW.w / 2 + 420, VIEW.h / 2);
check(downAt > 0, 'the paper target fell');
await shot('06-fell-0ms');
await sleep(170);
await shot('07-fell-170ms');
await sleep(500);
await shot('08-lying');
const range = full?.range;
say(`readout: ${JSON.stringify(range)}`);
check(!!range && range.shots > 0 && range.hits > 0 && range.downs >= 1, 'the readout counted shots, hits and a downed target');
check(!!range?.ttk && range.ttk.kind === 'paper', 'with a time to kill on a paper target');
const readoutText: string = await js(`document.getElementById('range-hud').innerText.replace(/\\s+/g, ' ')`);
say(`readout plate: ${readoutText}`);
check(/Accuracy/i.test(readoutText) && /DPS/i.test(readoutText) && /Time to kill/i.test(readoutText), 'the plate shows accuracy, DPS and time to kill');

// ---- regeneration
let upAt = 0;
for (let i = 0; i < 200; i++) {
  if ((full?.targets?.[idx] ?? 0) > 0) { upAt = Date.now(); break; }
  await sleep(50);
}
await shot('09-regen-0ms');
await sleep(130);
await shot('10-regen-130ms');
await sleep(500);
await shot('11-regen-settled');
// The server's own ticks time it, not the screenshots' delays.
const fell = frames.findIndex((f) => f.targets?.[idx] === 0);
const rose = frames.findIndex((f, i) => i > fell && (f.targets?.[idx] ?? 0) > 0);
const lay = fell >= 0 && rose > fell ? Math.round(((frames[rose]!.tick - frames[fell]!.tick) * 1000) / 30) : 0;
say(`down for ${lay} ms by the server's ticks`);
check(lay >= 3900 && lay <= 4300, 'it stood up again about four seconds after falling');

// ---- the sliders, the far end of the field and the blast corner, each from the firing line
await keyTap('KeyL', 'l', 76);
await sleep(200);
await clickText('#range-panel .rp-tile b', 'Marksman');
await clickText('#range-panel .rp-chip b', 'Optics');
await sleep(300);
await keyTap('KeyL', 'l', 76);
await goLane(500);
await mouse('mouseMoved', VIEW.w / 2 + 420, VIEW.h / 2);
await sleep(800);
await shot('12-rails');
await goLane(1030);
await sleep(600);
await shot('13-field');
await goLane(1900);
await sleep(600);
await shot('14-blast-lane');
for (const e of page.exceptions) { say(`exception: ${e}`); failed = true; }
writeFileSync(join(OUT, 'range-ui.log'), log.join('\n'));
say(failed ? 'RESULT FAIL' : 'RESULT PASS');
page.close();
process.exit(failed ? 1 : 0);
