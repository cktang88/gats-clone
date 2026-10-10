/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GUNS, WORLD } from '../src/shared/defs.ts';
import { clearOfRects, deathText, edgePoint, killOf, lossOf, type KillEvent } from '../src/client/derive.ts';
import { spreadFor } from '../src/shared/sim/stats.ts';
import { addMoments, CALLOUT_MS, CALLOUT_STAGGER_MS, MEDAL_MS, NO_MOMENTS } from '../src/client/moments.ts';
import { approachAlpha, drawHud, HEALTH, healthLook, hudScaleFor, PANEL_ALPHA, reticleGap } from '../src/client/hud.ts';
import { makeCamera } from '../src/client/camera.ts';
import { NO_FEEDBACK } from '../src/client/feedback.ts';
import { EMPTY_BUFFER } from '../src/client/interp.ts';
import type { Session } from '../src/client/state.ts';
import { createPool } from '../src/client/particles.ts';
import { createCracks } from '../src/client/decals.ts';
import { glow, INK, PALETTE } from '../src/client/palette.ts';
import { addCorpse, addZombieCorpse, CORPSE, corpseAlpha, deadHex, deadTone, drawCorpses, drawZombieCorpses, explosiveDeath, liveCorpses, restingGun, ZOMBIE_CORPSE, zombieField, type Corpse, type ZombieCorpse } from '../src/client/corpses.ts';
import { drawnTags, drawWorld, roundHeft } from '../src/client/render.ts';
import type { GameEvent, PlayerView, SelfView, Snapshot } from '../src/shared/protocol.ts';

const player = (id: number, over: Partial<PlayerView> = {}): PlayerView => ({
  id, name: `p${id}`, x: 100 * id, y: 0, angle: 0, hp: 100, maxHp: 100, color: 'red', gun: 'pistol',
  team: null, alive: true, hidden: false, shield: false, dashing: false, score: 0, level: 0, armorTier: 'none', hunted: false, kind: 'bot', ...over,
});

const snap = (o: { me?: Partial<PlayerView>; self?: Partial<SelfView>; players?: PlayerView[]; events?: GameEvent[] } = {}): Snapshot => ({
  t: 'snap', tick: 1, ackSeq: 0,
  self: { id: 1, ammo: 12, mag: 12, speed: 300, reloading: false, reloadFrac: 0, perks: {}, pending: null, ability: null, abilityReadyIn: 0, alive: o.me?.alive ?? true, dash: null, respawnIn: 0, kills: 0, deaths: 0, viewRadius: 900, suppression: 0, streak: 0, nemesis: null, ...o.self },
  players: [player(1, o.me), ...(o.players ?? [])], bullets: [], crates: [], thrown: [], zones: [], minimap: [], leaderboard: [],
  match: { mode: 'FFA', map: 'Boneyard', nextMap: 'Old Town', mapChangeIn: 0, teamScore: { red: 0, blue: 0 }, winner: null, restartIn: 0, roundEndsAt: null }, events: o.events ?? [],
});

const kill = (over: Partial<KillEvent> = {}): KillEvent =>
  ({ e: 'kill', killer: 'Atlas', victim: 'p1', killerId: 7, victimId: 1, weapon: 'Hornet', bounty: false, assisters: [], ended: 0, revenge: false, ...over });

const moments = (prev: Snapshot | null, next: Snapshot, now = 1000) => addMoments(NO_MOMENTS, prev, next, now);

test('evolving announces the new gun with a ring, and stage 2 adds the hunted callout', () => {
  const stage1 = moments(snap({ me: { gun: 'smg' } }), snap({ me: { gun: 'skirmisher' } })).callouts;
  assert.deepEqual(stage1.map((c) => [c.title, c.ring]), [['Skirmisher', true]]);
  assert.equal(stage1[0]!.color, GUNS.skirmisher.look.accent, 'in the gun\'s accent');
  const stage2 = moments(snap({ me: { gun: 'skirmisher' } }), snap({ me: { gun: 'phantom' } })).callouts;
  assert.deepEqual(stage2.map((c) => c.title), ['Phantom', 'You are HUNTED']);
  assert.match(stage2[1]!.line, /minimap/);
  assert.deepEqual(moments(snap({ me: { gun: 'phantom', alive: false } }), snap({ me: { gun: 'smg' } })).callouts, [], 'respawning on the class gun is no moment');
  assert.deepEqual(moments(snap({ me: { gun: 'smg' } }), snap({ me: { gun: 'smg' } })).callouts, []);
});

test('your kill floats the score you actually earned at the victim, catch-up included', () => {
  const blow: GameEvent = { e: 'dmg', attacker: 1, victim: 7, amount: 30, x: 420, y: 380, kind: 'player' };
  const m = moments(snap({ me: { score: 100 } }), snap({ me: { score: 250 }, events: [blow, kill({ killer: 'p1', killerId: 1, victim: 'Atlas', victimId: 7 })] }));
  assert.deepEqual(m.popups.map((p) => [p.x, p.y, p.amount]), [[420, 380, 150]]);
  assert.deepEqual(m.callouts, [], 'a plain kill has no callout');
  const someoneElse = moments(snap({ me: { score: 100 } }), snap({ me: { score: 100 }, events: [kill({ killerId: 3, victimId: 7 })] }));
  assert.deepEqual(someoneElse.popups, [], 'another player\'s kill');
});

test('a bounty kill gets its gold medal, and moments expire', () => {
  const prev = snap({ me: { score: 0 }, players: [player(7, { x: 300, y: 200 })] });
  const m = moments(prev, snap({ me: { score: 300 }, events: [kill({ killer: 'p1', killerId: 1, victim: 'Atlas', victimId: 7, bounty: true }), { e: 'medal', id: 1, medal: 'bounty' }] }));
  assert.deepEqual(m.medals.map((t) => (t.k === 'medal' ? t.medal : null)), ['bounty']);
  assert.deepEqual(m.popups.map((p) => [p.x, p.y]), [[300, 200]], 'without a blow this snapshot, the victim\'s last position');
  const later = addMoments(m, prev, prev, 1000 + Math.max(CALLOUT_MS, MEDAL_MS));
  assert.deepEqual([later.callouts, later.popups, later.medals], [[], [], []]);
});

test('moments that land together queue, so at most two callouts share the screen', () => {
  const prev = snap({ me: { gun: 'skirmisher', score: 0 } });
  const first = moments(prev, snap({ me: { gun: 'phantom', score: 0 } }));
  assert.deepEqual(first.callouts.map((c) => c.born), [1000, 1000 + CALLOUT_STAGGER_MS], 'evolving and turning hunted queue one after the other');
  // A new personal best a moment later queues behind them.
  const m = addMoments(first, snap({ me: { gun: 'phantom' }, self: { streak: 3 } }), snap({ me: { gun: 'phantom' }, self: { streak: 4 } }), 1100, 3);
  const borns = m.callouts.map((c) => c.born);
  assert.deepEqual(borns, [1000, 1000 + CALLOUT_STAGGER_MS, 1000 + 2 * CALLOUT_STAGGER_MS]);
  for (let t = 1000; t < 1000 + 3 * CALLOUT_MS; t += 50) {
    assert.ok(borns.filter((b) => t >= b && t - b < CALLOUT_MS).length <= 2, `at most two on screen at ${t}`);
  }
});

test('dying clears pending callouts, so none play over the death card', () => {
  const evolved = moments(snap({ me: { gun: 'skirmisher' } }), snap({ me: { gun: 'phantom' } }));
  assert.equal(evolved.callouts.length, 2);
  const dead = addMoments(evolved, snap({ me: { gun: 'phantom' } }), snap({ me: { gun: 'phantom', alive: false } }), 1100);
  assert.deepEqual(dead.callouts, []);
});

test('an off-screen hunted mark gets an edge marker on its bearing; an on-screen one gets none', () => {
  const center = { x: 640, y: 400 };
  assert.equal(edgePoint(center, { x: 900, y: 100 }, 1280, 800, 30), null, 'inside the screen');
  assert.deepEqual(edgePoint(center, { x: 3000, y: 400 }, 1280, 800, 30), { x: 1250, y: 400, angle: 0 }, 'due east lands on the right edge');
  assert.deepEqual(edgePoint(center, { x: 640, y: -5000 }, 1280, 800, 30), { x: 640, y: 30, angle: -Math.PI / 2 }, 'due north lands on the top edge');
  const corner = edgePoint(center, { x: -500, y: 3000 }, 1280, 800, 30)!;
  assert.equal(corner.y, 770, 'a steep bearing toward the bottom left clamps to the bottom edge first');
  assert.ok(corner.x > 30 && corner.x < 640, 'left of center, still on screen');
});

test('a HUD panel fades toward see-through while a player is under it, and back after', () => {
  let alpha: number = PANEL_ALPHA.rest;
  alpha = approachAlpha(alpha, true, 90);
  assert.ok(alpha < PANEL_ALPHA.rest && alpha > PANEL_ALPHA.covering, 'eases rather than snapping');
  for (let i = 0; i < 10; i++) alpha = approachAlpha(alpha, true, 50);
  assert.equal(alpha, PANEL_ALPHA.covering, 'settles see-through without overshooting');
  for (let i = 0; i < 10; i++) alpha = approachAlpha(alpha, false, 50);
  assert.equal(alpha, PANEL_ALPHA.rest, 'returns to its resting opacity');
  assert.ok(PANEL_ALPHA.rest < 1, 'even at rest the panel is translucent');
});

type Drawn = { text: string; color: unknown; font?: unknown };

/** Draws the HUD into a recording context and returns every filled string with its fill color. */
function hudTexts(frame: Snapshot, session: Partial<Session> = {}, now = 1000): Drawn[] {
  const drawn: Drawn[] = [];
  const ctx = new Proxy({} as Record<string | symbol, unknown>, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'fillText') return (text: string) => drawn.push({ text, color: target.fillStyle, font: target.font });
      if (prop === 'measureText') return (text: string) => ({ width: text.length * 7 });
      if (typeof prop === 'string' && prop.startsWith('create')) return () => ({ addColorStop() {} });
      return () => {};
    },
    set(target, prop, value) { target[prop] = value; return true; },
  }) as unknown as CanvasRenderingContext2D;
  Object.assign(globalThis, { Path2D: class {} });
  const s = { myId: 1, worldSize: 3000, walls: [], lastSelf: { x: 100, y: 0 }, feedback: NO_FEEDBACK, moments: NO_MOMENTS, feed: [], snaps: EMPTY_BUFFER, ...session } as unknown as Session;
  drawHud(ctx, 1, makeCamera(s.lastSelf, 1280, 800, WORLD.viewRadius), frame, s, now, { x: 0, y: 0 }, null);
  return drawn;
}

test('the kill feed spells out an evolved gun in its accent color and keeps the icon for a class gun', () => {
  const line = (weapon: string) => ({ ...kill({ weapon }), at: 1000 });
  const evolved = hudTexts(snap(), { feed: [line('Hornet')] });
  assert.deepEqual(evolved.filter((d) => d.text === 'Hornet').map((d) => d.color), [glow(GUNS.hornet.look.accent, 0.74)], 'its accent hue, lifted to read on the grey row');
  const base = hudTexts(snap(), { feed: [line('SMG')] });
  assert.equal(base.some((d) => d.text === 'SMG'), false, 'a class gun is drawn as its icon, not its name');
});

test('holding a stage-2 gun shows a HUNTED badge on your HUD', () => {
  assert.equal(hudTexts(snap({ me: { gun: 'phantom', hunted: true } })).filter((d) => d.text === 'HUNTED').length, 1);
  assert.equal(hudTexts(snap({ me: { gun: 'skirmisher' } })).some((d) => d.text === 'HUNTED'), false);
});

test('the HUD reads your health and magazine off the snapshot: the figure on the health cross, rounds over the mag size, RELOAD while reloading', () => {
  const texts = (frame: Snapshot, now: number) => hudTexts(frame, {}, now).map((d) => d.text);
  // Seen fresh (a new life, or the first frame in a while), the figures are exact.
  const fresh = texts(snap({ me: { hp: 73 }, self: { ammo: 7, mag: 12 } }), 50_000);
  assert.ok(fresh.includes('73'), `health 73 on the cross: ${fresh}`);
  assert.ok(fresh.includes('7') && fresh.includes('/12'), 'seven rounds of twelve');
  const reloading = texts(snap({ self: { ammo: 0, mag: 12, reloading: true, reloadFrac: 0.4 } }), 60_000);
  assert.ok(reloading.includes('RELOAD') && !reloading.includes('/12'), 'a reload replaces the count');
  // A hit rolls the figure down over a few frames instead of jumping, and lands exactly on the new health.
  texts(snap({ me: { hp: 100 } }), 70_000);
  const hit = texts(snap({ me: { hp: 41 } }), 70_016);
  assert.ok(!hit.includes('41') && hit.some((t) => Number(t) > 41 && Number(t) < 100), `rolling down: ${hit}`);
  let t = 70_016, last: string[] = [];
  for (let i = 0; i < 40; i++) last = texts(snap({ me: { hp: 41 } }), (t += 16));
  assert.ok(last.includes('41'), `settled on 41: ${last}`);
});

test('the health cross colours by health: green over half, amber to 35%, orange (low) to 15%, red (critical) under', () => {
  const at = (hp: number) => healthLook(hp, 400, hp, 10_000, -1e9, -1e9, true);
  assert.deepEqual([400, 201, 200, 141, 140, 61, 60, 1].map((hp) => at(hp).state), ['ok', 'ok', 'hurt', 'hurt', 'low', 'low', 'critical', 'critical']);
  assert.equal(at(400).tone, PALETTE.hpGood);
  assert.equal(at(50).tone, PALETTE.hpBad);
  assert.equal(at(0).figure, '0');
  assert.equal(healthLook(41, 100, 40.2, 0, -1e9, -1e9).figure, '41', 'the rolling figure rounds up, never showing less than you have');
  assert.equal(healthLook(500, 400, 500, 0, -1e9, -1e9).frac, 1, 'the fill never spills past full');
});

test('the health cross flashes on a hit and glows on a heal, each for a moment only', () => {
  const look = (now: number) => healthLook(200, 400, 200, now, 1000, 5000, false);
  assert.equal(look(1000).flash, 1, 'full flash the frame the hit lands');
  assert.ok(look(1000 + HEALTH.flashMs / 2).flash > 0.4 && look(1000 + HEALTH.flashMs / 2).flash < 0.6, 'fading');
  assert.equal(look(1001 + HEALTH.flashMs).flash, 0, 'gone after flashMs');
  assert.equal(look(5000).heal, 1);
  assert.equal(look(5001 + HEALTH.healMs).heal, 0);
  assert.equal(look(3000).pulse, 0, 'no throb above 35%');
  const low = [0, 100, 200, 300].map((t) => healthLook(100, 400, 100, t, -1e9, -1e9, false).pulse);
  assert.ok(new Set(low).size > 1 && low.every((p) => p >= 0 && p <= 1), `low health throbs: ${low}`);
  assert.equal(healthLook(100, 400, 100, 300, -1e9, -1e9, true).pulse, 0, 'steady with reduced motion');
});

test('the health figure is drawn big: 40 px or more at 1080p', () => {
  const drawn = hudTexts(snap({ me: { hp: 287, maxHp: 400 } }), {}, 90_000).filter((d) => d.text === '287');
  assert.equal(drawn.length, 1, 'once: on the cross, not again under your soldier');
  const px = Number(/(\d+(?:\.\d+)?)px/.exec(String(drawn[0]!.font))?.[1]);
  assert.equal(px, HEALTH.figure);
  assert.ok(px * hudScaleFor(1920, 1080, false) >= 40, `${px} HUD px at 1080p`);
});

/** Draws the world into a recording context and returns the stroke color of every stroke. */
function worldStrokes(frame: Snapshot, killerId: number | null = null): unknown[] {
  const strokes: unknown[] = [];
  const ctx = new Proxy({} as Record<string | symbol, unknown>, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'stroke') return () => strokes.push(target.strokeStyle);
      if (prop === 'measureText') return () => ({ width: 0 });
      if (typeof prop === 'string' && prop.startsWith('create')) return () => ({ addColorStop() {} });
      return () => {};
    },
    set(target, prop, value) { target[prop] = value; return true; },
  }) as unknown as CanvasRenderingContext2D;
  Object.assign(globalThis, { document: { createElement: () => ({ getContext: () => ctx }) } });
  const s = { myId: 1, worldSize: 3000, walls: [], hurtAt: new Map(), cracks: createCracks(), effects: [], corpses: [], zombieCorpses: { list: [], dawnAt: null }, particles: createPool(), feedback: NO_FEEDBACK } as unknown as Session;
  drawWorld(ctx, { snap: frame, s, cam: makeCamera({ x: 100, y: 0 }, 1280, 800, WORLD.viewRadius), dpr: 1, now: 0, selfAngle: null, killerId });
  return strokes;
}

test('the hunted brackets mark hunted enemies but not yourself', () => {
  assert.equal(worldStrokes(snap({ me: { gun: 'phantom', hunted: true } })).includes(PALETTE.hunted), false, 'no brackets on you');
  assert.equal(worldStrokes(snap({ players: [player(2, { gun: 'phantom', hunted: true })] })).includes(PALETTE.hunted), true, 'brackets on a hunted enemy');
});

test('in free for all an enemy wearing your color gets a rival ring; other colors and teammates do not', () => {
  const rings = (frame: Snapshot) => worldStrokes(frame).filter((c) => c === PALETTE.rival).length;
  assert.equal(rings(snap({ me: { color: 'blue' }, players: [player(2, { color: 'blue' }), player(3, { color: 'red' })] })), 1, 'only the same-colored enemy');
  assert.equal(rings(snap({ me: { color: 'blue', team: 'blue' }, players: [player(2, { color: 'blue', team: 'blue' })] })), 0, 'team modes color by team already');
});

test('every other body wears its name; your own bar shows only while you are hurt, and your name never', () => {
  const tags = (frame: Snapshot) => { worldStrokes(frame); return drawnTags(); };
  assert.deepEqual(tags(snap({ players: [player(2), player(3, { hidden: true })] })), [{ id: 1, bar: false, name: false }, { id: 2, bar: false, name: true }]);
  assert.deepEqual(tags(snap({ me: { hp: 99 }, players: [player(2, { hp: 10 })] })), [{ id: 1, bar: true, name: false }, { id: 2, bar: false, name: true }]);
});

test('while you wait to respawn, your killer wears a red ring', () => {
  const frame = snap({ me: { alive: false }, players: [player(2)] });
  assert.equal(worldStrokes(frame).includes(PALETTE.hunted), false);
  assert.equal(worldStrokes(frame, 2).includes(PALETTE.hunted), true);
});

test('the reticle spread follows the gun and Grip', () => {
  assert.equal(spreadFor('smg', {}, true), GUNS.smg.spread);
  assert.ok(Math.abs(spreadFor('smg', { 1: 'grip' }, true) - GUNS.smg.spread * 0.6) < 1e-12, 'grip narrows it');
  assert.ok(spreadFor('shotgun', {}, true) > spreadFor('sniper', {}, true), 'a shotgun reticle is wider than a sniper\'s');
});

test('the reticle opens with the spread cone at the cursor distance, within readable bounds', () => {
  assert.ok(Math.abs(reticleGap(0.1, 300) - Math.tan(0.1) * 300) < 1e-9);
  assert.ok(reticleGap(0.1, 400) > reticleGap(0.1, 200), 'farther aim, wider cone');
  assert.equal(reticleGap(0.01, 50), 5, 'never closes onto the center dot');
  assert.equal(reticleGap(0.3, 2000), 120, 'never sprawls across the screen (wide enough to show a post-sprint bloom)');
});

test('the death screen names the killer\'s gun and what the life had earned', () => {
  const life = snap({ me: { level: 5, gun: 'hornet' }, self: { perks: { 1: 'optics', 2: 'shield', 3: 'fragGrenade' } } });
  assert.deepEqual(deathText(kill(), lossOf(life)), {
    title: 'Eliminated by Atlas',
    cause: 'with Hornet',
    lost: 'Lost level 6 · Hornet · Optics · Shield · Frag grenade',
  });
});

test('a class gun and an unlevelled life lose nothing worth listing', () => {
  assert.equal(deathText(kill(), lossOf(snap({ me: { level: 0, gun: 'smg' } }))).lost, '');
  assert.equal(deathText(kill(), lossOf(snap({ me: { level: 1, gun: 'smg' } }))).lost, 'Lost level 2', 'the class gun is not a loss');
  assert.equal(lossOf(snap({ me: { alive: false } })), null, 'a snapshot after the death has nothing to report');
});

test('a hunted death says the bounty went to the killer, and an environmental one names only the cause', () => {
  assert.equal(deathText(kill({ bounty: true }), null).cause, `with Hornet · your bounty paid them ${WORLD.bountyScore}`);
  assert.deepEqual(deathText(kill({ killer: '', killerId: null, weapon: 'Gas' }), null), { title: 'You were eliminated', cause: 'Gas', lost: '' });
  assert.equal(killOf([kill({ victimId: 2 }), kill({ killer: 'Bo' })], 1)?.killer, 'Bo', 'the kill whose victim is you');
});

test('an edge marker that would land on a HUD panel slides back along its bearing to just outside it', () => {
  const from = { x: 640, y: 400 };
  const feed = { x: 12, y: 6, w: 300, h: 140 };
  const onFeed = { x: 40, y: 34 };
  const at = clearOfRects(from, onFeed, [feed], 16);
  assert.ok(at.x > feed.x + feed.w + 15 || at.y > feed.y + feed.h + 15, `outside the grown panel, got ${at.x},${at.y}`);
  const bearing = (p: { x: number; y: number }) => Math.atan2(p.y - from.y, p.x - from.x);
  assert.ok(Math.abs(bearing(at) - bearing(onFeed)) < 1e-9, 'same bearing');
  const clearSpot = { x: 1246, y: 400 };
  assert.deepEqual(clearOfRects(from, clearSpot, [feed], 16), clearSpot, 'a marker clear of every panel stays put');
});

const lightness = (color: unknown): number => {
  const s = String(color);
  const [r, g, b] = s.startsWith('#') ? [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16)) : s.match(/\d+/g)!.slice(0, 3).map(Number);
  return (r! + g! + b!) / (3 * 255);
};

test("every gun's round is a lit slug: a warm tracer, an amber body and a hot core lighter than both, with no ink outline", () => {
  worldStrokes(snap());
  for (const gun of Object.keys(GUNS) as (keyof typeof GUNS)[]) {
    // The first frame with a gun paints its cached image; measure from the second.
    worldStrokes(snap({ players: [player(2, { gun })] }));
    const base = worldStrokes(snap({ players: [player(2, { gun })] }));
    const frame = snap({ players: [player(2, { gun })] });
    frame.bullets = [{ id: 9, x: 140, y: 0, vx: 1500, vy: 0, owner: 2, gun }];
    const strokes = worldStrokes(frame);
    const from = strokes.findIndex((c, i) => c !== base[i]);
    const round = strokes.slice(from, from + strokes.length - base.length);
    assert.ok(round.includes('#ff8a2a'), `${gun} streaks a warm tracer`);
    assert.ok(round.includes('#ffc247'), `${gun} has an amber body`);
    assert.ok(round.includes('#fff6c8') && lightness('#fff6c8') > lightness('#ffc247'), `${gun} has a hot core`);
    assert.ok(!round.includes(INK), `${gun}'s round is light, so no ink outline`);
  }
});

test('a heavier round is fatter: a pistol round is modest, a slug or a sniper round is the biggest on the field', () => {
  assert.ok(roundHeft('pistol') < roundHeft('handCannon') && roundHeft('handCannon') < roundHeft('slugGun') && roundHeft('slugGun') < roundHeft('sniper'));
  assert.ok(roundHeft('pistol') < 0.35 && roundHeft('sniper') === 1 && roundHeft('smg') < roundHeft('pistol'));
});

test('a fallen player lies where they died as an obviously dead body, for 30s, then fades away', () => {
  const corpse: Corpse = { victim: 2, x: 200, y: 0, angle: 0, color: '#e5484d', gun: 'shotgun', map: 'Boneyard', born: 0, blow: 0, blast: false };
  let corpses = addCorpse([], corpse);
  assert.equal(liveCorpses(corpses, 'Boneyard', 29_000).length, 1, 'still there after 29s');
  assert.equal(liveCorpses(corpses, 'Boneyard', 30_000).length, 0, 'gone at 30s');
  assert.equal(liveCorpses(corpses, 'Old Town', 1000).length, 0, 'a new map clears the field');
  assert.equal(corpseAlpha(corpse, 10_000), 1, 'solid for most of its life');
  assert.ok(corpseAlpha(corpse, 28_500) < 1 && corpseAlpha(corpse, 28_500) > 0, 'fading over the last seconds');
  for (let i = 0; i < 100; i++) corpses = addCorpse(corpses, { ...corpse, victim: 100 + i });
  assert.equal(corpses.length, CORPSE.cap, 'the field holds a bounded number');
  assert.notEqual(deadTone('#e5484d'), '#e5484d', 'the dead are washed toward grey');

  const strokes: unknown[] = [];
  const fills: unknown[] = [];
  const ctx = new Proxy({} as Record<string | symbol, unknown>, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'stroke') return () => strokes.push(target.strokeStyle);
      if (prop === 'fill') return () => fills.push(target.fillStyle);
      return () => ({ addColorStop() {} });
    },
    set(target, prop, value) { target[prop] = value; return true; },
  }) as unknown as CanvasRenderingContext2D;
  // The body art paints its cached sprites through the same recording context.
  Object.assign(globalThis, { document: { createElement: () => ({ getContext: () => ctx }) } });
  drawCorpses(ctx, [corpse], 5000);
  assert.ok(fills.includes(deadHex(corpse.color)), 'a grey body');
  assert.ok(!fills.includes(corpse.color), 'never in the living colour');
  assert.ok(fills.some((f) => typeof f === 'string' && f.startsWith('#7a10')), 'in a pool of blood');
  assert.ok(strokes.filter((c) => c === INK).length >= 2, 'outlined and crossed out');
});

test('every corpse drops its gun somewhere different, and a blast flings it further', () => {
  const at = { x: 0, y: 0 };
  const rest = (c: Corpse) => restingGun(c, at, CORPSE.lifeMs / 2);
  const corpses = Array.from({ length: 40 }, (_, i): Corpse => ({ victim: i + 1, x: 0, y: 0, angle: 0, color: '#3e63dd', gun: 'pistol', map: 'm', born: 1000 * i, blow: null, blast: false }));
  const guns = corpses.map(rest);
  const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
  assert.ok(spread(guns.map((g) => Math.atan2(g.y, g.x))) > 4, 'dropped on every side');
  assert.ok(spread(guns.map((g) => Math.hypot(g.x, g.y))) > WORLD.playerRadius * 0.6, 'at different distances');
  assert.ok(spread(guns.map((g) => ((g.angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI))) > 4, 'lying at any angle');
  const reach = (blast: boolean) => Math.min(...corpses.map((c) => Math.hypot(rest({ ...c, blast }).x, rest({ ...c, blast }).y)));
  assert.ok(reach(true) > reach(false), 'a blast throws the gun clear');
  assert.deepEqual(restingGun(corpses[0]!, at, 0), { ...restingGun(corpses[0]!, at, 0) }, 'the same corpse always lands the same way');
  const settled = restingGun(corpses[0]!, at, CORPSE.slideMs * 2), later = restingGun(corpses[0]!, at, CORPSE.lifeMs - 1);
  assert.deepEqual(settled, later, 'and it stays put once it lands');
  assert.ok(explosiveDeath('Grenade') && explosiveDeath('Boom Slug') && !explosiveDeath('Pistol'));
});

test('dead zombies fade out ~10 s after they fall, whatever is left fades at dawn, and the field is bounded', () => {
  const z = (id: number): ZombieCorpse => ({ id, x: id * 10, y: 0, kind: 'walker', born: 0, blow: null });
  let list: ZombieCorpse[] = [];
  for (let i = 1; i <= ZOMBIE_CORPSE.cap + 50; i++) list = addZombieCorpse(list, z(i));
  assert.equal(list.length, ZOMBIE_CORPSE.cap, 'a huge night keeps a bounded field');
  const night = zombieField({ list, dawnAt: null }, true, 5_000);
  assert.equal(night.alpha, 1, 'the fresh dead lie at full strength');
  assert.equal(night.list.length, ZOMBIE_CORPSE.cap);
  const fading = zombieField(night, true, ZOMBIE_CORPSE.lifeMs + ZOMBIE_CORPSE.fadeMs / 2);
  assert.equal(fading.list.length, ZOMBIE_CORPSE.cap, 'still there while they fade out');
  const melted = zombieField(fading, true, ZOMBIE_CORPSE.lifeMs + ZOMBIE_CORPSE.fadeMs);
  assert.equal(melted.list.length, 0, 'each dead zombie is gone lifeMs + fadeMs after it fell, even mid-night');
  const later = zombieField({ list: [...list.slice(0, 3), { ...z(9999), born: 20_000 }], dawnAt: null }, true, 21_000);
  assert.deepEqual(later.list.map((c) => c.id), [9999], 'old dead go, the newly fallen stay');
  const dawn = zombieField(night, false, 6_000);
  assert.ok(dawn.alpha === 1 && dawn.dawnAt === 6_000, 'dawn starts the fade');
  const mid = zombieField(dawn, false, 6_000 + ZOMBIE_CORPSE.dawnFadeMs / 2);
  assert.ok(mid.alpha > 0.4 && mid.alpha < 0.6, 'fading');
  const gone = zombieField(mid, false, 6_000 + ZOMBIE_CORPSE.dawnFadeMs + 1);
  assert.deepEqual([gone.list.length, gone.alpha], [0, 0], 'cleared once faded');

  const fills: unknown[] = [];
  const ctx = new Proxy({} as Record<string | symbol, unknown>, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'fill') return () => fills.push(target.fillStyle);
      return () => {};
    },
    set(target, prop, value) { target[prop] = value; return true; },
  }) as unknown as CanvasRenderingContext2D;
  drawZombieCorpses(ctx, Array.from({ length: 200 }, (_, i) => z(i + 1)), 1, 5000);
  assert.ok(fills.length <= 6, `two hundred dead walkers draw in a handful of batched fills (${fills.length})`);
});
