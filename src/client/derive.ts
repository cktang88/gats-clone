import { GUNS, LEVELS, PERK_INFO, WORLD, type GunId, type ModeId, type PerkId, type Tier } from '../shared/defs.ts';
import { MAP_MS } from '../shared/maps.ts';
import { rankRows, type GameEvent, type LeaderRow, type MatchView, type PlayerView, type Snapshot, type Team } from '../shared/protocol.ts';
import type { ClientState } from './state.ts';

type LevelProgress = { displayLevel: number; frac: number; nextAt: number | null };

export function levelProgress(serverLevel: number, score: number): LevelProgress {
  const from = LEVELS[serverLevel]?.score ?? 0;
  const to = LEVELS[serverLevel + 1]?.score;
  const displayLevel = serverLevel + 1;
  if (to === undefined) return { displayLevel, frac: 1, nextAt: null };
  return { displayLevel, frac: Math.min(1, Math.max(0, (score - from) / (to - from))), nextAt: to };
}

export type KillEvent = Extract<GameEvent, { e: 'kill' }>;

export const killOf = (events: readonly GameEvent[], victimId: number): KillEvent | null =>
  events.find((ev): ev is KillEvent => ev.e === 'kill' && ev.victimId === victimId) ?? null;

/** What a death took away: the displayed level, the evolved gun (null for a class gun) and the perks, read from the last snapshot of the life. */
export type Loss = { level: number; gun: GunId | null; perks: PerkId[] };

const TIERS: readonly Tier[] = [1, 2, 3];

export function lossOf(snap: Snapshot): Loss | null {
  const me = selfOf(snap);
  if (!me?.alive) return null;
  const perks = TIERS.flatMap((t) => snap.self.perks[t] ?? []);
  return { level: me.level + 1, gun: GUNS[me.gun].stage > 0 ? me.gun : null, perks };
}

export function deathText(kill: KillEvent | null, loss: Loss | null): { title: string; cause: string; lost: string } {
  const title = kill?.killer ? `Eliminated by ${kill.killer}` : 'You were eliminated';
  const weapon = kill?.weapon ?? '';
  const cause = !weapon ? '' : `${kill?.killer ? `with ${weapon}` : weapon}${kill?.bounty ? ` · your bounty paid them ${WORLD.bountyScore}` : ''}`;
  const parts = loss ? [...(loss.level > 1 ? [`level ${loss.level}`] : []), ...(loss.gun ? [GUNS[loss.gun].name] : []), ...loss.perks.map((p) => PERK_INFO[p].name)] : [];
  return { title, cause, lost: parts.length ? `Lost ${parts.join(' · ')}` : '' };
}

export const feedMentions = (kill: { killerId: number | null; victimId: number }, myId: number): boolean =>
  kill.killerId === myId || kill.victimId === myId;

export const selfOf = (snap: Snapshot): PlayerView | undefined => snap.players.find((p) => p.id === snap.self.id);

/** m:ss, rounded up so it reads 0:00 only once the time is up. */
export function clock(ms: number): string {
  const s = seconds(ms);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Ms left on the round's clock, or null when it has none or the server's clock is not known yet. */
export const roundTimeLeft = (match: Pick<MatchView, 'roundEndsAt'>, serverNow: number | null): number | null =>
  match.roundEndsAt === null || serverNow === null ? null : Math.max(0, match.roundEndsAt - serverNow);

/** `most kills · 4:12 left` while the clock runs, `most kills in 6:00` before it is known. */
export const mostKillsText = (leftMs: number | null): string =>
  leftMs === null ? `most kills in ${clock(MAP_MS.FFA)}` : `most kills · ${clock(leftMs)} left`;

export function objectiveFor(mode: ModeId, team: Team, leftMs: number | null): { banner: string; line: string } {
  const side = team ?? 'no';
  const Side = side[0]!.toUpperCase() + side.slice(1);
  const FFA_GOAL = `${mostKillsText(leftMs)} · first player to ${WORLD.ffaWinKills} ends it`;
  const orMost = (ms: number) => (leftMs === null ? `or most in ${clock(ms)}` : `· ${clock(leftMs)} left`);
  const TDM_GOAL = `first to ${WORLD.tdmWinScore} kills ${orMost(MAP_MS.TDM)}`;
  const DOM_GOAL = `first to ${WORLD.domWinScore} ${orMost(MAP_MS.DOM)}`;
  switch (mode) {
    case 'FFA':
      return { banner: `Free for all: ${FFA_GOAL}`, line: `FFA · ${FFA_GOAL}` };
    case 'TDM':
      return {
        banner: `Team Deathmatch: you are ${side.toUpperCase()}, ${TDM_GOAL}`,
        line: `TDM · ${Side} team · ${TDM_GOAL}`,
      };
    case 'DOM':
      return {
        banner: `Domination: you are ${side.toUpperCase()}, hold A B C, ${DOM_GOAL}`,
        line: `DOM · ${Side} team · hold A B C · ${DOM_GOAL}`,
      };
    case 'ZOM':
      return { banner: 'Zombies: build walls and turrets by day, hold the Bastion by night', line: 'ZOM · defend the Bastion' };
    case 'BR':
      return { banner: 'Last Standing: everyone for themselves, loot caches and be the last one standing', line: 'BR · solo · last one standing' };
    case 'RNG':
      return { banner: 'Shooting range: practice on the targets, press L to change your loadout', line: 'RNG · practice · nothing here counts toward your record' };
  }
}


/** The half-angle, in radians, a shot can stray from the aim right now. */

type Pt = { x: number; y: number };

/** Where the bearing from `from` to an off-screen `to` crosses the screen rect shrunk by `inset`, or null when `to` is inside it. */
export function edgePoint(from: Pt, to: Pt, w: number, h: number, inset: number): (Pt & { angle: number }) | null {
  const x0 = inset, x1 = w - inset, y0 = inset, y1 = h - inset;
  if (to.x >= x0 && to.x <= x1 && to.y >= y0 && to.y <= y1) return null;
  const dx = to.x - from.x, dy = to.y - from.y;
  const tx = dx > 0 ? (x1 - from.x) / dx : dx < 0 ? (x0 - from.x) / dx : Infinity;
  const ty = dy > 0 ? (y1 - from.y) / dy : dy < 0 ? (y0 - from.y) / dy : Infinity;
  const t = Math.min(tx, ty);
  return { x: from.x + dx * t, y: from.y + dy * t, angle: Math.atan2(dy, dx) };
}

export const seconds =(ms: number) => Math.max(0, Math.ceil(ms / 1000));

export type Rect = { x: number; y: number; w: number; h: number };

/** Pulls `to` back along the ray from `from` until it sits outside every rect grown by `pad`, so an edge marker keeps its bearing without landing on a HUD panel. */
export function clearOfRects(from: Pt, to: Pt, rects: readonly Rect[], pad: number): Pt {
  const dx = to.x - from.x, dy = to.y - from.y;
  let t = 1;
  for (const r of rects) {
    const x0 = r.x - pad, x1 = r.x + r.w + pad, y0 = r.y - pad, y1 = r.y + r.h + pad;
    if (from.x > x0 && from.x < x1 && from.y > y0 && from.y < y1) continue;
    let enter = 0, exit = 1;
    for (const [d, lo, hi, o] of [[dx, x0, x1, from.x], [dy, y0, y1, from.y]] as const) {
      if (d === 0) { if (o < lo || o > hi) { enter = 1; exit = 0; } continue; }
      const a = (lo - o) / d, b = (hi - o) / d;
      enter = Math.max(enter, Math.min(a, b));
      exit = Math.min(exit, Math.max(a, b));
    }
    if (enter <= exit && enter < t) t = enter;
  }
  return { x: from.x + dx * t, y: from.y + dy * t };
}

export const OBJECTIVE_MS = 4000;

/** Long enough for a held or spammed trigger click to land before the death screen takes clicks, so it cannot repick the loadout. */
export const DEATH_ARM_MS = 700;
export const deathScreenArmed = (openedAt: number, now: number): boolean => now - openedAt >= DEATH_ARM_MS;

export const mapNotice = (match: Pick<MatchView, 'nextMap' | 'mapChangeIn'>): string | null =>
  match.mapChangeIn > 0 ? `Next map: ${match.nextMap} in ${seconds(match.mapChangeIn)}s` : null;

/** The round the objective banner last introduced (mode, map and team), and when. */
export type ObjectiveSeen = { key: string | null; at: number };
export const NO_OBJECTIVE_SEEN: ObjectiveSeen = { key: null, at: -Infinity };

/** Introduces each round once: a respawn into the same round keeps the old time, so the banner stays gone. A shown winner forgets the round, so the next one is introduced even on the same map. */
export function nextObjectiveSeen(seen: ObjectiveSeen, phase: ClientState['phase'], match: Pick<MatchView, 'mode' | 'map' | 'winner'>, team: Team, now: number): ObjectiveSeen {
  if (match.winner !== null) return seen.key === null ? seen : { ...seen, key: null };
  if (phase !== 'playing') return seen;
  const key = `${match.mode}|${match.map}|${team}`;
  return key === seen.key ? seen : { key, at: now };
}

export const objectiveVisible =(phase: ClientState['phase'], match: Pick<MatchView, 'winner'>, msSincePlaying: number): boolean =>
  phase === 'playing' && match.winner === null && msSincePlaying < OBJECTIVE_MS;

export const topScorers = (rows: readonly LeaderRow[], count: number): LeaderRow[] => rankRows(rows).slice(0, count);

const BOARD_TOP = 5;

export function boardRows(rows: readonly LeaderRow[], myId: number, full: number | null, top = BOARD_TOP): { place: number; row: LeaderRow }[] {
  const ranked = rankRows(rows).map((row, i) => ({ place: i + 1, row }));
  if (full !== null) return ranked.slice(0, full);
  const mine = ranked.find((r) => r.row.id === myId);
  return mine && mine.place > top ? [...ranked.slice(0, top), mine] : ranked.slice(0, top);
}

/** The round-end podium: the winning team's best in team modes, with the final team score; in FFA the winner, then everyone else's best. */
export function roundPodium(match: MatchView, rows: readonly LeaderRow[], count: number): { rows: LeaderRow[]; score: string | null } {
  if (match.mode === 'FFA') {
    const ranked = rankRows(rows);
    const winner = ranked.find((r) => r.id === match.winner?.id);
    return { rows: (winner ? [winner, ...ranked.filter((r) => r !== winner)] : ranked).slice(0, count), score: null };
  }
  const { red, blue } = match.teamScore;
  const won: Team = red >= blue ? 'red' : 'blue';
  return { rows: topScorers(rows.filter((r) => r.team === won), count), score: `Red ${red} · Blue ${blue}` };
}
