/// <reference types="node" />
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseServerMsg, routeServerMsg, SERVER_MSG_TYPES, type ServerMsgHandlers } from '../src/client/servermsg.ts';

/** Handlers that only note which one ran. */
function recording(): { seen: string[]; handlers: ServerMsgHandlers } {
  const seen: string[] = [];
  const note = (m: { t: string }) => { seen.push(m.t); };
  return { seen, handlers: { welcome: note, walls: note, snap: note, chat: note, emote: note, radio: note, badge: note, error: note, progress: note, equipped: note, friendInvite: note, friends: note, friendNote: note } };
}

test('every message type the page accepts off the socket has a handler, and nothing else does', () => {
  assert.deepEqual(Object.keys(recording().handlers).sort(), [...SERVER_MSG_TYPES].sort());
});

test('a progress message (the XP card, challenge toasts) and an equipped reply reach their handlers', () => {
  const { seen, handlers } = recording();
  const progress = parseServerMsg(JSON.stringify({ t: 'progress', xp: 120, level: 1, prestige: 0, xpInLevel: 120, xpToNext: 400, gained: [], levelUps: [], unlocks: [], challenges: [], equipped: {} }));
  const equipped = parseServerMsg(JSON.stringify({ t: 'equipped', equipped: {} }));
  assert.ok(progress && equipped);
  routeServerMsg(progress, handlers);
  routeServerMsg(equipped, handlers);
  assert.deepEqual(seen, ['progress', 'equipped']);
});

test('the socket parser drops what is not a known message', () => {
  assert.equal(parseServerMsg('{"t":"nope"}'), null);
  assert.equal(parseServerMsg('not json'), null);
  assert.equal(parseServerMsg(new ArrayBuffer(2)), null);
  assert.equal(parseServerMsg('null'), null);
  assert.equal(parseServerMsg('{"t":"toString"}'), null);
});
