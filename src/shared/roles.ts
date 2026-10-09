import type { GunId, WeaponId } from './defs.ts';

/**
 * What each gun is for. A class has one job in the fight, and the two evolutions at every step are sidegrades that change HOW you play it,
 * not how hard it hits: `role` is the one line the evolve pick shows, `traits` the two or three things that change (each has an icon on
 * the pick tile). test/gun-roles.test.ts holds that no two sibling guns share a trait set, and that every trait is backed by the numbers.
 */
export const TRAIT_IDS = [
  'quickdraw', 'strafe', 'plant', 'burst', 'auto', 'heavy', 'shove', 'pierce', 'blast', 'quiet', 'close', 'reach', 'scope', 'spray',
  'deep', 'rev', 'pin', 'breach', 'fast', 'slow', 'deploy',
] as const;
export type TraitId = (typeof TRAIT_IDS)[number];

export const TRAITS: Record<TraitId, { label: string; hint: string }> = {
  quickdraw: { label: 'Quick draw', hint: 'Quick off a sprint: the post-sprint bloom settles fast' },
  strafe: { label: 'Strafes', hint: 'Stays accurate while you move' },
  plant: { label: 'Plant to aim', hint: 'Accurate only when you stop' },
  burst: { label: 'Bursts', hint: 'One press, a short burst' },
  auto: { label: 'Full auto', hint: 'Hold to keep firing' },
  heavy: { label: 'Heavy hits', hint: 'Few, big rounds' },
  shove: { label: 'Knockback', hint: 'Hits shove them off their line' },
  pierce: { label: 'Pierces', hint: 'Rounds pass through bodies' },
  blast: { label: 'Explodes', hint: 'Rounds burst on impact' },
  quiet: { label: 'Silent', hint: 'Heard only up close' },
  close: { label: 'Close range', hint: 'Damage fades with distance' },
  reach: { label: 'Long reach', hint: 'Full damage far away' },
  scope: { label: 'Wide view', hint: 'See farther' },
  spray: { label: 'Wide spray', hint: 'A big cone of rounds' },
  deep: { label: 'Deep mag', hint: 'Many rounds before a reload' },
  rev: { label: 'Rev-up', hint: 'Fire rate climbs the longer you hold' },
  pin: { label: 'Pins foes', hint: 'Near misses spoil their aim' },
  breach: { label: 'Door breaker', hint: 'Blows swing doors open' },
  fast: { label: 'Fast feet', hint: 'Quicker than most to cross ground' },
  slow: { label: 'Slow feet', hint: 'Heavy: slow to move and to settle off a sprint' },
  deploy: { label: 'Plants down', hint: 'Stand still and it locks in' },
};

export const CLASS_ROLES: Record<WeaponId, string> = {
  pistol: 'Sidearm duelist: precise, and quick off a sprint',
  smg: 'Rusher: deadly up close, outruns everything, quick off a sprint',
  shotgun: 'Door-breaker: devastating inside 200 px',
  assault: 'Anchor: stand, tap, hold the middle',
  sniper: 'Long-range pick: plant, fire, work the bolt, let the cone settle',
  lmg: 'Suppressor: rev up, set down, pin a lane',
};

type Role = { role: string; traits: readonly TraitId[] };
export const GUN_ROLES: Record<GunId, Role> = {
  pistol: { role: 'Precise sidearm: quick off a sprint, steady on the run', traits: ['quickdraw', 'strafe'] },
  handCannon: { role: 'Slow and deliberate: two big hits that shove', traits: ['heavy', 'shove'] },
  machinePistol: { role: 'Run-and-gun: burst as you sprint in', traits: ['burst', 'strafe', 'quickdraw'] },
  executioner: { role: 'Plant and punch through two bodies', traits: ['pierce', 'reach', 'plant'] },
  gunslinger: { role: 'Duelist on the move: fast feet, quickest off a sprint', traits: ['strafe', 'quickdraw', 'fast'] },
  akimbo: { role: 'Six-round burst hose for tight quarters', traits: ['burst', 'spray', 'close'] },
  hailstorm: { role: 'Suppressor: a long stream that pins them', traits: ['auto', 'pin', 'deep'] },

  smg: { role: 'Rusher: no move penalty, fades fast past 350 px', traits: ['strafe', 'close', 'fast'] },
  skirmisher: { role: 'Flanker: fastest feet, fastest to fire', traits: ['fast', 'quickdraw', 'close'] },
  heavySmg: { role: 'Brawler: tighter, harder, stands and trades', traits: ['plant', 'close'] },
  phantom: { role: 'Silent assassin: unheard, in from behind', traits: ['quiet', 'fast', 'close'] },
  hornet: { role: 'Point-blank shredder: empties in a second', traits: ['auto', 'close', 'spray'] },
  ripper: { role: 'Lane breaker: rounds go through a body', traits: ['pierce', 'plant', 'slow'] },
  bulldog: { role: 'Drum gun: outlasts a whole squad', traits: ['deep', 'pin', 'slow'] },

  shotgun: { role: 'Door-breaker: devastating inside 200 px', traits: ['close', 'shove', 'breach'] },
  slugGun: { role: 'Slugger: holds a mid-range lane', traits: ['heavy', 'reach', 'plant'] },
  doubleBarrel: { role: 'Ambusher: two blasts, then reload', traits: ['close', 'burst', 'shove'] },
  railSlug: { role: 'Rail: one slug through two bodies', traits: ['pierce', 'reach', 'scope'] },
  boomSlug: { role: 'Cover buster: explodes on walls and doors', traits: ['blast', 'breach', 'heavy'] },
  sawedOff: { role: 'Alpha strike: sprint in, both barrels', traits: ['close', 'quickdraw', 'fast'] },
  streetSweeper: { role: 'Doorway hose: automatic drum, no one-shots', traits: ['auto', 'deep', 'slow'] },

  assault: { role: 'Anchor: tap threes for lasers, spray and it drifts', traits: ['plant', 'reach'] },
  battleRifle: { role: 'Burst anchor: a clean three-round burst', traits: ['burst', 'heavy', 'plant'] },
  carbine: { role: 'Double-tap on the move, accurate strafing', traits: ['burst', 'strafe', 'quickdraw'] },
  marksman: { role: 'Three-tap semi-auto from 500 to 900 px', traits: ['heavy', 'reach', 'scope'] },
  grenadier: { role: 'Explosive bursts: punish anyone round a corner', traits: ['blast', 'burst', 'slow'] },
  specter: { role: 'Silent double-tap: unheard past close range', traits: ['quiet', 'burst', 'strafe'] },
  scout: { role: 'Recon rifle: wide view, long double-taps', traits: ['scope', 'reach', 'burst'] },

  sniper: { role: 'Long-range pick: one shot drops the unarmored', traits: ['heavy', 'plant', 'scope'] },
  longshot: { role: 'Cannon: one shot drops light armor, rocks them back', traits: ['heavy', 'shove', 'slow'] },
  semiAuto: { role: 'Two-hit sniper with quick follow-ups', traits: ['plant', 'reach', 'pin'] },
  piercer: { role: 'Lane punisher: through three, one-shots medium armor', traits: ['pierce', 'scope', 'slow'] },
  artillery: { role: 'Shells with a wide blast: flush cover', traits: ['blast', 'breach', 'slow'] },
  repeater: { role: 'Jog-and-shoot marksman: fastest follow-ups', traits: ['strafe', 'reach', 'quickdraw'] },
  ghost: { role: 'Silent marksman: plants in a heartbeat', traits: ['quiet', 'plant', 'reach'] },

  lmg: { role: 'Suppressor: rev up and hose a lane', traits: ['rev', 'pin', 'deep'] },
  heavyLmg: { role: 'Bipod: stand half a second and every round lands', traits: ['deploy', 'pin', 'slow'] },
  lightMg: { role: 'Hip-fire MG: no rev-up, shoots on the walk', traits: ['auto', 'deep'] },
  minigun: { role: 'Torrent: long rev-up, huge damage, no sprint', traits: ['rev', 'auto', 'slow'] },
  juggernaut: { role: 'Fortress: no rev-up, plant, biggest rounds', traits: ['deploy', 'heavy', 'pin'] },
  ranger: { role: 'Squad MG: keeps pace, accurate on the move', traits: ['strafe', 'auto', 'deep'] },
  twinMg: { role: 'Paired barrels: double rounds, double pinning', traits: ['spray', 'pin', 'deep'] },
};

