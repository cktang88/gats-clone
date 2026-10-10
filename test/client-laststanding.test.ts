/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CacheView, GameEvent, PlayerView, RoyaleView, SelfView, Snapshot, TowerView } from '../src/shared/protocol.ts';
import { addGain, chipLabel, gainsOf, type GainRow } from '../src/client/pickups.ts';
import { aliveLabel, resultTitle, royaleCallouts, spectateLines, wipedLine } from '../src/client/royale.ts';
import { soundsFor } from '../src/client/sfx.ts';
import { addMoments, NO_MOMENTS } from '../src/client/moments.ts';
import { drawCachesMap, drawTowersMap, towersNeedClock } from '../src/client/lootart.ts';
import { scheduleEffects } from '../src/client/eventclock.ts';
import { MODE_INFO } from '../src/client/modecards.ts';
import { objectiveFor } from '../src/client/derive.ts';

const player = (id: number, over: Partial<PlayerView> = {}): PlayerView => ({
  id, name: `p${id}`, x: 100 * id, y: 0, angle: 0, hp: 100, maxHp: 100, color: 'red', gun: 'pistol',
  team: null, alive: true, hidden: false, shield: false, dashing: false, score: 0, level: 1, armorTier: 'none', kind: 'bot', hunted: false, ...over,
});

const royale = (o: Partial<RoyaleView> = {}): RoyaleView => ({
  round: 0, ring: { phase: 0, from: { x: 0, y: 0, r: 2000 }, to: { x: 0, y: 0, r: 1500 }, shrinkAt: 60_000, closeAt: 90_000 } as RoyaleView['ring'],
  redeploys: true, alive: 12, total: 18, redeployAt: null, drops: [], watch: null, result: null, caches: [], towers: [], guns: [], ...o,
});

const snap = (o: { events?: GameEvent[]; royale?: RoyaleView; self?: Partial<SelfView> } = {}): Snapshot => ({
  t: 'snap', tick: 1, ackSeq: 0,
  self: { id: 1, ammo: 12, mag: 12, speed: 300, reloading: false, reloadFrac: 0, perks: {}, pending: null, ability: null, abilityReadyIn: 0, alive: true, dash: null, respawnIn: 0, kills: 0, deaths: 0, viewRadius: 900, suppression: 0, streak: 0, nemesis: null, ...o.self },
  players: [player(1), player(2)], bullets: [], crates: [], thrown: [], zones: [], minimap: [], leaderboard: [],
  match: { mode: 'BR', map: 'Boneyard', nextMap: 'Old Town', mapChangeIn: 0, teamScore: { red: 0, blue: 0 }, winner: null, restartIn: 0, roundEndsAt: null },
  events: o.events ?? [], ...(o.royale && { royale: o.royale }),
} as Snapshot);

test('Last Standing is named as a solo mode on the menu card and the objective line', () => {
  assert.equal(MODE_INFO.BR.name, 'Last standing');
  assert.doesNotMatch(MODE_INFO.BR.pitch, /squad/i);
  assert.doesNotMatch(objectiveFor('BR', null, null).banner, /squad/i);
  assert.match(objectiveFor('BR', null, null).banner, /Last Standing/);
});

test('the alive counter, the result title and the out line read as one player against the rest', () => {
  assert.equal(aliveLabel(royale({ alive: 12, total: 18 })), '12 / 18');
  assert.equal(resultTitle({ place: 1, of: 18, kills: 6, loot: 4 }), '#1 · Last one standing');
  assert.equal(resultTitle({ place: 7, of: 18, kills: 2, loot: 3 }), '#7 of 18');
  assert.equal(wipedLine({ id: 4, name: 'Ann', place: 9 }, 1), 'Ann is out · #9');
  assert.equal(wipedLine({ id: 1, name: 'Me', place: 7 }, 1), "You're out · #7");
});

test('spectating names the redeploy, the result, or that no redeploys are left; nothing mentions a squad', () => {
  const s = snap();
  assert.match(spectateLines(s, royale({ redeployAt: 5000 }), 0).sub, /^Redeploy in /);
  assert.equal(spectateLines(s, royale({ result: { place: 7, of: 18, kills: 1, loot: 2 } }), 0).sub, 'You finished #7 of 18');
  for (const r of [royale({ redeployAt: 5000 }), royale({ redeploys: false })]) assert.doesNotMatch(spectateLines(s, r, 0).sub, /squad/i);
  const lastLives = royaleCallouts(royale(), royale({ redeploys: false }), 0, 0);
  assert.equal(lastLives[0]?.title, 'Last lives');
  assert.doesNotMatch(lastLives[0]!.line, /squad|knock/i);
});

test('a loot cache pays out as chips: score in XP, the armor tier named, plates as +N', () => {
  const g = gainsOf([{ e: 'gain', id: 1, from: 'loot', xp: 220, hp: 45, armor: 16, armorTo: 'light' }], 1);
  assert.deepEqual(g, [{ hp: 45, armor: 16, xp: 220, armorTo: 1 }]);
  const rows: GainRow[] = [];
  addGain(rows, g[0]!, 0);
  assert.deepEqual(rows[0]!.chips.map(chipLabel), ['LIGHT ARMOR', '+220 XP', '+45', '+16']);
  assert.equal(chipLabel({ kind: 'armorTo', amount: 2 }), 'MEDIUM ARMOR');
  assert.equal(chipLabel({ kind: 'armorTo', amount: 3 }), 'HEAVY ARMOR');
  // A second tier-up in the same beat names the new tier rather than adding them up.
  addGain(rows, { armorTo: 2 }, 50);
  assert.equal(chipLabel(rows[0]!.chips[0]!), 'MEDIUM ARMOR');
  assert.deepEqual(gainsOf([{ e: 'gain', id: 2, from: 'loot', xp: 90 }], 1), [], 'only your own');
});

test('caches open with a tiered crate sound at the cache, and a tower taken pings the radar', () => {
  const ev = (tier: 0 | 1 | 2, by: number): GameEvent => ({ e: 'loot', x: 300, y: 40, tier, by });
  const cues = soundsFor(null, snap({ events: [ev(0, 2), ev(1, 1), ev(2, 2)] }));
  assert.deepEqual(cues.map((c) => [c.id, c.self]), [['loot:0', false], ['loot:1', true], ['loot:2', false]]);
  const tower = soundsFor(null, snap({ events: [{ e: 'tower', x: 10, y: 10, r: 2200, by: 1, n: 3 }] }));
  assert.deepEqual(tower.map((c) => [c.id, c.self]), [['radar', true]]);
});

test('taking a recon tower calls out how many players it marked, only for its holder', () => {
  const mine = addMoments(NO_MOMENTS, null, snap({ events: [{ e: 'tower', x: 0, y: 0, r: 2200, by: 1, n: 3 }] }), 1000);
  assert.deepEqual(mine.callouts.map((c) => [c.title, c.line]), [['Recon', '3 players marked on your map']]);
  const theirs = addMoments(NO_MOMENTS, null, snap({ events: [{ e: 'tower', x: 0, y: 0, r: 2200, by: 2, n: 3 }] }), 1000);
  assert.equal(theirs.callouts.length, 0);
});

test('loot and tower events schedule no world effect of their own', () => {
  assert.deepEqual(scheduleEffects(snap({ events: [{ e: 'loot', x: 0, y: 0, tier: 2, by: 1 }, { e: 'tower', x: 0, y: 0, r: 1, by: 1, n: 0 }] }), 0), []);
});

/** A canvas stand-in that records the colour of each filled rect and each stroked path. */
function recorder() {
  const rects: string[] = [], strokes: string[] = [];
  const ctx = new Proxy({ fillStyle: '', strokeStyle: '', lineWidth: 1 } as Record<string, unknown>, {
    get(t, k) {
      if (k === 'fillRect') return () => rects.push(String(t.fillStyle));
      if (k === 'stroke') return () => strokes.push(String(t.strokeStyle));
      if (k in t) return t[k as string];
      return () => {};
    },
    set(t, k, v) { t[k as string] = v; return true; },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, rects, strokes };
}

test('the minimap shows unopened Rare and Epic caches only, and towers bright when ready and grey while resting', () => {
  const caches: CacheView[] = [[1, 10, 10, 0, 0, 0, 0], [2, 20, 20, 1, 0, 0, 0], [3, 30, 30, 2, 0, 0, 1], [4, 40, 40, 2, 1, 0, 0]];
  const { ctx, rects } = recorder();
  drawCachesMap(ctx, caches, 0, 0, 0.1);
  // An ink backing and a tier colour for each shown cache: the rare (blue) and the unopened epic (purple).
  assert.deepEqual(rects.filter((_, i) => i % 2 === 1), ['#5aa9ff', '#b06bff']);
  const towers: TowerView[] = [{ x: 0, y: 0, readyAt: 0 }, { x: 50, y: 50, readyAt: 90_000 }];
  const t = recorder();
  drawTowersMap(t.ctx, towers, 0, 0, 0.1, 0);
  assert.deepEqual(t.strokes.filter((_, i) => i % 2 === 1), ['#7fd4ff', '#6b7079']);
  assert.equal(towersNeedClock(towers), true);
  assert.equal(towersNeedClock([towers[0]!]), false, 'no resting tower, no server clock needed');
});
