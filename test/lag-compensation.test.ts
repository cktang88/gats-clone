import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GUNS, rulesOf, WORLD } from '../src/shared/defs.ts';
import { flightSec } from '../src/shared/sim/ballistics.ts';
import { INTERP_DELAY_MS, parseClientMsg, type GameEvent } from '../src/shared/protocol.ts';
import { setInput, step } from '../src/shared/sim.ts';
import { flyThroughPast, MAX_REWIND_MS, rewindCapFor } from '../src/shared/sim/combat.ts';
import { type Bullet, IDLE_INPUT, type Player, type Wall, type World } from '../src/shared/sim/world.ts';
import { emptyWorld, equip, press, run, spawnAt, TICK_MS } from './helpers.ts';

let seq = 1_000_000;
function fireSeeing(w: World, shooter: Player, angle: number, viewAt: number | null, rewindCapMs = MAX_REWIND_MS): GameEvent[] {
  setInput(w, shooter.id, seq++, { ...IDLE_INPUT, angle, fire: true, shots: shooter.input.shots + 1 }, viewAt, rewindCapMs);
  step(w, TICK_MS);
  const events = [...w.events];
  setInput(w, shooter.id, seq++, { ...IDLE_INPUT, angle, shots: shooter.input.shots }, viewAt, rewindCapMs);
  for (let t = 0; t < 500; t += TICK_MS) { step(w, TICK_MS); events.push(...w.events); }
  return events;
}

const hitOn = (events: GameEvent[], victim: Player) => events.some((e) => e.e === 'dmg' && e.kind === 'player' && e.victim === victim.id);

function victimThatSteppedAside(walls: Wall[] = []): { w: World; shooter: Player; victim: Player; sawAt: number } {
  const w = emptyWorld();
  w.walls.push(...walls);
  const shooter = spawnAt(w, 500, 500);
  const victim = spawnAt(w, 640, 500);
  run(w, 500);
  const sawAt = w.now - 100;
  press(w, victim, { down: true });
  while (victim.y - 500 <= WORLD.playerRadius * 2 + 2) step(w, TICK_MS);
  press(w, victim, {});
  return { w, shooter, victim, sawAt };
}

test('a shot at where the shooter saw a victim who has since stepped aside hits', () => {
  const { w, shooter, victim, sawAt } = victimThatSteppedAside();
  assert.ok(victim.y - 500 > WORLD.playerRadius * 2, `victim left the line of fire (y ${victim.y})`);
  assert.ok(hitOn(fireSeeing(w, shooter, 0, sawAt), victim), 'judged against the world the shooter drew');
});

test('the same shot with no view time misses the victim who stepped aside', () => {
  const { w, shooter, victim } = victimThatSteppedAside();
  assert.ok(!hitOn(fireSeeing(w, shooter, 0, null), victim), 'judged against the present');
});

test('a rewound shot stops at a wall standing between shooter and the rewound victim', () => {
  const { w, shooter, victim, sawAt } = victimThatSteppedAside([{ x: 600, y: 450, w: 20, h: 100, built: false, material: 'concrete', expiresAt: Infinity }]);
  const events = fireSeeing(w, shooter, 0, sawAt);
  assert.ok(!hitOn(events, victim), 'no hit through the wall');
  assert.ok(events.some((e) => e.e === 'impact' && e.x === 600), 'the bullet struck the wall face');
});

test('a rewound shot stops at a built wall that stood when the shooter saw the victim and has since expired', () => {
  const { w, shooter, victim, sawAt } = victimThatSteppedAside([{ x: 600, y: 450, w: 20, h: 100, built: true, expiresAt: 450 }]);
  assert.ok(sawAt < 450, 'the wall stood when the shooter saw the victim');
  assert.equal(w.walls.length, 0, 'the wall has expired');
  assert.ok(!hitOn(fireSeeing(w, shooter, 0, sawAt), victim), 'no hit through the wall as it stood');
});

/** How long after reaching cover a victim can still be hit by a shooter who claims to have seen the world at time 0. */
function latestHitAfterCover(rewindCapMs: number, range: number): number {
  let latest = -Infinity;
  for (let delayMs = 0; delayMs <= MAX_REWIND_MS + 200; delayMs += TICK_MS) {
    const w = emptyWorld();
    const shooter = spawnAt(w, 700 - range, 380);
    const victim = spawnAt(w, 700, 380);
    w.walls.push({ x: 600, y: 400, w: 20, h: 300, built: false, material: 'concrete', expiresAt: Infinity });
    run(w, 300);
    press(w, victim, { down: true });
    while (victim.y - 380 <= WORLD.playerRadius + range * GUNS.pistol.spread) step(w, TICK_MS);
    press(w, victim, {});
    const coveredAt = w.now;
    run(w, delayMs);
    const firedAt = w.now + TICK_MS;
    if (hitOn(fireSeeing(w, shooter, 0, 0, rewindCapMs), victim)) latest = Math.max(latest, firedAt - coveredAt);
  }
  return latest;
}

const RTT_MS = 40;
for (const [label, capMs] of [['the rewind cap', MAX_REWIND_MS], [`a ${RTT_MS}ms round trip's cap`, rewindCapFor(RTT_MS)]] as const) {
  test(`a victim who reached cover can be hit only for ${label} less the bullet's flight, however far back the client claims to see`, (t) => {
    const range = 130;
    const flightMs = flightSec(GUNS.pistol.bulletSpeed, range, rulesOf(GUNS.pistol).muzzleBoost) * 1000;
    const latest = latestHitAfterCover(capMs, range);
    t.diagnostic(`latest hit ${Math.round(latest)}ms after reaching cover (cap ${Math.round(capMs)}ms, flight ${Math.round(flightMs)}ms)`);
    assert.ok(latest >= 0, 'a shot fired just after the victim reached cover still lands');
    assert.ok(latest <= capMs - flightMs + TICK_MS, `latest hit ${Math.round(latest)}ms after cover`);
  });
}

test('a measured round trip caps the rewind at the round trip plus the render delay and a margin, never above the global cap', () => {
  assert.equal(rewindCapFor(null), MAX_REWIND_MS, 'unmeasured clients get the full cap');
  assert.ok(rewindCapFor(RTT_MS) < MAX_REWIND_MS / 1.5, `a ${RTT_MS}ms round trip caps at ${rewindCapFor(RTT_MS)}ms`);
  assert.ok(rewindCapFor(RTT_MS) >= RTT_MS + INTERP_DELAY_MS + 50, 'covers the view a lagged client really drew, with room for jitter');
  assert.equal(rewindCapFor(1000), MAX_REWIND_MS);
});

test('input parsing keeps a numeric view time and drops anything else', () => {
  const input = { ...IDLE_INPUT };
  const viewAtOf = (viewAt: unknown) => {
    const msg = parseClientMsg(JSON.stringify({ t: 'input', seq: 1, input, viewAt }));
    assert.ok(msg?.t === 'input');
    return msg.viewAt;
  };
  assert.equal(viewAtOf(1234.5), 1234.5);
  assert.equal(viewAtOf(-50), 0);
  assert.equal(viewAtOf('1234'), null);
  assert.equal(viewAtOf(undefined), null);
});

test('a shooter killed by their own rewound blast round in their tick does not use their ability after dying', () => {
  const w = emptyWorld();
  // Cover right at the muzzle: the blast round bursts on it at once, inside the shooter's own tick because it flies through the past.
  w.walls = [{ x: 540, y: 400, w: 40, h: 200, built: false, material: 'concrete', expiresAt: Infinity }];
  const p = spawnAt(w, 500, 500);
  equip(p, 'grenadier');
  p.perks = { 3: 'fragGrenade' };
  run(w, 300);
  if (p.life.k === 'alive') p.life.hp = 1;
  setInput(w, p.id, seq++, { ...IDLE_INPUT, angle: 0, fire: true, shots: p.input.shots + 1, ability: true }, w.now - 100);
  step(w, TICK_MS);
  assert.equal(p.life.k, 'dead', 'the point-blank blast killed its shooter');
  assert.ok(w.events.some((e) => e.e === 'shot' && e.owner === p.id), 'the round left');
  assert.equal(w.thrown.length, 0, 'no grenade thrown by the dead');
});

test('a rewound shot sees a moving victim where it was between two recorded ticks, not snapped to either', () => {
  const R = WORLD.playerRadius;
  const graze = (side: -1 | 1) => {
    const w = emptyWorld();
    const shooter = spawnAt(w, 100, 100);
    const victim = spawnAt(w, 700, 400);
    press(w, victim, { down: true });
    run(w, 400);
    const i = w.history.length - 4;
    const a = w.history[i]!, b = w.history[i + 1]!;
    const ya = a.poses.get(victim.id)!.y, yb = b.poses.get(victim.id)!.y;
    assert.ok(yb - ya > 6, 'the victim moved between the two ticks');
    // A round crossing the victim's path 2px inside its edge as it stood halfway between the ticks; it flies its 300px in the first 3ms after the moment rewound to.
    const mid = (a.at + b.at) / 2;
    const y = (ya + yb) / 2 + side * (R - 2);
    const round: Bullet = { id: 9999, owner: shooter.id, team: null, x: 600, y, vx: 1e5, vy: 0, left: 300, damage: 10, piercing: false, label: 'Test', gun: null, turret: null, lobbed: false, penetrate: 0, passed: [], blast: null, volley: 1 };
    w.events = [];
    flyThroughPast(w, round, w.now - mid);
    return hitOn(w.events, victim);
  };
  assert.equal(graze(-1), true, 'grazing its trailing edge, above');
  assert.equal(graze(1), true, 'grazing its leading edge, below');
});
