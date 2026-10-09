import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ATTACHMENTS, GUN_IDS, GUNS, PERK_INFO, PERK_TIERS, rulesOf, VIEW, WEAPON_IDS, WORLD, type GunId, type PerkId, type Tier } from '../src/shared/defs.ts';
import { DEFAULT_VIEW_ASPECT, VIEW_PRELOAD_MARGIN, viewExtents } from '../src/shared/protocol.ts';
import { effectiveStats, stackView, viewBonuses, viewMulFor } from '../src/shared/sim/stats.ts';
import { snapshotFor } from '../src/shared/sim/snapshot.ts';
import { makeCamera } from '../src/client/camera.ts';
import { lookReach } from '../src/shared/lookahead.ts';
import { emptyWorld, spawnAt } from './helpers.ts';

const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;
const VIEW_PERKS = PERK_TIERS[1].concat(PERK_TIERS[2] as never).filter((perk) => viewBonuses('pistol', { 1: perk } as never).length > 0) as PerkId[];

/** The widest view a gun can reach: its scope with every view perk, each on its own tier (Optics is tier 1, Recon tier 2). */
function maxKit(gun: GunId, anyAttachment: boolean): Partial<Record<Tier, PerkId>> {
  const kit: Partial<Record<Tier, PerkId>> = {};
  for (const perk of VIEW_PERKS) {
    const tier = ([1, 2, 3] as const).find((t) => (PERK_TIERS[t] as readonly string[]).includes(perk))!;
    if (tier === 1 && !anyAttachment && !ATTACHMENTS[GUNS[gun].base].includes(perk as never)) continue;
    kit[tier] = perk;
  }
  return kit;
}

test('the default view is zoomed in from the old 900 px, then from 780 by about 10%', () => {
  assert.ok(WORLD.viewRadius >= 780 * 0.88 && WORLD.viewRadius <= 780 * 0.9, `${WORLD.viewRadius}`);
  // Still enough to fight: at 16:9 every gun's reach that is not a scope's fits inside the view and its aim look-ahead, and even an
  // ultrawide shows past where an SMG's damage starts to fade above and below.
  for (const id of GUN_IDS) if (GUNS[id].base !== 'sniper' && GUNS[id].base !== 'assault') assert.ok(GUNS[id].range <= WORLD.viewRadius + lookReach(WORLD.viewRadius, id), id);
  assert.ok(viewExtents(WORLD.viewRadius, 2.4).halfH >= 280, 'an ultrawide still sees 280 px up and down');
});

test('view bonuses stack with diminishing returns: one alone gives its whole value, more give less each, in any order, never past the cap', () => {
  const cap = 0.4;
  assert.equal(stackView([], cap), 1);
  assert.ok(close(stackView([0.2], cap), 1.2), 'a single bonus is worth all of itself');
  const two = stackView([0.2, 0.1], cap);
  assert.ok(close(two, 1 + cap * (1 - (1 - 0.2 / cap) * (1 - 0.1 / cap))));
  assert.ok(two > 1.2 && two < 1.3, `a second bonus still adds, but less than its face value (${two})`);
  assert.ok(close(stackView([0.1, 0.2], cap), two), 'the order makes no difference');
  assert.ok(stackView([0.3, 0.3, 0.3, 0.3, 0.3], cap) < 1 + cap, 'any pile stays under the cap');
  assert.ok(stackView([5], cap) <= 1 + cap + 1e-12, 'even an absurd bonus is held at the cap');
  assert.equal(stackView([-0.5], cap), 1, 'a negative bonus is no bonus');
  // Each extra bonus adds less than the one before.
  let prev = 1, gain = Infinity;
  for (let n = 1; n <= 5; n++) {
    const v = stackView(Array(n).fill(0.1), cap);
    assert.ok(v - prev < gain, `the ${n}th bonus adds less`);
    gain = v - prev; prev = v;
  }
});

test('every view bonus is below its class cap, so none saturates the view alone, and the first gives the most of its value', () => {
  for (const id of GUN_IDS) {
    const cap = VIEW.cap[GUNS[id].base];
    for (const b of viewBonuses(id, maxKit(id, true))) assert.ok(b > 0 && b < cap * 0.85, `${id}: bonus ${b} against cap ${cap}`);
  }
  // Optics and Recon are worth their face value on a gun with no scope.
  assert.ok(close(viewMulFor('pistol', { 1: 'optics' }), 1.12));
  assert.ok(close(viewMulFor('smg', { 2: 'recon' }), 1.08));
  assert.match(PERK_INFO.optics.desc, /\+12% view/);
  assert.match(PERK_INFO.recon.desc, /\+8% view/);
});

test('per-class caps: a sniper with everything sees 1.35 to 1.45 times the base view, any other class at most about 1.15 to 1.18', () => {
  for (const base of WEAPON_IDS) {
    const guns = GUN_IDS.filter((id) => GUNS[id].base === base);
    const worst = Math.max(...guns.map((id) => viewMulFor(id, maxKit(id, false))));
    const worstAny = Math.max(...guns.map((id) => viewMulFor(id, maxKit(id, true))));
    assert.ok(worstAny < 1 + VIEW.cap[base], `${base}: ${worstAny} under its cap`);
    if (base === 'sniper') {
      assert.ok(worst >= 1.35 && worst <= 1.45, `sniper worst case in play ${worst}`);
      assert.ok(worstAny <= 1.45, `sniper with any attachment on the range ${worstAny}`);
    } else {
      assert.ok(worstAny <= 1.18, `${base} worst case ${worstAny}`);
    }
  }
  // A sniper still sees clearly further than an SMG with all it can carry, at every stage.
  const smgBest = Math.max(...GUN_IDS.filter((id) => GUNS[id].base === 'smg').map((id) => viewMulFor(id, maxKit(id, true))));
  for (const id of GUN_IDS.filter((g) => GUNS[g].base === 'sniper')) assert.ok(viewMulFor(id, {}) > smgBest, `${id} out-sees any SMG`);
  assert.ok(viewMulFor('sniper', {}) >= smgBest + 0.1, 'the Bolt-action out of the box sees well past an SMG with everything');
  // The scope evolutions still widen the view: Longshot and Piercer past the Bolt-action, each step a little less.
  const [bolt, longshot, piercer] = (['sniper', 'longshot', 'piercer'] as const).map((id) => viewMulFor(id, {}));
  assert.ok(bolt! < longshot! && longshot! < piercer!);
  // An upgrade stacked on the widest scope still counts for something.
  assert.ok(viewMulFor('piercer', { 2: 'recon' }) - piercer! >= 0.01);
});

test('the worst-case stacks, in px', () => {
  const px = (gun: GunId, perks: Partial<Record<Tier, PerkId>> = {}) => Math.round(WORLD.viewRadius * viewMulFor(gun, perks));
  assert.equal(px('pistol'), WORLD.viewRadius);
  assert.ok(px('piercer', { 1: 'optics', 2: 'recon' }) <= 1100, 'the range-only Piercer, Optics and Recon was 2153 px');
  assert.ok(px('piercer', { 2: 'recon' }) <= 1080, 'Piercer and Recon was 1656 px');
  assert.ok(px('scout', { 1: 'optics', 2: 'recon' }) <= 920, 'Scout, Optics and Recon was 1749 px');
});

test("the server's interest, the client's camera and a bot's sight all use the same stacked view", () => {
  for (const [gun, perks] of [['pistol', {}], ['sniper', {}], ['piercer', { 1: 'optics', 2: 'recon' }], ['scout', { 1: 'optics', 2: 'recon' }]] as const) {
    const w = emptyWorld();
    const me = spawnAt(w, 2000, 2000);
    const bot = spawnAt(w, 2000, 4000, { kind: 'bot' });
    for (const p of [me, bot]) { p.gun = gun; p.perks = { ...perks }; }
    const R = WORLD.viewRadius * viewMulFor(gun, perks);
    assert.ok(close(effectiveStats(me).viewRadius, R), gun);
    assert.ok(close(snapshotFor(w, me.id).self.viewRadius, R), `${gun}: the client is told the stacked view`);
    assert.ok(close(snapshotFor(w, bot.id).self.viewRadius, R), `${gun}: a bot with the same kit sees no further than a human`);
    // The camera that view radius gives at 16:9 shows exactly the extents the server culls by (plus its preload margin).
    const cam = makeCamera({ x: me.x, y: me.y }, 1600, 900, R);
    const ext = viewExtents(R, DEFAULT_VIEW_ASPECT);
    assert.ok(close(cam.viewHalfW, ext.halfW) && close(cam.viewHalfH, ext.halfH));
    assert.ok(close(1600 / cam.scale / 2, ext.halfW, 1e-6), 'the camera draws the full width and no more');
    const edge = spawnAt(w, me.x + ext.halfW - 1, me.y);
    const beyond = spawnAt(w, me.x + ext.halfW + VIEW_PRELOAD_MARGIN + WORLD.playerRadius + 1, me.y + 10);
    const ids = snapshotFor(w, me.id).players.map((q) => q.id);
    assert.ok(ids.includes(edge.id), `${gun}: an enemy at the camera's edge is sent`);
    assert.ok(!ids.includes(beyond.id), `${gun}: one past the edge and the preload margin is not`);
  }
});

test('the gun scope numbers keep each class tree in order', () => {
  assert.equal(rulesOf(GUNS.pistol).viewMul, 1);
  for (const id of GUN_IDS) assert.ok(rulesOf(GUNS[id]).viewMul >= 1 && rulesOf(GUNS[id]).viewMul - 1 < VIEW.cap[GUNS[id].base], id);
});
