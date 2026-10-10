import { COLORS } from '../shared/defs.ts';
import type { Celebration } from './celebratedata.ts';

/** Made-up round ends for looking at the celebration with `?dev` (skirmishDev.celebrate('ffa' | 'team' | 'zomWin' | 'zomLoss')). */
export function demoCelebration(kind: string): Celebration {
  const stand = (id: number, name: string, color: string, kills: number) => ({ id, name, color, armor: (['heavy', 'medium', 'light'] as const)[id % 3]!, kills });
  const cards = [
    { label: 'MOST KILLS', value: '27', who: 'Ironside', color: COLORS.blue },
    { label: 'BEST STREAK', value: '9', who: 'Vex', color: COLORS.red },
    { label: 'MOST MEDALS', value: '6', who: 'Ironside', color: COLORS.blue },
    { label: 'LONGEST SHOT', value: '38 m', who: 'Marlow', color: COLORS.green },
  ];
  const podium = [stand(1, 'Ironside', COLORS.blue, 27), stand(2, 'Vex', COLORS.red, 21), stand(3, 'Marlow', COLORS.green, 17)];
  const paper = (c: string) => [c, c, '#ece6d6', c];
  if (kind === 'zomWin') return { kind: 'zomWin', confetti: ['#ffb347', '#b4a07a', '#ece6d6', '#ffd34d'], title: 'THE TIDE HELD', sub: 'The core fell on night 13, 3 past the Tide', podium, stamp: { text: 'HELD', top3: true, sub: '2ND in kills' }, cards: [{ ...cards[0]!, label: 'MOST KILLS' }, { ...cards[1]!, label: 'MOST REVIVES', value: '4' }, { ...cards[2]!, label: 'MOST BUILT', value: '12' }, { label: 'TURRET KILLS', value: '63', who: 'the squad', color: null }] };
  if (kind === 'zomLoss') return { kind: 'zomLoss', confetti: null, title: 'OVERRUN', sub: 'The horde took the core on night 3', podium, stamp: { text: 'FALLEN', top3: false, sub: '2ND in kills' }, cards };
  if (kind === 'team') return { kind: 'team', confetti: paper(COLORS.red), title: 'RED WINS THE ROUND', sub: 'Kills: Red 150 · Blue 131', podium: podium.map((p, i) => ({ ...p, color: COLORS.red, name: ['Vex', 'Rook', 'Dune'][i]! })), stamp: { text: 'VICTORY', top3: true, sub: '2ND overall' }, cards };
  return { kind: 'ffa', confetti: paper(COLORS.blue), title: 'IRONSIDE WINS THE ROUND', sub: '', podium, stamp: { text: '4TH', top3: false, sub: 'of 12' }, cards };
}
