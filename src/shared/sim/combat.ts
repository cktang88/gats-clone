import { ARMORS, BOT_DAMAGE_TO_HUMAN, GUNS, KNOCK, KILL_REWARD, MEDAL_RULES, MEDALS, MULTI_MEDALS, ROYALE, rulesOf, STREAK, STREAK_MEDALS, SUPPRESSION, WEAPON_MEDALS, WORLD, ZOMBIES, type GunId, type MedalId } from '../defs.ts';
import { blastDoors } from './doors.ts';
import { INTERP_DELAY_MS, type Team } from '../protocol.ts';
import { flightSec, flownAfter } from './ballistics.ts';
import { MODES } from './modes.ts';
import { angleDiff, clamp, dist2, segmentBlocked, segmentEntersCircleAt, segmentEntersRectAt, segmentHits } from './movement.ts';
import { goDown } from './downed.ts';
import { fall, hurtDowned, openDrop } from './royale.ts';
import { barrelsInBlast, damageBarrel, payChain } from './barrels.ts';
import { openAirdrop } from './airdrop.ts';
import { damageProp, propMedals, propsInBlast } from './props.ts';
import { blastTargets, targetHits } from './targets.ts';
import { damageZombie } from './run.ts';
import { blastShove, bulletShove, shovePlayer, shoveZombie } from './knock.ts';
import { addScore, effectiveStats, falloffMul, hasPerk, isHunted, PERK_RULES } from './stats.ts';
import { barrelRect, crateRect, friendly, propRect, propSolid, type Bullet, type Crate, type Player, type Pose, type Shooter, type Wall, type World } from './world.ts';

const CRATE_RESPAWN_MS = 15000;
const SHIELD_BLOCK = 0.33;
const SHIELD_ARC = (40 * Math.PI) / 180;
/**
 * Covers the ~330ms p90 view lag measured at 100ms one-way lag with 40ms jitter, and a 150ms one-way lag's ~430ms (its round trip,
 * the render delay and a tick in the input queue); 350ms clipped those shots and judged them against a world the shooter never saw.
 * Each client's own cap (`rewindCapFor`) keeps a low ping's rewind far shorter.
 */
export const MAX_REWIND_MS = 500;
const REWIND_MARGIN_MS = 60;
/** A client sees the world its round trip plus its render delay ago, so it may claim no staler view than that; until a round trip is measured it gets the full cap. */
export const rewindCapFor = (rttMs: number | null): number =>
  rttMs === null ? MAX_REWIND_MS : Math.min(MAX_REWIND_MS, rttMs + INTERP_DELAY_MS + REWIND_MARGIN_MS);
const TICK_MS = 1000 / WORLD.tickHz;
const OWN_BLAST_SHARE = 0.5;
const ASSIST_SHARE = 0.3;

const round1 = (v: number) => Math.round(v * 10) / 10;
const SELF_KILL_CREDIT_MS = 10_000;

/** Who set the damage in motion; `team` is theirs at the time, and still spares teammates after they leave. */
type Culprit = { attacker: Player | null; team: Team; label: string; turret?: Shooter | null; /** Set when a barrel's burst made the blast: the chain it belongs to. */ chain?: number; /** A prop's medal for a kill this damage makes (Liftoff, Arsonist). */ medal?: MedalId };
/** A shield stops only bullets, and only a blast hurts its own attacker. */
type DamageSource = Culprit & { piercing: boolean; via: 'bullet' | 'blast' | 'knife' | 'gas' | 'bite'; fromX: number; fromY: number; gun?: GunId | null; volley?: number; /** The heading of the round that landed, which a bullet's shove follows; a blast shoves away from where it burst. */ dirX?: number; dirY?: number };
/** How a kill was made, for the weapon feats: the gun whose round landed it, whether it took one hit from full health, and how pinned the victim was. */
type KillHow = { gun: GunId | null; oneHit: boolean; pinned: number; chain?: number; medal?: MedalId };

export function damagePlayer(w: World, victim: Player, amount: number, src: DamageSource): void {
  if (victim.life.k === 'dead' || w.match.k === 'over' || w.mode === 'RNG') return;
  const a = src.attacker;
  if (a?.id === victim.id ? src.via !== 'blast' : friendly(src.team, victim)) return;
  // The one bot/person rule (`BOT_DAMAGE_TO_HUMAN`), here where every path a player is hurt by an attacker meets. It is the health taken
  // only: the shove and Bloodlust go by the hit as fired (`felt`), the same whoever fires it.
  const kindMul = a?.kind === 'bot' && victim.kind === 'human' ? BOT_DAMAGE_TO_HUMAN : 1;
  if (victim.life.k === 'downed') {
    if (w.royale) hurtDowned(w, victim, amount * kindMul, a);
    return;
  }
  if (w.run && src.team !== null) return;
  const life = victim.life;
  if (!w.run && w.now < life.shieldUntil) return;
  const before = life.hp;
  const stats = effectiveStats(victim);
  if (stats.shield && src.via === 'bullet') {
    const incoming = Math.atan2(src.fromY - victim.y, src.fromX - victim.x);
    if (angleDiff(incoming, victim.angle) <= SHIELD_ARC) amount *= 1 - SHIELD_BLOCK;
  }
  if (src.via === 'blast' && hasPerk(victim, 'demolitions')) amount *= PERK_RULES.demolitions.takenMul;
  if (w.now < life.windUntil) amount *= PERK_RULES.secondWind.damageMul;
  const felt = amount;
  amount *= kindMul;
  if (!src.piercing) amount *= 1 - ARMORS[victim.loadout.armor].blockFrac;
  const fromFull = before >= stats.maxHp;
  const pinned = life.suppression;
  life.hp -= amount;
  life.lastDamageAt = w.now;
  const dealt = before - Math.max(0, life.hp);
  if (a && a.id !== victim.id) {
    life.hits.push({ by: a.id, at: w.now, dealt });
    perkOnHit(w, a, felt, amount > 0 ? dealt / amount : 0, victim);
  }
  if (life.hp > 0 && !life.windUsed && hasPerk(victim, 'secondWind') && life.hp < PERK_RULES.secondWind.belowHp * stats.maxHp) {
    life.windUsed = true;
    life.windUntil = w.now + PERK_RULES.secondWind.ms;
  }
  const shove = life.hp > 0 ? shoveFor(victim, felt, src) : null;
  w.events.push({ e: 'dmg', attacker: a?.id ?? null, victim: victim.id, amount: round1(dealt), x: victim.x, y: victim.y, kind: 'player', ...(shove !== null && { push: shove }) });
  if (a && src.via === 'bullet' && src.volley !== undefined) noteVolley(w, a, victim, src.gun ?? null, src.volley);
  if (life.hp <= 0) kill(w, victim, a, src.label, { gun: src.via === 'bullet' ? src.gun ?? null : null, oneHit: fromFull, pinned, ...(src.chain !== undefined && { chain: src.chain }), ...(src.medal && { medal: src.medal }) });
}

/** Bloodlust heals the attacker by a share of the damage that landed, and Tracker marks the victim on their minimap. */
function perkOnHit(w: World, a: Player, felt: number, landed: number, victim: Player) {
  if (a.life.k !== 'alive') return;
  if (hasPerk(a, 'bloodlust')) a.life.hp = Math.min(effectiveStats(a).maxHp, a.life.hp + PERK_RULES.bloodlust.healShare * felt * landed);
  if (hasPerk(a, 'tracker')) a.life.tracks[victim.id] = w.now + PERK_RULES.tracker.ms;
}

/** Shoves `victim` by what a bullet or blast of `felt` damage lands with, and returns the shove's heading in radians (for the hit's flinch), or null when it moved nothing. */
function shoveFor(victim: Player, felt: number, src: DamageSource): number | null {
  const blast = src.via === 'blast';
  if (!blast && !(src.via === 'bullet' && src.gun)) return null;
  const dx = blast ? victim.x - src.fromX : src.dirX ?? 0, dy = blast ? victim.y - src.fromY : src.dirY ?? 0;
  if (dx === 0 && dy === 0) return null;
  shovePlayer(victim, dx, dy, (blast ? blastShove(felt) : bulletShove(src.gun!, felt)) * (src.attacker && hasPerk(src.attacker, 'brace') ? PERK_RULES.brace.dealtMul : 1), blast);
  return Math.round(Math.atan2(dy, dx) * 100) / 100;
}

/** A shotgun blast whose pellets land on `WEAPON_MEDALS.twoBirdsHits` enemies earns Two Birds the moment the second is hit. */
function noteVolley(w: World, a: Player, victim: Player, gun: GunId | null, volley: number) {
  const v = a.feats.volley;
  if (v.at !== volley) a.feats.volley = { at: volley, hit: [] };
  const hit = a.feats.volley.hit;
  if (hit.includes(victim.id)) return;
  hit.push(victim.id);
  if (hit.length === WEAPON_MEDALS.twoBirdsHits && gun && GUNS[gun].base === 'shotgun') award(w, a, 'twoBirds');
}

function damageSince(hits: readonly { by: number; at: number; dealt: number }[], since: number): Map<number, number> {
  const by = new Map<number, number>();
  for (const h of hits) if (h.at >= since) by.set(h.by, (by.get(h.by) ?? 0) + h.dealt);
  return by;
}

/**
 * A player finished by their own blast gives the kill to whoever hurt them most lately, so blowing yourself up mid-fight never denies a kill or bounty.
 * Only recent damage counts: an old fight the player has long healed from did not set up this death.
 */
function creditFor(w: World, victim: Player, killer: Player | null): Player | null {
  if (killer?.id !== victim.id) return killer;
  if (victim.life.k !== 'alive') return null;
  let top: Player | null = null, most = 0;
  for (const [id, dealt] of damageSince(victim.life.hits, w.now - SELF_KILL_CREDIT_MS)) {
    const p = w.players.get(id);
    if (p && dealt > most) { top = p; most = dealt; }
  }
  return top;
}

export function kill(w: World, victim: Player, killer: Player | null, label: string, how: KillHow = { gun: null, oneHit: false, pinned: 0 }) {
  if (w.run) { goDown(w, victim); return; }
  const credited = creditFor(w, victim, killer);
  const named = credited ?? killer;
  const bounty = credited !== null && isHunted(w, victim);
  const assisters = assistersOf(w, victim, credited);
  const ended = victim.lifeKills;
  const revenge = credited !== null && credited.nemesis === victim.id;
  if (credited) victim.nemesis = credited.id;
  const knock = w.royale ? fall(w, w.royale, victim, named) : (die(w, victim, w.now + WORLD.respawnMs), false);
  w.events.push({
    e: 'kill', killer: named?.name ?? '', victim: victim.name, killerId: named?.id ?? null, victimId: victim.id, weapon: label, bounty,
    assisters: assisters.map((p) => p.id), ...(knock && { knock: true as const }), ended, revenge,
  });
  for (const p of assisters) addScore(w, p, WORLD.assistScore);
  if (!credited) return;
  credited.kills++;
  credited.lifeKills++;
  if (revenge) credited.nemesis = null;
  addScore(w, credited, WORLD.killScore);
  // Every medal one kill earns is paid and announced, however many there are.
  const barrel = how.chain !== undefined && credited.id !== victim.id;
  for (const medal of [...killMedals(w, credited, victim, { bounty, revenge, ended }), ...weaponMedals(w, credited, victim, how, credited === killer), ...(barrel ? ['kaboom' as const] : []), ...propMedals(w, credited, victim, how.medal, credited === killer)]) award(w, credited, medal);
  const chain = barrel ? w.chains.get(how.chain!) : undefined;
  if (chain) { chain.kills++; payChain(w, chain); }
  refuel(credited);
  if (credited.life.k === 'alive' && hasPerk(credited, 'adrenaline')) credited.life.rushUntil = w.now + PERK_RULES.adrenaline.ms;
  MODES[w.mode].onKill(w, credited, victim);
}

export function die(w: World, victim: Player, respawnAt: number) {
  victim.life = { k: 'dead', respawnAt };
  victim.deaths++;
  w.lifeRecords.push({ id: victim.id, name: victim.name, kills: victim.lifeKills, score: victim.score, died: true });
}

/** The medals one kill earns its killer, judged before the kill's refuel so a Clutch sees the health it was won on. */
function killMedals(w: World, killer: Player, victim: Player, kill: { bounty: boolean; revenge: boolean; ended: number }): MedalId[] {
  const out: MedalId[] = [];
  if (!w.firstBlood) { w.firstBlood = true; out.push('firstBlood'); }
  killer.chain = w.now - killer.chain.at <= MEDAL_RULES.multiMs ? { count: killer.chain.count + 1, at: w.now } : { count: 1, at: w.now };
  const multi = MULTI_MEDALS[Math.min(killer.chain.count, MULTI_MEDALS.length + 1) - 2];
  if (multi) out.push(multi);
  const range = Math.hypot(victim.x - killer.x, victim.y - killer.y);
  if (range >= MEDAL_RULES.longShotPx) out.push('longShot');
  else if (range <= MEDAL_RULES.pointBlankPx) out.push('pointBlank');
  const life = killer.life;
  const hurtByVictim = life.k === 'alive' && life.hits.some((h) => h.by === victim.id && w.now - h.at <= MEDAL_RULES.clutchMs);
  if (life.k === 'alive' && hurtByVictim && life.hp <= MEDAL_RULES.clutchHp * effectiveStats(killer).maxHp) out.push('clutch');
  if (kill.revenge) out.push('revenge');
  if (kill.ended >= STREAK.shutdownAt) out.push('shutdown');
  if (kill.bounty) out.push('bounty');
  const streak = STREAK_MEDALS.find(([n]) => n === killer.lifeKills);
  if (streak) out.push(streak[1]);
  return out;
}

/** The weapon feats one kill earns, judged on the gun whose round landed it; a kill handed over by a self-blast earns none. */
function weaponMedals(w: World, killer: Player, victim: Player, how: KillHow, own: boolean): MedalId[] {
  if (!own || !how.gun) return [];
  const out: MedalId[] = [];
  const f = killer.feats;
  f.magKills++;
  const range = Math.hypot(victim.x - killer.x, victim.y - killer.y);
  const life = killer.life;
  switch (GUNS[how.gun].base) {
    case 'pistol':
      if (f.magKills === WEAPON_MEDALS.doubleTapKills) out.push('doubleTap');
      if (range >= WEAPON_MEDALS.deadeyePx) out.push('deadeye');
      break;
    case 'smg':
      // On the move, and only just out of a sprint: it ended at most `runAndGunMs` ago.
      if (life.k === 'alive' && life.lastMoveAt === w.now && w.now >= life.sprintEndAt && w.now - life.sprintEndAt <= WEAPON_MEDALS.runAndGunMs) out.push('runAndGun');
      break;
    case 'shotgun':
      if (range >= WEAPON_MEDALS.longBarrelPx) out.push('longBarrel');
      break;
    case 'assault': {
      const bloom = rulesOf(GUNS[how.gun]).bloom;
      if (bloom && life.k === 'alive' && life.spray <= bloom.tap && range >= WEAPON_MEDALS.disciplinedPx) out.push('disciplined');
      break;
    }
    case 'sniper':
      if (how.oneHit && range >= WEAPON_MEDALS.oneShotPx) {
        out.push('oneShot');
        f.oneShots++;
        if (f.oneShots === WEAPON_MEDALS.oneShotsForReaper) out.push('reaper');
      }
      if (range <= WEAPON_MEDALS.noScopePx) out.push('noScope');
      if (range >= WEAPON_MEDALS.eagleEyePx) out.push('eagleEye');
      break;
    case 'lmg':
      if (how.pinned >= WEAPON_MEDALS.pinnedSuppression && range >= WEAPON_MEDALS.pinnedPx) out.push('pinnedDown');
      if (f.magKills === WEAPON_MEDALS.beltFedKills) out.push('beltFed');
      break;
  }
  return out;
}

/** Pays a medal's score and tells its earner (`MEDALS`). */
export function award(w: World, p: Player, medal: MedalId) {
  addScore(w, p, MEDALS[medal].score);
  w.events.push({ e: 'medal', id: p.id, medal });
}

/**
 * A Close Call: a life that falls under `closeCallHp` and lives `closeCallMs` more earns the medal once, and can earn it
 * again only after healing back past `closeCallReset`.
 */
export function watchCloseCalls(w: World) {
  if (w.run) return;
  for (const p of w.players.values()) {
    watchGhost(w, p);
    if (p.life.k !== 'alive') { p.lowAt = null; continue; }
    const frac = p.life.hp / effectiveStats(p).maxHp;
    if (p.lowAt === -1) { if (frac >= MEDAL_RULES.closeCallReset) p.lowAt = null; continue; }
    if (p.lowAt === null) { if (frac <= MEDAL_RULES.closeCallHp) p.lowAt = w.now; continue; }
    if (w.now - p.lowAt >= MEDAL_RULES.closeCallMs) { p.lowAt = -1; award(w, p, 'closeCall'); }
  }
}

/** A Ghost: `MEDAL_RULES.ghostPx` of ground covered in one life without firing a shot, paid each time it is covered again. */
function watchGhost(w: World, p: Player) {
  const q = p.quiet;
  if (p.life.k !== 'alive') { p.quiet = { px: 0, x: p.x, y: p.y, firedAt: -Infinity }; return; }
  const step = Math.hypot(p.x - q.x, p.y - q.y);
  // A shot, or a jump such as a respawn's, starts the count again.
  const fired = p.life.firedAt !== q.firedAt;
  q.px = fired || step > WORLD.baseSpeed ? 0 : q.px + step;
  q.x = p.x; q.y = p.y; q.firedAt = p.life.firedAt;
  if (q.px >= MEDAL_RULES.ghostPx) { q.px = 0; award(w, p, 'ghost'); }
}

/** A kill gives the killer back some health and, unless they are mid-reload, some of their mag (`KILL_REWARD`). */
function refuel(p: Player) {
  if (p.life.k !== 'alive') return;
  const stats = effectiveStats(p);
  p.life.hp = Math.min(stats.maxHp, p.life.hp + KILL_REWARD.heal * stats.maxHp);
  if (p.life.reloadUntil === null) p.life.ammo = Math.min(stats.mag, p.life.ammo + Math.ceil(KILL_REWARD.ammo * stats.mag));
}

function assistersOf(w: World, victim: Player, killer: Player | null): Player[] {
  if (victim.life.k !== 'alive') return [];
  const enough = ASSIST_SHARE * effectiveStats(victim).maxHp;
  return [...damageSince(victim.life.hits, -Infinity)]
    .filter(([id, dealt]) => id !== killer?.id && dealt >= enough)
    .flatMap(([id]) => {
      const p = w.players.get(id);
      return p?.life.k === 'alive' ? [p] : [];
    });
}

function damageCrate(w: World, c: Crate, amount: number, attacker: Player | null) {
  if (c.respawnAt !== null) return;
  const dealt = Math.min(c.hp, amount);
  c.hp -= amount;
  const h = c.size / 2;
  w.events.push({ e: 'dmg', attacker: attacker?.id ?? null, victim: c.id, amount: round1(dealt), x: c.x + h, y: c.y + h, kind: 'crate' });
  if (c.hp > 0) return;
  c.respawnAt = w.royale || c.drop ? Infinity : w.now + CRATE_RESPAWN_MS;
  w.wallsVersion++;
  w.events.push({ e: 'boom', x: c.x + h, y: c.y + h, r: c.size });
  if (!attacker) return;
  addScore(w, attacker, w.royale ? ROYALE.crateScore : WORLD.crateScore);
  if (c.drop) { if (w.royale) openDrop(w, attacker); else openAirdrop(w, attacker, c); }
}

/** What a moving bullet or blast is judged against: live positions, or the rewound world a lagged shooter saw. */
/** `poseBefore` is where a body stood when the step began, so a round meets it moving through the step, not frozen where the step ends. */
type View = { poseOf: (p: Player) => Pose | undefined; walls: readonly Wall[]; /** The server time a rewound shot is judged at, for targets that slide; absent for a live view. */ at?: number; poseBefore?: (p: Player) => Pose | undefined };
/** The last recorded poses are the previous tick's: where everyone stood as this step began. */
const liveView = (w: World): View => ({ poseOf: (p) => p, walls: w.walls, poseBefore: (p) => w.history[w.history.length - 1]?.poses.get(p.id) });
/** Further than this in one step is a respawn or a teleport, not motion a round can sweep. */
const SWEEP_MAX_PX = 80;

/**
 * Where (0..1) a round's step (b, b + d) meets a circle that moved from `was` to `at` over the step: in the circle's own frame
 * the round flies d less the circle's motion over the `span` (0..1) of the step it flies (less than all of it when it dies mid-step). Judged only where the step ends, a body crossing the line mid-step was missed by a
 * round the page drew straight through it (and hit when it had already left).
 */
function meetsMoving(bx: number, by: number, dx: number, dy: number, at: Pose, was: Pose | undefined, r: number, span: number): number | null {
  const mx = was ? (at.x - was.x) * span : 0, my = was ? (at.y - was.y) * span : 0;
  if (!was || mx * mx + my * my > SWEEP_MAX_PX * SWEEP_MAX_PX) return segmentEntersCircleAt(bx, by, dx, dy, at.x, at.y, r);
  return segmentEntersCircleAt(bx, by, dx - mx, dy - my, was.x, was.y, r);
}

const sheltered = (walls: readonly Wall[], x: number, y: number, tx: number, ty: number) => segmentBlocked(walls, x, y, tx - x, ty - y, 'nb');

export function explode(w: World, x: number, y: number, radius: number, maxDamage: number, by: Culprit, view: View = liveView(w)) {
  if (by.attacker && hasPerk(by.attacker, 'demolitions')) { radius *= PERK_RULES.demolitions.radiusMul; maxDamage *= PERK_RULES.demolitions.dealtMul; }
  w.events.push({ e: 'boom', x, y, r: radius });
  blastDoors(w, x, y, radius);
  for (const p of w.players.values()) {
    const at = view.poseOf(p);
    if (!at) continue;
    const d = Math.sqrt(dist2(at.x, at.y, x, y));
    if (d > radius + WORLD.playerRadius || sheltered(view.walls, x, y, at.x, at.y)) continue;
    const dmg = maxDamage * (1 - Math.max(0, d - WORLD.playerRadius) / radius) * (p === by.attacker ? OWN_BLAST_SHARE : 1);
    damagePlayer(w, p, dmg, { ...by, piercing: false, via: 'blast', fromX: x, fromY: y });
  }
  for (const c of w.crates) {
    const r = crateRect(c);
    const nx = clamp(x, r.x, r.x + r.w), ny = clamp(y, r.y, r.y + r.h);
    const d = Math.sqrt(dist2(x, y, nx, ny));
    if (d >= radius || sheltered(view.walls, x, y, nx, ny)) continue;
    damageCrate(w, c, maxDamage * (1 - d / radius), by.attacker);
  }
  for (const { b, d } of barrelsInBlast(w, x, y, radius)) {
    if (sheltered(view.walls, x, y, b.x, b.y)) continue;
    damageBarrel(w, b, maxDamage * (1 - d / radius), { attacker: by.attacker, team: by.team, ...(by.chain !== undefined && { chain: by.chain }) }, d);
  }
  for (const { q, d } of propsInBlast(w, x, y, radius)) {
    if (sheltered(view.walls, x, y, q.x, q.y)) continue;
    damageProp(w, q, maxDamage * (1 - d / radius), { attacker: by.attacker, team: by.team }, { x: q.x - x, y: q.y - y });
  }
  blastTargets(w, x, y, radius, maxDamage, by.attacker, by.label, (tx, ty) => sheltered(view.walls, x, y, tx, ty));
  for (const z of w.zombies) {
    const r = ZOMBIES[z.kind].radius;
    const d = Math.sqrt(dist2(z.x, z.y, x, y));
    if (d > radius + r || sheltered(view.walls, x, y, z.x, z.y)) continue;
    const dmg = maxDamage * (1 - Math.max(0, d - r) / radius);
    damageZombie(w, z, dmg, by.attacker, by.turret ?? 'blast');
    shoveZombie(z, z.x - x, z.y - y, blastShove(dmg), true);
  }
}

type BulletHit = { t: number | null; victim: { id: number } | null; apply: (x: number, y: number) => void };

/** Backs the blast off the surface it struck, so the wall it hit does not shelter the side the bullet came from. */
const BLAST_STANDOFF = 2;

function stopBullet(w: World, b: Bullet, x: number, y: number, owner: Player | null, view: View): false {
  if (!b.blast) return false;
  const speed = Math.hypot(b.vx, b.vy);
  const bx = x - (b.vx / speed) * BLAST_STANDOFF, by = y - (b.vy / speed) * BLAST_STANDOFF;
  explode(w, bx, by, b.blast.radius, b.blast.damage, { attacker: owner, team: b.team, label: b.label, turret: b.turret }, view);
  return false;
}

/** How far around a door-breaker's strike a swing door is blown open. */
const BREACH_PX = 30;
const SUPPRESS_REACH = WORLD.playerRadius + SUPPRESSION.px;

/** A gun round whose path this step comes within `SUPPRESS_REACH` of an enemy suppresses them, once per round. */
function suppressAlong(w: World, b: Bullet, dx: number, dy: number, view: View) {
  if (b.gun === null) return;
  const len2 = dx * dx + dy * dy;
  for (const p of w.players.values()) {
    if (p.id === b.owner || p.life.k !== 'alive' || friendly(b.team, p) || b.suppressed?.includes(p.id)) continue;
    const at = view.poseOf(p);
    if (!at) continue;
    const t = len2 === 0 ? 0 : clamp(((at.x - b.x) * dx + (at.y - b.y) * dy) / len2, 0, 1);
    if (dist2(at.x, at.y, b.x + dx * t, b.y + dy * t) > SUPPRESS_REACH * SUPPRESS_REACH) continue;
    (b.suppressed ??= []).push(p.id);
    p.life.suppression = Math.min(1, p.life.suppression + rulesOf(GUNS[b.gun]).suppress);
    p.life.suppressedAt = w.now;
  }
}

function moveBullet(w: World, b: Bullet, dt: number, view: View): boolean {
  const speed = Math.hypot(b.vx, b.vy);
  const from = b.flown ?? 0;
  const boost = b.gun === null ? 0 : rulesOf(GUNS[b.gun]).muzzleBoost;
  const full = b.gun === null ? speed * dt : flownAfter(speed, dt, from, boost) - from;
  const travel = Math.min(b.left, full);
  /** The share of the step's time the round flies: all of it, unless it reaches the end of its range first. */
  const span = travel >= full || dt <= 0 ? 1 : b.gun === null ? travel / full : (flightSec(speed, from + travel, boost) - flightSec(speed, from, boost)) / dt;
  if (b.gun !== null) b.flown = from + travel;
  const dx = (b.vx / speed) * travel, dy = (b.vy / speed) * travel;
  const owner = w.players.get(b.owner) ?? null;
  /** What a hit at (x, y) this step keeps of the round's damage once it has flown that far (`GunRules.falloff`). */
  const fell = (x: number, y: number) => (b.gun ? falloffMul(b.gun, from + Math.hypot(x - b.x, y - b.y)) : 1);
  const candidates: BulletHit[] = [
    // Only the walls the step enters, in wall order: the same hits, ties and all, as testing every wall.
    ...segmentHits(view.walls, b.x, b.y, dx, dy, 'nb').map(({ t, b: wall }) => ({ t, victim: null, apply: (x: number, y: number) => {
      w.events.push({ e: 'impact', x, y });
      // A door-breaker's round blows the swing door it strikes open (see `GunRules.breach`).
      if (wall.door && b.gun && rulesOf(GUNS[b.gun]).breach) blastDoors(w, x, y, BREACH_PX);
    } })),
    ...w.crates.filter((c) => c.respawnAt === null).map((c) => ({
      t: segmentEntersRectAt(b.x, b.y, dx, dy, crateRect(c)), victim: null, apply: () => damageCrate(w, c, b.damage, owner),
    })),
    ...w.barrels.filter((o) => o.respawnAt === null).map((o) => ({
      t: segmentEntersRectAt(b.x, b.y, dx, dy, barrelRect(o)), victim: null, apply: () => damageBarrel(w, o, b.damage, { attacker: owner, team: b.team }),
    })),
    ...w.props.filter(propSolid).map((q) => ({
      t: segmentEntersRectAt(b.x, b.y, dx, dy, propRect(q)), victim: null, apply: () => damageProp(w, q, b.damage, { attacker: owner, team: b.team }, { x: b.vx, y: b.vy }),
    })),
    ...[...w.players.values()]
      .filter((p) => p.id !== b.owner && (p.life.k === 'alive' || (p.life.k === 'downed' && w.royale !== null)) && !friendly(b.team, p) && !b.passed.includes(p.id))
      .flatMap((p) => {
        const at = view.poseOf(p);
        return at ? [{
          t: meetsMoving(b.x, b.y, dx, dy, at, view.poseBefore?.(p), WORLD.playerRadius, span),
          victim: p,
          apply: (x: number, y: number) => damagePlayer(w, p, b.damage * fell(x, y), { attacker: owner, team: b.team, label: b.label, piercing: b.piercing, via: 'bullet', fromX: b.x, fromY: b.y, gun: b.gun, volley: b.volley, dirX: b.vx, dirY: b.vy }),
        }] : [];
      }),
    ...targetHits(w, b, dx, dy, owner, view.at, fell, dt * 1000, span),
    // Zombies are judged where they stand now, even for a rewound shot: they are slow, and they keep no pose history.
    ...w.zombies
      .filter((z) => !b.passed.includes(z.id) && Math.abs(z.x - b.x - dx / 2) <= Math.abs(dx) / 2 + ZOMBIES[z.kind].radius && Math.abs(z.y - b.y - dy / 2) <= Math.abs(dy) / 2 + ZOMBIES[z.kind].radius)
      .map((z) => ({
        t: segmentEntersCircleAt(b.x, b.y, dx, dy, z.x, z.y, ZOMBIES[z.kind].radius), victim: z,
        apply: (x: number, y: number) => {
          const damage = b.damage * fell(x, y);
          damageZombie(w, z, b.piercing ? damage : Math.max(1, damage - ZOMBIES[z.kind].plate), owner, b.turret ?? 'hit');
          shoveZombie(z, b.vx, b.vy, b.gun ? bulletShove(b.gun, b.damage) : b.damage * KNOCK.perDamage.assault, false);
        },
      })),
  ];
  const hits = b.lobbed ? [] : candidates.filter((c): c is BulletHit & { t: number } => c.t !== null).sort((a, c) => a.t - c.t);
  for (const hit of hits) {
    const x = b.x + dx * hit.t, y = b.y + dy * hit.t;
    if (!hit.victim || b.penetrate === 0) suppressAlong(w, b, dx * hit.t, dy * hit.t, view);
    hit.apply(x, y);
    if (!hit.victim || b.penetrate === 0) return stopBullet(w, b, x, y, owner, view);
    b.penetrate--;
    b.passed.push(hit.victim.id);
  }
  suppressAlong(w, b, dx, dy, view);
  b.x += dx;
  b.y += dy;
  b.left -= travel;
  return b.left > 0.5 || stopBullet(w, b, b.x, b.y, owner, view);
}

function posesAt(w: World, at: number): ReadonlyMap<number, Pose> {
  const h = w.history;
  const next = h.findIndex((f) => f.at >= at);
  if (next === -1) return h[h.length - 1]?.poses ?? new Map([...w.players.values()].map((p) => [p.id, { x: p.x, y: p.y }]));
  const b = h[next]!;
  const a = h[next - 1];
  if (!a) return b.poses;
  const k = (at - a.at) / (b.at - a.at);
  const poses = new Map<number, Pose>();
  for (const [id, pb] of b.poses) {
    const pa = a.poses.get(id);
    poses.set(id, pa ? { x: pa.x + (pb.x - pa.x) * k, y: pa.y + (pb.y - pa.y) * k } : pb);
  }
  return poses;
}

/**
 * Any wall that stood during the rewound window blocks, so a rewound shot never passes where cover existed.
 * It flies up to the start of this tick, the last recorded poses: `tickBullets` flies this tick's step against where everyone
 * stands now, as for every round. Flown on to now here as well, it would take that step twice and stay a tick ahead of the world
 * it is judged in for the rest of its flight, so a moving body was a tick's walk off from where the shooter saw the round meet it.
 */
export function flyThroughPast(w: World, b: Bullet, rewindMs: number): boolean {
  const from = w.now - rewindMs, until = w.now - TICK_MS;
  // Frames share their walls array while no wall comes or goes, so the union is usually today's array itself, with no copy to make.
  const lists: (readonly Wall[])[] = [];
  for (const f of w.history) if (f.at >= from - TICK_MS && !lists.includes(f.walls)) lists.push(f.walls);
  if (!lists.includes(w.walls)) lists.push(w.walls);
  const walls = lists.length === 1 ? lists[0]! : [...new Set(lists.flat())];
  for (let t = from; t < until - 1e-6;) {
    const dtMs = Math.min(TICK_MS, until - t);
    t += dtMs;
    const poses = posesAt(w, t), before = posesAt(w, t - dtMs);
    if (!moveBullet(w, b, dtMs / 1000, { poseOf: (p) => poses.get(p.id), walls, at: t, poseBefore: (p) => before.get(p.id) })) return false;
  }
  return true;
}

export function tickBullets(w: World, dt: number) {
  w.bullets = w.bullets.filter((b) => moveBullet(w, b, dt, liveView(w)));
}

export function recordPoses(w: World) {
  const poses = new Map<number, Pose>();
  for (const p of w.players.values()) if (p.life.k !== 'dead') poses.set(p.id, { x: p.x, y: p.y });
  w.history.push({ at: w.now, poses, walls: w.walls });
  while (w.history.length > 2 && w.history[1]!.at <= w.now - MAX_REWIND_MS) w.history.shift();
}
