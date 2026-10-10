import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LEVELS, LOOT, RING, TOWER, WORLD } from '../src/shared/defs.ts';
import type { Circle, GameEvent } from '../src/shared/protocol.ts';
import { step } from '../src/shared/sim.ts';
import { snapshotFor } from '../src/shared/sim/snapshot.ts';
import { enterRoyale, newRoyale, openDrop } from '../src/shared/sim/royale.ts';
import type { Player, World } from '../src/shared/sim/world.ts';
import type { Accounts } from '../src/server/accounts.ts';
import { createRoom } from '../src/server/room.ts';
import { emptyWorld, fakeSocket, hpOf, PISTOL, run, shootOnce, shootUntilDead, spawnAt, TICK_MS } from './helpers.ts';

/** Reads the life afresh, past what an earlier assertion narrowed it to. */
const lifeOf = (p: Player) => p.life;

/** A Last Standing world with no caches or towers on it, unless a test places its own. */
function brWorld(): World {
  const w = emptyWorld('BR');
  w.royale!.caches = [];
  w.royale!.towers = [];
  return w;
}

/** Solo players in the match: each its own side (`team` null), entered as the match would enter them. */
function solo(w: World, x: number, y: number, opts: Parameters<typeof spawnAt>[3] = {}): Player {
  const p = spawnAt(w, x, y, { ...opts, team: null });
  enterRoyale(w, p);
  if (p.life.k === 'alive') p.life.shieldUntil = -Infinity;
  return p;
}

function holdRing(w: World, circle: Circle, phase = 1) {
  w.royale!.ring = { k: 'waiting', phase, circle, next: circle, shrinkAt: Infinity };
}

function collect(w: World, ms: number): GameEvent[] {
  const seen: GameEvent[] = [];
  for (let t = 0; t < ms; t += TICK_MS) { step(w, TICK_MS); seen.push(...w.events); }
  return seen;
}

test('the ring burns only those outside it, through armor and the spawn shield, and holds their regen off', () => {
  const w = brWorld();
  holdRing(w, { x: 1000, y: 1000, r: 400 });
  const inside = solo(w, 1100, 1000);
  const outside = solo(w, 2000, 1000);
  if (outside.life.k === 'alive') outside.life.shieldUntil = Infinity;
  run(w, 1000);
  assert.equal(hpOf(inside), 100);
  assert.ok(Math.abs(hpOf(outside) - (100 - RING[1]!.dps * 100)) < 0.5, `lost ${100 - hpOf(outside)} in a second`);
  if (inside.life.k === 'alive') { inside.life.hp = 50; inside.life.lastDamageAt = -Infinity; }
  const before = hpOf(outside);
  run(w, 6000);
  assert.ok(hpOf(inside) > 50, 'regenerates inside');
  assert.ok(hpOf(outside) < before - 5 * RING[1]!.dps * 100, 'no regen while burning');
});

test('every player is on their own: a hit hurts anyone, a fall is a death, never a knock, and it pays the kill', () => {
  const w = brWorld();
  w.firstBlood = true;
  const shooter = solo(w, 1000, 1000);
  const victim = solo(w, 1200, 1000);
  solo(w, 3000, 3000);
  assert.equal(shooter.team, null);
  shootUntilDead(w, shooter, victim);
  assert.equal(lifeOf(victim).k, 'dead', 'no knock, no squad to revive them');
  assert.equal(shooter.kills, 1);
  assert.equal(snapshotFor(w, shooter.id).royale!.alive, 3, 'redeploys are open, so the dead are still in it');
});

test('everyone starts a life with no armor, whatever their loadout says', () => {
  const w = brWorld();
  const p = solo(w, 1000, 1000, { loadout: { armor: 'heavy' } });
  assert.equal(p.loadout.armor, 'none');
  assert.ok(p.life.k === 'alive' && p.life.armor === 0);
});

test('a dead player redeploys inside the circle with their class gun, no armor and a spawn shield, later each death', () => {
  const w = brWorld();
  holdRing(w, { x: 3000, y: 3000, r: 1500 });
  const shooter = solo(w, 2400, 3000);
  const victim = solo(w, 2600, 3000, { loadout: { weapon: 'smg' } });
  victim.gun = 'heavySmg';
  shootUntilDead(w, shooter, victim);
  assert.ok(snapshotFor(w, victim.id).royale!.redeployAt! > w.now);
  run(w, 11_000);
  assert.equal(lifeOf(victim).k, 'dead');
  run(w, 1500);
  assert.equal(lifeOf(victim).k, 'alive');
  assert.ok(Math.hypot(victim.x - 3000, victim.y - 3000) <= 1500, 'inside the circle');
  assert.equal(victim.gun, 'smg');
  assert.equal(victim.loadout.armor, 'none');
  assert.equal(snapshotFor(w, victim.id).players.find((p) => p.id === victim.id)?.spawnShield, true);
});

test('once the second ring phase closes nobody redeploys: a death is out for good, placed by when it fell', () => {
  const w = brWorld();
  holdRing(w, { x: 3000, y: 3000, r: 3000 }, 1);
  const shooter = solo(w, 1000, 1000);
  const victim = solo(w, 1200, 1000);
  solo(w, 3000, 3000);
  w.royale!.ring = { k: 'shrinking', phase: 1, from: { x: 3000, y: 3000, r: 3000 }, to: { x: 3000, y: 3000, r: 2900 }, startAt: w.now, closeAt: w.now + 100 };
  run(w, 200);
  assert.equal(snapshotFor(w, victim.id).royale!.redeploys, false);
  const events: GameEvent[] = [];
  shootUntilDead(w, shooter, victim);
  events.push(...collect(w, 200));
  assert.equal(snapshotFor(w, victim.id).royale!.result?.place, 3, 'first of three out: third');
  run(w, 30_000);
  assert.equal(lifeOf(victim).k, 'dead');
  assert.equal(snapshotFor(w, shooter.id).royale!.alive, 2);
});

test('the last one standing wins, and everyone reads back the place they went out in', () => {
  const w = brWorld();
  holdRing(w, { x: 3000, y: 3000, r: 3000 }, 2);
  const a = solo(w, 1000, 1000);
  const b = solo(w, 1200, 1000);
  const c = solo(w, 1000, 1200);
  shootUntilDead(w, a, b);
  run(w, 100);
  shootUntilDead(w, a, c, Math.PI / 2);
  run(w, 200);
  assert.equal(w.match.k, 'over');
  assert.ok(w.match.k === 'over' && w.match.winner.id === a.id && w.match.winner.note === 'Last one standing');
  assert.deepEqual([a, b, c].map((p) => snapshotFor(w, p.id).royale!.result?.place), [1, 3, 2]);
  assert.equal(snapshotFor(w, a.id).royale!.result?.kills, 2);
});

test('friends never hurt each other in Last Standing either', async () => {
  const { befriend } = await import('../src/shared/sim/world.ts');
  const w = brWorld();
  const a = solo(w, 1000, 1000), b = solo(w, 1200, 1000);
  befriend(w, a.id, b.id);
  shootOnce(w, a, 0);
  assert.equal(hpOf(b), 100);
});

test('a cache opens for whoever walks up to it, and pays by its tier: score, armor, health, and an epic one a level pick', () => {
  const w = brWorld();
  const p = solo(w, 1000, 1000);
  if (p.life.k === 'alive') { p.life.hp = 40; p.life.ammo = 1; }
  const r = w.royale!;
  const at = (id: number, tier: 0 | 1 | 2) => ({ id, x: 1000 + LOOT.openPx, y: 1000, tier, open: false });
  r.caches = [at(901, 0)];
  const events = collect(w, LOOT.openMs + TICK_MS * 2);
  assert.ok(r.caches[0]!.open, 'opened on walk-up');
  assert.ok(p.score >= LOOT.tiers[0].score, 'a common one pays score');
  assert.ok(p.life.k === 'alive' && p.life.ammo > 1, 'and a full magazine');
  assert.ok(events.some((e) => e.e === 'loot' && e.tier === 0 && e.by === p.id));
  assert.ok(events.some((e) => e.e === 'gain' && e.from === 'loot' && (e.xp ?? 0) > 0));

  r.caches = [at(902, 1)];
  const hpBefore = hpOf(p);
  const rare = collect(w, LOOT.openMs + TICK_MS * 2);
  assert.equal(p.loadout.armor, 'light', 'a rare one puts the armor up a tier');
  assert.ok(p.life.k === 'alive' && p.life.armor > 0);
  assert.ok(hpOf(p) > hpBefore, 'and heals');
  assert.ok(rare.some((e) => e.e === 'gain' && e.armorTo === 'light'));

  const level = p.level;
  r.caches = [at(903, 2)];
  collect(w, LOOT.openMs + TICK_MS * 2);
  assert.equal(p.level, level + 1, 'an epic one skips to the next pick');
  assert.equal(p.loadout.armor, 'medium');
  assert.equal(hpOf(p), 100, 'and resupplies in full');
  assert.equal(snapshotFor(w, p.id).royale!.caches.length, 1);
  assert.equal(snapshotFor(w, p.id).royale!.caches[0]![4], 1, 'the view shows it opened');
});

test('a match lays caches of every tier over the map, apart from each other, and a few towers far apart', () => {
  const w = emptyWorld('BR');
  const r = newRoyale(w);
  assert.ok(r.caches.length >= LOOT.count * 0.7, `${r.caches.length} caches`);
  for (const a of r.caches) for (const b of r.caches) if (a !== b) assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= LOOT.spacing - 1e-6);
  assert.ok(r.caches.some((c) => c.tier === 0) && r.caches.some((c) => c.tier === 1));
  assert.equal(r.towers.length, TOWER.count);
  for (const a of r.towers) for (const b of r.towers) if (a !== b) assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= 1000, 'towers far apart');
});

test('a tower held alone marks everyone within reach on its holder\'s minimap, then rests; a rival inside stops the hold', () => {
  const w = brWorld();
  const r = w.royale!;
  r.towers = [{ x: 2000, y: 2000, readyAt: 0, holder: null, since: 0 }];
  const holder = solo(w, 2000, 2000);
  const near = solo(w, 2000 + TOWER.revealPx - 200, 2000);
  const far = solo(w, 2000, 2000 + TOWER.revealPx + 300);
  const contester = solo(w, 2050, 2000);
  run(w, TOWER.holdMs + 500);
  assert.equal(r.towers[0]!.readyAt, 0, 'two inside: nobody takes it');
  contester.x = 5000;
  contester.y = 5000;
  const events = collect(w, TOWER.holdMs + 300);
  assert.ok(r.towers[0]!.readyAt > w.now, 'taken, now resting');
  assert.ok(events.some((e) => e.e === 'tower' && e.by === holder.id));
  const marks = snapshotFor(w, holder.id).minimap.filter((m) => m.marked);
  assert.ok(marks.some((m) => Math.abs(m.x - near.x) < 2), 'the near one is marked');
  assert.ok(!marks.some((m) => Math.abs(m.x - far.x) < 2), 'the far one is not');
  assert.equal(snapshotFor(w, near.id).minimap.filter((m) => m.marked).length, 0, 'only for the holder');
});

test('a supply drop shows before it lands, and breaking it jumps the breaker to their next level pick', () => {
  const w = brWorld();
  const shooter = solo(w, 1000, 1000);
  solo(w, 4000, 4000);
  w.royale!.drops = [{ x: 1300, y: 1000, landsAt: w.now + 5000 }];
  assert.deepEqual(snapshotFor(w, shooter.id).royale!.drops, [{ x: 1300, y: 1000, landsAt: w.now + 5000 }]);
  run(w, 5100);
  const drop = w.crates.find((c) => c.drop)!;
  assert.ok(drop && Math.abs(drop.x + drop.size / 2 - 1300) < 1, 'lands where it was shown');
  for (let i = 0; i < 40 && drop.respawnAt === null; i++) shootOnce(w, shooter, 0, 250);
  assert.notEqual(drop.respawnAt, null);
  assert.equal(shooter.level, 1);
});

test('cracking a supply drop says what it gave on the opener\'s chips and in the feed', () => {
  const w = brWorld();
  const p = solo(w, 1000, 1000, { name: 'Opener' });
  if (p.life.k === 'alive') { p.life.hp = 20; p.life.ammo = 1; }
  w.events = [];
  openDrop(w, p, { x: 1300, y: 1000 });
  const gain = w.events.find((e) => e.e === 'gain');
  assert.ok(gain && gain.e === 'gain' && gain.level && (gain.hp ?? 0) > 0 && (gain.ammo ?? 0) > 0, JSON.stringify(gain));
  assert.deepEqual(w.events.find((e) => e.e === 'airdrop'), { e: 'airdrop', k: 'taken', x: 1300, y: 1000, by: 'Opener', gold: false, level: true });
  assert.ok(p.level < LEVELS.length);
});

test('a joiner takes a bot\'s place while redeploys are open; after that they watch until the next match enters them', (t) => {
  const accounts = { stats: () => null, nameForToken: () => null, credit: () => {} } as unknown as Accounts;
  const room = createRoom('br-test', 'BR', 1, accounts);
  const w = room.world;
  const join = (name: string) => {
    const ws = fakeSocket();
    room.connect(ws.socket);
    t.after(ws.close);
    ws.send({ t: 'join', name, loadout: PISTOL, aspect: 1.5 });
    const welcome = ws.sent.find((m) => m.t === 'welcome');
    return { ws, p: w.players.get(welcome?.t === 'welcome' ? welcome.id : -1)! };
  };
  assert.equal(w.players.size, 18);
  const ann = join('Ann');
  assert.equal(w.players.size, 18, 'the joiner replaces a bot');
  assert.equal(ann.p.team, null);
  assert.equal(lifeOf(ann.p).k, 'alive');
  assert.ok(w.royale!.entrants.includes(ann.p.id));
  assert.equal(w.royale!.entrants.length, 18);

  w.royale!.ring = { k: 'waiting', phase: 3, circle: { x: 3000, y: 3000, r: 4300 }, next: { x: 3000, y: 3000, r: 4300 }, shrinkAt: Infinity };
  const cat = join('Cat');
  assert.equal(w.players.size, 19, 'no place once redeploys close');
  assert.equal(lifeOf(cat.p).k, 'dead');
  assert.ok(!w.royale!.entrants.includes(cat.p.id));
  room.tick();
  const snap = cat.ws.sent.filter((m) => m.t === 'snap').at(-1);
  assert.ok(snap?.t === 'snap' && snap.royale?.watch !== null, 'watches someone still in');

  w.match = { k: 'over', winner: { name: 'Ann', id: ann.p.id, note: null }, restartAt: w.now };
  w.mapChangeAt = w.now;
  room.tick();
  room.tick();
  assert.equal(lifeOf(cat.p).k, 'alive', 'the next match enters them');
  assert.ok(w.royale!.entrants.includes(cat.p.id));
  assert.equal(w.players.size, 18);
});
