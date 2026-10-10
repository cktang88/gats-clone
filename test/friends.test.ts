import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WORLD } from '../src/shared/defs.ts';
import { parseClientMsg } from '../src/shared/protocol.ts';
import { damagePlayer } from '../src/shared/sim/combat.ts';
import { snapshotFor } from '../src/shared/sim/snapshot.ts';
import { areFriends, befriend, friendsOf, unfriend } from '../src/shared/sim/world.ts';
import { removePlayer, respawn } from '../src/shared/sim.ts';
import { emptyWorld, run, shootOnce, spawnAt } from './helpers.ts';

type W = ReturnType<typeof emptyWorld>;
type P = ReturnType<typeof spawnAt>;
const hp = (p: P) => (p.life.k === 'alive' ? p.life.hp : 0);
const blast = (w: W, by: P, victim: P) =>
  damagePlayer(w, victim, 50, { attacker: by, team: by.team, label: 'Grenade', piercing: false, via: 'blast', fromX: by.x, fromY: by.y });

test('friendships go both ways and end both ways', () => {
  const w = emptyWorld();
  const a = spawnAt(w, 500, 500), b = spawnAt(w, 900, 500), c = spawnAt(w, 1300, 500);
  befriend(w, a.id, b.id);
  assert.ok(areFriends(w, a.id, b.id) && areFriends(w, b.id, a.id));
  assert.ok(!areFriends(w, a.id, c.id));
  assert.ok(!areFriends(w, a.id, a.id), 'nobody is their own friend');
  unfriend(w, b.id, a.id);
  assert.ok(!areFriends(w, a.id, b.id) && !areFriends(w, b.id, a.id));
  assert.equal(w.friends.size, 0, 'nothing left behind');
});

test('friends cannot hurt each other in a free-for-all, by round or blast, but anyone else still can', () => {
  const w = emptyWorld();
  const a = spawnAt(w, 500, 500), b = spawnAt(w, 700, 500), c = spawnAt(w, 500, 900);
  befriend(w, a.id, b.id);
  const full = hp(b);
  blast(w, a, b);
  assert.equal(hp(b), full, 'a friend\'s grenade does nothing');
  shootOnce(w, a, 0);
  assert.equal(hp(b), full, 'a friend\'s round passes through');
  blast(w, c, b);
  assert.ok(hp(b) < full, 'a stranger still hurts');
});

test('a friend always shows on your minimap, marked as a friend, wherever they are', () => {
  const w = emptyWorld();
  const a = spawnAt(w, 300, 300), b = spawnAt(w, 2500, 2500);
  assert.equal(snapshotFor(w, a.id).minimap.length, 0, 'a stranger out of sight is not on the minimap');
  befriend(w, a.id, b.id);
  const mark = snapshotFor(w, a.id).minimap.find((m) => m.friend);
  assert.ok(mark, 'the friend is on the minimap');
  assert.equal(Math.round(mark.x), Math.round(b.x));
});

test('the leaderboard tells people from bots, so only people are offered as friends', () => {
  const w = emptyWorld();
  const person = spawnAt(w, 300, 300, { kind: 'human' }), bot = spawnAt(w, 900, 300);
  const rows = snapshotFor(w, person.id).leaderboard;
  assert.equal(rows.find((r) => r.id === person.id)?.human, true);
  assert.equal(rows.find((r) => r.id === bot.id)?.human, undefined);
});

test('a dead player with a friend standing comes back right beside them', () => {
  const w = emptyWorld();
  const a = spawnAt(w, 400, 400), b = spawnAt(w, 2600, 2400);
  befriend(w, a.id, b.id);
  a.life = { k: 'dead', respawnAt: 0 };
  assert.ok(respawn(w, a.id, a.loadout));
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < WORLD.playerRadius * 6, `spawned ${Math.hypot(a.x - b.x, a.y - b.y).toFixed(0)}px from the friend`);
});

test('leaving the match ends every friendship', () => {
  const w = emptyWorld();
  const a = spawnAt(w, 400, 400), b = spawnAt(w, 900, 400), c = spawnAt(w, 1400, 400);
  befriend(w, a.id, b.id);
  befriend(w, a.id, c.id);
  removePlayer(w, a.id);
  assert.deepEqual(friendsOf(w, b.id), []);
  assert.deepEqual(friendsOf(w, c.id), []);
  run(w, 100);
});

test('friend messages are checked on the way in', () => {
  assert.deepEqual(parseClientMsg(JSON.stringify({ t: 'friend', a: 'invite', id: 7 })), { t: 'friend', a: 'invite', id: 7 });
  assert.equal(parseClientMsg(JSON.stringify({ t: 'friend', a: 'hug', id: 7 })), null);
  assert.equal(parseClientMsg(JSON.stringify({ t: 'friend', a: 'accept', id: -1 })), null);
  assert.equal(parseClientMsg(JSON.stringify({ t: 'friend', a: 'remove', id: '7' })), null);
});

test('in a room: an invite reaches its player, accepting makes friends on one team, declining and leaving tell the other side', async () => {
  const { createRoom } = await import('../src/server/room.ts');
  const { fakeSocket, PISTOL } = await import('./helpers.ts');
  const accounts = { stats: () => null, nameForToken: () => null, credit: () => {} } as unknown as import('../src/server/accounts.ts').Accounts;
  const room = createRoom('tdm', 'TDM', 1, accounts);
  const a = fakeSocket(), b = fakeSocket(), c = fakeSocket();
  for (const s of [a, b, c]) room.connect(s.socket);
  a.send({ t: 'join', name: 'Ann', loadout: PISTOL, aspect: 1.5 });
  b.send({ t: 'join', name: 'Ben', loadout: PISTOL, aspect: 1.5 });
  c.send({ t: 'join', name: 'Cat', loadout: PISTOL, aspect: 1.5 });
  const idOf = (s: ReturnType<typeof fakeSocket>) => (s.sent.find((m) => m.t === 'welcome') as { id: number }).id;
  const ann = idOf(a), ben = idOf(b), cat = idOf(c);
  const pa = room.world.players.get(ann)!, pb = room.world.players.get(ben)!;
  assert.notEqual(pa.team, pb.team, 'the first two people start on opposite sides');

  const bot = [...room.world.players.values()].find((p) => p.kind === 'bot')!;
  a.send({ t: 'friend', a: 'invite', id: bot.id });
  assert.ok(a.sent.some((m) => m.t === 'friendNote' && m.text === 'Only players can be friends.'));

  a.send({ t: 'friend', a: 'invite', id: ben });
  assert.deepEqual(b.sent.find((m) => m.t === 'friendInvite'), { t: 'friendInvite', from: ann, name: 'Ann' });
  c.send({ t: 'friend', a: 'accept', id: ann });
  assert.ok(!areFriends(room.world, ann, cat), 'nobody accepts an invite that was not theirs');

  b.send({ t: 'friend', a: 'accept', id: ann });
  assert.ok(areFriends(room.world, ann, ben));
  assert.equal(pa.team, pb.team, 'friends play on one side');
  assert.deepEqual(a.sent.filter((m) => m.t === 'friends').at(-1), { t: 'friends', ids: [ben] });
  assert.deepEqual(b.sent.filter((m) => m.t === 'friends').at(-1), { t: 'friends', ids: [ann] });

  c.send({ t: 'friend', a: 'invite', id: ann });
  a.send({ t: 'friend', a: 'decline', id: cat });
  assert.ok(c.sent.some((m) => m.t === 'friendNote' && m.text === 'Ann declined your friend invite.'));

  b.close();
  assert.deepEqual(a.sent.filter((m) => m.t === 'friends').at(-1), { t: 'friends', ids: [] }, 'a friend who leaves is a friend no more');
  room.close();
  a.close();
  c.close();
});
