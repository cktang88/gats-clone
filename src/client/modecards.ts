/**
 * The fights the menu offers, as words only: each mode's name and its one-line pitch, shown in the mode dropdown's info panel and
 * on the gear step's mission strip.
 */
export type SceneId = 'FFA' | 'TDM' | 'DOM' | 'BR' | 'ZOM' | 'RNG';

/** What each mode is called on its card and in one line. (No all-caps codes in the pitch: the chip carries the code.) */
export const MODE_INFO: Record<SceneId, { name: string; pitch: string; short: string }> = {
  FFA: { name: 'Free for all', pitch: 'Every soldier for themselves. Top score when the clock runs out wins the yard.', short: 'Free for all' },
  TDM: { name: 'Team deathmatch', pitch: 'Red against Blue. Every kill counts for your squad; hold the line together.', short: 'Team deathmatch' },
  DOM: { name: 'Domination', pitch: 'Capture the zones and keep them. Points tick up for whoever holds the ground.', short: 'Domination' },
  BR: { name: 'Last standing', pitch: 'Eighteen drop in, everyone for themselves. Loot caches for armor, take recon towers, outlast the ring.', short: 'Last standing' },
  ZOM: { name: 'Bastion squad', pitch: 'Hold the core against the horde with up to three friends. Build by day, survive the night.', short: 'Bastion squad' },
  RNG: { name: 'Shooting range', pitch: 'Your own private range. Any gun, any perk, nothing counts toward your record.', short: 'Shooting range' },
};
