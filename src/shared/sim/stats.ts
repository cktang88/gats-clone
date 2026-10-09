import {
  ABILITY_COOLDOWN_MS, ARMORS, GUN_IDS, SPREAD_EASE, SPRINT, SUPPRESSION, TIER2_OFFER, GUNS, LEVELS, minSpreadOf, PERK_TIERS, pickOptions, rulesOf, settleRulesOf, VIEW, WORLD, type AbilityId, type GunId, type GunRules, type PendingPick, type PerkId, type PickOption, type Tier,
} from '../defs.ts';
import { loadOf, sprintShareOf, walkMulOf } from '../handling.ts';
import { rand, type Life, type PerkOfTier, type Player, type World } from './world.ts';

type PerkMods = {
  spreadMul?: number; pelletSpreadMul?: number; reloadMul?: number; magMul?: number; rangeMul?: number; speedMul?: number;
  maxHpAdd?: number; regenMul?: number; regenDelayMul?: number; viewMul?: number;
  /** Sprint speed, post-sprint settle length, spray bloom build and recovery rate, ability cooldown, all as multipliers. */
  sprintMul?: number; settleMul?: number; bloomBuildMul?: number; bloomRecoverMul?: number; cooldownMul?: number;
  piercing?: true; silenced?: true; shield?: true; thermal?: true; ghillie?: true;
};

const PERK_MODS: Record<PerkId, PerkMods> = {
  optics: { viewMul: 1.12 },
  thermal: { thermal: true },
  ghillie: { ghillie: true },
  piercing: { piercing: true },
  extended: { magMul: 1.5 },
  grip: { spreadMul: 0.6 },
  silencer: { silenced: true },
  lightweight: { speedMul: 1.25 },
  longRange: { rangeMul: 1.4 },
  quickReload: { reloadMul: 0.65 },
  choke: { pelletSpreadMul: 0.75 },
  shield: { shield: true },
  thickSkin: { maxHpAdd: 40 },
  firstAid: { regenMul: 3, regenDelayMul: 0.4 },
  marathon: { sprintMul: 1.15, settleMul: 0.5 },
  steadyHands: { bloomBuildMul: 0.6, bloomRecoverMul: 1.6, settleMul: 0.75 },
  secondWind: {}, adrenaline: {}, bloodlust: {}, ninja: {}, demolitions: {}, tracker: {}, brace: {},
  recon: { viewMul: 1.08 },
  overclock: { cooldownMul: 0.7 },
  fastHands: { reloadMul: 0.75 },
  grenade: {}, fragGrenade: {}, gasGrenade: {}, landMine: {}, knife: {}, engineer: {}, dash: {}, flashbang: {}, smokeGrenade: {},
};

/** Tuning for the perks that act on events rather than stats. */
export const PERK_RULES = {
  adrenaline: { speedMul: 1.2, ms: 3000 },
  secondWind: { belowHp: 0.25, speedMul: 1.3, ms: 2000, damageMul: 0.5 },
  bloodlust: { healShare: 0.15 },
  demolitions: { dealtMul: 1.3, radiusMul: 1.3, takenMul: 0.7 },
  tracker: { ms: 4000 },
  brace: { takenMul: 0.4, dealtMul: 1.15 },
} as const;

export const hasPerk = (p: Pick<Player, 'perks'>, perk: PerkId): boolean => Object.values(p.perks).includes(perk);

/** `settleMs`: how long the post-sprint bloom takes to ease out once a sprint ends (the gun's, after perks). */
type Stats = {
  speed: number; sprintSpeed: number; settleMs: number; maxHp: number; mag: number; range: number; reloadMs: number; regenPerSec: number; regenDelayMs: number;
  viewRadius: number; piercing: boolean; silenced: boolean; shield: boolean; thermal: boolean; ghillie: boolean;
};

/**
 * Spread of the `sprayShot`th shot of a spray (0 outside one), on the move or `still`, after perks and `suppression`. Nothing fires tighter than
 * the gun's floor (`minSpreadOf`), however planted or perked; a pinpoint gun planted, steady and unsuppressed sits right on it. Bloom adds on
 * top of that: all of its growth on the move, `bloom.still` of it standing, `deploy.bloom` with a bipod down; a pinpoint gun's grows from
 * its own still spread (not from zero), so a sniper's follow-up opens the cone wide even planted. `settle` (0..1, see `settleShare`) is the
 * post-sprint bloom still to ease out (see `postSprintSpread`). This is the spread's target; what a shot gets is it eased (see `easeSpread`).
 */
export function spreadFor(gun: GunId, perks: Partial<Record<Tier, PerkId>>, still: boolean, sprayShot = 0, suppression = 0, settle = 0, deployed = false): number {
  const def = GUNS[gun], rules = rulesOf(def);
  const pin = still && rules.pinpoint && suppression <= SUPPRESSION.breaksPinpoint && settle <= 0.05;
  const bloomBuild = Object.values(perks).reduce((m, perk) => m * (PERK_MODS[perk].bloomBuildMul ?? 1), 1);
  const bipod = still && deployed && rules.deploy ? rules.deploy : null;
  const moving = def.spread + rules.movingSpreadAdd;
  const base = pin ? 0 : still ? def.spread * (bipod?.spreadMul ?? 1) : moving;
  const share = !still ? 1 : bipod ? bipod.bloom : rules.bloom?.still ?? 1;
  // A pinpoint gun's bloom is a kick of its own still spread whatever its stance, so a sniper on the move is not thrown a mile wide on top of its walking cone.
  const grown = (rules.pinpoint ? def.spread : base) * (bloomMul(rules, sprayShot, bloomBuild) - 1) * share;
  let mul = 1;
  for (const perk of Object.values(perks)) mul *= (PERK_MODS[perk].spreadMul ?? 1) * (def.pellets > 1 ? PERK_MODS[perk].pelletSpreadMul ?? 1 : 1);
  const stance = Math.max(minSpreadOf(def, bipod !== null), base * mul) + grown * mul;
  return postSprintSpread(stance, moving * mul, settle, settleRulesOf(def).mul) * suppressionMul(suppression);
}

/**
 * The post-sprint bloom over a `stance` spread, `settle` being the share (0..1) of it still to ease out: at 1 the spread is `mul` times
 * the gun's `moving` spread (or the stance's, if that is wider still), easing out quadratically to the stance's own at 0.
 */
export function postSprintSpread(stance: number, moving: number, settle: number, mul: number = SPRINT.settleMul): number {
  const k = Math.max(0, Math.min(1, settle)) ** 2;
  return stance + Math.max(0, mul * moving - stance) * k;
}

/** The share (0..1) of the post-sprint bloom still to ease out, `left` ms of its `settleMs` still to run. */
export const settleShare = (left: number, settleMs: number): number => (settleMs > 0 ? Math.max(0, Math.min(1, left / settleMs)) : 0);

/** How many ticks of spread targets the eased spread averages: a change takes at least `SPREAD_EASE.ms` to come through in full. */
export const SPREAD_EASE_TICKS = Math.ceil(SPREAD_EASE.ms / (1000 / WORLD.tickHz)) + 1;

/**
 * One tick of the eased spread (`SPREAD_EASE`): the last `SPREAD_EASE_TICKS` targets, oldest first, this tick's `target` on the end. Their
 * mean is the spread a shot gets, so any change of the target ramps in linearly over the window and never in less than `SPREAD_EASE.ms`.
 * `kick` is the part of the target a shot's bloom added since last tick: it lands at once (every kept target is raised by it), and
 * comes back down with the target, eased like the rest. An empty history (a fresh life) starts settled on the target.
 */
export function easeSpread(hist: readonly number[], target: number, kick = 0): number[] {
  if (hist.length === 0) return new Array<number>(SPREAD_EASE_TICKS).fill(target);
  const out = hist.slice(hist.length >= SPREAD_EASE_TICKS ? 1 : 0).map((x) => x + Math.max(0, kick));
  out.push(target);
  return out;
}
/** The eased spread a history holds (see `easeSpread`). */
export const easedSpread = (hist: readonly number[]): number => (hist.length === 0 ? 0 : hist.reduce((a, b) => a + b, 0) / hist.length);

/** How fast spray bloom recovers, as a multiplier (Steady Hands): the same for a bot as for a person. */
export const bloomRecoverMul = (perks: Partial<Record<Tier, PerkId>>): number =>
  Object.values(perks).reduce((m, perk) => m * (PERK_MODS[perk].bloomRecoverMul ?? 1), 1);

/** How much `suppression` (0..1) widens spread. */
export const suppressionMul = (suppression: number): number => 1 + suppression * SUPPRESSION.spread;

function bloomMul({ bloom }: GunRules, sprayShot: number, build = 1): number {
  return bloom ? Math.min(bloom.maxMul, 1 + bloom.perShot * build * Math.max(0, sprayShot - bloom.free)) : 1;
}

/** Whether the gun has the still spread, `sinceMoveMs` after the last step (0 while walking). */
export const isSteady = (gun: GunId, sinceMoveMs: number): boolean => sinceMoveMs > 0 && sinceMoveMs >= rulesOf(GUNS[gun]).steadyMs;

/** Whether a gun with a `deploy` is planted, `sinceMoveMs` after the last step (0 while walking). */
export const isDeployed = (gun: GunId, sinceMoveMs: number): boolean => {
  const { deploy } = rulesOf(GUNS[gun]);
  return deploy !== null && sinceMoveMs > 0 && sinceMoveMs >= deploy.ms;
};

/** How much of its damage a round of `gun` keeps after flying `flownPx` (`GunRules.falloff`): 1 out to the fade's start, then down to its floor. */
export function falloffMul(gun: GunId, flownPx: number): number {
  const { falloff } = rulesOf(GUNS[gun]);
  if (!falloff || flownPx <= falloff.startPx) return 1;
  const k = Math.min(1, (flownPx - falloff.startPx) / Math.max(1, falloff.endPx - falloff.startPx));
  return 1 - (1 - falloff.minMul) * k;
}

export const reloadMsFor = (gun: GunId, perks: Partial<Record<Tier, PerkId>>): number =>
  Object.values(perks).reduce((ms, perk) => ms * (PERK_MODS[perk].reloadMul ?? 1), GUNS[gun].reloadMs);

/** The most any one perk stretches a gun's range. */
export const MAX_RANGE_MUL = Math.max(...Object.values(PERK_MODS).map((m) => m.rangeMul ?? 1));

export const rangeFor = (gun: GunId, perks: Partial<Record<Tier, PerkId>>): number =>
  Object.values(perks).reduce((range, perk) => range * (PERK_MODS[perk].rangeMul ?? 1), GUNS[gun].range);

/** Every view bonus `gun` and `perks` give, as fractions (0.12 is +12%): the gun's scope first, then each perk's. */
export const viewBonuses = (gun: GunId, perks: Partial<Record<Tier, PerkId>>): number[] =>
  [rulesOf(GUNS[gun]).viewMul - 1, ...Object.values(perks).map((perk) => (PERK_MODS[perk].viewMul ?? 1) - 1)].filter((b) => b > 0);

/**
 * How far `bonuses` stretch the view of a `cap` class, with diminishing returns (see `VIEW`): each closes its share of the gap left to
 * `1 + cap`, so the order makes no difference, one bonus alone gives its whole value, and the total never reaches `1 + cap`.
 */
export function stackView(bonuses: readonly number[], cap: number): number {
  const left = bonuses.reduce((gap, b) => gap * (1 - Math.min(Math.max(b, 0), cap) / cap), 1);
  return 1 + cap * (1 - left);
}

/** The view radius multiplier `gun` and `perks` give: everything that stretches the view, combined with diminishing returns up to the class cap. */
export const viewMulFor = (gun: GunId, perks: Partial<Record<Tier, PerkId>>): number => stackView(viewBonuses(gun, perks), VIEW.cap[GUNS[gun].base]);

export const silencedFor = (gun: GunId, perks: Partial<Record<Tier, PerkId>>): boolean =>
  (GUNS[gun].silenced ?? false) || Object.values(perks).some((perk) => PERK_MODS[perk].silenced ?? false);

/** Ability cooldown after perks (Overclock). */
export const abilityCooldownMs = (ability: AbilityId, perks: Partial<Record<Tier, PerkId>>): number =>
  Object.values(perks).reduce((ms, perk) => ms * (PERK_MODS[perk].cooldownMul ?? 1), ABILITY_COOLDOWN_MS[ability]);

/** The speed boost Adrenaline (after a kill) and Second Wind (under 25% health) are giving `p` now. */
export function rushMul(w: Pick<World, 'now'>, p: Player): number {
  const life = p.life;
  if (life.k !== 'alive') return 1;
  return (w.now < life.rushUntil ? PERK_RULES.adrenaline.speedMul : 1) * (w.now < life.windUntil ? PERK_RULES.secondWind.speedMul : 1);
}

/** Whether `input` sprints: held, moving and not firing. A press this tick also ends it (see `tickPlayer`). */
export const sprintWanted = (i: { sprint?: boolean; fire?: boolean; up?: boolean; down?: boolean; left?: boolean; right?: boolean }): boolean =>
  i.sprint === true && !i.fire && (!!i.right !== !!i.left || !!i.down !== !!i.up);

export function effectiveStats(p: Player): Stats {
  const weapon = GUNS[p.gun];
  // The load carried (the gun's weight and length, the armor's weight) sets the walk and how much of a sprint it allows (handling.ts).
  const load = loadOf(weapon.kg, weapon.cm, ARMORS[p.loadout.armor].kg);
  const s: Stats = {
    speed: WORLD.baseSpeed * walkMulOf(load),
    sprintSpeed: 0,
    settleMs: settleRulesOf(weapon).ms,
    maxHp: WORLD.baseHp,
    mag: weapon.mag,
    range: rangeFor(p.gun, p.perks),
    reloadMs: reloadMsFor(p.gun, p.perks),
    regenPerSec: WORLD.regenPerSec,
    regenDelayMs: WORLD.regenDelayMs,
    viewRadius: WORLD.viewRadius * viewMulFor(p.gun, p.perks),
    piercing: false, silenced: silencedFor(p.gun, p.perks), shield: false, thermal: false, ghillie: false,
  };
  let sprintMul = 1 + (SPRINT.speedMul - 1) * sprintShareOf(load);
  for (const perk of Object.values(p.perks)) {
    const m = PERK_MODS[perk];
    s.mag = Math.floor(s.mag * (m.magMul ?? 1));
    s.speed *= m.speedMul ?? 1;
    sprintMul *= m.sprintMul ?? 1;
    s.settleMs *= m.settleMul ?? 1;
    s.maxHp += m.maxHpAdd ?? 0;
    s.regenPerSec *= m.regenMul ?? 1;
    s.regenDelayMs *= m.regenDelayMul ?? 1;
    s.piercing ||= m.piercing ?? false;
    s.shield ||= m.shield ?? false;
    s.thermal ||= m.thermal ?? false;
    s.ghillie ||= m.ghillie ?? false;
  }
  s.sprintSpeed = s.speed * sprintMul;
  return s;
}

export function freshLife(p: Player, now: number): Extract<Life, { k: 'alive' }> {
  const s = effectiveStats(p);
  return {
    k: 'alive', hp: s.maxHp, ammo: s.mag, reloadUntil: null, nextFireAt: 0, burstLeft: 0, spray: 0, firedAt: -Infinity, spin: 0,
    lastDamageAt: -Infinity, lastMoveAt: now, shieldUntil: now + WORLD.spawnShieldMs, dash: null, knock: null, pressUntil: -Infinity, hits: [],
    suppression: 0, suppressedAt: -Infinity, golden: false,
    sprint: false, settleLeft: 0, sprintEndAt: -Infinity, spreadHist: [], spreadShot: 0, rushUntil: -Infinity, windUntil: -Infinity, windUsed: false, tracks: {},
  };
}

export function levelForScore(score: number): number {
  let level = 0;
  LEVELS.forEach((l, i) => { if (score >= l.score) level = i; });
  return level;
}

/** The lowest reached level whose pick is still open: a perk tier left empty, or an evolution the gun has not made. */
export function pendingPick(p: Player): PendingPick | null {
  // A gun evolve never waits behind a perk left unchosen: the new gun is offered first, then the perks in ladder order.
  let evolves = 0, perk: PendingPick | null = null;
  for (let level = 1; level <= p.level; level++) {
    const pick = LEVELS[level]?.pick;
    if (!pick) continue;
    if (pick.k === 'evolve') { if (GUNS[p.gun].stage < ++evolves) return { level, ...pick }; }
    else if (!p.perks[pick.tier]) perk ??= { level, ...pick, ...(pick.tier === 2 && p.tier2Offer.length > 0 && { offer: p.tier2Offer }) };
  }
  return perk;
}

/** The hunt is a PvP pressure valve; a co-op squad has no one to hunt its own. */
export const isHunted = (w: World, p: Player): boolean => w.mode !== 'ZOM' && w.mode !== 'RNG' && GUNS[p.gun].stage === 2;

export function abilityOf(p: Player): AbilityId | null {
  return p.perks[3] ?? null;
}

/** `TIER2_OFFER` of the tier-2 pool, drawn with the world's rng so a replay offers the same perks, listed in pool order. */
export function drawTier2Offer(w: World): PerkId[] {
  const pool = [...PERK_TIERS[2]] as PerkId[];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand(w) * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  const keep = new Set(pool.slice(0, TIER2_OFFER));
  return PERK_TIERS[2].filter((perk) => keep.has(perk));
}

export function resetProgress(p: Player, w: World) {
  p.tier2Offer = drawTier2Offer(w);
  p.score = 0;
  p.level = 0;
  p.perks = {};
  p.gun = p.loadout.weapon;
  p.abilityReadyAt = 0;
}

/** An attachment the gun in hand cannot use, like a silencer on a silenced gun, is taken off so the tier-1 pick opens again on the gun's own menu. */
function reopenUselessAttachment(p: Player) {
  const attachment = p.perks[1];
  if (attachment && !pickOptions({ k: 'perk', tier: 1 }, p.gun).includes(attachment)) delete p.perks[1];
}

/** Applies `option` only when `level` is the pending pick and `option` is one of its options, so a repeated or stale pick changes nothing. */
export function choosePick(w: World, id: number, level: number, option: PickOption): boolean {
  const p = w.players.get(id);
  const pending = p && pendingPick(p);
  if (!p || p.life.k !== 'alive' || w.match.k === 'over' || pending?.level !== level || !pickOptions(pending, p.gun).includes(option)) return false;
  if (pending.k === 'perk') {
    if (!isPerkOfTier(pending.tier, option)) return false;
    const before = effectiveStats(p).maxHp;
    setPerk(p.perks, pending.tier, option);
    p.life.hp *= effectiveStats(p).maxHp / before;
    return true;
  }
  const gun = GUN_IDS.find((g) => g === option);
  if (!gun) return false;
  const oldMag = effectiveStats(p).mag;
  p.gun = gun;
  reopenUselessAttachment(p);
  p.life.ammo = hasPerk(p, 'fastHands') ? effectiveStats(p).mag : Math.round((effectiveStats(p).mag * p.life.ammo) / oldMag);
  p.life.burstLeft = 0;
  p.life.spray = 0;
  p.life.spin = 0;
  if (isHunted(w, p)) w.queuedEvents.push({ e: 'hunted', id: p.id, name: p.name });
  return true;
}

function isPerkOfTier<T extends Tier>(tier: T, option: PickOption): option is PerkOfTier<T> {
  return PERK_TIERS[tier].some((candidate) => candidate === option);
}

function setPerk<T extends Tier>(perks: { [K in T]?: PerkOfTier<K> }, tier: T, perk: PerkOfTier<T>) {
  perks[tier] = perk;
}

function catchUpMul(w: World, p: Player): number {
  const others = [...w.players.values()].filter((o) => o.id !== p.id && o.life.k === 'alive');
  if (others.length === 0) return 1;
  const average = others.reduce((sum, o) => sum + o.level, 0) / others.length;
  return p.level < average ? WORLD.catchUpMul : 1;
}

export function addScore(w: World, p: Player, amount: number) {
  if (p.life.k !== 'alive') return;
  p.score += Math.round(amount * catchUpMul(w, p));
  p.level = Math.max(p.level, levelForScore(p.score));
}
