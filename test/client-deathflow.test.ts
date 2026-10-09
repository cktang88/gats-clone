import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Loadout } from '../src/shared/protocol.ts';
import { compactDeath, deathAct, deathBox, deathGist, deathPrimaryBox, deathView, DEATH_FOOT_H, firstStep, quickRespawn, stepFor, touchControlsShown, type DeathCtx, type DeathStep } from '../src/client/deathflow.ts';
import { overlaps, phoneLayout, type Box, type Insets } from '../src/client/phonelayout.ts';
import type { Recap } from '../src/client/records.ts';

const OLD: Loadout = { weapon: 'smg', armor: 'light', color: 'red' };
const PICKED: Loadout = { weapon: 'sniper', armor: 'heavy', color: 'blue' };
const phone = (wait = 0): DeathCtx => ({ compact: true, run: false, wait });
const desk = (wait = 0): DeathCtx => ({ compact: false, run: false, wait });

test('phone: stats, then Try again opens the loadout, then Respawn sends the loadout picked there', () => {
  let step: DeathStep = firstStep(true);
  let more = false;
  assert.equal(step, 'stats');
  const stats = deathView(step, phone(3), more);
  assert.equal(stats.loadout, false, 'the stats step keeps the loadout out of the way');
  assert.equal(stats.recap, false, 'the tiles wait behind More');
  assert.equal(stats.gist, true);
  assert.deepEqual(stats.primary, { label: 'Try again', act: 'loadout', disabled: false }, 'Try again is never held by the timer');
  assert.equal(stats.secondary, null);

  // More opens the tiles, records and nemesis in place, and closes again.
  let r = deathAct(step, 'more', phone(3), OLD, more);
  assert.equal(r.send, null);
  more = r.moreOpen;
  assert.equal(deathView(step, phone(3), more).recap, true);
  assert.equal(deathView(step, phone(3), more).gist, false, 'the gist folds into the tiles it summed up');

  r = deathAct(step, 'loadout', phone(3), OLD, more);
  ({ step } = r);
  more = r.moreOpen;
  assert.equal(step, 'loadout');
  assert.equal(r.send, null, 'Try again only moves on to the loadout');
  const kit = deathView(step, phone(3), more);
  assert.equal(kit.loadout, true);
  assert.equal(kit.title, false, 'the loadout step is lean: no killer line over the chips');
  assert.deepEqual(kit.primary, { label: 'Respawn in 3', act: 'respawn', disabled: true }, 'the countdown rides on the button');
  assert.deepEqual(kit.secondary, { label: 'Stats', act: 'stats', disabled: false });

  // Pressed while the timer runs, Respawn sends nothing; once it is up, it sends the loadout chosen on this step.
  assert.equal(deathAct(step, 'respawn', phone(3), PICKED, more).send, null);
  assert.deepEqual(deathView(step, phone(0), more).primary, { label: 'Respawn', act: 'respawn', disabled: false });
  assert.deepEqual(deathAct(step, 'respawn', phone(0), PICKED, more).send, { t: 'respawn', loadout: PICKED });

  // Back to the stats and forward again.
  assert.equal(deathAct(step, 'stats', phone(0), PICKED, more).step, 'stats');
});

test('desktop: the whole card at once, Respawn and Space send the current loadout', () => {
  const step = firstStep(false);
  assert.equal(step, 'all');
  const v = deathView(step, desk(2), false);
  assert.ok(v.recap && v.loadout && v.title && v.sub, 'recap, loadout and the sentence under them');
  assert.equal(v.more, false, 'nothing hides behind More with room to spare');
  assert.deepEqual(v.primary, { label: 'Respawn in 2', act: 'respawn', disabled: true });
  assert.equal(deathAct(step, 'respawn', desk(2), PICKED, false).send, null);
  assert.deepEqual(deathAct(step, 'respawn', desk(0), PICKED, false).send, { t: 'respawn', loadout: PICKED });
  assert.equal(quickRespawn(desk(1), PICKED), null, 'Space waits out the timer too');
  assert.deepEqual(quickRespawn(desk(0), PICKED), { t: 'respawn', loadout: PICKED });
  assert.equal(deathAct(step, 'loadout', desk(0), PICKED, false).step, 'all', 'no steps to walk on a desktop');
});

test('a phone turned or a window resized mid-death lands on a step that exists there', () => {
  assert.equal(stepFor('loadout', false), 'all');
  assert.equal(stepFor('stats', false), 'all');
  assert.equal(stepFor('all', true), 'stats');
  assert.equal(stepFor('loadout', true), 'loadout');
});

test('zombies, out till dawn: no loadout and no respawn button, and nothing sends a respawn', () => {
  for (const compact of [true, false]) {
    const ctx: DeathCtx = { compact, run: true, wait: 0 };
    const v = deathView(firstStep(compact), ctx, false);
    assert.equal(v.primary, null);
    assert.equal(v.secondary, null);
    assert.equal(v.loadout, false);
    assert.equal(v.more, false);
    assert.equal(deathAct(firstStep(compact), 'respawn', ctx, PICKED, false).send, null);
    assert.equal(quickRespawn(ctx, PICKED), null);
  }
});

test('the compact gist is one line: the first record set, else kills, damage and time alive', () => {
  const recap = (bests: boolean[]): Recap => ({
    stats: [
      { label: 'Kills', value: '2', best: bests[0]! }, { label: 'Damage', value: '193', best: bests[1]! },
      { label: 'Level', value: '1', best: bests[2]! }, { label: 'Survived', value: '1:07', best: bests[3]! },
    ],
    bests: { kills: 2, damage: 193, level: 1, aliveMs: 67_000 }, newBests: bests.filter(Boolean).length,
  });
  assert.equal(deathGist(recap([true, true, true, true])), 'New best · 2 kills (+3 more)');
  assert.equal(deathGist(recap([false, true, false, false])), 'New best · 193 damage');
  assert.equal(deathGist(recap([false, false, false, false])), '2 kills · 193 dmg · 1:07');
  assert.equal(deathGist(null), '');
});

test('the in-match touch controls show only while playing, and the stylesheet folds them away otherwise', () => {
  assert.equal(touchControlsShown('playing'), true);
  for (const phase of ['dead', 'menu', 'reconnecting'] as const) assert.equal(touchControlsShown(phase), false, phase);
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const rule = css.match(/\.hud\.no-touch-controls :is\(([^)]*)\)\s*\{\s*display:\s*none !important;/);
  assert.ok(rule, 'a rule hides the touch controls under .hud.no-touch-controls');
  for (const sel of ['.touch-buttons', '.touch-emote', '.touch-radio']) assert.ok(rule[1]!.includes(sel), `${sel} is folded away`);
  const main = readFileSync(new URL('../src/client/main.ts', import.meta.url), 'utf8');
  assert.match(main, /classList\.toggle\('no-touch-controls', !touchControlsShown\(next\.phase\)\)/, 'every state change sets the class from the phase');
});

/**
 * The phone sizes the user plays at: Safari on its side with its toolbar (932x370, 844x390, 667x375), the same with the landscape
 * tab bar showing too (as short as about 283 px), and the home-screen app at full height, with and without the notch insets.
 */
const NONE: Insets = { l: 0, t: 0, r: 0, b: 0 };
const SCREENS: [number, number, Insets][] = [
  [932, 370, { l: 59, t: 0, r: 59, b: 21 }], [844, 390, { l: 47, t: 0, r: 47, b: 21 }], [667, 375, NONE],
  [932, 283, { l: 59, t: 0, r: 59, b: 21 }], [844, 300, { l: 47, t: 0, r: 47, b: 21 }], [667, 300, NONE],
  [932, 430, { l: 59, t: 0, r: 59, b: 21 }], [812, 375, { l: 50, t: 0, r: 50, b: 21 }],
];
const within = (b: Box, w: number, h: number, ins: Insets) => b.x >= ins.l && b.y >= ins.t && b.x + b.w <= w - ins.r && b.y + b.h <= h - ins.b;

for (const [w, h, phoneIns] of SCREENS) for (const ins of phoneIns === NONE ? [NONE] : [NONE, phoneIns]) {
  test(`death card at ${w}x${h}${ins === NONE ? '' : ' with insets'}: on screen, clear of the cog, its primary button in view`, () => {
    assert.equal(compactDeath(w, h, true), true, 'the stepped card');
    const card = deathBox(w, h, ins);
    assert.ok(within(card, w, h, ins), `card ${JSON.stringify(card)} stays inside the visible screen and the insets`);
    assert.ok(!overlaps(card, phoneLayout(w, h, ins).cog), 'the pause cog stays tappable beside it');
    assert.ok(card.w >= 480, `wide enough for four tiles or six guns in a row (${card.w})`);
    assert.ok(card.h >= DEATH_FOOT_H + 120, 'room for the step above its button row');
    const primary = deathPrimaryBox(card);
    assert.ok(within(primary, w, h, ins), `the primary button ${JSON.stringify(primary)} is on screen`);
    assert.ok(primary.h >= 44 && primary.w >= 120, 'a thumb-sized button');
  });
}

test('a desktop window, a tablet or a phone held upright keeps the full card', () => {
  assert.equal(compactDeath(1600, 900, false), false);
  assert.equal(compactDeath(932, 430, false), false);
  assert.equal(compactDeath(1180, 820, true), false);
  assert.equal(compactDeath(390, 844, true), false);
});
