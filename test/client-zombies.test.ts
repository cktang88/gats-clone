/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BUILD_CONTROLS, buildKindForKey, buildRows, hoverOf, nextTier, stepItem, upgradeLine, upgradeTarget, buildSiteOf, downedLine, forecast, ghostAt, inviteLink, outTillDawnText, phaseLine, readyHint, reportRows, reportTitle, runCallouts, squadFromSearch, turretLine, useHint, withSquad,
} from '../src/client/zombies.ts';
import { addMoments, NO_MOMENTS } from '../src/client/moments.ts';
import { aimTurrets, nextCoreHitAt, type TurretAim } from '../src/client/siege.ts';
import type { RunView } from '../src/shared/protocol.ts';
import { BUILDING_KINDS, BUILDINGS, hordeCount, NIGHTS, SIDES, UPGRADE, WALL_TIERS, ZOM, ZOMBIE_KINDS, ZOMBIES, type TurretKind, type ZombieKind } from '../src/shared/defs.ts';
import { MAPS } from '../src/shared/maps.ts';
import { buildRefusal } from '../src/shared/sim/build.ts';
import { build } from '../src/shared/sim/run.ts';
import { snapshotFor, wallViews } from '../src/shared/sim/snapshot.ts';
import { createWorld, newId, type World } from '../src/shared/sim/world.ts';
import { press, run, spawnAt } from './helpers.ts';

const AT = { x: 1380, y: 1525 };

function squadWorld() {
  const w = createWorld('ZOM', 1, 'outpost');
  const p = spawnAt(w, AT.x, AT.y);
  return { w, p };
}

const previewOf = (w: World, id: number, cx: number, cy: number) => {
  const p = w.players.get(id)!;
  const site = buildSiteOf(snapshotFor(w, id), wallViews(w), p);
  return site && buildRefusal(site, 'wall', cx, cy);
};

test('the build preview judges every cell around the builder as the server does', () => {
  const { w, p } = squadWorld();
  w.zombies.push({ id: newId(w), kind: 'brute', x: AT.x + 120, y: AT.y - 60, hp: 1, attackAt: Infinity, vx: 0, vy: 0 });
  spawnAt(w, AT.x - 100, AT.y + 100);
  w.buildings.push({ id: newId(w), kind: 'wall', cx: 28, cy: 27, hp: 1 });
  w.walls.push({ x: 1200, y: 1400, w: 24, h: 140, built: false, material: 'concrete', expiresAt: Infinity });
  const seen = new Set<string | null>();
  for (let cy = 24; cy <= 37; cy++) {
    for (let cx = 20; cx <= 33; cx++) {
      const server = build(structuredClone(w), p.id, 'wall', cx, cy);
      seen.add(server);
      assert.equal(previewOf(w, p.id, cx, cy), server, `cell ${cx},${cy}`);
    }
  }
  assert.deepEqual([...seen].sort(), [null, 'body', 'core', 'cover', 'farFromCore', 'outOfReach', 'taken'].sort(), 'the sweep covered every refusal a cell can earn');
});

test('the ghost judges each kind as the server would build it, and names what it costs or why not', () => {
  const { w, p } = squadWorld();
  w.buildings.push({ id: newId(w), kind: 'cannon', cx: 26, cy: 31, hp: 1, owner: p.id, ammo: 0, nextFireAt: 0 });
  const at = (cx: number, cy: number) => ({ x: (cx + 0.5) * ZOM.cell, y: (cy + 0.5) * ZOM.cell });
  for (const scrap of [BUILDINGS.sentry.cost - 1, 1000]) {
    w.run!.scrap = scrap;
    for (const kind of BUILDING_KINDS) {
      for (const cell of [{ cx: 26, cy: 30 }, { cx: 26, cy: 31 }, { cx: 20, cy: 30 }]) {
        const ghost = ghostAt(buildSiteOf(snapshotFor(w, p.id), wallViews(w), p)!, kind, at(cell.cx, cell.cy), MAPS[w.map].size);
        assert.equal(ghost.refusal, build(structuredClone(w), p.id, kind, cell.cx, cell.cy), `${kind} at ${cell.cx},${cell.cy} with ${scrap} scrap`);
        assert.equal(ghost.kind, kind);
      }
    }
  }
  const site = buildSiteOf(snapshotFor(w, p.id), wallViews(w), p)!;
  assert.equal(ghostAt(site, 'sentry', at(26, 30), MAPS[w.map].size).label, `Sentry · ${BUILDINGS.sentry.cost} scrap`);
  const worn = ghostAt(site, 'wall', at(26, 31), MAPS[w.map].size);
  assert.deepEqual([worn.label, worn.hover?.refund], [`Cannon · level 1/3 · health 10%`, BUILDINGS.cannon.cost / 20], 'the refund is the standing building\'s, for the tenth of it left');
  assert.ok(worn.detail?.split('\n')[0]!.endsWith(`Right click: take down +${BUILDINGS.cannon.cost / 20}`), worn.detail ?? '');
  assert.equal(worn.detail?.split('\n')[1], 'Next: +40% dmg · +18% rate · +10% range · +50% ammo · +40% hp');
  w.buildings[0]!.hp = BUILDINGS.cannon.hp;
  const whole = buildSiteOf(snapshotFor(w, p.id), wallViews(w), p)!;
  assert.equal(ghostAt(whole, 'wall', at(26, 31), MAPS[w.map].size).hover?.refund, BUILDINGS.cannon.cost / 2, 'half back for a whole one');
  w.run!.scrap = 0;
  assert.equal(ghostAt(buildSiteOf(snapshotFor(w, p.id), wallViews(w), p)!, 'cannon', at(26, 30), MAPS[w.map].size).label, `Cannon needs ${BUILDINGS.cannon.cost} scrap`);
});

test('in build mode 1 to 9 pick wall, the turrets and the utilities, and the hint bar lists them by category with their costs', () => {
  assert.deepEqual(['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0', 'KeyB'].map(buildKindForKey),
    ['wall', 'sentry', 'cannon', 'scatter', 'mortar', 'tesla', 'depot', 'post', 'spikes', null, null]);
  const rows = buildRows();
  assert.deepEqual(rows.map((r) => r.label), ['WALLS', 'TURRETS', 'UTILITY']);
  assert.deepEqual(rows[0]!.chips.map((c) => [c.key, c.what, c.pick]), WALL_TIERS.map((t, i) => [['I', 'II', 'III'][i], `${t.name} ${t.cost}`, { kind: 'wall', lv: i + 1 }]));
  assert.deepEqual(rows[1]!.chips.map((c) => [c.key, c.what, c.pick]), [
    ['2', `Sentry ${BUILDINGS.sentry.cost}`, { kind: 'sentry' }], ['3', `Cannon ${BUILDINGS.cannon.cost}`, { kind: 'cannon' }], ['4', `Scatter ${BUILDINGS.scatter.cost}`, { kind: 'scatter' }],
    ['5', `Mortar ${BUILDINGS.mortar.cost}`, { kind: 'mortar' }], ['6', `Tesla coil ${BUILDINGS.tesla.cost}`, { kind: 'tesla' }],
  ]);
  assert.deepEqual(rows[2]!.chips.map((c) => [c.key, c.what, c.pick]), [
    ['7', `Ammo depot ${BUILDINGS.depot.cost}`, { kind: 'depot' }], ['8', `Repair post ${BUILDINGS.post.cost}`, { kind: 'post' }], ['9', `Spike strip ${BUILDINGS.spikes.cost}`, { kind: 'spikes' }],
  ]);
  assert.ok(BUILD_CONTROLS.some((c) => c.key === 'U' && c.pick && 'upgrade' in c.pick), 'the controls row has the upgrade chip');
});

test('a wall key steps the tier and the wheel steps every item, both wrapping round', () => {
  assert.deepEqual([1, 2, 3].map(nextTier), [2, 3, 1]);
  assert.deepEqual(stepItem({ kind: 'wall', lv: 3 }, 1), { kind: 'sentry', lv: 1 });
  assert.deepEqual(stepItem({ kind: 'wall', lv: 1 }, -1), { kind: 'spikes', lv: 1 });
  assert.deepEqual(stepItem({ kind: 'wall', lv: 1 }, 1), { kind: 'wall', lv: 2 });
  let at = { kind: 'wall' as const, lv: 1 };
  const seen = new Set<string>();
  for (let i = 0; i < 11; i++) { at = stepItem(at, 1) as typeof at; seen.add(`${at.kind}${at.lv}`); }
  assert.equal(seen.size, 11, 'eleven steps visit eleven different items, ending where they began');
});

test('hovering a building in build mode names its level, health and what upgrading costs, and the ghost judges the upgrade as the server does', () => {
  const { w, p } = squadWorld();
  w.run!.scrap = 1000;
  build(w, p.id, 'wall', 26, 30, 2);
  const at = (cx: number, cy: number) => ({ x: (cx + 0.5) * ZOM.cell, y: (cy + 0.5) * ZOM.cell });
  let g = ghostAt(buildSiteOf(snapshotFor(w, p.id), wallViews(w), p)!, 'sentry', at(26, 30), MAPS[w.map].size);
  assert.equal(g.refusal, 'taken');
  assert.deepEqual(g.hover, { name: 'Sandbag wall', lv: 2, top: 3, hpPct: 100, refund: WALL_TIERS[1].cost / 2, next: { name: 'Steel wall', cost: WALL_TIERS[2].cost - WALL_TIERS[1].cost, gains: '+140% hp · blocks 30% of bites' } });
  assert.equal(g.label, 'Sandbag wall · level 2/3 · health 100%');
  assert.equal(g.upgrade, null);
  assert.ok(g.detail?.startsWith(`U or click: upgrade to Steel wall · ${WALL_TIERS[2].cost - WALL_TIERS[1].cost} scrap`), g.detail ?? '');
  assert.ok(g.detail?.endsWith('\nNext: +140% hp · blocks 30% of bites'), 'what the step up gives sits on its own line');
  w.run!.scrap = 5;
  g = ghostAt(buildSiteOf(snapshotFor(w, p.id), wallViews(w), p)!, 'sentry', at(26, 30), MAPS[w.map].size);
  assert.equal(g.upgrade, 'scrap');
  assert.equal(upgradeLine(g.hover!, g.upgrade), `Upgrade to Steel wall needs ${WALL_TIERS[2].cost - WALL_TIERS[1].cost} scrap`);
  w.buildings[0]!.lv = 3;
  assert.equal(upgradeLine(hoverOf({ kind: 'wall', cx: 26, cy: 30, hp: 10, lv: 3 }), 'maxed'), 'Fully upgraded');
  assert.equal(upgradeLine(hoverOf({ kind: 'spikes', cx: 26, cy: 30, hp: 10 }), 'maxed'), 'No upgrades');
});

test('outside build mode U upgrades the nearest building in reach that can step up, by day', () => {
  const { w, p } = squadWorld();
  w.run!.scrap = 1000;
  build(w, p.id, 'wall', 26, 30, 3);
  build(w, p.id, 'sentry', 26, 31);
  const near = upgradeTarget(snapshotFor(w, p.id), p);
  assert.deepEqual([near?.b.kind, near?.to], ['sentry', 'Sentry II'], 'the steel wall has nowhere to go, so the sentry beside it is the target');
  assert.equal(near?.cost, Math.round(BUILDINGS.sentry.cost * UPGRADE.costShare[0]));
  w.run!.phase = { k: 'night', toSpawn: [], nextSpawnAt: Infinity, dawnAt: Infinity };
  assert.equal(upgradeTarget(snapshotFor(w, p.id), p), null, 'no building is upgraded at night');
});

test('holding E is offered to reload a turret short of ammo, to repair it first when worn, nearest first', () => {
  const { w, p } = squadWorld();
  const turret = { id: newId(w), kind: 'sentry' as const, cx: 26, cy: 30, hp: BUILDINGS.sentry.hp, owner: p.id, ammo: BUILDINGS.sentry.turret.ammo, nextFireAt: 0 };
  w.buildings.push(turret);
  assert.equal(useHint(snapshotFor(w, p.id), p), null, 'a full turret needs nothing');
  turret.ammo = 10;
  assert.equal(useHint(snapshotFor(w, p.id), p), 'Hold E to reload the sentry');
  turret.hp = 100;
  assert.equal(useHint(snapshotFor(w, p.id), p), 'Hold E to repair the sentry');
  w.buildings.push({ id: newId(w), kind: 'cannon', cx: 27, cy: 30, hp: BUILDINGS.cannon.hp, owner: p.id, ammo: 0, nextFireAt: 0 });
  assert.equal(useHint(snapshotFor(w, p.id), p), 'Hold E to reload the cannon', 'the cannon is the nearer');
});

test('a turret\'s barrel takes the angle of its last shot, and its aim is forgotten once it is gone', () => {
  const { w, p } = squadWorld();
  const aims = new Map<string, TurretAim>();
  const shot = (kind: TurretKind, angle: number) => ({ e: 'turret' as const, kind, x: 26.5 * ZOM.cell, y: 30.5 * ZOM.cell, angle });
  w.buildings.push({ id: newId(w), kind: 'sentry', cx: 26, cy: 30, hp: 1, owner: p.id, ammo: 100, nextFireAt: 0 });
  aimTurrets(aims, { ...snapshotFor(w, p.id), events: [shot('sentry', 1)] }, 100);
  aimTurrets(aims, { ...snapshotFor(w, p.id), events: [shot('sentry', 2)] }, 200);
  assert.deepEqual(aims.get('26,30'), { to: 2, drawn: 1, at: 100, firedAt: 200 });
  w.buildings = [];
  aimTurrets(aims, snapshotFor(w, p.id), 300);
  assert.equal(aims.size, 0);
});

test('the report sums the squad\'s turret kills by kind and the Bastion\'s, and leaves the line off when they killed none', () => {
  const report = { night: 4, won: false, survivors: 0, durationMs: 1, players: [], turretKills: { sentry: 0, cannon: 0, scatter: 0, mortar: 0, tesla: 0 }, bastionKills: 0 };
  assert.equal(turretLine(report), null);
  assert.equal(turretLine({ ...report, turretKills: { sentry: 41, cannon: 7, scatter: 0, mortar: 3, tesla: 0 }, bastionKills: 12 }), 'Defense kills · Sentry 41 · Cannon 7 · Mortar 3 · Bastion 12');
  assert.equal(turretLine({ ...report, bastionKills: 2 }), 'Defense kills · Bastion 2');
});

test('the build preview refuses at night, while down, and when the bank is short, as the server does', () => {
  const cases: [string, (w: World, id: number) => void][] = [
    ['notDay', (w) => { w.run!.phase = { k: 'night', toSpawn: [], nextSpawnAt: Infinity, dawnAt: Infinity }; }],
    ['notDay', (w, id) => { w.players.get(id)!.life = { k: 'downed', bleedOutAt: Infinity, reviveProgress: 0, hp: 0 }; }],
    ['scrap', (w) => { w.run!.scrap = BUILDINGS.wall.cost - 1; }],
  ];
  for (const [reason, arrange] of cases) {
    const { w, p } = squadWorld();
    arrange(w, p.id);
    assert.equal(previewOf(w, p.id, 26, 30), reason);
    assert.equal(build(w, p.id, 'wall', 26, 30), reason);
  }
});

test('an invite link names a squad, and a broken one says so instead of joining nowhere', () => {
  assert.equal(squadFromSearch('?squad=z-ab2c7d'), 'z-ab2c7d');
  assert.equal(squadFromSearch('?dev&squad=z-ab2c7d'), 'z-ab2c7d');
  assert.equal(squadFromSearch('?dev'), null);
  for (const bad of ['?squad=', '?squad=z-ABCDEF', '?squad=ffa', '?squad=z-abc18x', '?squad=z-abcdefg']) assert.equal(squadFromSearch(bad), 'bad', bad);
});

test('the invite link carries only the squad, while the page keeps its own parameters', () => {
  assert.equal(inviteLink('http://localhost:8080/?dev&lag=50', 'z-ab2c7d'), 'http://localhost:8080/?squad=z-ab2c7d');
  assert.equal(withSquad('http://localhost:8080/?dev', 'z-ab2c7d'), 'http://localhost:8080/?dev=&squad=z-ab2c7d');
  assert.equal(withSquad('http://localhost:8080/?dev=&squad=z-ab2c7d', null), 'http://localhost:8080/?dev=');
});

test('the build preview reads the builder from where the client draws them', () => {
  const { w, p } = squadWorld();
  const snap = snapshotFor(w, p.id);
  const far = buildSiteOf(snap, wallViews(w), { x: AT.x - 7 * ZOM.cell, y: AT.y })!;
  assert.equal(buildRefusal(far, 'wall', 26, 30), 'outOfReach', 'the drawn position decides reach, not the snapshot\'s');
  const near = buildSiteOf(snap, wallViews(w), { x: AT.x, y: AT.y - 3 * ZOM.cell })!;
  assert.equal(buildRefusal(near, 'wall', 26, 30), null, 'the builder\'s own body moves with them');
});

const runView = (over: Partial<RunView> = {}): RunView => ({
  phase: 'day', night: 2, phaseEndsAt: 50_000, scrap: 120, core: { x: 1500, y: 1500, hp: 3000, maxHp: 4000 }, aliveZombies: 0, waveLeft: 0,
  survivors: 38, lost: 0, ready: [], report: null, ...over,
});

test('the phase line counts the day down to night, the night\'s wave down to dawn, and the report down to the next run', () => {
  assert.equal(phaseLine(runView(), 19_000), 'Day 2 · night in 0:31');
  assert.equal(phaseLine(runView(), null), 'Day 2', 'no countdown before the server clock is known');
  assert.equal(phaseLine(runView({ phase: 'night', night: 3, phaseEndsAt: null, waveLeft: 12 }), 19_000), 'Night 3 · 12 left');
  assert.equal(phaseLine(runView({ phase: 'night', night: 3, phaseEndsAt: 109_000, waveLeft: 4 }), 19_000), 'Night 3 · 4 left · first light in 1:30', 'once the last pack is in, first light counts down');
  assert.equal(phaseLine(runView({ phase: 'over', phaseEndsAt: 30_000 }), 16_000), 'The Bastion fell · next run in 0:14');
  const held = { night: 13, won: true, survivors: 0, durationMs: 0, players: [], turretKills: { sentry: 0, cannon: 0, scatter: 0, mortar: 0, tesla: 0 }, bastionKills: 0 };
  assert.equal(phaseLine(runView({ phase: 'over', phaseEndsAt: 30_000, report: held }), 16_000), 'The Bastion fell · the Tide held · next run in 0:14');
  assert.equal(phaseLine(runView({ phase: 'night', night: 12, phaseEndsAt: null, waveLeft: 80 }), 19_000), 'Night 12 · Endless · 80 left', 'past the Tide the nights go on');
  assert.equal(phaseLine(runView({ night: 11 }), null), 'Day 11 · Endless');
  assert.equal(phaseLine(runView({ night: NIGHTS.length }), null), `Day ${NIGHTS.length}`);
});

test('a downed player is told how long they have, or that help is on the way', () => {
  assert.equal(downedLine({ revive: 0, bleedOutAt: 40_000 }, 22_000), 'Crawl to a squadmate · 0:18');
  assert.equal(downedLine({ revive: 0.45, bleedOutAt: 40_000 }, 22_000), 'Being revived · 45%');
  assert.equal(outTillDawnText(runView({ phase: 'night', waveLeft: 9 }), true, 11_200).sub, `The Bastion sends you back in 12s · ${ZOM.reinforce.survivors(2)} survivors lost`);
  assert.equal(outTillDawnText(runView({ phase: 'night', waveLeft: 9, survivors: ZOM.reinforce.survivors(2) - 1 }), true, 0).sub, 'Back at dawn · 9 zombies left tonight', 'too few left to send anyone');
  assert.equal(outTillDawnText(runView({ phase: 'night' }), true, 0).title, 'You bled out');
  assert.equal(outTillDawnText(runView({ phase: 'night', waveLeft: 4 }), false, 0).sub, 'Back at dawn · 4 zombies left tonight', 'a night joiner waits for dawn');
});

test('holding E is offered for a downed squadmate in reach before a worn wall, and never with an empty bank for repairs', () => {
  const { w, p } = squadWorld();
  w.buildings.push({ id: newId(w), kind: 'wall', cx: 26, cy: 30, hp: 100 });
  assert.equal(useHint(snapshotFor(w, p.id), p), 'Hold E to repair the barricade');
  const mate = spawnAt(w, AT.x + 50, AT.y, { name: 'Ann' });
  mate.life = { k: 'downed', bleedOutAt: Infinity, reviveProgress: 0, hp: 0 };
  assert.equal(useHint(snapshotFor(w, p.id), p), 'Hold E to revive Ann');
  mate.x += ZOM.reviveRange;
  w.run!.scrap = 0;
  assert.equal(useHint(snapshotFor(w, p.id), p), null, 'out of revive range and no scrap to repair with');
});

test('holding E is offered for the worn core in reach, after a nearer worn wall, as the server picks', () => {
  const { w, p } = squadWorld();
  w.run!.core.hp = ZOM.coreHp - 100;
  assert.equal(useHint(snapshotFor(w, p.id), p), 'Hold E to repair the Bastion');
  w.buildings.push({ id: newId(w), kind: 'wall', cx: 26, cy: 30, hp: 100 });
  assert.equal(useHint(snapshotFor(w, p.id), p), 'Hold E to repair the barricade');
  w.buildings = [];
  p.x = 1500 - ZOM.reachPx - 10;
  assert.equal(useHint(snapshotFor(w, p.id), p), null, 'out of reach of the core');
});

test('the run forecasts tonight ten seconds ahead and at dawn, announces nightfall with its wave and sides, and dawn with the survivors and their scrap', () => {
  const titles = (prev: RunView, next: RunView, prevAt: number, nextAt: number) => runCallouts(prev, next, prevAt, nextAt, 1).map((c) => c.title);
  assert.deepEqual(runCallouts(runView(), runView(), 39_000, 40_000, 1).map((c) => [c.title, c.line]), [['Night falls in 10', forecast(2, 1)]]);
  assert.deepEqual(titles(runView(), runView(), 40_000, 41_000), [], 'once, as the countdown crosses ten seconds');
  const night = runView({ phase: 'night', phaseEndsAt: null, waveLeft: 31 });
  const call = runCallouts(runView(), night, 49_000, 50_000, 1);
  assert.deepEqual(call.map((c) => [c.title, c.line]), [['Night 2', `31 zombies from the ${NIGHTS[1]!.from.join(' and ')} · hold the Bastion`]]);
  const dawn = runCallouts({ ...night, scrap: 60 }, runView({ night: 3, scrap: 96, survivors: 36, lost: 2 }), 90_000, 91_000, 1);
  assert.deepEqual(dawn.map((c) => [c.title, c.line]), [['Dawn', 'Night 2 held · 2 lost · 36 survivors · +36 scrap'], ['Tonight', forecast(3, 1)]]);
  assert.equal(runCallouts(runView({ night: 4 }), runView({ phase: 'night', night: 5, phaseEndsAt: null }), 0, 1, 1)[0]!.title, 'The Colossus', 'a boss night goes by its name');
  assert.deepEqual(titles(night, runView({ phase: 'over', phaseEndsAt: 110_000 }), 90_000, 91_000), [], 'the report announces the fall');
  assert.deepEqual(runCallouts(undefined, night, 0, 1, 1), [], 'nothing on the first snapshot of a session');
  const tide = runCallouts(runView({ phase: 'night', night: NIGHTS.length, phaseEndsAt: null }), runView({ night: NIGHTS.length + 1, survivors: 22 }), 0, 1, 1);
  assert.deepEqual(tide.map((c) => [c.title, c.line]), [['THE TIDE HELD', '22 survivors saw the morning · the nights go on'], ['Tonight', forecast(NIGHTS.length + 1, 1)]], 'the Tide held is the big moment, and the run goes on');
  assert.equal(runCallouts(runView({ night: 11 }), runView({ phase: 'night', night: 11, phaseEndsAt: null }), 0, 1, 1)[0]!.title, 'Night 11 · Endless');
});

test('the fall clears every callout, so none shows through behind the report', () => {
  const { w, p } = squadWorld();
  const day = snapshotFor(w, p.id);
  w.run!.phase = { k: 'night', toSpawn: [{ kind: 'walker', side: 'north', n: 1 }], nextSpawnAt: Infinity, dawnAt: Infinity };
  const night = snapshotFor(w, p.id);
  const announced = addMoments(NO_MOMENTS, day, night, 1000);
  assert.deepEqual(announced.callouts.map((c) => c.title), ['Night 1']);
  w.run!.phase = { k: 'over', night: 1, won: false, restartAt: Infinity };
  assert.deepEqual(addMoments(announced, night, snapshotFor(w, p.id), 1100).callouts, []);
});

test('the run report ranks the squad by kills, then revives, and marks you', () => {
  const report = { night: 4, won: false, survivors: 0, durationMs: 372_000, players: [
    { name: 'Bo', kills: 12, revives: 0, built: 9 }, { name: 'Ann', kills: 30, revives: 1, built: 0 }, { name: 'Cy', kills: 12, revives: 4, built: 7 },
  ], turretKills: { sentry: 0, cannon: 0, scatter: 0, mortar: 0, tesla: 0 }, bastionKills: 0 };
  assert.deepEqual(reportRows(report, 'Cy').map((r) => [r.name, r.you]), [['Ann', false], ['Cy', true], ['Bo', false]]);
  assert.equal(reportTitle(report), 'The Bastion fell on night 4');
  assert.equal(reportTitle({ ...report, night: 14, won: true }), 'The Tide held. The Bastion fell on night 14, 4 past the Tide.');
});

test('the core alert starts on a bite by night and clears the moment dawn or the report arrives', () => {
  const night = (hp: number) => runView({ phase: 'night', core: { x: 1500, y: 1500, hp, maxHp: ZOM.coreHp } });
  assert.equal(nextCoreHitAt(night(4000), night(3990), 500, -Infinity), 500, 'a bite starts the alert');
  assert.equal(nextCoreHitAt(night(3990), night(3990), 600, 500), 500, 'no bite keeps the last one');
  assert.equal(nextCoreHitAt(night(3990), runView({ phase: 'day', core: { x: 1500, y: 1500, hp: 3990, maxHp: ZOM.coreHp } }), 700, 500), -Infinity, 'dawn clears it');
  assert.equal(nextCoreHitAt(night(10), runView({ phase: 'over', core: { x: 1500, y: 1500, hp: 0, maxHp: ZOM.coreHp } }), 700, 600), -Infinity, 'the report clears it');
});

test('the forecast names each night\'s kinds and sides from the night table, and nothing else', () => {
  NIGHTS.forEach((row, i) => {
    const line = forecast(i + 1, 1).toLowerCase();
    for (const kind of ZOMBIE_KINDS) assert.equal(line.includes(ZOMBIES[kind].many), kind in row.horde, `night ${i + 1}: ${line} and the ${kind}`);
    for (const side of SIDES) assert.equal(line.includes(side), row.from.length < SIDES.length && row.from.includes(side), `night ${i + 1}: ${line} and the ${side}`);
  });
  assert.equal(forecast(1, 1), `Brutes and walkers from the north · ${NIGHTS[0]!.horde.walker! + NIGHTS[0]!.horde.brute!} strong`);
  assert.ok(forecast(NIGHTS.length, 1).includes('from every side'));
  assert.match(forecast(NIGHTS.length + 2, 1), /^Endless · A colossus, brutes, .* from every side · \d+ strong$/);
});

test('the forecast puts the deadliest kinds first and sizes the horde for the squad, so one night reads apart from the next', () => {
  const kinds = (line: string) => line.split(' from ')[0]!.toLowerCase().split(/, | and /);
  for (let night = 1; night <= NIGHTS.length; night++) {
    const order = kinds(forecast(night, 1)).map((many) => ZOMBIE_KINDS.find((k) => ZOMBIES[k].many === many)!);
    assert.deepEqual(order, [...order].sort((a, b) => ZOMBIES[b].score - ZOMBIES[a].score), `night ${night}: ${forecast(night, 1)}`);
  }
  assert.ok(kinds(forecast(3, 1)).indexOf('brutes') < kinds(forecast(3, 1)).indexOf('runners'), 'brutes before runners');
  const size = (night: number, share: number) => Number(/· (\d+) strong$/.exec(forecast(night, share))![1]);
  const all = (night: number, share: number) => Object.entries(NIGHTS[night - 1]!.horde).reduce((n, [k, listed]) => n + hordeCount(k as ZombieKind, listed, share), 0);
  assert.equal(size(9, 1), all(9, 1));
  assert.equal(size(9, 0.375), all(9, 0.375), 'a lone human hears of a smaller horde');
  assert.notEqual(size(8, 1), size(9, 1));
});

test('the N hint counts the humans ready for night', () => {
  const players = [{ id: 1, kind: 'human' as const, alive: true }, { id: 2, kind: 'human' as const, alive: true }, { id: 3, kind: 'bot' as const, alive: true }];
  assert.equal(readyHint(runView(), players, 1), 'ready for night · 0/2');
  assert.equal(readyHint(runView({ ready: [1] }), players, 1), 'ready · 1/2 · N to wait');
  assert.equal(readyHint(runView(), players.slice(0, 1), 1), 'bring the night now');
});

test('holding E names the job the server does, even for a building a sliver short of whole', () => {
  const { w, p } = squadWorld();
  w.run!.scrap = 100;
  const wall = { id: newId(w), kind: 'wall' as const, cx: 26, cy: 30, hp: BUILDINGS.wall.hp - 1 };
  w.buildings.push(wall);
  assert.equal(useHint(snapshotFor(w, p.id), p), 'Hold E to repair the barricade');
  press(w, p, { use: true });
  run(w, 100);
  assert.equal(wall.hp, BUILDINGS.wall.hp, 'and the server mends that wall');
  const sentry = { id: newId(w), kind: 'sentry' as const, cx: 26, cy: 31, hp: BUILDINGS.sentry.hp, owner: p.id, ammo: BUILDINGS.sentry.turret.ammo - 0.5, nextFireAt: 0 };
  w.buildings = [sentry];
  assert.equal(useHint(snapshotFor(w, p.id), p), 'Hold E to reload the sentry');
});
