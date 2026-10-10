import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { badgeKey, CAREER, CAREER_IDS, KM_PX, MEDAL_IDS, WEAPON_IDS, ZOM_STATS, type Badge, type MedalId, type WeaponId, type ZomStat } from '../shared/defs.ts';
import { challengesView, cleanItems, DAILY_POOL, rollChallenges, WEEKLY_POOL, type ChallengesState } from '../shared/challenges.ts';
import { COSMETIC_BY_ID, dayKey, levelState, lifeGains, resolveEquipped, roundGains, SLOTS, toCos, isCosmeticId, type Cos, type Equipped, type Picks, type ProgressMsg, type RoundResult } from '../shared/cosmetics.ts';
import { challengeEvents, equip as equipOn, grantUnlocks, hasNews, newPending, settle, syncLevel, type Pending } from './progression.ts';

/**
 * Every human name has a profile, signed in or not: career kills and deaths, matches, best streak, distance walked, every
 * medal earned, and every lifetime medal (a rung of a `CAREER` track) with when it was earned. A registered account owns its
 * name: registering wipes whatever guests left under it, and from then on only the signed-in account writes to it (see
 * `profileKey` in room.ts). Guests sharing an unregistered name share a profile. Bots keep none.
 */
export type Profile = {
  name: string;
  kills: number;
  deaths: number;
  games: number;
  bestStreak: number;
  /** Career distance walked, in px. */
  distance: number;
  medals: Partial<Record<MedalId, number>>;
  /** Career kills by weapon class, for the weapon mastery tracks. */
  weaponKills: Partial<Record<WeaponId, number>>;
  /** What Zombies runs added (`ZOM_STATS`), for the Zombies tracks: running totals, but `bestNight` is a best. */
  zombies: Partial<Record<ZomStat, number>>;
  /** When each lifetime medal was earned, in ms since the epoch, by `badgeKey`. */
  badges: Record<string, number>;
  firstSeen: number;
  lastSeen: number;
  /** Account progression (see cosmetics.ts): total XP, and the level and prestige stars it works out to. */
  xp: number;
  level: number;
  prestige: number;
  /** Every cosmetic id this profile may wear, defaults included. */
  unlocked: string[];
  /** What it wears, defaults left out. */
  equipped: Picks;
  /** Daily and weekly challenges; the sets roll over lazily, when a key no longer matches the clock. */
  challenges: ChallengesState;
  /** The UTC day of the last round won, for the first-win-of-the-day bonus. */
  lastWinDay: string;
  /**
   * A guest profile's owner: the SHA-256 (hex) of the secret in the guest claim token handed to the connection that made it
   * (see `adoptGuest`). Only that token can carry the profile into a new account (`reserveClaim`). Never served by the API;
   * absent on an account's profile, on a claimed one and on guest profiles made before claims existed.
   */
  owner?: string;
};

/** What a registration takes from a guest profile: whose it was (its key) and the owner hash that proved it. */
export type GuestClaim = { from: string; owner: string };

/** Career stats, plus events that only feed challenges (`wins`, `finishes`, `nights`, `zkills`, `bastion`) and are not stored. */
export type ProfileDelta = {
  kills?: number; deaths?: number; games?: number; streak?: number; distance?: number; medals?: readonly MedalId[]; weaponKills?: readonly WeaponId[];
  /** Zombies stats to add, or for `bestNight` the night reached (kept when it beats the best). */
  zom?: Partial<Record<ZomStat, number>>;
  wins?: number; finishes?: number; nights?: number; zkills?: number; bastion?: number;
};

export type Profiles = {
  get(name: string): Profile | null;
  /** Folds a change into a name's profile, making the profile if need be, and returns any lifetime medals it newly earned. */
  record(name: string, delta: ProfileDelta, now?: number): Badge[];
  /** The rarest lifetime medal a name holds, the one it wears in matches. */
  featured(name: string): Badge | null;
  /** Pays the XP a finished life earned (kills and score, capped), and counts toward challenges. */
  life(name: string, life: { score: number; kills: number }, now?: number): void;
  /** Pays a round end's XP (doubled for the first win of the UTC day) and feeds the round's results to challenges. */
  round(name: string, result: RoundResult, now?: number): void;
  /** What the player has not yet been told since the last call (XP, level-ups, unlocks), as a `progress` message; null when nothing is new. */
  notice(name: string, now?: number): ProgressMsg | null;
  /** The player's whole progress as a `progress` message with nothing gained, or null without a profile. */
  state(name: string, now?: number): ProgressMsg | null;
  /** Wears `picks` (see `equip` in progression.ts); makes the profile if need be. `strict` applies nothing when any pick is refused. */
  equip(name: string, picks: Picks, strict?: boolean): { ok: boolean; rejected: string[]; equipped: Equipped };
  /** What a name wears, as the snapshot carries it, or null for no profile. */
  cos(name: string): Cos | null;
  /** Wipes a name's profile, when an account is registered under it, so nobody inherits what guests did under that name. */
  reset(name: string): void;
  /**
   * Makes a new guest profile under `name` (which must have none) and returns its claim token: the only proof that can later
   * carry it into an account. Null when the name already has a profile.
   */
  adoptGuest(name: string, now?: number): string | null;
  /**
   * Checks a guest claim token against the profile it names and, when it proves an unclaimed one, holds that profile for this
   * claim (a second claim on it is refused until `commitClaim` or `releaseClaim`). Null for a forged, stale or held token.
   */
  reserveClaim(token: string): (GuestClaim & { kills: number; deaths: number; games: number }) | null;
  /** Lets go of a held claim that will not be committed. */
  releaseClaim(claim: GuestClaim): void;
  /**
   * Carries a held (or, on recovery, recorded) guest profile into account `to`: wipes whatever guests left under `to`, moves
   * the profile there, drops its owner so the token is spent, and saves at once. False, changing nothing but the wipe, when the
   * guest profile is gone or no longer has that owner (already carried over).
   */
  commitClaim(claim: GuestClaim, to: string): Promise<boolean>;
  /**
   * Startup recovery, run once accounts are loaded: finishes every recorded claim whose move never reached profiles.json, and
   * wipes guest-owned profiles left under account names (a registration's wipe that never reached disk).
   */
  reconcile(accounts: readonly { name: string; claim?: GuestClaim }[]): Promise<void>;
  flush(): Promise<void>;
};

const key = (name: string) => name.toLowerCase();
const SAVE_DELAY_MS = 2000;
const sha256 = (secret: string) => createHash('sha256').update(secret).digest('hex');
const OWNER_HASH = /^[0-9a-f]{64}$/;

/** A guest claim token: `<base64url of the lowercased name>.<256-bit random secret, base64url>`. */
export function parseGuestToken(token: unknown): { key: string; secret: string } | null {
  if (typeof token !== 'string' || token.length > 256) return null;
  const m = /^([A-Za-z0-9_-]{1,200})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return null;
  return { key: Buffer.from(m[1]!, 'base64url').toString(), secret: m[2]! };
}
const ownerMatches = (p: Profile | undefined, owner: string) =>
  !!p?.owner && p.owner.length === owner.length && timingSafeEqual(Buffer.from(p.owner), Buffer.from(owner));

export const freshProfile = (name: string, now: number): Profile => {
  const p: Profile = {
    name, kills: 0, deaths: 0, games: 0, bestStreak: 0, distance: 0, medals: {}, weaponKills: {}, zombies: {}, badges: {}, firstSeen: now, lastSeen: now,
    xp: 0, level: 1, prestige: 0, unlocked: [], equipped: {}, challenges: { day: '', daily: [], week: '', weekly: [] }, lastWinDay: '',
  };
  grantUnlocks(p);
  return p;
};

/** How far a profile has come on a track. */
export function trackCount(p: Profile, track: (typeof CAREER_IDS)[number]): number {
  const needs = CAREER[track].needs;
  if (needs === 'km') return Math.floor(p.distance / KM_PX);
  if (needs === 'kills' || needs === 'games' || needs === 'bestStreak') return p[needs];
  if (needs.startsWith('kills:')) return p.weaponKills[needs.slice(6) as WeaponId] ?? 0;
  if (needs.startsWith('zom:')) return Math.floor(p.zombies[needs.slice(4) as ZomStat] ?? 0);
  return p.medals[needs as MedalId] ?? 0;
}

/** Applies `delta` to a profile and stamps every rung of a track it now reaches; returns the newly earned ones. */
export function applyDelta(p: Profile, delta: ProfileDelta, now: number): Badge[] {
  p.kills += delta.kills ?? 0;
  p.deaths += delta.deaths ?? 0;
  p.games += delta.games ?? 0;
  p.distance += delta.distance ?? 0;
  p.bestStreak = Math.max(p.bestStreak, delta.streak ?? 0);
  for (const m of delta.medals ?? []) p.medals[m] = (p.medals[m] ?? 0) + 1;
  for (const g of delta.weaponKills ?? []) p.weaponKills[g] = (p.weaponKills[g] ?? 0) + 1;
  for (const stat of ZOM_STATS) {
    const n = delta.zom?.[stat];
    if (!n || !(n > 0) || !Number.isFinite(n)) continue;
    p.zombies[stat] = stat === 'bestNight' ? Math.max(p.zombies[stat] ?? 0, n) : (p.zombies[stat] ?? 0) + n;
  }
  p.lastSeen = now;
  const earned: Badge[] = [];
  for (const track of CAREER_IDS) {
    const have = trackCount(p, track);
    CAREER[track].at.forEach((need, tier) => {
      const b: Badge = { track, tier: tier as Badge['tier'] };
      if (have >= need && p.badges[badgeKey(b)] === undefined) { p.badges[badgeKey(b)] = now; earned.push(b); }
    });
  }
  return earned;
}

/** The rarest lifetime medal held: the highest tier on any track, the first such track in `CAREER_IDS` order. */
export function featuredBadge(p: Profile): Badge | null {
  let best: Badge | null = null;
  for (const track of CAREER_IDS) {
    for (let tier = 3; tier >= 0; tier--) {
      if (p.badges[badgeKey({ track, tier: tier as Badge['tier'] })] === undefined) continue;
      if (!best || tier > best.tier) best = { track, tier: tier as Badge['tier'] };
      break;
    }
  }
  return best;
}

/** Drops anything a saved file holds that the game no longer knows, so an old file cannot smuggle odd keys onto a page. */
function clean(raw: unknown): Profile | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  if (typeof r.name !== 'string') return null;
  const pick = <K extends string>(ids: readonly K[], v: unknown) => {
    const out: Partial<Record<K, number>> = {};
    if (v && typeof v === 'object') for (const id of ids) if (num((v as Record<string, unknown>)[id])) out[id] = num((v as Record<string, unknown>)[id]);
    return out;
  };
  const c = r.challenges && typeof r.challenges === 'object' ? (r.challenges as Record<string, unknown>) : {};
  const keys = CAREER_IDS.flatMap((track) => [0, 1, 2, 3].map((tier) => badgeKey({ track, tier: tier as Badge['tier'] })));
  const p: Profile = {
    name: r.name, kills: num(r.kills), deaths: num(r.deaths), games: num(r.games), bestStreak: num(r.bestStreak), distance: num(r.distance),
    medals: pick(MEDAL_IDS, r.medals), weaponKills: pick(WEAPON_IDS, r.weaponKills), zombies: pick(ZOM_STATS, r.zombies), badges: pick(keys, r.badges) as Record<string, number>, firstSeen: num(r.firstSeen), lastSeen: num(r.lastSeen),
    // Profiles saved before progression existed have none of this: they start at level 1 and are retro-granted what their lifetime medals earn.
    xp: Math.floor(num(r.xp)), level: 1, prestige: 0,
    unlocked: Array.isArray(r.unlocked) ? r.unlocked.filter((id): id is string => typeof id === 'string' && COSMETIC_BY_ID.has(id)) : [],
    equipped: {},
    challenges: {
      day: typeof c.day === 'string' ? c.day.slice(0, 10) : '', daily: cleanItems(c.daily, DAILY_POOL),
      week: typeof c.week === 'string' ? c.week.slice(0, 8) : '', weekly: cleanItems(c.weekly, WEEKLY_POOL),
    },
    lastWinDay: typeof r.lastWinDay === 'string' ? r.lastWinDay.slice(0, 10) : '',
    ...(typeof r.owner === 'string' && OWNER_HASH.test(r.owner) && { owner: r.owner }),
  };
  syncLevel(p);
  grantUnlocks(p);
  const eq = r.equipped && typeof r.equipped === 'object' ? (r.equipped as Record<string, unknown>) : {};
  for (const slot of SLOTS) { const id = eq[slot]; if (isCosmeticId(slot, id) && p.unlocked.includes(id)) p.equipped[slot] = id; }
  return p;
}

export async function openProfiles(dataDir: string): Promise<Profiles> {
  await mkdir(dataDir, { recursive: true });
  const file = join(dataDir, 'profiles.json');
  const byKey = new Map<string, Profile>();
  try {
    const saved = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    for (const raw of Object.values(saved)) {
      const p = clean(raw);
      if (p) byKey.set(key(p.name), p);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  /** What each online player has not yet been told, by profile key. */
  const news = new Map<string, Pending>();
  const noteFor = (k: string) => { let n = news.get(k); if (!n) news.set(k, (n = newPending())); return n; };
  const edit = (name: string, now: number) => {
    let p = byKey.get(key(name));
    if (!p) byKey.set(key(name), (p = freshProfile(name, now)));
    return p;
  };
  const message = (p: Profile, now: number, n: Pending): ProgressMsg => {
    p.challenges = rollChallenges(p.challenges, now, p.name, new Set(p.unlocked));
    return { t: 'progress', xp: p.xp, ...levelState(p.xp), gained: n.gained, levelUps: n.levelUps, unlocks: n.unlocks, challenges: challengesView(p.challenges, now), equipped: resolveEquipped(p.equipped) };
  };

  let saveQueue = Promise.resolve();
  const save = () => {
    saveQueue = saveQueue
      .then(async () => { await writeFile(`${file}.tmp`, JSON.stringify(Object.fromEntries(byKey))); await rename(`${file}.tmp`, file); })
      .catch((err: unknown) => console.error('profiles save failed', err));
    return saveQueue;
  };
  let pending: ReturnType<typeof setTimeout> | null = null;
  const saveSoon = () => { pending ??= setTimeout(() => { pending = null; void save(); }, SAVE_DELAY_MS); };
  /** Saves now, folding in any debounced save. */
  const saveNow = () => { if (pending) { clearTimeout(pending); pending = null; } return save(); };
  /** Guest profiles held by a registration between its checks and its commit, by key, with the owner hash that holds them. */
  const held = new Map<string, string>();
  /** The move itself, all in memory and in one synchronous step; the caller saves. */
  const move = (claim: GuestClaim, to: string): boolean => {
    held.delete(claim.from);
    const p = byKey.get(claim.from);
    news.delete(key(to));
    if (!p || !ownerMatches(p, claim.owner)) { byKey.delete(key(to)); return false; }
    byKey.delete(claim.from);
    news.delete(claim.from);
    byKey.delete(key(to));
    delete p.owner;
    p.name = to;
    byKey.set(key(to), p);
    return true;
  };
  return {
    get: (name) => byKey.get(key(name)) ?? null,
    record(name, delta, now = Date.now()) {
      const p = edit(name, now);
      const earned = applyDelta(p, delta, now);
      settle(p, noteFor(key(name)), { events: challengeEvents(delta) }, now);
      saveSoon();
      return earned;
    },
    life(name, life, now = Date.now()) {
      const p = edit(name, now);
      settle(p, noteFor(key(name)), { gains: lifeGains(life.score, life.kills) }, now);
      saveSoon();
    },
    round(name, result, now = Date.now()) {
      const p = edit(name, now);
      const gains = roundGains(result);
      const today = dayKey(now);
      if (result.won && p.lastWinDay !== today) {
        gains.push({ reason: 'firstWin', xp: gains.reduce((sum, g) => sum + g.xp, 0) });
        p.lastWinDay = today;
      }
      settle(p, noteFor(key(name)), { gains, events: { wins: result.won ? 1 : 0, finishes: result.finished ? 1 : 0, nights: result.nights, bastion: result.bastion ? 1 : 0 } }, now);
      saveSoon();
    },
    notice(name, now = Date.now()) {
      const p = byKey.get(key(name)), n = news.get(key(name));
      if (!p || !n || !hasNews(n)) return null;
      news.delete(key(name));
      return message(p, now, n);
    },
    state(name, now = Date.now()) {
      const p = byKey.get(key(name));
      if (!p) return null;
      const n = news.get(key(name)) ?? newPending();
      news.delete(key(name));
      return message(p, now, n);
    },
    equip(name, picks, strict = false) {
      const p = edit(name, Date.now());
      const r = equipOn(p, picks, strict);
      if (r.ok || !strict) saveSoon();
      return { ...r, equipped: resolveEquipped(p.equipped) };
    },
    cos(name) {
      const p = byKey.get(key(name));
      return p ? toCos(p.equipped, p.level, p.prestige) : null;
    },
    featured(name) {
      const p = byKey.get(key(name));
      return p ? featuredBadge(p) : null;
    },
    reset(name) {
      news.delete(key(name));
      // A guest profile held by a claim is about to move to its new account; the commit takes it off this name.
      if (held.has(key(name))) return;
      if (byKey.delete(key(name))) void saveNow();
    },
    adoptGuest(name, now = Date.now()) {
      if (byKey.has(key(name))) return null;
      const secret = randomBytes(32).toString('base64url');
      const p = freshProfile(name, now);
      p.owner = sha256(secret);
      byKey.set(key(name), p);
      saveSoon();
      return `${Buffer.from(key(name)).toString('base64url')}.${secret}`;
    },
    reserveClaim(token) {
      const t = parseGuestToken(token);
      if (!t) return null;
      const owner = sha256(t.secret);
      const p = byKey.get(t.key);
      if (!p || !ownerMatches(p, owner) || held.has(t.key)) return null;
      held.set(t.key, owner);
      return { from: t.key, owner, kills: p.kills, deaths: p.deaths, games: p.games };
    },
    releaseClaim(claim) {
      if (held.get(claim.from) === claim.owner) held.delete(claim.from);
    },
    async commitClaim(claim, to) {
      const moved = move(claim, to);
      await saveNow();
      return moved;
    },
    async reconcile(accounts) {
      let changed = false;
      for (const a of accounts) if (a.claim && ownerMatches(byKey.get(a.claim.from), a.claim.owner)) changed = move(a.claim, a.name) || changed;
      for (const a of accounts) {
        const p = byKey.get(key(a.name));
        if (p?.owner) { byKey.delete(key(a.name)); changed = true; }
      }
      if (changed) await saveNow();
    },
    flush() {
      if (pending) { clearTimeout(pending); pending = null; void save(); }
      return saveQueue;
    },
  };
}

/** A profile as the API serves it: everything stored, plus the level state, the resolved equipped set and the challenges with their texts and reset times. */
export function profileView(p: Profile, now = Date.now()) {
  p.challenges = rollChallenges(p.challenges, now, p.name, new Set(p.unlocked));
  const { owner: _owner, ...shown } = p;
  return { ...shown, featured: featuredBadge(p), ...levelState(p.xp), equipped: resolveEquipped(p.equipped), challenges: challengesView(p.challenges, now) };
}

/** A profile store that keeps nothing, for rooms and tests that need none. */
export const NO_PROFILES: Profiles = {
  get: () => null, record: () => [], featured: () => null, reset: () => {}, flush: () => Promise.resolve(),
  adoptGuest: () => null, reserveClaim: () => null, releaseClaim: () => {}, commitClaim: () => Promise.resolve(false), reconcile: () => Promise.resolve(),
  life: () => {}, round: () => {}, notice: () => null, state: () => null, equip: () => ({ ok: false, rejected: [], equipped: resolveEquipped(undefined) }), cos: () => null,
};
