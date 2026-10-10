import { ZOM } from '../defs.ts';
import { dist2 } from './movement.ts';
import { freshLife } from './stats.ts';
import { sameTeam, type Player, type World } from './world.ts';

export function goDown(w: World, p: Player, hp = 0) {
  const armor = p.life.k === 'alive' ? p.life.armor : 0;
  p.life = { k: 'downed', bleedOutAt: w.now + ZOM.bleedOutMs, reviveProgress: 0, hp, armor };
  w.events.push({ e: 'life', id: p.id, name: p.name, k: 'downed', by: null });
}

export function tickDowned(w: World, p: Player, dtMs: number, revivers: Set<Player>): Player | 'bledOut' | null {
  const life = p.life;
  if (life.k !== 'downed') return null;
  if (w.now >= life.bleedOutAt) {
    w.events.push({ e: 'life', id: p.id, name: p.name, k: 'bledOut', by: null });
    return 'bledOut';
  }
  const reviver = [...w.players.values()].find((o) => o.life.k === 'alive' && o.input.use && sameTeam(o, p) && dist2(o.x, o.y, p.x, p.y) <= ZOM.reviveRange ** 2);
  if (!reviver) { life.reviveProgress = 0; return null; }
  revivers.add(reviver);
  life.reviveProgress += dtMs;
  if (life.reviveProgress < ZOM.reviveMs) return null;
  const revived = freshLife(p, w.now);
  revived.hp *= ZOM.reviveHpFrac;
  revived.armor = Math.min(revived.armor, life.armor ?? revived.armor);
  revived.lastDamageAt = w.now;
  revived.shieldUntil = -Infinity;
  p.life = revived;
  w.events.push({ e: 'life', id: p.id, name: p.name, k: 'revived', by: reviver.id });
  return reviver;
}
