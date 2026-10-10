/**
 * What's new: the biggest player-facing changes, newest first, shown from the menu's bottom bar. Add a line at the top of the newest
 * day (or a new day above it) whenever a change ships that players will notice; keep each line short, plain and about what they see.
 */
export type ChangelogDay = { date: string; items: string[] };

export const CHANGELOG: ChangelogDay[] = [
  {
    date: '2026-10-10',
    items: [
      'Zombies: every gun and every building has a job against the horde, with round prices and clean upgrade steps (1.5×, 2×)',
    ],
  },
  {
    date: '2026-10-09',
    items: [
      'Your picks this life in a clear row of slots top left, with what unlocks next',
      'Zombies: drag to lay a whole line of wall',
      'New catchy synthesized music on every map',
      'Bots fight smarter: they pre-aim corners, weigh the odds and avoid 1v2s',
      'Shots register where you see them: the round on your screen is the round that hits',
      'Phone HUD decluttered, and a death card that fits the screen',
      'Cabinets open by themselves when you need them',
      'Full-auto spread punishes a held trigger, plus a weapons balance pass',
      'Guests keep their progress when they make an account',
      'A clean shooting range with a target at every painted distance',
    ],
  },
  {
    date: '2026-10-08',
    items: [
      'Snipers get a visible bolt cycle, and no gun is a laser any more',
      'Domination points you can read: more soldiers capture faster',
      'Health cross in the corner, with hit and heal flashes',
      'Hidden radios on every versus map, and music for each map',
      'Pause menu with settings and graphics presets',
    ],
  },
  {
    date: '2026-10-07',
    items: [
      'Polygon walls, doors and roofs, with six new or reworked maps',
      'Levels, 98 cosmetics, and daily and weekly challenges',
      'Killcam, slow-mo, emotes, celebrations, barrels and airdrops',
      'Medals, player profiles and a mastery track for every weapon',
    ],
  },
];

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** A date as players read it: "Oct 9". */
export function dayLabel(date: string): string {
  const [, m, d] = date.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return m && d ? `${months[m - 1]} ${d}` : date;
}

/** The panel's body: one heading per day, newest first, and its lines. */
export function changelogHtml(days: readonly ChangelogDay[] = CHANGELOG): string {
  return [...days].sort((a, b) => b.date.localeCompare(a.date)).map((day) =>
    `<section class="cl-day"><h3><time datetime="${escape(day.date)}">${escape(dayLabel(day.date))}</time></h3><ul>${day.items.map((i) => `<li>${escape(i)}</li>`).join('')}</ul></section>`,
  ).join('');
}
