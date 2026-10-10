import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULTS, levelState, MAX_LEVEL, PRESTIGE_XP, xpForLevel, XP_REASON_LABEL, type ProgressMsg } from '../src/shared/cosmetics.ts';
import type { ChallengesView, ChallengeView } from '../src/shared/challenges.ts';
import { barSteps, challengePct, collectionCounts, fillOf, foldProgress, formatReset, joinPicks, levelBar, mergeEquipped, newlyDone, nextUnlock, openChallenges, owns, parseProfile, revealOrder, weeklyReward, xpLines, xpTotal } from '../src/client/progression.ts';
import { COSMETIC_BY_ID } from '../src/shared/cosmetics.ts';

const eq = (over: Record<string, string> = {}) => ({ ...DEFAULTS, ...over });

test('a signed-in account wears what the server says; a guest wears their own picks if their name owns them', () => {
  const server = eq({ helmet: 'h_viking', gunSkin: 'g_gold' });
  assert.equal(mergeEquipped({ signedIn: true, server, local: { helmet: 'h_beret' }, unlocked: new Set() }).helmet, 'h_viking', 'the server wins for an account');
  const owned = new Set([...Object.values(DEFAULTS), 'h_beret', 'c_woodland']);
  const guest = mergeEquipped({ signedIn: false, server: null, local: { helmet: 'h_beret', camo: 'c_woodland', gunSkin: 'g_gold' }, unlocked: owned });
  assert.equal(guest.helmet, 'h_beret');
  assert.equal(guest.camo, 'c_woodland');
  assert.equal(guest.gunSkin, DEFAULTS.gunSkin, 'a locked pick is not worn');
});

test('before the name is known a guest is taken at their word; a slot with no pick of its own wears what the server holds', () => {
  assert.equal(mergeEquipped({ signedIn: false, server: null, local: { helmet: 'h_crown' }, unlocked: null }).helmet, 'h_crown');
  const m = mergeEquipped({ signedIn: false, server: eq({ killFx: 'k_ink', helmet: 'h_beret' }), local: { helmet: 'h_standard' }, unlocked: new Set(['h_beret', 'k_ink', ...Object.values(DEFAULTS)]) });
  assert.equal(m.killFx, 'k_ink');
  assert.equal(m.helmet, 'h_standard', 'the guest chose the default on purpose');
  assert.equal(mergeEquipped({ signedIn: true, server: null, local: {}, unlocked: null }).helmet, DEFAULTS.helmet);
});

test('a guest joins with their whole look; an account joins with nothing, the server holds its own', () => {
  assert.equal(joinPicks(true, eq({ helmet: 'h_beret' })), undefined);
  const picks = joinPicks(false, eq({ helmet: 'h_beret' }))!;
  assert.equal(picks.helmet, 'h_beret');
  assert.equal(Object.keys(picks).length, 6);
});

test('ownership: defaults always, everything else only when unlocked', () => {
  const cone = COSMETIC_BY_ID.get('h_cone')!, std = COSMETIC_BY_ID.get('h_standard')!;
  assert.equal(owns(null, std), true);
  assert.equal(owns(null, cone), false);
  assert.equal(owns(new Set(['h_cone']), cone), true);
});

test('the level bar reads off the level state, and fills toward the next prestige star at the top', () => {
  const s = levelState(xpForLevel(34) + 100);
  const bar = levelBar(s);
  assert.equal(bar.level, 34);
  assert.equal(bar.max, false);
  assert.ok(bar.pct > 0 && bar.pct < 0.1);
  assert.match(bar.label, /^100 \/ 2,440 XP$/);
  const top = levelBar(levelState(xpForLevel(MAX_LEVEL) + PRESTIGE_XP * 2 + 2500));
  assert.equal(top.max, true);
  assert.equal(top.prestige, 2);
  assert.equal(top.pct, 0.25);
  assert.match(top.label, /to the next star$/);
  assert.equal(fillOf({ xpInLevel: 0, xpToNext: 0 }), 0);
});

test('XP card lines: labels from the shared table, one line per reason, challenges named by their text, zero lines dropped', () => {
  const lines = xpLines([{ reason: 'kills', xp: 100 }, { reason: 'score', xp: 40 }, { reason: 'kills', xp: 25 }, { reason: 'finish', xp: 0 }, { reason: 'challenge', xp: 250, id: 'd_smg' }]);
  assert.deepEqual(lines.map((l) => l.label), [XP_REASON_LABEL.kills, XP_REASON_LABEL.score, 'Get 15 kills with an SMG']);
  assert.deepEqual(lines.map((l) => l.text), ['+125', '+40', '+250']);
  assert.equal(xpTotal([{ reason: 'kills', xp: 100 }, { reason: 'win', xp: 100 }, { reason: 'score', xp: -5 }]), 200);
  assert.deepEqual(xpLines([{ reason: 'challenge', xp: 10, id: 'not_a_challenge' }])[0]!.label, XP_REASON_LABEL.challenge);
});

const msg = (xp: number, gained: ProgressMsg['gained'], levelUps: number[] = [], unlocks: string[] = []): Pick<ProgressMsg, 'xp' | 'gained' | 'levelUps' | 'unlocks'> => ({ xp, gained, levelUps, unlocks });

test('progress messages fold into one card: gains add, the start is the first one\'s, an empty message changes nothing', () => {
  assert.equal(foldProgress(null, msg(500, [])), null, 'the first message after welcome has no gains');
  const a = foldProgress(null, msg(1000, [{ reason: 'kills', xp: 100 }]))!;
  assert.equal(a.from, 900);
  assert.equal(a.to, 1000);
  const b = foldProgress(a, msg(1140, [{ reason: 'finish', xp: 40 }], [3], ['h_beret']))!;
  assert.equal(b.from, 900);
  assert.equal(b.to, 1140);
  assert.equal(b.gained.length, 2);
  assert.deepEqual(b.levelUps, [3]);
  assert.deepEqual(b.unlocks, ['h_beret']);
  assert.equal(foldProgress(b, msg(1140, [])), b);
});

test('the bar fills through each level crossed: a full leg per level with a stamp, then the part-leg', () => {
  const from = xpForLevel(4) - 100, to = xpForLevel(6) + 50;
  const steps = barSteps(from, to);
  assert.deepEqual(steps.map((s) => [s.level, s.up]), [[3, true], [4, true], [5, true], [6, false]]);
  assert.ok(steps[0]!.from > 0.8 && steps[0]!.to === 1);
  assert.equal(steps[1]!.from, 0);
  assert.ok(steps[3]!.to > 0 && steps[3]!.to < 0.1);
  const flat = barSteps(xpForLevel(10) + 10, xpForLevel(10) + 200);
  assert.equal(flat.length, 1);
  assert.equal(flat[0]!.up, false);
  assert.ok(flat[0]!.to > flat[0]!.from);
  const star = barSteps(xpForLevel(MAX_LEVEL) + PRESTIGE_XP - 100, xpForLevel(MAX_LEVEL) + PRESTIGE_XP + 100);
  assert.deepEqual(star.map((s) => [s.level, s.prestige, s.up]), [[MAX_LEVEL, 0, true], [MAX_LEVEL, 1, false]]);
});

test('unlocks reveal the rarest first, and unknown ids are dropped', () => {
  assert.deepEqual(revealOrder(['h_beret', 'h_crown', 'h_cone', 'zzz']), ['h_crown', 'h_cone', 'h_beret']);
});

test('reset countdowns read as days and hours, hours and minutes, or minutes', () => {
  assert.equal(formatReset(30_000), 'under a minute');
  assert.equal(formatReset(12 * 60_000), '12m');
  assert.equal(formatReset((5 * 60 + 12) * 60_000), '5h 12m');
  assert.equal(formatReset((2 * 24 * 60 + 4 * 60 + 59) * 60_000), '2d 4h');
});

const chal = (id: string, over: Partial<ChallengeView> = {}): ChallengeView => ({ id, target: 10, xp: 200, progress: 0, done: false, text: id, ...over });
const view = (daily: ChallengeView[], weekly: ChallengeView[], day = 'd1', week = 'w1'): ChallengesView => ({ day, dailyResetsAt: 1, daily, week, weeklyResetsAt: 2, weekly });

test('a challenge completing between two progress messages is news; the first look and a rollover are not', () => {
  const before = view([chal('a'), chal('b', { done: true, progress: 10 }), chal('c')], [chal('w1')]);
  const after = view([chal('a', { done: true, progress: 10 }), chal('b', { done: true, progress: 10 }), chal('c')], [chal('w1', { done: true, progress: 10 })]);
  assert.deepEqual(newlyDone(before, after).map((c) => c.id), ['a', 'w1']);
  assert.deepEqual(newlyDone(null, after), []);
  const nextDay = view([chal('a', { done: true }), chal('x', { done: true })], after.weekly, 'd2');
  assert.deepEqual(newlyDone(after, nextDay), [], 'a new day brings new challenges that are not completions');
  assert.equal(challengePct(chal('p', { progress: 5 })), 0.5);
  assert.equal(challengePct(chal('p', { progress: 50 })), 1);
  assert.equal(openChallenges(before), 3);
  assert.equal(openChallenges(null), 0);
});

test('the weekly reward is the challenge that carries one', () => {
  const v = view([], [chal('w1'), chal('w2', { grant: 'h_party' })]);
  assert.equal(weeklyReward(v)?.item.id, 'h_party');
  assert.equal(weeklyReward(view([], [chal('w1')])), null);
});

test('the next reward is the lowest level above yours, the rarer of a tie', () => {
  assert.equal((nextUnlock(0)!.unlock as { level: number }).level, 2);
  assert.equal(nextUnlock(63)!.unlock && (nextUnlock(63)!.unlock as { level: number }).level, 66);
  assert.equal(nextUnlock(100), null);
});

test('collection counts per slot count defaults and unlocked items', () => {
  const none = collectionCounts(new Set());
  assert.equal(none.helmet.have, 1);
  assert.equal(none.helmet.total, 16);
  const some = collectionCounts(new Set(['h_beret', 'h_crown', 'c_woodland']));
  assert.equal(some.helmet.have, 3);
  assert.equal(some.camo.have, 2);
});

test('the profile endpoint is read defensively', () => {
  assert.equal(parseProfile(null), null);
  assert.equal(parseProfile({ nope: 1 }), null);
  const p = parseProfile({ name: 'Viper', xp: 150000, level: 64, prestige: 0, xpInLevel: 10, xpToNext: 20, unlocked: ['h_beret', 'bogus', 5], equipped: { helmet: 'h_beret', camo: 'g_gold' }, challenges: { daily: [], weekly: [] } })!;
  assert.deepEqual(p.unlocked, ['h_beret']);
  assert.equal(p.equipped.helmet, 'h_beret');
  assert.equal(p.equipped.camo, DEFAULTS.camo, 'an id under the wrong slot is dropped');
  assert.equal(p.level, 64);
  assert.deepEqual(p.challenges, { daily: [], weekly: [] });
  assert.equal(parseProfile({ name: 'x', xp: 5, challenges: { daily: 'nope' } })!.challenges, null, 'malformed challenges are dropped, not trusted');
  assert.equal(parseProfile({ name: 'x', xp: 5 })!.level, 1);
});
