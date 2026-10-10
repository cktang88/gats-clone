import { COLORS, GUNS, ROYALE, WORLD, ZOM, ZOMBIE_KINDS, ZOMBIES, type GunId } from '../shared/defs.ts';
import { MAPS, CRATE_SIZE } from '../shared/maps.ts';
import type { BulletView, PlayerView, RunView, Snapshot, ThrownView, WallView } from '../shared/protocol.ts';
import { BLAST_RADIUS } from '../shared/sim/abilities.ts';
import { screenToWorld, type Camera, type Point } from './camera.ts';
import { drawCasings, drawEffects, drawParticles, HIT_FLASH_MS, hitFlashes, kicks, KICK_MS } from './effects.ts';
import { drawJuice } from './killfx.ts';
import { glow, INK, NIGHT, PALETTE, TEAM_COLORS, teamColor } from './palette.ts';
import { serverNow } from './interp.ts';
import { INTERP_DELAY_MS } from '../shared/protocol.ts';
import { drawHordeEyes } from './zombieart.ts';
import { drawCoreGlow, drawCoreTop, drawDowned, drawFloorItems, drawGhost, drawSiegeLights, drawSiegeTops, drawZombies, onPad, wallFlashes } from './siege.ts';
import { drawSiegeFx } from './siegefx.ts';
import { drawWrecks, wrecks } from './wrecks.ts';
import { drawBodyShadows, drawSoldier, gaitAmount, stepGait, type Gait } from './bodies.ts';
import { stepCarry, swingMsOf } from './raise.ts';
import { drawProps, drawPropTops, drawFireSlick } from './propfx.ts';
import { drawRadioOverlay, drawRadios } from './radio.ts';
import { drawGains } from './pickups.ts';
import { drawZoneFloor, drawZoneOverlay, zonesOf } from './zoneart.ts';
import { drawRangeFloor, drawTargets, layoutOf } from './targetart.ts';
import { drawReachFloor, drawReachOverlay, reachOf } from './rangeline.ts';
import { drawBarrels, drawArenaLight, drawBeacon, drawDropLabels, drawShields, drawGoldShine, drawParachute, drawPlaneShadow } from './arenafx.ts';
import { drawHeldGun, heldHands, muzzleTip } from './gunart.ts';
import { cosLook, RARITY_INK } from './cosmeticlook.ts';
import { nameInk } from './nametag.ts';
import { COSMETIC_BY_ID, DEFAULTS } from '../shared/cosmetics.ts';
import { drawEmoteBubbles, drawEmoteGestures, emoteOf, partyOn } from './emotefx.ts';
import { chatter, drawChatter } from './chatter.ts';
import { uiScaleFor } from './uiscale.ts';
import { reducedMotion } from './screenfx.ts';
import { fillIcon, strokeIcon, UI_ICONS } from './icons.ts';
import { careerImage } from './medals.ts';
import type { Session } from './state.ts';
import { buildingSolid, standsUp, coreSolid, crateSolid, createGroundCache, curbSolids, drawGround, drawLooseShadows, drawSolids, FOOT, LIP, wallSolids, type Solid } from './tilt.ts';
import { drawDust, drawVignette } from './ambience.ts';
import { moodOf, setMood } from './mood.ts';
import { drawNightFx } from './nightfx.ts';
import { setLightClock } from './lighting.ts';
import { onMapChange } from './mapscope.ts';
import { lightBackdrop, lightWorld } from './lightfeed.ts';
import { drawFixtures } from './fixtures.ts';
import { floorPlanOf } from './floor.ts';
import { doorOccluders, drawDoors, drawGeoDebug, drawPolys, drawRoofs, geoDebug, polyOccluders, type GeoInfo } from './geoart.ts';
import { drawDoorwayFloors, drawDoorwayJambs } from './doorwayart.ts';
import { leavesFromViews } from '../shared/sim/doors.ts';
import './themes/index.ts';
import { drawAmbientGround, drawAmbientSky } from './ambientfeed.ts';
import { mapOf, themeOf } from './themes/registry.ts';
import { canBuildNow, upgradeTarget, type Ghost } from './zombies.ts';
import { turretRangesOn } from './settings.ts';
import { TRACER } from './rounds.ts';
import { heftOf } from './shake.ts';
import { drawCorpses, drawZombieCorpses, liveCorpses, zombieField } from './corpses.ts';
import { flinchOf, flinchOffset } from './flinch.ts';
import { drawFloor as drawGunFloor, drawTop as drawGunTop, gunFxOf, noteMap as noteGunMap } from './gunfx.ts';
import { drawDropsWorld, drawRingWorld } from './royale.ts';
import { drawBlastFx, drawBlastRing, drawDashTrails, drawExplosiveRounds, drawGasCloud, drawScorches, drawThrownBody } from './blastdraw.ts';
import { trackDash } from './blastfx.ts';
import { boltScene, dropCarried, reloadScene, selfReload, stepBolt, stepReload, type ReloadFrame } from './reloadanim.ts';
import { reloadFoley } from './reloadsfx.ts';
import { nextPickName } from './loadout.ts';
import { drawGadgetBody, drawGadgetFx, isGadget } from './gadgetart.ts';
import { applyPose, bodyPose, drawGunGlints, drawMotionAbove, drawMotionBelow, drawShieldShimmer, noteStride, observeMotion } from './motionfx.ts';

const TAU = Math.PI * 2;
const R = WORLD.playerRadius;
const GRID = 80;
const CULL_MARGIN = 80;

export const bodyColor = (p: Pick<PlayerView, 'color' | 'team'>): string => (p.team ? TEAM_COLORS[p.team] : COLORS[p.color]);

type Frame = { snap: Snapshot; s: Session; cam: Camera; dpr: number; now: number; /** The real clock, for juice that keeps moving through a hit-stop. */ fxNow?: number; selfAngle: number | null; killerId: number | null; ghost?: Ghost | null; /** The cursor in the world, for the turret under it to show its range. */ cursor?: { x: number; y: number } | null; /** Only the world: no names, health bars, chatter, emote bubbles, marks or damage numbers (the menu's attract mode). */ bare?: boolean };
type View = { x0: number; y0: number; x1: number; y1: number };

const inView = (v: View, x: number, y: number, w: number, h: number) => x + w >= v.x0 && x <= v.x1 && y + h >= v.y0 && y <= v.y1;
const solidInView = (v: View, s: Solid) => inView(v, s.x, s.y, s.w + LIP, s.h + LIP + FOOT);

const ground = createGroundCache();
// The ground layer is one map's: a new map (or the menu's attract mode letting go, see attract.ts) frees it rather than holding it till the next bake.
onMapChange(() => ground.clear());
const mapWallKeys = new WeakMap<readonly WallView[], string>();
export function mapWallsKey(walls: readonly WallView[]): string {
  let key = mapWallKeys.get(walls);
  if (key === undefined) mapWallKeys.set(walls, (key = walls.flatMap((w) => (w.built ? [] : [`${w.material}${w.x},${w.y},${w.w},${w.h}`])).join('|')));
  return key;
}
export const shadowBakes = ground.bakes;

let night = 0;
let nightAt = 0;
const NIGHT_FADE_MS = 1500;

export const nightAmount = () => night;

function easeNight(run: RunView | undefined, now: number, dusk = 0): number {
  const target = Math.max(dusk, run?.phase === 'night' ? 1 : 0);
  const step = Math.min(1, Math.max(0, now - nightAt) / NIGHT_FADE_MS);
  nightAt = now;
  night = night < target ? Math.min(target, night + step) : Math.max(target, night - step);
  return night;
}

export function drawWorld(ctx: CanvasRenderingContext2D, f: Frame) {
  const { cam, dpr, snap, s, now } = f;
  // The frame's light clock first: everything below may set a light (a theme's lamps, a door's glow, a parked vehicle's lamps),
  // and one stamped with last frame's clock would lapse on a slow frame (a software canvas, a hitch) the moment it is set.
  setLightClock(now);
  const k = dpr * cam.scale;
  ctx.setTransform(k, 0, 0, k, dpr * (cam.w / 2 - cam.x * cam.scale), dpr * (cam.h / 2 - cam.y * cam.scale));
  const tl = screenToWorld(cam, { x: 0, y: 0 });
  const br = screenToWorld(cam, { x: cam.w, y: cam.h });
  const view: View = { x0: tl.x - CULL_MARGIN, y0: tl.y - CULL_MARGIN, x1: br.x + CULL_MARGIN, y1: br.y + CULL_MARGIN };
  const mood = moodOf(snap.match.map);
  setMood(mood);
  const dark = easeNight(snap.run, now, mood?.dusk ?? themeOf(mapOf(snap.match.map)?.theme)?.dusk);
  const siege = snap.run ? [...(snap.buildings ?? []).filter(onPad).map(buildingSolid), coreSolid(snap.run)] : 'static';
  drawGround(ctx, ground.get(`${snap.match.map}|${mapWallsKey(s.walls)}`, s.worldSize, () => [...curbSolids(s.worldSize), ...wallSolids(s.walls.filter((w) => !w.built))], siege, floorPlanOf(snap.match.map)), view.x0, view.y0, view.x1, view.y1);
  // A theme's ground-level animation (water, decks) goes under every wall, shadow and body.
  { const t0 = themeOf(mapOf(snap.match.map)?.theme), m0 = mapOf(snap.match.map); if (t0?.ground && m0) t0.ground(ctx, now, view, m0); }
  // Every doorway's sill, worn passage and doormat (doorwayart.ts), baked per doorway.
  { const m0 = mapOf(snap.match.map); if (m0) drawDoorwayFloors(ctx, m0, view); }

  const mine = snap.players.find((p) => p.id === s.myId);
  // The range only: its floor paint, then the reach of the gun you hold (rangeline.ts), measured from where you stand.
  const rangeLayout = snap.targets ? layoutOf(snap.match.map) : undefined;
  const reach = rangeLayout && mine?.alive ? reachOf(mine.gun, snap.self.perks) : null;
  if (rangeLayout) drawRangeFloor(ctx, rangeLayout, s.worldSize, view);
  if (rangeLayout && reach && mine) drawReachFloor(ctx, rangeLayout, s.worldSize, view, mine, reach, now);
  // The squad shares one team, so each squadmate wears their own color instead.
  const colorOf = (p: PlayerView) => (snap.run ? COLORS[p.color] : bodyColor(p));
  const zones = zonesOf(snap.zones);
  for (const z of zones) drawZoneFloor(ctx, z, now, dark, reducedMotion());
  for (const t of snap.thrown) if (t.kind === 'claymore') drawThrown(ctx, t, now);
  if (snap.run) drawCoreGlow(ctx, snap.run, now);
  if (snap.run && snap.buildings) drawFloorItems(ctx, snap.buildings.filter((b) => !standsUp(b) && inView(view, b.cx * ZOM.cell, b.cy * ZOM.cell, ZOM.cell, ZOM.cell)), now);
  drawScorches(ctx, now, view);
  // What the horde brought down lies on the floor as a charred heap of junk (wrecks.ts); its smoke and embers come in the siege's late pass.
  if (snap.run && wrecks.list.length) drawWrecks(ctx, wrecks.list, view, now, k);

  const crates = snap.crates.map(crateSolid).filter((c) => solidInView(view, c));
  drawLooseShadows(ctx, [...crates, ...wallSolids(s.walls.filter((w) => w.built && !w.out)).filter((w) => solidInView(view, w))]);
  drawCasings(ctx, s.particles, now);
  observeMotion(snap, s.myId, now, colorOf);

  const alive = snap.players.filter((p) => p.alive && inView(view, p.x - R * 3, p.y - R * 3, R * 6, R * 6));
  const downed = snap.players.filter((p) => p.downed && inView(view, p.x - R * 3, p.y - R * 3, R * 6, R * 6));
  const zombies = snap.zombies ?? [];
  drawBodyShadows(ctx, [
    ...alive.filter((p) => !p.hidden).map((p) => ({ x: p.x, y: p.y, r: R })),
    ...zombies.map(([, kind, x, y]) => ({ x, y, r: ZOMBIES[ZOMBIE_KINDS[kind]].radius })),
  ], k);

  const walls = wallSolids(s.walls.filter((w) => !w.out)).filter((w) => solidInView(view, w));
  const standing = (siege === 'static' ? [] : siege).filter((b) => solidInView(view, b));
  drawSolids(ctx, [...curbSolids(s.worldSize).filter((c) => solidInView(view, c)), ...walls, ...standing, ...crates]);
  const shields = s.walls.filter((w) => w.out && inView(view, w.x, w.y, w.w, w.h));
  if (shields.length) drawShields(ctx, shields, now, serverNow(s.snaps, now));
  // Polygon walls, doors and roofs (docs/maps/GEOMETRY.md) come from the map itself; door state comes from the snapshot.
  const geoMap = mapOf(snap.match.map);
  const geo: GeoInfo | null = geoMap && (geoMap.polys?.length || geoMap.doors?.length || geoMap.roofs?.length) ? { now, view, dark, map: geoMap } : null;
  const leaves = geo ? leavesFromViews(geoMap!.doors, snap.doors) : [];
  if (geo) {
    drawPolys(ctx, geo);
    drawDoorwayJambs(ctx, geoMap!, view);
    drawDoors(ctx, geo, snap.doors);
    if (geoDebug()) drawGeoDebug(ctx, geo, leaves);
  }
  // The yard's practical lights and wall fittings (decor.ts): drawn over the walls, under every body.
  const decor = floorPlanOf(snap.match.map)?.decor;
  const fx = { dark, now, reduced: reducedMotion(), alarm: !!snap.run && snap.run.core.hp > 0 && snap.run.core.hp <= snap.run.core.maxHp * 0.35 };
  if (decor) drawFixtures(ctx, decor, view, fx);
  const airClock = snap.airdrop ? serverNow(s.snaps, now) : null;
  const theme = themeOf(mapOf(snap.match.map)?.theme), themeMap = mapOf(snap.match.map);
  if (theme?.under && themeMap) theme.under(ctx, now, view, themeMap);
  // Ambient life (ambient.ts): critters on the floor and wall tops, drawn under every body; the flyers come after the roofs.
  drawAmbientGround(ctx, { snap, s, now, view, dark });
  drawBarrels(ctx, snap, now, view);
  drawProps(ctx, snap, now, view);
  drawRadios(ctx, now, view, dark, reducedMotion());
  if (snap.targets) { const at = serverNow(s.snaps, now); drawTargets(ctx, snap, at === null ? null : at - INTERP_DELAY_MS, now, view); }
  drawBeacon(ctx, snap.airdrop, airClock, now, view);
  if (snap.crates.some((c) => c.drop)) drawDropLabels(ctx, snap.crates, nextPickName(mine?.level ?? 0), now, view);
  drawPlaneShadow(ctx, snap.airdrop, airClock, view);
  if (snap.buildings && snap.run) {
    drawSiegeTops(ctx, snap.buildings.filter((b) => standsUp(b) && inView(view, b.cx * ZOM.cell, b.cy * ZOM.cell, ZOM.cell, ZOM.cell)), wallFlashes(s.effects, now), s.turretAims, snap.run.core, now, k);
  }
  if (snap.run) drawCoreTop(ctx, snap.run, now, s.coreHitAt, k);
  noteGunMap(gunFxOf(s), snap.match.map);
  drawGunFloor(ctx, gunFxOf(s), now, view);
  s.corpses = liveCorpses(s.corpses, snap.match.map, now);
  drawCorpses(ctx, s.corpses.filter((c) => inView(view, c.x - R * 3, c.y - R * 3, R * 6, R * 6)), now, k);
  // The horde is drawn before the night shade, so it dims outside the light pools; its eyes shine over the shade.
  const flashes = hitFlashes(s.effects, now);
  if (zombies.length) drawZombies(ctx, zombies, snap, flashes, now, k);
  // With the shader pass on, the world so far is handed to it to be lit (shadows, lamps, night); the rest of the frame is its overlay.
  const lit = lightWorld(ctx, { snap, selfId: s.myId, selfAngle: f.selfAngle, tl, br, dark, now, airLanded: !!snap.airdrop && airClock !== null && airClock >= snap.airdrop.landAt, solids: [...walls, ...standing, ...crates], occluders: geo ? [...polyOccluders(geoMap!, view), ...doorOccluders(leaves, view)] : undefined, decor, fx });
  if (dark > 0) {
    if (!lit) drawNightFx(ctx, tl, br, dark, now, mood);
    if (zombies.length) drawHordeEyes(ctx, dark);
  }
  drawDust(ctx, tl, br, now, dark);
  drawVignette(ctx, cam.w, cam.h, dpr, 0.36 + 0.2 * dark);
  ctx.setTransform(k, 0, 0, k, dpr * (cam.w / 2 - cam.x * cam.scale), dpr * (cam.h / 2 - cam.y * cam.scale));
  drawRadioOverlay(ctx, now, reducedMotion());
  // Turret ranges and what the siege's guns light (muzzle flashes, lamps, gauges) stand over the night, so they read in the dark.
  if (snap.run && snap.buildings) {
    // `day` here is whether you may build now: by day, or by night with a pistol (the next level's ring, the cursor's and U's target).
    const day = canBuildNow(snap), all = snap.buildings;
    drawSiegeLights(ctx, {
      buildings: all.filter((b) => standsUp(b) && inView(view, b.cx * ZOM.cell, b.cy * ZOM.cell, ZOM.cell, ZOM.cell)), all, aims: s.turretAims, core: snap.run.core, day, ghost: f.ghost ?? null,
      cursor: day && !f.ghost ? f.cursor ?? null : null, upgrade: day && !f.ghost ? upgradeTarget(snap, s.lastSelf)?.b ?? null : null, squadRings: dark > 0.5 && turretRangesOn(),
      walls: s.walls, crates: snap.crates, now, pxPerUnit: k, scale: cam.scale, reduced: reducedMotion(), dark,
    });
  }
  if (rangeLayout && reach && mine && snap.targets) {
    const at = serverNow(s.snaps, now);
    drawReachOverlay(ctx, rangeLayout, s.worldSize, snap.targets, at === null ? 0 : at - INTERP_DELAY_MS, { x0: tl.x, y0: tl.y, x1: br.x, y1: br.y }, cam.scale, mine, reach, now);
  }
  // Zone flags, capture edges and chevrons stand over the night so a point reads from across the screen.
  for (const [i, z] of zones.entries()) if (inView(view, z.x - z.r * 1.5, z.y - z.r * 1.5, z.r * 3, z.r * 3)) drawZoneOverlay(ctx, z, i, now, dark, reducedMotion());
  const clockNow = snap.royale ? serverNow(s.snaps, now) : null;
  if (snap.royale && clockNow !== null) {
    drawRingWorld(ctx, snap.royale, clockNow, tl, br);
    drawDropsWorld(ctx, snap.royale, clockNow, now, ROYALE.dropSize);
  }
  // Tonight's dead lie over the night shade, so the horde's toll stays readable in the dark.
  const field = zombieField(s.zombieCorpses, snap.run?.phase === 'night', now);
  s.zombieCorpses = { list: field.list, dawnAt: field.dawnAt };
  drawZombieCorpses(ctx, field.list.filter((c) => inView(view, c.x - R * 4, c.y - R * 4, R * 8, R * 8)), field.alpha, now, k);

  drawRounds(ctx, snap.bullets, dark > 0.5);
  drawExplosiveRounds(ctx, snap.bullets, now);

  for (const p of downed) drawDowned(ctx, p, colorOf(p), serverNow(s.snaps, now), p.id === s.myId, now, k);
  drawGunGlints(ctx, s.corpses, now, (x, y) => inView(view, x - R, y - R, R * 2, R * 2));
  drawMotionBelow(ctx, now);
  const tags = bodyTags(f.bare ? [] : alive, s, now);
  drawNamesUnderBodies(ctx, tags, dark, now);
  const recoil = kicks(s.effects, now);
  const flinches = flinchOf(s);
  trackDash(snap.players, now);
  drawDashTrails(ctx, (id) => { const p = snap.players.find((q) => q.id === id); return p ? colorOf(p) : null; }, now, view);
  for (const p of alive) {
    const self = p.id === s.myId;
    const angle = self && f.selfAngle !== null ? f.selfAngle : p.angle;
    const flash = flashes.get(p.id);
    const kick = recoil.get(p.id);
    const jolt = flinchOffset(flinches, p.id, now);
    // Everyone's reload arms follow their reload clock; yours is the predicted one, so the hands move the instant you press the key.
    const rl = self && s.firing?.trigger.alive ? selfReload(s.firing, now) : p.rl;
    const reload = stepReload(p.id, p.gun, rl, now);
    // The reload's foley rides the same clock and beats: yours centred and a touch louder, everyone else's in the world.
    reloadFoley.step({ id: p.id, gun: p.gun, x: p.x, y: p.y, self, hidden: p.hidden }, rl, now, { mapId: s.mapId, listener: s.lastSelf, viewRadius: snap.self.viewRadius });
    if (reload?.drops.length) dropMags(gunFxOf(s), p, angle, reload, now, self);
    // A bolt-action's soldier works the bolt after every shot, over exactly the gun's fire interval (see `boltScene`).
    const bolt = stepBolt(p.id, p.gun, kick, now);
    drawPlayer(ctx, { ...p, angle, x: p.x + jolt.x, y: p.y + jolt.y }, colorOf(p), {
      self, rival: !self && p.team === null && p.color === mine?.color,
      flash: flash === undefined ? 0 : 1 - (now - flash) / HIT_FLASH_MS, kick: kick === undefined ? 0 : 1 - (now - kick) / KICK_MS, now, pxPerUnit: k, reload, bolt: reload ? null : bolt,
      sprint: self && s.firing?.trigger.alive ? s.firing.trigger.sprint : p.sprint === true,
    });
    if (p.golden) drawGoldShine(ctx, p.x, p.y, muzzleTip(p.x, p.y, angle, p.gun, R), p.id, now);
  }
  drawEmoteGestures(ctx, alive, colorOf, now, partyOn() ? s.myId : null, reducedMotion());
  for (const t of snap.thrown) if (t.kind !== 'claymore' && t.kind !== 'gasCloud') drawThrown(ctx, t, now);
  for (const t of snap.thrown) if (t.kind === 'gasCloud') drawThrown(ctx, t, now);
  drawEffects(ctx, s.effects.filter((e) => e.kind !== 'flash' && e.kind !== 'boom' && e.kind !== 'slash'), now);
  drawBlastFx(ctx, now, view);
  drawGadgetFx(ctx, snap, now);
  drawArenaLight(ctx, snap, now, view);
  drawPropTops(ctx, snap, now, view);
  drawParachute(ctx, snap.airdrop, airClock, now, view);
  drawParticles(ctx, s.particles, now);
  if (theme?.over && themeMap) theme.over(ctx, now, view, themeMap, alive);
  drawMotionAbove(ctx, now);
  drawSiegeFx(ctx, snap, view, now, dark, k, s.coreHitAt, undefined, undefined, { reduced: reducedMotion(), wrecks: wrecks.list });
  drawGunTop(ctx, gunFxOf(s), now, view);
  // Roofs hang over everything and thin out above you and your squad; they hide nothing the light has not already hidden.
  if (geo?.map.roofs?.length) drawRoofs(ctx, geo, [s.lastSelf, ...snap.players.filter((p) => p.alive && p.id !== s.myId && mine?.team && p.team === mine.team)]);
  drawAmbientSky(ctx, now, view);
  drawBars(ctx, tags, dark);
  if (!f.bare) drawEmoteBubbles(ctx, alive, now, dark);
  // Soldier chatter: skipped under the killcam, slow-motion and the round-end celebration, and for anyone showing an emote.
  const overlay = !!snap.match.winner || ['dl-slowmo', 'dl-play', 'dl-hold', 'dl-settle'].some((c) => !!document?.body?.classList?.contains(c));
  const emoting = (pid: number) => emoteOf(pid, now) !== null;
  if (!f.bare) chatter.tick(snap, s.myId, now, { overlay, emoting });
  if (!overlay && !f.bare) drawChatter(ctx, alive, now, dark, cam.scale, uiScaleFor(cam.w, cam.h), reducedMotion(), emoting);
  if (f.ghost && snap.run) drawGhost(ctx, f.ghost, s.lastSelf, snap.run.core, now, k);
  const killer = f.killerId === null ? undefined : alive.find((p) => p.id === f.killerId);
  if (killer) drawKillerMark(ctx, killer, now, dark);
  const nemesis = killer || f.bare || snap.self.nemesis === null ? undefined : alive.find((p) => p.id === snap.self.nemesis && !p.hidden);
  if (nemesis) drawKillerMark(ctx, nemesis, now, dark, 'NEMESIS');
  if (!f.bare) drawJuice(ctx, f.fxNow ?? now, MARK_Y - 10);
  // What you just picked up, over your own soldier.
  drawGains(ctx, f.fxNow ?? now, mine?.alive ? mine : null, reducedMotion());
}

const BACKDROP = { zoom: 0.75, swayMs: 40_000, fill: 0.85 } as const;
const BACKDROP_MAP = MAPS.plaza;
const backdropSolids: Solid[] = [...curbSolids(BACKDROP_MAP.size), ...wallSolids(BACKDROP_MAP.walls.map((w) => ({ ...w, built: false })))];
const backdropCrates: Solid[] = BACKDROP_MAP.crates.map((c, i) => ({ kind: 'crate', x: c.x - CRATE_SIZE / 2, y: c.y - CRATE_SIZE / 2, w: CRATE_SIZE, h: CRATE_SIZE, wear: [0, 0.35, 0.7, 0.1][i % 4] }));

export function drawBackdrop(ctx: CanvasRenderingContext2D, w: number, h: number, dpr: number, now: number) {
  const { size } = BACKDROP_MAP;
  const zoom = Math.max(BACKDROP.zoom, w / (size * BACKDROP.fill), h / (size * BACKDROP.fill));
  const viewW = w / zoom, viewH = h / zoom;
  const freeX = size - viewW, freeY = size - viewH;
  const x = freeX / 2 + (freeX / 2) * Math.sin(now / BACKDROP.swayMs);
  const y = freeY / 2 + (freeY / 2) * 0.5 * Math.cos(now / BACKDROP.swayMs);
  const k = dpr * zoom;
  ctx.setTransform(k, 0, 0, k, -x * k, -y * k);
  drawGround(ctx, ground.get(BACKDROP_MAP, size, () => backdropSolids, 'static', floorPlanOf('plaza')), x, y, x + viewW, y + viewH);
  drawLooseShadows(ctx, backdropCrates);
  drawSolids(ctx, [...backdropSolids, ...backdropCrates]);
  lightBackdrop(ctx, { x, y }, { x: x + viewW, y: y + viewH }, [...backdropSolids, ...backdropCrates], now);
  drawDust(ctx, { x, y }, { x: x + viewW, y: y + viewH }, now, 0);
  drawVignette(ctx, w, h, dpr, 0.38);
}

function drawThrown(ctx: CanvasRenderingContext2D, t: ThrownView, now: number) {
  if (t.kind === 'gasCloud') return drawGasCloud(ctx, t, now);
  if (t.kind === 'fireSlick') return drawFireSlick(ctx, t, now);
  if (t.kind === 'fragGrenade') drawBlastRing(ctx, t.x, t.y, BLAST_RADIUS[t.kind], now);
  if (isGadget(t.kind)) return drawGadgetBody(ctx, t, now);
  drawThrownBody(ctx, t, now);
}

type RoundLook = { r: number; heft: number; tail: string; body: string; core: string };

/**
 * A round is a lit slug: a warm tracer, a lamp-amber body and a hot white-yellow core, sized by what one round does (a pistol round is
 * modest, a slug, a sniper round or a hand cannon is fat) and leaving a longer, brighter streak the heavier it is. Rounds are light, so no ink outline;
 * at night the same layers glow additively and pick up a faint halo that blooms.
 */
const ROUND = { minR: 3.1, maxR: 7, slugLen: 3.8, trailAlpha: 0.4, trailSlugs: 2.6, heavyTrailSlugs: 6 } as const;
const ROUND_COLORS = { tail: '#ff8a2a', body: '#ffc247', core: '#fff6c8', nightTail: '#ffa84d' } as const;

/** 0..1 how heavy one round is, from its own damage: a 25 pistol round ~0.35, a 70 slug ~0.75, a bolt-action round (or anything heavier) 1. */
export const roundHeft = (gun: GunId | null): number => (gun ? Math.min(1, (GUNS[gun].damage / GUNS.sniper.damage) ** 0.75) : 0.15);

function roundLook(gun: GunId | null, night: boolean): RoundLook {
  const heft = roundHeft(gun);
  const pellet = gun && GUNS[gun].pellets > 1;
  const r = ROUND.minR + (ROUND.maxR - ROUND.minR) * heft + (pellet ? 0.5 : 0);
  return { r, heft, tail: night ? ROUND_COLORS.nightTail : ROUND_COLORS.tail, body: ROUND_COLORS.body, core: ROUND_COLORS.core };
}

function drawRounds(ctx: CanvasRenderingContext2D, bullets: readonly BulletView[], night: boolean) {
  ctx.lineCap = 'round';
  const groups = new Map<GunId | 'none', { look: RoundLook; bullets: BulletView[] }>();
  for (const b of bullets) {
    const key = b.gun ?? 'none';
    const group = groups.get(key);
    if (group) group.bullets.push(b);
    else groups.set(key, { look: roundLook(b.gun, night), bullets: [b] });
  }
  const prev = ctx.globalCompositeOperation;
  for (const { look, bullets: group } of groups.values()) {
    const dirs = group.map((b) => { const v = Math.hypot(b.vx, b.vy) || 1; return { b, ux: b.vx / v, uy: b.vy / v }; });
    const stroke = (color: string, width: number, alpha: number, from: (d: (typeof dirs)[number]) => number, to: (d: (typeof dirs)[number]) => number) => {
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      for (const d of dirs) {
        ctx.moveTo(d.b.x - d.ux * from(d), d.b.y - d.uy * from(d));
        ctx.lineTo(d.b.x - d.ux * to(d), d.b.y - d.uy * to(d));
      }
      ctx.stroke();
    };
    const slug = look.r * ROUND.slugLen;
    const streak = ROUND.trailSlugs + (ROUND.heavyTrailSlugs - ROUND.trailSlugs) * look.heft ** 2;
    if (night) {
      ctx.globalCompositeOperation = 'lighter';
      stroke(look.tail, look.r * 4, 0.1 + 0.08 * look.heft, (d) => slug * streak * 0.8 + Math.hypot(d.b.vx, d.b.vy) * TRACER.tail * 0.5, () => 0);
    }
    // The warm tracer, then the slug body, then the hot core down its middle.
    stroke(look.tail, look.r * 1.5, ROUND.trailAlpha + 0.2 * look.heft, (d) => Math.min(slug * streak, Math.max(slug, Math.hypot(d.b.vx, d.b.vy) * TRACER.tail * 1.4)), () => slug * 0.5);
    stroke(look.body, look.r * 2.3, 1, () => slug, () => 0);
    stroke(look.core, Math.max(1.4, look.r * 1.2), 1, () => slug * 0.85, () => slug * 0.1);
    ctx.globalCompositeOperation = prev;
  }
  ctx.globalAlpha = 1;
}

/** `sprint`: whether the body is sprinting (yours as your own trigger predicts it, so the gun drops and comes up in step with your reticle). */
/** `bolt`: how far (0..1) through working its bolt after a shot a bolt-action soldier is (see `stepBolt`), null when it is not. */
type PlayerLook = { self: boolean; rival: boolean; flash: number; kick: number; now: number; pxPerUnit: number; reload: ReloadFrame | null; bolt: number | null; sprint: boolean };
const TIER_COLORS = { 1: '#c9ced8', 2: PALETTE.gold } as const;
/** How far a gun jumps back in the hands when fired; a heavy gun (see `heftOf`) jumps up to `RECOIL_HEAVY` times as far. */
const RECOIL = 4.5;
const RECOIL_HEAVY = 3.4;
const MARK_Y = -R - 8;
const RING = R + 5;

function drawTierMark(ctx: CanvasRenderingContext2D, stage: 1 | 2) {
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const [width, color] of [[4, 'rgba(28, 31, 38, 0.55)'], [2, TIER_COLORS[stage]]] as const) {
    ctx.lineWidth = width;
    ctx.strokeStyle = color;
    ctx.beginPath();
    for (let i = 0; i < stage; i++) {
      const y = MARK_Y - i * 6;
      ctx.moveTo(-6, y);
      ctx.lineTo(0, y - 4.5);
      ctx.lineTo(6, y);
    }
    ctx.stroke();
  }
}

function drawHuntedMark(ctx: CanvasRenderingContext2D, now: number) {
  const pulse = 0.5 + 0.5 * Math.sin(now / 220);
  const r = R + 9;
  ctx.globalAlpha *= 0.55 + 0.4 * pulse;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.strokeStyle = PALETTE.hunted;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2 + Math.PI / 4;
    ctx.moveTo(Math.cos(a) * (r - 4), Math.sin(a) * (r - 4));
    ctx.lineTo(Math.cos(a) * (r + 4), Math.sin(a) * (r + 4));
  }
  ctx.stroke();
}

/** Each drawn body's walk cycle, from where it was drawn last frame. */
const gaits = new Map<number, Gait>();
let gaitsPrunedAt = 0;

function gaitOf(p: PlayerView, now: number): Gait {
  const g = stepGait(gaits.get(p.id), p.x, p.y, now);
  gaits.set(p.id, g);
  if (!p.hidden) noteStride(p.id, g, p.x, p.y, now, p.sprint === true);
  if (now - gaitsPrunedAt > 5000) {
    gaitsPrunedAt = now;
    for (const [id, o] of gaits) if (now - o.t > 5000) gaits.delete(id);
  }
  return g;
}

/** Each body's sprint carry this frame (see raise.ts `stepCarry`): down into the carry while it sprints, swung back up over its gun's short `swingMsOf` after. */
const sprintOf = (p: PlayerView, sprinting: boolean, now: number): number => stepCarry(p.id, sprinting, swingMsOf(p.gun), now, reducedMotion());

/** Adrenaline and Second Wind: a few short streaks trail behind a body that is running on a boost. */
function drawSpeedLines(ctx: CanvasRenderingContext2D, heading: number, now: number, strength = 1) {
  const back = heading + Math.PI;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#ffe08a';
  for (let i = 0; i < 4; i++) {
    const side = (i - 1.5) * R * 0.5;
    const flick = reducedMotion() ? 0.5 : (now / 90 + i * 0.37) % 1;
    const start = R * (0.9 + 0.5 * flick), len = R * (0.7 + 0.5 * ((i * 7) % 3) / 2);
    ctx.globalAlpha = 0.75 * strength * (1 - flick);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(Math.cos(back) * start - Math.sin(back) * side, Math.sin(back) * start + Math.cos(back) * side);
    ctx.lineTo(Math.cos(back) * (start + len) - Math.sin(back) * side, Math.sin(back) * (start + len) + Math.cos(back) * side);
    ctx.stroke();
  }
  ctx.restore();
}

/** Recon: a small reload arrow over an enemy mid-reload, the moment to push. */
function drawReloadMark(ctx: CanvasRenderingContext2D) {
  ctx.save();
  ctx.fillStyle = 'rgba(28, 31, 38, 0.8)';
  ctx.beginPath();
  ctx.arc(0, -R - 20, 9, 0, TAU);
  ctx.fill();
  strokeIcon(ctx, UI_ICONS.reload, 0, -R - 20, 12, PALETTE.gold, 2.4);
  ctx.restore();
}

/** The magazines a reload lets go of this frame fall to the floor from the hand that held them (the clatter is the reload foley's, by the floor they land on). */
function dropMags(fx: ReturnType<typeof gunFxOf>, p: PlayerView, angle: number, frame: ReloadFrame, now: number, self: boolean) {
  for (const beat of frame.drops) {
    dropCarried(fx, p.x, p.y, angle, reloadScene(p.gun, R, angle, beat, 1), now);
  }
}

function drawPlayer(ctx: CanvasRenderingContext2D, p: PlayerView, color: string, look: PlayerLook) {
  const alpha = p.hidden ? 0.25 : 1;
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.globalAlpha = alpha;
  if (look.self || look.rival) {
    // A ring on the ground under the feet: yours in your colour, a same-coloured rival's dashed red.
    ctx.beginPath();
    ctx.arc(0, 0, RING, 0, TAU);
    if (look.self) {
      ctx.fillStyle = color;
      ctx.globalAlpha = alpha * 0.14;
      ctx.fill();
    }
    ctx.lineWidth = 2;
    ctx.strokeStyle = look.self ? color : PALETTE.rival;
    ctx.globalAlpha = alpha * (look.self ? 0.6 : 0.9);
    if (look.rival) ctx.setLineDash([5, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = alpha;
  }
  const gait = gaitOf(p, look.now);
  const pose = bodyPose(p.id, look.now, gaitAmount(gait));
  ctx.save();
  applyPose(ctx, pose);
  // A reload moves the support hand, tilts the gun and dips the shoulders a hair at each snap (see reloadanim.ts).
  const scene = look.reload ? reloadScene(p.gun, R, p.angle, look.reload.t, look.reload.k) : look.bolt !== null ? boltScene(p.gun, R, p.angle, look.bolt) : null;
  const jump = RECOIL * (1 + (RECOIL_HEAVY - 1) * heftOf(p.gun)) * Math.max(0, look.kick) + (scene && !reducedMotion() ? scene.dip : 0);
  const hands = (scene?.hands ?? heldHands(p.gun, R, p.angle)).map((h) => ({ x: h.x - jump, y: h.y })) as [{ x: number; y: number }, { x: number; y: number }];
  const cos = cosLook(p.cos);
  drawSoldier(ctx, color, 0, 0, R, {
    angle: p.angle, armor: p.armorTier, hands, jump, gait, flash: look.flash, noShadow: pose.lift > 0, sprint: sprintOf(p, look.sprint, look.now) * (1 - (look.reload?.k ?? 0)),
    helmet: cos.helmet, camo: cos.camo, spin: (gait.phase * 3) + (reducedMotion() ? 0 : look.now / 900),
    gun: (g) => {
      g.translate(-jump, 0);
      if (scene) scene.draw(g, p.golden === true, cos.skin);
      else drawHeldGun(g, p.gun, R, p.angle, p.golden === true, cos.skin);
      g.translate(jump, 0);
    },
  }, look.pxPerUnit);
  ctx.globalAlpha = alpha;
  if (p.rush && gait.speed > 30) drawSpeedLines(ctx, gait.heading, look.now);
  // A sprinter trails a faint pair of the same streaks, so a sprint reads as fast even standing next to a walker.
  else if (look.sprint && gait.speed > 250) drawSpeedLines(ctx, gait.heading, look.now, 0.35);
  if (p.reloading && !look.self) drawReloadMark(ctx);
  ctx.globalAlpha = alpha;
  const { stage } = GUNS[p.gun];
  if (p.hunted && !look.self) drawHuntedMark(ctx, look.now);
  ctx.globalAlpha = alpha;
  if (stage !== 0) drawTierMark(ctx, stage);
  if (p.spawnShield) {
    // A bubble over the fresh spawn: a faint blue fill, a pulsing rim, and a glint toward the light.
    const pulse = 0.5 + 0.5 * Math.sin(look.now / 120);
    ctx.beginPath();
    ctx.arc(0, 0, R + 6, 0, TAU);
    ctx.fillStyle = PALETTE.shield;
    ctx.globalAlpha = alpha * (0.1 + 0.05 * pulse);
    ctx.fill();
    ctx.globalAlpha = alpha * (0.5 + 0.3 * pulse);
    ctx.lineWidth = 5.5;
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.globalAlpha = alpha * (0.75 + 0.25 * pulse);
    ctx.lineWidth = 3;
    ctx.strokeStyle = PALETTE.shield;
    ctx.stroke();
    ctx.globalAlpha = alpha * 0.7;
    ctx.lineCap = 'round';
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(0, 0, R + 2, Math.PI * 1.1, Math.PI * 1.4);
    ctx.stroke();
    drawShieldShimmer(ctx, look.now, alpha);
  }
  if (p.shield) {
    // The Shield perk's front guard: a faint, narrow sliver, so a perk half the lobby picks reads as a detail, not a halo round everyone.
    ctx.beginPath();
    ctx.arc(0, 0, R + 4, p.angle - 0.55, p.angle + 0.55);
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.globalAlpha = alpha * 0.55;
    ctx.strokeStyle = PALETTE.shield;
    ctx.stroke();
    ctx.globalAlpha = alpha;
  }
  ctx.restore();
  ctx.restore();
}

/** Your killer while you wait to respawn, and afterwards your nemesis, until you take your revenge. */
function drawKillerMark(ctx: CanvasRenderingContext2D, p: PlayerView, now: number, dark: number, label = 'KILLER') {
  const pulse = 0.5 + 0.5 * Math.sin(now / 200);
  ctx.globalAlpha = 0.65 + 0.35 * pulse;
  ctx.beginPath();
  ctx.arc(p.x, p.y, R + 11, 0, TAU);
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = PALETTE.hunted;
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.font = '800 15px "Barlow Condensed", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  // The callout sits on the same clipped gunmetal plate as a name tag, never loose on the floor.
  const text = `${label} \u00b7 ${p.name}`, ty = p.y + MARK_Y - (GUNS[p.gun].stage ? 12 + 6 * GUNS[p.gun].stage : 6);
  const w = ctx.measureText(text).width + 12, h = 20, x = p.x - w / 2, y = ty - 15, c = 4;
  ctx.fillStyle = TAG.plate;
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  ctx.moveTo(x, y); ctx.lineTo(x + w - c, y); ctx.lineTo(x + w, y + c); ctx.lineTo(x + w, y + h); ctx.lineTo(x + c, y + h); ctx.lineTo(x, y + h - c);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = PALETTE.hunted;
  ctx.fillText(text, p.x, ty);
}

const HURT_SHOW_MS = 1800;
const HURT_FADE_MS = 500;
const TAG_PIP = 11;
const TAG = { bar: R + 7, barW: 36, barH: 3.5, name: R + 22, font: 15, plate: '#131519', plateAlpha: 0.78, ink: '#ece6d6', badge: 20 } as const;

type Tag = { p: PlayerView; bar: number; name: boolean };
let tagsDrawn: { id: number; bar: boolean; name: boolean }[] = [];
export const drawnTags = () => tagsDrawn;

function bodyTags(bodies: readonly PlayerView[], s: Session, now: number): Tag[] {
  const tags = bodies.filter((p) => p.id === s.myId || !p.hidden).map((p) => {
    if (p.id === s.myId) return { p, bar: p.hp < p.maxHp ? 1 : 0, name: false };
    const hurt = s.hurtAt.get(p.id);
    return { p, bar: hurt === undefined ? 0 : Math.max(0, Math.min(1, (HURT_SHOW_MS - (now - hurt)) / HURT_FADE_MS)), name: true };
  });
  tagsDrawn = tags.map((t) => ({ id: t.p.id, bar: t.bar > 0, name: t.name }));
  return tags;
}

/** A clipped plate (the field kit's corners: top right and bottom left cut) at (`x`, `y`), `w` by `h`. */
function plate(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c = 4) {
  ctx.beginPath();
  ctx.moveTo(x, y); ctx.lineTo(x + w - c, y); ctx.lineTo(x + w, y + c); ctx.lineTo(x + w, y + h); ctx.lineTo(x + c, y + h); ctx.lineTo(x, y + h - c);
  ctx.closePath();
}

/** A five-point star of radius `r` at (`x`, `y`), for prestige. */
function starPath(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? r * 0.45 : r;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
}

const CHIP_FONT = `800 ${TAG.font - 3}px "Barlow Condensed", system-ui, sans-serif`;
const TITLE_FONT = `600 ${TAG.font - 3}px "Barlow Condensed", system-ui, sans-serif`;

/** The width the account level chip takes before a name: "34" with the stars of prestige, 0 for a bot or a player without one. */
export function levelChipWidth(ctx: CanvasRenderingContext2D, level: number, prestige: number): number {
  if (level <= 0) return 0;
  ctx.font = CHIP_FONT;
  return ctx.measureText(String(level)).width + (prestige > 0 ? 9 + (prestige > 1 ? ctx.measureText(String(prestige)).width + 1 : 0) : 0) + 9;
}

function drawNamesUnderBodies(ctx: CanvasRenderingContext2D, tags: readonly Tag[], dark: number, now = 0) {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const plateAlpha = TAG.plateAlpha * (dark > 0.5 ? 0.8 : 1);
  // Each name sits on a small gunmetal plate with clipped corners, the HUD's field kit, so it reads on the bone floor by day.
  // A human's account level rides on the plate before the name, and a title under it on a plate of its own.
  const looks = new Map<number, { look: ReturnType<typeof cosLook>; nameW: number; chipW: number }>();
  for (const { p, name } of tags) {
    if (!name) continue;
    const look = cosLook(p.cos);
    ctx.font = `700 ${TAG.font}px "Barlow Condensed", system-ui, sans-serif`;
    const nameW = ctx.measureText(p.name).width;
    looks.set(p.id, { look, nameW, chipW: levelChipWidth(ctx, look.level, look.prestige) });
  }
  ctx.fillStyle = TAG.plate;
  ctx.globalAlpha = plateAlpha;
  for (const { p, name } of tags) {
    const l = looks.get(p.id);
    if (!name || !l) continue;
    const w = l.nameW + 10 + l.chipW + TAG_PIP, h = TAG.font + 5, x = p.x + l.nameW / 2 + 5 - w, y = p.y + TAG.name - TAG.font + 1;
    plate(ctx, x, y, w, h);
    ctx.fill();
    // An ink edge keeps the plate apart from the floor; the colour pip says whose soldier it is.
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = INK;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  for (const { p, name } of tags) {
    const l = looks.get(p.id);
    if (!name || !l) continue;
    const px = p.x - l.nameW / 2 - 5 - l.chipW - TAG_PIP + 7, py = p.y + TAG.name - TAG.font / 2 + 2.5;
    ctx.fillStyle = INK;
    ctx.beginPath(); ctx.arc(px, py, 4.6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = p.team ? TEAM_COLORS[p.team] : COLORS[p.color];
    ctx.beginPath(); ctx.arc(px - 0.3, py - 0.3, 3.2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.beginPath(); ctx.arc(px - 1.3, py - 1.4, 0.9, 0, Math.PI * 2); ctx.fill();
  }
  for (const { p, name } of tags) {
    const l = looks.get(p.id);
    if (!name || !l) continue;
    const baseline = p.y + TAG.name;
    ctx.font = `700 ${TAG.font}px "Barlow Condensed", system-ui, sans-serif`;
    ctx.fillStyle = l.look.nameColor === DEFAULTS.nameColor ? TAG.ink : nameInk(ctx, l.look.nameColor, p.x - l.nameW / 2, l.nameW, now);
    ctx.fillText(p.name, p.x, baseline);
    if (l.chipW > 0) {
      // The chip: a darker well at the plate's left end holding the level in bone, and a gold star for each prestige.
      const cx = p.x - l.nameW / 2 - 5 - l.chipW, h = TAG.font + 5, y = p.y + TAG.name - TAG.font + 1;
      ctx.fillStyle = 'rgba(0, 0, 0, 0.38)';
      plate(ctx, cx, y, l.chipW, h);
      ctx.fill();
      ctx.font = CHIP_FONT;
      ctx.textAlign = 'left';
      ctx.fillStyle = '#c9c4b4';
      ctx.fillText(String(l.look.level), cx + 4.5, baseline - 1);
      if (l.look.prestige > 0) {
        const sx = cx + 4.5 + ctx.measureText(String(l.look.level)).width + 5.5;
        ctx.fillStyle = PALETTE.gold;
        starPath(ctx, sx, baseline - 5.5, 4.2);
        ctx.fill();
        if (l.look.prestige > 1) { ctx.fillStyle = PALETTE.gold; ctx.fillText(String(l.look.prestige), sx + 5, baseline - 1); }
      }
      ctx.textAlign = 'center';
    }
    if (l.look.title !== DEFAULTS.title) {
      const t = COSMETIC_BY_ID.get(l.look.title);
      if (t) {
        ctx.font = TITLE_FONT;
        const tw = ctx.measureText(t.name).width + 10, th = TAG.font - 1, tx = p.x - tw / 2, ty = baseline + 5;
        ctx.fillStyle = TAG.plate;
        ctx.globalAlpha = plateAlpha;
        plate(ctx, tx, ty, tw, th, 3);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.fillStyle = RARITY_INK[t.rarity];
        ctx.fillText(t.name, p.x, ty + th - 3.5);
      }
    }
  }
  // The rarest lifetime medal a player holds rides before their name, so a decorated veteran is plain to see.
  ctx.font = `700 ${TAG.font}px "Barlow Condensed", system-ui, sans-serif`;
  for (const { p, name } of tags) {
    if (!name || !p.badge) continue;
    const img = careerImage(p.badge);
    const l = looks.get(p.id);
    if (!img || !l) continue;
    const x = p.x - l.nameW / 2 - l.chipW - TAG_PIP - TAG.badge - 8;
    ctx.drawImage(img, x, p.y + TAG.name - TAG.badge * 0.78, TAG.badge, TAG.badge);
  }
  // A player on a streak wears a flame and their kill count beside their name: a target worth a shutdown.
  const hot = tags.filter((t) => t.name && t.p.streak).map((t) => ({ p: t.p, x: t.p.x + (looks.get(t.p.id)?.nameW ?? 0) / 2 + 9 }));
  if (!hot.length) return;
  ctx.font = `800 ${TAG.font + 1}px "Barlow Condensed", system-ui, sans-serif`;
  ctx.textAlign = 'left';
  for (const { p, x } of hot) {
    fillIcon(ctx, UI_ICONS.flame, x + 5, p.y + TAG.name - 4, 12, STREAK_INK);
    ctx.fillStyle = STREAK_INK;
    ctx.fillText(String(p.streak), x + 12, p.y + TAG.name);
  }
  ctx.textAlign = 'center';
}

const STREAK_INK = '#ff5a1f';

function drawBars(ctx: CanvasRenderingContext2D, tags: readonly Tag[], dark: number) {
  const ink = dark > 0.5 ? NIGHT.label : PALETTE.label;
  for (const { p, bar } of tags) {
    if (bar <= 0) continue;
    ctx.globalAlpha = bar;
    const x = p.x - TAG.barW / 2, y = p.y + TAG.bar;
    ctx.fillStyle = dark > 0.5 ? 'rgba(230, 235, 245, 0.25)' : 'rgba(40, 44, 52, 0.2)';
    ctx.fillRect(x, y, TAG.barW, TAG.barH);
    const frac = Math.max(0, Math.min(1, p.hp / p.maxHp));
    ctx.fillStyle = frac > 0.35 ? ink : PALETTE.hpBad;
    ctx.fillRect(x, y, TAG.barW * frac, TAG.barH);
  }
  ctx.globalAlpha = 1;
}

