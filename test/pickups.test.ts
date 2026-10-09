/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HP_MULTIPLIER, PROP_FX, PROP_KINDS, PROPS, WORLD, type PropKind } from '../src/shared/defs.ts';
import type { GameEvent, PropView } from '../src/shared/protocol.ts';
import { setInput, step } from '../src/shared/sim.ts';
import { damageProp } from '../src/shared/sim/props.ts';
import { snapshotFor } from '../src/shared/sim/snapshot.ts';
import { effectiveStats } from '../src/shared/sim/stats.ts';
import type { Player, Prop, World } from '../src/shared/sim/world.ts';
import { botThink, newBotMemory, type BotMemory } from '../src/server/bots.ts';
import { arenaFor } from '../src/server/bot/arena.ts';
import { actionForKey, CONTROLS } from '../src/client/input.ts';
import { addGain, chipLabel, drawGainRows, GAIN, GAIN_LIFE_MS, gainsOf, nearCabinet, rowAlpha, rowLift, sweepGains, type GainRow } from '../src/client/pickups.ts';
import { emptyWorld, hpOf, press, spawnAt, TICK_MS } from './helpers.ts';

function propAt(w: World, kind: PropKind, x: number, y: number): Prop {
  const q: Prop = { id: w.nextId++, kind, x, y, hp: PROPS[kind].hp, phase: 'stand', at: 0, respawnAt: null, vx: 0, vy: 0, by: null, home: { x, y } };
  w.props.push(q);
  w.wallsVersion++;
  return q;
}
/** A cabinet already broken open: its pack lies on the floor. */
function packAt(w: World, kind: 'medic' | 'ammo', x: number, y: number, by: Player): Prop {
  const q = propAt(w, kind, x, y);
  damageProp(w, q, 1000, { attacker: by, team: by.team }, { x: 1, y: 0 });
  return q;
}
function runEvents(w: World, ms: number): GameEvent[] {
  const out: GameEvent[] = [];
  for (let t = 0; t < ms; t += TICK_MS) { step(w, TICK_MS); out.push(...w.events); }
  return out;
}
const gains = (events: readonly GameEvent[], id: number) => events.filter((e): e is Extract<GameEvent, { e: 'gain' }> => e.e === 'gain' && e.id === id);
const hurt = (p: Player, hp: number) => { if (p.life.k === 'alive') { p.life.hp = hp; p.life.lastDamageAt = Infinity; } };
const noRegen = (p: Player) => { if (p.life.k === 'alive') p.life.lastDamageAt = 1e12; };

// ---- auto pickup: walking over a pack

test('a pack is taken by walking over it, with no key, and says what it gave to that player alone', () => {
  const w = emptyWorld();
  const me = spawnAt(w, 600, 1000), other = spawnAt(w, 1400, 1000, { loadout: { color: 'blue' } });
  const pack = packAt(w, 'medic', 1000, 1000, other);
  hurt(me, 30); noRegen(me);
  // Walking east over it: the body (radius 24) brushing the pack is enough.
  press(w, me, { right: true });
  const events: GameEvent[] = [];
  for (let t = 0; t < 3000 && pack.respawnAt === null; t += TICK_MS) {
    step(w, TICK_MS);
    events.push(...w.events);
    if (pack.respawnAt !== null) assert.ok(me.x <= 1000 - PROP_FX.medic.pickR + 20, 'taken as the body reaches it, not on its centre');
    for (const e of w.events) if (e.e === 'gain') {
      assert.ok(snapshotFor(w, me.id).events.includes(e), 'my snapshot carries my gain');
      assert.ok(!snapshotFor(w, other.id).events.includes(e), 'nobody else hears of it');
    }
  }
  assert.ok(pack.respawnAt !== null, 'taken');
  assert.equal(hpOf(me), 30 + PROP_FX.medic.heal);
  assert.deepEqual(gains(events, me.id).map(({ from, hp }) => ({ from, hp })), [{ from: 'medic', hp: PROP_FX.medic.heal }]);
});

test('a pack out of reach stays, and one standing on the next tile over is not taken', () => {
  const w = emptyWorld();
  const by = spawnAt(w, 3000, 3000);
  const me = spawnAt(w, 1000 + PROP_FX.medic.pickR + 6, 1000);
  hurt(me, 30); noRegen(me);
  const pack = packAt(w, 'medic', 1000, 1000, by);
  const events = runEvents(w, 1500);
  assert.equal(pack.respawnAt, null, 'still on the floor');
  assert.equal(hpOf(me), 30);
  assert.equal(gains(events, me.id).length, 0);
});

test('a pack that would be wasted is left for whoever needs it: full health, or a full magazine with the ability ready', () => {
  const w = emptyWorld();
  const me = spawnAt(w, 1000, 1000);
  const med = packAt(w, 'medic', 1000, 1000, me);
  const ammo = packAt(w, 'ammo', 1000, 1010, me);
  const events = runEvents(w, 600);
  assert.equal(med.respawnAt, null);
  assert.equal(ammo.respawnAt, null);
  assert.equal(gains(events, me.id).length, 0, 'nothing taken, nothing shown');
  // Partly hurt: the pack heals what is missing, and the popup counts only that.
  const max = effectiveStats(me).maxHp;
  hurt(me, max - 12); noRegen(me);
  const later = runEvents(w, 200);
  assert.ok(med.respawnAt !== null);
  assert.equal(hpOf(me), max);
  assert.deepEqual(gains(later, me.id).map((g) => g.hp), [12]);
});

test('an ammo pack counts the rounds it put back and says when it brought the ability back', () => {
  const w = emptyWorld();
  const me = spawnAt(w, 1000, 1000);
  me.perks = { ...me.perks, 3: 'grenade' };
  const mag = effectiveStats(me).mag;
  if (me.life.k === 'alive') me.life.ammo = 2;
  me.abilityReadyAt = w.now + 9000;
  packAt(w, 'ammo', 1000, 1000, me);
  const events = runEvents(w, 100);
  assert.deepEqual(gains(events, me.id).map(({ ammo, ability }) => ({ ammo, ability })), [{ ammo: mag - 2, ability: true }]);
  // A full magazine, only the ability cooling: it is still worth taking, and the popup says READY with no rounds.
  const w2 = emptyWorld();
  const you = spawnAt(w2, 1000, 1000);
  you.perks = { ...you.perks, 3: 'grenade' };
  you.abilityReadyAt = w2.now + 9000;
  packAt(w2, 'ammo', 1000, 1000, you);
  const g = gains(runEvents(w2, 100), you.id);
  assert.equal(g.length, 1);
  assert.equal(g[0]!.ammo, undefined);
  assert.equal(g[0]!.ability, true);
});

test('a person\'s health pack heals in their own scale: twice a bot\'s, as their health counts twice', () => {
  const w = emptyWorld();
  const by = spawnAt(w, 3000, 3000);
  const me = spawnAt(w, 1000, 1000, { kind: 'human' });
  const max = effectiveStats(me).maxHp;
  assert.equal(max, 2 * effectiveStats(by).maxHp);
  hurt(me, 40); noRegen(me);
  packAt(w, 'medic', 1000, 1000, by);
  const g = gains(runEvents(w, 100), me.id);
  assert.equal(hpOf(me), 40 + PROP_FX.medic.heal * HP_MULTIPLIER.human);
  assert.deepEqual(g.map((x) => x.hp), [PROP_FX.medic.heal * HP_MULTIPLIER.human], 'the popup reads the same number the health counter gains');
});

// ---- E: a standing cabinet

test('E beside a standing cabinet opens it and hands over what it holds at once; standing there without E does nothing', () => {
  const w = emptyWorld();
  const cab = propAt(w, 'medic', 1000, 1000);
  const me = spawnAt(w, 1000 - PROPS.medic.size / 2 - WORLD.playerRadius - 2, 1000);
  hurt(me, 40); noRegen(me);
  runEvents(w, 1000);
  assert.equal(cab.phase, 'stand', 'a cabinet is not opened by walking up to it');
  press(w, me, { use: true });
  const events = runEvents(w, TICK_MS * 2);
  assert.ok(cab.respawnAt !== null, 'opened and its pack taken');
  assert.equal(hpOf(me), 40 + PROP_FX.medic.heal);
  assert.deepEqual(gains(events, me.id).map((g) => g.from), ['medic']);
  assert.ok(events.some((e) => e.e === 'prop' && e.kind === 'medic' && e.k === 'pop'), 'it breaks open as a shot one does');
});

test('E at a cabinet out of reach, or Space beside one, opens nothing; Space is still the ability and E the use key', () => {
  const w = emptyWorld();
  const cab = propAt(w, 'ammo', 1000, 1000);
  const far = spawnAt(w, 1000 + PROP_FX.ammo.openR + 8, 1000);
  press(w, far, { use: true });
  runEvents(w, 500);
  assert.equal(cab.phase, 'stand', 'out of reach');
  const near = spawnAt(w, 1000, 1000 - PROPS.ammo.size / 2 - WORLD.playerRadius - 2);
  if (near.life.k === 'alive') near.life.ammo = 0;
  press(w, near, { ability: true });
  runEvents(w, 500);
  assert.equal(cab.phase, 'stand', 'Space picks nothing up');
  assert.equal(actionForKey('Space'), 'ability');
  assert.equal(actionForKey('KeyE'), 'use');
  const help = new Map(CONTROLS);
  assert.match(help.get('E')!, /pick|open/i, 'the controls page says what E opens');
  assert.doesNotMatch(help.get('Space')!, /pick/i);
});

test('a cabinet opened with E by someone who does not need it leaves its pack for whoever does', () => {
  const w = emptyWorld();
  const cab = propAt(w, 'medic', 1000, 1000);
  const full = spawnAt(w, 1000 - 50, 1000);
  press(w, full, { use: true });
  const events = runEvents(w, 200);
  assert.equal(cab.phase, 'spent');
  assert.equal(cab.respawnAt, null, 'the pack lies on the floor');
  assert.equal(gains(events, full.id).length, 0, 'nothing shown for nothing taken');
});

// ---- bots, under the same rules

test('a hurt bot with nobody to fight walks to a medical cabinet, opens it with E and is healed', () => {
  const w = emptyWorld();
  const cab = propAt(w, 'medic', 1400, 1500);
  const bot = spawnAt(w, 1000, 1500, { loadout: { weapon: 'assault' }, kind: 'bot' });
  hurt(bot, 40); noRegen(bot);
  const seeded = (seed: number) => { let x = seed; return () => ((x = (x * 16807) % 2147483647) / 2147483647); };
  const r = seeded(11);
  let mem: BotMemory = newBotMemory(r);
  let used = false, t = 0;
  for (; t < 8000 && cab.phase === 'stand'; t += TICK_MS) {
    const d = botThink(snapshotFor(w, bot.id), arenaFor(w), mem, r, { strategic: true });
    mem = d.mem;
    used ||= d.input.use;
    setInput(w, bot.id, Math.round(t / TICK_MS) + 1, d.input);
    step(w, TICK_MS);
  }
  assert.ok(used, 'it pressed E');
  assert.notEqual(cab.phase, 'stand', 'the cabinet is open');
  assert.equal(hpOf(bot), 40 + PROP_FX.medic.heal, 'and the health is the bot\'s');
});

test('a healthy bot leaves cabinets alone', () => {
  const w = emptyWorld();
  const cab = propAt(w, 'medic', 1100, 1500);
  const bot = spawnAt(w, 1000, 1500, { loadout: { weapon: 'assault' }, kind: 'bot' });
  const r = (() => { let x = 5; return () => ((x = (x * 16807) % 2147483647) / 2147483647); })();
  let mem: BotMemory = newBotMemory(r);
  for (let t = 0; t < 3000; t += TICK_MS) {
    const d = botThink(snapshotFor(w, bot.id), arenaFor(w), mem, r, { strategic: true });
    mem = d.mem;
    assert.equal(d.input.use, false);
    setInput(w, bot.id, Math.round(t / TICK_MS) + 1, d.input);
    step(w, TICK_MS);
  }
  assert.equal(cab.phase, 'stand');
});

// ---- the client: popups and the prompt

test('your gains become popups: one row per pickup, a same-kind gain in the same moment sums, a later one lifts the older rows', () => {
  const events: GameEvent[] = [
    { e: 'gain', id: 7, from: 'medic', hp: 30 },
    { e: 'gain', id: 8, from: 'medic', hp: 50 },
    { e: 'gain', id: 7, from: 'ammo', ammo: 18, ability: true },
  ];
  const mine = gainsOf(events, 7);
  assert.deepEqual(mine, [{ hp: 30 }, { ammo: 18, ability: 1 }], 'only mine');
  const rows: GainRow[] = [];
  for (const g of mine) addGain(rows, g, 1000);
  assert.equal(rows.length, 1, 'what lands together shares a row');
  assert.deepEqual(rows[0]!.chips.map(chipLabel), ['+30', '+18', 'READY']);
  addGain(rows, { hp: 20 }, 1100);
  assert.deepEqual(rows[0]!.chips.map(chipLabel), ['+50', '+18', 'READY'], 'a second health pack inside the moment adds to its chip');
  addGain(rows, { ammo: 30 }, 1000 + GAIN.mergeMs + 50);
  assert.equal(rows.length, 2);
  const now = 1000 + GAIN.mergeMs + 50 + 400;
  assert.ok(rowLift(rows[0]!, now) - rowLift(rows[1]!, now) >= GAIN.gap - 1, 'the older row is lifted clear of the newer');
  assert.equal(rowAlpha(rows[1]!, now), 1, 'readable at a glance');
  assert.ok(rowLift(rows[1]!, now + 600) > rowLift(rows[1]!, now), 'it rises');
  assert.equal(rowAlpha(rows[1]!, now - 400 + GAIN_LIFE_MS - 1) < 0.2, true, 'and fades out');
  sweepGains(rows, now + GAIN_LIFE_MS);
  assert.equal(rows.length, 0);
});

test('a popup draws each chip on a plate with its icon colour and its number, over the soldier', () => {
  const texts: { s: string; x: number; y: number; fill: string }[] = [];
  const fills: string[] = [];
  let state = { fillStyle: '', font: '', globalAlpha: 1 } as Record<string, unknown>;
  const stack: Record<string, unknown>[] = [];
  const ctx = new Proxy({} as Record<string | symbol, unknown>, {
    get(_t, prop) {
      if (prop in state) return state[prop as string];
      if (prop === 'measureText') return (s: string) => ({ width: s.length * 8 });
      if (prop === 'fillText') return (s: string, x: number, y: number) => texts.push({ s, x, y, fill: String(state.fillStyle) });
      if (prop === 'fill') return () => fills.push(String(state.fillStyle));
      if (prop === 'save') return () => stack.push({ ...state });
      if (prop === 'restore') return () => { state = stack.pop() ?? state; };
      return () => undefined;
    },
    set(_t, prop, v) { state[prop as string] = v; return true; },
  }) as unknown as CanvasRenderingContext2D;
  const rows: GainRow[] = [];
  addGain(rows, { hp: 30, ammo: 12 }, 0);
  drawGainRows(ctx, rows, 400, 500, 400);
  assert.ok(texts.some((t) => t.s === '+30' && t.fill === '#8ff0c4'), 'health in heal mint');
  assert.ok(texts.some((t) => t.s === '+12' && t.fill === '#ffb347'), 'rounds in lamp amber');
  assert.ok(fills.includes('#3d4450'), 'on a gunmetal plate');
});

test('the E prompt finds the standing cabinet in reach, never a pack or one too far', () => {
  const medic = PROP_KINDS.indexOf('medic'), ammo = PROP_KINDS.indexOf('ammo'), lamp = PROP_KINDS.indexOf('lamp');
  const props: PropView[] = [[1, medic, 1000, 1000, 10], [2, ammo, 1200, 1000, 11], [3, lamp, 1040, 1000, 10]];
  assert.deepEqual(nearCabinet(props, { x: 1050, y: 1000 }), { id: 1, kind: 'medic', x: 1000, y: 1000 });
  assert.equal(nearCabinet(props, { x: 1000 + PROP_FX.medic.openR, y: 1000 }), null, 'past its reach');
  assert.equal(nearCabinet(props, { x: 1200, y: 1040 }), null, 'a pack is walked over, not opened');
});
