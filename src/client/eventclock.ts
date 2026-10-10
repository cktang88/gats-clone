import { BUILDINGS, ZOMBIE_KINDS, ZOMBIES } from '../shared/defs.ts';
import { segmentEntersCircleAt } from '../shared/sim/movement.ts';
import { pelletOffset } from '../shared/sim/turrets.ts';
import type { GameEvent, Snapshot } from '../shared/protocol.ts';
import type { Effect } from './state.ts';

export type EffectSpec = Effect extends infer E ? (E extends Effect ? Omit<E, 'born'> : never) : never;
export type PendingEffect = { at: number; fx: EffectSpec };

function effectOf(ev: GameEvent, snap: Snapshot): EffectSpec | EffectSpec[] | null {
  switch (ev.e) {
    case 'impact': return { kind: 'impact', surface: 'wall', x: ev.x, y: ev.y, victim: null };
    // A target's hit puffs and wobble are targetart.ts's, timed on the same render clock.
    case 'target': return null;
    case 'dmg': return ev.kind === 'target' ? null : { kind: 'impact', surface: ev.kind, x: ev.x, y: ev.y, victim: ev.kind === 'player' || ev.kind === 'zombie' ? ev.victim : null, amount: ev.amount, ...(ev.push !== undefined && { push: ev.push }) };
    case 'boom': return { kind: 'boom', x: ev.x, y: ev.y, r: ev.r };
    case 'slash': return { kind: 'slash', x: ev.x, y: ev.y, angle: ev.angle };
    case 'zkill': return { kind: 'splat', x: ev.x, y: ev.y, zombie: ev.kind, by: ev.by };
    case 'turret': {
      const def = BUILDINGS[ev.kind].turret;
      if (ev.reach !== undefined) {
        const x = ev.x + Math.cos(ev.angle) * def.muzzle, y = ev.y + Math.sin(ev.angle) * def.muzzle;
        return { kind: 'tracer', turret: ev.kind, x, y, angle: ev.angle, reach: ev.reach };
      }
      return Array.from({ length: def.pellets }, (_, i) => {
        const angle = ev.angle + (def.pellets === 1 ? 0 : pelletOffset(i, def.pellets, def.spread));
        const x = ev.x + Math.cos(angle) * def.muzzle, y = ev.y + Math.sin(angle) * def.muzzle;
        const dx = Math.cos(angle) * def.range, dy = Math.sin(angle) * def.range;
        const hit = Math.min(1, ...(snap.zombies ?? []).map(([, k, zx, zy]) => segmentEntersCircleAt(x, y, dx, dy, zx, zy, ZOMBIES[ZOMBIE_KINDS[k]].radius) ?? 1));
        return { kind: 'tracer', turret: ev.kind, x, y, angle, reach: hit * def.range };
      });
    }
    case 'shot':
    case 'radar':
    case 'medal':
    case 'hunted':
    case 'life':
    case 'wiped':
    case 'loot':
    case 'tower':
    case 'airdrop':
    case 'gain':
    case 'prop':
    case 'pack': return null;
    case 'coil': return { kind: 'coil', x: ev.x, y: ev.y, p: ev.p };
    case 'aid': return { kind: 'aid', of: ev.kind, x: ev.x, y: ev.y };
    case 'kill': {
      const blow = snap.events.filter((d) => d.e === 'dmg' && d.kind === 'player' && d.victim === ev.victimId).at(-1);
      return blow?.e === 'dmg' ? { kind: 'death', x: blow.x, y: blow.y, victim: ev.victimId, by: ev.killerId, weapon: ev.weapon } : null;
    }
  }
}

/** Every effect waits for the render clock to reach its tick. Shots are left out, since main.ts draws them from the shooter's drawn muzzle. */
export function scheduleEffects(snap: Snapshot, serverMs: number): PendingEffect[] {
  return snap.events.flatMap((ev) => {
    const fx = effectOf(ev, snap);
    return (Array.isArray(fx) ? fx : fx ? [fx] : []).map((f) => ({ at: serverMs, fx: f }));
  });
}

export function releaseDue<T extends { at: number }>(queue: readonly T[], renderMs: number): { due: T[]; rest: T[] } {
  return { due: queue.filter((p) => p.at <= renderMs), rest: queue.filter((p) => p.at > renderMs) };
}
