import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isPhoneLandscape, overlaps, phoneLayout, type Box, type Insets } from '../src/client/phonelayout.ts';

/**
 * A phone on its side: iPhone 14/15 Pro Max (932x430), iPhone 14/15 (844x390), a 13 mini (812x375) and an iPhone SE (667x375), each at full screen
 * (the home-screen app) and with Safari's toolbar and landscape tab bar showing (about 60 px less), with and without the notch
 * and home-bar insets, at the phone's HUD scale and at a bigger UI scale option.
 */
const NONE: Insets = { l: 0, t: 0, r: 0, b: 0 };
/** Each phone's landscape insets (the notch or Dynamic Island side and its mirror, and the home bar); an SE has none. */
const PHONES: [number, number, Insets][] = [[932, 430, { l: 59, t: 0, r: 59, b: 21 }], [844, 390, { l: 47, t: 0, r: 47, b: 21 }], [812, 375, { l: 50, t: 0, r: 50, b: 21 }], [667, 375, NONE]];
const SCREENS: [number, number, Insets][] = PHONES.flatMap(([w, h, ins]) => [[w, h, ins], [w, h - 60, ins]] as [number, number, Insets][]);
const INSETS = (ins: Insets): [string, Insets][] => [['no insets', NONE], ...(ins === NONE ? [] : [['with insets', ins]] as [string, Insets][])];
const SCALES = [0.9, 1.0];

const within = (b: Box, w: number, h: number, ins: Insets) => b.x >= ins.l - 0.01 && b.y >= ins.t - 0.01 && b.x + b.w <= w - ins.r + 0.01 && b.y + b.h <= h - ins.b + 0.01;

for (const [w, h, phoneIns] of SCREENS) for (const [label, ins] of INSETS(phoneIns)) for (const k of SCALES) {
  test(`phone HUD at ${w}x${h}, ${label}, scale ${k}: no element overlaps another or the central play area`, () => {
    const { safe, ...boxes } = phoneLayout(w, h, ins, k);
    const entries = Object.entries(boxes);
    for (const [name, b] of entries) {
      assert.ok(b.w > 0 && b.h > 0, `${name} has a size`);
      assert.ok(within(b, w, h, ins), `${name} ${JSON.stringify(b)} stays on screen, inside the notch and home-bar insets`);
      assert.ok(!overlaps(b, safe), `${name} ${JSON.stringify(b)} stays out of the central play area ${JSON.stringify(safe)}`);
    }
    for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
      const [an, a] = entries[i]!, [bn, b] = entries[j]!;
      assert.ok(!overlaps(a, b), `${an} ${JSON.stringify(a)} overlaps ${bn} ${JSON.stringify(b)}`);
    }
    // Touch targets stay at least 40 px, and the minimap stays big enough to read.
    for (const name of ['ability', 'reload', 'emote', 'cog', 'context'] as const) assert.ok(Math.min(boxes[name].w, boxes[name].h) >= 40, `${name} is a thumb-sized target`);
    assert.ok(boxes.minimap.w >= 48, 'the minimap stays readable');
    // The central play area is a real share of the screen, not a sliver.
    assert.ok(safe.w >= 0.4 * w - 0.01 && safe.h >= 0.5 * h, 'the central play area is the middle 40% by half the height');
  });
}

test('only a touch screen on its side, under 520 px tall, gets the phone layout', () => {
  assert.equal(isPhoneLandscape(932, 430, true), true);
  assert.equal(isPhoneLandscape(667, 320, true), true);
  assert.equal(isPhoneLandscape(430, 932, true), false, 'upright: the rotate hint covers the field instead');
  assert.equal(isPhoneLandscape(1180, 820, true), false, 'a tablet keeps the full HUD');
  assert.equal(isPhoneLandscape(932, 430, false), false, 'a small desktop window keeps the desktop HUD');
});
