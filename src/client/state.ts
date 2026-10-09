import type { BuildingKind, TurretKind, ZombieKind } from '../shared/defs.ts';
import type { DamageKind, GameEvent, Loadout, Team, WallView } from '../shared/protocol.ts';
import type { MapId } from '../shared/maps.ts';
import type { KillEvent, Loss } from './derive.ts';
import type { Feedback } from './feedback.ts';
import type { Moments } from './moments.ts';
import type { Bests, LifeLog, Recap } from './records.ts';
import type { SnapBuffer } from './interp.ts';
import type { PendingEffect } from './eventclock.ts';
import type { ParticlePool } from './particles.ts';
import type { Firing } from './fire.ts';
import type { Ghost } from './zombies.ts';
import type { Prediction } from './predict.ts';
import type { Retry } from './reconnect.ts';
import type { LocalRound, ShotEvent } from './rounds.ts';
import type { TurretAim } from './siege.ts';
import type { Corpse, ZombieCorpse } from './corpses.ts';
import type { CrackPool } from './decals.ts';

export type Effect =
  | { kind: 'impact'; surface: 'wall' | DamageKind; x: number; y: number; victim: number | null; /** Health the hit took, and the heading in radians a gun round or blast shoved the victim (from the server's dmg event). */ amount?: number; push?: number; born: number }
  /** `by` is the killer, `weapon` the kill feed's label for what killed. */
  | { kind: 'death'; x: number; y: number; victim: number; by: number | null; weapon: string; born: number }
  | { kind: 'boom'; x: number; y: number; r: number; born: number }
  | { kind: 'flash'; x: number; y: number; angle: number; owner: number; born: number }
  | { kind: 'slash'; x: number; y: number; angle: number; born: number }
  /** `by` is the squad player whose shot, blade or blast killed the zombie, null for a turret's kill. */
  | { kind: 'splat'; x: number; y: number; zombie: ZombieKind; by: number | null; born: number }
  /** A turret's round from its muzzle at (`x`, `y`), flying `reach` px before it stops. */
  | { kind: 'tracer'; turret: TurretKind; x: number; y: number; angle: number; reach: number; born: number }
  /** A tesla coil's arc at (`x`, `y`) through the points `p`, x then y, from the coil on to each zombie it jumped to. */
  | { kind: 'coil'; x: number; y: number; p: number[]; born: number }
  /** A depot refilling or a post mending, at (`x`, `y`). */
  | { kind: 'aid'; of: 'depot' | 'post'; x: number; y: number; born: number };

export const EFFECT_LIFE_MS: Record<Effect['kind'], number> = { impact: 240, death: 650, boom: 650, flash: 70, slash: 200, splat: 400, tracer: 240, coil: 220, aid: 800 };

type FeedLine = Extract<GameEvent, { e: 'kill' | 'hunted' | 'life' | 'wiped' | 'airdrop' }> & { at: number };
export type ChatLine = { from: string; text: string; team: Team; at: number };

/** Everything needed to join the same room again as the same player. */
export type Rejoin = { room: string; name: string; loadout: Loadout; token: string | undefined };

export type Session = {
  /** When the last sent input walked, and whether the newest one does, read the way the server reads it. */
  walk: { now: boolean; at: number };
  ws: WebSocket;
  rejoin: Rejoin;
  myId: number;
  worldSize: number;
  walls: WallView[];
  /** The map in play, so its doors can be rebuilt from the snapshot's door state (set by welcome and walls). */
  mapId?: MapId;
  snaps: SnapBuffer;
  seq: number;
  shots: number;
  predict: Prediction;
  firing: Firing;
  lastSelf: { x: number; y: number };
  effects: Effect[];
  corpses: Corpse[];
  /** The night's dead zombies, kept until dawn; `dawnAt` is when the night that left them ended, null while it lasts. */
  zombieCorpses: { list: ZombieCorpse[]; dawnAt: number | null };
  rounds: LocalRound[];
  /** Whether each of the server's gun rounds in view is drawn locally instead, from `coverServerRounds`. */
  roundCover: Map<number, boolean>;
  pendingFx: PendingEffect[];
  /** Other players' shots, waiting for the render clock to reach their tick. */
  pendingShots: { at: number; shot: ShotEvent }[];
  /** The server time of each shooter's last shot event, for `recentShooters`. */
  lastShotAt: Map<number, number>;
  feedback: Feedback;
  moments: Moments;
  /** The life in progress, for the death card's recap, and this browser's single-life records. */
  life: LifeLog | null;
  bests: Bests;
  feed: FeedLine[];
  chat: ChatLine[];
  hurtAt: Map<number, number>;
  cracks: CrackPool;
  /** The level whose pick was sent and not yet confirmed by a snapshot. */
  pickSentFor: number | null;
  particles: ParticlePool;
  /** Zombies: the time the core last lost health, whether build mode is on and what it puts up. Zombie poses live in zombieart.ts. */
  coreHitAt: number;
  building: boolean;
  buildKind: BuildingKind;
  /** The tier a wall goes up at in build mode, 1 to 3. */
  buildTier: number;
  /** The cell under the cursor in build mode as last judged (main.ts), for the build bar's upgrade chip. */
  buildGhost: Ghost | null;
  /** Each turret's aim by cell (`cx,cy`). */
  turretAims: Map<string, TurretAim>;
};

type MenuStatus =
  | { kind: 'idle' }
  | { kind: 'connecting'; ws: WebSocket; rejoin: Rejoin }
  | { kind: 'error'; message: string };

export type ClientState =
  | { phase: 'menu'; status: MenuStatus }
  | { phase: 'playing'; s: Session }
  | { phase: 'dead'; s: Session; kill: KillEvent | null; loss: Loss | null; recap: Recap | null }
  | { phase: 'reconnecting'; s: Session; rejoin: Rejoin; retry: Retry; dial: WebSocket | null };
