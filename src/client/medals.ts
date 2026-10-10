import { CAREER, CAREER_TIERS, MEDALS, type Badge, type CareerId, type MedalId, type MedalTier } from '../shared/defs.ts';

/**
 * Medal art as SVG, so a medal is as crisp in a toast as on a profile page. A medal's metal and outline come from its tier:
 * bronze is a notched coin, silver an eight-point star, gold a shield in a laurel, platinum a winged star burst. Its enamel
 * face is coloured by family and carries the medal's own glyph, and ribbon tails hang behind it.
 */
/** `stars` marks a lifetime medal's rung on its track, one to four. */
export type MedalArt = { tier: MedalTier; enamel: string; ribbon: string; glyph: string; stars?: number };

const FAMILY = {
  chain: { enamel: '#a3302a', ribbon: '#d9541f' },
  range: { enamel: '#2b5d93', ribbon: '#4f8fd6' },
  survive: { enamel: '#2f7a4c', ribbon: '#58b07c' },
  grudge: { enamel: '#7a1f3a', ribbon: '#c23b5e' },
  hunt: { enamel: '#8a5a12', ribbon: '#e0a42a' },
  streak: { enamel: '#b8410f', ribbon: '#ff7a2f' },
  /** The weapon feats: gunmetal enamel on the interface's signal orange. */
  arms: { enamel: '#3d4450', ribbon: '#ff5a1f' },
  /** Zombies: olive-drab enamel on a sickly lime ribbon, the horde's own colours. */
  horde: { enamel: '#4b5a22', ribbon: '#a6c63a' },
} as const;

/** A cog of `n` teeth round 12,12 with a hole in it, as a glyph path (evenodd leaves the hole open). */
function cogGlyph(n: number, outer: number, inner: number, hole: number): string {
  const pts: string[] = [];
  for (let i = 0; i < n * 4; i++) {
    const a = -Math.PI / 2 + ((i - 0.5) * Math.PI * 2) / (n * 4) + Math.PI / (n * 4);
    const r = i % 4 < 2 ? outer : inner;
    pts.push(`${(12 + Math.cos(a) * r).toFixed(2)} ${(12 + Math.sin(a) * r).toFixed(2)}`);
  }
  return `M${pts.join('L')}zM${12 + hole} 12a${hole} ${hole} 0 1 0-${hole * 2} 0a${hole} ${hole} 0 1 0 ${hole * 2} 0z`;
}

/** A round in flight pointing right, its tail at `x`, `y` its top, with a streak behind it. */
const roundGlyph = (x: number, y: number) => `M${x} ${y}h7c3 0 5.5 1.1 5.5 2.5s-2.5 2.5-5.5 2.5H${x}zM${x - 4} ${y + 1.6}h3v1.8h-3z`;

/** 24-unit glyphs, drawn in bone with an ink edge. */
export const GLYPHS = {
  drop: 'M12 2.5c3.2 5 6.3 8.2 6.3 12.2a6.3 6.3 0 0 1-12.6 0c0-4 3.1-7.2 6.3-12.2z',
  chevrons2: 'M5 8l7 5 7-5v3.5l-7 5-7-5zM5 3l7 5 7-5v3.5l-7 5-7-5z',
  chevrons3: 'M5 13l7 4.5 7-4.5v3l-7 4.5-7-4.5zM5 8l7 4.5 7-4.5v3l-7 4.5-7-4.5zM5 3l7 4.5 7-4.5v3l-7 4.5-7-4.5z',
  chevrons4: 'M5 16l7 4 7-4v2.6l-7 4-7-4zM5 11.5l7 4 7-4v2.6l-7 4-7-4zM5 7l7 4 7-4v2.6l-7 4-7-4zM5 2.5l7 4 7-4v2.6l-7 4-7-4z',
  skull: 'M12 2.5c-5 0-8.5 3.5-8.5 8 0 2.8 1.4 4.6 3 5.6V19a1.5 1.5 0 0 0 1.5 1.5h8a1.5 1.5 0 0 0 1.5-1.5v-2.9c1.6-1 3-2.8 3-5.6 0-4.5-3.5-8-8.5-8zM8.5 9.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm7 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM12 13.5l1.4 2.5h-2.8z',
  scope: 'M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17zm0 2.2a6.3 6.3 0 1 0 0 12.6 6.3 6.3 0 0 0 0-12.6zM11 1h2v6h-2zM11 17h2v6h-2zM1 11h6v2H1zM17 11h6v2h-6zM12 10.4a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2z',
  blast: 'M12 1.5l2.2 6.3 6.3-2.6-3 6 6 2.6-6.4 2 2.7 6.2-6.1-3.1L12 22.5l-1.7-5.6-6.1 3.1 2.7-6.2-6.4-2 6-2.6-3-6 6.3 2.6z',
  heart: 'M12 21.2C5.2 15.9 2.5 12.6 2.5 8.7A5 5 0 0 1 12 6.3a5 5 0 0 1 9.5 2.4c0 3.9-2.7 7.2-9.5 12.5zM6 11.5h3l1.5-3 2.5 6 1.5-3H18v1.6h-2.5l-2.4 4.6-2.5-6-.8 1.6H6z',
  shieldCrack: 'M12 1.8l8.3 3.1v6.6c0 5.3-3.6 9.3-8.3 10.7-4.7-1.4-8.3-5.4-8.3-10.7V4.9zM12.6 5.5l-2.3 5.2 3 1.2-2.5 6.1 4.6-7.2-3-1.3 1.8-4z',
  revenge: 'M12 3a9 9 0 1 1-8.3 5.5l2 .9A6.8 6.8 0 1 0 12 5.2V8L7.5 4.1 12 .2zM9.4 9.8l1.4-1.4 1.2 1.2 1.2-1.2 1.4 1.4-1.2 1.2 1.2 1.2-1.4 1.4-1.2-1.2-1.2 1.2-1.4-1.4 1.2-1.2z',
  power: 'M10.8 2h2.4v9.5h-2.4zM6.3 5.4l1.6 1.8a7 7 0 1 0 8.2 0l1.6-1.8a9.4 9.4 0 1 1-11.4 0z',
  bounty: 'M12 2l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 15.5l-5.4 3 1.2-6-4.5-4.2 6.1-.7z',
  flame: 'M12 22.5c-4.4 0-7.5-3-7.5-7.2 0-3.6 2.4-5.6 3.9-8.8.9 1.9 1.9 3 3.1 3.3-.2-2.8.9-5.7 3.3-8.3.6 4.1 5.2 7 5.2 13 0 4.8-3.4 8-8 8zm0-2.4c1.9 0 3.2-1.3 3.2-3.2 0-2.2-1.6-3.4-2.4-5.3-.9 1.4-2.6 2.4-3.6 4.2-.6 2.2.8 4.3 2.8 4.3z',
  crown: 'M3 7.5l4.6 3.6L12 4l4.4 7.1L21 7.5l-1.8 10.5H4.8zM4.8 19.5h14.4V22H4.8z',
  bolt: 'M13.5 1.5L4.5 13.5h6l-1.5 9 9-12h-6z',
  pistol: 'M2.5 6h17v4.5h-7.2l-.9 2.2H9.6l-.4 2.4-1.7 6.4H3.8l2.1-8.8H2.5z',
  shells: 'M4.5 8h5.5v13H4.5zM4.5 6.8c0-2.6 1.2-4.8 2.75-4.8S10 4.2 10 6.8zM14 8h5.5v13H14zM14 6.8c0-2.6 1.2-4.8 2.75-4.8s2.75 2.2 2.75 4.8z',
  bullet: 'M9.5 9h5v13h-5zM9.5 7.8c0-3.2 1.1-5.8 2.5-5.8s2.5 2.6 2.5 5.8z',
  belt: 'M3 10h4v11H3zM3 9c0-2.6.9-5 2-5s2 2.4 2 5zM10 10h4v11h-4zM10 9c0-2.6.9-5 2-5s2 2.4 2 5zM17 10h4v11h-4zM17 9c0-2.6.9-5 2-5s2 2.4 2 5zM2 15h20v2H2z',
  eye: 'M12 5c5.2 0 9 4.4 10.5 7-1.5 2.6-5.3 7-10.5 7S3 14.6 1.5 12C3 9.4 6.8 5 12 5zm0 2.6a4.4 4.4 0 1 0 0 8.8 4.4 4.4 0 0 0 0-8.8zm0 2.6a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6z',
  dash: 'M2 10.5h11.5L9.8 6.8 11.4 5.2 18.2 12l-6.8 6.8-1.6-1.6 3.7-3.7H2zM19.5 5h2.5v14h-2.5z',
  pinned: 'M3 3h18v3H3zM12 7l6 6h-4v8h-4v-8H6z',
  rocket: 'M12 1.5c3.2 2.6 4.6 6 4.6 9.5v4.2l2.4 3.3v2.5l-4-1.7H9l-4 1.7v-2.5l2.4-3.3V11c0-3.5 1.4-6.9 4.6-9.5zM12 7a1.9 1.9 0 1 0 0 3.8A1.9 1.9 0 0 0 12 7zM10.2 19.5h3.6L12 23z',
  plug: 'M8 1.5h2.2v5h3.6v-5H16v5h1.5v4.2a5.5 5.5 0 0 1-4.4 5.4V19h-2.2v-2.9a5.5 5.5 0 0 1-4.4-5.4V6.5H8zM11 20.5h2V23h-2z',
  brush: 'M17.8 1.8l4.4 4.4-8.3 9.6-2.7-2.7zM9.7 14.5c1.8 0 3.2 1.4 3.2 3.2 0 2.5-2.6 4.6-6.4 4.6 1-1.2 1.2-2 1.2-3.2 0-2.5 0-4.6 2-4.6z',
  ghost: 'M12 2.5c-4.7 0-7.5 3.4-7.5 8v10.5l2.5-2 2.5 2 2.5-2 2.5 2 2.5-2 2.5 2V10.5c0-4.6-2.8-8-7.5-8zM9 8.5a1.7 1.7 0 1 1 0 3.4 1.7 1.7 0 0 1 0-3.4zm6 0a1.7 1.7 0 1 1 0 3.4 1.7 1.7 0 0 1 0-3.4z',
  // The Zombies tracks.
  moon: 'M13.5 2A10 10 0 1 0 22 16.5 8 8 0 0 1 13.5 2zM19 2.5l.8 1.7 1.8.2-1.3 1.3.3 1.8-1.6-.9-1.6.9.3-1.8-1.3-1.3 1.8-.2z',
  sunrise: 'M2 17h20v2H2zM5.5 15.5a6.5 6.5 0 0 1 13 0zM11 3h2v4.5h-2zM4.4 7.1l1.4-1.4 3 3-1.4 1.4zM19.6 7.1l-1.4-1.4-3 3 1.4 1.4zM1.5 12.5H5v2H1.5zM19 12.5h3.5v2H19zM6 20.5h12V22H6z',
  tower: 'M4 3h3.2v2.8h2.2V3h5.2v2.8h2.2V3H20v7.2l-2 1.6V21.5H6v-9.7l-2-1.6zM10 21.5v-5a2 2 0 0 1 4 0v5z',
  hand: 'M2 19.5h20V22H2zM8 11h8v8.5H8zM8.2 4.6h1.9V11H8.2zM10.6 3h1.9v8h-1.9zM13 3.4h1.9V11H13zM15.3 5.2h1.7V11h-1.7zM8 13.2L5 10.1l1.4-1.4L8 10.3z',
  bricks: 'M2 3.5h9V8H2zM12 3.5h10V8H12zM2 9.5h4.5V14H2zM7.5 9.5h9V14h-9zM17.5 9.5H22V14h-4.5zM2 15.5h9V20H2zM12 15.5h10V20H12z',
  cog: cogGlyph(8, 10.5, 7.6, 3.2),
  wrench: 'M15 2a5.5 5.5 0 0 0-5.2 7.3L2.8 16.3a2 2 0 0 0 0 2.8l2.1 2.1a2 2 0 0 0 2.8 0l7-7A5.5 5.5 0 0 0 21.8 8.4l-3.4 3.4-3.6-.9-.9-3.6 3.4-3.4A5.5 5.5 0 0 0 15 2z',
  volley: `${roundGlyph(5.5, 2)}${roundGlyph(8, 9.5)}${roundGlyph(5.5, 17)}`,
  medic: 'M9 2.5h6v6.5h6.5v6H15v6.5H9V15H2.5V9H9z',
  hammer: 'M1.5 8L10 1.8l4.5 6.4L6 14.4zM12.2 10.6l10.4 10-2 2-10.2-10.2zM16.5 2.5l1.6-1.2 1.2 1.6-1.6 1.2zM19.5 6.2l2.3-.5.3 1.6-2.3.5z',
  shieldCheck: 'M12 1.8l8.3 3.1v6.6c0 5.3-3.6 9.3-8.3 10.7-4.7-1.4-8.3-5.4-8.3-10.7V4.9zM7.4 11.6l1.7-1.7 2.2 2.2 4.6-4.6 1.7 1.7-6.3 6.3z',
} as const;

const ART: Record<MedalId, MedalArt> = {
  firstBlood: { tier: 'silver', ...FAMILY.grudge, glyph: GLYPHS.drop },
  doubleKill: { tier: 'bronze', ...FAMILY.chain, glyph: GLYPHS.chevrons2 },
  tripleKill: { tier: 'silver', ...FAMILY.chain, glyph: GLYPHS.chevrons3 },
  quadKill: { tier: 'gold', ...FAMILY.chain, glyph: GLYPHS.chevrons4 },
  massacre: { tier: 'platinum', ...FAMILY.chain, glyph: GLYPHS.skull },
  longShot: { tier: 'bronze', ...FAMILY.range, glyph: GLYPHS.scope },
  pointBlank: { tier: 'bronze', ...FAMILY.range, glyph: GLYPHS.blast },
  clutch: { tier: 'silver', ...FAMILY.survive, glyph: GLYPHS.heart },
  closeCall: { tier: 'bronze', ...FAMILY.survive, glyph: GLYPHS.shieldCrack },
  revenge: { tier: 'silver', ...FAMILY.grudge, glyph: GLYPHS.revenge },
  shutdown: { tier: 'gold', ...FAMILY.hunt, glyph: GLYPHS.power },
  bounty: { tier: 'gold', ...FAMILY.hunt, glyph: GLYPHS.bounty },
  onFire: { tier: 'bronze', ...FAMILY.streak, glyph: GLYPHS.flame },
  rampage: { tier: 'silver', ...FAMILY.streak, glyph: GLYPHS.flame },
  unstoppable: { tier: 'gold', ...FAMILY.streak, glyph: GLYPHS.bolt },
  untouchable: { tier: 'platinum', ...FAMILY.streak, glyph: GLYPHS.shieldCrack },
  legendary: { tier: 'platinum', ...FAMILY.streak, glyph: GLYPHS.crown },
  ghost: { tier: 'bronze', ...FAMILY.survive, glyph: GLYPHS.ghost },
  doubleTap: { tier: 'bronze', ...FAMILY.arms, glyph: GLYPHS.pistol },
  deadeye: { tier: 'silver', ...FAMILY.arms, glyph: GLYPHS.eye },
  runAndGun: { tier: 'bronze', ...FAMILY.arms, glyph: GLYPHS.dash },
  twoBirds: { tier: 'bronze', ...FAMILY.arms, glyph: GLYPHS.shells },
  longBarrel: { tier: 'silver', ...FAMILY.arms, glyph: GLYPHS.scope },
  disciplined: { tier: 'bronze', ...FAMILY.arms, glyph: GLYPHS.bullet },
  oneShot: { tier: 'silver', ...FAMILY.arms, glyph: GLYPHS.bullet },
  noScope: { tier: 'silver', ...FAMILY.arms, glyph: GLYPHS.blast },
  eagleEye: { tier: 'gold', ...FAMILY.arms, glyph: GLYPHS.eye },
  reaper: { tier: 'platinum', ...FAMILY.arms, glyph: GLYPHS.skull },
  pinnedDown: { tier: 'bronze', ...FAMILY.arms, glyph: GLYPHS.pinned },
  beltFed: { tier: 'gold', ...FAMILY.arms, glyph: GLYPHS.belt },
  kaboom: { tier: 'bronze', ...FAMILY.streak, glyph: GLYPHS.blast },
  chainReaction: { tier: 'gold', ...FAMILY.chain, glyph: GLYPHS.bolt },
  specialDelivery: { tier: 'silver', ...FAMILY.hunt, glyph: GLYPHS.pinned },
  liftoff: { tier: 'silver', ...FAMILY.arms, glyph: GLYPHS.rocket },
  shockTherapy: { tier: 'silver', ...FAMILY.range, glyph: GLYPHS.plug },
  arsonist: { tier: 'bronze', ...FAMILY.streak, glyph: GLYPHS.flame },
  picasso: { tier: 'bronze', ...FAMILY.survive, glyph: GLYPHS.brush },
};

export const medalArt = (id: MedalId): MedalArt => ART[id];

/** Each lifetime track wears the glyph of what it counts, in its family's colours. */
const CAREER_ART: Record<CareerId, Omit<MedalArt, 'tier'>> = {
  kills: { ...FAMILY.chain, glyph: GLYPHS.skull },
  games: { ...FAMILY.hunt, glyph: GLYPHS.bounty },
  streak: { ...FAMILY.streak, glyph: GLYPHS.flame },
  longShot: { ...FAMILY.range, glyph: GLYPHS.scope },
  pointBlank: { ...FAMILY.range, glyph: GLYPHS.blast },
  multiKill: { ...FAMILY.chain, glyph: GLYPHS.chevrons2 },
  tripleKill: { ...FAMILY.chain, glyph: GLYPHS.chevrons3 },
  massacre: { ...FAMILY.chain, glyph: GLYPHS.chevrons4 },
  clutch: { ...FAMILY.survive, glyph: GLYPHS.heart },
  closeCall: { ...FAMILY.survive, glyph: GLYPHS.shieldCrack },
  revenge: { ...FAMILY.grudge, glyph: GLYPHS.revenge },
  shutdown: { ...FAMILY.hunt, glyph: GLYPHS.power },
  bounty: { ...FAMILY.hunt, glyph: GLYPHS.crown },
  firstBlood: { ...FAMILY.grudge, glyph: GLYPHS.drop },
  distance: { ...FAMILY.survive, glyph: GLYPHS.bolt },
  ghost: { ...FAMILY.survive, glyph: GLYPHS.ghost },
  pistolKills: { ...FAMILY.arms, glyph: GLYPHS.pistol },
  smgKills: { ...FAMILY.arms, glyph: GLYPHS.dash },
  shotgunKills: { ...FAMILY.arms, glyph: GLYPHS.shells },
  assaultKills: { ...FAMILY.arms, glyph: GLYPHS.bullet },
  sniperKills: { ...FAMILY.arms, glyph: GLYPHS.scope },
  lmgKills: { ...FAMILY.arms, glyph: GLYPHS.belt },
  oneShot: { ...FAMILY.arms, glyph: GLYPHS.skull },
  twoBirds: { ...FAMILY.arms, glyph: GLYPHS.shells },
  zNights: { ...FAMILY.horde, glyph: GLYPHS.moon },
  zBestNight: { ...FAMILY.horde, glyph: GLYPHS.sunrise },
  zWins: { ...FAMILY.horde, glyph: GLYPHS.tower },
  zKills: { ...FAMILY.horde, glyph: GLYPHS.hand },
  zBuilt: { ...FAMILY.horde, glyph: GLYPHS.bricks },
  zMaxed: { ...FAMILY.horde, glyph: GLYPHS.cog },
  zRepaired: { ...FAMILY.horde, glyph: GLYPHS.wrench },
  zRounds: { ...FAMILY.horde, glyph: GLYPHS.volley },
  zRevives: { ...FAMILY.horde, glyph: GLYPHS.medic },
  zColossus: { ...FAMILY.horde, glyph: GLYPHS.hammer },
  zFlawless: { ...FAMILY.horde, glyph: GLYPHS.shieldCheck },
};

export const careerArt = (b: Badge): MedalArt => ({ ...CAREER_ART[b.track], tier: CAREER_TIERS[b.tier]!, stars: b.tier + 1 });
export const careerName = (b: Badge) => `${CAREER[b.track].name} ${['I', 'II', 'III', 'IV'][b.tier]}`;

const TIER_WORD: Record<MedalTier, string> = { bronze: 'Bronze', silver: 'Silver', gold: 'Gold', platinum: 'Platinum' };
/**
 * What a lifetime medal is for, as a hover tooltip: the track and what counts toward it (a match medal's own rule when the
 * track counts one), every rung's goal, and the rung this player holds with the day it was earned.
 */
export function careerTooltip(track: CareerId, held?: { tier: Badge['tier']; at: number }): string {
  const def = CAREER[track];
  const medal = def.needs in MEDALS ? MEDALS[def.needs as MedalId] : null;
  const why = medal?.desc ?? def.desc;
  const what = why ? `Earned for ${def.unit}: ${why.charAt(0).toLowerCase()}${why.slice(1)}.` : `Earned for ${def.unit}.`;
  const rungs = def.at.map((n, i) => `${TIER_WORD[CAREER_TIERS[i]!]} ${n.toLocaleString('en-US')}`).join(' · ');
  const got = held ? `\nHeld: ${careerName({ track, tier: held.tier })} (${TIER_WORD[CAREER_TIERS[held.tier]!]}), earned ${new Date(held.at).toLocaleDateString()}.` : '';
  return `${def.name}: ${what}\n${rungs}${got}`;
}
// Each medal's tier on screen is the one its rules give it.
for (const id of Object.keys(ART) as MedalId[]) ART[id] = { ...ART[id], tier: MEDALS[id].tier };

/** Light, mid and dark of each metal, for its rim's gradient and bevel. */
export const METAL: Record<MedalTier, readonly [string, string, string]> = {
  bronze: ['#f2c08a', '#c07a3e', '#6e3e16'],
  silver: ['#ffffff', '#c3c9d2', '#6c7380'],
  gold: ['#fff1a8', '#e3b23a', '#8a5f0c'],
  platinum: ['#f2fbff', '#a9d4ec', '#4d6f8a'],
};

const star = (n: number, outer: number, inner: number, rot = -Math.PI / 2) =>
  Array.from({ length: n * 2 }, (_, i) => {
    const r = i % 2 ? inner : outer, a = rot + (i * Math.PI) / n;
    return `${(50 + Math.cos(a) * r).toFixed(2)},${(50 + Math.sin(a) * r).toFixed(2)}`;
  }).join(' ');

/** The rim's outline, in a 100-unit box centred at 50,50. */
function rimShape(tier: MedalTier): string {
  switch (tier) {
    case 'bronze': return `<polygon points="${star(16, 40, 36.5)}"/>`;
    case 'silver': return `<polygon points="${star(8, 44, 33, -Math.PI / 2 + Math.PI / 8)}"/>`;
    case 'gold': return '<path d="M50 6 L86 18 V48 C86 70 70 86 50 94 C30 86 14 70 14 48 V18 Z"/>';
    case 'platinum': return `<polygon points="${star(12, 46, 34)}"/>`;
  }
}

/** Ribbon tails behind the medal, and wings or laurel for the higher tiers. */
function behind(tier: MedalTier, ribbon: string, metal: readonly [string, string, string], uid: string): string {
  const tails = `<g stroke="#14161a" stroke-width="2" stroke-linejoin="round">
    <path d="M30 60 L18 98 L28 92 L34 100 L44 66 Z" fill="${ribbon}"/>
    <path d="M70 60 L82 98 L72 92 L66 100 L56 66 Z" fill="${ribbon}"/>
    <path d="M30 60 L18 98 L23 95 L36 63 Z M70 60 L82 98 L77 95 L64 63 Z" fill="rgba(0,0,0,0.25)" stroke="none"/></g>`;
  if (tier === 'gold') {
    const leaf = (x: number, y: number, a: number) => `<ellipse cx="${x}" cy="${y}" rx="7" ry="3.2" transform="rotate(${a} ${x} ${y})"/>`;
    const side = (s: 1 | -1) => [0, 1, 2, 3, 4].map((i) => leaf(50 + s * (34 + i * 1.5), 30 + i * 12, s * (60 - i * 18))).join('');
    return `${tails}<g fill="url(#m${uid})" stroke="#14161a" stroke-width="1.5">${side(1)}${side(-1)}</g>`;
  }
  if (tier === 'platinum') {
    const wing = (s: 1 | -1) => `<path d="M${50 + s * 30} 40 C${50 + s * 52} 30 ${50 + s * 60} 20 ${50 + s * 62} 10 C${50 + s * 58} 30 ${50 + s * 56} 46 ${50 + s * 36} 58 Z" fill="url(#m${uid})" stroke="#14161a" stroke-width="2"/>
      <path d="M${50 + s * 36} 46 C${50 + s * 50} 40 ${50 + s * 54} 32 ${50 + s * 57} 22" fill="none" stroke="${metal[2]}" stroke-width="1.5"/>`;
    return `${tails}${wing(1)}${wing(-1)}`;
  }
  return tails;
}

/** Small stars along the medal's foot, one per rung of a lifetime track. */
function starRow(n: number, metal: readonly [string, string, string]): string {
  const pts = (cx: number, cy: number) => Array.from({ length: 10 }, (_, i) => {
    const r = i % 2 ? 2.6 : 6, a = -Math.PI / 2 + (i * Math.PI) / 5;
    return `${(cx + Math.cos(a) * r).toFixed(1)},${(cy + Math.sin(a) * r).toFixed(1)}`;
  }).join(' ');
  return Array.from({ length: n }, (_, i) => `<polygon points="${pts(50 + (i - (n - 1) / 2) * 13, 88)}" fill="${metal[0]}" stroke="#14161a" stroke-width="1.4"/>`).join('');
}

let uids = 0;

/** A medal as an SVG string, `size` px square. */
export function medalSvg(art: MedalArt, size: number, title?: string): string {
  const uid = `${(uids++).toString(36)}`;
  const metal = METAL[art.tier];
  const rim = rimShape(art.tier);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-14 -4 128 108" width="${size}" height="${size}" role="img"${title ? ` aria-label="${title}"` : ''}>
  <defs>
    <linearGradient id="m${uid}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${metal[0]}"/><stop offset="0.45" stop-color="${metal[1]}"/><stop offset="1" stop-color="${metal[2]}"/>
    </linearGradient>
    <radialGradient id="e${uid}" cx="0.4" cy="0.35" r="0.75">
      <stop offset="0" stop-color="${art.enamel}" stop-opacity="1"/><stop offset="1" stop-color="#0d0e11" stop-opacity="1"/>
    </radialGradient>
    <clipPath id="c${uid}">${rim}</clipPath>
  </defs>
  ${behind(art.tier, art.ribbon, metal, uid)}
  <g fill="url(#m${uid})" stroke="#14161a" stroke-width="2.5" stroke-linejoin="round">${rim}</g>
  <g clip-path="url(#c${uid})"><path d="M0 0 L100 0 L0 100 Z" fill="rgba(255,255,255,0.18)"/></g>
  <circle cx="50" cy="50" r="27" fill="url(#e${uid})" stroke="${metal[2]}" stroke-width="3"/>
  <circle cx="50" cy="50" r="27" fill="none" stroke="rgba(255,255,255,0.35)" stroke-width="1" stroke-dasharray="40 200" transform="rotate(-140 50 50)"/>
  ${art.stars ? starRow(art.stars, metal) : ''}
  <g transform="translate(30.8 30.8) scale(1.6)"><path d="${art.glyph}" fill="#ece6d6" stroke="#14161a" stroke-width="0.8" stroke-linejoin="round" fill-rule="evenodd"/></g>
</svg>`;
}

const images = new Map<string, HTMLImageElement>();

/** A lifetime medal as an image for the canvas, made once per medal; null until it has loaded. */
export function careerImage(b: Badge): HTMLImageElement | null {
  const key = `${b.track}:${b.tier}`;
  let img = images.get(key);
  if (!img) {
    if (typeof Image === 'undefined') return null;
    img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(medalSvg(careerArt(b), 64))}`;
    images.set(key, img);
  }
  return img.complete && img.naturalWidth ? img : null;
}
