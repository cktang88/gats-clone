import type { Cos } from '../cosmetics.ts';
import { AIRDROP, BARREL, byTurret, PERK_TIERS, PROPS, WORLD, type Badge, ZOM, ZOMBIE_KINDS, type Blast, type ColorId, type GunId, type ModeId, type PerkId, type PlayerKind, type PropKind, type Side, type Tier, type TurretKind, type ZombieKind } from '../defs.ts';
import type { Circle, Dash, GameEvent, InputState, Loadout, RoundWinner, Team, WallView } from '../protocol.ts';
import { CRATE_SIZE, MAP_MS, MAPS, ZONE_RADIUS, type Center, type MapId } from '../maps.ts';
import { cellRect, coreRectAt } from './build.ts';
import { loadDoors, type DoorState } from './doors.ts';
import { polyParts } from '../mapgeo.ts';
import { circleBlocked, dist2, type Knock, type Rect } from './movement.ts';
import type { ZAi } from './boids.ts';
import { newRoyale } from './royale.ts';
import { newRange, type RangeSim } from './targets.ts';
import { loadPacks } from './packs.ts';

/** `door` names the door a leaf belongs to; such leaves never go on the wire (see `sim/doors.ts`). */
export type Wall = WallView & { expiresAt: number; door?: string };

export type Life =
  | {
    k: 'alive';
    hp: number;
    /** Points left in this life's armor pool (`ARMORS`); full at every fresh life and refilled by an armor pack. */
    armor: number;
    ammo: number;
    reloadUntil: number | null;
    nextFireAt: number;
    /** Rounds still to come from the burst in progress. */
    burstLeft: number;
    spray: number;
    firedAt: number;
    spin: number;
    lastDamageAt: number;
    lastMoveAt: number;
    shieldUntil: number;
    dash: Dash | null;
    /** A shove from a hit still bleeding off, in px/s (see `KNOCK`); moves the body through the same collision as a step. */
    knock: Knock | null;
    pressUntil: number;
    /** Health each attacker took off this life and when, for assists and for who a self-inflicted death credits. */
    hits: { by: number; at: number; dealt: number }[];
    /** 0..1 from enemy rounds passing close (see `SUPPRESSION`); `suppressedAt` is when the last one did. */
    suppression: number;
    suppressedAt: number;
    /** Holds an airdrop's golden gun for this life: its rounds hit `AIRDROP.goldMul` as hard. */
    golden: boolean;
    /** Sprinting this tick (see `SPRINT`); `settleLeft` ms of the post-sprint bloom still to ease out (see `settleShare`); when the last sprint ended. */
    sprint: boolean;
    settleLeft: number;
    sprintEndAt: number;
    /** The eased spread (see `easeSpread`): the last few ticks' spread targets, and the spray shot the newest was taken at (a rise in it is a bloom kick, which lands at once). */
    spreadHist: number[];
    spreadShot: number;
    /** Perk timers: Adrenaline's kill rush and Second Wind (used once a life) run to these server times. */
    rushUntil: number;
    windUntil: number;
    windUsed: boolean;
    /** Tracker: the server time each enemy this life damaged stays marked on the minimap until, by player id. */
    tracks: Record<number, number>;
  }
  /** Out of the fight until a squadmate holds use beside them for `ZOM.reviveMs`, or dead at `bleedOutAt`. */
  | { k: 'downed'; bleedOutAt: number; reviveProgress: number; hp: number; /** The armor pool as it stood when they went down, which a revive gives back (full if unset). */ armor?: number }
  /** `respawnAt` is Infinity when the mode, not a timer, brings the player back: a zombies dawn or a Last Squad redeploy. */
  | { k: 'dead'; respawnAt: number };

export type Player = {
  id: number;
  name: string;
  kind: PlayerKind;
  loadout: Loadout;
  /** The class gun from the loadout until it evolves; back to the class gun every life. */
  gun: GunId;
  team: Team;
  x: number;
  y: number;
  angle: number;
  input: InputState;
  seq: number;
  /** Server time of the world the client was drawing when it sampled `input`, or null when it never said. */
  viewAt: number | null;
  /** The furthest back this player's shots may be judged, from their measured round trip. */
  rewindCapMs: number;
  shotsSeen: number;
  /** Shots this player has fired, ever: the number that picks each shot's spread (`spreadPick`), which their page predicts. */
  fired: number;
  life: Life;
  score: number;
  level: number;
  perks: ChosenPerks;
  kills: number;
  deaths: number;
  lifeKills: number;
  /** Who last killed this player, until this player kills them back. */
  nemesis: number | null;
  /** The lifetime medal this player wears, set by the server from their profile; the simulation never reads it. */
  badge: Badge | null;
  /** What this player wears (cosmetics, account level), set by the server from their profile or a bot's name; the simulation never reads it. */
  cos: Cos | null;
  /** This player's run of kills each within `MEDAL_RULES.multiMs` of the last, for the multi-kill medals. */
  chain: { count: number; at: number };
  /** When this life fell under `MEDAL_RULES.closeCallHp`, for the Close Call medal; -1 once paid, until it heals back up. */
  lowAt: number | null;
  /** Ground covered since this life last fired (or began), from where it stood last tick, for the Ghost medal. */
  quiet: { px: number; x: number; y: number; firedAt: number };
  /** This life's weapon feats so far (`WEAPON_MEDALS`): kills since the last reload, one-hit kills, and who the last volley hit. */
  feats: Feats;
  /** Until when an unsilenced shot gives this player away to the eye (a ghillie suit stops hiding them); never a minimap mark. */
  revealedUntil: number;
  /** Where enemy minimaps last placed this player while hunted; refreshed on a timer and by unsilenced fire (not with Ninja). */
  huntedPing: (Pose & { at: number }) | null;
  abilityReadyAt: number;
  /** Until when an enemy's radar sensor has this player on everyone's minimap (see `RADAR`); 0 for never. */
  taggedUntil: number;
  /** The tier-2 perks this life's pick offers, drawn from the world's rng at spawn. */
  tier2Offer: readonly PerkId[];
};

export type PerkOfTier<T extends Tier> = (typeof PERK_TIERS)[T][number];
export type ChosenPerks = { [T in Tier]?: PerkOfTier<T> };

export type Feats = { magKills: number; oneShots: number; volley: { at: number; hit: number[] } };
export const freshFeats = (): Feats => ({ magKills: 0, oneShots: 0, volley: { at: -1, hit: [] } });

export type Bullet = {
  /** `team` is the owner's at the time of firing, so the round still spares teammates after its owner leaves. */
  id: number; owner: number; team: Team; x: number; y: number; vx: number; vy: number;
  left: number; damage: number; piercing: boolean; label: string;
  gun: GunId | null;
  /** The turret or the Bastion's survivors that fired it, null for a player's own round. */
  turret: Shooter | null;
  /** A lobbed round flies over everything and bursts where it comes down. */
  lobbed: boolean;
  /** Players it can still pass through, and the ones it already has. */
  penetrate: number; passed: number[];
  /** The tick a player's round was fired on, which groups a shotgun's pellets into one blast. */
  volley?: number;
  /** Players this round already suppressed in passing, so each feels it once. */
  suppressed?: number[];
  /** How far a gun round has flown, which sets how much of its muzzle speed is left (see `MUZZLE`). */
  flown?: number;
  blast: Blast | null;
};

/** What fires at the horde for the squad besides its players. */
export type Shooter = TurretKind | 'bastion';

/** An armor pack lying at (`x`, `y`) (see sim/packs.ts), `id` its place in the map's list; `respawnAt` is set while it is taken. */
export type ArmorPack = { id: number; x: number; y: number; respawnAt: number | null };

export type Crate = { id: number; x: number; y: number; size: number; hp: number; respawnAt: number | null; drop?: true };

/**
 * An explosive barrel (center `x`, `y`). At 0 hp it hisses until `fuseAt`, then bursts and stands again at `respawnAt`.
 * `by` is whoever lit it, with the `chain` (the id of the barrel that began it) it belongs to.
 */
export type Barrel = { id: number; x: number; y: number; hp: number; fuseAt: number | null; respawnAt: number | null; by: { attacker: number | null; team: Team; chain: number } | null };
/**
 * A prop (center `x`, `y`; see `PROPS` and `sim/props.ts`). `stand` until shot to zero; then `active` (a propane tank in flight with
 * velocity `vx`, `vy`, or a generator arcing) until `at`, or `spent` (a broken lamp until it relights, a cabinet's pack until it is taken or expires) until `at`.
 * `respawnAt` is set while it is gone. `by` is whoever set it off.
 */
export type Prop = {
  id: number; kind: PropKind; x: number; y: number; hp: number; phase: 'stand' | 'active' | 'spent'; at: number; respawnAt: number | null;
  vx: number; vy: number; by: { attacker: number | null; team: Team } | null;
  /** Its spot on the map, where it stands again: a propane tank bursts wherever its flight ends. */
  home: { x: number; y: number };
};
/** Barrels that burst one after another from one spark, and the kills they made, so a chain of two or more barrels that kills two or more earns Chain Reaction. */
export type Chain = { by: number | null; barrels: number; kills: number; paid: boolean; at: number };
/** A supply plane on its way: it passes (`x`, `y`) at `dropAt`, the crate lands at `landAt` and, once landed, stands as crate `crateId` until `expiresAt`. */
export type Flight = { x: number; y: number; a: number; dropAt: number; landAt: number; crateId: number | null; expiresAt: number };
export type Airdrops = { due: number[]; flight: Flight | null };

export type Thrown =
  | { id: number; kind: 'grenade' | 'fragGrenade' | 'gasGrenade'; owner: number; team: Team; x: number; y: number; vx: number; vy: number; explodeAt: number }
  | { id: number; kind: 'radar'; owner: number; team: Team; x: number; y: number; vx: number; vy: number; explodeAt: number }
  /** A heal pole planted where its owner stood (see `HEAL_POLE`). */
  | { id: number; kind: 'healPole'; owner: number; team: Team; x: number; y: number; bornAt: number; expiresAt: number }
  | { id: number; kind: 'landMine'; owner: number; team: Team; x: number; y: number; armedAt: number; expiresAt: number }
  /** A gas cloud: it hurts whoever is in it in pulses (`dotPulses`), on a clock from `bornAt`. */
  | { id: number; kind: 'gasCloud'; owner: number; team: Team; x: number; y: number; bornAt: number; expiresAt: number }
  /** An oil drum's burning slick: it burns whoever stands in it but its spiller (see `PROP_FX.oil`), in pulses from `bornAt` like a gas cloud. */
  | { id: number; kind: 'fireSlick'; owner: number; team: Team; x: number; y: number; bornAt: number; expiresAt: number };

/** `crew` is how many of the one team alone on the zone stand on it (0 when it is empty or contested); `contested` is both teams on it. */
export type Zone = { id: number; x: number; y: number; r: number; owner: Team; capturing: Team; progress: number; crew: number; contested: boolean };

export type Match = { k: 'playing' } | { k: 'over'; winner: RoundWinner; restartAt: number };

export type LifeRecord = { id: number; name: string; kills: number; score: number; died: boolean };

/** `vx`, `vy` is how fast it moved last tick, in px a second. */
export type Zombie = { id: number; kind: ZombieKind; x: number; y: number; hp: number; attackAt: number; vx: number; vy: number; /** A shove from a hit, in px/s (see `KNOCK`); brutes and the colossus take none. */ knock?: Knock | null; /** The pack it walked in with, and its steering and target state (see `boids.ts`); neither goes on the wire. */ pack?: number; ai?: ZAi };

/** `lv` is the upgrade level, 1 to `MAX_LEVEL`; a building without one is level 1 (a wall's tier, a turret's or utility's level). */
type Cell = { id: number; cx: number; cy: number; hp: number; lv?: number };
/** A turret fires for `owner`, its builder, who gets the score for its kills. */
export type Turret = Cell & { kind: TurretKind; owner: number; ammo: number; nextFireAt: number };
/** What stands on a cell and blocks the way: a wall, a turret, a depot or a post. Spike strips are floor, in `World.floor`, and are walked over. */
export type Building = (Cell & { kind: 'wall' | 'depot' | 'post' }) | Turret;
export type FloorItem = Cell & { kind: 'spikes' };

/** `n` zombies of one kind that walk in together from one side. */
export type HordeUnit = { kind: ZombieKind; side: Side; n: number };

type RunPhase =
  | { k: 'day'; endsAt: number }
  /** Ends once `toSpawn` is empty and every zombie is dead, or at `dawnAt`, a while after the last pack walks in, when the light burns what is left. */
  | { k: 'night'; toSpawn: HordeUnit[]; nextSpawnAt: number; dawnAt: number }
  | { k: 'over'; night: number; won: boolean; restartAt: number };

export type RunStats = { name: string; kills: number; revives: number; built: number };

/** The flow field: each grid cell's cost to reach the core, cached against the wall and building layouts it was built from. */
type Flow = { wallsVersion: number; buildingsVersion: number; cost: Uint16Array };

/**
 * `survivors` never come back: mending the core shelters the rest but raises no one. `harm` is what the core has taken toward the next survivor lost.
 * `lost` counts tonight's, or last night's by day; `ready` holds the humans ready for night.
 */
export type Run = {
  core: { hp: number };
  harm: number;
  survivors: number;
  lost: number;
  ready: Set<number>;
  scrap: number;
  night: number;
  phase: RunPhase;
  startedAt: number;
  flow: Flow | null;
  stats: Map<number, RunStats>;
  /** Health each player has mended on the squad's buildings and the core this run, by id: the server reads it for their profile, the sim never does. */
  mended?: Map<number, number>;
  turretKills: Record<TurretKind, Record<ZombieKind, number>>;
  bastionKills: number;
  /** Tonight's horde share for the squad, which scales a boss's health. */
  share: number;
  bastionFireAt: number;
};

export type Ring =
  | { k: 'waiting'; phase: number; circle: Circle; next: Circle; shrinkAt: number }
  | { k: 'shrinking'; phase: number; from: Circle; to: Circle; startAt: number; closeAt: number }
  | { k: 'closed'; circle: Circle; closedAt: number };

export type Drop = { x: number; y: number; landsAt: number };

export type RoyaleStats = { name: string; kills: number; knocks: number; revives: number };

/**
 * `squads` are those that have fielded a player this match and `out` the ones with nobody left standing, first out first.
 * `redeployAt` holds each dead player still coming back; `killers` who took each player's life, so a wiped squad can watch them; `watching` whom each dead player's camera follows.
 */
export type Royale = {
  /** The server time the round began: the round's name, which the clients' hidden radios are placed by. */
  startedAt: number;
  ring: Ring;
  squads: ColorId[];
  out: ColorId[];
  redeployAt: Map<number, number>;
  drops: Drop[];
  stats: Map<number, RoyaleStats>;
  killers: Map<number, number>;
  watching: Map<number, number>;
};

export type Pose = { x: number; y: number };
type PoseFrame = { at: number; poses: ReadonlyMap<number, Pose>; walls: readonly Wall[] };

export type World = {
  mode: ModeId;
  map: MapId;
  mapChangeAt: number;
  /** The random map rotation: the seed it is dealt from and where in the deal this map is (see `rotationMap`). */
  rotationSeed: number;
  rotationAt: number;
  now: number;
  tick: number;
  rng: number;
  nextId: number;
  players: Map<number, Player>;
  /** Friendships made in this match (the room makes and ends them): each player's friends, kept both ways. Friends never hurt each other, always show on each other's minimap, and come back beside each other. */
  friends: Map<number, Set<number>>;
  bullets: Bullet[];
  crates: Crate[];
  barrels: Barrel[];
  props: Prop[];
  /** Armor packs (sim/packs.ts). */
  packs: ArmorPack[];
  /** Players an EMP has slowed, until when, and the player whose generator did it. */
  emps: Map<number, { until: number; by: number | null }>;
  chains: Map<number, Chain>;
  airdrops: Airdrops;
  walls: Wall[];
  wallsVersion: number;
  /** The map's doors and their state (see `sim/doors.ts`); `doorsVersion` counts changes to the leaves they put in `walls`. */
  doors: DoorState[];
  doorsVersion: number;
  thrown: Thrown[];
  zones: Zone[];
  teamScore: { red: number; blue: number };
  match: Match;
  events: GameEvent[];
  /** Events raised between ticks, such as by a pick; the next step ships them. */
  queuedEvents: GameEvent[];
  lifeRecords: LifeRecord[];
  /** Whether this round's first kill, and its medal, has been taken. */
  firstBlood: boolean;
  /** Recent player positions, oldest first, so a shot can be judged against the world its shooter saw. */
  history: PoseFrame[];
  zombies: Zombie[];
  buildings: Building[];
  /** Spike strips: built like a building but not solid, and not on the horde's flow field. */
  floor: FloorItem[];
  buildingsVersion: number;
  run: Run | null;
  royale: Royale | null;
  /** The shooting range's targets and readout; only a Range world has one (see `sim/targets.ts`). */
  range?: RangeSim;
};

export const IDLE_INPUT: InputState = {
  up: false, down: false, left: false, right: false, angle: 0, fire: false, shots: 0, reload: false, ability: false, aimDist: 0, use: false, sprint: false,
};

function mulberry32(state: number): number {
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function rand(w: World): number {
  w.rng = (w.rng + 0x6d2b79f5) | 0;
  return mulberry32(w.rng);
}

export const newId = (w: World) => w.nextId++;

export const friendly = (team: Team, p: Player) => team !== null && team === p.team;
export const sameTeam = (a: Player, b: Player) => friendly(a.team, b);
export const isEnemy = (a: Player, b: Player) => a.id !== b.id && !sameTeam(a, b);

/** Whether players `a` and `b` are friends (see `World.friends`). */
export const areFriends = (w: World, a: number, b: number): boolean => a !== b && (w.friends.get(a)?.has(b) ?? false);

/** Makes `a` and `b` friends, both ways. */
export function befriend(w: World, a: number, b: number): void {
  if (a === b) return;
  for (const [x, y] of [[a, b], [b, a]] as const) {
    const set = w.friends.get(x) ?? new Set<number>();
    set.add(y);
    w.friends.set(x, set);
  }
}

/** Ends the friendship of `a` and `b`, both ways. */
export function unfriend(w: World, a: number, b: number): void {
  for (const [x, y] of [[a, b], [b, a]] as const) {
    const set = w.friends.get(x);
    if (!set) continue;
    set.delete(y);
    if (!set.size) w.friends.delete(x);
  }
}

/** `id`'s friends (empty for none). */
export const friendsOf = (w: World, id: number): number[] => [...(w.friends.get(id) ?? [])];

export function createWorld(mode: ModeId, seed: number, map: MapId): World {
  const w: World = {
    mode, map, mapChangeAt: Infinity, rotationSeed: seed | 0, rotationAt: 0, now: 0, tick: 0, rng: seed | 0, nextId: 1,
    players: new Map(), friends: new Map(), bullets: [], crates: [], barrels: [], props: [], packs: [], emps: new Map(), chains: new Map(), airdrops: { due: [], flight: null }, walls: [], wallsVersion: 0, doors: [], doorsVersion: 0, thrown: [],
    zones: [], teamScore: { red: 0, blue: 0 }, match: { k: 'playing' }, events: [], queuedEvents: [], lifeRecords: [], firstBlood: false, history: [],
    zombies: [], buildings: [], floor: [], buildingsVersion: 0, run: null, royale: null,
  };
  loadMap(w, map);
  if (mode === 'ZOM') w.run = newRun(w.now);
  if (mode === 'RNG') w.range = newRange(w);
  return w;
}

export function newRun(now: number): Run {
  return {
    core: { hp: ZOM.coreHp }, harm: 0, survivors: ZOM.survivors, lost: 0, ready: new Set(), scrap: ZOM.startScrap, night: 1, phase: { k: 'day', endsAt: now + ZOM.dayMs },
    startedAt: now, flow: null, stats: new Map(),
    turretKills: byTurret(() => Object.fromEntries(ZOMBIE_KINDS.map((k) => [k, 0])) as Record<ZombieKind, number>), bastionKills: 0, bastionFireAt: 0, share: 1,
  };
}

/** Replaces the layout and everything in flight; players stay where they are. */
export function loadMap(w: World, map: MapId) {
  const def = MAPS[map];
  w.map = map;
  w.mapChangeAt = w.now + MAP_MS[w.mode];
  w.walls = [...def.walls, ...polyParts(def)].map((r) => ({ ...r, built: false as const, expiresAt: Infinity }));
  loadDoors(w);
  w.wallsVersion++;
  w.crates = def.crates.map((c) => ({ id: newId(w), x: c.x - CRATE_SIZE / 2, y: c.y - CRATE_SIZE / 2, size: CRATE_SIZE, hp: WORLD.crateHp, respawnAt: null }));
  w.barrels = hasArenaSurprises(w.mode) || w.mode === 'RNG' ? def.barrels.map((b) => ({ id: newId(w), x: b.x, y: b.y, hp: BARREL.hp, fuseAt: null, respawnAt: null, by: null })) : [];
  w.props = hasArenaSurprises(w.mode) || w.mode === 'RNG' ? def.props.map((q) => ({ id: newId(w), kind: q.kind, x: q.x, y: q.y, hp: PROPS[q.kind].hp, phase: 'stand' as const, at: 0, respawnAt: null, vx: 0, vy: 0, by: null, home: { x: q.x, y: q.y } })) : [];
  w.packs = loadPacks(w);
  w.emps = new Map();
  w.chains = new Map();
  w.airdrops = { due: hasArenaSurprises(w.mode) ? planAirdrops(w) : [], flight: null };
  w.zones = w.mode === 'DOM' ? def.zones.map((z, id) => ({ id, x: z.x, y: z.y, r: ZONE_RADIUS, owner: null, capturing: null, progress: 0, crew: 0, contested: false })) : [];
  w.bullets = [];
  w.thrown = [];
  w.history = [];
  w.zombies = [];
  w.buildings = [];
  w.floor = [];
  w.buildingsVersion++;
  if (w.mode === 'BR') w.royale = newRoyale(w);
}

/** Barrels and airdrops stand on the versus maps only. */
export const hasArenaSurprises = (mode: ModeId): boolean => mode === 'FFA' || mode === 'TDM' || mode === 'DOM';

/** When this round's supply planes come: `AIRDROP.perRound` of them, at random times in the round's clock, spaced at least `gapMs` apart. */
function planAirdrops(w: World): number[] {
  const round = MAP_MS[w.mode];
  const [lo, hi] = AIRDROP.perRound;
  // Its own stream, derived from the world's, so planning never shifts the rolls a fight draws.
  let state = (w.rng ^ 0x5bd1e995) | 0;
  const next = () => { state = (state + 0x6d2b79f5) | 0; return mulberry32(state); };
  const n = lo + Math.floor(next() * (hi - lo + 1));
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const at = w.now + round * (AIRDROP.from + next() * (AIRDROP.to - AIRDROP.from));
    if (times.every((t) => Math.abs(t - at) >= AIRDROP.gapMs)) times.push(at);
  }
  return times.sort((a, b) => a - b);
}

export const barrelRect = (b: Barrel): Rect => ({ x: b.x - BARREL.size / 2, y: b.y - BARREL.size / 2, w: BARREL.size, h: BARREL.size });
export const propRect = (q: Prop): Rect => { const h = PROPS[q.kind].size / 2; return { x: q.x - h, y: q.y - h, w: 2 * h, h: 2 * h }; };
/** A prop blocks bodies and rounds while it stands or arcs, and a dark lamp keeps its post; a flying tank and a lying pack do not block. */
export const propSolid = (q: Prop): boolean => q.respawnAt === null && !(q.kind === 'propane' && q.phase === 'active') && !((q.kind === 'medic' || q.kind === 'ammo') && q.phase === 'spent');
export const crateRect = (c: Crate): Rect => ({ x: c.x, y: c.y, w: c.size, h: c.size });
export function coreRect(w: World): Rect | null {
  const core = MAPS[w.map].siege?.core;
  return core ? coreRectAt(core) : null;
}

/**
 * `coverRects` and `solidRects` are asked for by every player's move and every grenade, each tick, and copying the map's 150 to 700
 * walls each time (and then matching the copy to its wall grid) was a twentieth of the tick. The lists are kept per world and handed out
 * again while nothing they are built from has changed: the same `w.walls` array at the same length (walls are only appended to or the
 * array replaced, see rectgrid.ts), and the same standing crates, barrels, solid props and buildings in the same places. Callers only
 * read them; a list handed out is never changed, a change builds a new one.
 */
type SolidsMemo = { walls: readonly Wall[]; wallsLen: number; sig: SolidsSig; cover: Rect[]; solid: Rect[] | null };
/** What the lists were built from: the standing crates, barrels and solid props by object and place, and the buildings' cells. */
type SolidsSig = { crates: (Crate | null)[]; barrels: (Barrel | null)[]; props: (Prop | null)[]; at: number[]; cells: number[]; run: boolean };
const SOLIDS = new WeakMap<World, SolidsMemo>();

function sameSolids(w: World, sig: SolidsSig): boolean {
  if (w.crates.length !== sig.crates.length || w.barrels.length !== sig.barrels.length || w.props.length !== sig.props.length) return false;
  if ((w.run !== null) !== sig.run || w.buildings.length * 2 !== sig.cells.length) return false;
  const at = sig.at;
  let k = 0;
  for (let i = 0; i < w.crates.length; i++) {
    const c = w.crates[i]!;
    if ((c.respawnAt === null ? c : null) !== sig.crates[i]) return false;
    if (c.respawnAt === null && (at[k++] !== c.x || at[k++] !== c.y || at[k++] !== c.size)) return false;
  }
  for (let i = 0; i < w.barrels.length; i++) {
    const b = w.barrels[i]!;
    if ((b.respawnAt === null ? b : null) !== sig.barrels[i]) return false;
    if (b.respawnAt === null && (at[k++] !== b.x || at[k++] !== b.y)) return false;
  }
  for (let i = 0; i < w.props.length; i++) {
    const q = w.props[i]!, solid = propSolid(q);
    if ((solid ? q : null) !== sig.props[i]) return false;
    if (solid && (at[k++] !== q.x || at[k++] !== q.y || at[k++] !== PROPS[q.kind].size)) return false;
  }
  for (let i = 0; i < w.buildings.length; i++) if (sig.cells[2 * i] !== w.buildings[i]!.cx || sig.cells[2 * i + 1] !== w.buildings[i]!.cy) return false;
  return true;
}

function solidsMemo(w: World): SolidsMemo {
  const m = SOLIDS.get(w);
  if (m && m.walls === w.walls && m.wallsLen === w.walls.length && sameSolids(w, m.sig)) return m;
  const at: number[] = [];
  const crates = w.crates.map((c) => (c.respawnAt === null ? (at.push(c.x, c.y, c.size), c) : null));
  const barrels = w.barrels.map((b) => (b.respawnAt === null ? (at.push(b.x, b.y), b) : null));
  const props = w.props.map((q) => (propSolid(q) ? (at.push(q.x, q.y, PROPS[q.kind].size), q) : null));
  const sig: SolidsSig = { crates, barrels, props, at, cells: w.buildings.flatMap((b) => [b.cx, b.cy]), run: w.run !== null };
  const cover = [...w.walls, ...w.crates.filter((c) => c.respawnAt === null).map(crateRect), ...w.barrels.filter((b) => b.respawnAt === null).map(barrelRect), ...w.props.filter(propSolid).map(propRect)];
  const fresh: SolidsMemo = { walls: w.walls, wallsLen: w.walls.length, sig, cover, solid: null };
  SOLIDS.set(w, fresh);
  return fresh;
}

/** What stops grenades: walls and standing crates. The squad's own walls and core let them fly over. Shared: read it, never change it. */
export const coverRects = (w: World): Rect[] => solidsMemo(w).cover;

/** What stops bodies: cover, plus the squad's walls and the core in a zombies run. Shared: read it, never change it. */
export function solidRects(w: World): Rect[] {
  const m = solidsMemo(w);
  if (m.solid) return m.solid;
  const solids = [...m.cover];
  for (const b of w.buildings) solids.push(cellRect(b.cx, b.cy));
  const core = w.run && coreRect(w);
  if (core) solids.push(core);
  return (m.solid = solids);
}

const SPAWN_CLEARANCE = 10;
/** Clear spots a spawn weighs, taking the one farthest from any enemy. */
const SPAWN_CANDIDATES = 12;
const SPAWN_EDGE = 100;

const SQUAD_GAP = { min: 70, max: 160 } as const;
const SQUAD_CANDIDATES = 24;

function squadSpawn(w: World, team: Team, solids: readonly Rect[], size: number): Pose {
  const r = WORLD.playerRadius + SPAWN_CLEARANCE;
  const clear = (x: number, y: number) => x >= r && y >= r && x <= size - r && y <= size - r && !circleBlocked(solids, x, y, r);
  const standing = [...w.players.values()].filter((p) => p.life.k === 'alive' && Number.isFinite(p.x));
  const mates = standing.filter((p) => p.team === team);
  if (mates.length) {
    const m = mates[Math.floor(rand(w) * mates.length)]!;
    for (let i = 0; i < 20; i++) {
      const a = rand(w) * 2 * Math.PI, d = SQUAD_GAP.min + rand(w) * (SQUAD_GAP.max - SQUAD_GAP.min);
      const x = m.x + Math.cos(a) * d, y = m.y + Math.sin(a) * d;
      if (clear(x, y)) return { x, y };
    }
    return clearPointNear(solids, m.x, m.y, r, size);
  }
  const rivals = standing.filter((p) => p.team !== team);
  let best: (Pose & { safety: number }) | null = null;
  for (let i = 0, found = 0; i < 400 && found < SQUAD_CANDIDATES; i++) {
    const x = SPAWN_EDGE + rand(w) * (size - 2 * SPAWN_EDGE), y = SPAWN_EDGE + rand(w) * (size - 2 * SPAWN_EDGE);
    if (!clear(x, y)) continue;
    found++;
    const safety = Math.min(Infinity, ...rivals.map((p) => dist2(p.x, p.y, x, y)));
    if (!best || safety > best.safety) best = { x, y, safety };
  }
  return best ? { x: best.x, y: best.y } : clearPointNear(solids, size / 2, size / 2, r, size);
}

export function spawnPoint(w: World, team: Team): Pose {
  const { spawns, siege, size } = MAPS[w.map];
  const solids = solidRects(w);
  if (w.royale) return squadSpawn(w, team, solids, size);
  const regions = spawns[team === 'red' || team === 'blue' ? team : 'ffa'];
  const core = siege?.core;
  if (w.run && core) {
    const inside = defendedPoints(solids, core, size);
    if (inside.length) return inside[Math.floor(rand(w) * Math.min(inside.length, SQUAD_SPAWN_CHOICES))]!;
  }
  const enemies = [...w.players.values()].filter((p) => p.life.k === 'alive' && (team === null || p.team !== team));
  const safety = (x: number, y: number) => Math.min(Infinity, ...enemies.map((p) => dist2(p.x, p.y, x, y)));
  let best: (Pose & { safety: number }) | null = null;
  // A free-for-all has no sides to keep, so half its candidates come from anywhere open on the map and nobody starts on top of a rival.
  const anywhere: Rect = { x: SPAWN_EDGE, y: SPAWN_EDGE, w: size - 2 * SPAWN_EDGE, h: size - 2 * SPAWN_EDGE };
  for (let i = 0, found = 0; i < 200 && found < SPAWN_CANDIDATES; i++) {
    const r = team === null && i % 2 === 1 ? anywhere : regions[Math.floor(rand(w) * regions.length)];
    const x = r.x + rand(w) * r.w, y = r.y + rand(w) * r.h;
    if (circleBlocked(solids, x, y, WORLD.playerRadius + SPAWN_CLEARANCE)) continue;
    found++;
    const s = safety(x, y);
    if (!best || s > best.safety) best = { x, y, safety: s };
  }
  if (best) return { x: best.x, y: best.y };
  const fallback = regions[0];
  return clearPointNear(solids, fallback.x + fallback.w / 2, fallback.y + fallback.h / 2, WORLD.playerRadius + SPAWN_CLEARANCE, size);
}

const SQUAD_SPAWN_CHOICES = 12;

/** Grid points a player can walk to from the core, nearest first, so a squad respawns on the defended side of its walls. */
function defendedPoints(solids: readonly Rect[], core: Center, size: number): Pose[] {
  const n = Math.floor(size / ZOM.cell);
  const center = (c: number) => c * ZOM.cell + ZOM.cell / 2;
  const open = (cx: number, cy: number, r: number) => !circleBlocked(solids, center(cx), center(cy), r);
  const seen = new Uint8Array(n * n);
  const x0 = Math.floor((core.x - ZOM.coreHalf) / ZOM.cell) - 1, x1 = Math.floor((core.x + ZOM.coreHalf - 1) / ZOM.cell) + 1;
  const y0 = Math.floor((core.y - ZOM.coreHalf) / ZOM.cell) - 1, y1 = Math.floor((core.y + ZOM.coreHalf - 1) / ZOM.cell) + 1;
  const queue: [number, number][] = [];
  for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
    const border = cx === x0 || cx === x1 || cy === y0 || cy === y1;
    if (border && open(cx, cy, WORLD.playerRadius)) { seen[cy * n + cx] = 1; queue.push([cx, cy]); }
  }
  const points: Pose[] = [];
  const walkable: Pose[] = [];
  for (let i = 0; i < queue.length && points.length < SQUAD_SPAWN_CHOICES; i++) {
    const [cx, cy] = queue[i]!;
    if (walkable.length < SQUAD_SPAWN_CHOICES) walkable.push({ x: center(cx), y: center(cy) });
    if (open(cx, cy, WORLD.playerRadius + SPAWN_CLEARANCE)) points.push({ x: center(cx), y: center(cy) });
    for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]] as const) {
      if (nx < 1 || ny < 1 || nx >= n - 1 || ny >= n - 1 || seen[ny * n + nx] || !open(nx, ny, WORLD.playerRadius)) continue;
      seen[ny * n + nx] = 1;
      queue.push([nx, ny]);
    }
  }
  // A ring built tight around the core leaves no fully clear cell inside; standing room inside still beats the far side of the wall.
  return points.length ? points : walkable;
}

/**
 * Where `id` comes back beside a standing friend: a clear spot a couple of body widths from one of them, picked from the world's rng.
 * Null with no friend standing, and in Last Squad, which brings everyone back beside their own squad.
 */
export function friendSpawn(w: World, id: number): Pose | null {
  if (w.royale) return null;
  const standing = friendsOf(w, id).map((f) => w.players.get(f)).filter((f): f is Player => f?.life.k === 'alive');
  if (!standing.length) return null;
  const friend = standing[Math.floor(rand(w) * standing.length)]!;
  const { size } = MAPS[w.map];
  const solids = solidRects(w), r = WORLD.playerRadius + SPAWN_CLEARANCE;
  const turn = rand(w) * Math.PI * 2;
  for (let i = 0; i < 8; i++) {
    const a = turn + (i * Math.PI) / 4, d = WORLD.playerRadius * 2.6;
    const x = friend.x + Math.cos(a) * d, y = friend.y + Math.sin(a) * d;
    if (x >= r && y >= r && x <= size - r && y <= size - r && !circleBlocked(solids, x, y, r)) return { x, y };
  }
  return clearPointNear(solids, friend.x, friend.y, r, size);
}

/** The nearest point to (x, y), on a grid of ZOM.cell steps, where a circle of radius `r` stands clear of every solid, such as when a squad's walls cover its spawn strips. */
function clearPointNear(solids: readonly Rect[], x: number, y: number, r: number, size: number): Pose {
  const clear = (px: number, py: number) => px >= r && py >= r && px <= size - r && py <= size - r && !circleBlocked(solids, px, py, r);
  for (let ring = 0; ring * ZOM.cell < size; ring++) {
    const points: Pose[] = [];
    for (let i = -ring; i <= ring; i++) for (let j = -ring; j <= ring; j++) {
      if (Math.max(Math.abs(i), Math.abs(j)) === ring && clear(x + i * ZOM.cell, y + j * ZOM.cell)) points.push({ x: x + i * ZOM.cell, y: y + j * ZOM.cell });
    }
    if (points.length) return points.reduce((a, b) => (dist2(a.x, a.y, x, y) <= dist2(b.x, b.y, x, y) ? a : b));
  }
  return { x, y };
}
