/**
 * PROGRESSION CONTRACT (shared by server and client; the simulation never reads any of this).
 *
 * Account XP and levels, cosmetics, and challenges. This file holds the catalog and the pure rules; `challenges.ts` holds the
 * daily and weekly challenge templates and their selection. The server (src/server/profiles.ts, progression.ts, room.ts,
 * main.ts) owns all state; a client only displays it and asks to equip.
 *
 * ## Slots and items
 * Six slots (`SLOTS`): helmet, camo (torso pattern), gunSkin, nameColor, title, killFx. Every item (`Cosmetic`) has a globally
 * unique `id` of the form `<slotLetter>_<name>` (h_viking, c_woodland, g_gold, n_aurora, t_rookie, k_confetti), a `name`, a one
 * line `desc`, a `rarity`, and an `unlock` rule:
 *   `{ default: true }`            worn from the first game; exactly one per slot (`DEFAULTS`).
 *   `{ level: n }`                 granted on reaching account level n (1..100).
 *   `{ career: CareerId, tier }`   granted with that lifetime medal rung (CAREER in defs.ts, tier 0 bronze .. 3 platinum).
 *   `{ challenge: true }`          granted only by a weekly challenge (`ChallengeItem.grant`).
 * `swatch` is a list of art-bible hex colours for previews: one flat colour, or 2+ gradient stops (nameColor, left to right);
 * `animated` marks the name colour that should shimmer. Titles are plain text (`name`). How an item is DRAWN is the client's
 * business; ids are the stable key. Look items up with `COSMETIC_BY_ID`, list a slot with `cosmeticsIn(slot)`.
 *
 * ## Levels
 * Level 1 at 0 XP. XP to go from level L to L+1 is `xpToLevel(L)` = 400 + 60*L. `MAX_LEVEL` is 100; beyond it XP keeps
 * counting and every further `PRESTIGE_XP` (10,000) is a prestige star. `levelState(xp)` gives level, prestige, xpInLevel and
 * xpToNext (to the next level, or to the next star at max level).
 *
 * ## XP sources (`XP`)
 * Per life, at its end (death, leaving, or the round resetting): 1 XP per 5 score earned that life and 25 per kill, the life's
 * total capped at `XP.lifeCap`. Per round end: +40 for finishing, +100 for winning (FFA first place, the winning team, the last
 * squad). Zombies: +60 per night survived, +300 for holding the Bastion through the Tide (instead of the +100), +40 finish. The
 * first round won each UTC day doubles that round-end award (the extra shows as its own `firstWin` entry). Challenges pay their
 * `xp` when completed. A player must be seated for `XP.minRoundPlayMs` of a round to earn its end-of-round XP.
 *
 * ## Wire
 * ClientMsg `join` takes optional `cosmetics: Partial<Record<Slot, string>>` (ids validated against the catalog by
 * parseClientMsg; the server applies only items the profile has unlocked and stores them as its equipped set). ClientMsg
 * `{ t: 'equip', slot, id }` changes one slot while connected; the server answers `{ t: 'equipped', equipped }` (the resolved
 * full set), plus `{ t: 'error' }` when the item is locked. ServerMsg `{ t: 'progress', ... }` (`ProgressMsg`) goes to the
 * owning player only: once right after `welcome` (`gained` is normally empty), and whenever XP, a level, an unlock or a challenge completion
 * lands. PlayerView.cos (`Cos`) carries what a player wears, omitting defaults: h helmet, c camo, g gunSkin, n nameColor,
 * t title, k killFx ids, plus l (account level, humans) and p (prestige stars, when above 0). It rides the snapshot wire as a
 * sticky top-level `cos` map keyed by player id that `fillSnapshot` folds back onto the players, so clients only ever read
 * `PlayerView.cos`.
 *
 * ## HTTP
 * GET /api/profile/:name adds level, xp, xpInLevel, xpToNext, prestige, unlocked, equipped (full, defaults filled) and
 * challenges (`ChallengesView`, with `text` and reset times). POST /api/equip {slot,id} or {equipped:{...}} with the account
 * token (Authorization: Bearer <token>, or `token` in the body) equips for a signed-in account: 200 {equipped, unlocked}, 400
 * bad body or id, 401 bad token, 403 locked item (nothing applied). Guests keep their choices in localStorage and send them
 * with `join`; the server validates them against the guest name's profile.
 */
import type { CareerId } from './defs.ts';
import type { ChallengesView } from './challenges.ts';

export const SLOTS = ['helmet', 'camo', 'gunSkin', 'nameColor', 'title', 'killFx'] as const;
export type Slot = (typeof SLOTS)[number];
export type Rarity = 'common' | 'rare' | 'epic' | 'legendary';
export const RARITIES: readonly Rarity[] = ['common', 'rare', 'epic', 'legendary'];
export type Tier = 0 | 1 | 2 | 3;
export type Unlock = { default: true } | { level: number } | { career: CareerId; tier: Tier } | { challenge: true };

export type Cosmetic = { id: string; slot: Slot; name: string; desc: string; rarity: Rarity; unlock: Unlock; swatch: readonly string[]; animated?: true };

/** `Cos` keys by slot, for the compact wire form. */
export const SLOT_KEY = { helmet: 'h', camo: 'c', gunSkin: 'g', nameColor: 'n', title: 't', killFx: 'k' } as const satisfies Record<Slot, string>;
/** What a player wears: only non-default ids, plus account level (`l`) and prestige stars (`p`). */
export type Cos = { h?: string; c?: string; g?: string; n?: string; t?: string; k?: string; l?: number; p?: number };
export type Equipped = Record<Slot, string>;
export type Picks = Partial<Record<Slot, string>>;

const SLOT_LETTER: Record<Slot, string> = SLOT_KEY;

type Row = [id: string, name: string, desc: string, rarity: Rarity, unlock: Unlock, swatch: readonly string[], animated?: true];
const make = (slot: Slot, rows: Row[]): Cosmetic[] =>
  rows.map(([name, title, desc, rarity, unlock, swatch, animated]) => ({ id: `${SLOT_LETTER[slot]}_${name}`, slot, name: title, desc, rarity, unlock, swatch, ...(animated && { animated }) }));

const lv = (level: number): Unlock => ({ level });
const car = (career: CareerId, tier: Tier): Unlock => ({ career, tier });
const DEFAULT: Unlock = { default: true };
const CHALLENGE: Unlock = { challenge: true };

// Swatches use the art bible's tokens (docs/art/STYLE.md) plus a few toy-box primaries.
const INK = '#1c1f26', BONE = '#e2dccb', GUNMETAL = '#4f5560', KHAKI = '#b4a07a', OLIVE = '#6c7356', RUST = '#a8552e', ORANGE = '#ff5a1f', GOLD = '#ffd34d', AMBER = '#ffb347', STEEL = '#26304a', MINT = '#8ff0c4';

export const COSMETICS: readonly Cosmetic[] = [
  ...make('helmet', [
    ['standard', 'Standard Issue', 'The classic steel pot.', 'common', DEFAULT, [GUNMETAL]],
    ['beret', 'Beret', 'Jaunty, and somehow regulation.', 'common', lv(4), [OLIVE]],
    ['bandana', 'Bandana', 'Tied tight for the long haul.', 'common', lv(9), [RUST]],
    ['ushanka', 'Ushanka', 'Earflaps down, morale up.', 'common', lv(15), [KHAKI, BONE]],
    ['tanker', 'Tanker Cap', 'Padded for tight hatches.', 'common', lv(21), ['#3d4450']],
    ['boonie', 'Boonie Hat', 'Wide brim, wide grin.', 'rare', lv(28), [OLIVE, KHAKI]],
    ['cone', 'Traffic Cone', 'Caution: soldier.', 'rare', lv(34), [ORANGE, BONE]],
    ['chef', 'Chef Hat', "Tonight's special: you.", 'rare', lv(40), [BONE]],
    ['pilot', 'Pilot Goggles Cap', 'Flies like a brick, aims like an ace.', 'rare', lv(46), [RUST, GOLD]],
    ['propeller', 'Propeller Beanie', 'Spins when nobody is looking.', 'epic', lv(52), ['#e8433a', '#3a7be8', GOLD]],
    ['viking', 'Viking Horns', 'Plastic horns, real glory.', 'epic', lv(62), [BONE, KHAKI]],
    ['crown', 'Crown', 'Heavy is the head. Gold is the plastic.', 'legendary', lv(90), [GOLD, '#e8433a']],
    ['centurion', 'Centurion Crest', 'A plume for five hundred kills.', 'rare', car('kills', 1), [RUST, GOLD]],
    ['phantom', 'Phantom Hood', 'You never saw it coming. Five times over.', 'epic', car('ghost', 1), [STEEL, INK]],
    ['hardhat', 'Hard Hat', 'Five thousand buildings put up in Zombies. Mind your head.', 'epic', car('zBuilt', 3), [GOLD, INK]],
    ['party', 'Party Hat', 'Weekly challenge reward. Everyone is invited.', 'rare', CHALLENGE, ['#e8433a', '#3a7be8', GOLD]],
  ]),
  ...make('camo', [
    ['plain', 'Plain', 'Clean paint, no fuss.', 'common', DEFAULT, [OLIVE]],
    ['woodland', 'Woodland', 'Blobs of green, browns and hope.', 'common', lv(2), [OLIVE, '#4a5238', RUST]],
    ['desert', 'Desert', 'Sandy and a little dry.', 'common', lv(7), [KHAKI, '#978562']],
    ['urban', 'Urban', 'Concrete grey for concrete jungles.', 'common', lv(13), [GUNMETAL, '#3d4450', '#6b7280']],
    ['tiger', 'Tiger Stripe', 'Stripes, because why not.', 'common', lv(19), [OLIVE, INK, RUST]],
    ['digital', 'Digital', 'Chunky pixels in a toy soldier world.', 'rare', lv(25), [GUNMETAL, OLIVE, KHAKI]],
    ['arctic', 'Arctic', 'Snow, steel and a cold stare.', 'rare', lv(31), [BONE, '#9fb3c8']],
    ['hazard', 'Hazard Stripes', 'Yellow and ink. Keep clear.', 'rare', lv(37), [GOLD, INK]],
    ['polka', 'Polka Dot', 'Surprisingly hard to spot. Surprisingly easy to love.', 'rare', lv(43), ['#e8433a', BONE]],
    ['toybox', 'Toy-Box Primary', 'Fresh out of the box.', 'rare', lv(49), ['#e8433a', '#3a7be8', GOLD]],
    ['ember', 'Ember Weave', 'Still warm from the foundry.', 'epic', lv(66), ['#d9541f', '#ff9a3c', INK]],
    ['goldleaf', 'Gold Leaf', 'Hand-laid and slightly ridiculous.', 'legendary', lv(82), [GOLD, '#ffe08a', '#b8860b']],
    ['galaxy', 'Galaxy', 'A whole night sky on your chest.', 'legendary', lv(100), [STEEL, '#7a5ae8', '#e85ac8']],
    ['oldguard', 'Old Guard', 'Worn smooth by a hundred and fifty matches.', 'epic', car('games', 2), [KHAKI, RUST, INK]],
    ['confetti', 'Confetti', 'Weekly challenge reward. Cleanup not included.', 'rare', CHALLENGE, ['#e8433a', '#3a7be8', GOLD, MINT]],
  ]),
  ...make('gunSkin', [
    ['factory', 'Factory', 'Straight off the line.', 'common', DEFAULT, [GUNMETAL]],
    ['walnut', 'Walnut', 'Warm wood furniture.', 'common', lv(5), ['#7a4a2a', GUNMETAL]],
    ['carbon', 'Carbon', 'Black weave, tidy lines.', 'common', lv(12), [INK, '#3d4450']],
    ['hazard', 'Hazard', 'Yellow-black stripes along the barrel.', 'common', lv(18), [GOLD, INK]],
    ['tiger', 'Tiger', 'Orange and ink stripes.', 'rare', lv(24), [ORANGE, INK]],
    ['chrome', 'Chrome', 'Mirror shine. Zero subtlety.', 'rare', lv(30), ['#d8dee6', '#9aa4b2']],
    ['candy', 'Candy', 'Glossy sweets colours.', 'rare', lv(36), ['#ff7ab8', '#7ad8ff']],
    ['plastic', 'Toy Plastic', 'Moulded in one piece, with a seam.', 'rare', lv(42), ['#e8433a', '#3a7be8']],
    ['molten', 'Molten', 'Cracks of glowing lava.', 'epic', lv(58), ['#d9541f', '#ffb347', INK]],
    ['gold', 'Gold', 'Solid gold. Surely a safety hazard.', 'legendary', lv(85), [GOLD, '#b8860b']],
    ['bluesteel', 'Marksman Blue', 'Blued steel for a hundred and fifty Long Shots.', 'epic', car('longShot', 2), ['#2a4a7a', '#7a9ac8']],
    ['tape', 'Duct Tape', 'Weekly challenge reward. Holds everything together.', 'rare', CHALLENGE, ['#9aa4b2', '#6b7280']],
  ]),
  ...make('nameColor', [
    ['bone', 'Bone', 'Plain and proud.', 'common', DEFAULT, [BONE]],
    ['orange', 'Signal Orange', 'Hard to miss.', 'common', lv(6), [ORANGE]],
    ['mint', 'Mint', 'Cool and fresh.', 'common', lv(11), [MINT]],
    ['sky', 'Sky', 'Clear blue morning.', 'common', lv(17), ['#7cc4ff']],
    ['lilac', 'Lilac', 'Softly purple.', 'common', lv(23), ['#c3a6ff']],
    ['rose', 'Rose', 'A little bit of romance.', 'common', lv(29), ['#ff8fa3']],
    ['gold', 'Gold', 'Reward only.', 'rare', lv(35), [GOLD]],
    ['ember', 'Ember', 'Fading from flame to coal.', 'epic', lv(55), ['#ffd27a', '#ff9a3c', '#d9541f']],
    ['aurora', 'Aurora', 'Shimmers across the sky.', 'legendary', lv(95), [MINT, '#7cc4ff', '#c3a6ff'], true],
    ['bounty', 'Bounty Gold', 'Fifteen bounties claimed. Worth its weight.', 'epic', car('bounty', 1), [GOLD, RUST]],
    ['firstlight', 'First Light', 'Thirty Zombies runs held through the Tide. Dawn, every time.', 'legendary', car('zWins', 3), [AMBER, '#ff8fa3', '#7cc4ff'], true],
    ['neon', 'Neon Lime', 'Weekly challenge reward. Glows in the dark.', 'rare', CHALLENGE, ['#c8ff3d']],
  ]),
  ...make('title', [
    ['rookie', 'Rookie', 'Everyone starts somewhere.', 'common', DEFAULT, []],
    ['toysoldier', 'Toy Soldier', 'Level 3. Painted and ready.', 'common', lv(3), []],
    ['crate', 'Crate Whisperer', 'Level 8. The crates talk back.', 'common', lv(8), []],
    ['barrel', 'Barrel Enthusiast', 'Level 14. Big fan of big bangs.', 'common', lv(14), []],
    ['respawner', 'Professional Respawner', 'Level 16. Practice makes permanent.', 'common', lv(16), []],
    ['dentist', 'Zombie Dentist', 'Level 22. Open wide.', 'common', lv(22), []],
    ['hunted', 'The Hunted', 'Level 26. Everyone wants you.', 'rare', lv(26), []],
    ['sandbag', 'Sandbag Architect', 'Level 27. Builds walls, breaks hearts.', 'common', lv(27), []],
    ['brass', 'Brass Collector', 'Level 33. Casings everywhere.', 'common', lv(33), []],
    ['nightshift', 'Night Shifter', 'Level 38. The dark is your office.', 'rare', lv(38), []],
    ['fantastic', 'Plastic Fantastic', 'Level 39. Mould-made and proud.', 'common', lv(39), []],
    ['tin', 'Tin Tactician', 'Level 41. Plans, then more plans.', 'rare', lv(41), []],
    ['ankle', 'Ankle Biter', 'Level 44. Small but annoying.', 'common', lv(44), []],
    ['diorama', 'Diorama Dweller', 'Level 47. Part of the scenery.', 'rare', lv(47), []],
    ['flipper', 'Table Flipper', 'Level 48. Game over, man.', 'rare', lv(48), []],
    ['fieldmarshal', 'Field Marshal Jr.', 'Level 50. Halfway to the top.', 'rare', lv(50), []],
    ['commander', 'Pocket Commander', 'Level 60. Small army, big plans.', 'epic', lv(60), []],
    ['sovereign', 'Sandbox Sovereign', 'Level 70. Rules the yard.', 'epic', lv(70), []],
    ['marshal', 'Grand Marshal', 'Level 80. Salutes all round.', 'epic', lv(80), []],
    ['legend', 'Living Legend', 'Level 100. They write songs.', 'legendary', lv(100), []],
    ['centurion', 'Centurion', 'A hundred career kills.', 'rare', car('kills', 0), []],
    ['centurionprime', 'Centurion Prime', 'Five thousand career kills.', 'legendary', car('kills', 3), []],
    ['phantom', 'Phantom', 'Five Ghost medals.', 'rare', car('ghost', 0), []],
    ['marathoner', 'Marathoner', 'Ten kilometres on foot.', 'rare', car('distance', 0), []],
    ['ironwill', 'Iron Will', 'Ten kills in one life.', 'rare', car('streak', 1), []],
    ['marksman', 'Marksman', 'Fifty Long Shots.', 'rare', car('longShot', 1), []],
    ['butcher', 'Butcher', 'Your first Massacre.', 'rare', car('massacre', 0), []],
    ['giantslayer', 'Giant Slayer', 'Fifteen Shutdowns.', 'epic', car('shutdown', 1), []],
    ['headhunter', 'Headhunter', 'Fifteen bounties claimed.', 'epic', car('bounty', 1), []],
    ['sharpshooter', 'Sharpshooter', 'Two hundred and fifty sniper kills.', 'rare', car('sniperKills', 1), []],
    ['spraymaster', 'Spray Master', 'Two hundred and fifty SMG kills.', 'rare', car('smgKills', 1), []],
    ['brawler', 'Brawler', 'A hundred and fifty Point Blank kills.', 'epic', car('pointBlank', 2), []],
    ['seasoned', 'Seasoned', 'Fifty matches played.', 'rare', car('games', 1), []],
    ['nightowl', 'Night Owl', 'Four hundred zombie nights survived.', 'epic', car('zNights', 3), []],
    ['titan', 'Titan Toppler', 'Sixty Colossi felled.', 'legendary', car('zColossus', 3), []],
    ['grinder', 'Daily Grinder', 'Weekly challenge reward. Never misses a day.', 'rare', CHALLENGE, []],
    ['overachiever', 'Overachiever', 'Weekly challenge reward. Asked for more.', 'epic', CHALLENGE, []],
    ['regular', 'Regular', 'Weekly challenge reward. Usual table, usual order.', 'rare', CHALLENGE, []],
  ]),
  ...make('killFx', [
    ['poof', 'Poof', 'The standard puff of smoke.', 'common', DEFAULT, [BONE, GUNMETAL]],
    ['confetti', 'Confetti', 'A tiny celebration.', 'common', lv(10), ['#e8433a', '#3a7be8', GOLD, MINT]],
    ['ink', 'Ink Splat', 'A bold splash of ink.', 'common', lv(20), [INK]],
    ['sparkle', 'Sparkle Star', 'Twinkle, twinkle, gone.', 'rare', lv(32), [GOLD, '#ffe08a']],
    ['firework', 'Firework', 'Up she goes.', 'rare', lv(45), [ORANGE, GOLD, '#e8433a']],
    ['chicken', 'Rubber Chicken', 'Squeak-pop.', 'epic', lv(56), [GOLD, ORANGE]],
    ['coins', 'Coin Burst', 'Cash out in style.', 'legendary', lv(78), [GOLD, '#b8860b']],
    ['mushroom', 'Mushroom Cloud', 'A modest one, for a Massacre.', 'epic', car('massacre', 1), [AMBER, RUST]],
    ['bubbles', 'Bubble Pop', 'Weekly challenge reward. Pop pop pop.', 'rare', CHALLENGE, ['#7cc4ff', '#c3a6ff']],
  ]),
];

export const COSMETIC_BY_ID: ReadonlyMap<string, Cosmetic> = new Map(COSMETICS.map((c) => [c.id, c]));
export const cosmeticsIn = (slot: Slot): Cosmetic[] => COSMETICS.filter((c) => c.slot === slot);
export const DEFAULTS: Equipped = Object.fromEntries(SLOTS.map((s) => [s, COSMETICS.find((c) => c.slot === s && 'default' in c.unlock)!.id])) as Equipped;
export const isDefaultId = (id: string): boolean => (SLOTS as readonly string[]).some((s) => DEFAULTS[s as Slot] === id);
/** Cosmetics only a weekly challenge grants, in catalog order. */
export const CHALLENGE_COSMETICS: readonly string[] = COSMETICS.filter((c) => 'challenge' in c.unlock).map((c) => c.id);
/** True when `id` names a catalog item of `slot`. */
export const isCosmeticId = (slot: Slot, id: unknown): id is string => typeof id === 'string' && COSMETIC_BY_ID.get(id)?.slot === slot;
export const isSlot = (v: unknown): v is Slot => typeof v === 'string' && (SLOTS as readonly string[]).includes(v);

/** What a profile holds that unlocks things: its account level and which lifetime medal rungs it has (`badgeKey` form, `track:tier`). */
export type UnlockState = { level: number; badges: Readonly<Record<string, number>> };
export function unlockMet(u: Unlock, s: UnlockState): boolean {
  if ('default' in u) return true;
  if ('level' in u) return s.level >= u.level;
  if ('career' in u) return s.badges[`${u.career}:${u.tier}`] !== undefined;
  return false;
}
/** Every catalog id a profile in state `s` earns by level or lifetime medal (defaults included); challenge items are never here. */
export const earnedIds = (s: UnlockState): string[] => COSMETICS.filter((c) => unlockMet(c.unlock, s)).map((c) => c.id);

/** Validates a wire object of picks: keeps only entries whose slot is real and whose id is a catalog item of that slot. */
export function parsePicks(v: unknown): Picks {
  const out: Picks = {};
  if (typeof v !== 'object' || v === null) return out;
  for (const slot of SLOTS) {
    const id = (v as Record<string, unknown>)[slot];
    if (isCosmeticId(slot, id)) out[slot] = id;
  }
  return out;
}

/** The full equipped set, with defaults filling every slot a profile leaves bare or holds an unknown id for. */
export function resolveEquipped(picks: Picks | undefined): Equipped {
  const out = { ...DEFAULTS };
  for (const slot of SLOTS) { const id = picks?.[slot]; if (isCosmeticId(slot, id)) out[slot] = id; }
  return out;
}

/** The compact form for the wire: non-default ids only, with account level and stars. Null when there is nothing to say. */
export function toCos(equipped: Picks | undefined, level?: number, prestige?: number): Cos | null {
  const cos: Cos = {};
  for (const slot of SLOTS) { const id = equipped?.[slot]; if (isCosmeticId(slot, id) && id !== DEFAULTS[slot]) cos[SLOT_KEY[slot]] = id; }
  if (level !== undefined && level > 0) cos.l = level;
  if (prestige) cos.p = prestige;
  return Object.keys(cos).length ? cos : null;
}

// ---- Levels -------------------------------------------------------------------------------------------------------

export const MAX_LEVEL = 100;
/** XP past level `MAX_LEVEL` for each prestige star. */
export const PRESTIGE_XP = 10_000;
/** XP to go from level `level` to the next. */
export const xpToLevel = (level: number): number => 400 + 60 * level;
/** Total XP at which `level` is reached (level 1 is 0). */
export const xpForLevel = (level: number): number => { const n = Math.max(1, level) - 1; return 400 * n + 30 * n * (n + 1); };

export type LevelState = { level: number; prestige: number; xpInLevel: number; xpToNext: number };
export function levelState(xp: number): LevelState {
  xp = Math.max(0, Math.floor(xp));
  let level = 1;
  // The curve is quadratic; walking at most 99 steps is cheap and exact.
  while (level < MAX_LEVEL && xp >= xpForLevel(level + 1)) level++;
  if (level < MAX_LEVEL) return { level, prestige: 0, xpInLevel: xp - xpForLevel(level), xpToNext: xpForLevel(level + 1) - xp };
  const over = xp - xpForLevel(MAX_LEVEL);
  return { level, prestige: Math.floor(over / PRESTIGE_XP), xpInLevel: over % PRESTIGE_XP, xpToNext: PRESTIGE_XP - (over % PRESTIGE_XP) };
}

// ---- XP -----------------------------------------------------------------------------------------------------------

export const XP = {
  scoreDiv: 5, perKill: 25, lifeCap: 750,
  finish: 40, win: 100, night: 60, bastion: 300,
  /** Seated this long (world ms) in a round before its end pays out. */
  minRoundPlayMs: 60_000,
} as const;

/** Why XP was paid, for the end-of-life and end-of-round summary. */
export type XpReason = 'score' | 'kills' | 'finish' | 'win' | 'night' | 'bastion' | 'firstWin' | 'challenge';
export const XP_REASON_LABEL: Record<XpReason, string> = {
  score: 'Score', kills: 'Kills', finish: 'Round finished', win: 'Round won', night: 'Night survived', bastion: 'Bastion held', firstWin: 'First win of the day', challenge: 'Challenge complete',
};
/** `id` names the challenge for a `challenge` entry. */
export type XpGain = { reason: XpReason; xp: number; id?: string };

/** The XP a finished life pays: kills first, score filling what the cap leaves. */
export function lifeGains(score: number, kills: number): XpGain[] {
  const k = Math.min(XP.lifeCap, Math.max(0, Math.floor(kills)) * XP.perKill);
  const s = Math.min(XP.lifeCap - k, Math.floor(Math.max(0, score) / XP.scoreDiv));
  return [...(k > 0 ? [{ reason: 'kills' as const, xp: k }] : []), ...(s > 0 ? [{ reason: 'score' as const, xp: s }] : [])];
}

export type RoundResult = { won: boolean; finished: boolean; nights?: number; bastion?: boolean };
/** The XP a round end pays, before the first-win-of-the-day doubling. */
export function roundGains(r: RoundResult): XpGain[] {
  const out: XpGain[] = [];
  if (r.finished) out.push({ reason: 'finish', xp: XP.finish });
  if (r.won && !r.bastion) out.push({ reason: 'win', xp: XP.win });
  if (r.nights) out.push({ reason: 'night', xp: XP.night * r.nights });
  if (r.bastion) out.push({ reason: 'bastion', xp: XP.bastion });
  return out;
}

/** The UTC day, `YYYY-MM-DD`. */
export const dayKey = (now: number): string => new Date(now).toISOString().slice(0, 10);

// ---- Messages -----------------------------------------------------------------------------------------------------

/** Sent only to the player it is about. `gained` is empty on the first one after `welcome`. */
export type ProgressMsg = {
  t: 'progress';
  xp: number; level: number; prestige: number; xpInLevel: number; xpToNext: number;
  gained: XpGain[];
  /** Each level newly reached, in order (never above `MAX_LEVEL`; stars show in `prestige`). */
  levelUps: number[];
  /** Ids of cosmetics newly unlocked. */
  unlocks: string[];
  challenges: ChallengesView;
  equipped: Equipped;
};

// ---- Bots ---------------------------------------------------------------------------------------------------------

/** FNV-1a, for seeding without the simulation's random stream. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
/** A small seeded stream in [0, 1). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** What a bot named `name` wears: a deterministic mix from level-gated common and rare items, and now and then a title. */
export function botCosmetics(name: string): Cos | null {
  const rand = seeded(hash32(`bot:${name}`));
  const picks: Picks = {};
  for (const slot of SLOTS) {
    const pool = cosmeticsIn(slot).filter((c) => 'level' in c.unlock && (c.rarity === 'common' || c.rarity === 'rare') && c.id !== DEFAULTS[slot]);
    const chance = slot === 'title' ? 0.2 : 0.6;
    const roll = rand(), at = rand();
    if (roll < chance && pool.length) picks[slot] = pool[Math.floor(at * pool.length)]!.id;
  }
  return toCos(picks);
}
