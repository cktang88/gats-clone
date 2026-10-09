/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GUNS, type GunId } from '../src/shared/defs.ts';
import { setInput, step } from '../src/shared/sim.ts';
import { effectiveStats } from '../src/shared/sim/stats.ts';
import { IDLE_INPUT, type Player, type World } from '../src/shared/sim/world.ts';
import { committed, dueAt, NO_FIRING, sendInput, serverGun, settle, stepTrigger, type Firing, type ServerGun, type TriggerInput } from '../src/client/fire.ts';
import { emptyWorld, equip, grantPerks, spawnAt, TICK_MS } from './helpers.ts';

const held = (shots: number, fire = true, reload = false): TriggerInput => ({ fire, shots, reload });
const ready = (gun: GunId, o: Partial<ServerGun> = {}): ServerGun =>
  ({ gun, mag: GUNS[gun].mag, reloadMs: GUNS[gun].reloadMs, ammo: GUNS[gun].mag, reloading: false, reloadFrac: 0, alive: true, armed: true, ...o });
const armedWith = (gun: GunId, o: Partial<ServerGun> = {}): Firing => settle(NO_FIRING, ready(gun, o), 0, 0, []).firing;

function play(f: Firing, inputs: readonly TriggerInput[]): { firing: Firing; drawn: number[]; rejected: number[] } {
  const drawn: number[] = [], rejected: number[] = [];
  for (const input of inputs) {
    const seq = f.sent.seq + 1;
    if (dueAt(f, input) !== null) {
      f = { ...f, ahead: { seq, rounds: [-seq] } };
      drawn.push(seq);
    }
    const sent = sendInput(f, seq, committed(f, input), seq * TICK_MS);
    f = sent.firing;
    if (sent.rejected) rejected.push(sent.rejected.seq);
  }
  return { firing: f, drawn, rejected };
}

function simAndPageFires(gun: GunId, inputs: readonly TriggerInput[], setup?: (w: World, p: Player) => void): { sim: number[]; page: number[] } {
  const w = emptyWorld();
  // The page predicts its own player, a person (a bot's gun runs by the same rules, see bot-bloom.test.ts).
  const p = spawnAt(w, 500, 500, { loadout: { weapon: GUNS[gun].base }, kind: 'human' });
  setup?.(w, p);
  equip(p, gun);
  const sim: number[] = [], page: number[] = [];
  const { mag, reloadMs } = effectiveStats(p);
  let t = armedWith(gun, { mag, reloadMs, ammo: mag, armed: w.match.k === 'playing' }).trigger;
  inputs.forEach((input, i) => {
    setInput(w, p.id, i + 1, { ...IDLE_INPUT, ...input });
    step(w, TICK_MS);
    if (w.events.some((e) => e.e === 'shot' && e.owner === p.id)) sim.push(i + 1);
    const pulled = stepTrigger(t, input, w.now);
    t = pulled.t;
    if (pulled.fired) page.push(i + 1);
    if (p.life.k === 'alive') assert.deepEqual([t.spray, t.spin], [p.life.spray, p.life.spin], `bloom and spin-up after input ${i + 1}`);
  });
  return { sim, page };
}

const taps = (pattern: string, pressedBefore = 0): TriggerInput[] => {
  let shots = pressedBefore, fire = false;
  return [...pattern].map((c) => {
    if (c === 'P') { shots++; fire = true; } else if (c === 'h') fire = true; else if (c === '.') fire = false;
    return { fire, shots, reload: c === 'R' };
  });
};

const SCRIPTS: [string, GunId, string][] = [
  ['spaced pistol taps', 'pistol', 'P.......P.......P.......P'],
  ['pistol taps inside the cooldown are held for it', 'pistol', 'P..P.P..P..P....'],
  ['pistol spammed through an empty magazine and a reload', 'pistol', 'P.P.P.P.P.P.P.P.P.P.P.P.P.P.P.P.P.P.P.P.P.P.P.P.P.P.P.P.P.P.P.P.P.P.P.P.P.P.P.P.P.P.P.P.P.P.P.P.P.P.P.P.P.P.P.P.P.P.P.P.P.P.P.P.'],
  ['a press during a reload fires as it ends', 'pistol', 'P........R......P.....................................'],
  ['machine pistol bursts', 'machinePistol', 'P..........................P..P.................'],
  ['SMG held, released and held again', 'smg', 'Phhhhhhhhhhhhhhhhhhhhhhhh.....Phhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh....'],
  ['hornet held fires every tick', 'hornet', 'Phhhhhhhhhhhhhhhhhhh.'],
  ['akimbo bursts', 'akimbo', 'P.........P.......................P'],
  ['assault held, released and held again', 'assault', 'P' + 'h'.repeat(40) + '...' + 'P' + 'h'.repeat(60) + '..P.P..'],
  ['battle rifle held through bursts', 'battleRifle', 'P' + 'h'.repeat(60) + '.'],
  ['minigun held, released and held again', 'minigun', 'P' + 'h'.repeat(80) + '.'.repeat(12) + 'P' + 'h'.repeat(40) + '.'],
  ['shotgun with an early reload', 'shotgun', 'P.....................P..R.........................................................P'],
];

for (const [name, gun, pattern] of SCRIPTS) {
  test(`the page's trigger fires on the same inputs as the sim's: ${name}`, () => {
    const { sim, page } = simAndPageFires(gun, taps(pattern));
    assert.ok(sim.length > 0);
    assert.deepEqual(page, sim);
  });

  test(`every shot the page draws ahead goes out on an input that fires it: ${name}`, () => {
    const { drawn, rejected } = play(armedWith(gun), taps(pattern));
    assert.ok(drawn.length > 0);
    assert.deepEqual(rejected, []);
  });
}

test('the page reloads to the sim\'s perk-extended magazine, not the gun\'s', () => {
  const { sim, page } = simAndPageFires('pistol', taps('P.'.repeat(150)), (w, p) => grantPerks(w, p, ['extended']));
  assert.ok(sim.length > GUNS.pistol.mag * 1.5, 'spans a reload of the extended magazine');
  assert.deepEqual(page, sim);
});

test('the page reloads at the sim\'s Quick reload pace, not the gun\'s', () => {
  const { sim, page } = simAndPageFires('shotgun', taps(('P' + '.'.repeat(23)).repeat(30)), (w, p) => grantPerks(w, p, ['quickReload']));
  assert.ok(sim.length > GUNS.shotgun.mag * 2, 'spans reloads');
  assert.deepEqual(page, sim);
});

test('neither the page nor the sim fires once the round is over', () => {
  const { sim, page } = simAndPageFires('smg', taps('Phhhhhhhhh.P.P'), (w) => { w.match = { k: 'over', winner: { name: 'x', id: null, note: null }, restartAt: Infinity }; });
  assert.deepEqual(sim, []);
  assert.deepEqual(page, []);
});

test('held auto fire keeps the gun\'s rate on average, not the tick\'s', () => {
  const inputs = taps('P' + 'h'.repeat(GUNS.smg.mag * 3));
  const { drawn } = play(armedWith('smg'), inputs);
  const shots = drawn.slice(0, GUNS.smg.mag);
  assert.equal(shots.length, GUNS.smg.mag);
  const meanMs = ((shots.at(-1)! - shots[0]!) * TICK_MS) / (shots.length - 1);
  assert.ok(Math.abs(meanMs - GUNS.smg.fireMs) < 2, `mean gap ${meanMs}ms`);
});

test('a held shot is due when the gun is ready, between inputs, and a fresh press on a ready gun is due at once', () => {
  let f = armedWith('assault');
  assert.equal(dueAt(f, held(1)), f.sent.at, 'the press fires the moment it lands');
  f = play(f, [held(1), held(1), held(1), held(1)]).firing;
  assert.equal(dueAt(f, held(1)), TICK_MS + GUNS.assault.fireMs, 'due 110ms after the first shot, part way between inputs 4 and 5');
});

test('a server shot event confirms the oldest drawn shot instead of drawing another', () => {
  const { firing } = play(armedWith('pistol'), [held(1, false)]);
  assert.deepEqual(firing.unconfirmed.map((p) => p.seq), [1]);
  const s = settle(firing, ready('pistol', { ammo: GUNS.pistol.mag - 1 }), 1, 1, []);
  assert.equal(s.unmatched, 0);
  assert.deepEqual(s.rejected, []);
  assert.deepEqual(s.firing.unconfirmed, []);
});

test('a server shot nobody drew is unmatched, so the page draws it late', () => {
  const s = settle(armedWith('pistol'), ready('pistol', { ammo: GUNS.pistol.mag - 1 }), 3, 1, []);
  assert.equal(s.unmatched, 1);
});

test('a drawn shot the server never fires is taken back once the server is well past its input, not before', () => {
  let f = play(armedWith('pistol'), [held(1, false), held(1, false)]).firing;
  const waiting = settle(f, ready('pistol'), 3, 0, []);
  assert.deepEqual(waiting.rejected, [], 'still in time for a late server tick');
  f = waiting.firing;
  const gone = settle(f, ready('pistol'), 5, 0, []);
  assert.deepEqual(gone.rejected.map((p) => p.seq), [1]);
  assert.deepEqual(gone.firing.unconfirmed, []);
});

test('a shot drawn ahead of an input the trigger then refuses is taken back as that input goes out', () => {
  let f = armedWith('pistol');
  f = { ...f, ahead: { seq: 1, rounds: [-1] } };
  f = settle(f, ready('pistol', { ammo: 0, reloading: true, reloadFrac: 0.1 }), 0, 0, []).firing;
  const sent = sendInput(f, 1, held(1, false), TICK_MS);
  assert.deepEqual(sent.rejected?.rounds, [-1]);
});

test('no shot is drawn while reloading, with an empty magazine, dead, or after the round is won', () => {
  for (const [why, sv] of [
    ['reloading', { reloading: true, reloadFrac: 0.2 }],
    ['empty', { ammo: 0 }],
    ['dead', { alive: false }],
    ['round over', { armed: false }],
  ] as const) {
    const f = settle(armedWith('pistol'), ready('pistol', sv), 0, 0, []).firing;
    assert.equal(dueAt(f, held(1)), null, why);
    assert.deepEqual(play(f, [held(1), held(2), held(3)]).drawn, [], why);
  }
});

test('the trigger rebuilds from the server\'s ammo on the acknowledged input, then replays the inputs since', () => {
  let f = play(armedWith('pistol'), taps('P.......P.......')).firing;
  f = settle(f, ready('pistol', { ammo: 1 }), 16, 2, []).firing;
  const { drawn } = play(f, taps('........P.......P.......P', 2));
  assert.deepEqual(drawn, [25], 'only the one round the server says is left fires, then the reload');
  f = play(armedWith('pistol'), taps('P')).firing;
  const pending = [{ seq: 2, input: held(2, false) }];
  f = settle(f, ready('pistol', { ammo: 1 }), 1, 1, pending).firing;
  assert.equal(f.trigger.ammo, 1, 'the press on input 2 waits out the cooldown, so the round stays');
});

test('a shot the server has not fired yet still counts against the ammo it reports', () => {
  let f = play(armedWith('pistol', { ammo: 2 }), taps('P')).firing;
  f = settle(f, ready('pistol', { ammo: 2 }), 1, 0, []).firing;
  assert.equal(f.trigger.ammo, 1);
});

test('a respawn hands back a ready gun, and an evolved gun fires by its own rules', () => {
  let f = settle(armedWith('pistol'), ready('pistol', { alive: false }), 1, 0, []).firing;
  f = settle(f, ready('machinePistol'), 2, 0, []).firing;
  const { drawn } = play(f, taps('P.......'));
  assert.deepEqual(drawn, [1, 3, 5], 'a three-round burst 60ms apart');
});

test('releasing the trigger after a shot keeps it held for the input the server may still fire it on, but never into a new shot', () => {
  let f = play(armedWith('assault'), taps('P')).firing;
  assert.deepEqual(f.unconfirmed.map((p) => p.seq), [1]);
  const released = held(1, false);
  assert.equal(committed(f, released).fire, true, 'input 2 is held while shot 1 is owed');
  f = play(f, [released]).firing;
  assert.equal(committed(f, released).fire, false, 'a server firing in step with the page has had its input');
  assert.equal(committed({ ...f, lag: 1 }, released).fire, true, 'a server trailing by one input gets one more');
  assert.equal(committed({ ...f, unconfirmed: [] }, released).fire, false, 'nothing owed, so the release goes through');
  f = play(armedWith('hornet'), taps('P')).firing;
  assert.equal(committed(f, released).fire, false, 'holding a hornet one more input would fire a new shot');
});

test('a gun swap resets the spray, burst and spin-up the old gun had built; the same gun keeps them', () => {
  const f = play(armedWith('assault'), taps('P' + 'h'.repeat(8))).firing;
  const same = settle(f, ready('assault', { ammo: GUNS.assault.mag - 5 }), 6, 0, []).firing.trigger;
  assert.ok(same.spray > 0, `six held inputs of assault fire built spray (${same.spray})`);
  const swapped = settle(f, ready('smg'), 6, 0, []).firing.trigger;
  assert.deepEqual([swapped.gun, swapped.spray, swapped.burstLeft, swapped.spin], ['smg', 0, 0, 0]);
});

test('a reload the server is part way through ends when the server\'s will, not a whole reload later', () => {
  const f = settle(NO_FIRING, ready('pistol', { ammo: 0, reloading: true, reloadFrac: 0.25 }), 10, 0, []).firing;
  assert.ok(Math.abs(f.trigger.reloadUntil! - (10 * TICK_MS + 0.75 * GUNS.pistol.reloadMs)) < 1e-9);
  const done = settle(f, ready('pistol', { ammo: GUNS.pistol.mag }), 12, 0, []).firing;
  assert.equal(done.trigger.reloadUntil, null, 'and the server saying it is over ends it');
});

test('a confirmation the server sent many inputs late holds the trigger at most a few inputs, never longer', () => {
  const f = play(armedWith('pistol'), [held(1, false)]).firing;
  assert.equal(settle(f, ready('pistol'), 2, 1, []).firing.lag, 1);
  assert.equal(settle(f, ready('pistol'), 40, 1, []).firing.lag, 3, 'capped below the slack after which a shot is taken back');
});

test('the server\'s word on your gun: armed only while the round is undecided, alive only while you are on the field', () => {
  const snapOf = (o: { winner?: unknown; inPlayers?: boolean; alive?: boolean } = {}) => ({
    self: { id: 1, ammo: 7, mag: 12, reloading: false, reloadFrac: 0, alive: o.alive ?? true, perks: {} },
    players: o.inPlayers === false ? [] : [{ id: 1, gun: 'shotgun' }],
    match: { winner: o.winner ?? null },
  }) as never;
  const sv = serverGun(snapOf());
  assert.deepEqual([sv.gun, sv.ammo, sv.mag, sv.alive, sv.armed, sv.reloadMs], ['shotgun', 7, 12, true, true, GUNS.shotgun.reloadMs]);
  assert.equal(serverGun(snapOf({ winner: { name: 'x', id: 2, note: null } })).armed, false);
  assert.equal(serverGun(snapOf({ inPlayers: false })).alive, false, 'dropped from the players: nothing to fire');
  assert.equal(serverGun(snapOf({ alive: false })).alive, false);
});

test('a reload pressed while a drawn shot is owed waits so the server fires that shot first', () => {
  const f = { ...armedWith('pistol', { ammo: 5 }), ahead: { seq: 1, rounds: [-1] } };
  assert.equal(committed(f, held(1, false, true)).reload, false);
  assert.equal(stepTrigger(f.trigger, held(1, false, true), TICK_MS).fired, false, 'the reload would have beaten the shot');
});
