import {
  ARMOR_IDS, BUILDING_KINDS, COLOR_IDS, LEVELS, PICK_OPTIONS, WEAPON_IDS, WORLD, ZOM,
  type AbilityId, type ArmorId, type ColorId, type GunId, type ModeId, type PendingPick, type PerkId, type PickOption, type PlayerKind, type Tier, type WeaponId, type ZombieKind, type BuildingKind, type TurretKind,
} from './defs.ts';
import { MAP_IDS, MAPS, type WallMaterial } from './maps.ts';

export type Loadout = { weapon: WeaponId; armor: ArmorId; color: ColorId };
export type Team = 'red' | 'blue' | null;

export type InputState = {
  up: boolean; down: boolean; left: boolean; right: boolean;
  angle: number;
  fire: boolean;
  /** Trigger presses since the connection opened. Monotonic, so a press and release between two samples still counts. */
  shots: number;
  reload: boolean;
  ability: boolean;
  aimDist: number;
  /** Zombies: held to revive a downed squadmate nearby, or else to repair the nearest damaged wall in reach. */
  use: boolean;
};

/** How far behind the newest snapshot a client draws the world; the server allows for it when judging a lagged shot. */
export const INTERP_DELAY_MS = (3 * 1000) / WORLD.tickHz;

/**
 * Screen shapes the view honours. The width of the view is fixed, so a wider screen only ever sees LESS height: widening `max` past 16:9
 * can never reveal more world, it just stops modern phones (iPhone 15 Pro landscape is 2.17:1) and ultrawides losing the sides of their
 * screen to a crop. Beyond the clamp the client scales the clamped view to cover the screen (see camera.ts), never showing more.
 */
export const VIEW_ASPECT = { min: 1, max: 2.4 } as const;
/** What a client that sent no (or a garbled) aspect is assumed to have, and what bots see by. */
export const DEFAULT_VIEW_ASPECT = 16 / 9;
export const VIEW_PRELOAD_MARGIN = 64;
export const clampAspect = (aspect: number): number => Math.min(VIEW_ASPECT.max, Math.max(VIEW_ASPECT.min, aspect));
/** The world a player can see: the view radius across, and as much height as the screen's shape allows. Camera, server culling and bot sight all use it, so nobody is hit from off screen. */
export const viewExtents = (viewRadius: number, aspect: number): { halfW: number; halfH: number } => ({ halfW: viewRadius, halfH: viewRadius / clampAspect(aspect) });

export type ClientMsg =
  | { t: 'join'; name: string; loadout: Loadout; token?: string; aspect: number }
  | { t: 'view'; aspect: number }
  /** `viewAt` is the server time of the world the client was drawing when it sampled `input`, so the server can judge its shots against that world. */
  | { t: 'input'; seq: number; input: InputState; viewAt: number | null }
  /** `level` names the pending pick being answered, so a pick sent twice, or after the next one opened, is ignored. */
  | { t: 'pick'; level: number; option: PickOption }
  | { t: 'chat'; text: string }
  | { t: 'respawn'; loadout: Loadout }
  /** Zombies: put a wall on, or take one off, grid cell (`cx`, `cy`) of `ZOM.cell` px. */
  | { t: 'build'; kind: BuildingKind; cx: number; cy: number }
  | { t: 'demolish'; cx: number; cy: number }
  | { t: 'ready' };

export type PlayerView = {
  id: number; name: string; x: number; y: number; angle: number;
  hp: number; maxHp: number;
  color: ColorId; gun: GunId; team: Team;
  alive: boolean; hidden: boolean; shield: boolean; dashing: boolean;
  score: number; level: number;
  armorTier: ArmorId;
  kind: PlayerKind;
  /** True for an enemy holding a stage-2 gun, and for yourself when you hold one. */
  hunted: boolean;
  /** Zombies only, while down: `revive` is 0..1 through a squadmate's revive and `bleedOutAt` the server time they bleed out. */
  downed?: { revive: number; bleedOutAt: number };
};

/** `gun` is null for shrapnel. */
export type BulletView = { id: number; x: number; y: number; vx: number; vy: number; owner: number; gun: GunId | null };
export type CrateView = { id: number; x: number; y: number; hp: number; size: number };
export type WallView = { x: number; y: number; w: number; h: number } & ({ built: false; material: WallMaterial } | { built: true });
export type ThrownKind = 'grenade' | 'fragGrenade' | 'gasGrenade' | 'landMine' | 'gasCloud';
export type ThrownView = { id: number; kind: ThrownKind; x: number; y: number; r: number; owner: number };
export type ZoneView = { id: number; x: number; y: number; r: number; owner: Team; capturing: Team; progress: number };

export type Dash = { dirX: number; dirY: number; leftMs: number };

/** `kind` indexes ZOMBIE_KINDS, `x` and `y` are whole px, and `hp` is tenths of full health, 1..10; a tuple keeps 200 zombies under 5KB. */
export type ZombieView = [id: number, kind: number, x: number, y: number, hp: number];
/**
 * `hp` is tenths of full health, 1..10, and a turret's `ammo` tenths of a full load, 0 once it cannot fire.
 * A turret's aim is not here: it turns only to fire, and each `turret` event carries its angle, so this sticky field stays unchanged while it fires.
 */
export type BuildingView = { cx: number; cy: number; hp: number } & ({ kind: 'wall' } | { kind: TurretKind; ammo: number });
/** `turretKills` counts the squad's turrets' kills by turret kind; a player's `kills` are their own. `won` once the Bastion held through the Tide. */
export type RunReport = {
  night: number; won: boolean; survivors: number; durationMs: number; players: { name: string; kills: number; revives: number; built: number }[]; turretKills: Record<TurretKind, number>; bastionKills: number;
};
/**
 * `phaseEndsAt` is the server time the day ends or the next run starts, and null at night, which ends when the wave is dead.
 * `waveLeft` counts the night's zombies alive or still to come; `report` is set once the run is over.
 * `survivors` are those left in the core, `lost` those lost tonight (last night's by day), and `ready` the ids of humans ready for night.
 */
export type RunView = {
  phase: 'day' | 'night' | 'over'; night: number; phaseEndsAt: number | null; scrap: number;
  core: { x: number; y: number; hp: number; maxHp: number }; aliveZombies: number; waveLeft: number; survivors: number; lost: number; ready: number[]; report: RunReport | null;
};

export type SelfView = {
  id: number; ammo: number; mag: number; reloading: boolean;
  /** 0..1 through the current reload, 0 when not reloading. */
  reloadFrac: number;
  /** Move speed without a dash, for predicting the local player's movement. */
  speed: number;
  perks: Partial<Record<Tier, PerkId>>;
  pending: PendingPick | null;
  ability: AbilityId | null; abilityReadyIn: number;
  alive: boolean;
  dash: Dash | null;
  respawnIn: number;
  kills: number; deaths: number;
  viewRadius: number;
};

/** `victim` is the id of the player, crate, zombie or squad wall hit; all come from the world's one id sequence. */
export type DamageKind = 'player' | 'crate' | 'zombie' | 'building';

export type GameEvent =
  /** `assisters` are the other players paid an assist for this kill. */
  | { e: 'kill'; killer: string; victim: string; killerId: number | null; victimId: number; weapon: string; bounty: boolean; assisters: number[] }
  | { e: 'hunted'; id: number; name: string }
  | { e: 'dmg'; attacker: number | null; victim: number; amount: number; x: number; y: number; kind: DamageKind }
  | { e: 'impact'; x: number; y: number }
  | { e: 'boom'; x: number; y: number; r: number }
  | { e: 'shot'; x: number; y: number; angle: number; silenced: boolean; owner: number; gun: GunId }
  | { e: 'slash'; x: number; y: number; angle: number; owner: number }
  /** A zombie died; `by` is the squad player whose own shot, blade or blast killed it, null for a turret's kill. */
  | { e: 'zkill'; id: number; kind: ZombieKind; x: number; y: number; by: number | null }
  /** A turret at cell center (`x`, `y`) fired toward `angle`, to 0.01 rad. Its rounds stay off `bullets`: the client draws each from this. */
  /** `reach` is how far a lobbed round flies before it bursts. */
  | { e: 'turret'; kind: TurretKind; x: number; y: number; angle: number; reach?: number }
  /** A squad player went down, was revived (`by` the reviver), or bled out. */
  | { e: 'life'; id: number; name: string; k: 'downed' | 'revived' | 'bledOut'; by: number | null };

/** `pingAge` is null for a live mark, and for a hunted enemy the ms since the ping that froze it in place. */
export type MinimapMark = { x: number; y: number; team: Team; pingAge: number | null };

/** `kills` and `deaths` count this round only and every mode ranks on them; `score` is the current life's, which a death resets. */
export type LeaderRow = { id: number; name: string; score: number; kills: number; deaths: number; team: Team };
/** Most round kills first, then fewest deaths. The FFA timer crowns whoever this puts first, so the leaderboard and the winner agree. */
export const byRank = (a: { kills: number; deaths: number }, b: { kills: number; deaths: number }): number => b.kills - a.kills || a.deaths - b.deaths;
export const rankRows = (rows: readonly LeaderRow[]): LeaderRow[] => [...rows].sort(byRank);
/** `id` is the winning player's, null for a team. `note` says why they won when the ranking does not, such as a human reaching the FFA kill target behind a bot. */
export type RoundWinner = { name: string; id: number | null; note: string | null };
/**
 * `mapChangeIn` counts down to the next map once it is close enough to announce, and is 0 otherwise.
 * `roundEndsAt` is the server time (tick × tick length) the round's clock runs out, null while it is over or when it has no clock; it holds still for the whole round, so the sticky match field is not resent every tick.
 */
export type MatchView = {
  mode: ModeId; map: string; nextMap: string; mapChangeIn: number; teamScore: { red: number; blue: number }; winner: RoundWinner | null; restartIn: number;
  roundEndsAt: number | null;
};

export type Snapshot = {
  t: 'snap';
  tick: number;
  ackSeq: number;
  self: SelfView;
  players: PlayerView[];
  bullets: BulletView[];
  crates: CrateView[];
  thrown: ThrownView[];
  zones: ZoneView[];
  minimap: MinimapMark[];
  leaderboard: LeaderRow[];
  match: MatchView;
  events: GameEvent[];
  /** Zombies only: the horde in view, the squad's walls and the run. */
  zombies?: ZombieView[];
  buildings?: BuildingView[];
  run?: RunView;
};

/** Fields that change rarely; the wire omits each one while it is unchanged since the last snapshot sent to that client. */
export const STICKY_KEYS = ['crates', 'leaderboard', 'zones', 'match', 'buildings', 'run'] as const;
type StickyKey = (typeof STICKY_KEYS)[number];
export type SnapshotWire = Omit<Snapshot, StickyKey> & Partial<Pick<Snapshot, StickyKey>>;

export type ServerMsg =
  /** `account` is the signed-in account name, or null when the join had no token or an invalid or expired one. */
  | { t: 'welcome'; id: number; mode: ModeId; worldSize: number; walls: WallView[]; account: string | null }
  | { t: 'walls'; worldSize: number; walls: WallView[] }
  | SnapshotWire
  | { t: 'chat'; from: string; text: string; team: Team }
  | { t: 'error'; message: string };

const oneOf = <T extends string>(xs: readonly T[], v: unknown): v is T => typeof v === 'string' && (xs as readonly string[]).includes(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const num = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null);

export function parseLoadout(v: unknown): Loadout | null {
  if (!isObj(v)) return null;
  if (!oneOf(WEAPON_IDS, v.weapon) || !oneOf(ARMOR_IDS, v.armor) || !oneOf(COLOR_IDS, v.color)) return null;
  return { weapon: v.weapon, armor: v.armor, color: v.color };
}

export const NAME_MAX = 16;

export function cleanName(v: unknown): string {
  const s = typeof v === 'string' ? v.replace(/[^\p{L}\p{N} _.\-]/gu, '').trim().slice(0, NAME_MAX) : '';
  return s || 'Unnamed';
}

const MAX_SIEGE_GRID = Math.max(...MAP_IDS.filter((m) => MAPS[m].siege).map((m) => MAPS[m].size)) / ZOM.cell;
const gridCell = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < MAX_SIEGE_GRID ? v : null);

const parseAspect = (v: unknown): number => num(v, VIEW_ASPECT.min, VIEW_ASPECT.max) ?? DEFAULT_VIEW_ASPECT;

function parseInput(v: unknown): InputState | null {
  if (!isObj(v)) return null;
  const angle = num(v.angle, -10, 10);
  const aimDist = num(v.aimDist, 0, 2000);
  const shots = num(v.shots ?? 0, 0, Number.MAX_SAFE_INTEGER);
  if (angle === null || aimDist === null || shots === null) return null;
  const b = (k: string) => v[k] === true;
  return {
    up: b('up'), down: b('down'), left: b('left'), right: b('right'), angle, aimDist,
    fire: b('fire'), shots: Math.floor(shots), reload: b('reload'), ability: b('ability'), use: b('use'),
  };
}

export function parseClientMsg(raw: string): ClientMsg | null {
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!isObj(v)) return null;
  switch (v.t) {
    case 'join': {
      const loadout = parseLoadout(v.loadout);
      if (!loadout) return null;
      return { t: 'join', name: cleanName(v.name), loadout, token: typeof v.token === 'string' ? v.token.slice(0, 128) : undefined, aspect: parseAspect(v.aspect) };
    }
    case 'view':
      return { t: 'view', aspect: parseAspect(v.aspect) };
    case 'input': {
      const input = parseInput(v.input);
      const seq = num(v.seq, 0, Number.MAX_SAFE_INTEGER);
      return input && seq !== null ? { t: 'input', seq, input, viewAt: num(v.viewAt, 0, Number.MAX_SAFE_INTEGER) } : null;
    }
    case 'pick': {
      const level = v.level;
      if (typeof level !== 'number' || !Number.isInteger(level) || level < 1 || level >= LEVELS.length) return null;
      return oneOf(PICK_OPTIONS, v.option) ? { t: 'pick', level, option: v.option } : null;
    }
    case 'chat':
      return typeof v.text === 'string' && v.text.trim() ? { t: 'chat', text: v.text.trim().slice(0, 120) } : null;
    case 'respawn': {
      const loadout = parseLoadout(v.loadout);
      return loadout ? { t: 'respawn', loadout } : null;
    }
    case 'build': {
      const cx = gridCell(v.cx), cy = gridCell(v.cy);
      return cx === null || cy === null || !oneOf(BUILDING_KINDS, v.kind) ? null : { t: 'build', kind: v.kind, cx, cy };
    }
    case 'demolish': {
      const cx = gridCell(v.cx), cy = gridCell(v.cy);
      return cx === null || cy === null ? null : { t: 'demolish', cx, cy };
    }
    case 'ready': return { t: 'ready' };
    default:
      return null;
  }
}
