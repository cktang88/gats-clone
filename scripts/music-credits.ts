/**
 * Writes public/music/tracks/CREDITS.md from the soundtrack registry (src/client/musicstream.ts for the recordings, src/client/musictracks.ts for
 * the synthesized themes), so the file and the in-game credits never disagree. Run: node scripts/music-credits.ts
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { allCredits, DROP, MARCH_CREDIT, STREAMS, type StreamKey } from '../src/client/musicstream.ts';
import { MAP_TRACK, TRACKS } from '../src/client/musictracks.ts';

const WHERE: Record<StreamKey, string> = { market: 'Night Market', groove: 'Radio', dizzy: 'Radio', chibi: 'Radio', dekalb: 'Radio', wraghstep: 'Radio' };
const MAP_NAME: Record<string, string> = {
  plaza: 'Plaza (and the menu)', oldtown: 'Old Town', quarry: 'Quarry', causeway: 'Causeway (harbour)', market: 'Night Market', museum: 'Museum', subpen: 'Sub Pen',
  park: 'Park', railyard: 'Rail Yard', summit: 'Summit', embassy: 'Embassy', airbase: 'Airbase', wasteland: 'Wasteland', range: 'Shooting Range', outpost: 'Outpost (Zombies)',
};

/** CREDITS.md as it should read. */
export function creditsMarkdown(): string {
  const themes = Object.entries(MAP_TRACK).map(([map, id]) => {
    const t = TRACKS[id];
    const pop = t.pop;
    const what = !pop ? 'the original seeded toy march'
      : pop.minor !== pop.major ? `day: ${pop.major.bpm} bpm, ${pop.major.progName}; night "${pop.minor.label}": ${pop.minor.bpm} bpm, ${pop.minor.progName}`
        : `${pop.major.bpm} bpm, ${pop.major.progName}`;
    const rec = STREAMS[id as StreamKey];
    const name = rec ? `"${rec.credit.title}" (${rec.credit.artist}, a recording, below); its stand-in theme while the file loads is "${t.label}"` : `"${t.label}"`;
    return `| ${MAP_NAME[map] ?? map} | ${name} | ${what} |`;
  });
  return [
    '# Soundtrack credits',
    '',
    `${MARCH_CREDIT}, so there are no recordings of them (docs/music/CRAFT.md says how the themes are written).`,
    'Night Market and the radio-only stations play the recordings below. Each was trimmed, loudness-normalised to -16 LUFS (true peak',
    '-1.5 dBTP) and re-encoded to MP3 for the game; the changes column says what else was done. All are used under the licence named,',
    'which requires this attribution; none is endorsed by its author.',
    '',
    '## Synthesized themes',
    '',
    '| Map | Theme | Tempo and progression |',
    '| --- | --- | --- |',
    ...themes,
    '',
    '## Recordings',
    '',
    '| Where | Title | Artist | Licence | Source | Changes | File |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...Object.values(STREAMS).map((s) => `| ${WHERE[s.key]} | "${s.credit.title}" | ${s.credit.artist} | [${s.credit.licence}](${s.credit.licenceUrl}) | ${s.credit.source} | ${s.credit.changes} | \`${s.file.split('/').pop()}\` |`),
    `| Bass-drop sting (big streaks over a recording) | "${DROP.credit.title}" | ${DROP.credit.artist} | [${DROP.credit.licence}](${DROP.credit.licenceUrl}) | ${DROP.credit.source} | ${DROP.credit.changes} | \`${DROP.file.split('/').pop()}\` |`,
    '',
    '## Attribution lines',
    '',
    ...allCredits().map((c) => `- "${c.title}" ${c.artist}. Licensed under Creative Commons: ${c.licence.replace('CC BY', 'By Attribution')} ${c.licenceUrl} (source: ${c.source}). Modified: ${c.changes}.`),
    '',
    '## Why each recording',
    '',
    ...Object.values(STREAMS).map((s) => `- **${WHERE[s.key]}**, "${s.credit.title}": ${s.why}`),
    '',
  ].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  writeFileSync(new URL('../public/music/tracks/CREDITS.md', import.meta.url), creditsMarkdown());
  console.log(`wrote ${Object.keys(STREAMS).length} recordings and ${Object.keys(MAP_TRACK).length} maps' themes`);
}
