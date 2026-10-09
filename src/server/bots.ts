import { ARMOR_IDS, COLOR_IDS, GUNS, isPerkId, pickOptions, WEAPON_IDS, type BuildingKind, type GunId, type PerkId, type PickOption, type WeaponId } from '../shared/defs.ts';
import type { InputState, Loadout, Snapshot } from '../shared/protocol.ts';
import type { BotArena } from './bot/arena.ts';
import { freshAwareness, perceive, type Awareness } from './bot/awareness.ts';
import { bandFor, GUN_BAND, nextIntent, PERSONALITIES, PERSONALITY_IDS, roleFor, startIntent, type Intent, type IntentCtx, type PersonalityId } from './bot/intent.ts';
import { act, freshMotor, type Motor } from './bot/motor.ts';
import { crawlThink, royaleThink } from './bot/royale.ts';
import { supplyFor } from './bot/supplies.ts';
import { isOpen } from './bot/nav.ts';
import { readTactics, type Tactics } from './bot/tactics.ts';
import { DEAD_ZONE, siegeThink, type SiegeMemory } from './bot/siege.ts';

export type BotMemory = {
  persona: PersonalityId;
  intent: Intent | null;
  awareness: Awareness;
  motor: Motor;
  /** When it last thought and last planned, and what it saw then, for the think cadence (see tick.ts). */
  beat?: Beat;
  /** How it last saw each enemy, and where it pre-aims (see tactics.ts); fresh each life. */
  tactics?: Tactics;
  /** The zombies a squad bot has lately had in sight (see siege.ts). */
  siege?: SiegeMemory;
};

/**
 * `seen` is how many enemies stood in its view box when it last thought, `inSight` which of them it had a line on, `zones` who held each
 * zone, `sight` its view box's half extents.
 */
export type Beat = { thought: number; planned: number; seen: number; zones: string; sight: { halfW: number; halfH: number }; inSight?: readonly number[] };

/** Whether this think re-plans (see `nextIntent`), and when the bot last did. */
export type ThinkTier = { strategic?: boolean; lastPlan?: number };

export type BotDecision = { input: InputState; pick: { level: number; option: PickOption } | null; mem: BotMemory; build?: { kind: BuildingKind; cx: number; cy: number; lv?: number }; upgrade?: { cx: number; cy: number } };

const IDLE_BOT_INPUT: InputState = { up: false, down: false, left: false, right: false, angle: 0, fire: false, shots: 0, reload: false, ability: false, aimDist: 0, use: false };

const pick = <T>(xs: readonly T[], rand: () => number): T => xs[Math.floor(rand() * xs.length)];

/** Bots do not read the minimap or sprint much, so Recon, Ninja and Tracker are rarer picks; fights reward Bloodlust, Second Wind and Fast Hands. */
const PERK_WEIGHT: Partial<Record<PerkId, number>> = {
  ghillie: 0, longRange: 0, quickReload: 1.5, choke: 2,
  recon: 0.4, ninja: 0.4, tracker: 0.4, marathon: 0.6, demolitions: 0.7, brace: 0.8, steadyHands: 0.4, bloodlust: 1.5, secondWind: 1.5, fastHands: 1.5, adrenaline: 1.2,
};
const CLASS_PERK_WEIGHT: Partial<Record<WeaponId, Partial<Record<PerkId, number>>>> = {
  lmg: { quickReload: 2, steadyHands: 2.5 }, assault: { steadyHands: 2.5 }, smg: { steadyHands: 2 }, shotgun: { brace: 1.6, bloodlust: 2 }, sniper: { recon: 1, steadyHands: 0 },
};

/** Which evolution a bot leans to by its temper: a daredevil takes the rushers, a marksman the long guns, a careful one the guns that hold a mid-range lane. */
export function gunWeight(option: GunId, persona: PersonalityId): number {
  const [, ideal, , rush] = GUN_BAND[option];
  if (persona === 'aggressive') return rush ? 2 : 1;
  if (persona === 'marksman') return ideal >= 450 ? 2 : 1;
  return ideal >= 300 && !rush ? 1.5 : 1;
}

function choosePickOption(options: readonly PickOption[], gun: GunId, persona: PersonalityId, rand: () => number): PickOption {
  const weight = (o: PickOption) => (isPerkId(o) ? CLASS_PERK_WEIGHT[GUNS[gun].base]?.[o] ?? PERK_WEIGHT[o] ?? 1 : gunWeight(o, persona));
  let roll = rand() * options.reduce((sum, o) => sum + weight(o), 0);
  return options.find((o) => (roll -= weight(o)) < 0) ?? pick(options, rand);
}

export function newBotMemory(rand: () => number): BotMemory {
  return { persona: pick(PERSONALITY_IDS, rand), intent: null, awareness: freshAwareness(), motor: freshMotor() };
}

export function randomLoadout(rand: () => number): Loadout {
  return { weapon: pick(WEAPON_IDS, rand), armor: pick(ARMOR_IDS, rand), color: pick(COLOR_IDS, rand) };
}

export function botThink(snap: Snapshot, arena: BotArena, mem: BotMemory, rand: () => number, tier: ThinkTier = {}): BotDecision {
  const me = snap.players.find((p) => p.id === snap.self.id);
  if (me?.downed && snap.run) {
    const core = snap.run.core;
    const input = { ...IDLE_BOT_INPUT, shots: mem.motor.shots, up: core.y < me.y - DEAD_ZONE, down: core.y > me.y + DEAD_ZONE, left: core.x < me.x - DEAD_ZONE, right: core.x > me.x + DEAD_ZONE };
    return { input, pick: null, mem };
  }
  if (me?.downed && snap.royale) return { ...crawlThink(snap, snap.royale, me, mem), pick: null };
  if (!me || !me.alive) {
    const forgotten = mem.intent ? { ...mem, intent: null, awareness: freshAwareness(), motor: { ...freshMotor(), shots: mem.motor.shots } } : mem;
    return { input: { ...IDLE_BOT_INPUT, shots: mem.motor.shots }, pick: null, mem: forgotten };
  }
  const pending = snap.self.pending;
  const choice = pending ? { level: pending.level, option: choosePickOption(pickOptions(pending, me.gun), me.gun, mem.persona, rand) } : null;
  if (snap.run) return { ...siegeThink(snap, snap.run, me, arena, mem, rand), pick: choice };
  if (snap.royale) return { ...royaleThink(snap, snap.royale, me, arena, mem, rand), pick: choice };

  const perceived = perceive(snap, arena, me, mem.awareness);
  const { awareness } = perceived;
  // What it read off each enemy it saw, whom it shoots first, and where it pre-aims (see tactics.ts); a fresh life starts a fresh read.
  const { view, tactics } = readTactics(mem.intent ? mem.tactics ?? null : null, perceived.view, awareness);
  const persona = PERSONALITIES[mem.persona];
  const ctx: IntentCtx = { tick: snap.tick, persona, role: roleFor(me.id, me.team), band: bandFor(view.me.gun, persona), arena, rand, ...tier, supply: supplyFor(snap, me, (p) => isOpen(arena.nav, p)), tac: tactics };
  const intent = nextIntent(mem.intent ?? startIntent({ k: 'patrol', goal: me }, ctx), view, ctx);
  const { input, motor } = act(intent, view, ctx, mem.motor, snap);
  return { input, pick: choice, mem: { ...mem, intent, awareness, motor, tactics } };
}

export type TeamCounts = { red: number; blue: number };

/**
 * How many bots each team gets so the room holds at least `minPlayers` and both sides are equally strong, a human counting as `botsPerHuman` bots.
 * A team left without its humans gets extra bots rather than playing short against the other side's humans, up to `maxBots` in all.
 */
export function botSeats(humans: TeamCounts, minPlayers: number, botsPerHuman: number, maxBots: number): TeamCounts {
  const gap = (humans.red - humans.blue) * botsPerHuman;
  const total = Math.min(maxBots, Math.max(minPlayers - humans.red - humans.blue, Math.round(Math.abs(gap))));
  const imbalance = (red: number) => Math.abs(humans.red * botsPerHuman + red - humans.blue * botsPerHuman - (total - red));
  const red = Math.max(0, Math.min(total, Math.floor((total - gap) / 2)));
  const best = red + 1 <= total && imbalance(red + 1) < imbalance(red) ? red + 1 : red;
  return { red: best, blue: total - best };
}

/** Bots go by everyday gamertags, so a room reads like a lobby of real players. */
const BOT_NAMES = [
  'mariah_27', 'TheoPlays', 'robby500', 'KayOnXbox', 'HassanK9', 'livin4games', 'BigAl1978', 'sandybeach88',
  'Jules_404', 'FrancoPlays', 'nickatnite22', 'MindyMoo', 'rajplaysgames', 'benji2k', 'ItsMeTori', 'DustyController',
  'cameron_17', 'lizzieQ', 'MoRunsMid', 'JakeFromIT', 'paulieB', 'KeishaPlays', 'ArcticMikey', 'Nando_6',
  'amberwaves', 'GabiOnTheGo', 'trevorD93', 'yusuf_13', 'JessPlaysLate', 'chuckwagon7', 'DeejayRico', 'MarnieMae',
  'leodotexe', 'tonybologna', 'kimchiKris', 'birdwatcher84', 'Maxine_5', 'MikeLikesTacos', 'danielpdx',
  'shortstack42', 'ChrisWithThePlan', 'wendyw', 'OmarWasTaken', 'RonnieRae', 'JaeTheGreat', 'dani_plays',
  'HeatherB33', 'chillinwithphil', 'BigMoe77', 'SofiaSaysHi', 'nicknackpaddy', 'justincredible', 'ElizaBee9',
  'jojo_lefty', 'larsen_21', 'VeeDubJay', 'HannahBanana', 'FrankieFourEyes', 'malikonline', 'StevieNicksFan',
  'gabe_plays', 'PriyankaP', 'Scotty2Hotty', 'BonnieOnBreak', 'JordanWasHere', 'DonnyD35', 'Akiro88', 'HayleyK',
  'papabear101', 'LozzaB', 'CharliPlays', 'mrbiggles', 'ErinGoBragh', 'RudyRuiz', 'debs_17', 'SamwiseNot',
  'lilacsky9', 'JamalFromWork', 'dougieFresh', 'MsBeccaB', 'MannyTheMan', 'KaylaKay', 'marcoPolo88', 'audrey_3',
  'TimFromOhio', 'vinnyb', 'zainplays', 'kelleyokeefe', 'PattyCakes7', 'ReeceTheBeast', 'justmaddie', 'ZedIsDead',
  'harperjune', 'DevWithTheMoves', 'MaureenM', 'rayray_22', 'RandySavageish', 'ShilohB', 'lancealot', 'abbycadabby',
  'Chuy_64', 'ItsProbablyDan', 'monicagellerish', 'JonoPlays', 'OldSchoolKev', 'NiaNiaNia', 'ShaneTrain9',
  'boba_fettish', 'YukiOnXbox', 'TrentB', 'frankthetank', 'MaddogMaddie', 'drewdrew', 'TheRealTerry', 'AnaBanana',
  'TimoTime', 'wildbill83', 'RachelFromHR', 'BigPermEnergy', 'SaltyGary', 'matthewcooks', 'jessicah_8',
  'ZekeTheGeek', 'LouieLouie', 'CarlaConQueso', 'AaronAtHome', 'pinksocks', 'DarnellDidIt', 'noahisland', 'bethanyK',
  'jaybird_6', 'CassieCakes', 'MohanPlays', 'RoxyRocks', 'jimmyjam21', 'CelesteOnMic', 'AlFromAccounting',
  'Bradster', 'lucasM45', 'ImNotYourDad', 'TaraTastic', 'GhostedByWifi', 'NikoWithThePlan', 'lil_miss_mayhem',
  'frankie2phones', 'CurtisB', 'SkaterJay', 'MitskiFan99', 'DevonDoesStuff', 'SantiPlays', 'janetjacksonfan',
  'Theo_77', 'ShrekIsLove', 'AdilKhanish', 'tori_rocks', 'CoachMiller', 'maxxpower', 'WandaAtLarge', 'RenPlaysCoop',
  'thatsmydog', 'ClaudiaC', 'PeanutButterDan', 'karlwithak', 'amirthegamer', 'nancyb_12', 'BigDaleEnergy',
  'mitchyRich', 'LoloOnXbox', 'EugeneKrabsish', 'JessFromPayroll', 'simbaFan23', 'RobynHood', 'dylan_d',
  'onewheelmike', 'raeofsunshine', 'ArchieBunkerish', 'clarkkentish', 'BenThereDoneThat', 'Kiki_88', 'SoCalManny',
  'mariachiMike', 'DeannaRose', 'TboneSteak', 'HikeAndSeek', 'Finnigan_7', 'poormanspro', 'MegInAccounting',
  'QuentinQ', 'ShabazPlays', 'bertandernie', 'LaurenSaysGG', 'treefrogTom', 'StefanTheMan', 'KrispyKremeKid',
  'Amal_5', 'PapaMoose', 'samwisegamer', 'KariOn', 'MackenzieM', 'olliepop',
];

export function botName(taken: ReadonlySet<string>, rand: () => number): string {
  const free = BOT_NAMES.filter((n) => !taken.has(n));
  if (free.length) return pick(free, rand);
  for (;;) {
    const name = `${pick(BOT_NAMES, rand)} ${Math.floor(rand() * 90) + 10}`;
    if (!taken.has(name)) return name;
  }
}
