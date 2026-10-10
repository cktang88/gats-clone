/// <reference types="node" />
// Usage: node royale-ui.ts <run-dir>
// Joins the br room (Last Standing, solo) in muted headless Chrome through the menu, then walks out of the ring and stays there: the storm, the
// ring's kill, spectating and the result card each get a screenshot. Run it on a scratch copy with a fast, hard ring and redeploys closed
// from the start (`ROYALE.redeployPhases` 0; see features/last-squad.md).
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ringAt, type Snapshot } from '../../../../src/shared/protocol.ts';
import { fillSnapshot } from '../../../../src/shared/wire.ts';
import { dirKey, joinFromMenu, openPage, sleep, type Dir } from './lib/browser.ts';

const RUN = process.argv[2];
if (!RUN) { console.error('usage: node royale-ui.ts <run-dir>'); process.exit(2); }
const BASE = `http://localhost:${readFileSync(join(RUN, 'port'), 'utf8').trim()}`;
const EV = join(RUN, 'evidence');
const LOG = join(EV, 'royale-ui.log');
mkdirSync(EV, { recursive: true });
const log = (line: string) => { console.log(line); appendFileSync(LOG, line + '\n'); };
const problems: string[] = [];
const expect = (label: string, ok: boolean, detail = '') => { log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  (${detail})` : ''}`); if (!ok) problems.push(label); return ok; };

const frames = { welcome: null as null | { id: number; mode: string }, snap: null as Snapshot | null, ringHits: 0, feed: [] as string[] };
const page = await openPage({
  profile: 'skirmish-royale-',
  viewport: { width: 1280, height: 800 },
  onEvent: (method, params) => {
    if (method !== 'Network.webSocketFrameReceived') return;
    const msg = JSON.parse(params.response.payloadData);
    if (msg.t === 'welcome') { frames.welcome = msg; frames.snap = null; }
    if (msg.t !== 'snap') return;
    frames.snap = fillSnapshot(msg, frames.snap) ?? frames.snap;
    for (const e of frames.snap?.events ?? []) {
      if (e.e === 'dmg' && e.kind === 'player' && e.victim === frames.welcome?.id && e.attacker === null) frames.ringHits++;
      if (e.e === 'wiped') frames.feed.push('wiped');
    }
  },
  onProblem: (kind, detail) => problems.push(`${kind}: ${detail}`),
});
const { cdp, js } = page;
const shot = async (name: string) => {
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(EV, `${name}.png`), Buffer.from(data, 'base64'));
  log(`shot ${name}.png`);
};
const until = async (fn: () => unknown, ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(100); } return false; };
const me = () => frames.snap?.players.find((p) => p.id === frames.welcome?.id);
const now = () => (frames.snap?.tick ?? 0) * (1000 / 30);

let held: Dir[] = [];
const steer = async (dirs: Dir[]) => {
  for (const d of held) if (!dirs.includes(d)) await dirKey(page, 'keyUp', d);
  for (const d of dirs) if (!held.includes(d)) await dirKey(page, 'keyDown', d);
  held = dirs;
};
const fleeRing = async () => {
  const p = me(), royale = frames.snap?.royale;
  if (!p?.alive || !royale) { await steer([]); return; }
  const c = royale.ring.to;
  const dx = p.x - c.x, dy = p.y - c.y;
  await steer([...(Math.abs(dx) > 40 ? [dx > 0 ? 'right' as const : 'left' as const] : []), ...(Math.abs(dy) > 40 ? [dy > 0 ? 'down' as const : 'up' as const] : [])]);
};

await cdp('Page.navigate', { url: `${BASE}/?dev` });
await sleep(800);
await joinFromMenu(page, { room: 3, name: 'Ringer', press: true });
expect('the menu joins the Last Standing room', await until(() => frames.welcome?.mode === 'BR' && me(), 8000), `mode ${frames.welcome?.mode}`);
expect('the player plays solo, on no team', me()?.team === null, `team ${me()?.team}`);
expect('the match counts everyone still in', (frames.snap?.royale?.alive ?? 0) > 1 && frames.snap?.royale?.alive === frames.snap?.royale?.total, `${frames.snap?.royale?.alive} / ${frames.snap?.royale?.total}`);
expect('loot caches and towers are on the map', (frames.snap?.royale?.caches.length ?? 0) > 20 && (frames.snap?.royale?.towers.length ?? 0) > 0);
await sleep(1500);
await shot('br-start');

const outside = () => {
  const p = me(), royale = frames.snap?.royale;
  if (!p || !royale) return false;
  const c = ringAt(royale.ring, now());
  return Math.hypot(p.x - c.x, p.y - c.y) > c.r;
};
const edgeInView = () => {
  const p = me(), royale = frames.snap?.royale;
  if (!p || !royale) return false;
  const c = ringAt(royale.ring, now());
  return Math.abs(Math.hypot(p.x - c.x, p.y - c.y) - c.r) < 350;
};
expect('the ring catches the player outside it', await until(async () => { await fleeRing(); return outside() && edgeInView(); }, 90_000));
await shot('br-ring');
expect('the ring hurts the player outside it', await until(async () => { await fleeRing(); return frames.ringHits >= 2; }, 10_000), `${frames.ringHits} ring hits`);

await steer([]);
expect('the ring kills the player', await until(async () => { await fleeRing(); return !!me() && !me()!.alive; }, 90_000));
expect('a dead player watches someone', await until(() => frames.snap?.royale?.watch !== null, 5000), `watch ${frames.snap?.royale?.watch}`);
await sleep(600);
const watched = frames.snap?.players.find((p) => p.id === frames.snap?.royale?.watch);
const at = watched && await js(`skirmishDev.toScreen(${watched.x}, ${watched.y})`) as { x: number; y: number } | null;
expect('the camera follows the watched player', !!at && Math.abs(at.x - 640) < 120 && Math.abs(at.y - 400) < 120, at ? `${Math.round(at.x)},${Math.round(at.y)}` : 'none');
expect('the death screen stays closed while spectating', await js(`document.getElementById('death').hidden`));
await sleep(500);
await shot('br-spectate');

expect('the result card shows the place', await until(async () => !(await js(`document.getElementById('report').hidden`)), 240_000));
const result = await js(`document.getElementById('report').textContent`) as string;
expect('it reads as a place with kills', /#\d/.test(result) && /kills/i.test(result), result);
await sleep(400);
await shot('br-result');
expect('the feed carried players going out', frames.feed.includes('wiped'), frames.feed.slice(0, 8).join(','));

for (const p of problems.filter((p) => p.startsWith('page') || p.startsWith('console'))) log(p);
log(problems.length ? `RESULT FAIL (${problems.length})` : 'RESULT PASS');
page.close();
process.exit(problems.length ? 1 : 0);
