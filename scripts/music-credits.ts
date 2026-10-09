/**
 * Writes public/music/tracks/CREDITS.md from the soundtrack registry (src/client/musicstream.ts), so the file and the in-game credits never
 * disagree. Run: node scripts/music-credits.ts
 */
import { writeFileSync } from 'node:fs';
import { allCredits, DROP, MARCH_CREDIT, STREAMS, type StreamKey } from '../src/client/musicstream.ts';

const WHERE: Record<StreamKey, string> = {
  oldtown: 'Old Town', quarry: 'Quarry', harbor: 'Causeway (harbour)', market: 'Night Market', museum: 'Museum', subpen: 'Sub Pen', park: 'Park',
  railyard: 'Railyard', summit: 'Summit', embassy: 'Embassy', airbase: 'Airbase', wasteland: 'Wasteland', range: 'Shooting Range',
  outpost: 'Outpost / Zombies (day)', 'outpost-night': 'Outpost / Zombies (night)', groove: 'Radio', dizzy: 'Radio', chibi: 'Radio', dekalb: 'Radio', wraghstep: 'Radio',
};
const lines = [
  '# Soundtrack credits',
  '',
  `The menu and the Plaza play the original Tinwar march. ${MARCH_CREDIT}; it is synthesized live, so there is no recording.`,
  'Every other map, the Zombies night and the radio-only stations play the recordings below. Each was trimmed, loudness-normalised to',
  '-16 LUFS (true peak -1.5 dBTP) and re-encoded to MP3 for the game; the changes column says what else was done. All are used under the',
  'licence named, which requires this attribution; none is endorsed by its author.',
  '',
  '| Where | Title | Artist | Licence | Source | Changes | File |',
  '| --- | --- | --- | --- | --- | --- | --- |',
  ...Object.values(STREAMS).map((s) => `| ${WHERE[s.key]} | "${s.credit.title}" | ${s.credit.artist} | [${s.credit.licence}](${s.credit.licenceUrl}) | ${s.credit.source} | ${s.credit.changes} | \`${s.file.split('/').pop()}\` |`),
  `| Bass-drop sting (big streaks) | "${DROP.credit.title}" | ${DROP.credit.artist} | [${DROP.credit.licence}](${DROP.credit.licenceUrl}) | ${DROP.credit.source} | ${DROP.credit.changes} | \`${DROP.file.split('/').pop()}\` |`,
  '',
  '## Attribution lines',
  '',
  ...allCredits().map((c) => `- "${c.title}" ${c.artist}. Licensed under Creative Commons: ${c.licence.replace('CC BY', 'By Attribution')} ${c.licenceUrl} (source: ${c.source}). Modified: ${c.changes}.`),
  '',
  '## Why each track',
  '',
  ...Object.values(STREAMS).map((s) => `- **${WHERE[s.key]}**, "${s.credit.title}": ${s.why}`),
  '',
];
writeFileSync(new URL('../public/music/tracks/CREDITS.md', import.meta.url), lines.join('\n'));
console.log(`wrote ${Object.keys(STREAMS).length} tracks`);
