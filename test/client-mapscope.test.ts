import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enterMap, onMapChange } from '../src/client/mapscope.ts';

test("a map's art caches are let go when the room moves to another map, and only then", () => {
  let released = 0;
  onMapChange(() => { released++; });
  enterMap('quarry');
  assert.equal(released, 0, 'the first map has nothing to let go');
  enterMap('quarry');
  assert.equal(released, 0, 'a reconnect or a walls update on the same map keeps them');
  enterMap('causeway');
  assert.equal(released, 1);
  enterMap('wasteland');
  assert.equal(released, 2);
});
