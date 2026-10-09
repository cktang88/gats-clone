import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CAREER, CAREER_IDS, MEDALS, type MedalId } from '../src/shared/defs.ts';
import { careerTooltip } from '../src/client/medals.ts';

test('every lifetime medal has a hover tooltip saying what it is for and every rung, plus the rung held and when', () => {
  for (const track of CAREER_IDS) {
    const def = CAREER[track], tip = careerTooltip(track);
    assert.ok(tip.startsWith(`${def.name}: Earned for ${def.unit}`), tip);
    for (const n of def.at) assert.ok(tip.includes(n.toLocaleString('en-US')), `${track} names the ${n} rung`);
    if (def.needs in MEDALS) assert.ok(tip.toLowerCase().includes(MEDALS[def.needs as MedalId].desc.toLowerCase()), `${track} explains the match medal it counts`);
    assert.ok(!tip.includes('Held'), 'a locked medal says nothing is held');
  }
  const held = careerTooltip('kills', { tier: 2, at: Date.UTC(2026, 9, 1) });
  assert.match(held, /Held: Centurion III \(Gold\), earned /);
  assert.match(held, /Bronze 100 · Silver 500 · Gold 1,500 · Platinum 5,000/);
});
