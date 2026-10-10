import assert from 'node:assert/strict';
import { test } from 'node:test';
import { drawZombieCorpses, ZOMBIE_CORPSE, type ZombieCorpse } from '../src/client/corpses.ts';

function fakeCtx() {
  const ctx: CanvasRenderingContext2D = new Proxy({} as Record<string, unknown>, {
    get: (_, name: string) => {
      if (name === 'canvas') return { width: 64, height: 64 };
      if (name === 'getTransform') return () => ({ a: 1 });
      return () => ({ addColorStop() {} });
    },
    set: () => true,
  }) as unknown as CanvasRenderingContext2D;
  Object.assign(globalThis, { document: { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) } });
  return ctx;
}

test('a fading zombie corpse draws once, even where born + lifeMs - lifeMs rounds above born', () => {
  // On a fractional clock such a `born` once sent the fading corpse back through the split forever, until the stack ran out.
  const rounds = (b: number) => b + ZOMBIE_CORPSE.lifeMs - ZOMBIE_CORPSE.lifeMs > b;
  let born = 0;
  for (let i = 1; i < 1e6 && !rounds(born); i++) born = 1000 + i * 0.37;
  assert.ok(rounds(born), 'found a born that rounds');
  const corpse: ZombieCorpse = { id: 1, x: 10, y: 10, kind: 'walker', born, blow: null };
  const fresh: ZombieCorpse = { ...corpse, id: 2, born: born + ZOMBIE_CORPSE.lifeMs };
  assert.doesNotThrow(() => drawZombieCorpses(fakeCtx(), [corpse, fresh], 1, born + ZOMBIE_CORPSE.lifeMs + ZOMBIE_CORPSE.fadeMs / 2));
});
