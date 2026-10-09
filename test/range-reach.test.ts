/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GUNS, type GunId, type PerkId, type Tier } from '../src/shared/defs.ts';
import { MAPS } from '../src/shared/maps.ts';
import { TARGETS, targetAim } from '../src/shared/range.ts';
import { MUZZLE_PX } from '../src/shared/sim/ballistics.ts';
import { snapshotFor } from '../src/shared/sim/snapshot.ts';
import { effectiveStats } from '../src/shared/sim/stats.ts';
import { setRangeLoadout } from '../src/shared/sim/targets.ts';
import type { Player, World } from '../src/shared/sim/world.ts';
import { drawReachFloor, drawReachOverlay, rangeLineX, reachClass, reachOf, resetRangeLine, type ReachClass } from '../src/client/rangeline.ts';
import { emptyWorld, press, run, spawnAt, TICK_MS } from './helpers.ts';

/**
 * The range's reach marking (src/client/rangeline.ts) against the simulation itself: the arc sits where a round really dies, it follows
 * a change of gun at once, and the pip under each target says what a real round fired from where you stand does to it.
 */
const layout = MAPS.range.range!;
const rangeWorld = (): World => emptyWorld('RNG');

/** A canvas that only records: every arc drawn (centre and radius) and every line of text. */
function recorder() {
  const arcs: { x: number; y: number; r: number }[] = [];
  const texts: string[] = [];
  const props: Record<string | symbol, unknown> = {};
  const ctx = new Proxy(props, {
    get(o, k) {
      if (k === 'arc') return (x: number, y: number, r: number) => arcs.push({ x, y, r });
      if (k === 'fillText') return (s: string) => texts.push(s);
      if (k === 'measureText') return (s: string) => ({ width: s.length * 7 });
      if (k in o) return o[k];
      return () => {};
    },
    set(o, k, v) { o[k] = v; return true; },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, arcs, texts, clear() { arcs.length = 0; texts.length = 0; } };
}

const WIDE = { x0: -5000, y0: -5000, x1: 9000, y1: 9000 };
const allUp = layout.targets.map(() => 10);

/**
 * Fires one round along `angle` and follows it tick by tick: how far east of the shooter's x it would stop if it flew dead level (its
 * place plus the range it has `left`, along its heading, as a distance from the shooter), as first seen and as last seen before it is
 * spent. The two agree, so the round flies the whole of its range and no further, whatever its spread.
 */
function roundDiesAt(w: World, p: Player, angle: number): { first: number; last: number; ticks: number } {
  const { x, y } = p;
  const before = new Set(w.bullets.map((b) => b.id));
  press(w, p, { angle, fire: true, shots: p.input.shots + 1 });
  const ends: number[] = [];
  let id: number | null = null;
  for (let i = 0; i < 200; i++) {
    run(w, TICK_MS);
    if (i === 0) press(w, p, { angle });
    const b: World['bullets'][number] | undefined = id === null ? w.bullets.find((o) => o.owner === p.id && !before.has(o.id)) : w.bullets.find((o) => o.id === id);
    if (b) { id = b.id; const k = b.left / Math.hypot(b.vx, b.vy); ends.push(x + Math.hypot(b.x + b.vx * k - x, b.y + b.vy * k - y)); } else if (id !== null) break;
  }
  assert.ok(ends.length > 1, 'the round flew');
  return { first: ends[0]!, last: ends.at(-1)!, ticks: ends.length };
}

test('the reach is the muzzle offset plus the gun\'s range after perks, for several guns', () => {
  const cases: [GunId, Partial<Record<Tier, PerkId>>, number][] = [
    ['pistol', {}, 700], ['smg', {}, 520], ['shotgun', {}, 420], ['sniper', {}, 1200], ['piercer', {}, 1400], ['sniper', { 1: 'longRange' }, 1680], ['smg', { 1: 'longRange' }, 728],
  ];
  for (const [gun, perks, range] of cases) {
    const r = reachOf(gun, perks);
    assert.equal(r.range, range, gun);
    assert.equal(rangeLineX(r, 390), 390 + MUZZLE_PX + range, `${gun} ${JSON.stringify(perks)}`);
  }
  assert.equal(reachOf('sniper', {}).title, 'MAX RANGE 1200 · BOLT-ACTION');
  assert.equal(reachOf('sniper', { 1: 'longRange' }).title, 'MAX RANGE 1680 · BOLT-ACTION · LONG RANGE');
  assert.equal(reachOf('sniper', {}).sub, null, 'no falloff, no second line');
  assert.equal(reachOf('machinePistol', {}).sub, 'FALLOFF 250–450 → 50% DMG');
  assert.deepEqual(reachOf('machinePistol', {}).falloff, { startPx: 250, endPx: 450, minMul: 0.5, start: MUZZLE_PX + 250, end: MUZZLE_PX + 450 });
});

test('the line sits where a real round fired down the range dies, for the pistol, SMG, bolt-action, Piercer and a long-range sniper', () => {
  for (const [gun, perks] of [['pistol', {}], ['smg', {}], ['sniper', {}], ['piercer', {}], ['sniper', { 1: 'longRange' }]] as [GunId, Partial<Record<Tier, PerkId>>][]) {
    const w = rangeWorld();
    w.range!.targets.forEach((t) => { t.respawnAt = Infinity; });
    // Level with no target and clear of every wall, so nothing stops the round short.
    const p = spawnAt(w, 380, 1330);
    assert.ok(setRangeLoadout(w, p, { gun, perks }));
    run(w, 900);
    const r = reachOf(gun, perks);
    assert.equal(r.reach, MUZZLE_PX + effectiveStats(p).range, 'the same range the sim gives the round');
    const died = roundDiesAt(w, p, 0);
    const line = rangeLineX(r, p.x);
    assert.ok(Math.abs(died.first - line) < 0.6 && Math.abs(died.last - line) < 0.6, `${gun}: the round stops at x ${died.first.toFixed(1)}..${died.last.toFixed(1)}, the line is at ${line}`);
    // And the overlay puts the arc's far point (the leader's dot) at that x, level with you.
    const rec = recorder();
    resetRangeLine();
    drawReachOverlay(rec.ctx, layout, MAPS.range.size, allUp, 0, WIDE, 1, { x: p.x, y: p.y, gun }, r, 0);
    assert.ok(rec.arcs.some((a) => Math.abs(a.x - line) < 0.5 && a.y === p.y), `${gun}: the plate's dot marks x ${line}`);
    assert.ok(rec.texts.includes(r.title), rec.texts.join());
  }
});

test('the arc and its plate follow a change of gun: the plate at once, the arc within its 200 ms slide', () => {
  const w = rangeWorld();
  const p = spawnAt(w, 380, 1320);
  run(w, 100);
  const reachNow = (): ReturnType<typeof reachOf> => {
    const snap = snapshotFor(w, p.id);
    const me = snap.players.find((o) => o.id === p.id)!;
    return reachOf(me.gun, snap.self.perks);
  };
  const rec = recorder();
  resetRangeLine();
  const frame = (now: number) => {
    rec.clear();
    const r = reachNow();
    drawReachFloor(rec.ctx, layout, MAPS.range.size, WIDE, { x: p.x, y: p.y, gun: r.gun }, r, now);
    drawReachOverlay(rec.ctx, layout, MAPS.range.size, allUp, 0, WIDE, 1, { x: p.x, y: p.y, gun: r.gun }, r, now);
    return { r, radii: rec.arcs.filter((a) => a.x === p.x && a.y === p.y).map((a) => a.r), texts: [...rec.texts] };
  };
  const pistol = frame(1000);
  assert.equal(pistol.r.gun, 'pistol');
  assert.ok(pistol.radii.includes(MUZZLE_PX + 700), `pistol arc ${pistol.radii}`);
  // The loadout panel's message, as the server applies it; the next snapshot carries the new gun.
  assert.ok(setRangeLoadout(w, p, { gun: 'sniper' }));
  run(w, TICK_MS);
  const switched = frame(1040);
  assert.equal(switched.r.gun, 'sniper');
  assert.ok(switched.texts.includes('MAX RANGE 1200 · BOLT-ACTION'), `the plate names the new gun on the first frame: ${switched.texts}`);
  const settled = frame(1040 + 210);
  assert.ok(settled.radii.includes(MUZZLE_PX + 1200), `bolt-action arc ${settled.radii}`);
  assert.ok(!settled.radii.includes(MUZZLE_PX + 700), 'the pistol arc is gone');
  // A perk that stretches the range moves it too.
  assert.ok(setRangeLoadout(w, p, { perks: { 1: 'longRange' } }));
  run(w, TICK_MS);
  frame(2000);
  const stretched = frame(2300);
  assert.ok(stretched.radii.includes(MUZZLE_PX + 1680), `long range arc ${stretched.radii}`);
  assert.ok(stretched.texts.includes('MAX RANGE 1680 · BOLT-ACTION · LONG RANGE'));
  // An SMG brings its falloff band: two fainter arcs at 180 and 380 px from the muzzle.
  assert.ok(setRangeLoadout(w, p, { gun: 'smg', perks: { 1: null } }));
  run(w, TICK_MS);
  frame(3000);
  const smg = frame(3300);
  for (const rad of [MUZZLE_PX + 180, MUZZLE_PX + 380, MUZZLE_PX + 520]) assert.ok(smg.radii.includes(rad), `smg arcs ${smg.radii} lack ${rad}`);
});

/**
 * Shoots target `i` from (`x`, `y`) with every other target knocked flat (so none shields it): up to `tries` rounds aimed at its centre,
 * each on a fresh trigger pull once the gun is ready, and gives back the damage of the first hit, or null if none landed.
 */
function firstHit(gun: GunId, perks: Partial<Record<Tier, PerkId>>, i: number, x: number, y: number, tries = 6): number | null {
  const w = rangeWorld();
  w.range!.targets.forEach((t, j) => { if (j !== i) t.respawnAt = Infinity; });
  const t = w.range!.targets[i]!;
  const p = spawnAt(w, x, y);
  assert.ok(setRangeLoadout(w, p, { gun, perks }));
  run(w, 900);
  // Aimed at the board, as a player aims (`targetAim`).
  const aim = targetAim(t.def.kind, t);
  const angle = Math.atan2(aim.y - p.y, aim.x - p.x);
  const gap = Math.max(GUNS[gun].fireMs, 250) + 2000;
  for (let s = 0; s < tries; s++) {
    t.hp = 1e6;
    press(w, p, { angle, fire: true, shots: p.input.shots + 1 });
    for (let ms = 0; ms < gap; ms += TICK_MS) {
      run(w, TICK_MS);
      if (ms === 0) press(w, p, { angle });
      const hit = w.events.find((e) => e.e === 'dmg' && e.kind === 'target' && e.victim === t.id);
      if (hit && hit.e === 'dmg') return hit.amount;
    }
  }
  return null;
}

const GUNS_TRIED: [GunId, Partial<Record<Tier, PerkId>>][] = [['pistol', {}], ['smg', {}], ['machinePistol', {}], ['sniper', {}], ['piercer', {}], ['smg', { 1: 'longRange' }]];

test('in range or out: the pip under each target matches what a real round from the firing line does, and in the falloff band it lands weaker', () => {
  const tally: Record<ReachClass, number> = { full: 0, falloff: 0, out: 0 };
  for (const [gun, perks] of GUNS_TRIED) {
    const r = reachOf(gun, perks);
    // Level with each target on the line, and from one spot on the line (beside the pad) for the diagonals.
    const spots = layout.targets.flatMap((d, i) => (d.rail ? [] : [{ i, x: layout.line - 10, y: d.y }, { i, x: layout.line - 10, y: 1250 }]));
    for (const { i, x, y } of spots) {
      const d = layout.targets[i]!;
      const cls = reachClass(r, { x, y }, d, d.kind);
      tally[cls]++;
      const got = firstHit(gun, perks, i, x, y, cls === 'out' ? 2 : 6);
      const what = `${gun}${perks[1] ? '+' + perks[1] : ''} from (${x}, ${y}) at target ${i} (${d.kind} ${d.x},${d.y}), ${Math.round(Math.hypot(d.x - x, d.y - y))} px: ${cls}, hit ${got}`;
      if (cls === 'out') { assert.equal(got, null, what); continue; }
      assert.notEqual(got, null, what);
      const edge = Math.hypot(d.x - x, d.y - y) - TARGETS[d.kind].r;
      // Right on the falloff's first pixel a round that strays a hair can tip either way; everywhere else the class is exact.
      if (r.falloff && Math.abs(edge - r.falloff.start) < 12) continue;
      if (cls === 'full') assert.equal(got, GUNS[gun].damage, what);
      else assert.ok(got! < GUNS[gun].damage - 0.05 && got! >= GUNS[gun].damage * r.falloff!.minMul - 0.05, what);
    }
  }
  assert.ok(tally.full > 20 && tally.falloff > 5 && tally.out > 10, `every class is exercised: ${JSON.stringify(tally)}`);
});

test('right at the edge: a target a few px inside the reach is hit and a few px outside is not, for each gun', () => {
  // The last long board (1250 px out) is clear of every other target's line, so the shooter can stand anywhere level with it.
  const i = layout.targets.findIndex((d) => d.kind === 'plank' && d.x === layout.line + 1250);
  const d = layout.targets[i]!;
  for (const [gun, perks] of GUNS_TRIED) {
    const r = reachOf(gun, perks);
    // Level with the middle of its board, where a round meets it `r` short of its post.
    const at = d.x - (r.reach + TARGETS[d.kind].r), y = targetAim(d.kind, d).y;
    const inside = firstHit(gun, perks, i, at + 4, y, 8);
    const outside = firstHit(gun, perks, i, at - 4, y, 3);
    assert.equal(reachClass(r, { x: at + 4, y }, d, d.kind) !== 'out', true);
    assert.equal(reachClass(r, { x: at - 4, y }, d, d.kind), 'out');
    assert.notEqual(inside, null, `${gun}: 4 px inside the reach should hit`);
    assert.equal(outside, null, `${gun}: 4 px outside the reach should not`);
  }
});
