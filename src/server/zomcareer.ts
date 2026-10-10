import type { ZomStat } from '../shared/defs.ts';
import type { GameEvent } from '../shared/protocol.ts';
import type { Run, World } from '../shared/sim/world.ts';

/**
 * Zombies lifetime-medal bookkeeping for one squad room: reads what each step of a run already says (its events, and the run's own
 * state) and turns it into each player's `ZOM_STATS` to add, by player id. The room keeps only the humans' (`profile` in room.ts drops
 * anyone without a seat's profile, so bots count for nothing) and never runs this in the range. Night-long stats (nights survived, the
 * furthest night, a flawless night, a won run) are the room's to pay at dawn and at the run's end, with its rule for who sat the night;
 * this keeps whether the core was hurt tonight for them.
 */
export type ZomDelta = Partial<Record<ZomStat, number>>;

/** Rounds fired and health mended come in a trickle: they are paid to the profile in lumps this big, and whatever is left when the phase turns (dusk, dawn, the end). */
export const ZOM_FLUSH = { rounds: 25, repaired: 250 } as const;

export type ZomWatch = {
  /** The run being watched; a new run starts everything afresh. */
  run: Run | null;
  /** True once the core has taken harm this night. */
  hurt: boolean;
  /** The core's harm and survivors as last seen, to tell a bite (any harm moves one or the other). */
  harm: number; survivors: number; phase: string;
  /** Each Colossus alive, by id, with the players who have landed a hit of their own on it. */
  colossi: Map<number, Set<number>>;
  /** Mended health already counted from `run.mended`, by player. */
  mendSeen: Map<number, number>;
  /** Rounds and mended health not yet paid, by player. */
  owed: Map<number, { rounds: number; repaired: number }>;
};

export const newZomWatch = (): ZomWatch => ({ run: null, hurt: false, harm: 0, survivors: 0, phase: '', colossi: new Map(), mendSeen: new Map(), owed: new Map() });

function add(out: Map<number, ZomDelta>, id: number, stat: ZomStat, n = 1) {
  let d = out.get(id);
  if (!d) out.set(id, (d = {}));
  d[stat] = (d[stat] ?? 0) + n;
}

function owedOf(z: ZomWatch, id: number) {
  let o = z.owed.get(id);
  if (!o) z.owed.set(id, (o = { rounds: 0, repaired: 0 }));
  return o;
}

/** Pays out what each player is owed, in whole rounds and whole health; `all` pays any amount, else only full lumps (`ZOM_FLUSH`). */
function settleOwed(z: ZomWatch, out: Map<number, ZomDelta>, all: boolean) {
  for (const [id, o] of z.owed) {
    if (o.rounds >= (all ? 1 : ZOM_FLUSH.rounds)) { add(out, id, 'rounds', o.rounds); o.rounds = 0; }
    const hp = Math.floor(o.repaired);
    if (hp >= (all ? 1 : ZOM_FLUSH.repaired)) { add(out, id, 'repaired', hp); o.repaired -= hp; }
  }
}

/**
 * One step of a zombies world, after `step`: returns each player's stats to add. `events` are the step's own. Zombie kills, revives,
 * rounds, Colossi and mending are counted here; the rest is the room's (see above).
 */
export function watchZombies(z: ZomWatch, w: World, events: readonly GameEvent[]): Map<number, ZomDelta> {
  const out = new Map<number, ZomDelta>();
  const run = w.run;
  if (!run) return out;
  if (run !== z.run) {
    z.run = run; z.hurt = false; z.colossi.clear(); z.mendSeen.clear();
    z.harm = run.harm; z.survivors = run.survivors; z.phase = run.phase.k;
  }
  const turned = z.phase !== run.phase.k;
  if (run.phase.k === 'night') {
    if (turned) z.hurt = false;
    else if (run.harm !== z.harm || run.survivors !== z.survivors) z.hurt = true;
  }
  z.harm = run.harm; z.survivors = run.survivors;
  z.phase = run.phase.k;
  for (const zb of w.zombies) if (zb.kind === 'colossus' && !z.colossi.has(zb.id)) z.colossi.set(zb.id, new Set());
  for (const e of events) {
    if (e.e === 'shot') owedOf(z, e.owner).rounds++;
    else if (e.e === 'dmg' && e.kind === 'zombie' && e.attacker !== null) z.colossi.get(e.victim)?.add(e.attacker);
    else if (e.e === 'life' && e.k === 'revived' && e.by !== null) add(out, e.by, 'revives');
  }
  for (const e of events) {
    if (e.e !== 'zkill') continue;
    if (e.by !== null) add(out, e.by, 'kills');
    if (e.kind !== 'colossus') continue;
    const hit = z.colossi.get(e.id) ?? new Set<number>();
    if (e.by !== null) hit.add(e.by);
    // Burnt at first light (no killer, no hit of anyone's in it) fells nothing.
    for (const id of hit) add(out, id, 'colossi');
    z.colossi.delete(e.id);
  }
  for (const [id, hp] of run.mended ?? []) {
    const fresh = hp - (z.mendSeen.get(id) ?? 0);
    if (fresh > 0) { owedOf(z, id).repaired += fresh; z.mendSeen.set(id, hp); }
  }
  settleOwed(z, out, turned);
  return out;
}

/** What a leaving player is still owed, paid at once and forgotten. */
export function settleLeaver(z: ZomWatch, id: number): ZomDelta | null {
  const o = z.owed.get(id);
  z.owed.delete(id);
  if (!o) return null;
  const d: ZomDelta = {};
  if (o.rounds >= 1) d.rounds = o.rounds;
  if (o.repaired >= 1) d.repaired = Math.floor(o.repaired);
  return Object.keys(d).length ? d : null;
}
