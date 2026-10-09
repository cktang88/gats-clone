import { WORLD, ZOM, ZOMBIES } from '../defs.ts';
import { damagePlayer } from './combat.ts';
import { clamp, decayKnock, dist2, rectsOverlap, segmentBlocked, slide, type Rect } from './movement.ts';
import { aiOf, BOID, buildGrid, LURE, personality, steer, type ZAi } from './boids.ts';
import { MAPS } from '../maps.ts';
import { cellRect } from './build.ts';
import { coreRect, coverRects, solidRects, type Building, type Player, type Run, type World, type Zombie } from './world.ts';

const UNREACHABLE = 0xffff;
const ORTH = 10, DIAG = 14;
const WALL_COST = ZOM.wallCostCells * ORTH;
const NEIGHBORS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const;

const cellAt = (x: number, y: number, grid: number) =>
  clamp(Math.floor(y / ZOM.cell), 0, grid - 1) * grid + clamp(Math.floor(x / ZOM.cell), 0, grid - 1);

function cellsUnder(r: Rect, grid: number, mark: (c: number) => void) {
  const x0 = Math.max(0, Math.floor(r.x / ZOM.cell)), x1 = Math.min(grid - 1, Math.ceil((r.x + r.w) / ZOM.cell) - 1);
  const y0 = Math.max(0, Math.floor(r.y / ZOM.cell)), y1 = Math.min(grid - 1, Math.ceil((r.y + r.h) / ZOM.cell) - 1);
  for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) if (rectsOverlap(r, cellRect(cx, cy))) mark(cy * grid + cx);
}

/**
 * Each cell's cost to reach the core, by Dijkstra out from the core's cells. Cover is impassable; a squad wall costs `ZOM.wallCostCells` steps
 * to walk into, so the horde takes any open way round and chews through a wall only when the core is walled in.
 * A diagonal step needs both cells it cuts past to be open, so a zombie never clips a corner.
 */
function buildFlow(w: World, core: Rect, grid: number): Uint16Array {
  const blocked = new Uint8Array(grid * grid);
  for (const r of coverRects(w)) cellsUnder(r, grid, (c) => { blocked[c] = 1; });
  const walled = new Uint8Array(grid * grid);
  for (const b of w.buildings) walled[b.cy * grid + b.cx] = 1;
  const cost = new Uint16Array(grid * grid).fill(UNREACHABLE);
  const heap: number[] = [];
  const push = (c: number) => {
    heap.push(c);
    for (let i = heap.length - 1; i > 0;) {
      const up = (i - 1) >> 1;
      if (cost[heap[up]!]! <= cost[c]!) break;
      heap[i] = heap[up]!;
      heap[up] = c;
      i = up;
    }
  };
  const pop = (): number => {
    const top = heap[0]!, last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && cost[heap[l]!]! < cost[heap[m]!]!) m = l;
        if (r < heap.length && cost[heap[r]!]! < cost[heap[m]!]!) m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m]!, heap[i]!];
        i = m;
      }
    }
    return top;
  };
  cellsUnder(core, grid, (c) => { cost[c] = 0; push(c); });
  const done = new Uint8Array(grid * grid);
  while (heap.length > 0) {
    const b = pop();
    if (done[b]) continue;
    done[b] = 1;
    const bx = b % grid, by = (b - bx) / grid;
    const enter = cost[b]! + (walled[b] ? WALL_COST : 0);
    for (const [dx, dy] of NEIGHBORS) {
      const ax = bx + dx, ay = by + dy;
      if (ax < 0 || ay < 0 || ax >= grid || ay >= grid) continue;
      const a = ay * grid + ax;
      if (blocked[a] || done[a]) continue;
      const diagonal = dx !== 0 && dy !== 0;
      if (diagonal && !(open(ax, by) && open(bx, ay))) continue;
      const next = Math.min(UNREACHABLE - 1, enter + (diagonal ? DIAG : ORTH));
      if (next < cost[a]!) { cost[a] = next; push(a); }
    }
  }
  return cost;

  function open(cx: number, cy: number) {
    const c = cy * grid + cx;
    return !blocked[c] && !walled[c];
  }
}

function flowFor(w: World, run: Run, core: Rect, grid: number): Uint16Array {
  const f = run.flow;
  if (f && f.wallsVersion === w.wallsVersion && f.buildingsVersion === w.buildingsVersion) return f.cost;
  run.flow = { wallsVersion: w.wallsVersion, buildingsVersion: w.buildingsVersion, cost: buildFlow(w, core, grid) };
  return run.flow.cost;
}

/** The neighboring cell one step closer to the core, or null when the zombie's cell has no way there. A cell's flow cost leaves out walking into it, so a wall's is added here. */
function nextCell(flow: Uint16Array, c: number, walled: (c: number) => boolean, grid: number): number | null {
  const isOpen = (n: number) => flow[n]! < UNREACHABLE && !walled(n);
  const cx = c % grid, cy = (c - cx) / grid;
  let best: number | null = null, bestCost = UNREACHABLE;
  for (const [dx, dy] of NEIGHBORS) {
    const nx = cx + dx, ny = cy + dy;
    if (nx < 0 || ny < 0 || nx >= grid || ny >= grid) continue;
    const n = ny * grid + nx;
    const diagonal = dx !== 0 && dy !== 0;
    if (diagonal && !(isOpen(ny * grid + cx) && isOpen(cy * grid + nx))) continue;
    const cost = flow[n]! + (diagonal ? DIAG : ORTH) + (walled(n) ? WALL_COST : 0);
    if (flow[n]! < UNREACHABLE && cost < bestCost) { best = n; bestCost = cost; }
  }
  return best;
}

export const distToRect = (x: number, y: number, r: Rect) => Math.sqrt(dist2(x, y, clamp(x, r.x, r.x + r.w), clamp(y, r.y, r.y + r.h)));

export function hurtCore(run: Run, amount: number) {
  run.core.hp = Math.max(0, run.core.hp - amount);
  run.harm += amount;
  const lost = Math.min(run.survivors, Math.floor(run.harm / ZOM.survivorHp));
  run.harm -= lost * ZOM.survivorHp;
  run.survivors -= lost;
  run.lost += lost;
}

export function biteBuilding(w: World, b: Building, amount: number) {
  if (b.hp <= 0) return;
  b.hp -= amount;
  w.events.push({ e: 'dmg', attacker: null, victim: b.id, amount: Math.round(amount * 10) / 10, x: (b.cx + 0.5) * ZOM.cell, y: (b.cy + 0.5) * ZOM.cell, kind: 'building' });
  if (b.hp > 0) return;
  w.buildings = w.buildings.filter((o) => o !== b);
  w.buildingsVersion++;
  w.events.push({ e: 'boom', x: (b.cx + 0.5) * ZOM.cell, y: (b.cy + 0.5) * ZOM.cell, r: ZOM.cell / 2 });
}

/** A player this near pulls at full strength; the pull then falls off to nothing at the kind's range. */
const NEAR = 110;
/** What the core is worth against a player's pull, and the extra a zombie already after someone gives them, so it does not flip between two. */
const CORE_BIAS = 0.35, STICKY = 0.2, SWITCH_MARGIN = 0.25;
const HOLD_MS = 1200, LOS_GRACE_MS = 600, COOL_MS = 3000;
/**
 * Within this of the core, a zombie heads for its own slot round it instead of the flow's next cell (and a player's pull is eased). Off at 0: with 300 the squad win rate
 * fell from about 11 of 16 seeds to 7, as a fanned arrival lets more of the horde bite at once, so separation alone spreads the arrival.
 */
const RING_NEAR = 0;

const hasLine = (solids: readonly Rect[], ax: number, ay: number, bx: number, by: number) => !segmentBlocked(solids, ax, ay, bx - ax, by - ay);

/**
 * Weighs the core against each squad player in sight: a player's pull is the kind's lure at its range, full inside `NEAR` and fading to nothing, against a fixed
 * pull for the core. Whoever it already follows is sticky and a chase ends when the player is gone, lost behind cover or has led the zombie past its leash.
 */
function choosePrey(w: World, z: Zombie, ai: ZAi, solids: readonly Rect[], core: Rect): Player | null {
  const now = w.now, lure = LURE[z.kind], me = personality(z.id);
  const cur = ai.tgt === 'player' ? w.players.get(ai.pid) : undefined;
  if (cur && Math.hypot(z.x - ai.ox, z.y - ai.oy) > lure.leash) { ai.tgt = 'core'; ai.coolUntil = now + COOL_MS; return null; }
  if (now < ai.coolUntil) return null;
  const nearCore = distToRect(z.x, z.y, core) < RING_NEAR * 0.8 ? 0.6 : 1;
  let best: Player | null = null, bestScore = CORE_BIAS, curScore = -1;
  for (const p of w.players.values()) {
    if (p.life.k !== 'alive') continue;
    const d = Math.hypot(p.x - z.x, p.y - z.y);
    if (d > lure.range) continue;
    const mine = p === cur;
    const score = lure.lure * me.lure * nearCore * (d <= NEAR ? 1 : (lure.range - d) / (lure.range - NEAR)) + (mine ? STICKY : 0);
    if (score <= CORE_BIAS || !hasLine(solids, z.x, z.y, p.x, p.y)) continue;
    if (mine) curScore = score;
    if (score > bestScore) { best = p; bestScore = score; }
  }
  if (cur && curScore > 0) {
    ai.seenAt = now;
    return best && best !== cur && now >= ai.holdUntil && bestScore > curScore + SWITCH_MARGIN ? begin(best) : cur;
  }
  if (cur && now - ai.seenAt <= LOS_GRACE_MS && cur.life.k === 'alive') return cur;
  return best ? begin(best) : null;

  function begin(p: Player) {
    ai.holdUntil = now + HOLD_MS;
    ai.seenAt = now;
    ai.ox = z.x;
    ai.oy = z.y;
    return p;
  }
}

const open = (flow: Uint16Array, c: number, walled: (c: number) => boolean) => flow[c]! < UNREACHABLE && !walled(c);

/** Each zombie bites what it is after (a squad player, else the core once in reach, else the wall in its way) and steers as a boid: toward its goal, clear of the rest of the horde and of cover. */
export function tickHorde(w: World, run: Run, dtMs: number) {
  const core = coreRect(w);
  if (!core) return;
  const size = MAPS[w.map].size, grid = size / ZOM.cell;
  const flow = flowFor(w, run, core, grid);
  const solids = solidRects(w);
  const sight = solids.filter((s) => s !== core);
  const wallAt = new Map(w.buildings.map((b) => [b.cy * grid + b.cx, b]));
  const walled = (c: number) => wallAt.has(c);
  const mul = ZOM.nightMul(run.night);
  const g = buildGrid(w.zombies, size);
  const dt = dtMs / 1000;
  const ccx = core.x + core.w / 2, ccy = core.y + core.h / 2;
  const avoid: Rect[] = [];
  for (let i = 0; i < w.zombies.length; i++) {
    const z = w.zombies[i]!;
    const def = ZOMBIES[z.kind], me = personality(z.id), ai = aiOf(z, w.now);
    const reach = def.radius + ZOM.biteReach;
    const damage = def.damage * mul.damage;
    let goal: { x: number; y: number } | null = null;
    let bite: (() => void) | null = null;
    let wall: Building | undefined;
    if (w.now >= ai.evalAt || (ai.tgt === 'player' && w.players.get(ai.pid)?.life.k !== 'alive')) {
      ai.evalAt = w.now + 180 + me.phase * 20;
      const chosen = choosePrey(w, z, ai, sight, core);
      ai.tgt = chosen ? 'player' : 'core';
      ai.pid = chosen ? chosen.id : 0;
    }
    const prey = ai.tgt === 'player' ? w.players.get(ai.pid) : undefined;
    const near = prey;
    if (near && Math.hypot(near.x - z.x, near.y - z.y) <= reach + WORLD.playerRadius) {
      bite = () => damagePlayer(w, near, damage, { attacker: null, team: null, label: def.name, piercing: false, via: 'bite', fromX: z.x, fromY: z.y });
    } else if (prey) goal = prey;
    else if (distToRect(z.x, z.y, core) <= reach) bite = () => hurtCore(run, damage * (1 - ZOM.coreArmor));
    else goal = pathGoal();
    if (bite && w.now >= z.attackAt) {
      bite();
      z.attackAt = w.now + def.attackMs;
    }
    let sx = 0, sy = 0;
    if (goal) {
      const d = Math.hypot(goal.x - z.x, goal.y - z.y);
      if (d > 1) { sx = (goal.x - z.x) / d; sy = (goal.y - z.y) / d; }
    }
    avoid.length = 0;
    const zc = cellAt(z.x, z.y, grid), zx = zc % grid, zy = (zc - zx) / grid;
    for (const [ox, oy] of NEIGHBORS) {
      const nx = zx + ox, ny = zy + oy;
      if (nx < 0 || ny < 0 || nx >= grid || ny >= grid) continue;
      const n = ny * grid + nx;
      if (wall && wallAt.get(n) === wall) continue;
      if (flow[n]! >= UNREACHABLE || walled(n)) avoid.push(cellRect(nx, ny));
    }
    const s = steer(g, i, w.now, sx, sy, avoid);
    const top = def.speed * me.speed * mul.speed;
    // A zombie that has not moved yet takes up its heading at once, so a fresh one walks in at full pace.
    const k = ai.hx === 0 && ai.hy === 0 ? 1 : Math.min(1, dt * BOID.turn);
    ai.hx += (s.wx * top - ai.hx) * k;
    ai.hy += (s.wy * top - ai.hy) * k;
    let dx = ai.hx * dt + s.px, dy = ai.hy * dt + s.py;
    if (z.knock) { dx += (z.knock.vx * dtMs) / 1000; dy += (z.knock.vy * dtMs) / 1000; z.knock = decayKnock(z.knock, dtMs); }
    const at = dx === 0 && dy === 0 ? z : slide(solids, z.x, z.y, dx, dy, def.radius, size);
    z.vx = ((at.x - z.x) * 1000) / dtMs;
    z.vy = ((at.y - z.y) * 1000) / dtMs;
    z.x = at.x;
    z.y = at.y;

    /** Whether any of the eight cells round it is cover or a wall, where a sidelong lane would only press it into a corner. */
    function hugging() {
      const zc = cellAt(z.x, z.y, grid), zx = zc % grid, zy = (zc - zx) / grid;
      for (const [ox, oy] of NEIGHBORS) {
        const nx = zx + ox, ny = zy + oy;
        if (nx >= 0 && ny >= 0 && nx < grid && ny < grid && (flow[ny * grid + nx]! >= UNREACHABLE || walled(ny * grid + nx))) return true;
      }
      return false;
    }

    /** Where to head with no one to chase: its slot round the core when near, else the flow's next cell, a wall in the way being bitten. */
    function pathGoal(): { x: number; y: number } | null {
      const cx = ccx, cy = ccy;
      if (distToRect(z.x, z.y, core!) < RING_NEAR) {
        if (ai.ring === null) ai.ring = Math.atan2(z.y - cy, z.x - cx) + me.ring * RING_SPREAD;
        if (w.now >= ai.ringOkAt) {
          ai.ringOkAt = w.now + 250 + me.phase * 20;
          const slot = ringSlot(core!, ai.ring, def.radius);
          ai.ringOk = hasLine(sight, z.x, z.y, slot.x, slot.y);
        }
        if (ai.ringOk) return ringSlot(core!, ai.ring, def.radius);
      }
      const next = nextCell(flow, cellAt(z.x, z.y, grid), walled, grid);
      wall = next === null ? undefined : wallAt.get(next);
      ai.tgt = wall ? 'wall' : 'core';
      if (wall) {
        if (distToRect(z.x, z.y, cellRect(wall.cx, wall.cy)) <= reach) { const b = wall; bite = () => biteBuilding(w, b, damage * def.buildingDamageMul); return null; }
      }
      if (next === null) {
        // Standing in a cell cover clips: head for the cheapest open cell within two of it, else straight on.
        const x0 = Math.floor(z.x / ZOM.cell), y0 = Math.floor(z.y / ZOM.cell);
        let at = -1, cost = UNREACHABLE;
        for (let ny = Math.max(0, y0 - 2); ny <= Math.min(grid - 1, y0 + 2); ny++) {
          for (let nx = Math.max(0, x0 - 2); nx <= Math.min(grid - 1, x0 + 2); nx++) {
            const c = ny * grid + nx;
            if (flow[c]! < cost && !walled(c)) { cost = flow[c]!; at = c; }
          }
        }
        return at < 0 ? { x: cx, y: cy } : { x: ((at % grid) + 0.5) * ZOM.cell, y: (Math.floor(at / grid) + 0.5) * ZOM.cell };
      }
      const gx = ((next % grid) + 0.5) * ZOM.cell, gy = (Math.floor(next / grid) + 0.5) * ZOM.cell;
      if (wall) return { x: gx, y: gy };
      // Each walks a little to one side of the flow's line, more the farther from the core, so a horde fans into a wide front.
      const d = Math.hypot(gx - z.x, gy - z.y) || 1;
      if (hugging()) return { x: gx, y: gy };
      const off = me.lat * Math.min(BOID.lateral * 3, BOID.lateral * 0.5 + Math.hypot(z.x - cx, z.y - cy) * 0.05);
      const ox = gx - (gy - z.y) / d * off, oy = gy + (gx - z.x) / d * off;
      return open(flow, cellAt(ox, oy, grid), walled) ? { x: ox, y: oy } : { x: gx, y: gy };
    }
  }
}

/** How far to either side of the way it came in a zombie's slot round the core may fall, in radians. */
const RING_SPREAD = 0.6;

/** Where a body of this radius stands against the core's edge along the ray from its center at `angle`. */
function ringSlot(core: Rect, angle: number, r: number) {
  const hw = core.w / 2 + r + ZOM.biteReach * 0.4, hh = core.h / 2 + r + ZOM.biteReach * 0.4;
  const c = Math.cos(angle), s = Math.sin(angle);
  const t = Math.min(c === 0 ? Infinity : hw / Math.abs(c), s === 0 ? Infinity : hh / Math.abs(s));
  return { x: core.x + core.w / 2 + c * t, y: core.y + core.h / 2 + s * t };
}
