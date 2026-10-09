import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MODE_IDS, WORLD } from '../src/shared/defs.ts';
import type { Accounts } from '../src/server/accounts.ts';
import { createRoom, type Room } from '../src/server/room.ts';
import { fakeSocket, PISTOL } from './helpers.ts';

const accounts = { stats: () => null, nameForToken: () => null, credit: () => {} } as unknown as Accounts;

function sidesWith(room: Room, humans: number) {
  const sockets = Array.from({ length: humans }, (_, i) => {
    const ws = fakeSocket();
    room.connect(ws.socket);
    ws.send({ t: 'join', name: `Human${i}`, loadout: PISTOL, aspect: 1.5 });
    return ws;
  });
  const ps = [...room.world.players.values()];
  for (const ws of sockets) ws.close();
  const tally = (team: 'red' | 'blue', kind?: 'human') => ps.filter((p) => p.team === team && (!kind || p.kind === kind)).length;
  return { redHumans: tally('red', 'human'), blueHumans: tally('blue', 'human'), red: tally('red'), blue: tally('blue') };
}

for (const mode of MODE_IDS.filter((m) => m === 'TDM' || m === 'DOM')) {
  test(`${mode}: two humans land on opposite teams`, () => {
    const s = sidesWith(createRoom('r', mode, 1, accounts), 2);
    assert.deepEqual({ red: s.redHumans, blue: s.blueHumans }, { red: 1, blue: 1 });
  });

  test(`${mode}: four humans split two and two, with the bots keeping the teams level`, () => {
    assert.deepEqual(sidesWith(createRoom('r', mode, 1, accounts), 4), { redHumans: 2, blueHumans: 2, red: WORLD.minPlayers / 2, blue: WORLD.minPlayers / 2 });
  });

  test(`${mode}: a side that loses its humans gets one bot for each human the other side has, until a human joins it`, () => {
    const room = createRoom('r', mode, 1, accounts);
    const sockets = new Map<string, ReturnType<typeof fakeSocket>>();
    const join = (name: string) => {
      const ws = fakeSocket();
      room.connect(ws.socket);
      ws.send({ t: 'join', name, loadout: PISTOL, aspect: 1.5 });
      sockets.set(name, ws);
    };
    // The room's heartbeat timers keep the test process alive until every socket closes, so close them even when an assertion fails.
    try {
      for (const name of ['Ann', 'Bo', 'Cy', 'Di']) join(name);
      assert.deepEqual(sides(room), { redHumans: 2, blueHumans: 2, redBots: 7, blueBots: 7 });
      for (const p of [...room.world.players.values()]) if (p.kind === 'human' && p.team === 'red') sockets.get(p.name)!.close();
      assert.deepEqual(sides(room), { redHumans: 0, blueHumans: 2, redBots: 9, blueBots: 7 }, 'red plays nine bots against two humans and seven bots');
      join('Eve');
      assert.deepEqual(sides(room), { redHumans: 1, blueHumans: 2, redBots: 8, blueBots: 7 }, 'the next human joins red and one of its bots leaves');
    } finally {
      for (const ws of sockets.values()) ws.close();
    }
  });
}

function sides(room: Room) {
  const ps = [...room.world.players.values()];
  const tally = (team: 'red' | 'blue', kind: 'human' | 'bot') => ps.filter((p) => p.team === team && p.kind === kind).length;
  return { redHumans: tally('red', 'human'), blueHumans: tally('blue', 'human'), redBots: tally('red', 'bot'), blueBots: tally('blue', 'bot') };
}
