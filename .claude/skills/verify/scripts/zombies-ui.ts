/// <reference types="node" />
// Usage: node zombies-ui.ts <run-dir> [step ...]   Steps: menu badlink squad build turrets night (default, in order), plus drag, variety, downed and report on request.
// Drives the zombies client in headless Chrome through real input. downed and report need a scratch copy with fragile humans and a weak core, and turrets builds a cannon
// only on a scratch copy with more starting scrap, and variety (tiers, upgrades, every kind) needs about 3000 (see features/zombies.md).
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import type { BuildingView, RunView, Snapshot, ZombieView } from '../../../../src/shared/protocol.ts';
import type { BuildingKind, TurretKind } from '../../../../src/shared/defs.ts';
import { fillSnapshot } from '../../../../src/shared/wire.ts';
import { BUILDINGS, byTurret, nightOf, WALL_TIERS, ZOM, ZOMBIE_KINDS, ZOMBIES } from '../../../../src/shared/defs.ts';
import { costOf } from '../../../../src/shared/sim/build.ts';
import { forecast, squadShare } from '../../../../src/client/zombies.ts';
import { hold, key, openPage, serversListed, sleep, type Dir } from './lib/browser.ts';

const RUN = process.argv[2];
if (!RUN) { console.error('usage: node zombies-ui.ts <run-dir> [step ...]'); process.exit(2); }
const steps = process.argv.length > 3 ? process.argv.slice(3) : ['menu', 'badlink', 'squad', 'build', 'turrets', 'night'];
const BASE = `http://localhost:${readFileSync(join(RUN, 'port'), 'utf8').trim()}`;
const EV = join(RUN, 'evidence');
const LOG = join(EV, 'zombies-ui.log');
mkdirSync(EV, { recursive: true });
const VIEW = { w: 1280, h: 800 };
const NAME = `Zed${Math.floor(Math.random() * 1e4)}`;
const log = (line: string) => { console.log(line); appendFileSync(LOG, line + '\n'); };
const problems: string[] = [];
const expect = (label: string, ok: boolean, detail = '') => { log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  (${detail})` : ''}`); if (!ok) problems.push(label); return ok; };

const frames = {
  welcome: null as null | { id: number; mode: string }, snap: null as Snapshot | null,
  turretShots: byTurret(() => 0), turretKills: 0, lowestAmmo: byTurret(() => 10), scrapEarned: 0, coils: 0, aids: 0,
};
const page = await openPage({
  profile: 'skirmish-zombies-',
  viewport: { width: VIEW.w, height: VIEW.h },
  onEvent: (method, params) => {
    if (method !== 'Network.webSocketFrameReceived') return;
    const msg = JSON.parse(params.response.payloadData);
    if (msg.t === 'welcome') { frames.welcome = msg; frames.snap = null; }
    if (msg.t === 'snap') {
      frames.snap = fillSnapshot(msg, frames.snap) ?? frames.snap;
      for (const e of frames.snap?.events ?? []) {
        if (e.e === 'turret') frames.turretShots[e.kind]++;
        if (e.e === 'coil') frames.coils++;
        if (e.e === 'aid') frames.aids++;
        if (e.e === 'zkill' && e.by === null) frames.turretKills++;
        if (e.e === 'zkill') frames.scrapEarned += ZOMBIES[e.kind].scrap;
      }
      for (const b of frames.snap?.buildings ?? []) if ('ammo' in b) frames.lowestAmmo[b.kind] = Math.min(frames.lowestAmmo[b.kind], b.ammo);
    }
  },
  onProblem: (kind, detail) => problems.push(`${kind}: ${detail}`),
});
const { cdp, js } = page;
const shot = async (name: string, clip?: { x: number; y: number; width: number; height: number; scale: number }) => {
  const { data } = await cdp('Page.captureScreenshot', { format: 'png', ...(clip && { clip }) });
  writeFileSync(join(EV, `${name}.png`), Buffer.from(data, 'base64'));
  log(`shot ${name}.png`);
};
const until = async (fn: () => unknown, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(100); } return false; };
const mouse = (type: string, x: number, y: number, button: 'left' | 'right' | 'none' = 'none') => cdp('Input.dispatchMouseEvent', { type, x, y, button, clickCount: type === 'mouseMoved' ? 0 : 1 });
const click = async (x: number, y: number, button: 'left' | 'right' = 'left') => { await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y, button); await mouse('mouseReleased', x, y, button); };
const clickEl = async (selector: string) => {
  const at = await js(`(() => { const b = document.querySelector('${selector}'); if (!b || !b.getClientRects().length) return null; b.scrollIntoView({ block: 'nearest' }); const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  if (!at) return false;
  await click(at[0], at[1]);
  return true;
};
const tap = async (code: string, k: string) => { await key(page, 'keyDown', code, k); await sleep(60); await key(page, 'keyUp', code, k); };
const status = () => js(`document.getElementById('menu-status').textContent`) as Promise<string>;
const me = () => frames.snap?.players.find((p) => p.id === frames.welcome?.id);
const run = (): RunView | undefined => frames.snap?.run;
type ZombiesDev = {
  building: boolean; buildKind: BuildingKind; buildTier: number; chips: { pick: { kind?: BuildingKind; lv?: number; upgrade?: true }; x: number; y: number; w: number; h: number }[]; use: string | null;
  ghost: { kind: BuildingKind; lv: number; cx: number; cy: number; refusal: string | null; label: string; detail: string | null; upgrade: string | null; hover: { name: string; lv: number; top: number; hpPct: number; next: { name: string; cost: number } | null } | null } | null;
  coreAlert: boolean; callouts: string[];
};
const zdev = () => js(`skirmishDev.zombies()`) as Promise<ZombiesDev | null>;
const toScreen = (x: number, y: number) => js(`skirmishDev.toScreen(${x}, ${y})`) as Promise<{ x: number; y: number } | null>;
const aimAtWorld = async (x: number, y: number) => { const at = await toScreen(x, y); if (at) await mouse('mouseMoved', at.x, at.y); return at; };
const cellCenter = (cx: number, cy: number) => ({ x: (cx + 0.5) * ZOM.cell, y: (cy + 0.5) * ZOM.cell });
const hasWall = (b: readonly BuildingView[] | undefined, cx: number, cy: number) => !!b?.some((w) => w.cx === cx && w.cy === cy);
const turretAt = (cell: { cx: number; cy: number }) =>
  frames.snap?.buildings?.find((b): b is Extract<BuildingView, { ammo: number }> => b.cx === cell.cx && b.cy === cell.cy && 'ammo' in b);
let squad = '';
/**
 * A magnified shot of the screen round a world point, for detail the full view draws too small to judge. The page is redrawn at 3x device pixels for it,
 * so the detail is drawn, not stretched, and put back to 1x after.
 */
async function closeUp(name: string, x: number, y: number) {
  const at = await toScreen(x, y);
  if (!at) return;
  const view = (deviceScaleFactor: number) => cdp('Emulation.setDeviceMetricsOverride', { ...VIEW, deviceScaleFactor, mobile: false, width: VIEW.w, height: VIEW.h });
  await view(3);
  await js(`window.dispatchEvent(new Event('resize'))`);
  await sleep(450);
  const crisp = await toScreen(x, y);
  await shot(name, { x: Math.max(0, (crisp ?? at).x - 120), y: Math.max(0, (crisp ?? at).y - 80), width: 240, height: 160, scale: 1 });
  await view(1);
  await js(`window.dispatchEvent(new Event('resize'))`);
  await sleep(200);
}

/** The turrets the turrets step put up, for the night to watch. */
const turrets: { kind: TurretKind; cx: number; cy: number }[] = [];
/** What the variety step put up, by label, for the night to look at. */
const gallery = new Map<string, { cx: number; cy: number }>();

/** Points the ghost at cells around the player until it shows one the picked kind may go up on. */
async function buildableCell(): Promise<{ cx: number; cy: number } | null> {
  const self = me()!;
  for (const [dx, dy] of [[-2, 0], [-2, 1], [-2, -1], [0, 2], [0, -2], [2, 2], [-3, 0], [0, 3], [2, -2], [-2, 2], [-2, -2], [3, 0], [0, -3]]) {
    const cx = Math.floor(self.x / ZOM.cell) + dx, cy = Math.floor(self.y / ZOM.cell) + dy;
    await aimAtWorld(cellCenter(cx, cy).x, cellCenter(cx, cy).y);
    await sleep(80);
    const g = (await zdev())?.ghost;
    if (g?.cx === cx && g.cy === cy && g.refusal === null) return { cx, cy };
  }
  return null;
}

/** Holds the keys toward a world point until the player stands within `near` px of it. */
async function walkTo(x: number, y: number, near: number, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const self = me();
    if (!self?.alive) { await sleep(150); continue; }
    if (Math.hypot(x - self.x, y - self.y) <= near) return true;
    const dirs = ([x > self.x + 15 ? 'right' : x < self.x - 15 ? 'left' : null, y > self.y + 15 ? 'down' : y < self.y - 15 ? 'up' : null] as const).filter((d): d is Dir => d !== null);
    await hold(page, dirs, 120);
  }
  return false;
}

log(`zombies-ui ${new Date().toISOString()} base=${BASE} name=${NAME} steps=${steps.join(',')}`);

const openMenu = async (query = '') => {
  await cdp('Page.navigate', { url: `${BASE}/?dev${query}` });
  await serversListed(page);
  await js(`document.getElementById('name').value = '${NAME}'`);
};
const showSquadMenu = () => js(`document.getElementById('mode-pick').scrollIntoView({ block: 'nearest' })`);
/** Picks Zombies in the mode card's dropdown with real clicks (the button, then the option), then presses Next for the loadout step. */
const pickZombies = async () => {
  if (!(await clickEl('#mode-trigger'))) return false;
  await sleep(200);
  if (!(await clickEl('#mode-opt-zom'))) return false;
  await sleep(150);
  return clickEl('#mode-next');
};

/** Clear of the HUD panels and DOM overlays round the edges, so a press always reaches the canvas. */
const AIM_BOX = { x0: 200, y0: 150, x1: VIEW.w - 240, y1: VIEW.h - 150 };

/** A point toward `to` from the player's spot on screen, pulled in along that line until it sits in AIM_BOX over the canvas, so the shot keeps its heading. */
async function aimPoint(from: { x: number; y: number }, to: { x: number; y: number }): Promise<{ x: number; y: number } | null> {
  for (const k of [1, 0.7, 0.5, 0.35, 0.25]) {
    const at = { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k };
    if (at.x < AIM_BOX.x0 || at.x > AIM_BOX.x1 || at.y < AIM_BOX.y0 || at.y > AIM_BOX.y1) continue;
    if (Math.hypot(at.x - from.x, at.y - from.y) < 40) return null;
    if (await js(`document.elementFromPoint(${at.x}, ${at.y})?.id === 'game'`)) return at;
  }
  return null;
}

/** Holds fire on the nearest zombie and strafes beside the core until `done`, respawning nothing: a run brings its players back itself. A press whose gun never fires is let go and pressed again. */
async function fight(done: () => Promise<boolean> | boolean, ms: number, onTick: () => Promise<void> = async () => {}) {
  const end = Date.now() + ms;
  let pressed = false;
  let step = 0;
  let ammo = { left: -1, since: Date.now() };
  while (Date.now() < end && !(await done())) {
    const self = me();
    const horde: ZombieView[] = frames.snap?.zombies ?? [];
    const near = self && horde.length ? horde.reduce((a, b) => (Math.hypot(a[2] - self.x, a[3] - self.y) <= Math.hypot(b[2] - self.x, b[3] - self.y) ? a : b)) : null;
    const from = self && await toScreen(self.x, self.y);
    const to = near && await toScreen(near[2], near[3]);
    const at = self?.alive && from && to ? await aimPoint(from, to) : null;
    const left = frames.snap?.self.ammo ?? -1;
    if (left !== ammo.left || frames.snap?.self.reloading) ammo = { left, since: Date.now() };
    if (pressed && (!at || Date.now() - ammo.since > 1000)) {
      await mouse('mouseReleased', VIEW.w / 2, VIEW.h / 2, 'left');
      pressed = false;
      ammo.since = Date.now();
    }
    if (at) await mouse('mouseMoved', at.x, at.y);
    if (at && !pressed) { await mouse('mousePressed', at.x, at.y, 'left'); pressed = true; }
    if (++step % 10 === 0 && self?.alive && run()) {
      const core = run()!.core;
      if (Math.hypot(core.x - self.x, core.y - self.y) > 220) await hold(page, [core.x > self.x ? 'right' : 'left'], 200);
    }
    await onTick();
    await sleep(100);
  }
  if (pressed) await mouse('mouseReleased', VIEW.w / 2, VIEW.h / 2, 'left');
}

const STEPS: Record<string, () => Promise<void>> = {
  async menu() {
    await openMenu();
    expect('the mode dropdown offers a zombies squad', await js(`!!document.getElementById('mode-opt-zom')`));
    expect('Zombies is picked from the dropdown and Next goes on', await pickZombies());
    expect('choosing it opens the gear-up step', await until(() => js(`!document.getElementById('play-form').hidden`)));
    await clickEl('#loadout-menu .weapon:nth-child(6)');
    expect('the shared loadout picker takes the LMG', await js(`document.querySelector('#loadout-menu .weapon:nth-child(6)').getAttribute('aria-pressed') === 'true'`));
    await shot('zom-gear');
    await js(`document.getElementById('gear-back').click()`);
    await sleep(300);
    await showSquadMenu();
    await shot('zom-menu');
  },
  async badlink() {
    await openMenu('&squad=not-a-code');
    expect('a broken invite link says so on the menu', (await status()).includes('broken'), await status());
    await openMenu('&squad=z-aaaaaa');
    expect('an invite link selects its squad', await js(`document.getElementById('squad-room')?.getAttribute('aria-pressed') === 'true'`));
    await clickEl('#play');
    expect('joining a squad that is gone says it has closed', await until(async () => (await status()).includes('has closed'), 6000), await status());
    expect('the dead code leaves the address bar', !(await js(`location.search`)).includes('squad='));
    await showSquadMenu();
    await shot('zom-badlink');
  },
  async squad() {
    await openMenu();
    expect('Zombies is picked from the dropdown and Next goes on', await pickZombies());
    await sleep(300);
    // The LMG by default; ZOM_WEAPON=1 picks the pistol (WEAPON_IDS order), for the nightbuild step.
    await clickEl(`#loadout-menu .weapon:nth-child(${process.env.ZOM_WEAPON ?? 6})`);
    await clickEl('#play');
    expect('Start a squad joins a zombies room', await until(() => frames.welcome?.mode === 'ZOM', 8000), `mode ${frames.welcome?.mode}`);
    squad = new URLSearchParams(await js(`location.search`)).get('squad') ?? '';
    expect('the address bar carries the squad code', /^z-[a-z2-7]{6}$/.test(squad), squad);
    const listed = ((await (await fetch(`${BASE}/api/servers`)).json()) as { id: string }[]).some((r) => r.id === squad);
    expect('the squad stays off the public room list', !listed);
    expect('the in-game chip names the squad', await until(async () => (await js(`document.getElementById('squad-chip').hidden ? '' : document.getElementById('squad-chip').textContent`)).includes(squad)));
    const link: string = await js(`document.getElementById('squad-link').value`);
    expect('the invite link is this page with only the squad code', link === `${BASE}/?squad=${squad}`, link);
    const friend = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws?room=${new URL(link).searchParams.get('squad')}`);
    const friendMode = await new Promise<string>((r) => {
      friend.on('open', () => friend.send(JSON.stringify({ t: 'join', name: 'Friend', loadout: { weapon: 'smg', armor: 'none', color: 'green' }, aspect: 1.6 })));
      friend.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m.t === 'welcome') r(m.mode); });
      setTimeout(() => r('none'), 4000);
    });
    expect('a friend following the invite link lands in the same squad', friendMode === 'ZOM');
    await until(() => (frames.snap?.players.length ?? 0) >= 2 && !!frames.snap?.players.some((p) => p.name === 'Friend'), 4000);
    friend.close();
    expect('the run opens on day 1', run()?.phase === 'day' && run()?.night === 1, `${run()?.phase} ${run()?.night}`);
    await sleep(800);
    await shot('zom-squad-joined');
    await cdp('Page.reload', { ignoreCache: true });
    await serversListed(page);
    expect('reopening the invite link selects the squad on the menu', await js(`document.getElementById('squad-room')?.getAttribute('aria-pressed') === 'true'`));
    await sleep(300);
    await shot('zom-menu-squad');
    frames.welcome = null;
    await js(`document.getElementById('name').value = '${NAME}'`);
    await clickEl('#play');
    expect('Play rejoins the squad from the invite link', await until(() => frames.welcome?.mode === 'ZOM' && !!me(), 8000));
  },
  async build() {
    await until(() => run()?.phase === 'day' && me()?.alive, 60_000);
    await tap('KeyB', 'b');
    expect('B turns build mode on by day', await until(async () => (await zdev())?.building === true));
    const self = me()!;
    let cell: { cx: number; cy: number } | null = null;
    for (const [dx, dy] of [[-2, 0], [-2, 1], [-2, -1], [0, 2], [0, -2], [2, 2], [-3, 0], [0, 3]]) {
      const cx = Math.floor(self.x / ZOM.cell) + dx, cy = Math.floor(self.y / ZOM.cell) + dy;
      await aimAtWorld(cellCenter(cx, cy).x, cellCenter(cx, cy).y);
      await sleep(80);
      const g = (await zdev())?.ghost;
      if (g?.cx === cx && g.cy === cy && g.refusal === null) { cell = { cx, cy }; break; }
    }
    if (!expect('the ghost turns green over a buildable cell', cell !== null)) return;
    await shot('zom-ghost-valid');
    const scrap = run()!.scrap;
    const at = await toScreen(cellCenter(cell!.cx, cell!.cy).x, cellCenter(cell!.cx, cell!.cy).y);
    await click(at!.x, at!.y);
    expect('a left click puts the wall up on the server', await until(() => hasWall(frames.snap?.buildings, cell!.cx, cell!.cy)), `cell ${cell!.cx},${cell!.cy}`);
    expect('the wall cost its scrap', await until(() => run()!.scrap === scrap - BUILDINGS.wall.cost), `${scrap} -> ${run()!.scrap}`);
    await sleep(300);
    await shot('zom-wall-built');
    const core = run()!.core;
    await aimAtWorld(core.x, core.y);
    expect('the ghost turns red with a reason over the core', await until(async () => (await zdev())?.ghost?.refusal === 'core'), (await zdev())?.ghost?.label);
    await sleep(200);
    await shot('zom-ghost-invalid');
    await aimAtWorld(self.x + 9 * ZOM.cell, self.y);
    expect('a cell out of reach is refused', await until(async () => ['outOfReach', 'farFromCore'].includes((await zdev())?.ghost?.refusal ?? '')), (await zdev())?.ghost?.label);
    const before = run()!.scrap;
    await aimAtWorld(cellCenter(cell!.cx, cell!.cy).x, cellCenter(cell!.cx, cell!.cy).y);
    expect('the ghost offers to take your wall down', await until(async () => (await zdev())?.ghost?.refusal === 'taken'));
    await click(at!.x, at!.y, 'right');
    expect('a right click takes the wall down for half its cost', await until(() => !hasWall(frames.snap?.buildings, cell!.cx, cell!.cy) && run()!.scrap === before + BUILDINGS.wall.cost / 2), `${before} -> ${run()!.scrap}`);
    await click(at!.x, at!.y);
    expect('the wall goes back up', await until(() => hasWall(frames.snap?.buildings, cell!.cx, cell!.cy)));
    await mouse('mouseMoved', VIEW.w / 2 + 200, VIEW.h / 2);
  },
  /**
   * A left drag in build mode lays a line of walls: the ghost shows every cell of it, straight along the axis the drag went farther, with its price,
   * red where it cannot go up; letting go builds the line in one message, and Esc or a right click mid-drag drops it.
   */
  async drag() {
    await until(() => run()?.phase === 'day' && me()?.alive, 60_000);
    if ((await zdev())?.building !== true) await tap('KeyB', 'b');
    expect('B turns build mode on by day', await until(async () => (await zdev())?.building === true));
    // 1 picks the wall, and again steps its tier: barricades, the cheapest, so more of the line is paid for.
    for (let i = 0; i < 4; i++) {
      const d = await zdev();
      if (d?.buildKind === 'wall' && d.buildTier === 1) break;
      await tap('Digit1', '1');
      await sleep(150);
    }
    expect('barricades are picked', (await zdev())?.buildKind === 'wall' && (await zdev())?.buildTier === 1);
    const self = me()!;
    const cx = Math.floor(self.x / ZOM.cell) - 3, cy0 = Math.floor(self.y / ZOM.cell) - 3, cy1 = cy0 + 8;
    const from = await toScreen(cellCenter(cx, cy0).x, cellCenter(cx, cy0).y), to = await toScreen(cellCenter(cx, cy1).x + 35, cellCenter(cx, cy1).y);
    if (!expect('the drag ends are on screen', !!from && !!to)) return;
    // Esc mid-drag drops the line and builds nothing.
    const walls0 = frames.snap?.buildings?.length ?? 0;
    await mouse('mouseMoved', from!.x, from!.y);
    await sleep(80);
    await mouse('mousePressed', from!.x, from!.y, 'left');
    for (let i = 1; i <= 6; i++) { await mouse('mouseMoved', from!.x + ((to!.x - from!.x) * i) / 6, from!.y + ((to!.y - from!.y) * i) / 6); await sleep(40); }
    expect('dragging shows a line ghost', await until(async () => ((await zdev())?.ghost as { line?: unknown[] } | null)?.line?.length === 9), JSON.stringify((await zdev())?.ghost));
    await tap('Escape', 'Escape');
    await mouse('mouseReleased', to!.x, to!.y, 'left');
    await sleep(400);
    expect('Esc drops the line and nothing goes up', (frames.snap?.buildings?.length ?? 0) === walls0 && (await zdev())?.building === true);
    // The real drag: down the column, drifting sideways, so the line locks to the column.
    const scrap = run()!.scrap;
    await mouse('mouseMoved', from!.x, from!.y);
    await sleep(80);
    await mouse('mousePressed', from!.x, from!.y, 'left');
    for (let i = 1; i <= 8; i++) { await mouse('mouseMoved', from!.x + ((to!.x - from!.x) * i) / 8, from!.y + ((to!.y - from!.y) * i) / 8); await sleep(50); }
    await sleep(250);
    const g = (await zdev())?.ghost as (ZombiesDev['ghost'] & { line?: { cx: number; cy: number; refusal: string | null }[] }) | null;
    const line = g?.line ?? [];
    expect('the line ghost runs straight down the column from where the drag began', line.length === 9 && line.every((c, i) => c.cx === cx && c.cy === cy0 + i), JSON.stringify(line));
    const ok = line.filter((c) => c.refusal === null);
    expect('the line shows cells that go up and cells it passes over', ok.length > 0 && ok.length < line.length, line.map((c) => c.refusal ?? 'ok').join(','));
    log(`ghost plate: ${g?.label} / ${g?.detail}`);
    await shot('zom-drag-ghost');
    await mouse('mouseReleased', to!.x, to!.y, 'left');
    expect('letting go builds every green cell of the line', await until(() => ok.every((c) => hasWall(frames.snap?.buildings, c.cx, c.cy)), 3000), `${ok.length} cells`);
    expect('and none of the red ones', line.filter((c) => c.refusal !== null && c.refusal !== 'taken').every((c) => !hasWall(frames.snap?.buildings, c.cx, c.cy)));
    expect('the line cost a wall\'s price for each wall', await until(() => run()!.scrap === scrap - ok.length * costOf('wall', g!.lv)), `${scrap} -> ${run()!.scrap}`);
    await mouse('mouseMoved', VIEW.w / 2 + 200, VIEW.h / 2);
    await sleep(400);
    await shot('zom-drag-built');
    // A press let go where it began is still a single build.
    const one = await buildableCell();
    if (one) {
      const at = await toScreen(cellCenter(one.cx, one.cy).x, cellCenter(one.cx, one.cy).y);
      const before = run()!.scrap;
      await click(at!.x, at!.y);
      expect('a click still builds one wall', await until(() => hasWall(frames.snap?.buildings, one.cx, one.cy) && run()!.scrap === before - BUILDINGS.wall.cost), `${before} -> ${run()!.scrap}`);
    }
  },
  /** Tiers, upgrades and every kind: needs a scratch copy with about 3000 starting scrap and a long day (see features/zombies.md). */
  async variety() {
    await until(() => run()?.phase === 'day' && me()?.alive, 60_000);
    if ((await zdev())?.building !== true) await tap('KeyB', 'b');
    expect('B turns build mode on by day', await until(async () => (await zdev())?.building === true));
    if (!expect('there is scrap to spend on the variety', run()!.scrap >= 1500, `${run()!.scrap} scrap`)) return;
    const wheel = (deltaY: number) => cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: VIEW.w / 2, y: VIEW.h / 2, deltaX: 0, deltaY });
    const tier = async () => (await zdev())?.buildTier;
    // Keys: 1 picks the wall, 1 again and Q step its tier, the wheel steps through everything.
    await tap('Digit1', '1');
    await until(async () => (await zdev())?.buildKind === 'wall');
    const first = await tier();
    await tap('Digit1', '1');
    expect('1 again steps the wall to its next tier', await until(async () => (await tier()) === (first! % 3) + 1), `tier ${first} -> ${await tier()}`);
    const before = await tier();
    await tap('KeyQ', 'q');
    expect('Q steps the wall tier', await until(async () => (await tier()) === (before! % 3) + 1), `tier ${before} -> ${await tier()}`);
    while ((await tier()) !== 1) { await tap('KeyQ', 'q'); await sleep(60); }
    await wheel(100);
    expect('the wheel steps to the next tier', await until(async () => (await tier()) === 2));
    await wheel(-100);
    expect('and back', await until(async () => (await tier()) === 1));
    await tap('Digit6', '6');
    expect('6 picks the tesla coil, 7 the depot, 8 the post, 9 the spikes', await until(async () => (await zdev())?.buildKind === 'tesla'));
    for (const [code, kind] of [['Digit7', 'depot'], ['Digit8', 'post'], ['Digit9', 'spikes']] as const) {
      await tap(code, code.slice(5));
      expect(`${code.slice(5)} picks the ${kind}`, await until(async () => (await zdev())?.buildKind === kind));
    }
    const rows = (await zdev())?.chips ?? [];
    expect('the build bar has a chip for each wall tier, five turrets, three utilities and the upgrade', rows.length === 3 + 5 + 3 + 1, `${rows.length} chips`);
    // Build one of each, in rows north and south of the player, each at the next free cell.
    const self = me()!, base = { cx: Math.floor(self.x / ZOM.cell), cy: Math.floor(self.y / ZOM.cell) };
    const spots = [-3, 3, -2, 2].flatMap((dy) => [-4, -3, -2, -1, 1, 2, 3, 4, 5].map((dx) => ({ cx: base.cx + dx, cy: base.cy + dy })));
    const placed = gallery;
    const place = async (label: string, pick: () => Promise<void>, kind: BuildingKind, lv = 1) => {
      await pick();
      for (const spot of spots) {
        if ([...placed.values()].some((c) => c.cx === spot.cx && c.cy === spot.cy)) continue;
        await aimAtWorld(cellCenter(spot.cx, spot.cy).x, cellCenter(spot.cx, spot.cy).y);
        await sleep(70);
        const g = (await zdev())?.ghost;
        if (g?.cx !== spot.cx || g.cy !== spot.cy || g.refusal !== null) continue;
        const scrap = run()!.scrap;
        const at = await toScreen(cellCenter(spot.cx, spot.cy).x, cellCenter(spot.cx, spot.cy).y);
        await click(at!.x, at!.y);
        const up = await until(() => frames.snap?.buildings?.some((b) => b.cx === spot.cx && b.cy === spot.cy && b.kind === kind && (b.lv ?? 1) === lv));
        if (!expect(`a left click puts up the ${label}`, up, `cell ${spot.cx},${spot.cy}`)) return null;
        expect(`the ${label} cost ${costOf(kind, lv)}`, await until(() => Math.abs(scrap - run()!.scrap - costOf(kind, lv)) < 5), `${scrap} -> ${run()!.scrap}`);
        placed.set(label, spot);
        return spot;
      }
      expect(`a free cell for the ${label}`, false);
      return null;
    };
    const pickTier = (lv: number) => async () => { await tap('Digit1', '1'); while ((await tier()) !== lv) { await tap('KeyQ', 'q'); await sleep(60); } };
    for (const lv of [1, 2, 3]) {
      const spot = await place(`${WALL_TIERS[lv - 1]!.name}`, pickTier(lv), 'wall', lv);
      if (spot) { await mouse('mouseMoved', VIEW.w / 2 + 200, 40); await closeUp(`zom-tier-${lv}-${WALL_TIERS[lv - 1]!.name.toLowerCase().replace(/ /g, '-')}`, cellCenter(spot.cx, spot.cy).x, cellCenter(spot.cx, spot.cy).y); }
    }
    const kinds: [string, string, BuildingKind][] = [['Digit2', 'sentry', 'sentry'], ['Digit3', 'cannon', 'cannon'], ['Digit4', 'scatter', 'scatter'], ['Digit5', 'mortar', 'mortar'], ['Digit6', 'tesla coil', 'tesla'], ['Digit7', 'ammo depot', 'depot'], ['Digit8', 'repair post', 'post'], ['Digit9', 'spike strip', 'spikes']];
    for (const [code, label, kind] of kinds) await place(label, () => tap(code, code.slice(5)), kind);
    await mouse('mouseMoved', VIEW.w / 2 + 200, 40);
    await sleep(400);
    await shot('zom-variety-gallery');
    // Hovering a building shows its level, health and upgrade cost; U or the upgrade chip or a click steps it up.
    const stepUp = async (label: string, how: 'U' | 'chip' | 'click', toLv: number) => {
      const spot = placed.get(label);
      if (!spot) return;
      const at = await aimAtWorld(cellCenter(spot.cx, spot.cy).x, cellCenter(spot.cx, spot.cy).y);
      await sleep(120);
      const hover = (await zdev())?.ghost?.hover;
      expect(`hovering the ${label} names its level and the next step`, !!hover && hover.lv === toLv - 1 && hover.next !== null, JSON.stringify(hover));
      const scrap = run()!.scrap;
      if (how === 'U') await tap('KeyU', 'u');
      else if (how === 'chip') { const chip = (await zdev())?.chips.find((c) => c.pick.upgrade); if (chip) await click(chip.x + chip.w / 2, chip.y + chip.h / 2); await aimAtWorld(cellCenter(spot.cx, spot.cy).x, cellCenter(spot.cx, spot.cy).y); }
      else await click(at!.x, at!.y);
      const got = await until(() => frames.snap?.buildings?.some((b) => b.cx === spot.cx && b.cy === spot.cy && (b.lv ?? 1) === toLv));
      expect(`${how === 'U' ? 'U' : how === 'chip' ? 'the upgrade chip' : 'a left click'} upgrades the ${label} to level ${toLv}`, got, `${scrap} -> ${run()!.scrap}`);
    };
    const sentry = placed.get('sentry'), barricade = placed.get('Barricade');
    if (barricade) {
      await aimAtWorld(cellCenter(barricade.cx, barricade.cy).x, cellCenter(barricade.cx, barricade.cy).y);
      await sleep(150);
      await shot('zom-hover-wall');
    }
    await stepUp('Barricade', 'U', 2);
    await stepUp('Barricade', 'chip', 3);
    if (sentry) {
      await closeUp('zom-sentry-lv1', cellCenter(sentry.cx, sentry.cy).x, cellCenter(sentry.cx, sentry.cy).y);
      await stepUp('sentry', 'click', 2);
      await closeUp('zom-sentry-lv2', cellCenter(sentry.cx, sentry.cy).x, cellCenter(sentry.cx, sentry.cy).y);
      await stepUp('sentry', 'U', 3);
      await mouse('mouseMoved', VIEW.w / 2 + 200, 40);
      await sleep(300);
      await closeUp('zom-sentry-lv3', cellCenter(sentry.cx, sentry.cy).x, cellCenter(sentry.cx, sentry.cy).y);
    }
    for (const label of ['cannon', 'scatter', 'mortar', 'tesla coil', 'ammo depot', 'repair post']) { await stepUp(label, 'U', 2); await stepUp(label, 'U', 3); }
    await mouse('mouseMoved', VIEW.w / 2 + 200, 40);
    await sleep(400);
    await shot('zom-variety-upgraded');
    for (const [label, spot] of placed) if (label !== 'sentry') await closeUp(`zom-variety-${label.replace(/ /g, '-').toLowerCase()}`, cellCenter(spot.cx, spot.cy).x, cellCenter(spot.cx, spot.cy).y);
    const hp = (label: string) => { const spot = placed.get(label); return spot ? frames.snap?.buildings?.find((b) => b.cx === spot.cx && b.cy === spot.cy) : undefined; };
    expect('the tiers and levels reached the snapshot', hp('Barricade')?.lv === 3 && hp('Steel wall')?.lv === 3 && hp('Sandbag wall')?.lv === 2, JSON.stringify([hp('Barricade'), hp('Sandbag wall'), hp('Steel wall')]));
    for (const [label, spot] of placed) { const b = hp(label); if (b && 'ammo' in b) turrets.push({ kind: b.kind, ...spot }); }
  },
  async turrets() {
    if ((await zdev())?.building !== true) await tap('KeyB', 'b');
    await tap('Digit2', '2');
    expect('2 picks the sentry in build mode', await until(async () => (await zdev())?.buildKind === 'sentry'));
    for (const kind of ['sentry', 'cannon'] as const) {
      if (kind === 'cannon') {
        const chip = (await zdev())?.chips.find((c) => c.pick.kind === 'cannon');
        if (chip) await click(chip.x + chip.w / 2, chip.y + chip.h / 2);
        expect('a click on the hint bar\'s cannon chip picks the cannon', await until(async () => (await zdev())?.buildKind === 'cannon'));
      }
      const cost = BUILDINGS[kind].cost;
      if (run()!.scrap < cost) {
        await aimAtWorld(me()!.x - 2 * ZOM.cell, me()!.y + 3 * ZOM.cell);
        const ghost = await until(async () => (await zdev())?.ghost?.label === `${BUILDINGS[kind].name} needs ${cost} scrap`);
        expect(`the ghost says a ${kind} needs ${cost} scrap when the bank is short`, ghost, `${run()!.scrap} scrap, ${(await zdev())?.ghost?.label}`);
        await shot(`zom-ghost-${kind}-short`);
        continue;
      }
      const cell = await buildableCell();
      if (!expect(`the ghost shows a ${kind} over a buildable cell`, cell !== null && (await zdev())?.ghost?.label === `${BUILDINGS[kind].name} · ${cost} scrap`, (await zdev())?.ghost?.label)) continue;
      await sleep(150);
      await shot(`zom-ghost-${kind}`);
      const scrap = run()!.scrap;
      const at = await toScreen(cellCenter(cell!.cx, cell!.cy).x, cellCenter(cell!.cx, cell!.cy).y);
      await click(at!.x, at!.y);
      expect(`a left click puts the ${kind} up on the server, fully loaded`, await until(() => { const t = turretAt(cell!); return t?.kind === kind && t.ammo === 10; }), `cell ${cell!.cx},${cell!.cy}`);
      expect(`the ${kind} cost its scrap`, await until(() => run()!.scrap === scrap - cost), `${scrap} -> ${run()!.scrap}`);
      turrets.push({ kind, ...cell! });
    }
    await sleep(300);
    await mouse('mouseMoved', VIEW.w / 2 + 200, VIEW.h / 2);
    await shot('zom-turrets-built');
    if (turrets[0]) await closeUp('zom-turrets-built-closeup', cellCenter(turrets[0].cx, turrets[0].cy).x, cellCenter(turrets[0].cx, turrets[0].cy).y);
  },
  async night() {
    const nightAt = Date.now();
    const callout = (title: string) => async () => (await zdev())?.callouts.some((c) => c.startsWith(title)) ?? false;
    if (run()?.phase === 'day') {
      expect('a warning callout comes ten seconds before night', await until(callout('Night falls in'), 45_000));
      const said = (await zdev())?.callouts.find((c) => c.startsWith('Night falls in')) ?? '';
      expect('the warning forecasts tonight from the night table', said.endsWith(forecast(run()!.night, squadShare(frames.snap!.players))), said);
      await shot('zom-dusk-warning');
    }
    const tonight = nightOf(run()!.night);
    const seen = new Map<number, { x: number; y: number }>();
    const watchSides = setInterval(() => { for (const [id, , x, y] of frames.snap?.zombies ?? []) if (!seen.has(id)) seen.set(id, { x, y }); }, 100);
    expect('night falls', await until(() => run()?.phase === 'night', 15_000));
    const fellAt = Date.now();
    expect('night turns build mode off', await until(async () => (await zdev())?.building === false));
    expect('a Night callout announces the wave', await until(callout('Night 1'), 3000));
    await sleep(300);
    await shot('zom-night-callout');
    let crowd = false, alerted = false, firing = false, reload: 'waiting' | 'done' = 'waiting', beaten = 0, arcs = 0, coilsSeen = 0, lit = false;
    const shotsAtNight = { ...frames.turretShots };
    const coilsAtNight = frames.coils;
    await fight(() => run()?.phase === 'day' && run()!.night === 2, 150_000, async () => {
      if (!crowd && (frames.snap?.zombies?.length ?? 0) >= 4 && me()?.alive) { crowd = true; await shot('zom-night'); }
      if (!alerted && (await zdev())?.coreAlert) { alerted = true; await shot('zom-core-alert'); }
      // A coil's arc lasts a fifth of a second, so each new one is shot as it is seen, up to three.
      if (frames.coils > coilsSeen && arcs < 3) { coilsSeen = frames.coils; arcs++; await shot(`zom-tesla-arc-${arcs}`); }
      // Dusk takes a few seconds to turn to night, so the gallery is looked at once it has.
      if (!lit && gallery.size && Date.now() - fellAt > 12_000 && (frames.snap?.zombies?.length ?? 0) >= 1) {
        lit = true;
        for (const [label, spot] of gallery) await closeUp(`zom-night-${label.replace(/ /g, '-').toLowerCase()}`, cellCenter(spot.cx, spot.cy).x, cellCenter(spot.cx, spot.cy).y);
      }
      if (!firing && turrets.length && frames.turretKills > 0 && (frames.snap?.zombies?.length ?? 0) >= 2) {
        firing = true;
        await shot('zom-turrets-firing');
        await closeUp('zom-turrets-firing-closeup', cellCenter(turrets[0]!.cx, turrets[0]!.cy).x, cellCenter(turrets[0]!.cx, turrets[0]!.cy).y);
      }
      const low = turrets.find((t) => (turretAt(t)?.ammo ?? 10) < 10);
      if (reload === 'waiting' && low && me()?.alive && run()!.scrap > 0) {
        const name = BUILDINGS[low.kind].name.toLowerCase();
        await mouse('mouseReleased', VIEW.w / 2, VIEW.h / 2, 'left');
        await walkTo(cellCenter(low.cx, low.cy).x, cellCenter(low.cx, low.cy).y + ZOM.cell, 50);
        // A squad bot reloads a turret far faster than it fires, so it often gets there first; wait for the next drop.
        const offered = await until(async () => (turretAt(low)?.ammo ?? 10) === 10 || (await zdev())?.use === `Hold E to reload the ${name}`, 2000);
        const from = turretAt(low)?.ammo ?? 10;
        if (from === 10) { beaten++; return; }
        reload = 'done';
        expect(`by the low ${name} the hint offers to reload it`, offered, String((await zdev())?.use));
        await shot('zom-reload-hint');
        const scrap = run()!.scrap, earned = frames.scrapEarned;
        await key(page, 'keyDown', 'KeyE', 'e');
        const full = await until(() => { const t = turretAt(low); return t?.kind === low.kind && t.ammo === 10; }, ZOM.refillMs + 3000);
        await key(page, 'keyUp', 'KeyE', 'e');
        // Kills meanwhile pay into the bank, so the spend is what the bank lacks beyond them; a few rounds cost under the whole scrap the snapshot shows.
        const spent = scrap + frames.scrapEarned - earned - run()!.scrap;
        expect(`holding E reloads the ${name}`, full, `ammo ${from} -> 10/10, about ${spent} scrap spent`);
      }
    });
    for (const t of turrets) {
      // A coil sends arcs, not rounds: each `coil` event is one zap.
      const fired = t.kind === 'tesla' ? frames.coils - coilsAtNight : frames.turretShots[t.kind] - shotsAtNight[t.kind];
      expect(`the ${t.kind} fired at the horde`, fired > 0, `${fired} ${t.kind === 'tesla' ? 'arcs' : 'rounds'}`);
      // Squad bots reload a turret faster than it fires while the horde is far from them, so its bar may never move.
      log(`note the ${t.kind}'s ammo bar went as low as ${frames.lowestAmmo[t.kind]}/10`);
    }
    if (turrets.length && reload === 'waiting') log(`note no turret stayed low long enough to reload by hand (bots got there first ${beaten} times)`);
    // The squad often shoots the small first wave down before it comes in turret range, so stock night 1 may leave a turret without a kill.
    if (turrets.length) log(`note turrets killed ${frames.turretKills} zombies for the squad`);
    clearInterval(watchSides);
    // A zombie first comes into view on the side of the core it walks in from; the view spans 900px or so, so only clear sides count.
    const sideOf = ({ x, y }: { x: number; y: number }) => {
      const dx = x - 1500, dy = y - 1500;
      return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'east' : 'west') : dy > 0 ? 'south' : 'north';
    };
    const sides = new Set([...seen.values()].filter((p) => Math.hypot(p.x - 1500, p.y - 1500) > 350).map(sideOf));
    expect('the night\'s zombies walk in only from the sides it forecast', [...sides].every((s) => tonight.from.includes(s)), `seen from ${[...sides].join(', ')}, forecast ${tonight.from.join(', ')}`);
    expect('the squad saw zombies in view', crowd);
    expect('the driven player shot zombies through real input', (frames.snap?.self.kills ?? 0) > 0, `${frames.snap?.self.kills} kills`);
    log(`note core alert ${alerted ? 'seen' : 'not seen'} on night 1`);
    expect('dawn of night 2 arrives', run()?.phase === 'day' && run()?.night === 2, `${Math.round((Date.now() - nightAt) / 1000)}s`);
    expect('a Dawn callout sums up the night', await until(callout('Dawn'), 3000));
    const dawnSaid = (await zdev())?.callouts.find((c) => c.startsWith('Dawn')) ?? '';
    expect('the Dawn callout counts the survivors and their scrap', / survivors · \+\d+ scrap$/.test(dawnSaid), dawnSaid);
    expect('dawn forecasts the coming night', await until(async () => (await zdev())?.callouts.some((c) => c === `Tonight · ${forecast(2, squadShare(frames.snap!.players))}`) ?? false, 6000));
    await sleep(300);
    await shot('zom-dawn');
  },
  /**
   * Needs ZOM_WEAPON=1 on the squad step: a pistol holder keeps build mode through nightfall and builds, upgrades and takes down by night
   * (`ZombieRole.nightBuild`). Brings the night with N rather than waiting out the day.
   */
  async nightbuild() {
    expect('the driven player holds a pistol', me()?.gun === 'pistol', me()?.gun);
    await until(() => run()?.phase === 'day' && me()?.alive, 60_000);
    if (run()?.phase === 'day') await tap('KeyN', 'n');
    expect('night falls', await until(() => run()?.phase === 'night', 60_000));
    await until(() => me()?.alive, 10_000);
    await mouse('mouseMoved', VIEW.w / 2 + 200, VIEW.h / 2);
    await sleep(800);
    await shot('zom-nightbuild-hint');
    if ((await zdev())?.building !== true) await tap('KeyB', 'b');
    expect('B turns build mode on by night with a pistol', await until(async () => (await zdev())?.building === true));
    const cell = await buildableCell();
    if (!expect('the ghost turns green over a buildable cell by night', cell !== null, (await zdev())?.ghost?.label)) return;
    await shot('zom-nightbuild-ghost');
    const scrap = run()!.scrap, earned = frames.scrapEarned;
    const at = await toScreen(cellCenter(cell!.cx, cell!.cy).x, cellCenter(cell!.cx, cell!.cy).y);
    await click(at!.x, at!.y);
    expect('a left click puts the wall up on the server by night', await until(() => hasWall(frames.snap?.buildings, cell!.cx, cell!.cy)), `cell ${cell!.cx},${cell!.cy} phase ${run()?.phase}`);
    await sleep(200);
    // Kills meanwhile pay into the bank, so the spend is counted net of them.
    const spent = scrap + frames.scrapEarned - earned - run()!.scrap;
    expect('the night wall cost its usual scrap', spent === BUILDINGS.wall.cost, `${spent} spent, ${scrap} -> ${run()!.scrap}`);
    await sleep(300);
    await shot('zom-nightbuild-wall');
    const lv = () => frames.snap?.buildings?.find((b) => b.cx === cell!.cx && b.cy === cell!.cy)?.lv ?? 1;
    const lv0 = lv();
    await aimAtWorld(cellCenter(cell!.cx, cell!.cy).x, cellCenter(cell!.cx, cell!.cy).y);
    await until(async () => (await zdev())?.ghost?.refusal === 'taken');
    await tap('KeyU', 'u');
    expect('U upgrades the wall by night', await until(() => lv() > lv0), `level ${lv0} -> ${lv()}`);
    await sleep(300);
    await shot('zom-nightbuild-upgraded');
    // Standing still by night, the driver may be bitten down meanwhile, and a downed player builds nothing: wait to be back up.
    if (!me()?.alive) { log('note the driver went down; waiting to be back up before taking the wall down'); await until(() => me()?.alive && run()?.phase === 'night', 45_000); }
    const back = await toScreen(cellCenter(cell!.cx, cell!.cy).x, cellCenter(cell!.cx, cell!.cy).y);
    if ((await zdev())?.building !== true) await tap('KeyB', 'b');
    await mouse('mouseMoved', back!.x, back!.y);
    await until(async () => (await zdev())?.ghost?.refusal === 'taken');
    await click(back!.x, back!.y, 'right');
    expect('a right click takes the wall down by night', await until(() => !hasWall(frames.snap?.buildings, cell!.cx, cell!.cy)), `phase ${run()?.phase}`);
    expect('still night throughout', run()?.phase === 'night');
  },
  async ready() {
    expect('by day before readying up', await until(() => run()?.phase === 'day' && me()?.alive, 60_000));
    const left = run()!.phaseEndsAt! - (frames.snap?.tick ?? 0) * (1000 / 30);
    await tap('KeyN', 'n');
    expect('N brings the night early when the only human is ready', await until(() => run()?.phase === 'night', 3000), `${Math.round(left / 1000)}s of day were left`);
  },
  async horde() {
    const kinds = new Set<string>();
    let pictured = 0;
    await fight(() => run()?.phase === 'day' && run()!.night > 1, 150_000, async () => {
      const inView = frames.snap?.zombies ?? [];
      for (const [, k] of inView) kinds.add(ZOMBIE_KINDS[k]!);
      // Keep the frame with the most kinds in view, then the most zombies.
      const variety = new Set(inView.map(([, k]) => k)).size * 100 + inView.length;
      if (variety > pictured && inView.length >= 6) {
        pictured = variety;
        await shot('zom-new-horde');
        const kindsNear = ([, , x, y]: (typeof inView)[number]) => new Set(inView.filter((o) => Math.abs(o[2] - x) < 120 && Math.abs(o[3] - y) < 80).map((o) => o[1])).size;
        const busiest = inView.reduce((a, b) => (kindsNear(b) > kindsNear(a) ? b : a));
        await closeUp('zom-new-horde-closeup', busiest[2], busiest[3]);
      }
    });
    log(`note zombie kinds seen: ${[...kinds].join(', ')}`);
    for (const t of ['scatter', 'mortar'] as const) if (frames.turretShots[t] > 0) log(`note the ${t} fired ${frames.turretShots[t]} times`);
  },
  async victory() {
    await fight(() => run()?.phase === 'over', 300_000, async () => {});
    expect('the run ends won after the Tide', run()?.report?.won === true, `night ${run()?.report?.night}, ${run()?.report?.survivors} survivors`);
    const title = await js(`document.getElementById('report').hidden ? '' : document.querySelector('#report h2, #report h1')?.textContent ?? ''`);
    expect('the report says the Bastion held and how many saw the morning', /^The Bastion held\. \d+ survivors saw the morning\.$/.test(String(title)), String(title));
    await sleep(400);
    await shot('zom-victory');
  },
  async downed() {
    const end = Date.now() + 200_000;
    while (Date.now() < end && !me()?.downed && run()?.phase !== 'over') {
      const self = me();
      const z = self && (frames.snap?.zombies ?? []).sort((a, b) => Math.hypot(a[2] - self.x, a[3] - self.y) - Math.hypot(b[2] - self.x, b[3] - self.y))[0];
      if (self?.alive && z) {
        const dirs = ([z[2] > self.x + 20 ? 'right' : z[2] < self.x - 20 ? 'left' : null, z[3] > self.y + 20 ? 'down' : z[3] < self.y - 20 ? 'up' : null] as const).filter((d): d is Dir => d !== null);
        await hold(page, dirs, 150);
      } else await sleep(150);
    }
    if (!expect('the driven player goes down to a bite', !!me()?.downed)) return;
    await sleep(500);
    await shot('zom-downed');
    expect('a downed player stays in play, not on the death screen', await js(`document.getElementById('death').hidden`));
    const bled = await until(() => me() && !me()!.alive && !me()!.downed, ZOM.bleedOutMs + 5000);
    if (!bled) { log('note revived before bleeding out'); return; }
    expect('bleeding out opens the death screen', await until(async () => !(await js(`document.getElementById('death').hidden`))));
    expect('it says back at dawn instead of offering a respawn', await until(async () => (await js(`document.getElementById('death-sub').textContent`)).startsWith('Back at dawn') && await js(`document.getElementById('respawn').hidden`)));
    await sleep(300);
    await shot('zom-bled-out');
  },
  async report() {
    let alerted = false;
    await fight(() => run()?.phase === 'over', 300_000, async () => {
      if (!alerted && (await zdev())?.coreAlert) { alerted = true; await sleep(200); await shot('zom-core-alert'); }
    });
    expect('the core falls', run()?.phase === 'over');
    expect('the report shows the night reached and a row per player', await until(async () => (await js(`document.getElementById('report').hidden ? 0 : document.querySelectorAll('#report tr').length`)) >= 5, 3000));
    expect('the report counts down to the next run', (await js(`document.getElementById('report').textContent`)).includes('Next run in'));
    await sleep(400);
    await shot('zom-report');
  },
};

for (const s of steps) {
  if (!STEPS[s]) { expect(`known step "${s}"`, false); continue; }
  try { await STEPS[s](); } catch (e) { expect(`step ${s} ran without throwing`, false, String(e)); }
}
for (const p of problems.filter((p) => p.startsWith('page') || p.startsWith('console'))) log(p);
log(problems.length ? `RESULT FAIL (${problems.length})` : 'RESULT PASS');
page.close();
process.exit(problems.length ? 1 : 0);
