import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { ARMOR_IDS, BARREL, GUN_IDS, GUNS, PERK_TIERS } from '../src/shared/defs.ts';
import { MAPS } from '../src/shared/maps.ts';
import { parseClientMsg, STICKY_KEYS, type ServerMsg, type Snapshot } from '../src/shared/protocol.ts';
import { RANGE, TARGETS, targetPos } from '../src/shared/range.ts';
import { ABILITIES } from '../src/shared/sim/abilities.ts';
import { explode } from '../src/shared/sim/combat.ts';
import { damageBarrel } from '../src/shared/sim/barrels.ts';
import { snapshotFor } from '../src/shared/sim/snapshot.ts';
import { effectiveStats } from '../src/shared/sim/stats.ts';
import { damageTarget, rangeView, resetRange, setRangeLoadout, targetHits, targetViews, tickRange } from '../src/shared/sim/targets.ts';
import { createWorld, type World } from '../src/shared/sim/world.ts';
import { createRoom } from '../src/server/room.ts';
import { startServer } from '../src/server/main.ts';
import type { Accounts } from '../src/server/accounts.ts';
import type { Profiles } from '../src/server/profiles.ts';
import { emptyWorld, fakeSocket, hpOf, PISTOL, press, run, shootOnce, spawnAt, TICK_MS } from './helpers.ts';

const layout = MAPS.range.range!;
const rangeWorld = (): World => emptyWorld('RNG');
const targetOf = (w: World, kind: 'paper' | 'plank' | 'rail' | 'dummy') => w.range!.targets.find((t) => t.def.kind === kind && !t.def.rail === (kind !== 'rail'))!;
/** A shooter standing `back` px west of `t`, level with it, so a shot along angle 0 meets it first (the layout staggers its targets off one another's line). */
const shooterFor = (w: World, t: { x: number; y: number }, back = 200, loadout = {}) => spawnAt(w, t.x - back, t.y, { loadout });

test('a Range world stands every target of the layout whole, and no other mode has any', () => {
  const w = rangeWorld();
  assert.equal(w.range!.targets.length, layout.targets.length);
  assert.ok(['paper', 'plank', 'rail', 'dummy'].every((k) => layout.targets.some((t) => t.kind === k)), 'every kind stands somewhere');
  // A few targets, not a crowd: one standing at each painted distance, and a handful of extras.
  assert.ok(layout.targets.length >= layout.marks.length && layout.targets.length <= 12, `${layout.targets.length} targets`);
  for (const m of layout.marks) assert.equal(layout.targets.filter((t) => !t.rail && t.x === layout.line + m && t.y > layout.lanes[1]!.y0 && t.y < layout.lanes[1]!.y1).length, 1, `one target in the field at ${m} px`);
  assert.ok(w.range!.targets.every((t, i) => t.hp === TARGETS[t.def.kind].hp && t.id === RANGE.idBase + i));
  for (const mode of ['FFA', 'TDM', 'DOM', 'BR'] as const) assert.equal(createWorld(mode, 1, 'plaza').range, undefined, mode);
  assert.equal(createWorld('ZOM', 1, 'outpost').range, undefined);
  const ffa = emptyWorld('FFA');
  const me = spawnAt(ffa, 500, 500);
  const snap = snapshotFor(ffa, me.id);
  assert.ok(!('targets' in snap) && !('range' in snap), 'a versus snapshot carries nothing of the range');
  assert.ok(STICKY_KEYS.includes('targets'));
  const rng = createWorld('RNG', 1, 'range');
  assert.ok(rng.barrels.length >= 2 && rng.props.length >= 1, 'the range keeps a few barrels and props');
  assert.deepEqual(rng.airdrops.due, [], 'and has no supply planes');
});

test('a round takes health off a target through the normal damage path, with a damage event, and four pistol hits drop a paper target', () => {
  const w = rangeWorld();
  const t = targetOf(w, 'paper');
  const p = shooterFor(w, t);
  shootOnce(w, p, 0, 400);
  assert.equal(t.hp, 100 - GUNS.pistol.damage);
  assert.deepEqual(targetViews(w)[t.id - RANGE.idBase], 8, 'tenths of health on the wire');
  for (let i = 0; i < 6; i++) shootOnce(w, p, 0, 250);
  assert.equal(t.respawnAt === null, false, 'it is down');
  assert.equal(targetViews(w)[t.id - RANGE.idBase], 0);
  assert.equal(p.kills, 0, 'a target is not a kill: no score, no medal, no level');
  assert.equal(p.level, 0);
});

test('events: a hit is a dmg event of kind target for the shooter, and a fall and a standing up are target events', () => {
  const w = rangeWorld();
  const t = targetOf(w, 'paper');
  const p = shooterFor(w, t);
  const seen: string[] = [];
  const watch = () => { for (const e of w.events) { if (e.e === 'dmg' && e.kind === 'target' && e.attacker === p.id && e.victim === t.id) seen.push(`dmg ${e.amount}`); if (e.e === 'target') seen.push(`${e.k} ${e.i} by ${e.by}`); } };
  press(w, p, { angle: 0, fire: true, shots: 1 });
  for (let i = 0; i < 12; i++) { run(w, TICK_MS); watch(); }
  press(w, p, { angle: 0, fire: false });
  damageTarget(w, t, 1000, { attacker: p, label: 'test' });
  watch();
  assert.ok(seen.some((s) => s.startsWith('dmg 25')), seen.join());
  assert.ok(seen.includes(`down ${t.id - RANGE.idBase} by ${p.id}`), seen.join());
  for (let ms = 0; ms < RANGE.regenMs + 200; ms += TICK_MS) { step1(w); watch(); }
  assert.ok(seen.includes(`up ${t.id - RANGE.idBase} by null`));
});

const step1 = (w: World) => run(w, TICK_MS);

test('a knocked-down target stands again after the regen time, whole, and not before', () => {
  const w = rangeWorld();
  const t = targetOf(w, 'plank');
  const p = spawnAt(w, 100, 100);
  damageTarget(w, t, 10_000, { attacker: p, label: 'test' });
  assert.notEqual(t.respawnAt, null);
  run(w, RANGE.regenMs - 300);
  assert.notEqual(t.respawnAt, null, 'still down');
  assert.equal(targetViews(w)[t.id - RANGE.idBase], 0);
  run(w, 600);
  assert.equal(t.respawnAt, null, 'up');
  assert.equal(t.hp, TARGETS.plank.hp);
  assert.equal(targetViews(w)[t.id - RANGE.idBase], 10);
});

test('a target that is hurt and left alone heals back to full', () => {
  const w = rangeWorld();
  const t = targetOf(w, 'dummy');
  const p = spawnAt(w, 100, 100);
  damageTarget(w, t, 100, { attacker: p, label: 'test' });
  assert.equal(t.hp, TARGETS.dummy.hp - 100);
  run(w, RANGE.healMs - 300);
  assert.ok(t.hp < t.maxHp);
  run(w, 700);
  assert.equal(t.hp, t.maxHp);
});

test('the readout: last hit, damage per second over three seconds, accuracy by trigger pull, time to kill and distance', () => {
  const w = rangeWorld();
  const t = targetOf(w, 'paper');
  const p = shooterFor(w, t, 250);
  assert.deepEqual(rangeView(w, p.id), { last: null, dps: 0, shots: 0, hits: 0, ttk: null, downs: 0, total: 0 });
  shootOnce(w, p, 0, 300);
  const first = rangeView(w, p.id);
  assert.equal(first.shots, 1);
  assert.equal(first.hits, 1);
  assert.equal(first.last?.dmg, 25);
  assert.ok(Math.abs(first.last!.dist - 250) <= 2, `distance ${first.last!.dist}`);
  assert.ok(Math.abs(first.dps - 25 / 3) < 0.2, `dps ${first.dps}`);
  shootOnce(w, p, Math.PI / 2, 300);
  assert.deepEqual([rangeView(w, p.id).shots, rangeView(w, p.id).hits], [2, 1], 'a miss is a shot and not a hit');
  for (let i = 0; i < 3; i++) shootOnce(w, p, 0, 250);
  const done = rangeView(w, p.id);
  assert.equal(done.downs, 1);
  assert.equal(done.ttk?.kind, 'paper');
  assert.ok(done.ttk!.ms > 0 && done.ttk!.ms < 2500, `ttk ${done.ttk!.ms}`);
  run(w, RANGE.dpsWindowMs + 100);
  assert.equal(rangeView(w, p.id).dps, 0, 'the window empties');
  resetRange(w, p.id);
  assert.deepEqual(rangeView(w, p.id), { last: null, dps: 0, shots: 0, hits: 0, ttk: null, downs: 0, total: 0 });
  assert.equal(t.respawnAt, null, 'reset stands the targets up');
});

test('a shotgun blast is one shot and one hit, however many pellets land', () => {
  const w = rangeWorld();
  const t = targetOf(w, 'paper');
  const p = shooterFor(w, t, 120, { weapon: 'shotgun' });
  shootOnce(w, p, 0, 600);
  const v = rangeView(w, p.id);
  assert.equal(v.shots, 1);
  assert.equal(v.hits, 1);
  assert.ok(t.hp < 100 - GUNS.shotgun.damage * 2 || t.respawnAt !== null, 'several pellets landed');
});

test('a blast hurts targets by distance and a wall shelters one', () => {
  const w = rangeWorld();
  const t = targetOf(w, 'paper');
  const p = spawnAt(w, 100, 100);
  explode(w, t.x - 100, t.y, 160, 80, { attacker: p, team: null, label: 'Grenade' });
  const near = 100 - t.hp;
  assert.ok(near > 0 && near < 80, `${near}`);
  const u = w.range!.targets.find((o) => o !== t && o.def.kind === 'paper' && o.def.y !== t.def.y && Math.hypot(o.x - t.x, o.y - t.y) > 400)!;
  w.walls = [{ x: u.x - 80, y: u.y - 200, w: 20, h: 400, built: false, material: 'concrete', expiresAt: Infinity }];
  explode(w, u.x - 120, u.y, 160, 80, { attacker: p, team: null, label: 'Grenade' });
  assert.equal(u.hp, 100, 'sheltered');
  assert.ok((rangeView(w, p.id).last?.dmg ?? 0) > 0, 'a blast counts as a hit in the readout');
});

test('the grenade ability, a knife lunge, a gas cloud and a land mine all hurt targets', () => {
  const w = rangeWorld();
  const t = targetOf(w, 'dummy');
  const p = spawnAt(w, t.x - 400, t.y, { loadout: PISTOL });
  p.angle = 0;
  p.input = { ...p.input, aimDist: 400 };
  ABILITIES.grenade(w, p);
  run(w, 1100);
  assert.ok(t.hp < t.maxHp, 'grenade');
  const before = t.hp;
  const q = spawnAt(w, t.x - 40, t.y);
  ABILITIES.knife(w, q);
  assert.ok(t.hp <= before - 49, `knife ${before - t.hp}`);
  const g = targetOf(w, 'plank');
  const r = spawnAt(w, g.x - 300, g.y);
  w.thrown.push({ id: 9001, kind: 'gasCloud', owner: r.id, team: null, x: g.x, y: g.y, bornAt: w.now, expiresAt: w.now + 3000 });
  run(w, 1000);
  assert.ok(g.hp < g.maxHp, 'gas');
  const m = targetOf(w, 'paper');
  const s = spawnAt(w, m.x - 300, m.y);
  w.thrown.push({ id: 9002, kind: 'landMine', owner: s.id, team: null, x: m.x - 10, y: m.y, armedAt: 0, expiresAt: w.now + 60000 });
  run(w, TICK_MS * 2);
  assert.ok(m.hp < m.maxHp, 'mine');
  assert.ok(!w.thrown.some((o) => o.id === 9002), 'the mine is spent');
});

test('a sliding target is judged where it stood when the shooter saw it', () => {
  const w = rangeWorld();
  const t = w.range!.targets.find((o) => o.def.rail)!;
  const a = targetPos(t.def, 0);
  const b = targetPos(t.def, 700);
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y) > 60, 'it moves');
  const bullet = { x: a.x - 300, y: a.y, damage: 10, label: 'x', passed: [] as number[] };
  const hitsAt = (at: number) => targetHits(w, bullet, 600, 0, null, at).some((h) => h.victim.id === t.id);
  assert.ok(hitsAt(0), 'where it was');
  assert.equal(hitsAt(700), false, 'not where it is now');
  for (let ms = 0; ms < 20_000; ms += 137) {
    const p = targetPos(t.def, ms);
    assert.ok(Math.abs(p.y - t.def.y) <= t.def.rail!.reach + 1e-6 && p.x === t.def.x);
  }
});

test('players are not hurt in the range, not even by their own blast', () => {
  const w = rangeWorld();
  const p = spawnAt(w, 600, 1100);
  const before = hpOf(p);
  explode(w, p.x, p.y, 200, 500, { attacker: p, team: null, label: 'Grenade' });
  assert.equal(hpOf(p), before);
  assert.equal(p.life.k, 'alive');
});

test('barrels and props go off like anywhere, then stand again within seconds', () => {
  const w = createWorld('RNG', 1, 'range');
  const p = spawnAt(w, 600, 1100);
  const b = w.barrels[0]!;
  damageBarrel(w, b, 1000, { attacker: p, team: null });
  run(w, BARREL.fuseMs + 100);
  assert.notEqual(b.respawnAt, null, 'it burst');
  run(w, RANGE.propRespawnMs + 400);
  assert.equal(b.respawnAt, null, 'and is back');
  assert.equal(b.hp, BARREL.hp);
  const q = w.props.find((o) => o.kind === 'oil')!;
  q.hp = 0;
  p.x = q.x - 500;
  const prop = w.props.find((o) => o !== q)!;
  prop.respawnAt = w.now + 90_000;
  run(w, RANGE.propRespawnMs + 400);
  assert.equal(prop.respawnAt, null, 'a long-lived prop is shortened to the range\'s time');
});

test('any gun, armor and perk can be put on at once: health, magazine and ability come back, no level is asked, and none is offered', () => {
  const w = rangeWorld();
  const p = spawnAt(w, 600, 1100);
  for (const gun of GUN_IDS) {
    assert.ok(setRangeLoadout(w, p, { gun }), gun);
    assert.equal(p.gun, gun);
    assert.equal(p.loadout.weapon, GUNS[gun].base);
    assert.equal(p.life.k === 'alive' && p.life.ammo, effectiveStats(p).mag);
  }
  for (const tier of [1, 2, 3] as const) {
    for (const perk of PERK_TIERS[tier]) {
      assert.ok(setRangeLoadout(w, p, { perks: { [tier]: perk } }), perk);
      assert.equal(p.perks[tier], perk);
    }
    assert.ok(setRangeLoadout(w, p, { perks: { [tier]: null } }));
    assert.equal(p.perks[tier], undefined, `tier ${tier} cleared`);
  }
  setRangeLoadout(w, p, { gun: 'minigun', armor: 'heavy', perks: { 1: 'grip', 2: 'thickSkin', 3: 'grenade' } });
  assert.deepEqual(p.perks, { 1: 'grip', 2: 'thickSkin', 3: 'grenade' });
  assert.equal(p.loadout.armor, 'heavy');
  setRangeLoadout(w, p, { perks: { 2: 'brace' } });
  assert.deepEqual(p.perks, { 1: 'grip', 2: 'brace', 3: 'grenade' }, 'a tier left out stays');
  if (p.life.k !== 'alive') throw new Error('alive');
  p.life.ammo = 0;
  p.life.hp = 1;
  p.abilityReadyAt = w.now + 99_999;
  setRangeLoadout(w, p, { gun: 'sniper' });
  assert.equal(p.life.ammo, GUNS.sniper.mag);
  assert.equal(p.life.hp, effectiveStats(p).maxHp);
  assert.equal(p.abilityReadyAt, 0);
  assert.equal(snapshotFor(w, p.id).self.pending, null, 'no pick prompt');
  assert.equal(snapshotFor(w, p.id).players.find((o) => o.id === p.id)!.hunted, false, 'a stage 2 gun is not hunted here');
  setRangeLoadout(w, p, { gun: 'executioner' });
  assert.equal(snapshotFor(w, p.id).players.find((o) => o.id === p.id)!.hunted, false);
  assert.equal(setRangeLoadout(w, p, { gun: 'nope' as never }), false);
  assert.equal(setRangeLoadout(w, p, { perks: { 1: 'shield' as never } }), false, 'a tier-2 perk in tier 1 is refused');
  assert.ok(ARMOR_IDS.every((armor) => setRangeLoadout(w, p, { armor })));
});

test('the loadout message parses only real guns, armors and perks in their own tiers', () => {
  const ok = (m: unknown) => parseClientMsg(JSON.stringify(m));
  assert.deepEqual(ok({ t: 'range', a: 'loadout', gun: 'railSlug', armor: 'light', perks: { 1: 'grip', 2: null, 3: 'knife' } }), { t: 'range', a: 'loadout', gun: 'railSlug', armor: 'light', perks: { 1: 'grip', 2: null, 3: 'knife' } });
  assert.deepEqual(ok({ t: 'range', a: 'reset' }), { t: 'range', a: 'reset' });
  assert.equal(ok({ t: 'range', a: 'loadout', gun: 'laserCannon' }), null);
  assert.equal(ok({ t: 'range', a: 'loadout', armor: 'plate' }), null);
  assert.equal(ok({ t: 'range', a: 'loadout', perks: { 1: 'knife' } }), null, 'a tier-3 ability is not a tier-1 perk');
  assert.equal(ok({ t: 'range', a: 'loadout', perks: 'all' }), null);
  assert.equal(ok({ t: 'range', a: 'explode' }), null);
});

const accounts = { stats: () => null, nameForToken: () => null, credit: () => { throw new Error('credited an account'); } } as unknown as Accounts;
const lastSnap = (sent: ServerMsg[]) => sent.filter((m): m is Snapshot => m.t === 'snap').at(-1)!;

test('only a Range room takes the loadout message; any other room says no and changes nothing', () => {
  for (const mode of ['FFA', 'TDM', 'ZOM'] as const) {
    const room = createRoom(`t-${mode}`, mode, 1, { ...accounts, credit: () => {} } as unknown as Accounts);
    const ws = fakeSocket();
    room.connect(ws.socket);
    ws.send({ t: 'join', name: 'Ann', loadout: PISTOL, aspect: 1.5 });
    const me = [...room.world.players.values()].find((p) => p.kind === 'human')!;
    ws.send({ t: 'range', a: 'loadout', gun: 'minigun', perks: { 3: 'grenade' } });
    assert.equal(me.gun, 'pistol', mode);
    assert.deepEqual(me.perks, {}, mode);
    assert.ok(ws.sent.some((m) => m.t === 'error' && /shooting range/.test(m.message)), mode);
    ws.close();
  }
  const room = createRoom('r-test', 'RNG', 1, accounts);
  const ws = fakeSocket();
  room.connect(ws.socket);
  ws.send({ t: 'join', name: 'Ann', loadout: PISTOL, aspect: 1.5 });
  const me = [...room.world.players.values()][0]!;
  ws.send({ t: 'range', a: 'loadout', gun: 'minigun', armor: 'heavy', perks: { 1: 'grip', 3: 'grenade' } });
  assert.equal(me.gun, 'minigun');
  assert.deepEqual(me.perks, { 1: 'grip', 3: 'grenade' });
  room.tick();
  const snap = lastSnap(ws.sent);
  assert.equal(snap.self.perks[3], 'grenade');
  assert.equal(snap.players.find((p) => p.id === me.id)!.gun, 'minigun');
  assert.equal(snap.targets?.length, layout.targets.length);
  assert.ok(snap.range);
  ws.send({ t: 'range', a: 'loadout', gun: 'bogus' } as never);
  assert.ok(ws.sent.some((m) => m.t === 'error' && m.message === 'Bad message'));
  assert.equal(me.gun, 'minigun');
  ws.close();
});

test('a range room is one player\'s own, with no bots, and writes no account, profile, XP or medal', (t) => {
  const calls: string[] = [];
  const spy = new Proxy({ get: () => null, featured: () => null, cos: () => null, flush: async () => {} } as unknown as Profiles, {
    get: (target, key: string) => (key in target ? (target as never)[key] : (...args: unknown[]) => { calls.push(key); return key === 'record' ? [] : null; }),
  });
  // Signed in, so a join anywhere else would credit the account a game (and `credit` here throws).
  const signedIn = { ...accounts, nameForToken: (token: string) => (token === 'ann-token' ? 'Ann' : null) } as unknown as Accounts;
  const room = createRoom('r-spy', 'RNG', 1, signedIn, 1, undefined, undefined, spy);
  const a = fakeSocket();
  // A socket left open keeps the room's timers, and with them the test process, alive: close it even when an assertion fails.
  t.after(() => a.close());
  room.connect(a.socket);
  a.send({ t: 'join', name: 'Ann', loadout: PISTOL, aspect: 1.5, token: 'ann-token', cosmetics: { helmet: 'x' } } as never);
  assert.ok(a.sent.some((m) => m.t === 'welcome' && m.account === 'Ann'), 'joined as the account');
  assert.equal(room.world.players.size, 1, 'no bots');
  const b = fakeSocket();
  room.connect(b.socket);
  b.send({ t: 'join', name: 'Bo', loadout: PISTOL, aspect: 1.5 });
  assert.ok(b.sent.some((m) => m.t === 'error' && /full/i.test(m.message)), 'a second player is turned away');
  b.close();
  const me = [...room.world.players.values()][0]!;
  for (let i = 0; i < 30; i++) {
    a.send({ t: 'input', seq: i + 1, input: { up: false, down: false, left: false, right: i % 2 === 0, angle: 0, fire: true, shots: i, reload: false, ability: false, aimDist: 300, use: false }, viewAt: null });
    room.tick();
  }
  a.close();
  room.tick();
  assert.deepEqual(calls, [], 'no profile call of any kind');
  assert.ok(me.score === 0 && me.kills === 0 && me.level === 0);
});

test('the range is deterministic: the same inputs give byte-identical snapshots', () => {
  const play = () => {
    const w = createWorld('RNG', 5, 'range');
    const p = spawnAt(w, 380, 1250, { loadout: { weapon: 'smg' } });
    setRangeLoadout(w, p, { gun: 'hailstorm', perks: { 3: 'fragGrenade' } });
    const out: string[] = [];
    for (let i = 0; i < 400; i++) {
      press(w, p, { angle: Math.sin(i / 40) * 0.5, fire: i % 90 < 50, shots: p.input.shots + (i % 7 === 0 ? 1 : 0), ability: i % 111 === 0, reload: i % 163 === 0, right: i % 120 < 20 });
      run(w, TICK_MS);
      // The helper's input counter is shared across tests, so what the server acknowledges differs between two plays.
      if (i % 5 === 0) out.push(JSON.stringify({ ...snapshotFor(w, p.id), ackSeq: 0 }));
    }
    return out.join('\n');
  };
  assert.equal(play(), play());
});

// The polls below give a loaded machine room to be slow; each stops as soon as its condition holds.
test('the server opens a private range on request, keeps it off the server list, and closes it once it has sat empty', async () => {
  const dataDir = await mkdtemp(joinPath(tmpdir(), 'skirmish-range-'));
  const server = await startServer({ port: 0, dataDir, limits: { rangeRooms: 2, rangeIdleMs: 600, squadsPerMin: 3 } });
  try {
    const base = `http://localhost:${server.port}`;
    const res = await fetch(`${base}/api/range`, { method: 'POST' });
    assert.equal(res.status, 200);
    const { room } = (await res.json()) as { room: string };
    assert.match(room, /^r-[a-z2-7]{6}$/);
    assert.equal(server.rooms.get(room)!.world.mode, 'RNG');
    assert.equal(server.rooms.get(room)!.world.players.size, 0, 'no bots');
    const listed = (await (await fetch(`${base}/api/servers`)).json()) as { id: string }[];
    assert.deepEqual(listed.map((s) => s.id), ['ffa', 'tdm', 'dom', 'br']);
    const two = await fetch(`${base}/api/range`, { method: 'POST' });
    assert.equal(two.status, 200);
    assert.equal((await fetch(`${base}/api/range`, { method: 'POST' })).status, 503, 'the cap holds');

    const ws = new WebSocket(`ws://localhost:${server.port}/ws?room=${room}`);
    const msgs: ServerMsg[] = [];
    ws.on('message', (d) => msgs.push(JSON.parse(d.toString()) as ServerMsg));
    await new Promise((ok, fail) => { ws.once('open', ok); ws.once('error', fail); });
    ws.send(JSON.stringify({ t: 'join', name: 'Ann', loadout: PISTOL, aspect: 1.6 }));
    for (let i = 0; i < 1000 && !msgs.some((m) => m.t === 'welcome'); i++) await new Promise((ok) => setTimeout(ok, 10));
    const welcome = msgs.find((m) => m.t === 'welcome');
    assert.equal(welcome?.t === 'welcome' && welcome.mode, 'RNG');
    assert.equal(welcome?.t === 'welcome' && welcome.worldSize, MAPS.range.size);
    ws.send(JSON.stringify({ t: 'range', a: 'loadout', gun: 'sniper', perks: { 1: 'thermal' } }));
    for (let i = 0; i < 1000 && !msgs.some((m) => m.t === 'snap' && (m as Snapshot).self?.perks?.[1] === 'thermal'); i++) await new Promise((ok) => setTimeout(ok, 20));
    assert.ok(msgs.some((m) => m.t === 'snap' && (m as Snapshot).self?.perks?.[1] === 'thermal'), 'the loadout arrived over the socket');
    await new Promise((ok) => { ws.once('close', ok); ws.close(); });
    for (let i = 0; i < 400 && server.rooms.has(room); i++) await new Promise((ok) => setTimeout(ok, 50));
    assert.equal(server.rooms.has(room), false, 'an empty range closes');
  } finally {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('every target in the layout can be shot from the firing line by some gun that reaches it, sliders included', () => {
  const reach = Math.max(...GUN_IDS.map((g) => GUNS[g].range));
  const longest = GUN_IDS.find((g) => GUNS[g].range === reach)!;
  layout.targets.forEach((d, i) => {
    let hit = false;
    // Stand on the line level with the target, and for a slider try a few moments along its run, aiming where it will be when the round lands.
    for (let attempt = 0; attempt < 6 && !hit; attempt++) {
      const w = rangeWorld();
      const t = w.range!.targets[i]!;
      const p = spawnAt(w, layout.line - 10, d.y);
      assert.ok(setRangeLoadout(w, p, { gun: longest }));
      run(w, 600 + attempt * 170);
      const dist = Math.hypot(d.x - p.x, targetPos(d, w.now).y - p.y);
      const at = targetPos(d, w.now + TICK_MS + (dist / GUNS[longest].bulletSpeed) * 1000);
      shootOnce(w, p, Math.atan2(at.y - p.y, at.x - p.x), 1500);
      hit = t.hp < TARGETS[d.kind].hp || t.respawnAt !== null;
    }
    assert.ok(hit, `target ${i} (${d.kind} at ${d.x},${d.y}, ${d.x - layout.line} px out) can't be hit from the firing line with the ${longest} (reach ${reach})`);
  });
});

test('the field is staggered: from the firing line beside the pad, no target stands in front of another', () => {
  const field = layout.targets.filter((d) => !d.rail && d.y > layout.lanes[1]!.y0 && d.y < layout.lanes[1]!.y1);
  const near = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
    const dx = bx - ax, dy = by - ay, k = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(px - ax - dx * k, py - ay - dy * k);
  };
  // Anywhere on the line from 300 px north of the pad to 200 px south of it.
  const pad = layout.pad.y + layout.pad.h / 2;
  for (let y = pad - 300; y <= pad + 200; y += 10) {
    for (const a of field) for (const b of field) {
      if (a === b || Math.hypot(b.x - layout.line, b.y - y) >= Math.hypot(a.x - layout.line, a.y - y)) continue;
      assert.ok(near(b.x, b.y, layout.line, y, a.x, a.y) > TARGETS[b.kind].r + 4, `from (${layout.line}, ${y}) the target ${b.x - layout.line} px out hides the one ${a.x - layout.line} px out`);
    }
  }
});
