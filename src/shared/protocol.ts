import {
  AIRDROP, ARMOR_IDS, BUILDING_KINDS, COLOR_IDS, GUN_IDS, LEVELS, MAX_LEVEL, PERK_TIERS, PICK_OPTIONS, WEAPON_IDS, WORLD, ZOM,
  type AbilityId, type ArmorId, type Badge, type ColorId, type MedalId, type GunId, type ModeId, type PendingPick, type PerkId, type PickOption, type PlayerKind, type PropKind, type Tier, type WeaponId, type ZombieKind, type BuildingKind, type TurretKind,
} from './defs.ts';
import { MAP_IDS, MAPS, type MapId, type WallMaterial } from './maps.ts';
import type { DoorView } from './sim/doors.ts';
import { isEmoteId, type EmoteId } from './emotes.ts';
import { isStationId, type StationId } from './radio.ts';
import type { RangeView, TargetView } from './range.ts';
import { isCosmeticId, isSlot, parsePicks, type Cos, type Equipped, type Picks, type ProgressMsg, type Slot } from './cosmetics.ts';

export type Loadout = { weapon: WeaponId; armor: ArmorId; color: ColorId };
export type Team = ColorId | null;

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
  /** Held to sprint (`SPRINT`); only moving, not firing, counts. Optional so older senders and bots may omit it. */
  sprint?: boolean;
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
/**
 * What bots see by: the squarest screen the view honours (`VIEW_ASPECT.min`), so a bot sees the whole view radius every way, as much as a
 * person with the biggest screen can (`BOT_VIEW` in the README). No screen shows more, so a bot still never sees what no human could.
 */
export const BOT_VIEW_ASPECT = VIEW_ASPECT.min;
export const VIEW_PRELOAD_MARGIN = 64;
/** A non-finite aspect (a 0x0 viewport divides 0 by 0) is the default, never NaN, which would poison the camera and the server's culling. */
export const clampAspect = (aspect: number): number => (Number.isFinite(aspect) ? Math.min(VIEW_ASPECT.max, Math.max(VIEW_ASPECT.min, aspect)) : DEFAULT_VIEW_ASPECT);
/** The world a player can see: the view radius across, and as much height as the screen's shape allows. Camera, server culling and bot sight all use it, so nobody is hit from off screen. */
export const viewExtents = (viewRadius: number, aspect: number): { halfW: number; halfH: number } => ({ halfW: viewRadius, halfH: viewRadius / clampAspect(aspect) });

export type ClientMsg =
  /** `cosmetics` are the picks to wear: validated against the catalog here, against what the profile has unlocked by the server. */
  | { t: 'join'; name: string; loadout: Loadout; token?: string; aspect: number; cosmetics?: Picks }
  | { t: 'view'; aspect: number }
  /** `viewAt` is the server time of the world the client was drawing when it sampled `input`, so the server can judge its shots against that world. */
  | { t: 'input'; seq: number; input: InputState; viewAt: number | null }
  /** `level` names the pending pick being answered, so a pick sent twice, or after the next one opened, is ignored. */
  | { t: 'pick'; level: number; option: PickOption }
  | { t: 'chat'; text: string }
  /** A cosmetic quick emote; the server rate-limits it and fans it out to nearby players and the emoter's team. */
  | { t: 'emote'; id: EmoteId }
  /** Zombies and the range: tune the room's radio. The server drops it in any other room and rate-limits it. */
  | { t: 'radio'; station: StationId }
  | { t: 'respawn'; loadout: Loadout }
  /** Zombies: put a building on, or take one off, grid cell (`cx`, `cy`) of `ZOM.cell` px. A wall's `lv` is its tier (1 when absent). */
  | { t: 'build'; kind: BuildingKind; cx: number; cy: number; lv?: number }
  /**
   * Zombies: a line dragged out in build mode, its cells `[cx, cy]` in order from where the drag began, one straight run along a row or a column, at most `ZOM.lineMax`,
   * of a kind in `ZOM.lineKinds`. The server builds each cell by the single build's rules in that order, so the line goes up as far as the scrap lasts and a cell that cannot take it is passed over.
   */
  | { t: 'build'; kind: BuildingKind; cells: [number, number][]; lv?: number }
  | { t: 'demolish'; cx: number; cy: number }
  /** Zombies: upgrade the wall, turret or utility on the cell one level, by day. */
  | { t: 'upgrade'; cx: number; cy: number }
  | { t: 'ready' }
  /** Wear catalog item `id` in `slot`; the server answers `equipped`. */
  | { t: 'equip'; slot: Slot; id: string }
  /** Range rooms only: put any gun, armor and perk on at once (a tier left out stays, `null` clears it), or start the readout over and stand everything up. */
  | { t: 'range'; a: 'loadout'; gun?: GunId; armor?: ArmorId; perks?: { [T in Tier]?: PerkId | null } }
  | { t: 'range'; a: 'reset' };

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
  /** Fresh from a spawn and not yet firing: takes no damage. */
  spawnShield?: true;
  /** Kills this life, sent once it reaches `STREAK.showAt`. */
  streak?: number;
  /** The rarest lifetime medal on this player's profile, worn by their name. */
  badge?: Badge;
  /** What this player wears (non-default cosmetics, account level, prestige stars); see cosmetics.ts. */
  cos?: Cos;
  /** Holds an airdrop's golden gun for this life. */
  golden?: true;
  /** Sprinting: the gun is lowered and the stride long. Hidden from others by Ninja. */
  sprint?: true;
  /** Adrenaline or Second Wind is lifting this player's speed. */
  rush?: true;
  /** Recon only: this enemy is mid-reload. */
  reloading?: true;
  /** Mid-reload (anyone in view, for the arm animation): `[elapsedMs, totalMs]` whole ms, the reload's real length with perks; absent otherwise. */
  rl?: [elapsedMs: number, totalMs: number];
  /** Shocked by a generator's EMP: slowed, abilities locked. */
  emp?: true;
  /** While down: `revive` is 0..1 through a squadmate's revive and `bleedOutAt` the server time they bleed out. In Last Squad the view's `hp` is the knocked health enemies shoot through. */
  downed?: { revive: number; bleedOutAt: number };
};

/** `gun` is null for shrapnel. */
export type BulletView = { id: number; x: number; y: number; vx: number; vy: number; owner: number; gun: GunId | null };
/**
 * An explosive barrel: `[id, x, y, hp]`, `hp` in tenths of full health, 1..10, or 0 once lit (it is hissing toward its burst).
 * Whole px, and none while a burst barrel waits to stand again; the list changes only when one is hurt, so it rides as a sticky field.
 */
export type BarrelView = [id: number, x: number, y: number, hp: number];
/**
 * A prop (`PROPS`): `[id, kind, x, y, state]`, `kind` indexing `PROP_KINDS`, whole px, none while it is gone. `state` is tenths of full
 * health 1..10 standing, 0 while a propane tank flies or a generator arcs, 11 once spent (a dark lamp, a cabinet's pack on the floor). Sticky.
 */
export type PropView = [id: number, kind: number, x: number, y: number, state: number];
/** A supply plane in flight over (`x`, `y`) heading `a` radians, there at `dropAt`; its crate lands at `landAt` and stands until broken. Server times. */
export type AirdropView = { x: number; y: number; a: number; dropAt: number; landAt: number };
/** Where the supply plane is at server time `t`: a straight line at `AIRDROP.planeSpeed`, over (`x`, `y`) at `dropAt`. */
export const planeAt = (f: Pick<AirdropView, 'x' | 'y' | 'a' | 'dropAt'>, t: number): { x: number; y: number } => {
  const d = (AIRDROP.planeSpeed * (t - f.dropAt)) / 1000;
  return { x: f.x + Math.cos(f.a) * d, y: f.y + Math.sin(f.a) * d };
};
export type CrateView = { id: number; x: number; y: number; hp: number; size: number; drop?: true };
/** A wall as it goes on the wire. A polygon part also carries `pts` (flat, convex; see `Rect`) and `pid`, its polygon's index in the map's `polys`. */
export type WallView = { x: number; y: number; w: number; h: number; pts?: readonly number[]; nb?: true; ns?: true; pid?: number } & ({ built: false; material: WallMaterial } | { built: true });
export type ThrownKind = 'grenade' | 'fragGrenade' | 'gasGrenade' | 'landMine' | 'gasCloud' | 'fireSlick' | 'flashbang' | 'smokeGrenade' | 'smokeCloud';
export type ThrownView = { id: number; kind: ThrownKind; x: number; y: number; r: number; owner: number };
/** `crew` (sent only when above 0) is how many of the one team alone on the zone stand on it, which sets how fast it moves (`zoneRate`);
 * `contested` (sent only when true) is both teams on it, which holds it still. */
export type ZoneView = { id: number; x: number; y: number; r: number; owner: Team; capturing: Team; progress: number; crew?: number; contested?: true };

export type Dash = { dirX: number; dirY: number; leftMs: number };

/** `kind` indexes ZOMBIE_KINDS, `x` and `y` are whole px, and `hp` is tenths of full health, 1..10; a tuple keeps 200 zombies under 5KB. */
export type ZombieView = [id: number, kind: number, x: number, y: number, hp: number];
/**
 * `hp` is tenths of full health, 1..10, and a turret's `ammo` tenths of a full load, 0 once it cannot fire.
 * A turret's aim is not here: it turns only to fire, and each `turret` event carries its angle, so this sticky field stays unchanged while it fires.
 */
export type BuildingView = { cx: number; cy: number; hp: number; /** The upgrade level (a wall's tier), 2 or 3; absent at level 1. */ lv?: number } & ({ kind: Exclude<BuildingKind, TurretKind> } | { kind: TurretKind; ammo: number });
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
  /** Sprinting this tick; `sprintSpeed` is the speed it moves at (`speed` times `SPRINT.speedMul`, with Marathon). */
  sprint?: boolean; sprintSpeed?: number;
  /** The share (1..0) of the post-sprint bloom still to ease out (1 while sprinting), and the bloom's full length in ms (see `settleShare`). */
  settle?: number; settleMs?: number;
  perks: Partial<Record<Tier, PerkId>>;
  pending: PendingPick | null;
  ability: AbilityId | null; abilityReadyIn: number;
  alive: boolean;
  dash: Dash | null;
  /** A shove from a hit still bleeding off, px/s, so the local player's prediction replays it instead of snapping back. */
  knock?: { vx: number; vy: number } | null;
  respawnIn: number;
  kills: number; deaths: number;
  viewRadius: number;
  /** 0..1, how suppressed you are by rounds passing close; it widens your reticle and shades the screen's edges. */
  suppression: number;
  /** Shots you have fired, ever, as of the input acknowledged: the page numbers the shots it draws ahead from it (`spreadPick`). */
  fired?: number;
  /** 0..1, how blinded you are by a flashbang: 1 is a full whiteout, easing to 0 as it wears off (absent when clear). */
  flash?: number;
  /** Kills this life, and the player who last killed you until you take your revenge. */
  streak: number; nemesis: number | null;
};

/** `victim` is the id of the player, crate, zombie or squad wall hit; all come from the world's one id sequence. */
export type DamageKind = 'player' | 'crate' | 'zombie' | 'building' | 'target';

export type GameEvent =
  /**
   * `assisters` are the other players paid an assist for this kill. `knock` when the victim went down with a squadmate
   * still standing: the knock pays the kill. `ended` is the victim's streak this kill ended, and `revenge` says the victim
   * had last killed the killer.
   */
  | { e: 'kill'; killer: string; victim: string; killerId: number | null; victimId: number; weapon: string; bounty: boolean; assisters: number[]; knock?: true; ended: number; revenge: boolean }
  | { e: 'hunted'; id: number; name: string }
  /** Player `id` earned a medal (`MEDALS`), and its score with it. */
  | { e: 'medal'; id: number; medal: MedalId }
  | { e: 'dmg'; attacker: number | null; victim: number; amount: number; x: number; y: number; kind: DamageKind; /** Heading, in radians, a gun round or blast shoved a player. */ push?: number }
  | { e: 'impact'; x: number; y: number }
  /** Range only: target number `i` of the layout fell (`by` the shooter who dropped it) or stood up again, at (`x`, `y`). */
  | { e: 'target'; i: number; k: 'down' | 'up'; by: number | null; x: number; y: number }
  | { e: 'boom'; x: number; y: number; r: number }
  /** A flashbang burst: everyone near looks away. */
  | { e: 'flashburst'; x: number; y: number; r: number }
  /** `n` is the shooter's shot number (`Player.fired`), which picks where in the spread each pellet flies (`spreadPick`). */
  | { e: 'shot'; x: number; y: number; angle: number; silenced: boolean; owner: number; gun: GunId; n?: number }
  | { e: 'slash'; x: number; y: number; angle: number; owner: number }
  /** A zombie died; `by` is the squad player whose own shot, blade or blast killed it, null for a turret's kill. */
  | { e: 'zkill'; id: number; kind: ZombieKind; x: number; y: number; by: number | null }
  /** A turret at cell center (`x`, `y`) fired toward `angle`, to 0.01 rad. Its rounds stay off `bullets`: the client draws each from this. */
  /** `reach` is how far a lobbed round flies before it bursts. */
  | { e: 'turret'; kind: TurretKind; x: number; y: number; angle: number; reach?: number }
  /** A tesla coil at (`x`, `y`) arced: `p` is the arc's points, x then y, from the coil to each zombie it jumped to. */
  | { e: 'coil'; x: number; y: number; p: number[] }
  /** A depot topped up a turret or a post mended someone at (`x`, `y`), at most once a second each. */
  | { e: 'aid'; kind: 'depot' | 'post'; x: number; y: number }
  /** A squad player went down, was revived (`by` the reviver), bled out, was finished while down (`by` null for the ring), or redeployed beside a squadmate. */
  | { e: 'life'; id: number; name: string; k: 'downed' | 'revived' | 'bledOut' | 'finished' | 'redeployed'; by: number | null }
  /** A Last Squad squad has nobody left standing; `place` is where it finished. */
  | { e: 'wiped'; team: ColorId; place: number }
  /** A supply plane is `inbound` for (`x`, `y`); its crate `landed`; or `by` cracked it open and took a golden gun (`gold`) or a resupply. */
  | { e: 'airdrop'; k: 'inbound' | 'landed' | 'taken'; x: number; y: number; by?: string; gold?: boolean }
  /** A prop (`PROPS`) did its thing: `pop` (shattered, burst, spilled), `launch` a tank at heading `a`, `arc` a generator shorting, `emp` its pulse of radius `r`, `pick` a pack taken, `relight` a lamp. `c` is the colour a paint can splatters. */
  | { e: 'prop'; kind: PropKind; k: 'pop' | 'launch' | 'arc' | 'emp' | 'pick' | 'relight'; x: number; y: number; a?: number; r?: number; c?: ColorId }
  /**
   * Player `id` took something: `hp` health and `ammo` rounds actually gained (what was wasted is not counted), `ability` ready again,
   * `gold` a golden gun. `from` is where it came from. News only to that player, who sees it pop up over their own soldier.
   */
  | { e: 'gain'; id: number; from: GainSource; hp?: number; ammo?: number; ability?: true; gold?: true };

/** Where a `gain` came from: a health or ammo pack, a supply plane's crate, a Last Squad drop. */
export type GainSource = 'medic' | 'ammo' | 'airdrop' | 'drop';

export type Circle = { x: number; y: number; r: number };
/**
 * The safe circle is `from` until `shrinkAt`, closes to `to` by `closeAt`, then holds there; `phase` counts the phases closed before this one.
 * Once the last phase closes `from` and `to` are the final circle.
 */
export type RingView = { phase: number; from: Circle; to: Circle; shrinkAt: number; closeAt: number };
export const ringAt = (ring: RingView, now: number): Circle => {
  if (now <= ring.shrinkAt) return ring.from;
  if (now >= ring.closeAt) return ring.to;
  const k = (now - ring.shrinkAt) / (ring.closeAt - ring.shrinkAt);
  const lerp = (a: number, b: number) => a + (b - a) * k;
  return { x: lerp(ring.from.x, ring.to.x), y: lerp(ring.from.y, ring.to.y), r: lerp(ring.from.r, ring.to.r) };
};
export type Pip = 'up' | 'down' | 'dead';
/** `place` once the squad is out, 1 for the winner. */
export type SquadView = { team: ColorId; pips: Pip[]; place: number | null };
/** Where a Last Squad match ended for you: `place` of `of` squads. */
export type RoyaleResult = { place: number; of: number; kills: number; knocks: number; revives: number };
/**
 * `redeploys` stays true until the third phase closes. `redeployAt` is the server time you come back, null when no redeploy is coming.
 * `drops` are supply drops about to land or landed and still standing; `watch` is the player your camera follows while you are dead.
 */
export type RoyaleView = {
  /** The server time the round began; the clients place their hidden radios by it. */
  round: number;
  ring: RingView; redeploys: boolean; squads: SquadView[]; redeployAt: number | null;
  drops: { x: number; y: number; landsAt: number }[]; watch: number | null; result: RoyaleResult | null;
};

/** `pingAge` is null for a live mark, and for a hunted enemy the ms since the ping that froze it in place. */
/** `marked` is a Tracker mark on an enemy you hurt. */
export type MinimapMark = { x: number; y: number; team: Team; pingAge: number | null; marked?: true };

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
  /** Explosive barrels still standing, versus modes. Sticky. */
  barrels?: BarrelView[];
  /** The other props standing, versus modes. Sticky. */
  props?: PropView[];
  /** The supply plane in flight or the landed crate not yet opened, or null. Sticky. */
  airdrop?: AirdropView | null;
  /** Zombies only: the horde in view, the squad's walls and the run. */
  zombies?: ZombieView[];
  buildings?: BuildingView[];
  run?: RunView;
  /** Doors in view that are not shut, `[index in the map's doors, open 0..255, swing side]`; present on maps with doors. Sticky. */
  doors?: DoorView[];
  /** Last Squad only. */
  royale?: RoyaleView;
  /** Range only: each target's health in layout order (`TargetView`), sticky, and the readout for you. */
  targets?: TargetView[];
  range?: RangeView;
  /** Bots only, never on the wire: enemy gunfire it heard since it last thought, placed roughly (`heardShots`). A person hears it instead. */
  heard?: HeardShot[];
};

/** Where a bot heard a shot come from: blurred by distance, not where it was fired. */
export type HeardShot = { x: number; y: number };

/** Fields that change rarely; the wire omits each one while it is unchanged since the last snapshot sent to that client. */
export const STICKY_KEYS = ['crates', 'leaderboard', 'zones', 'match', 'buildings', 'run', 'royale', 'barrels', 'props', 'airdrop', 'targets', 'doors'] as const;
type StickyKey = (typeof STICKY_KEYS)[number];
/** `cos` maps player id to what they wear, sent only when it changes; `fillSnapshot` folds it onto each `PlayerView.cos`. */
/** `minimap` rides at most every `MINIMAP_EVERY`th snapshot (a 10 Hz map needs no 30 Hz feed); a snapshot without it keeps the last. */
export type SnapshotWire = Omit<Snapshot, StickyKey | 'minimap'> & Partial<Pick<Snapshot, StickyKey | 'minimap'>> & { cos?: Record<number, Cos> };
export const MINIMAP_EVERY = 3;

export type ServerMsg =
  /** `account` is the signed-in account name, or null when the join had no token or an invalid or expired one. */
  /** `guest`, sent only to the guest whose join made their name's profile, is the claim token that can carry it into a new account (`/api/register`). */
  | { t: 'welcome'; id: number; mode: ModeId; worldSize: number; map?: MapId; walls: WallView[]; account: string | null; guest?: string }
  | { t: 'walls'; worldSize: number; map?: MapId; walls: WallView[] }
  | SnapshotWire
  | { t: 'chat'; from: string; text: string; team: Team }
  /** Player `pid` is doing emote `id`. */
  | { t: 'emote'; pid: number; id: EmoteId }
  /** The room's radio is tuned to `station` (null: back to each map's own track), by `by`; sent to everyone in the room and to a player who joins. */
  | { t: 'radio'; station: StationId | null; by: string | null }
  /** You just earned a lifetime medal (`CAREER`), and the score it paid. */
  | { t: 'badge'; badge: Badge; score: number }
  /** Your XP, level, unlocks and challenges; see `ProgressMsg`. */
  | ProgressMsg
  /** Your full equipped set, after an `equip` (`progress` carries it at join). */
  | { t: 'equipped'; equipped: Equipped }
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
  // Trimmed after the cut, so a long name never keeps a trailing space (a padded look-alike of another name), and never cut through an astral letter's surrogate pair.
  const s = typeof v === 'string' ? v.replace(/[^\p{L}\p{N} _.\-]/gu, '').trim().slice(0, NAME_MAX).replace(/[\uD800-\uDBFF]$/, '').trim() : '';
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
    fire: b('fire'), shots: Math.floor(shots), reload: b('reload'), ability: b('ability'), use: b('use'), sprint: b('sprint'),
  };
}

/** A dragged line's cells: 1 to `ZOM.lineMax` grid cells, each the next along one row or one column, all the same way. */
function lineOfCells(v: unknown): [number, number][] | null {
  if (!Array.isArray(v) || v.length < 1 || v.length > ZOM.lineMax) return null;
  const cells: [number, number][] = [];
  for (const c of v) {
    if (!Array.isArray(c) || c.length !== 2) return null;
    const cx = gridCell(c[0]), cy = gridCell(c[1]);
    if (cx === null || cy === null) return null;
    cells.push([cx, cy]);
  }
  if (cells.length === 1) return cells;
  const sx = cells[1]![0] - cells[0]![0], sy = cells[1]![1] - cells[0]![1];
  if (Math.abs(sx) + Math.abs(sy) !== 1) return null;
  return cells.every(([cx, cy], i) => cx === cells[0]![0] + sx * i && cy === cells[0]![1] + sy * i) ? cells : null;
}

export function parseClientMsg(raw: string): ClientMsg | null {
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!isObj(v)) return null;
  switch (v.t) {
    case 'join': {
      const loadout = parseLoadout(v.loadout);
      if (!loadout) return null;
      // A join with an unknown cosmetic id still joins; the unknown picks are dropped.
      const picks = parsePicks(v.cosmetics);
      return { t: 'join', name: cleanName(v.name), loadout, token: typeof v.token === 'string' ? v.token.slice(0, 128) : undefined, aspect: parseAspect(v.aspect), ...(Object.keys(picks).length > 0 && { cosmetics: picks }) };
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
    case 'emote':
      return isEmoteId(v.id) ? { t: 'emote', id: v.id } : null;
    case 'radio':
      return isStationId(v.station) ? { t: 'radio', station: v.station } : null;
    case 'respawn': {
      const loadout = parseLoadout(v.loadout);
      return loadout ? { t: 'respawn', loadout } : null;
    }
    case 'build': {
      if (!oneOf(BUILDING_KINDS, v.kind)) return null;
      const lv = v.lv === undefined ? undefined : Number.isInteger(v.lv) && (v.lv as number) >= 1 && (v.lv as number) <= MAX_LEVEL ? (v.lv as number) : null;
      if (lv === null) return null;
      if (v.cells !== undefined) {
        const cells = lineOfCells(v.cells);
        if (!cells || !oneOf(ZOM.lineKinds, v.kind) || v.cx !== undefined || v.cy !== undefined) return null;
        return { t: 'build', kind: v.kind, cells, ...(lv !== undefined && { lv }) };
      }
      const cx = gridCell(v.cx), cy = gridCell(v.cy);
      if (cx === null || cy === null) return null;
      return { t: 'build', kind: v.kind, cx, cy, ...(lv !== undefined && { lv }) };
    }
    case 'upgrade': {
      const cx = gridCell(v.cx), cy = gridCell(v.cy);
      return cx === null || cy === null ? null : { t: 'upgrade', cx, cy };
    }
    case 'demolish': {
      const cx = gridCell(v.cx), cy = gridCell(v.cy);
      return cx === null || cy === null ? null : { t: 'demolish', cx, cy };
    }
    case 'ready': return { t: 'ready' };
    case 'range': {
      if (v.a === 'reset') return { t: 'range', a: 'reset' };
      if (v.a !== 'loadout') return null;
      const msg: Extract<ClientMsg, { t: 'range'; a: 'loadout' }> = { t: 'range', a: 'loadout' };
      if (v.gun !== undefined) { if (!oneOf(GUN_IDS, v.gun)) return null; msg.gun = v.gun; }
      if (v.armor !== undefined) { if (!oneOf(ARMOR_IDS, v.armor)) return null; msg.armor = v.armor; }
      if (v.perks !== undefined) {
        if (!isObj(v.perks)) return null;
        const perks: NonNullable<typeof msg.perks> = {};
        for (const tier of [1, 2, 3] as const) {
          const perk = v.perks[tier];
          if (perk === undefined) continue;
          if (perk === null) { perks[tier] = null; continue; }
          if (!oneOf(PERK_TIERS[tier] as readonly PerkId[], perk)) return null;
          (perks as Record<number, PerkId>)[tier] = perk;
        }
        msg.perks = perks;
      }
      return msg;
    }
    case 'equip':
      return isSlot(v.slot) && isCosmeticId(v.slot, v.id) ? { t: 'equip', slot: v.slot, id: v.id } : null;
    default:
      return null;
  }
}
