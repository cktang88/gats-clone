import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WORLD, type ModeId } from '../src/shared/defs.ts';
import { loadoutSlots, progressLine, slotBoxes, TILE } from '../src/client/loadout.ts';
import { drawHud, drawnLoadout, drawnPanels, HEALTH, hudScaleFor } from '../src/client/hud.ts';
import { makeCamera } from '../src/client/camera.ts';
import { NO_FEEDBACK } from '../src/client/feedback.ts';
import { NO_MOMENTS } from '../src/client/moments.ts';
import { EMPTY_BUFFER } from '../src/client/interp.ts';
import type { Session } from '../src/client/state.ts';
import type { LeaderRow, PlayerView, SelfView, Snapshot } from '../src/shared/protocol.ts';
import type { Rect } from '../src/client/derive.ts';

test('with nothing unlocked the strip is empty, and each unlock adds exactly its own slot', () => {
  assert.deepEqual(loadoutSlots('smg', {}, null), [], 'a class gun and no picks: no slots at all');
  const ladder = [
    loadoutSlots('smg', { 1: 'extended' }, null),
    loadoutSlots('skirmisher', { 1: 'extended' }, null),
    loadoutSlots('skirmisher', { 1: 'extended', 2: 'secondWind' }, null),
    loadoutSlots('skirmisher', { 1: 'extended', 2: 'secondWind', 3: 'dash' }, 'dash'),
  ];
  assert.deepEqual(ladder.map((s) => s.map((x) => x.kind)), [
    ['attachment'], ['gun', 'attachment'], ['gun', 'attachment', 'perk'], ['gun', 'attachment', 'perk', 'ability'],
  ]);
  for (let i = 1; i < ladder.length; i++) {
    const added = ladder[i]!.filter((s) => !ladder[i - 1]!.some((p) => p.key === s.key));
    assert.equal(added.length, 1, `step ${i} adds one slot`);
  }
  const second = loadoutSlots('phantom', { 1: 'extended', 2: 'secondWind', 3: 'dash' }, 'dash');
  assert.equal(second.length, 4, 'a second evolve changes the gun slot, it does not add one');
  assert.equal(second[0]!.key, 'gun:phantom');
  assert.match(second[0]!.kindLabel, /evolution 2 of 2/);
});

test('every slot has a short label, a name and what it does', () => {
  const slots = loadoutSlots('phantom', { 1: 'quickReload', 2: 'steadyHands', 3: 'healPole' }, 'healPole');
  for (const s of slots) {
    assert.ok(s.label.length > 0 && s.label.length <= 10, `${s.key} has a short label (${s.label})`);
    assert.ok(s.name.length > 0 && s.desc.length > 0 && s.kindLabel.length > 0);
  }
  assert.deepEqual(slots.map((s) => s.kindLabel.split(' · ')[0]), ['Gun', 'Attachment', 'Perk', 'Ability']);
});

test('the progress line says what is next and how far, in words', () => {
  assert.deepEqual(progressLine(0, 120, null), { level: 1, text: 'Next: Attachment · 120 / 220', next: 'Attachment', frac: 120 / 220, pick: false });
  assert.equal(progressLine(1, 300, null).text, 'Next: Evolve · 300 / 450');
  assert.equal(progressLine(3, 760, null).text, 'Next: Ability · 760 / 900');
  assert.equal(progressLine(3, 760, { level: 3, k: 'perk', tier: 2 }).text, 'Pick a perk', 'a waiting pick says so');
  assert.deepEqual(progressLine(5, 1340, null), { level: 6, text: 'Score 1340', next: null, frac: 1, pick: false });
});

test('tiles sit in a row, the gun tile wider for its side profile', () => {
  const boxes = slotBoxes(loadoutSlots('skirmisher', { 1: 'extended' }, null), 10, 20);
  assert.deepEqual(boxes, [{ x: 10, y: 20, w: TILE.gunW, h: TILE.h }, { x: 10 + TILE.gunW + TILE.gap, y: 20, w: TILE.w, h: TILE.h }]);
});

// ---- Drawn through the real HUD into a recording context ----

const player = (id: number, over: Partial<PlayerView> = {}): PlayerView => ({
  id, name: `player${id}`, x: 100 * id, y: 0, angle: 0, hp: 100, maxHp: 100, color: 'red', gun: 'pistol',
  team: null, alive: true, hidden: false, shield: false, dashing: false, score: 0, level: 0, armorTier: 'none', hunted: false, kind: 'bot', ...over,
});

const snap = (o: { me?: Partial<PlayerView>; self?: Partial<SelfView>; mode?: ModeId } = {}): Snapshot => ({
  t: 'snap', tick: 1, ackSeq: 0,
  self: { id: 1, ammo: 30, mag: 30, speed: 300, reloading: false, reloadFrac: 0, perks: {}, pending: null, ability: null, abilityReadyIn: 0, alive: true, dash: null, respawnIn: 0, kills: 0, deaths: 0, viewRadius: 900, suppression: 0, streak: 0, nemesis: null, ...o.self },
  players: [player(1, { gun: 'smg', ...o.me })], bullets: [], crates: [], thrown: [], zones: [], minimap: [],
  leaderboard: Array.from({ length: 14 }, (_, i): LeaderRow => ({ id: i + 1, name: `Player${i + 1}`, score: 100 * i, kills: 14 - i, deaths: 0, team: o.mode === 'TDM' ? (i % 2 ? 'red' : 'blue') : null })),
  match: { mode: o.mode ?? 'FFA', map: 'Plaza', nextMap: 'Old Town', mapChangeIn: 0, teamScore: { red: 0, blue: 0 }, winner: null, restartIn: 0, roundEndsAt: null }, events: [],
} as unknown as Snapshot);

type Drawn = { text: string; x: number; y: number };
function draw(frame: Snapshot, opts: { w?: number; h?: number; now?: number; cursor?: { x: number; y: number } } = {}): Drawn[] {
  const drawn: Drawn[] = [];
  const ctx = new Proxy({} as Record<string | symbol, unknown>, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'fillText') return (text: string, x: number, y: number) => drawn.push({ text, x, y });
      if (prop === 'measureText') return (text: string) => ({ width: text.length * 7 });
      if (prop === 'getTransform') return () => ({ a: 1 });
      if (typeof prop === 'string' && prop.startsWith('create')) return () => ({ addColorStop() {} });
      return () => {};
    },
    set(target, prop, value) { target[prop] = value; return true; },
  }) as unknown as CanvasRenderingContext2D;
  Object.assign(globalThis, { Path2D: class {} });
  const feed = Array.from({ length: 5 }, (_, i) => ({ e: 'kill', killer: `Killer${i}`, victim: `Victim${i}`, weapon: 'SMG', killerId: 20 + i, victimId: 30 + i, bounty: false, assisters: [], ended: 0, revenge: false, at: (opts.now ?? 1000) - 100 }));
  const s = { myId: 1, worldSize: 3000, walls: [], lastSelf: { x: 100, y: 0 }, feedback: NO_FEEDBACK, moments: NO_MOMENTS, feed, snaps: EMPTY_BUFFER } as unknown as Session;
  const w = opts.w ?? 1280, h = opts.h ?? 800;
  drawHud(ctx, 1, makeCamera(s.lastSelf, w, h, WORLD.viewRadius), frame, s, opts.now ?? 1000, opts.cursor ?? { x: w / 2, y: h / 2 }, opts.cursor ? 0.05 : null, true);
  return drawn;
}

const ALL = { me: { gun: 'phantom' as const, level: 5, score: 1340, hunted: true }, self: { perks: { 1: 'extended', 2: 'secondWind', 3: 'dash' } as SelfView['perks'], ability: 'dash' as const, streak: 6 } };

test('drawn with nothing unlocked, the HUD shows the progress line and no slots', () => {
  const texts = draw(snap({ me: { level: 0, score: 120 } })).map((d) => d.text);
  assert.deepEqual(drawnLoadout().slots, []);
  assert.ok(texts.includes('Attachment · 120 / 220'), 'the next unlock in words');
  assert.ok(!texts.some((t) => /^at \d+$/.test(t)), 'no "at 900" lock note');
});

test('each unlock draws exactly its slot, labelled', () => {
  let now = 5000;
  const steps: [Partial<PlayerView>, Partial<SelfView>, string[]][] = [
    [{ level: 0, score: 0 }, {}, []],
    [{ level: 1, score: 230 }, { perks: { 1: 'extended' } }, ['Ext. mag']],
    [{ level: 2, score: 460, gun: 'skirmisher' }, { perks: { 1: 'extended' } }, ['Skirmisher', 'Ext. mag']],
    [{ level: 3, score: 720, gun: 'skirmisher' }, { perks: { 1: 'extended', 2: 'secondWind' } }, ['Skirmisher', 'Ext. mag', '2nd wind']],
    [{ level: 4, score: 910, gun: 'skirmisher' }, { perks: { 1: 'extended', 2: 'secondWind', 3: 'dash' }, ability: 'dash' }, ['Skirmisher', 'Ext. mag', '2nd wind', 'Dash']],
  ];
  for (const [me, self, labels] of steps) {
    now += 1000;
    const texts = draw(snap({ me, self }), { now }).map((d) => d.text);
    assert.deepEqual(drawnLoadout().slots.map((s) => s.label), labels);
    for (const l of labels) assert.ok(texts.includes(l), `the label "${l}" is drawn`);
  }
});

test('the ability slot shows its cooldown in seconds, and its key once ready', () => {
  const cooling = draw(snap({ me: ALL.me, self: { ...ALL.self, abilityReadyIn: 2100 } }), { now: 9000 }).map((d) => d.text);
  assert.ok(cooling.includes('2.1'), 'the seconds left over the sweep');
  const ready = draw(snap({ me: ALL.me, self: { ...ALL.self, abilityReadyIn: 0 } }), { now: 9100 }).map((d) => d.text);
  assert.ok(!ready.includes('2.1') && ready.includes('SPACE'), 'ready: no count, the key lit');
});

test('hovering a tile names it and says what it does', () => {
  draw(snap(ALL), { now: 10_000 });
  const perk = drawnLoadout().slots.find((s) => s.kind === 'perk')!;
  const texts = draw(snap(ALL), { now: 10_050, cursor: { x: perk.x + perk.w / 2, y: perk.y + perk.h / 2 } }).map((d) => d.text);
  assert.ok(texts.includes('Second wind') && texts.includes('Perk'), 'its name and kind');
  assert.ok(drawnLoadout().card !== null);
});

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

test('the strip never overlaps the scoreboard, kill feed, timer, team banner, minimap or health cross on desktop sizes', () => {
  for (const [w, h] of [[1280, 720], [1366, 768], [1440, 900], [1600, 900], [1920, 1080], [2560, 1440], [3840, 2160]] as const) {
    for (const mode of ['FFA', 'TDM'] as const) {
      const texts = draw(snap({ ...ALL, mode }), { w, h, now: 20_000 });
      const k = hudScaleFor(w, h, false);
      const strip = drawnLoadout();
      const boxes = [strip.rank!, ...strip.slots];
      const others = drawnPanels();
      for (const id of ['board', 'minimap', 'score'] as const) {
        const o = others[id]!;
        assert.ok(o, `${id} drawn`);
        const scaled = { x: o.x * k, y: o.y * k, w: o.w * k, h: o.h * k };
        for (const b of boxes) assert.ok(!overlaps(b, scaled), `${w}x${h} ${mode}: strip clear of the ${id}`);
      }
      // The feed is right-aligned under the board: every feed name sits right of the strip.
      const right = Math.max(...boxes.map((b) => b.x + b.w));
      for (const t of texts.filter((d) => /^(Killer|Victim)\d$/.test(d.text))) assert.ok(t.x * k > right, `${w}x${h}: feed clear of the strip`);
      const cross = { x: 0, y: h - (16 + HEALTH.size + 6) * k, w: (16 + HEALTH.size + 6) * k, h: (16 + HEALTH.size + 6) * k };
      for (const b of boxes) assert.ok(!overlaps(b, cross), `${w}x${h}: strip clear of the health cross`);
    }
  }
});
