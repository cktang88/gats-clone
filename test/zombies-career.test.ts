import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAREER, CAREER_IDS, CAREER_PAY, ZOM, ZOM_CAREER_IDS, ZOM_STATS, type Badge } from '../src/shared/defs.ts';
import type { Loadout, ServerMsg } from '../src/shared/protocol.ts';
import { applyDelta, freshProfile, openProfiles, profileView, trackCount } from '../src/server/profiles.ts';
import { createRoom } from '../src/server/room.ts';
import { LIMITS } from '../src/server/limits.ts';
import { setInput } from '../src/shared/sim.ts';
import { damageZombie } from '../src/shared/sim/run.ts';
import { hurtCore } from '../src/shared/sim/horde.ts';
import { IDLE_INPUT, newId, type Player, type World, type Zombie } from '../src/shared/sim/world.ts';
import { careerArt, careerTooltip } from '../src/client/medals.ts';
import { COSMETICS } from '../src/shared/cosmetics.ts';
import { fakeSocket, TICK_MS } from './helpers.ts';

const RIFLE: Loadout = { weapon: 'assault', armor: 'none', color: 'red' };
const accounts = { stats: () => null, credit: () => {}, nameForToken: () => null } as unknown as Parameters<typeof createRoom>[3];

test('the Zombies tracks are lifetime medals like any other: rungs at their counts, each once, a best night kept as a best', () => {
  assert.equal(ZOM_CAREER_IDS.length, 11);
  for (const t of ZOM_CAREER_IDS) {
    const at = CAREER[t].at;
    assert.ok(at[0] < at[1] && at[1] < at[2] && at[2] < at[3], `${t} climbs`);
    assert.ok(CAREER[t].needs.startsWith('zom:') && ZOM_STATS.includes(CAREER[t].needs.slice(4) as never), t);
  }
  const p = freshProfile('Zed', 0);
  assert.deepEqual(applyDelta(p, { zom: { kills: CAREER.zKills.at[0] - 1 } }, 1), []);
  assert.deepEqual(applyDelta(p, { zom: { kills: 1 } }, 2), [{ track: 'zKills', tier: 0 }]);
  assert.deepEqual(applyDelta(p, { zom: { kills: 1 } }, 3), [], 'a rung is earned once');
  assert.deepEqual(applyDelta(p, { zom: { bestNight: 5 } }, 4), [{ track: 'zBestNight', tier: 0 }, { track: 'zBestNight', tier: 1 }]);
  applyDelta(p, { zom: { bestNight: 3 } }, 5);
  assert.equal(trackCount(p, 'zBestNight'), 5, 'a shallower run leaves the best alone, and bests do not add up');
  assert.deepEqual(applyDelta(p, { zom: { bestNight: 10 } }, 6), [{ track: 'zBestNight', tier: 2 }, { track: 'zBestNight', tier: 3 }]);
  assert.deepEqual(applyDelta(p, { zom: { built: -50, rounds: Number.NaN } }, 7), [], 'nothing odd can take a count down');
  assert.equal(p.zombies.built, undefined);
});

test('Zombies stats persist through the profile store, ride the profile JSON, and a saved file cannot smuggle in others', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zom-career-'));
  const a = await openProfiles(dir);
  assert.deepEqual(a.record('Kit', { zom: { nights: 5, built: 30, bestNight: 4 } }, 9), [
    { track: 'zNights', tier: 0 }, { track: 'zBestNight', tier: 0 }, { track: 'zBuilt', tier: 0 },
  ]);
  await a.flush();
  const b = await openProfiles(dir);
  assert.deepEqual(b.get('kit')?.zombies, { nights: 5, built: 30, bestNight: 4 });
  assert.equal(b.get('kit')?.badges['zBuilt:0'], 9);
  const view = profileView(b.get('kit')!);
  assert.deepEqual(view.zombies, { nights: 5, built: 30, bestNight: 4 }, 'GET /api/profile serves them');
  assert.equal(view.badges['zNights:0'], 9);
  await writeFile(join(dir, 'profiles.json'), JSON.stringify({ kit: { name: 'Kit', zombies: { nights: 2, bogus: 7, rounds: -3 }, badges: { 'zNights:0': 1, 'zNights:9': 1 } } }));
  const c = await openProfiles(dir);
  assert.deepEqual({ z: c.get('kit')?.zombies, b: c.get('kit')?.badges }, { z: { nights: 2 }, b: { 'zNights:0': 1 } });
});

test('the platinum rungs of four Zombies tracks unlock Zombies cosmetics', async () => {
  const rewards = COSMETICS.filter((c) => 'career' in c.unlock && ZOM_CAREER_IDS.includes(c.unlock.career));
  assert.deepEqual(rewards.map((c) => c.id).sort(), ['h_hardhat', 'n_firstlight', 't_nightowl', 't_titan']);
  const profiles = await openProfiles(await mkdtemp(join(tmpdir(), 'zom-cos-')));
  profiles.record('Mo', { zom: { built: CAREER.zBuilt.at[3] - 1 } });
  assert.ok(!profiles.get('Mo')!.unlocked.includes('h_hardhat'));
  profiles.state('Mo');
  profiles.record('Mo', { zom: { built: 1 } });
  assert.ok(profiles.get('Mo')!.unlocked.includes('h_hardhat'));
  assert.deepEqual(profiles.notice('Mo')?.unlocks, ['h_hardhat'], 'and the player is told');
});

test('every Zombies medal has its own emblem and a tooltip that says what counts and every rung', () => {
  const glyphs = new Map<string, string>();
  for (const track of CAREER_IDS) glyphs.set(track, careerArt({ track, tier: 0 }).glyph);
  for (const t of ZOM_CAREER_IDS) {
    for (const [other, g] of glyphs) if (other !== t) assert.notEqual(glyphs.get(t), g, `${t} and ${other} share an emblem`);
    const tip = careerTooltip(t);
    assert.ok(tip.startsWith(`${CAREER[t].name}: Earned for ${CAREER[t].unit}: `), tip);
    assert.ok(tip.toLowerCase().includes(CAREER[t].desc!.toLowerCase()), `${t} explains what counts`);
  }
  assert.match(careerTooltip('zBestNight'), /Bronze 3 · Silver 5 · Gold 8 · Platinum 10/);
  assert.match(careerTooltip('zBestNight'), /Tide/);
  assert.match(careerTooltip('zBuilt', { tier: 1, at: Date.UTC(2026, 9, 1) }), /Held: Bricklayer II \(Silver\)/);
});

/** A squad room of four humans (no bots), each standing apart on the outpost, in the daylight before night `night`. */
async function squad(t: { after(fn: () => unknown): void }, night = 1) {
  const profiles = await openProfiles(await mkdtemp(join(tmpdir(), 'zom-room-')));
  const room = createRoom('z-career', 'ZOM', 1, accounts, 1, LIMITS, undefined, profiles);
  const w = room.world;
  const seat = (name: string) => {
    const ws = fakeSocket();
    room.connect(ws.socket);
    ws.send({ t: 'join', name, loadout: RIFLE, aspect: 1.5 });
    const welcome = ws.sent.find((m) => m.t === 'welcome');
    assert.ok(welcome?.t === 'welcome');
    return { ws, p: w.players.get(welcome.id)! };
  };
  const ann = seat('Ann'), bo = seat('Bo'), cy = seat('Cy'), di = seat('Di');
  t.after(async () => { for (const s of [ann, bo, cy, di]) s.ws.close(); await profiles.flush(); });
  assert.equal([...w.players.values()].filter((p) => p.kind === 'bot').length, 0, 'a full squad has no bots');
  const place = (p: Player, x: number, y: number) => { p.x = x; p.y = y; };
  place(ann.p, 1380, 1525);
  place(bo.p, 1475, 1700);
  place(cy.p, 1525, 1700);
  place(di.p, 1380, 1400);
  w.run!.scrap = 1e5;
  w.run!.night = night;
  w.run!.core.hp = 1e9;
  room.tick();
  return { profiles, room, w, ann, bo, cy, di };
}

const zom = (profiles: Awaited<ReturnType<typeof openProfiles>>, name: string) => profiles.get(name)?.zombies ?? {};
const badges = (sent: readonly ServerMsg[]) => sent.flatMap((m) => (m.t === 'badge' ? [m.badge] : []));
/** Does to the sim what `act` does, and hands its events to the room's next step as the sim's own would be. */
const simulate = (w: World, act: () => void) => { w.events = []; act(); w.queuedEvents.push(...w.events); w.events = []; };
const holder = (w: World): Zombie => ({ id: newId(w), kind: 'walker', x: 60, y: 60, hp: 1e9, attackAt: Infinity, vx: 0, vy: 0 });

test('in a squad room, builds, top-level upgrades and mending count toward the Zombies tracks of whoever did them', async (t) => {
  const { profiles, room, w, ann, di } = await squad(t);
  ann.ws.send({ t: 'build', kind: 'wall', cx: 26, cy: 30 });
  ann.ws.send({ t: 'build', kind: 'wall', cells: [[26, 31], [26, 32], [26, 33]] });
  ann.ws.send({ t: 'build', kind: 'wall', cx: 29, cy: 30 });
  assert.equal(zom(profiles, 'Ann').built, 4, 'a single build and each cell of a line count, a refused one does not');
  ann.ws.send({ t: 'upgrade', cx: 26, cy: 30 });
  assert.equal(zom(profiles, 'Ann').maxed, undefined, 'a step to level 2 is not the top');
  ann.ws.send({ t: 'upgrade', cx: 26, cy: 30 });
  assert.equal(zom(profiles, 'Ann').maxed, 1, 'the step to steel is');
  ann.ws.send({ t: 'upgrade', cx: 26, cy: 30 });
  assert.equal(zom(profiles, 'Ann').maxed, 1, 'a refused upgrade past the top counts nothing');

  const wall = w.buildings.find((b) => b.cx === 26 && b.cy === 30)!;
  wall.hp = 100;
  di.p.x = 1380; di.p.y = 1460;
  let seq = 1;
  setInput(w, di.p.id, seq++, { ...IDLE_INPUT, use: true });
  for (let ms = 0; ms < 4000; ms += TICK_MS) room.tick();
  setInput(w, di.p.id, seq++, { ...IDLE_INPUT });
  const mended = w.run!.mended?.get(di.p.id) ?? 0;
  assert.ok(mended > 250, `Di mended ${mended}`);
  // Mending trickles in; whole lumps are paid as they fill, and the rest when the phase turns.
  assert.ok((zom(profiles, 'Di').repaired ?? 0) >= 250);
  w.run!.phase = { k: 'night', toSpawn: [], nextSpawnAt: Infinity, dawnAt: Infinity };
  w.zombies.push(holder(w));
  room.tick();
  assert.equal(zom(profiles, 'Di').repaired, Math.floor(mended));
  assert.equal(zom(profiles, 'Ann').repaired, undefined);
});

test('in a squad room, nights, the furthest night, a flawless night, kills, Colossi, rounds and revives count, and a rung pays and shows its toast', async (t) => {
  const { profiles, room, w, ann, bo, cy, di } = await squad(t, 3);
  const run = w.run!;
  run.phase = { k: 'night', toSpawn: [], nextSpawnAt: Infinity, dawnAt: Infinity };
  w.zombies.push(holder(w));
  room.tick();
  for (const n of ['Ann', 'Bo', 'Cy', 'Di']) assert.equal(zom(profiles, n).bestNight, 3, `${n} reached night 3 at dusk`);
  assert.deepEqual(badges(ann.ws.sent), [{ track: 'zBestNight', tier: 0 }]);

  // Ann fires three rounds of her own.
  let seq = 1;
  for (let i = 0; i < 3; i++) {
    setInput(w, ann.p.id, seq++, { ...IDLE_INPUT, angle: 0, fire: true, shots: ann.p.input.shots + 1 });
    room.tick();
    setInput(w, ann.p.id, seq++, { ...IDLE_INPUT, angle: 0, shots: ann.p.input.shots });
    for (let k = 0; k < 15; k++) room.tick();
  }
  // Ann kills a walker; a Colossus Ann hit falls to Bo.
  const walker: Zombie = { ...holder(w), x: 900, y: 900, hp: 10 };
  const colossus: Zombie = { ...holder(w), kind: 'colossus', x: 300, y: 300, hp: 1e6 };
  w.zombies.push(walker, colossus);
  simulate(w, () => { damageZombie(w, walker, 100, ann.p); damageZombie(w, colossus, 50, ann.p); });
  room.tick();
  simulate(w, () => damageZombie(w, colossus, 1e9, bo.p));
  room.tick();
  assert.equal(zom(profiles, 'Ann').kills, 1);
  assert.equal(zom(profiles, 'Bo').kills, 1, 'the Colossus is a kill too');
  assert.equal(zom(profiles, 'Ann').colossi, 1, 'a hit in it fells it as much as the last blow');
  assert.equal(zom(profiles, 'Bo').colossi, 1);
  assert.equal(zom(profiles, 'Cy').colossi, undefined, 'no hit, no credit');
  assert.ok(badges(ann.ws.sent).some((b) => b.track === 'zColossus'), 'Titan Toppler I lands in the moment');

  // Cy revives Bo.
  bo.p.life = { k: 'downed', bleedOutAt: w.now + 1e9, reviveProgress: 0, hp: 50 };
  cy.p.x = bo.p.x + 30; cy.p.y = bo.p.y;
  setInput(w, cy.p.id, seq++, { ...IDLE_INPUT, use: true });
  for (let ms = 0; ms < ZOM.reviveMs + 300; ms += TICK_MS) room.tick();
  assert.equal(bo.p.life.k, 'alive');
  assert.equal(zom(profiles, 'Cy').revives, 1);
  setInput(w, cy.p.id, seq++, { ...IDLE_INPUT });

  // Dawn: the night is seen out with the core untouched.
  const before = ann.p.score;
  w.zombies = [];
  room.tick();
  assert.equal(run.night, 4);
  for (const n of ['Ann', 'Bo', 'Cy', 'Di']) assert.deepEqual([zom(profiles, n).nights, zom(profiles, n).flawless], [1, 1], n);
  assert.equal(zom(profiles, 'Ann').rounds, 3, 'rounds fired are paid when the night turns');
  assert.ok(badges(di.ws.sent).some((b: Badge) => b.track === 'zFlawless' && b.tier === 0), 'Not a Scratch I');
  assert.ok(ann.p.score - before >= CAREER_PAY.bronze, 'and it pays its score');
  assert.deepEqual(ann.p.badge, { track: 'zBestNight', tier: 0 }, 'a held medal is worn');

  // A night where the horde reaches the core is survived but not flawless.
  run.phase = { k: 'night', toSpawn: [], nextSpawnAt: Infinity, dawnAt: Infinity };
  w.zombies.push(holder(w));
  room.tick();
  hurtCore(run, 5);
  room.tick();
  w.zombies = [];
  room.tick();
  assert.deepEqual([zom(profiles, 'Ann').nights, zom(profiles, 'Ann').flawless, zom(profiles, 'Ann').bestNight], [2, 1, 4]);

  assert.equal(zom(profiles, 'Ann').wins, undefined);
});

test('in a squad room, holding the Bastion through the Tide wins the run for everyone who sat it', async (t) => {
  const { profiles, room, w, bo } = await squad(t, 10);
  w.run!.phase = { k: 'night', toSpawn: [], nextSpawnAt: Infinity, dawnAt: Infinity };
  w.zombies.push(holder(w));
  room.tick();
  w.zombies = [];
  room.tick();
  assert.equal(w.run!.phase.k, 'over');
  const z = zom(profiles, 'Bo');
  assert.deepEqual([z.wins, z.nights, z.bestNight, z.flawless], [1, 1, 10, 1]);
  assert.ok(badges(bo.ws.sent).some((b) => b.track === 'zWins' && b.tier === 0), 'Held the Line I');
  assert.ok(badges(bo.ws.sent).some((b) => b.track === 'zBestNight' && b.tier === 3), 'Last Light IV');
});

test('bots, the range and versus rooms count for nothing on the Zombies tracks', async (t) => {
  const profiles = await openProfiles(await mkdtemp(join(tmpdir(), 'zom-none-')));
  const room = createRoom('z-bots', 'ZOM', 2, accounts, 1, LIMITS, undefined, profiles);
  const w = room.world;
  const ws = fakeSocket();
  room.connect(ws.socket);
  ws.send({ t: 'join', name: 'Lou', loadout: RIFLE, aspect: 1.5 });
  t.after(async () => { ws.close(); await profiles.flush(); });
  const bots = [...w.players.values()].filter((p) => p.kind === 'bot');
  assert.equal(bots.length, ZOM.squadSize - 1);
  w.run!.core.hp = 1e9;
  room.tick();
  w.run!.phase = { k: 'night', toSpawn: [], nextSpawnAt: Infinity, dawnAt: Infinity };
  w.zombies.push(holder(w));
  room.tick();
  const prey: Zombie = { ...holder(w), x: 900, y: 900, hp: 5 };
  w.zombies.push(prey);
  simulate(w, () => damageZombie(w, prey, 100, bots[0]!));
  for (let ms = 0; ms < 3000; ms += TICK_MS) room.tick();
  w.zombies = [];
  room.tick();
  for (const b of bots) assert.equal(profiles.get(b.name), null, `${b.name} keeps no profile`);
  assert.equal(zom(profiles, 'Lou').kills, undefined, 'a bot\'s kill is not the human\'s');
  assert.equal(zom(profiles, 'Lou').nights, 1, 'the human still saw the night out');

  for (const mode of ['RNG', 'FFA'] as const) {
    const other = createRoom(`x-${mode}`, mode, 3, accounts, 1, { ...LIMITS, minPlayers: 2 }, undefined, profiles);
    const s = fakeSocket();
    other.connect(s.socket);
    s.send({ t: 'join', name: `Rae${mode}`, loadout: RIFLE, aspect: 1.5 });
    const welcome = s.sent.find((m) => m.t === 'welcome');
    assert.ok(welcome?.t === 'welcome');
    const me = other.world.players.get(welcome.id)!;
    let seq = 1;
    for (let i = 0; i < 40; i++) {
      setInput(other.world, me.id, seq++, { ...IDLE_INPUT, angle: 0, fire: true, shots: me.input.shots + 1 });
      other.tick();
      other.tick();
    }
    s.close();
    assert.ok(other.world.events !== undefined);
    assert.deepEqual(zom(profiles, `Rae${mode}`), {}, `${mode}: no Zombies rounds`);
  }
});
