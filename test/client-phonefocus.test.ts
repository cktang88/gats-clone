import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ALWAYS_ON, FOCUS, feedKeeps, labelsOn, phoneFocus, statusAlways, type FocusState, type PhoneElement } from '../src/client/phonefocus.ts';
import { MODE_IDS, type ModeId } from '../src/shared/defs.ts';

/** A steady mid-round moment: nothing changed lately, nothing tapped, no chat, a veteran of earlier matches, five minutes left. */
const NEVER = -Infinity;
const steady = (mode: ModeId, over: Partial<FocusState> = {}): FocusState => ({
  mode, now: 100_000, timeLeft: mode === 'FFA' || mode === 'TDM' || mode === 'DOM' ? 300_000 : null, over: false, squadsLeft: mode === 'BR' ? 6 : undefined,
  levelAt: NEVER, scoreAt: NEVER, vitalsTapAt: NEVER, teamScoreAt: NEVER, mapTapAt: NEVER, chatTapAt: NEVER, rangeTapAt: NEVER,
  chatLines: 0, firstMatch: false, guidesSince: 0, introSeen: true, ...over,
});
const on = (f: Record<PhoneElement, boolean>) => (Object.keys(f) as PhoneElement[]).filter((k) => f[k]).sort();

test('the always-on set is health, ammo, ability, the sticks, the cog and the folded minimap', () => {
  assert.deepEqual([...ALWAYS_ON].sort(), ['ability', 'ammo', 'cog', 'health', 'minimap', 'sticks']);
  for (const mode of MODE_IDS) for (const el of ALWAYS_ON) assert.equal(phoneFocus(steady(mode))[el], true, `${el} is on in ${mode}`);
});

test('mid-round, each mode shows only the always-on set, its status line where it needs one, and the board chip', () => {
  const base = [...ALWAYS_ON].sort();
  const expect: Record<ModeId, string[]> = {
    FFA: [...base, 'board'].sort(),
    TDM: [...base, 'board'].sort(),
    DOM: [...base, 'board', 'status'].sort(),
    BR: [...base, 'board', 'status'].sort(),
    ZOM: [...base, 'status'].sort(),
    RNG: base,
  };
  for (const mode of MODE_IDS) assert.deepEqual(on(phoneFocus(steady(mode))), expect[mode], mode);
  assert.deepEqual(MODE_IDS.filter(statusAlways), ['DOM', 'ZOM', 'BR'], 'the status line is always on only for Domination, zombies and Last Squad');
});

test('each on-demand piece is hidden by default and comes up on its trigger, then goes again', () => {
  const t = 100_000;
  const cases: [PhoneElement, ModeId, Partial<FocusState>, number][] = [
    ['level', 'FFA', { levelAt: t }, FOCUS.chipMs],
    ['score', 'FFA', { scoreAt: t }, FOCUS.chipMs],
    ['level', 'FFA', { vitalsTapAt: t }, FOCUS.chipMs],
    ['score', 'DOM', { vitalsTapAt: t }, FOCUS.chipMs],
    ['minimapOpen', 'FFA', { mapTapAt: t }, FOCUS.mapOpenMs],
    ['teamScore', 'TDM', { teamScoreAt: t }, FOCUS.chipMs],
    ['chatOpen', 'FFA', { chatLines: 2, chatTapAt: t }, FOCUS.chatOpenMs],
    ['rangeFull', 'RNG', { rangeTapAt: t }, FOCUS.mapOpenMs],
    ['stickLabels', 'FFA', { firstMatch: true, guidesSince: t }, FOCUS.labelMs],
  ];
  for (const [el, mode, trigger, life] of cases) {
    assert.equal(phoneFocus(steady(mode))[el], false, `${el} is hidden by default in ${mode}`);
    assert.equal(phoneFocus(steady(mode, { ...trigger, now: t + 10 }))[el], true, `${el} comes up on its trigger`);
    assert.equal(phoneFocus(steady(mode, { ...trigger, now: t + life + 10 }))[el], false, `${el} goes again after ${life} ms`);
  }
});

test('the chat is a pip while there is something to read, its lines only once tapped', () => {
  assert.equal(phoneFocus(steady('FFA')).chatPip, false, 'no pip with nothing to read');
  const waiting = phoneFocus(steady('FFA', { chatLines: 1 }));
  assert.equal(waiting.chatPip, true);
  assert.equal(waiting.chatOpen, false);
  const open = phoneFocus(steady('FFA', { chatLines: 1, chatTapAt: 99_000 }));
  assert.equal(open.chatOpen, true);
  assert.equal(open.chatPip, false, 'the pip gives way to the lines (it stays as their close button: phonehud.ts)');
});

test('the clock and GG come up only as a round nears its end; GG also once it is over', () => {
  for (const mode of ['FFA', 'TDM'] as const) {
    assert.equal(phoneFocus(steady(mode)).clock, false, `${mode}: no clock mid-round`);
    assert.equal(phoneFocus(steady(mode, { timeLeft: FOCUS.clockMs - 1 })).clock, true, `${mode}: the clock in the last minute`);
  }
  assert.equal(phoneFocus(steady('TDM', { timeLeft: FOCUS.clockMs - 1 })).teamScore, true, 'TDM keeps its score up in the last minute');
  for (const mode of ['FFA', 'TDM', 'DOM'] as const) {
    assert.equal(phoneFocus(steady(mode)).gg, false, `${mode}: no GG mid-round`);
    assert.equal(phoneFocus(steady(mode, { timeLeft: FOCUS.ggMs - 1 })).gg, true, `${mode}: GG in the last half minute`);
    assert.equal(phoneFocus(steady(mode, { over: true })).gg, true, `${mode}: GG once the round is over`);
  }
  assert.equal(phoneFocus(steady('BR', { squadsLeft: 2 })).gg, true, 'Last Squad: GG with two squads left');
  assert.equal(phoneFocus(steady('ZOM', { over: true })).gg, true, 'zombies: GG once the run is over');
  assert.equal(phoneFocus(steady('RNG', { over: true })).gg, false, 'never on the range');
});

test('the objective line is spelled out once per mode, the stick labels only in the first match', () => {
  assert.equal(phoneFocus(steady('DOM', { introSeen: false })).intro, true);
  assert.equal(phoneFocus(steady('DOM', { introSeen: true })).intro, false);
  assert.equal(labelsOn(true, 1000, 0), true);
  assert.equal(labelsOn(false, 1000, 0), false, 'after the first match the labels never come back');
  assert.equal(labelsOn(true, FOCUS.labelMs + 1, 0), false);
});

test('the phone feed keeps your own kills and deaths and the big events, and drops the rest', () => {
  const me = 7;
  const kill = (k: Partial<{ killerId: number | null; victimId: number; bounty: boolean; ended: number; assisters: number[] }>) =>
    ({ e: 'kill' as const, killer: 'a', victim: 'b', killerId: 1, victimId: 2, weapon: 'smg', bounty: false, assisters: [], ended: 0, revenge: false, ...k });
  const teamOf = (id: number) => (id === 3 ? 'red' : id === 4 ? 'blue' : null);
  assert.equal(feedKeeps(kill({}), me, null, teamOf), false, "someone else's kill");
  assert.equal(feedKeeps(kill({ killerId: me }), me, null, teamOf), true, 'your kill');
  assert.equal(feedKeeps(kill({ victimId: me }), me, null, teamOf), true, 'your death');
  assert.equal(feedKeeps(kill({ assisters: [me] }), me, null, teamOf), true, 'your assist');
  assert.equal(feedKeeps(kill({ bounty: true }), me, null, teamOf), true, 'a bounty paid');
  assert.equal(feedKeeps(kill({ ended: 5 }), me, null, teamOf), true, 'a long streak ended');
  assert.equal(feedKeeps(kill({ ended: 2 }), me, null, teamOf), false, 'a short one is not news');
  assert.equal(feedKeeps({ e: 'hunted', id: 1, name: 'x' }, me, null, teamOf), true, 'someone hunted');
  assert.equal(feedKeeps({ e: 'wiped', team: 'red', place: 4 }, me, null, teamOf), true, 'a squad out');
  assert.equal(feedKeeps({ e: 'life', id: 3, name: 'x', k: 'downed', by: null }, me, 'red', teamOf), true, 'a squadmate down');
  assert.equal(feedKeeps({ e: 'life', id: 4, name: 'x', k: 'downed', by: null }, me, 'red', teamOf), false, 'a stranger down');
  assert.ok(FOCUS.feedMs < 6000, 'and briefer than the desktop feed');
});
