import { BUILDING_KINDS, BUILDINGS, hordeCount, isEndless, MAX_LEVEL, NIGHTS, nightOf, SIDES, TURRET_KINDS, WALL_TIERS, WORLD, ZOM, ZOMBIE_KINDS, ZOMBIES, type BuildingKind } from '../shared/defs.ts';
import type { BuildingView, PlayerView, RunReport, RunView, Snapshot, WallView } from '../shared/protocol.ts';
import { buildRefusal, cellOf, coreRectAt, costOf, levelOf, lineCells, maxLevelOf, nameOf as nameAt, planLine, refundFor, serviceTarget, upgradeCost, upgradeRefusal, type BuildRefusal, type BuildSite, type UpgradeRefusal } from '../shared/sim/build.ts';
import { clock } from './derive.ts';

type Pose = { x: number; y: number };

/** Past the Tide the nights never end, and the HUD says so: `Night 12 · Endless`. */
const endlessTag = (night: number) => (isEndless(night) ? ' · Endless' : '');

export function phaseLine(run: Pick<RunView, 'phase' | 'night' | 'phaseEndsAt' | 'waveLeft' | 'report'>, serverNow: number | null): string {
  const left = run.phaseEndsAt === null || serverNow === null ? null : run.phaseEndsAt - serverNow;
  switch (run.phase) {
    case 'day': return `Day ${run.night}${endlessTag(run.night)}${left === null ? '' : ` · night in ${clock(left)}`}`;
    case 'night': return `Night ${run.night}${endlessTag(run.night)} · ${run.waveLeft} left${left === null ? '' : ` · first light in ${clock(left)}`}`;
    case 'over': return `The Bastion fell${run.report?.won ? ' · the Tide held' : ''}${left === null ? '' : ` · next run in ${clock(left)}`}`;
  }
}

const listOf = (xs: readonly string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

const sidesOf = (night: number) => {
  const from = nightOf(night).from;
  return from.length === SIDES.length ? 'every side' : `the ${listOf(from)}`;
};

export const squadShare = (players: readonly Pick<PlayerView, 'kind'>[]) =>
  ZOM.hordeShare({ humans: players.filter((p) => p.kind === 'human').length, bots: players.filter((p) => p.kind !== 'human').length });

/** What a night brings for a squad with this `share` of the horde and from where, by the night table: the deadliest kinds first, by what each pays, then how many in all. */
export function forecast(night: number, share: number): string {
  const def = nightOf(night);
  const present = ZOMBIE_KINDS.filter((k) => def.horde[k]).sort((a, b) => ZOMBIES[b].score - ZOMBIES[a].score);
  const kinds = listOf(present.map((k) => ZOMBIES[k].many));
  const size = present.reduce((n, k) => n + hordeCount(k, def.horde[k]!, share), 0);
  return `${isEndless(night) ? 'Endless · ' : ''}${kinds[0]!.toUpperCase()}${kinds.slice(1)} from ${sidesOf(night)} · ${size} strong`;
}

/** The day's hint for N: how many of the squad's humans are ready for night, and whether you are. */
export function readyHint(run: Pick<RunView, 'ready'>, players: readonly Pick<PlayerView, 'id' | 'kind' | 'alive'>[], selfId: number): string {
  const humans = players.filter((p) => p.kind === 'human' && p.alive);
  const ready = humans.filter((p) => run.ready.includes(p.id)).length;
  if (!run.ready.includes(selfId)) return humans.length > 1 ? `ready for night · ${ready}/${humans.length}` : 'bring the night now';
  return `ready · ${ready}/${humans.length} · N to wait`;
}

export function downedLine(down: NonNullable<PlayerView['downed']>, serverNow: number | null): string {
  if (down.revive > 0) return `Being revived · ${Math.round(down.revive * 100)}%`;
  return `Crawl to a squadmate${serverNow === null ? '' : ` · ${clock(down.bleedOutAt - serverNow)}`}`;
}

/** What a building is called in a line of text: a wall by its tier, anything else by its kind however far upgraded. */
const nameOf = (b: Pick<BuildingView, 'kind' | 'lv'>) => (b.kind === 'wall' ? nameAt('wall', levelOf(b)) : BUILDINGS[b.kind].name).toLowerCase();

/** What holding E would do right now: revive first, else what `serviceTarget` names, the rule the server tends by. */
export function useHint(snap: Snapshot, at: Pose): string | null {
  const run = snap.run;
  if (!run || !snap.self.alive) return null;
  const down = snap.players.find((p) => p.id !== snap.self.id && p.downed && Math.hypot(p.x - at.x, p.y - at.y) <= ZOM.reviveRange);
  if (down) return `Hold E to revive ${down.name}`;
  if (run.scrap <= 0) return null;
  const target = serviceTarget(at, run.core, snap.buildings ?? []);
  return target && `Hold E to ${target.job} the ${target.on === 'core' ? 'Bastion' : nameOf(target.on)}`;
}

/** The nearest building within reach that could go up a level, with what the step costs: what U does by day outside build mode. */
export function upgradeTarget(snap: Snapshot, at: Pose): { b: BuildingView; to: string; cost: number } | null {
  const run = snap.run;
  if (!run || run.phase !== 'day' || !snap.self.alive) return null;
  let best: { b: BuildingView; d: number } | null = null;
  for (const b of snap.buildings ?? []) {
    if (upgradeCost(b.kind, levelOf(b)) === null) continue;
    const d = Math.hypot((b.cx + 0.5) * ZOM.cell - at.x, (b.cy + 0.5) * ZOM.cell - at.y);
    if (d <= ZOM.reachPx && (!best || d < best.d)) best = { b, d };
  }
  return best && { b: best.b, to: nameAt(best.b.kind, levelOf(best.b) + 1), cost: upgradeCost(best.b.kind, levelOf(best.b))! };
}

export type RunCallout = { title: string; line: string; tone: 'night' | 'dawn' | 'warn' };
const NIGHT_WARNING_MS = 10_000;

/** The run's turning points between two snapshots; the fall has the report instead, timed on the server's clock (`prevAt`, `nextAt`). */
export function runCallouts(prev: RunView | undefined, next: RunView | undefined, prevAt: number, nextAt: number, share: number): RunCallout[] {
  if (!prev || !next) return [];
  const out: RunCallout[] = [];
  if (prev.phase === 'day' && next.phase === 'day' && prev.phaseEndsAt !== null && next.phaseEndsAt !== null
    && prev.phaseEndsAt - prevAt > NIGHT_WARNING_MS && next.phaseEndsAt - nextAt <= NIGHT_WARNING_MS) {
    out.push({ title: `Night falls in ${NIGHT_WARNING_MS / 1000}`, line: forecast(next.night, share), tone: 'warn' });
  }
  if (prev.phase === 'day' && next.phase === 'night') {
    out.push({ title: nightOf(next.night).name ?? `Night ${next.night}${endlessTag(next.night)}`, line: `${next.waveLeft} zombies from ${sidesOf(next.night)} · hold the Bastion`, tone: 'night' });
  }
  if (prev.phase === 'night' && next.phase === 'day') {
    const lost = next.lost ? `${next.lost} lost · ` : '';
    // Holding through the Tide is the run's great moment, but not its end: the nights go on until the core falls.
    if (prev.night === NIGHTS.length) out.push({ title: 'THE TIDE HELD', line: `${next.survivors} survivors saw the morning · the nights go on`, tone: 'dawn' });
    else out.push({ title: 'Dawn', line: `Night ${prev.night} held · ${lost}${next.survivors} survivors · +${next.scrap - prev.scrap} scrap`, tone: 'dawn' });
    out.push({ title: 'Tonight', line: forecast(next.night, share), tone: 'warn' });
  }
  return out;
}

type ReportRow = { name: string; kills: number; revives: number; built: number; you: boolean };

/** The report's table: most kills first, then most revives, so the squad's carry tops it. */
export const reportRows = (report: RunReport, selfName: string | undefined): ReportRow[] =>
  [...report.players].sort((a, b) => b.kills - a.kills || b.revives - a.revives || b.built - a.built).map((p) => ({ ...p, you: p.name === selfName }));

/** Only the core's fall ends a run; one that held through the Tide on the way says how far past it the squad got. */
export const reportTitle = (report: RunReport) =>
  report.won ? `The Tide held. The Bastion fell on night ${report.night}, ${report.night - NIGHTS.length} past the Tide.` : `The Bastion fell on night ${report.night}`;

/** The kills of the squad's turrets and the Bastion's survivors, or null when they killed none. */
export function turretLine(report: RunReport): string | null {
  const kills = [...TURRET_KINDS.map((t) => [BUILDINGS[t].name, report.turretKills[t]] as const), ['Bastion', report.bastionKills] as const]
    .filter(([, n]) => n > 0).map(([name, n]) => `${name} ${n}`);
  return kills.length ? `Defense kills · ${kills.join(' · ')}` : null;
}

/** The card for a squad player out of the fight: bled out, back from the Bastion after `respawnIn` ms at the cost of survivors, or joined mid-night and back at dawn. */
export function outTillDawnText(run: Pick<RunView, 'phase' | 'night' | 'waveLeft' | 'survivors'>, bledOut: boolean, respawnIn: number): { title: string; sub: string } {
  const cost = ZOM.reinforce.survivors(run.night);
  const sent = bledOut && run.phase === 'night' && run.survivors >= cost;
  return {
    title: bledOut ? 'You bled out' : 'The night is under way',
    sub: sent ? `The Bastion sends you back in ${Math.ceil(respawnIn / 1000)}s · ${cost} survivors lost`
      : run.phase === 'night' ? `Back at dawn · ${run.waveLeft} zombies left tonight` : 'Back at dawn',
  };
}

/** The wall rules' view of the world from one snapshot, with the builder where the client draws them. */
export function buildSiteOf(snap: Snapshot, walls: readonly WallView[], builder: Pose): BuildSite | null {
  const run = snap.run;
  if (!run) return null;
  const me = snap.players.find((p) => p.id === snap.self.id);
  const bodies = [
    ...snap.players.filter((p) => p.alive || p.downed).map((p) => ({ x: p.id === snap.self.id ? builder.x : p.x, y: p.id === snap.self.id ? builder.y : p.y, r: WORLD.playerRadius })),
    ...(snap.zombies ?? []).map(([, kind, x, y]) => ({ x, y, r: ZOMBIES[ZOMBIE_KINDS[kind]].radius })),
  ];
  return {
    day: run.phase === 'day',
    builder: me?.alive ? builder : null,
    core: coreRectAt(run.core),
    cover: [...walls, ...snap.crates.map((c) => ({ x: c.x, y: c.y, w: c.size, h: c.size }))],
    bodies,
    buildings: snap.buildings ?? [],
    scrap: run.scrap,
  };
}

function refusalText(refusal: BuildRefusal, kind: BuildingKind, lv: number): string {
  switch (refusal) {
    case 'notDay': return 'Build by day';
    case 'farFromCore': return 'Too far from the Bastion';
    case 'outOfReach': return 'Out of reach';
    case 'cover': return 'Blocked';
    case 'core': return 'That is the Bastion';
    case 'body': return 'Someone is in the way';
    case 'taken': return 'Taken';
    case 'scrap': return `${nameAt(kind, lv)} needs ${costOf(kind, lv)} scrap`;
  }
}

/** What stands on a hovered cell: its name, level of the most it can reach, health in percent, what taking it down pays, and the step up if there is one. */
export type HoverInfo = { name: string; lv: number; top: number; hpPct: number; refund: number; next: { name: string; cost: number } | null };

export function hoverOf(b: BuildingView): HoverInfo {
  const lv = levelOf(b), cost = upgradeCost(b.kind, lv);
  return { name: nameAt(b.kind, lv), lv, top: maxLevelOf(b.kind), hpPct: b.hp * 10, refund: refundFor(b), next: cost === null ? null : { name: nameAt(b.kind, lv + 1), cost } };
}

/** The line under a hovered building's name: what U does, or why it cannot. */
export function upgradeLine(hover: HoverInfo, why: UpgradeRefusal | null): string {
  if (!hover.next) return hover.top === 1 ? 'No upgrades' : 'Fully upgraded';
  if (why === 'scrap') return `Upgrade to ${hover.next.name} needs ${hover.next.cost} scrap`;
  if (why === 'outOfReach') return 'Out of reach to upgrade';
  if (why === 'notDay') return 'Upgrade by day';
  return `U or click: upgrade to ${hover.next.name} · ${hover.next.cost} scrap`;
}

/**
 * `kind` and `lv` are what build mode would put up (a wall's `lv` its tier). With a building on the cell `hover` says what it is and `upgrade` whether it can step up; `detail` is the plate's second line.
 */
export type Ghost = {
  kind: BuildingKind; lv: number; cx: number; cy: number; refusal: BuildRefusal | null; label: string; detail: string | null; hover: HoverInfo | null; upgrade: UpgradeRefusal | null;
  /** While a line is dragged out: every cell of it from where the drag began, each judged as the server will build it; `cx`, `cy` are then its far end. */
  line?: readonly LineCell[];
};
export type LineCell = { cx: number; cy: number; refusal: BuildRefusal | null };

/** Why a cell of a dragged line is passed over, in a few words for the plate's count of them. */
const SKIP_WORDS: Record<BuildRefusal, string> = {
  notDay: 'not by night', farFromCore: 'too far out', outOfReach: 'out of reach', cover: 'blocked', core: 'blocked', taken: 'taken', body: 'someone in the way', scrap: 'short of scrap',
};

/**
 * The ghost of a line dragged from cell `start` to the cursor at `at`: straight along the axis the drag went farther (`lineCells`), each cell judged
 * as the server builds the line (`planLine`), so a cell shows red where it cannot go up or the scrap has run out before it.
 */
export function lineGhostAt(site: BuildSite, kind: BuildingKind, start: { cx: number; cy: number }, at: Pose, worldSize: number, lv = 1): Ghost {
  const cell = cellOf(at.x, at.y), grid = worldSize / ZOM.cell;
  const end = { cx: Math.min(grid - 1, Math.max(0, cell.cx)), cy: Math.min(grid - 1, Math.max(0, cell.cy)) };
  const level = kind === 'wall' ? lv : 1;
  const line = planLine(site, kind, lineCells(start, end), level);
  const ok = line.filter((c) => c.refusal === null).length;
  const skipped = new Map<string, number>();
  for (const c of line) if (c.refusal !== null) skipped.set(SKIP_WORDS[c.refusal], (skipped.get(SKIP_WORDS[c.refusal]) ?? 0) + 1);
  const last = line[line.length - 1]!;
  return {
    kind, lv: level, cx: last.cx, cy: last.cy, refusal: ok > 0 ? null : line[0]!.refusal, hover: null, upgrade: null, line,
    label: `${nameAt(kind, level)} × ${ok}${ok < line.length ? ` of ${line.length}` : ''} · ${ok * costOf(kind, level)} scrap`,
    detail: skipped.size ? [...skipped].map(([why, n]) => `${n} ${why}`).join(' · ') : null,
  };
}

export function ghostAt(site: BuildSite, kind: BuildingKind, at: Pose, worldSize: number, lv = 1): Ghost {
  const cell = cellOf(at.x, at.y), grid = worldSize / ZOM.cell;
  const cx = Math.min(grid - 1, Math.max(0, cell.cx)), cy = Math.min(grid - 1, Math.max(0, cell.cy));
  const level = kind === 'wall' ? lv : 1;
  const refusal = buildRefusal(site, kind, cx, cy, level);
  const taken = site.buildings.find((b) => b.cx === cx && b.cy === cy);
  if (refusal === 'taken' && taken) {
    const hover = hoverOf(taken), upgrade = upgradeRefusal(site, cx, cy);
    return {
      kind, lv: level, cx, cy, refusal, hover, upgrade,
      label: `${hover.name}${hover.top > 1 ? ` · level ${hover.lv}/${hover.top}` : ''} · health ${hover.hpPct}%`,
      detail: `${upgradeLine(hover, upgrade)} · Right click: take down +${hover.refund}`,
    };
  }
  return { kind, lv: level, cx, cy, refusal, hover: null, upgrade: null, detail: null, label: refusal ? refusalText(refusal, kind, level) : `${nameAt(kind, level)} · ${costOf(kind, level)} scrap` };
}

/** One chip on the build bar: what its key or a tap on it picks (a wall at a tier, a turret, a utility), or `upgrade` for the hovered building. */
export type BuildChip = { kind: BuildingKind; lv?: number } | { upgrade: true };
export type HintChip = { key: string; what: string; pick?: BuildChip };
/** Build mode's keys, in order: the number keys pick these kinds from 1 (a wall takes the tier last chosen, and its key again steps to the next tier). */
export const BUILD_KEYS: readonly BuildingKind[] = BUILDING_KINDS;
export const TIER_KEYS = ['I', 'II', 'III'] as const;

/** The build bar's rows from the top, each a category with its chips; the one picked is lit by the HUD. */
export function buildRows(): { label: string; chips: HintChip[] }[] {
  const chip = (kind: BuildingKind): HintChip => ({ key: `${BUILD_KEYS.indexOf(kind) + 1}`, what: `${BUILDINGS[kind].name} ${costOf(kind)}`, pick: { kind } });
  return [
    { label: 'WALLS', chips: WALL_TIERS.map((t, i) => ({ key: TIER_KEYS[i]!, what: `${t.name} ${t.cost}`, pick: { kind: 'wall' as const, lv: i + 1 } })) },
    { label: 'TURRETS', chips: TURRET_KINDS.map(chip) },
    { label: 'UTILITY', chips: (['depot', 'post', 'spikes'] as const).map(chip) },
  ];
}

/** The bar's controls row: the clicks, upgrading and the tier and wheel shortcuts. */
export const BUILD_CONTROLS: readonly HintChip[] = [
  { key: 'Left click', what: 'build · drag a wall line' },
  { key: 'Right click', what: 'take down' },
  { key: 'U', what: 'upgrade', pick: { upgrade: true } },
  { key: '1 · Q · wheel', what: 'wall tier' },
  { key: 'B', what: 'done' },
];

/** In build mode the number keys pick what to put up, in `BUILD_KEYS` order from 1. */
export const buildKindForKey = (code: string): BuildingKind | null => BUILD_KEYS.find((_, i) => code === `Digit${i + 1}`) ?? null;

/** What build mode picks stepping through everything in bar order, walls by tier first: the wheel's list. */
export const BUILD_ITEMS: readonly { kind: BuildingKind; lv: number }[] = [
  ...WALL_TIERS.map((_, i) => ({ kind: 'wall' as const, lv: i + 1 })),
  ...BUILD_KEYS.filter((k) => k !== 'wall').map((kind) => ({ kind, lv: 1 })),
];

/** The pick `step` places on from `from` in `BUILD_ITEMS`, wrapping round. */
export function stepItem(from: { kind: BuildingKind; lv: number }, step: number): { kind: BuildingKind; lv: number } {
  const at = BUILD_ITEMS.findIndex((i) => i.kind === from.kind && (from.kind !== 'wall' || i.lv === from.lv));
  return BUILD_ITEMS[(Math.max(0, at) + step + BUILD_ITEMS.length * 4) % BUILD_ITEMS.length]!;
}

/** The next wall tier after `lv`, wrapping from the last back to the first. */
export const nextTier = (lv: number): number => (lv % MAX_LEVEL) + 1;

const SQUAD_CODE = /^z-[a-z2-7]{6}$/;

/** A squad code from an invite link, or null when there is none; `bad` when the link carries a code that cannot exist. */
export function squadFromSearch(search: string): string | null | 'bad' {
  const code = new URLSearchParams(search).get('squad');
  if (code === null) return null;
  return SQUAD_CODE.test(code) ? code : 'bad';
}

export function withSquad(href: string, code: string | null): string {
  const url = new URL(href);
  if (code === null) url.searchParams.delete('squad');
  else url.searchParams.set('squad', code);
  return url.toString();
}

export const inviteLink = (href: string, code: string): string => {
  const url = new URL(href);
  return `${url.origin}${url.pathname}?squad=${code}`;
};
