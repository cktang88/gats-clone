import { COLOR_IDS, COLORS, NIGHTS, type ColorId } from '../shared/defs.ts';
import { rankRows, type LeaderRow, type Snapshot } from '../shared/protocol.ts';
import { roundPodium } from './derive.ts';

/** Pure data for the round-end celebration: who stood where, and the MVP cards, read from what the client saw during the round. */

type Seen = { name: string; color: ColorId; team: ColorId | null; armor: 'none' | 'light' | 'medium' | 'heavy' };
export type Tracker = {
  map: string; hadWinner: boolean;
  seen: Map<number, Seen>; pos: Map<number, { x: number; y: number }>;
  streak: Map<number, number>; best: Map<number, number>; medals: Map<number, number>;
  longest: { id: number; victim: string; dist: number } | null;
};
export const newTracker = (map = ''): Tracker => ({ map, hadWinner: false, seen: new Map(), pos: new Map(), streak: new Map(), best: new Map(), medals: new Map(), longest: null });

/** Folds one snapshot into the round's running record; a new map or a finished celebration starts a clean one. */
export function trackSnap(t: Tracker, snap: Snapshot): Tracker {
  const winner = snap.match.winner !== null || snap.run?.phase === 'over';
  if (snap.match.map !== t.map || (t.hadWinner && !winner)) t = newTracker(snap.match.map);
  t.hadWinner = winner;
  const here = new Map(snap.players.map((p) => [p.id, p]));
  for (const p of snap.players) t.seen.set(p.id, { name: p.name, color: p.color, team: p.team, armor: p.armorTier });
  const at = (id: number) => { const p = here.get(id); return p ? { x: p.x, y: p.y } : t.pos.get(id); };
  for (const e of snap.events) {
    if (e.e === 'medal') t.medals.set(e.id, (t.medals.get(e.id) ?? 0) + 1);
    if (e.e !== 'kill') continue;
    t.streak.set(e.victimId, 0);
    if (e.killerId === null || e.killerId === e.victimId) continue;
    const run = (t.streak.get(e.killerId) ?? 0) + 1;
    t.streak.set(e.killerId, run);
    if (run > (t.best.get(e.killerId) ?? 0)) t.best.set(e.killerId, run);
    const a = at(e.killerId), b = at(e.victimId);
    if (a && b) {
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (!t.longest || dist > t.longest.dist) t.longest = { id: e.killerId, victim: e.victim, dist };
    }
  }
  for (const p of snap.players) t.pos.set(p.id, { x: p.x, y: p.y });
  return t;
}

export type Stander = { id: number; name: string; color: string; armor: Seen['armor']; kills: number };
export type Card = { label: string; value: string; who: string; color: string | null };
export type Celebration = {
  kind: 'ffa' | 'team' | 'zomWin' | 'zomLoss';
  /** The colour the confetti floods with; null when there is nothing to cheer. */
  confetti: string[] | null;
  title: string; sub: string;
  podium: Stander[];
  /** The stamp on your result. */
  stamp: { text: string; top3: boolean; sub: string };
  cards: Card[];
};

export const ordinal = (n: number): string => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'TH' : (['TH', 'ST', 'ND', 'RD'][n % 10] ?? 'TH')}`;
const colorFor = (t: Tracker, id: number, team: ColorId | null): string => COLORS[team ?? t.seen.get(id)?.color ?? COLOR_IDS[id % COLOR_IDS.length]!];
export const METRES_PER_PX = 1 / 48;
const metres = (px: number) => `${Math.round(px * METRES_PER_PX)} m`;

/** Confetti in a winner's colour: the paint, a lit and a shaded step of it, and bone for paper. Team colour only ever goes to the winners. */
export const confettiFor = (hex: string): string[] => [hex, hex, '#ece6d6', hex];

export function celebrationFor(snap: Snapshot, t: Tracker): Celebration | null {
  if (snap.royale) return null;
  const me = snap.self.id;
  if (snap.run) {
    const report = snap.run.report;
    if (snap.run.phase !== 'over' || !report) return null;
    const ranked = [...report.players].sort((a, b) => b.kills - a.kills);
    const idOf = (name: string) => [...t.seen].find(([, s]) => s.name === name)?.[0] ?? 0;
    const podium = ranked.slice(0, 3).map((p) => ({ id: idOf(p.name), name: p.name, color: colorFor(t, idOf(p.name), null), armor: t.seen.get(idOf(p.name))?.armor ?? 'light', kills: p.kills }));
    const top = (f: (p: (typeof ranked)[number]) => number, unit: string): Card => {
      const best = [...ranked].sort((a, b) => f(b) - f(a))[0];
      return best && f(best) > 0 ? { label: '', value: `${f(best)}${unit}`, who: best.name, color: colorFor(t, idOf(best.name), null) } : { label: '', value: '-', who: 'nobody', color: null };
    };
    const turrets = Object.values(report.turretKills).reduce((a, b) => a + b, 0);
    const cards = [{ ...top((p) => p.kills, ''), label: 'MOST KILLS' }, { ...top((p) => p.revives, ''), label: 'MOST REVIVES' }, { ...top((p) => p.built, ''), label: 'MOST BUILT' },
      { label: 'TURRET KILLS', value: String(turrets), who: 'the squad', color: null }];
    const mineIdx = ranked.findIndex((p) => p.name === snap.players.find((q) => q.id === me)?.name);
    return report.won
      ? { kind: 'zomWin', confetti: ['#ffb347', '#b4a07a', '#ece6d6', '#ffd34d'], title: 'THE TIDE HELD', sub: `The core fell on night ${report.night}, ${report.night - NIGHTS.length} past the Tide`, podium, stamp: { text: 'HELD', top3: true, sub: mineIdx >= 0 ? `${ordinal(mineIdx + 1)} in kills` : `night ${report.night}` }, cards }
      : { kind: 'zomLoss', confetti: null, title: 'OVERRUN', sub: `The horde took the core on night ${report.night}`, podium, stamp: { text: 'FALLEN', top3: false, sub: mineIdx >= 0 ? `${ordinal(mineIdx + 1)} in kills` : '' }, cards };
  }
  const { winner } = snap.match;
  if (winner === null) return null;
  const ranked = rankRows(snap.leaderboard);
  const { rows } = roundPodium(snap.match, snap.leaderboard, 3);
  const team = snap.match.mode === 'FFA' ? null : snap.match.teamScore.red >= snap.match.teamScore.blue ? 'red' : 'blue';
  const stand = (r: LeaderRow): Stander => ({ id: r.id, name: r.name, color: colorFor(t, r.id, r.team), armor: t.seen.get(r.id)?.armor ?? 'light', kills: r.kills });
  const podium = rows.map(stand);
  const mine = ranked.findIndex((r) => r.id === me);
  const myTeam = snap.players.find((p) => p.id === me)?.team ?? null;
  const who = (id: number | undefined, fallback: string) => (id === undefined ? { who: fallback, color: null } : { who: t.seen.get(id)?.name ?? ranked.find((r) => r.id === id)?.name ?? fallback, color: colorFor(t, id, null) });
  const best = (m: Map<number, number>) => [...m].sort((a, b) => b[1] - a[1])[0];
  const topKills = ranked[0], streak = best(t.best), medal = best(t.medals);
  const cards: Card[] = [
    { label: 'MOST KILLS', value: topKills ? String(topKills.kills) : '-', ...(topKills ? { who: topKills.name, color: colorFor(t, topKills.id, topKills.team) } : { who: 'nobody', color: null }) },
    { label: 'BEST STREAK', value: streak ? String(streak[1]) : '-', ...who(streak?.[0], 'nobody') },
    { label: 'MOST MEDALS', value: medal ? String(medal[1]) : '-', ...who(medal?.[0], 'nobody') },
    { label: 'LONGEST SHOT', value: t.longest ? metres(t.longest.dist) : '-', ...who(t.longest?.id, 'nobody') },
  ];
  if (snap.match.mode === 'FFA') {
    const place = mine + 1;
    return { kind: 'ffa', confetti: confettiFor(podium[0]?.color ?? COLORS.orange), title: `${winner.name} wins the round`.toUpperCase(), sub: winner.note ?? '', podium,
      stamp: { text: place > 0 ? ordinal(place) : 'SPECTATOR', top3: place > 0 && place <= 3, sub: place > 0 ? `of ${ranked.length}` : '' }, cards };
  }
  const won = myTeam !== null && myTeam === team;
  const { red, blue } = snap.match.teamScore;
  return { kind: 'team', confetti: confettiFor(COLORS[team!]), title: `${winner.name} wins the round`.toUpperCase(), sub: `${snap.match.mode === 'DOM' ? 'Zones' : 'Kills'}: Red ${red} · Blue ${blue}`, podium,
    stamp: { text: myTeam === null ? 'SPECTATOR' : won ? 'VICTORY' : 'DEFEAT', top3: won, sub: mine >= 0 ? `${ordinal(mine + 1)} overall` : '' }, cards };
}
