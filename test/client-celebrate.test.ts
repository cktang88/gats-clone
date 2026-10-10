import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GameEvent, LeaderRow, PlayerView, Snapshot } from '../src/shared/protocol.ts';
import { COLORS } from '../src/shared/defs.ts';
import { celebrationFor, newTracker, ordinal, trackSnap } from '../src/client/celebratedata.ts';

const pv = (id: number, x: number, y: number, over: Partial<PlayerView> = {}): PlayerView => ({
  id, name: `P${id}`, x, y, angle: 0, hp: 100, maxHp: 100, color: 'blue', gun: 'pistol', team: null, alive: true, hidden: false, shield: false, dashing: false,
  score: 0, level: 0, armorTier: 'light', kind: 'human', hunted: false, ...over,
} as PlayerView);
const kill = (killerId: number, victimId: number): GameEvent => ({ e: 'kill', killer: `P${killerId}`, victim: `P${victimId}`, killerId, victimId, weapon: 'Pistol', bounty: false, assisters: [], ended: 0, revenge: false });
const row = (id: number, kills: number, team: LeaderRow['team'] = null): LeaderRow => ({ id, name: `P${id}`, score: 0, kills, deaths: 0, team });
function snap(over: { players?: PlayerView[]; events?: GameEvent[]; mode?: 'FFA' | 'TDM'; winner?: boolean; rows?: LeaderRow[]; self?: number; teamScore?: { red: number; blue: number } }): Snapshot {
  return {
    t: 'snap', tick: 1, ackSeq: 0, self: { id: over.self ?? 1 }, players: over.players ?? [], events: over.events ?? [], leaderboard: over.rows ?? [], bullets: [], crates: [], thrown: [], zones: [], minimap: [],
    match: { mode: over.mode ?? 'FFA', map: 'm', nextMap: 'n', mapChangeIn: 0, teamScore: over.teamScore ?? { red: 0, blue: 0 }, winner: over.winner ? { name: 'P1', id: 1, note: null } : null, restartIn: over.winner ? 8000 : 0, roundEndsAt: null },
  } as unknown as Snapshot;
}

test('ordinals', () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22].map(ordinal), ['1ST', '2ND', '3RD', '4TH', '11TH', '12TH', '13TH', '21ST', '22ND']);
});

test('the tracker keeps streaks, medals and the longest shot, and starts clean after a celebration', () => {
  let t = newTracker();
  t = trackSnap(t, snap({ players: [pv(1, 0, 0), pv(2, 480, 0), pv(3, 100, 0)], events: [kill(1, 2), kill(1, 3), { e: 'medal', id: 1, medal: 'doubleKill' }] }));
  t = trackSnap(t, snap({ players: [pv(1, 0, 0), pv(2, 480, 0), pv(3, 100, 0)], events: [kill(3, 1), kill(1, 2)] }));
  assert.equal(t.best.get(1), 2, 'two in a row, then killed, then one more: best stays 2');
  assert.equal(t.streak.get(1), 1);
  assert.equal(t.medals.get(1), 1);
  assert.equal(Math.round(t.longest!.dist), 480);
  assert.equal(t.longest!.id, 1);
  t = trackSnap(t, snap({ players: [pv(1, 0, 0)], winner: true }));
  t = trackSnap(t, snap({ players: [pv(1, 0, 0)] }));
  assert.equal(t.best.size, 0, 'the next round starts from nothing');
});

test('an FFA round end puts the winner first, stamps your place and floods confetti in the winner\'s colour', () => {
  let t = newTracker();
  const players = [pv(1, 0, 0, { color: 'green' }), pv(2, 50, 0, { color: 'red' }), pv(3, 90, 0), pv(4, 120, 0)];
  const rows = [row(2, 12), row(1, 20), row(3, 5), row(4, 1)];
  t = trackSnap(t, snap({ players, rows, winner: true, self: 4 }));
  const c = celebrationFor(snap({ players, rows, winner: true, self: 4 }), t)!;
  assert.equal(c.kind, 'ffa');
  assert.deepEqual(c.podium.map((p) => p.id), [1, 2, 3]);
  assert.equal(c.podium[0]!.color, COLORS.green);
  assert.deepEqual(c.stamp, { text: '4TH', top3: false, sub: 'of 4' });
  assert.ok(c.confetti!.includes(COLORS.green) && !c.confetti!.includes(COLORS.red));
  assert.deepEqual(c.cards.map((k) => k.label), ['MOST KILLS', 'BEST STREAK', 'MOST MEDALS', 'LONGEST SHOT']);
  assert.equal(c.cards[0]!.value, '20');
});

test('a team win floods the winning team\'s colour for everyone, and stamps victory or defeat', () => {
  const players = [pv(1, 0, 0, { team: 'red', color: 'red' }), pv(2, 50, 0, { team: 'blue', color: 'blue' })];
  const rows = [row(1, 9, 'red'), row(2, 4, 'blue')];
  const base = { players, rows, winner: true, mode: 'TDM' as const, teamScore: { red: 150, blue: 90 } };
  const t = trackSnap(newTracker(), snap(base));
  const win = celebrationFor(snap({ ...base, self: 1 }), t)!;
  const lose = celebrationFor(snap({ ...base, self: 2 }), t)!;
  assert.equal(win.stamp.text, 'VICTORY');
  assert.equal(lose.stamp.text, 'DEFEAT');
  assert.ok(lose.confetti!.includes(COLORS.red), 'the loser still sees the winners\' confetti');
  assert.deepEqual(win.podium.map((p) => p.id), [1]);
});

test('no celebration without a winner, or in Last Standing', () => {
  const t = newTracker();
  assert.equal(celebrationFor(snap({ players: [pv(1, 0, 0)] }), t), null);
  const br = { ...snap({ winner: true }), royale: {} } as unknown as Snapshot;
  assert.equal(celebrationFor(br, t), null);
});
