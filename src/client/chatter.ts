import { GUNS } from '../shared/defs.ts';
import type { GameEvent, PlayerView, Snapshot } from '../shared/protocol.ts';
import { PERSONALITY_IDS, personalityById, type PersonalityId, type Tag } from './chatterlines.ts';
import { clipped, outlined, popScale } from './emotefx.ts';
import { TICK_MS } from './interp.ts';
import { INK, NIGHT } from './palette.ts';

/**
 * Soldier chatter: little speech bubbles with a personality, said when nothing is going on. All of it is local to the drawing
 * client; the simulation never hears of it. Each soldier gets a personality per life from a hash of their id and their death count
 * (both on every client's snapshots), so everybody sees the same voice. Rules for when to speak live in `Chatter.tick`.
 */

const R = 24;
const BONE = '#ece6d6';
const PLATE = '#3d4450';
const PLATE_LIT = '#566070';
const ORANGE = '#ff5a1f';
const FONT_PX = 15;
const FONT = `800 ${FONT_PX}px "Barlow Condensed", "Arial Narrow", system-ui, sans-serif`;

export const CHATTER = {
  quietAfterShotMs: 4000,
  enemyRange: 650,
  cooldownMs: [14_000, 30_000] as const,
  ownCooldownMs: [10_000, 22_000] as const,
  /** Delay before a fresh life's first line; `spawnMs` is how long the spawn tag stays fresh. */
  firstMs: [2000, 22_000] as const,
  ownFirstMs: [1500, 6000] as const,
  spawnFreshMs: 10_000,
  maxBubbles: 2,
  holdMs: [2800, 4000] as const,
  fadeMs: 400,
  globalRepeatMs: 120_000,
  contextChance: 0.5,
  eventChance: 0.7,
  idleStillMs: 8000,
  lowHp: 0.35,
  closeCallHp: 0.25,
  streak: 3,
  quickDeathMs: 25_000,
  eventFreshMs: 9000,
  roundEndMs: 30_000,
  barrelRange: 220,
  hearRange: 900,
  wrapPx: 190,
} as const;

/** Tags that come from something that just happened (they fade) rather than a state of the world. */
const EVENT_TAGS: ReadonlySet<Tag> = new Set<Tag>(['justSpawned', 'justKilled', 'closeCall', 'respawned', 'wonRound', 'lostRound']);

const mix = (a: number, b: number): number => {
  let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 0x7f4a7c15, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
};

/** Who a soldier is this life: the same answer on every client for the same player id and death count. */
export const personalityFor = (playerId: number, life: number): PersonalityId => PERSONALITY_IDS[mix(playerId * 31 + 7, life) % PERSONALITY_IDS.length]!;

const mulberry = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// ---- the persisted switch ----

const KEY = 'skirmish.chatter';
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* the setting lasts this tab only */ } },
};
let enabled = store.get(KEY) !== '0';
export const chatterOn = () => enabled;
export const setChatterOn = (on: boolean) => { enabled = on; store.set(KEY, on ? '1' : '0'); };
/** The key's toggle (C). Returns whether chatter is now on. */
export const toggleChatter = (): boolean => { setChatterOn(!enabled); return enabled; };

// ---- state ----

type Soldier = {
  id: number; life: number; personality: PersonalityId; alive: boolean; bornAt: number; nextAt: number; said: Set<string>;
  x: number; y: number; stillSince: number; lowAt: number | null; closeCallAt: number; killAt: number;
  /** The previous life ended inside `quickDeathMs`. */
  quickDeath: boolean; endedAt: number | null;
};

export type Bubble = { pid: number; text: string; at: number; holdMs: number; own: boolean; tag: Tag | null; lines?: string[]; w?: number };

export type TickOpts = {
  /** Anything that makes chatter wrong now: the killcam, slow-motion, the celebration. */
  overlay?: boolean;
  /** Whether a soldier is showing an emote. */
  emoting?: (pid: number) => boolean;
};

export const holdFor = (text: string): number => Math.min(CHATTER.holdMs[1], Math.max(CHATTER.holdMs[0], 2200 + text.length * 40));

/** A soldier's context tags that are fresh now, from what the client has tracked and the snapshot's world. */
export type TagCtx = { now: number; snap: Snapshot; p: PlayerView };

export class Chatter {
  readonly soldiers = new Map<number, Soldier>();
  bubbles: Bubble[] = [];
  private shotAt = new Map<number, number>();
  private said = new Map<string, number>();
  private airdropAt = -Infinity;
  private coreHp: number | null = null;
  private coreHitAt = -Infinity;
  private selfAmmo: number | null = null;
  private pendingResult: Map<number, boolean> | null = null;
  private roundResult = new Map<number, { won: boolean; at: number }>();
  private hadWinner = false;
  private zombieDay = false;
  readonly rng: () => number;

  constructor(seed = (Date.now() ^ 0x5bd1e995) >>> 0) { this.rng = mulberry(seed); }

  private between(range: readonly [number, number]) { return range[0] + this.rng() * (range[1] - range[0]); }

  reset() {
    this.soldiers.clear(); this.bubbles = []; this.shotAt.clear(); this.said.clear(); this.airdropAt = -Infinity; this.coreHp = null;
    this.coreHitAt = -Infinity; this.selfAmmo = null; this.pendingResult = null; this.roundResult.clear(); this.hadWinner = false;
  }

  /** Takes a raw snapshot: spawns and deaths, kills, shots, hurt, the world's events. */
  onSnap(snap: Snapshot, myId: number, now: number) {
    const deaths = new Map(snap.leaderboard.map((r) => [r.id, r.deaths]));
    deaths.set(myId, snap.self.deaths);
    const serverT = snap.tick * TICK_MS;
    for (const p of snap.players) {
      let s = this.soldiers.get(p.id);
      if (!p.alive) {
        if (s?.alive) { s.alive = false; s.endedAt = now; }
        continue;
      }
      const life = deaths.get(p.id) ?? s?.life ?? 0;
      if (!s || !s.alive || s.life !== life) s = this.born(p, life, now, s ?? null, myId);
      const frac = p.hp / Math.max(1, p.maxHp);
      if (frac < CHATTER.closeCallHp) s.lowAt = now;
      else if (s.lowAt !== null && frac >= 0.4) { s.closeCallAt = now; s.lowAt = null; }
      if (Math.hypot(p.x - s.x, p.y - s.y) > 6) { s.x = p.x; s.y = p.y; s.stillSince = now; }
    }
    if (this.selfAmmo !== null && snap.self.ammo < this.selfAmmo) this.shotAt.set(myId, now);
    this.selfAmmo = snap.self.ammo;
    for (const ev of snap.events) this.onEvent(ev, now);
    if (snap.airdrop && serverT < snap.airdrop.landAt - 2000 && now - this.airdropAt > 20_000) this.airdropAt = now - 5000;
    const core = snap.run?.core.hp ?? null;
    if (core !== null && this.coreHp !== null && core < this.coreHp) this.coreHitAt = now;
    this.coreHp = core;
    this.zombieDay = snap.run?.phase === 'day';
    this.roundOutcome(snap, now);
  }

  private born(p: PlayerView, life: number, now: number, prev: Soldier | null, myId: number): Soldier {
    const fresh = !!p.spawnShield || !!prev;
    const quick = !!prev && prev.endedAt !== null && prev.endedAt - prev.bornAt < CHATTER.quickDeathMs;
    const s: Soldier = {
      id: p.id, life, personality: personalityFor(p.id, life), alive: true, bornAt: fresh ? now : now - 120_000,
      nextAt: now + this.between(p.id === myId ? CHATTER.ownFirstMs : CHATTER.firstMs), said: new Set(),
      x: p.x, y: p.y, stillSince: now, lowAt: null, closeCallAt: -Infinity, killAt: -Infinity, quickDeath: quick, endedAt: null,
    };
    this.soldiers.set(p.id, s);
    return s;
  }

  private onEvent(ev: GameEvent, now: number) {
    switch (ev.e) {
      case 'shot': case 'slash': this.shotAt.set(ev.owner, now); break;
      case 'kill': if (ev.killerId !== null) { const s = this.soldiers.get(ev.killerId); if (s) s.killAt = now; } break;
      case 'zkill': if (ev.by !== null) { const s = this.soldiers.get(ev.by); if (s) s.killAt = now; } break;
      case 'airdrop': if (ev.k === 'inbound') this.airdropAt = now; break;
    }
  }

  private roundOutcome(snap: Snapshot, now: number) {
    const w = snap.match.winner;
    if (w && !this.hadWinner) {
      this.pendingResult = new Map(snap.players.map((p) => [p.id, w.id !== null ? w.id === p.id : !!p.team && w.name.toLowerCase().includes(p.team)]));
    } else if (!w && this.hadWinner && this.pendingResult) {
      for (const [id, won] of this.pendingResult) this.roundResult.set(id, { won, at: now });
      this.pendingResult = null;
    }
    this.hadWinner = !!w;
  }

  /** The tags that are fresh for soldier `p` right now, in no particular order. */
  tagsOf(p: PlayerView, snap: Snapshot, now: number): Tag[] {
    const s = this.soldiers.get(p.id);
    if (!s?.alive) return [];
    const out: Tag[] = [];
    const frac = p.hp / Math.max(1, p.maxHp);
    const streak = p.id === snap.self.id ? snap.self.streak : p.streak ?? 0;
    if (now - s.bornAt < CHATTER.spawnFreshMs) out.push(s.quickDeath ? 'respawned' : 'justSpawned');
    if (now - s.killAt < CHATTER.eventFreshMs) out.push('justKilled');
    if (now - s.closeCallAt < CHATTER.eventFreshMs + 3000) out.push('closeCall');
    if (streak >= CHATTER.streak) out.push('onStreak');
    if (frac < CHATTER.lowHp) out.push('lowHealth');
    if (now - s.stillSince >= CHATTER.idleStillMs) out.push('longIdle');
    if (p.hunted || GUNS[p.gun].stage === 2) out.push('hunted');
    if (p.golden) out.push('goldenGun');
    if (snap.barrels?.some(([, bx, by]) => Math.hypot(bx - p.x, by - p.y) < CHATTER.barrelRange)) out.push('nearBarrel');
    if (now - this.airdropAt < 25_000) out.push('airdropInbound');
    if (snap.run?.phase === 'day') out.push('zombiesDay');
    if (snap.run?.phase === 'night') out.push('zombiesNight');
    if (snap.run && (now - this.coreHitAt < 10_000)) out.push('coreDamaged');
    const endsAt = snap.match.roundEndsAt;
    if (endsAt !== null && !snap.run && endsAt - snap.tick * TICK_MS < CHATTER.roundEndMs && endsAt > snap.tick * TICK_MS) out.push('roundEndingSoon');
    const r = this.roundResult.get(p.id);
    if (r && now - r.at < 25_000) out.push(r.won ? 'wonRound' : 'lostRound');
    return out;
  }

  /** Whether a soldier is quiet enough to talk: alive, not shooting, and no enemy in sight. */
  quiet(p: PlayerView, snap: Snapshot, now: number): boolean {
    if (!p.alive || p.hidden || p.downed) return false;
    if (now - (this.shotAt.get(p.id) ?? -Infinity) < CHATTER.quietAfterShotMs) return false;
    const r2 = CHATTER.enemyRange * CHATTER.enemyRange;
    for (const o of snap.players) {
      if (o.id === p.id || !o.alive || o.hidden || o.downed) continue;
      const friendly = o.team !== null && o.team === p.team;
      if (friendly) continue;
      if ((o.x - p.x) ** 2 + (o.y - p.y) ** 2 < r2) return false;
    }
    for (const z of snap.zombies ?? []) if ((z[2] - p.x) ** 2 + (z[3] - p.y) ** 2 < r2) return false;
    return true;
  }

  /** Picks the line for `p`: a contextual one about half the time when a tag is fresh, else idle; never one said this life. */
  pick(s: Soldier, tags: readonly Tag[], now: number, force?: Tag): { text: string; tag: Tag | null } | null {
    const pers = personalityById(s.personality);
    const ok = (l: string) => !s.said.has(l) && now - (this.said.get(l) ?? -Infinity) > CHATTER.globalRepeatMs;
    const usable = (xs: readonly string[]) => xs.filter(ok);
    const live = tags.filter((t) => usable(pers.tags[t]).length > 0);
    const eventful = live.filter((t) => EVENT_TAGS.has(t));
    const chance = eventful.length ? CHATTER.eventChance : CHATTER.contextChance;
    if (force && pers.tags[force]?.length) return { text: this.oneOf(usable(pers.tags[force]).length ? usable(pers.tags[force]) : pers.tags[force]), tag: force };
    if (live.length && this.rng() < chance) {
      const pool = eventful.length ? eventful : live;
      const tag = pool[Math.floor(this.rng() * pool.length)]!;
      return { text: this.oneOf(usable(pers.tags[tag])), tag };
    }
    let pool = usable(pers.idle);
    if (!pool.length) pool = pers.idle.filter((l) => !s.said.has(l));
    return pool.length ? { text: this.oneOf(pool), tag: null } : null;
  }

  private oneOf(xs: readonly string[]): string { return xs[Math.floor(this.rng() * xs.length)]!; }

  private open(s: Soldier, text: string, tag: Tag | null, own: boolean, now: number) {
    s.said.add(text);
    this.said.set(text, now);
    this.bubbles.push({ pid: s.id, text, at: now, holdMs: holdFor(text), own, tag });
  }

  /** Whether a bubble is still on screen (shown or fading). */
  private live(b: Bubble, now: number) { return now - b.at < b.holdMs + CHATTER.fadeMs; }

  /**
   * Decides whether anybody on your side speaks now (you and your teammates only). One new bubble per call, at most `maxBubbles` on screen, your own soldier first and then the
   * nearest; each soldier waits a random 14-30 s between lines (yours 10-22 s).
   */
  tick(snap: Snapshot, myId: number, now: number, opts: TickOpts = {}) {
    this.bubbles = this.bubbles.filter((b) => this.live(b, now));
    if (!enabled || opts.overlay || this.bubbles.length >= CHATTER.maxBubbles) return;
    const me = snap.players.find((p) => p.id === myId);
    const eye = me?.alive ? me : null;
    if (!eye) return;
    const near = snap.players
      .filter((p) => hearsChatter(eye, p) && p.alive && !p.hidden && Math.hypot(p.x - eye.x, p.y - eye.y) < CHATTER.hearRange && !this.bubbles.some((b) => b.pid === p.id) && !opts.emoting?.(p.id))
      .sort((a, b) => (a.id === myId ? -1 : b.id === myId ? 1 : Math.hypot(a.x - eye.x, a.y - eye.y) - Math.hypot(b.x - eye.x, b.y - eye.y)));
    for (const p of near) {
      const s = this.soldiers.get(p.id);
      if (!s?.alive || now < s.nextAt || !this.quiet(p, snap, now)) continue;
      const line = this.pick(s, this.tagsOf(p, snap, now), now);
      s.nextAt = now + this.between(p.id === myId ? CHATTER.ownCooldownMs : CHATTER.cooldownMs);
      if (!line) continue;
      this.open(s, line.text, line.tag, p.id === myId, now);
      return;
    }
  }

  /** Forces a line now (the dev hook): `personality` overrides the soldier's, `tag` asks for a contextual line. */
  say(pid: number, now: number, opts: { personality?: PersonalityId; tag?: Tag; text?: string; own?: boolean } = {}): Bubble | null {
    let s = this.soldiers.get(pid);
    if (!s) return null;
    if (opts.personality) s = { ...s, personality: opts.personality, said: new Set() };
    const line = opts.text ? { text: opts.text, tag: opts.tag ?? null } : this.pick(s, [], now, opts.tag);
    if (!line) return null;
    const b: Bubble = { pid, text: line.text, at: now, holdMs: holdFor(line.text), own: opts.own ?? false, tag: line.tag };
    this.bubbles = [...this.bubbles.filter((x) => x.pid !== pid), b];
    return b;
  }
}

export const chatter = new Chatter();

/** Chatter is for your own side: you hear yourself and your teammates (squad in Zombies or Last Squad), never an enemy or, in FFA, anyone else. */
export const hearsChatter = (me: Pick<PlayerView, 'id' | 'team'>, p: Pick<PlayerView, 'id' | 'team'>): boolean =>
  p.id === me.id || (me.team !== null && p.team === me.team);

// ---- drawing ----

/** Greedy wrap into at most two lines no wider than `maxW`; a longer text is cut by the line limit in the writing, not here. */
export function wrapLines(measure: (s: string) => number, text: string, maxW: number): string[] {
  if (measure(text) <= maxW) return [text];
  const words = text.split(' ');
  let best = [text], bestW = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' '), b = words.slice(i).join(' ');
    const w = Math.max(measure(a), measure(b));
    if (w < bestW) { bestW = w; best = [a, b]; }
  }
  return best;
}

const easeOut = (t: number) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;
const MARK_Y = -R - 8;

/** Where a soldier's bubble tail points: above the head, clear of the stage marks and the hunted plate, which sit higher. */
export const tailOffset = (stage: number): number => MARK_Y - 10 - (stage ? 12 + 6 * stage + 14 : 0);

/** A phone on its side: one small bubble at a time, gone sooner, so talk never covers the fight. */
export const CHATTER_PHONE = { scale: 0.7, holdMs: 1800, max: 1 } as const;
let compactBubbles = false;
export const setChatterCompact = (on: boolean): void => { compactBubbles = on; };

/**
 * Draws the live bubbles over `players` (world coordinates). `ui` is the UI scale and `zoom` the camera's scale, so a bubble keeps the
 * same size on screen however the camera zooms; `reduced` skips the pop and only fades.
 */
export function drawChatter(ctx: CanvasRenderingContext2D, players: readonly PlayerView[], now: number, dark: number, zoom: number, ui: number, reduced: boolean, emoting?: (pid: number) => boolean) {
  let shown = 0;
  for (const b of chatter.bubbles) {
    const p = players.find((q) => q.id === b.pid);
    const ms = now - b.at;
    const holdMs = compactBubbles ? Math.min(b.holdMs, CHATTER_PHONE.holdMs) : b.holdMs;
    if (!p || p.hidden || !p.alive || ms < 0 || ms >= holdMs + CHATTER.fadeMs || emoting?.(p.id)) continue;
    if (compactBubbles && shown >= CHATTER_PHONE.max) continue;
    shown++;
    ctx.save();
    ctx.font = FONT;
    if (!b.lines) {
      b.lines = wrapLines((t) => ctx.measureText(t).width, b.text, CHATTER.wrapPx);
      b.w = Math.ceil(Math.max(...b.lines.map((t) => ctx.measureText(t).width))) + 22;
    }
    const lh = FONT_PX + 2, w = b.w!, h = 12 + b.lines.length * lh, cut = 7;
    const fade = ms > holdMs ? 1 - (ms - holdMs) / CHATTER.fadeMs : reduced ? easeOut(ms / 160) : 1;
    const k = (ui / zoom) * (reduced ? 1 : popScale(ms)) * (compactBubbles ? CHATTER_PHONE.scale : 1);
    ctx.translate(p.x, p.y + tailOffset(GUNS[p.gun].stage));
    ctx.scale(k, k);
    ctx.globalAlpha = Math.max(0, fade) * (b.own ? 1 : 0.94);
    // A comic speech bubble in the house ink: bone paper, a 2.5 px ink edge, a hard shadow down and right, a tail to the head.
    const top = -h - 4, face = b.own ? '#fff0d2' : '#f3eedf';
    ctx.lineJoin = 'round';
    ctx.fillStyle = 'rgba(10, 12, 18, 0.42)';
    ctx.beginPath(); ctx.roundRect(-w / 2 + 3, top + 4, w, h, 9); ctx.fill();
    ctx.lineWidth = 2.5; ctx.strokeStyle = INK;
    ctx.beginPath(); ctx.moveTo(-6, -4.5); ctx.quadraticCurveTo(-3, 0, 2, 6); ctx.quadraticCurveTo(3, 0, 6, -4.5); ctx.closePath(); ctx.stroke();
    ctx.beginPath(); ctx.roundRect(-w / 2, top, w, h, 9); ctx.stroke();
    ctx.fillStyle = face;
    ctx.fill();
    ctx.beginPath(); ctx.moveTo(-6, -4.5); ctx.quadraticCurveTo(-3, 0, 2, 6); ctx.quadraticCurveTo(3, 0, 6, -4.5); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.roundRect(-w / 2, top, w, h, 9); ctx.fill();
    ctx.fillRect(-5, -5.6, 10, 2.8);
    ctx.fillStyle = INK;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    b.lines.forEach((t, i) => ctx.fillText(t, 0, -h - 4 + 6 + lh / 2 + 3 + i * lh));
    ctx.restore();
  }
}

