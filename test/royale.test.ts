import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RING, WORLD, ZOM } from '../src/shared/defs.ts';
import { goDown } from '../src/shared/sim/downed.ts';
import type { Circle, GameEvent } from '../src/shared/protocol.ts';
import { removePlayer, step } from '../src/shared/sim.ts';
import { snapshotFor } from '../src/shared/sim/snapshot.ts';
import type { Player, World } from '../src/shared/sim/world.ts';
import type { Accounts } from '../src/server/accounts.ts';
import { createRoom } from '../src/server/room.ts';
import { emptyWorld, fakeSocket, hpOf, PISTOL, press, run, shootOnce, shootUntilDead, spawnAt, TICK_MS } from './helpers.ts';

/** Reads the life afresh, past what an earlier assertion narrowed it to. */
const lifeOf = (p: Player) => p.life;

function holdRing(w: World, circle: Circle, phase = 1) {
  w.royale!.ring = { k: 'waiting', phase, circle, next: circle, shrinkAt: Infinity };
}

function collect(w: World, ms: number): GameEvent[] {
  const seen: GameEvent[] = [];
  for (let t = 0; t < ms; t += TICK_MS) { step(w, TICK_MS); seen.push(...w.events); }
  return seen;
}

test('the ring burns only those outside it, through armor and the spawn shield, and holds their regen off', () => {
  const w = emptyWorld('BR');
  holdRing(w, { x: 1000, y: 1000, r: 400 });
  const inside = spawnAt(w, 1100, 1000, { team: 'red', loadout: { armor: 'heavy' } });
  const outside = spawnAt(w, 2000, 1000, { team: 'red', loadout: { armor: 'heavy' }, shielded: true });
  spawnAt(w, 200, 200, { team: 'blue' });
  run(w, 1000);
  assert.equal(hpOf(inside), 100);
  assert.ok(Math.abs(hpOf(outside) - (100 - RING[1]!.dps * 100)) < 0.5, `lost ${100 - hpOf(outside)} in a second`);
  if (inside.life.k === 'alive') inside.life.hp = 50;
  if (inside.life.k === 'alive') inside.life.lastDamageAt = -Infinity;
  const before = hpOf(outside);
  run(w, 6000);
  assert.ok(hpOf(inside) > 50, 'regenerates inside');
  assert.ok(hpOf(outside) < before - 5 * RING[1]!.dps * 100, 'no regen while burning');
});

test('a player with a squadmate standing is knocked, not killed, and the knock pays the kill; enemies can shoot the knocked player to finish them', () => {
  const w = emptyWorld('BR');
  w.firstBlood = true;
  const shooter = spawnAt(w, 1000, 1000, { team: 'blue' });
  const victim = spawnAt(w, 1200, 1000, { team: 'red' });
  spawnAt(w, 3000, 3000, { team: 'red' });
  shootUntilDead(w, shooter, victim);
  assert.equal(lifeOf(victim).k, 'downed');
  assert.equal(shooter.kills, 1);
  assert.equal(shooter.score, 100);
  for (let i = 0; i < 10 && lifeOf(victim).k === 'downed'; i++) shootOnce(w, shooter, 0, 300);
  assert.equal(lifeOf(victim).k, 'dead');
  assert.equal(shooter.kills, 1, 'the finish pays no second kill');
});

test('a squad is out once nobody in it stands: its knocked players die with it and it places below the squads still in', () => {
  const w = emptyWorld('BR');
  const shooter = spawnAt(w, 1000, 1000, { team: 'blue' });
  const first = spawnAt(w, 1200, 1000, { team: 'red' });
  const last = spawnAt(w, 1000, 1200, { team: 'red' });
  spawnAt(w, 4000, 4000, { team: 'green' });
  shootUntilDead(w, shooter, first);
  assert.equal(lifeOf(first).k, 'downed');
  const events: GameEvent[] = [];
  for (let i = 0; i < 40 && lifeOf(last).k === 'alive'; i++) { shootOnce(w, shooter, Math.PI / 2, 0); events.push(...w.events, ...collect(w, 300)); }
  step(w, TICK_MS);
  events.push(...w.events);
  assert.equal(lifeOf(last).k, 'dead', 'the last one standing dies outright');
  assert.equal(lifeOf(first).k, 'dead', 'the knocked squadmate dies with the squad');
  assert.deepEqual(events.filter((e) => e.e === 'wiped'), [{ e: 'wiped', team: 'red', place: 3 }]);
  assert.equal(w.match.k, 'playing', 'two squads are still in');
});

test('the last squad standing wins, and every squad reads back the place it went out in', () => {
  const w = emptyWorld('BR');
  const shooter = spawnAt(w, 1000, 1000, { team: 'blue' });
  const green = spawnAt(w, 1200, 1000, { team: 'green' });
  const red = spawnAt(w, 1000, 1200, { team: 'red' });
  shootUntilDead(w, shooter, green);
  shootUntilDead(w, shooter, red, Math.PI / 2);
  step(w, TICK_MS);
  assert.equal(w.match.k, 'over');
  if (w.match.k === 'over') assert.deepEqual(w.match.winner, { name: 'Blue squad', id: null, note: 'Last squad standing' });
  const place = (p: Player) => snapshotFor(w, p.id).royale!.result?.place;
  assert.deepEqual([place(shooter), place(red), place(green)], [1, 2, 3]);
  assert.equal(snapshotFor(w, shooter.id).royale!.result!.of, 3);
});

test('a winner still knocked when the next match starts has the life it ends paid, like those standing', () => {
  const w = emptyWorld('BR');
  const shooter = spawnAt(w, 1000, 1000, { team: 'blue' });
  const mate = spawnAt(w, 3000, 3000, { team: 'blue' });
  const green = spawnAt(w, 1200, 1000, { team: 'green' });
  mate.score = 300;
  goDown(w, mate, 50);
  shootUntilDead(w, shooter, green);
  step(w, TICK_MS);
  assert.equal(w.match.k, 'over');
  w.lifeRecords.length = 0;
  run(w, WORLD.roundRestartMs + 500);
  assert.equal(w.match.k, 'playing', 'the next match is on');
  assert.deepEqual(w.lifeRecords.filter((r) => r.id === mate.id).map((r) => r.score), [300], 'the knocked winner\'s life is paid');
  assert.equal(w.lifeRecords.filter((r) => r.id === shooter.id).length, 1, 'as is the standing one\'s');
});

test('bullets spare a squadmate but hurt every other squad', () => {
  const w = emptyWorld('BR');
  const shooter = spawnAt(w, 1000, 1000, { team: 'green' });
  const mate = spawnAt(w, 1200, 1000, { team: 'green' });
  const rival = spawnAt(w, 1000, 1200, { team: 'yellow' });
  shootOnce(w, shooter, 0);
  assert.equal(hpOf(mate), 100);
  shootOnce(w, shooter, Math.PI / 2);
  assert.ok(hpOf(rival) < 100);
});

function finish(w: World, shooter: Player, victim: Player, angle = 0) {
  shootUntilDead(w, shooter, victim, angle);
  for (let i = 0; i < 20 && lifeOf(victim).k === 'downed'; i++) shootOnce(w, shooter, angle, 300);
  assert.equal(lifeOf(victim).k, 'dead');
}

test('a dead player redeploys beside a standing squadmate, later each death, with the class gun and a spawn shield', () => {
  const w = emptyWorld('BR');
  const shooter = spawnAt(w, 1000, 1000, { team: 'blue' });
  const victim = spawnAt(w, 1200, 1000, { team: 'red', loadout: { weapon: 'smg' } });
  const mate = spawnAt(w, 3000, 3000, { team: 'red' });
  victim.gun = 'heavySmg';
  finish(w, shooter, victim);
  assert.ok(snapshotFor(w, victim.id).royale!.redeployAt! > w.now);
  run(w, 14_000);
  assert.equal(lifeOf(victim).k, 'dead');
  run(w, 1500);
  assert.equal(lifeOf(victim).k, 'alive');
  assert.ok(Math.hypot(victim.x - mate.x, victim.y - mate.y) < 250, 'beside the squadmate');
  assert.equal(victim.gun, 'smg');
  assert.equal(snapshotFor(w, victim.id).players.find((p) => p.id === victim.id)?.spawnShield, true);
  victim.x = 1200;
  victim.y = 1000;
  if (victim.life.k === 'alive') victim.life.shieldUntil = -Infinity;
  finish(w, shooter, victim);
  run(w, 20_000);
  assert.equal(lifeOf(victim).k, 'dead', 'the second wait is longer');
  run(w, 6000);
  assert.equal(lifeOf(victim).k, 'alive');
});

test('once the third ring phase closes nobody redeploys: last lives', () => {
  const w = emptyWorld('BR');
  holdRing(w, { x: 3000, y: 3000, r: 3000 }, 2);
  const shooter = spawnAt(w, 1000, 1000, { team: 'blue' });
  const victim = spawnAt(w, 1200, 1000, { team: 'red' });
  spawnAt(w, 3000, 3000, { team: 'red' });
  finish(w, shooter, victim);
  assert.equal(snapshotFor(w, victim.id).royale!.redeploys, true);
  w.royale!.ring = { k: 'shrinking', phase: 2, from: { x: 3000, y: 3000, r: 3000 }, to: { x: 3000, y: 3000, r: 2900 }, startAt: w.now, closeAt: w.now + 100 };
  run(w, 200);
  const view = snapshotFor(w, victim.id).royale!;
  assert.equal(view.ring.phase, 3);
  assert.equal(view.redeploys, false);
  assert.equal(view.redeployAt, null);
  run(w, 25_000);
  assert.equal(lifeOf(victim).k, 'dead');
});

test('a dead player watches a squadmate still up, and the snapshot centres on them', () => {
  const w = emptyWorld('BR');
  const shooter = spawnAt(w, 1000, 1000, { team: 'blue' });
  const victim = spawnAt(w, 1200, 1000, { team: 'red' });
  const mate = spawnAt(w, 4000, 4000, { team: 'red' });
  const near = spawnAt(w, 4300, 4000, { team: 'green' });
  finish(w, shooter, victim);
  step(w, TICK_MS);
  const snap = snapshotFor(w, victim.id);
  assert.equal(snap.royale!.watch, mate.id);
  assert.ok(snap.players.some((p) => p.id === near.id), 'sees what the watched squadmate sees');
  assert.ok(!snap.players.some((p) => p.id === shooter.id), 'not what is round its own body');
});

test('a squadmate holding use beside a knocked player revives them; left alone they bleed out', () => {
  const w = emptyWorld('BR');
  const shooter = spawnAt(w, 1000, 1000, { team: 'blue' });
  const victim = spawnAt(w, 1200, 1000, { team: 'red' });
  const medic = spawnAt(w, 1200, 1050, { team: 'red' });
  shootUntilDead(w, shooter, victim);
  press(w, medic, { use: true });
  run(w, ZOM.reviveMs + 100);
  assert.equal(lifeOf(victim).k, 'alive');
  assert.equal(w.royale!.stats.get(medic.id)?.revives, 1);
  press(w, medic, {});
  shootUntilDead(w, shooter, victim);
  run(w, ZOM.bleedOutMs + 100);
  assert.equal(lifeOf(victim).k, 'dead');
});

test('a supply drop shows before it lands, and breaking it jumps the breaker to their next level pick, or heals one with every pick made', () => {
  const w = emptyWorld('BR');
  const shooter = spawnAt(w, 1000, 1000, { team: 'blue' });
  spawnAt(w, 4000, 4000, { team: 'red' });
  w.royale!.drops = [{ x: 1300, y: 1000, landsAt: w.now + 5000 }];
  assert.deepEqual(snapshotFor(w, shooter.id).royale!.drops, [{ x: 1300, y: 1000, landsAt: w.now + 5000 }]);
  assert.ok(!w.crates.some((c) => c.drop));
  run(w, 5100);
  const drop = w.crates.find((c) => c.drop)!;
  assert.ok(drop && Math.abs(drop.x + drop.size / 2 - 1300) < 1, 'lands where it was shown');
  for (let i = 0; i < 40 && drop.respawnAt === null; i++) shootOnce(w, shooter, 0, 250);
  assert.notEqual(drop.respawnAt, null);
  assert.equal(shooter.level, 1);
  assert.deepEqual(snapshotFor(w, shooter.id).self.pending, { level: 1, k: 'perk', tier: 1 });

  shooter.level = 5;
  shooter.score = 600;
  shooter.perks = { 1: 'extended', 2: 'thickSkin', 3: 'fragGrenade' };
  shooter.gun = 'executioner';
  if (shooter.life.k === 'alive') shooter.life.hp = 10;
  w.royale!.drops = [{ x: 1300, y: 1000, landsAt: w.now }];
  run(w, 100);
  const second = w.crates.find((c) => c.drop && c.respawnAt === null)!;
  for (let i = 0; i < 40 && second.respawnAt === null; i++) shootOnce(w, shooter, 0, 250);
  assert.equal(shooter.level, 5);
  assert.ok(hpOf(shooter) >= 140, `healed to ${hpOf(shooter)}`);
});

test('crates pay 25 and stay broken for the match', () => {
  const w = emptyWorld('BR');
  const shooter = spawnAt(w, 1000, 1000, { team: 'blue' });
  spawnAt(w, 4000, 4000, { team: 'red' });
  w.crates = [{ id: 999_999, x: 1150, y: 978, size: 44, hp: 40, respawnAt: null }];
  w.wallsVersion++;
  for (let i = 0; i < 6; i++) shootOnce(w, shooter, 0, 250);
  assert.equal(shooter.score, 25);
  run(w, 60_000);
  assert.ok(!snapshotFor(w, shooter.id).crates.some((c) => c.id === 999_999));
});

test('a joiner takes a bot\'s seat while redeploys are open, solo humans spread one per squad, and after that they watch until the next match seats them', (t) => {
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
  const squadOf = (team: Player['team']) => [...w.players.values()].filter((p) => p.team === team);
  assert.equal(w.players.size, 18);
  const ann = join('Ann');
  const bob = join('Bob');
  assert.equal(w.players.size, 18, 'each joiner replaces a bot');
  assert.notEqual(ann.p.team, null);
  assert.notEqual(ann.p.team, bob.p.team, 'two solo humans land in different squads');
  assert.deepEqual(squadOf(ann.p.team).map((p) => p.kind).sort(), ['bot', 'bot', 'human']);
  assert.equal(lifeOf(ann.p).k, 'alive');

  w.royale!.ring = { k: 'waiting', phase: 3, circle: { x: 3000, y: 3000, r: 4300 }, next: { x: 3000, y: 3000, r: 4300 }, shrinkAt: Infinity };
  const cat = join('Cat');
  assert.equal(w.players.size, 19, 'no seat once redeploys close');
  assert.equal(cat.p.team, null);
  assert.equal(lifeOf(cat.p).k, 'dead');
  room.tick();
  const snap = cat.ws.sent.filter((m) => m.t === 'snap').at(-1);
  assert.ok(snap?.t === 'snap' && snap.royale?.watch !== null, 'watches someone still in');

  w.match = { k: 'over', winner: { name: 'Red squad', id: null, note: null }, restartAt: w.now };
  w.mapChangeAt = w.now;
  room.tick();
  assert.notEqual(cat.p.team, null, 'the next match seats them');
  assert.equal(lifeOf(cat.p).k, 'alive');
  assert.equal(w.players.size, 18);
  assert.equal(new Set([ann.p.team, bob.p.team, cat.p.team]).size, 3);
  for (const team of new Set([...w.players.values()].map((p) => p.team))) assert.equal(squadOf(team).length, 3, `${team} has three`);
});

test('a knocked player who leaves has the life paid, as a standing one does', () => {
  const w = emptyWorld('BR');
  const p = spawnAt(w, 1000, 1000, { team: 'blue' });
  spawnAt(w, 3000, 3000, { team: 'blue' });
  p.score = 250;
  goDown(w, p, 50);
  w.lifeRecords.length = 0;
  removePlayer(w, p.id);
  assert.deepEqual(w.lifeRecords.filter((r) => r.id === p.id).map((r) => [r.score, r.died]), [[250, false]]);
});

test('cracking a supply drop says what it gave: a level and a resupply on the opener\'s chips, and who cracked it in the feed', async () => {
  const { openDrop } = await import('../src/shared/sim/royale.ts');
  const w = emptyWorld('BR');
  const p = spawnAt(w, 1000, 1000, { team: 'blue', name: 'Opener' });
  if (p.life.k === 'alive') { p.life.hp = 20; p.life.ammo = 1; }
  w.events = [];
  openDrop(w, p, { x: 1300, y: 1000 });
  const gain = w.events.find((e) => e.e === 'gain');
  assert.ok(gain && gain.e === 'gain' && gain.level && (gain.hp ?? 0) > 0 && (gain.ammo ?? 0) > 0, JSON.stringify(gain));
  assert.ok(hpOf(p) > 20, 'healed as well as levelled');
  assert.deepEqual(w.events.find((e) => e.e === 'airdrop'), { e: 'airdrop', k: 'taken', x: 1300, y: 1000, by: 'Opener', gold: false, level: true });
});
