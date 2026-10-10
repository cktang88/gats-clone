import { RING } from '../shared/defs.ts';
import { ringAt, type RoyaleResult, type RoyaleView, type Snapshot } from '../shared/protocol.ts';
import { clock } from './derive.ts';

type Point = { x: number; y: number };

/** The ring in the kit's hazard colours: a rust-red storm edged in signal orange, with the next circle dashed in bone. */
const RING_LOOK = { storm: '#7a2414', stormAlpha: 0.24, edge: '#ff5a1f', next: 'rgba(236, 230, 214, 0.85)', drop: '#ffc94a', muted: '#9a9ea6' } as const;
const KIT_FONT = '"Barlow Condensed", "Arial Narrow", system-ui, sans-serif';

export function ringLine(royale: Pick<RoyaleView, 'ring'>, serverNow: number): string {
  const { ring } = royale;
  if (ring.phase >= RING.length) return 'Final circle';
  if (serverNow < ring.shrinkAt) return `Ring closes in ${clock(ring.shrinkAt - serverNow)}`;
  return `Ring closing · ${clock(ring.closeAt - serverNow)}`;
}

export function ringPill(royale: Pick<RoyaleView, 'ring'>, serverNow: number): { label: string; time: string } {
  const { ring } = royale;
  if (ring.phase >= RING.length) return { label: 'FINAL', time: '' };
  const until = serverNow < ring.shrinkAt ? ring.shrinkAt : ring.closeAt;
  return { label: `RING ${ring.phase + 1}/${RING.length}`, time: clock(until - serverNow) };
}

export const resultTitle = (r: RoyaleResult) => (r.place === 1 ? '#1 · Last one standing' : `#${r.place} of ${r.of}`);

const nameOf = (snap: Snapshot, id: number | null) =>
  id === null ? null : snap.players.find((p) => p.id === id)?.name ?? snap.leaderboard.find((r) => r.id === id)?.name ?? null;

export function spectateLines(snap: Snapshot, royale: RoyaleView, serverNow: number): { title: string; sub: string } {
  const watched = nameOf(snap, royale.watch);
  const title = watched ? `Watching ${watched}` : 'Spectating';
  if (royale.redeployAt !== null) return { title, sub: `Redeploy in ${clock(royale.redeployAt - serverNow)}` };
  if (royale.result) return { title, sub: `You finished ${resultTitle(royale.result)}` };
  return { title, sub: 'No redeploys left · you drop in when the next match starts' };
}

/** The Last Standing kill-feed line for player `id` out for good in `place`. */
export const wipedLine = (f: { id: number; name: string; place: number }, myId: number) =>
  f.id === myId ? `You're out · #${f.place}` : `${f.name} is out · #${f.place}`;

/** The alive counter: `12 / 18 LEFT`. */
export const aliveLabel = (royale: Pick<RoyaleView, 'alive' | 'total'>) => `${royale.alive} / ${royale.total}`;

export function drawRingWorld(ctx: CanvasRenderingContext2D, royale: RoyaleView, serverNow: number, tl: Point, br: Point) {
  const c = ringAt(royale.ring, serverNow);
  ctx.save();
  ctx.beginPath();
  ctx.rect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
  ctx.arc(c.x, c.y, Math.max(0, c.r), 0, Math.PI * 2, true);
  ctx.globalAlpha = RING_LOOK.stormAlpha;
  ctx.fillStyle = RING_LOOK.storm;
  ctx.fill('evenodd');
  ctx.globalAlpha = 0.85;
  ctx.lineWidth = 6;
  ctx.strokeStyle = RING_LOOK.edge;
  ctx.beginPath();
  ctx.arc(c.x, c.y, Math.max(0, c.r), 0, Math.PI * 2);
  ctx.stroke();
  const next = royale.ring.to;
  if (royale.ring.phase < RING.length && next.r < c.r) {
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 3;
    ctx.setLineDash([24, 18]);
    ctx.strokeStyle = RING_LOOK.next;
    ctx.beginPath();
    ctx.arc(next.x, next.y, Math.max(1, next.r), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

export function drawDropsWorld(ctx: CanvasRenderingContext2D, royale: RoyaleView, serverNow: number, now: number, size: number) {
  for (const d of royale.drops) {
    ctx.save();
    ctx.strokeStyle = RING_LOOK.drop;
    if (d.landsAt > serverNow) {
      const pulse = 0.5 + 0.5 * Math.sin(now / 180);
      ctx.globalAlpha = 0.55 + 0.35 * pulse;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(d.x, d.y, size * (0.8 + 0.25 * pulse), 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 0.95;
      ctx.font = `800 26px ${KIT_FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = RING_LOOK.drop;
      ctx.fillText(String(Math.ceil((d.landsAt - serverNow) / 1000)), d.x, d.y);
    } else {
      ctx.lineWidth = 3;
      ctx.strokeRect(d.x - size / 2 - 4, d.y - size / 2 - 4, size + 8, size + 8);
    }
    ctx.restore();
  }
}

export function drawRingMap(ctx: CanvasRenderingContext2D, royale: RoyaleView, serverNow: number, now: number, x: number, y: number, k: number, size: number) {
  const c = ringAt(royale.ring, serverNow);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, size, size);
  ctx.clip();
  ctx.beginPath();
  ctx.rect(x, y, size, size);
  ctx.arc(x + c.x * k, y + c.y * k, Math.max(0, c.r * k), 0, Math.PI * 2, true);
  ctx.globalAlpha *= 0.45;
  ctx.fillStyle = RING_LOOK.storm;
  ctx.fill('evenodd');
  ctx.globalAlpha /= 0.45;
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = RING_LOOK.edge;
  ctx.beginPath();
  ctx.arc(x + c.x * k, y + c.y * k, Math.max(0, c.r * k), 0, Math.PI * 2);
  ctx.stroke();
  const next = royale.ring.to;
  if (royale.ring.phase < RING.length && next.r < c.r) {
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = RING_LOOK.next;
    ctx.beginPath();
    ctx.arc(x + next.x * k, y + next.y * k, Math.max(1.5, next.r * k), 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  for (const d of royale.drops) {
    const blink = d.landsAt > serverNow && Math.floor(now / 250) % 2 === 0;
    ctx.fillStyle = RING_LOOK.drop;
    ctx.globalAlpha = blink ? 0.4 : 1;
    ctx.fillRect(x + d.x * k - 3, y + d.y * k - 3, 6, 6);
  }
  ctx.restore();
}

export const ringMoved = (prev: RoyaleView | undefined, next: RoyaleView | undefined, prevAt: number, nextAt: number): boolean =>
  !!prev && !!next && prevAt < next.ring.shrinkAt && nextAt >= next.ring.shrinkAt && next.ring.phase < RING.length;

export function royaleCallouts(prev: RoyaleView | undefined, next: RoyaleView | undefined, prevAt: number, nextAt: number): { title: string; line: string }[] {
  const out: { title: string; line: string }[] = [];
  if (prev?.redeploys && next && !next.redeploys) out.push({ title: 'Last lives', line: 'No more redeploys. This life is your last.' });
  if (ringMoved(prev, next, prevAt, nextAt)) out.push({ title: 'The ring is moving', line: 'Get inside the dashed circle' });
  return out;
}
