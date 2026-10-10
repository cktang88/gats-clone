import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ABILITIES, CLAYMORE, HEAL_POLE, RADAR } from '../src/shared/sim/abilities.ts';
import { snapshotFor } from '../src/shared/sim/snapshot.ts';
import { befriend } from '../src/shared/sim/world.ts';
import { roundPasses } from '../src/shared/protocol.ts';
import { emptyWorld, run, shootOnce, spawnAt } from './helpers.ts';

type P = ReturnType<typeof spawnAt>;
const hp = (p: P) => (p.life.k === 'alive' ? p.life.hp : 0);
const aim = (p: P, angle: number, dist = 300) => { p.angle = angle; p.input = { ...p.input, angle, aimDist: dist }; };

test('a radar sensor tags every enemy in its wide ring, through walls, on everyone\'s minimap for 30s', () => {
  const w = emptyWorld('TDM');
  const thrower = spawnAt(w, 1000, 1000, { team: 'red' });
  const mate = spawnAt(w, 1000, 2600, { team: 'red' });
  const near = spawnAt(w, 1500, 1000, { team: 'blue' });
  const far = spawnAt(w, 1300 + RADAR.radius + 200, 1000, { team: 'blue' });
  const theirMate = spawnAt(w, 4000, 4000, { team: 'blue' });
  aim(thrower, 0, 300);
  assert.ok(ABILITIES.radar(w, thrower));
  run(w, RADAR.fuseMs + 100);
  assert.ok(near.taggedUntil > w.now, 'an enemy in reach is tagged');
  assert.equal(far.taggedUntil, 0, 'one out of reach is not');
  assert.equal(mate.taggedUntil, 0, 'a teammate never is');
  const seen = (viewer: P) => snapshotFor(w, viewer.id).minimap.filter((m) => m.tagged).length;
  assert.equal(seen(thrower), 1, 'the thrower sees the tag');
  assert.equal(seen(mate), 1, 'so does a teammate far away');
  assert.equal(seen(theirMate), 0, 'the tagged player\'s own side sees them as a teammate, not a tag');
  assert.ok((snapshotFor(w, near.id).self.tagged ?? 0) > 25, 'the tagged player is told');
  run(w, RADAR.tagMs);
  assert.equal(seen(thrower), 0, 'the tag runs out');
});

test('in a free-for-all the tag shows to everyone but the tagged player, and spares the thrower\'s friends', () => {
  const w = emptyWorld('FFA');
  const thrower = spawnAt(w, 1000, 1000), pal = spawnAt(w, 1400, 1000), stranger = spawnAt(w, 1000, 1400), bystander = spawnAt(w, 4000, 4000);
  befriend(w, thrower.id, pal.id);
  aim(thrower, 0, 200);
  ABILITIES.radar(w, thrower);
  run(w, RADAR.fuseMs + 100);
  assert.equal(pal.taggedUntil, 0, 'a friend is never tagged');
  assert.ok(stranger.taggedUntil > w.now);
  assert.ok(snapshotFor(w, bystander.id).minimap.some((m) => m.tagged), 'a bystander sees the stranger too');
});

test('a heal pole heals its owner, teammates and friends in reach, and nobody else', () => {
  const w = emptyWorld('TDM');
  const owner = spawnAt(w, 1000, 1000, { team: 'red' });
  const mate = spawnAt(w, 1080, 1000, { team: 'red' });
  const foe = spawnAt(w, 1000, 1080, { team: 'blue' });
  const away = spawnAt(w, 1000 + HEAL_POLE.radius + 60, 1000, { team: 'red' });
  for (const p of [owner, mate, foe, away]) if (p.life.k === 'alive') p.life.hp = 20;
  assert.ok(ABILITIES.healPole(w, owner));
  run(w, 2000);
  // Everyone regenerates on their own; `away` (out of reach) is what regeneration alone gives.
  const pole = HEAL_POLE.hps * 1.5;
  assert.ok(hp(owner) - hp(away) >= pole && hp(mate) - hp(away) >= pole, `healed past regen: owner ${hp(owner)}, mate ${hp(mate)}, regen alone ${hp(away)}`);
  assert.ok(Math.abs(hp(foe) - hp(away)) < 1, `an enemy gets regen only (${hp(foe)} vs ${hp(away)})`);
  run(w, HEAL_POLE.lifeMs);
  assert.ok(!w.thrown.some((t) => t.kind === 'healPole'), 'the pole goes when its time is up');
});

test('the shield is one-way: its owner shoots out through it, and nothing shoots back in', () => {
  const w = emptyWorld('FFA');
  const owner = spawnAt(w, 1000, 1000), foe = spawnAt(w, 1400, 1000);
  aim(owner, 0);
  assert.ok(ABILITIES.engineer(w, owner));
  const wall = w.walls.at(-1)!;
  assert.deepEqual(wall.out, [1, 0], 'it lets rounds out the way its owner faced');
  assert.ok(roundPasses(wall, 1, 0) && !roundPasses(wall, -1, 0));
  const foeFull = hp(foe), ownerFull = hp(owner);
  shootOnce(w, owner, 0);
  assert.ok(hp(foe) < foeFull, 'the owner\'s round goes out through the shield');
  shootOnce(w, foe, Math.PI);
  assert.equal(hp(owner), ownerFull, 'the foe\'s round stops at the shield');
});

test('an enemy claymore reaches a viewer only when they look right at it from near enough; its own side always sees it', () => {
  const w = emptyWorld('TDM');
  const owner = spawnAt(w, 3000, 3000, { team: 'red' });
  const mate = spawnAt(w, 1300, 1400, { team: 'red' });
  const foe = spawnAt(w, 1000, 1000, { team: 'blue' });
  w.thrown.push({ id: 9001, kind: 'claymore', owner: owner.id, team: 'red', x: 1300, y: 1000, angle: Math.PI, armedAt: 0, expiresAt: w.now + 60_000 });
  const sees = (p: P) => snapshotFor(w, p.id).thrown.some((t) => t.kind === 'claymore');
  const look = (a: number) => { foe.angle = a; };
  look(0);
  assert.ok(sees(foe), 'looking straight at it, 300 px off');
  look(Math.PI / 4 - 0.05);
  assert.ok(sees(foe), 'just inside a 90 degree view');
  look(Math.PI / 2);
  assert.ok(!sees(foe), 'looking aside, it is not sent');
  look(Math.PI);
  assert.ok(!sees(foe), 'nor with their back to it');
  look(0);
  foe.x = 1300 - CLAYMORE.seePx - 30;
  assert.ok(!sees(foe), 'nor from further than it can be made out');
  assert.ok(CLAYMORE.seePx - CLAYMORE.reach - 14 > 0.4 * 255 * 1.65, 'spotted early enough to stop even at a sprint');
  mate.angle = Math.PI / 2;
  assert.ok(sees(mate), 'a teammate sees it wherever they look');
});
