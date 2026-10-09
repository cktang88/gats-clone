/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WORLD } from '../src/shared/defs.ts';
import { BOT_HEARING } from '../src/shared/sim/hearing.ts';
import { snapshotFor } from '../src/shared/sim/snapshot.ts';
import { effectiveStats } from '../src/shared/sim/stats.ts';
import type { World } from '../src/shared/sim/world.ts';
import { arenaFor } from '../src/server/bot/arena.ts';
import { freshAwareness, perceive, type Awareness } from '../src/server/bot/awareness.ts';
import { bandFor, nextIntent, PERSONALITIES, startIntent, type Intent, type IntentCtx, type Personality, type Plan } from '../src/server/bot/intent.ts';
import { step } from '../src/shared/sim.ts';
import { emptyWorld, setWalls, spawnAt, TICK_MS } from './helpers.ts';

const seeded = (seed: number) => { let x = seed; return () => ((x = (x * 16807) % 2147483647) / 2147483647); };

function decide(w: World, id: number, cur: Plan | Intent, opts: { persona?: Personality; tick?: number; aware?: Awareness } = {}): Intent {
  const persona = opts.persona ?? PERSONALITIES.cautious;
  const snap = snapshotFor(w, id);
  snap.tick = opts.tick ?? snap.tick;
  const me = snap.players.find((p) => p.id === id)!;
  const { view } = perceive(snap, arenaFor(w), me, opts.aware ?? freshAwareness());
  const ctx: IntentCtx = { tick: snap.tick, persona, role: null, band: bandFor(view.me.gun, persona), arena: arenaFor(w), rand: seeded(3) };
  const intent = 'since' in cur ? cur : startIntent(cur, { ...ctx, tick: snap.tick });
  return nextIntent(intent, view, ctx);
}

const pillarWest = { x: 700, y: 900, w: 40, h: 200 };
/** Cover east of a bot at (1000, 1000) from an enemy at (1500, 1000): its spot is hidden from him, and a step south of it is out in his sight. */
const coverEast = { x: 1040, y: 900, w: 30, h: 130 };

test('an enemy walking into view turns a patrol into a fight at once, commitment or not', () => {
  const w = emptyWorld();
  const bot = spawnAt(w, 1000, 1000, { loadout: { weapon: 'assault' } });
  const patrol = decide(w, bot.id, { k: 'patrol', goal: { x: 2000, y: 2000 } });
  assert.equal(patrol.k, 'patrol', 'nothing in view: keeps patrolling');
  const enemy = spawnAt(w, 1400, 1000);
  const next = decide(w, bot.id, { ...patrol, holdUntil: Infinity });
  assert.equal(next.k, 'engage');
  assert.equal(next.k === 'engage' && next.target, enemy.id);
});

test('a hurt bot in a fight with cover in reach breaks off to heal behind it, and comes back only once healed past its line', () => {
  const w = emptyWorld();
  setWalls(w, [pillarWest]);
  const bot = spawnAt(w, 1000, 1000, { loadout: { weapon: 'assault' } });
  spawnAt(w, 1500, 1000);
  const p = PERSONALITIES.cautious;
  if (bot.life.k !== 'alive') throw new Error('alive');
  bot.life.hp = 100 * (p.retreatHp - 0.1);
  const retreat = decide(w, bot.id, { k: 'engage', target: 0 }, { persona: p });
  assert.equal(retreat.k, 'retreatAndHeal');
  assert.ok(retreat.k === 'retreatAndHeal' && retreat.spot && retreat.spot.x < pillarWest.x, `hides west of the pillar: ${JSON.stringify(retreat)}`);

  bot.x = 640; bot.y = 1000;
  bot.life.hp = 100 * ((p.retreatHp + p.healedHp) / 2);
  const healing = decide(w, bot.id, { ...retreat, holdUntil: 0 }, { persona: p });
  assert.equal(healing.k, 'retreatAndHeal', 'between the lines it keeps healing');
  bot.life.hp = 100 * (p.healedHp + 0.02);
  assert.notEqual(decide(w, bot.id, { ...retreat, holdUntil: 0 }, { persona: p }).k, 'retreatAndHeal', 'healed past its line it goes back out');
});

test('a hurt bot with an enemy on top of it fights rather than turning its back', () => {
  const w = emptyWorld();
  setWalls(w, [pillarWest]);
  const bot = spawnAt(w, 1000, 1000, { loadout: { weapon: 'assault' } });
  spawnAt(w, 1150, 1000);
  if (bot.life.k === 'alive') bot.life.hp = 10;
  assert.equal(decide(w, bot.id, { k: 'engage', target: 0 }).k, 'engage');
  const fleeing = startIntent({ k: 'retreatAndHeal', spot: { x: 640, y: 1000 }, threat: { x: 1150, y: 1000 } }, { tick: 0, persona: PERSONALITIES.cautious } as IntentCtx);
  assert.equal(decide(w, bot.id, fleeing).k, 'engage', 'a retreat caught up with turns to fight');
});

test('a bot in a fight with its magazine nearly dry reloads in cover, and fights again once it is full', () => {
  const w = emptyWorld();
  setWalls(w, [pillarWest]);
  const bot = spawnAt(w, 1000, 1000, { loadout: { weapon: 'assault' } });
  spawnAt(w, 1500, 1000);
  if (bot.life.k !== 'alive') throw new Error('alive');
  bot.life.ammo = 3;
  const reload = decide(w, bot.id, { k: 'engage', target: 0 });
  assert.equal(reload.k, 'reloadInCover');
  bot.life.ammo = 30;
  assert.equal(decide(w, bot.id, { ...reload, holdUntil: 0 }).k, 'engage');
});

test('a fight holds for its commitment, then a cautious bot with cover in reach moves to peek from it', () => {
  const w = emptyWorld();
  setWalls(w, [{ x: 1100, y: 900, w: 40, h: 200 }]);
  const bot = spawnAt(w, 1000, 1150, { loadout: { weapon: 'assault' } });
  spawnAt(w, 1650, 1000);
  const persona = { ...PERSONALITIES.cautious, peekOdds: 1 };
  const engaged = startIntent({ k: 'engage', target: 0 }, { tick: 100, persona } as IntentCtx);
  assert.equal(decide(w, bot.id, engaged, { persona, tick: 101 }).k, 'engage', 'still committed');
  const peek = decide(w, bot.id, engaged, { persona, tick: engaged.holdUntil });
  assert.equal(peek.k, 'peekAndHide');
});

test('a peek takes turns hiding and looking out without leaving the intent', () => {
  const w = emptyWorld();
  setWalls(w, [coverEast]);
  const bot = spawnAt(w, 1000, 1000, { loadout: { weapon: 'assault' } });
  spawnAt(w, 1500, 1000);
  const peek = startIntent({ k: 'peekAndHide', target: 0, spot: { x: 1000, y: 1000 }, peek: { x: 1000, y: 1060 }, phase: 'hide', phaseUntil: 10 }, { tick: 0, persona: PERSONALITIES.cautious } as IntentCtx);
  const out = decide(w, bot.id, peek, { tick: 10 });
  assert.ok(out.k === 'peekAndHide' && out.phase === 'peek' && out.phaseUntil > 10, `steps out: ${JSON.stringify(out)}`);
  assert.equal(out.since, peek.since, 'the same intent, not a new one');
  const back = decide(w, bot.id, out, { tick: out.k === 'peekAndHide' ? out.phaseUntil : 0 });
  assert.ok(back.k === 'peekAndHide' && back.phase === 'hide', 'tucks back in');
});

test('a target lost behind cover is flanked, pushed or waited out by the personality\'s odds', () => {
  const w = emptyWorld();
  const bot = spawnAt(w, 1000, 1000, { loadout: { weapon: 'assault' } });
  const aware: Awareness = { ...freshAwareness(), contacts: [{ id: 99, x: 1500, y: 1000, seenTick: 0, gun: 'assault' }] };
  const lost = startIntent({ k: 'engage', target: 99 }, { tick: 0, persona: PERSONALITIES.cautious } as IntentCtx);
  const as = (overrides: Partial<Personality>) => decide(w, bot.id, lost, { persona: { ...PERSONALITIES.cautious, ...overrides }, tick: 60, aware }).k;
  assert.equal(as({ flankOdds: 1 }), 'flank');
  assert.equal(as({ flankOdds: 0, pushOdds: 1 }), 'search');
  assert.equal(as({ flankOdds: 0, pushOdds: 0 }), 'takePosition');
});

test('a flank that reaches its side point goes to search where the target was last seen', () => {
  const w = emptyWorld();
  const bot = spawnAt(w, 1000, 1000, { loadout: { weapon: 'assault' } });
  const flank = startIntent({ k: 'flank', target: 99, via: { x: 1010, y: 1000 }, lastKnown: { x: 1500, y: 1400 } }, { tick: 0, persona: PERSONALITIES.cautious } as IntentCtx);
  const next = decide(w, bot.id, flank, { tick: flank.holdUntil });
  assert.ok(next.k === 'search' && next.at.x === 1500 && next.at.y === 1400, JSON.stringify(next));
});

test('a peek duel that drags on is broken by a flank when the personality goes round', () => {
  const w = emptyWorld();
  setWalls(w, [coverEast]);
  // Out at its peek, where the two trade shots.
  const bot = spawnAt(w, 1000, 1060, { loadout: { weapon: 'assault' } });
  const enemy = spawnAt(w, 1500, 1000);
  const peek = startIntent({ k: 'peekAndHide', target: enemy.id, spot: { x: 1000, y: 1000 }, peek: { x: 1000, y: 1060 }, phase: 'hide', phaseUntil: 1e9 }, { tick: 0, persona: PERSONALITIES.cautious } as IntentCtx);
  const at = (tick: number, flankOdds: number) => decide(w, bot.id, peek, { persona: { ...PERSONALITIES.cautious, flankOdds }, tick }).k;
  assert.equal(at(90, 1), 'peekAndHide', 'three seconds in it keeps peeking');
  assert.equal(at(180, 1), 'flank', 'six seconds in it goes round');
  assert.equal(at(180, 0), 'peekAndHide', 'a bot that never flanks keeps peeking');
});

test('a bot hears gunfire it cannot see within its (superhuman) earshot, roughly placed, a silenced shot only up close, and remembers it for a few seconds', () => {
  const heardAt = (shot: { x: number; y: number; silenced: boolean; gun?: 'assault' | 'sniper' }, aware = freshAwareness(), team?: 'red' | 'blue') => {
    const w = emptyWorld(team ? 'TDM' : 'FFA');
    const bot = spawnAt(w, 1000, 1000, { loadout: { weapon: 'assault' }, ...(team && { team: 'red' as const }) });
    const shooter = spawnAt(w, shot.x, shot.y, team && { team });
    const events = [{ e: 'shot' as const, x: shot.x, y: shot.y, angle: 0, silenced: shot.silenced, owner: shooter.id, gun: shot.gun ?? 'assault' }];
    const snap = snapshotFor(w, bot.id, events);
    return { w, bot, snap, ...perceive(snap, arenaFor(w), snap.players.find((p) => p.id === bot.id)!, aware) };
  };
  const earshot = WORLD.viewRadius * BOT_HEARING.earshotMul;
  assert.ok(BOT_HEARING.earshotMul >= 2 * 1.2, 'a bot hears at least twice as far as a person (the client fades a shot out at 1.2 view radii)');
  const loud = heardAt({ x: 1800, y: 1300, silenced: false });
  const lead = loud.view.lead;
  const d = Math.hypot(800, 300);
  assert.ok(lead, 'an unsilenced shot 850px off is heard');
  assert.ok(lead.x !== 1800 || lead.y !== 1300, 'but not exactly where it was fired');
  assert.ok(Math.hypot(lead.x - 1800, lead.y - 1300) <= d * BOT_HEARING.blur + 1, `only roughly: ${Math.round(Math.hypot(lead.x - 1800, lead.y - 1300))}px off`);
  assert.equal(loud.snap.minimap.length, 0, 'and never as a minimap dot');
  assert.equal(heardAt({ x: 1000 + earshot + 20, y: 1000, silenced: false }).view.lead, null, 'past earshot it is not heard');
  assert.ok(heardAt({ x: 1000 + earshot - 20, y: 1000, silenced: false }).view.lead, 'just inside it is');
  assert.ok(heardAt({ x: 1000 + earshot + 20, y: 1000, silenced: false, gun: 'sniper' }).view.lead, 'a loud sniper carries further');
  assert.equal(heardAt({ x: 1800, y: 1300, silenced: true }).view.lead, null, 'a silenced one that far is not');
  assert.ok(heardAt({ x: 1200, y: 1100, silenced: true }).view.lead, 'a silenced one 220px off is');
  assert.equal(heardAt({ x: 1800, y: 1300, silenced: false }, freshAwareness(), 'red').view.lead, null, 'a teammate firing is no lead');
  assert.equal(snapshotFor(loud.w, loud.bot.id).heard?.length, 0, 'nothing heard without a shot');
  const humanW = emptyWorld();
  const human = spawnAt(humanW, 1000, 1000, { kind: 'human' });
  assert.equal(snapshotFor(humanW, human.id).heard, undefined, 'a person hears with their ears: the cue is for bots only');
  const remembered = loud.awareness;
  const later = snapshotFor(loud.w, loud.bot.id, []);
  later.tick += 60;
  assert.ok(perceive(later, arenaFor(loud.w), later.players.find((p) => p.id === loud.bot.id)!, remembered).view.lead, 'still a lead two seconds on');
  later.tick += 120;
  assert.equal(perceive(later, arenaFor(loud.w), later.players.find((p) => p.id === loud.bot.id)!, remembered).view.lead, null, 'forgotten after six');
  const patrol = decide(loud.w, loud.bot.id, { k: 'patrol', goal: { x: 200, y: 200 } }, { aware: remembered });
  assert.ok(patrol.k === 'search' && Math.abs(patrol.at.x - 1800) < 300 && Math.abs(patrol.at.y - 1300) < 300, `goes to look: ${JSON.stringify(patrol)}`);
});

test('a hurt bot leaves the hiding spot a teammate is already in', () => {
  const w = emptyWorld('TDM');
  setWalls(w, [pillarWest]);
  const bot = spawnAt(w, 1000, 1000, { loadout: { weapon: 'assault' }, team: 'red' });
  spawnAt(w, 1500, 1000, { team: 'blue' });
  if (bot.life.k === 'alive') bot.life.hp = 10;
  const alone = decide(w, bot.id, { k: 'engage', target: 0 });
  assert.ok(alone.k === 'retreatAndHeal' && alone.spot, 'retreats to cover');
  const spot = alone.k === 'retreatAndHeal' ? alone.spot! : { x: 0, y: 0 };
  spawnAt(w, spot.x, spot.y, { team: 'red' });
  const shared = decide(w, bot.id, { k: 'engage', target: 0 });
  assert.ok(shared.k === 'retreatAndHeal' && shared.spot && Math.hypot(shared.spot.x - spot.x, shared.spot.y - spot.y) >= 60, `picks another spot: ${JSON.stringify(shared)}`);
});

test('a hurt bot keeps fighting a lone enemy who is worse off, but leaves when outnumbered with nobody beside it', () => {
  const w = emptyWorld('TDM');
  setWalls(w, [pillarWest]);
  const bot = spawnAt(w, 1000, 1000, { loadout: { weapon: 'assault' }, team: 'red' });
  const foe = spawnAt(w, 1500, 1000, { team: 'blue' });
  const hp = (p: typeof bot, v: number) => { if (p.life.k === 'alive') p.life.hp = v; };
  hp(bot, 15);
  hp(foe, 8);
  assert.equal(decide(w, bot.id, { k: 'engage', target: foe.id }).k, 'engage', 'finishes a weaker lone enemy');
  hp(foe, 100);
  assert.equal(decide(w, bot.id, { k: 'engage', target: foe.id }).k, 'retreatAndHeal', 'leaves a stronger one');

  hp(bot, 25);
  spawnAt(w, 1500, 1150, { team: 'blue' });
  assert.equal(decide(w, bot.id, { k: 'engage', target: foe.id }).k, 'retreatAndHeal', 'two on one at 25% is a fight to leave');
  spawnAt(w, 1000, 1150, { team: 'red' });
  assert.equal(decide(w, bot.id, { k: 'engage', target: foe.id }).k, 'engage', 'with a teammate beside it, it stays');
});

test('a peek that nobody answers stays out, and one that draws fire tucks back in', () => {
  const w = emptyWorld();
  setWalls(w, [{ x: 1040, y: 850, w: 30, h: 120 }]);
  const bot = spawnAt(w, 1000, 1000, { loadout: { weapon: 'assault' } });
  const enemy = spawnAt(w, 1500, 1000);
  const out = startIntent({ k: 'peekAndHide', target: enemy.id, spot: { x: 1000, y: 940 }, peek: { x: 1000, y: 1000 }, phase: 'peek', phaseUntil: 10 }, { tick: 0, persona: PERSONALITIES.cautious } as IntentCtx);
  const quiet = decide(w, bot.id, out, { tick: 10 });
  assert.ok(quiet.k === 'peekAndHide' && quiet.phase === 'peek', 'unanswered: keeps shooting');
  const shot = decide(w, bot.id, out, { tick: 10, aware: { ...freshAwareness(), hitTick: 10 } });
  assert.ok(shot.k === 'peekAndHide' && shot.phase === 'hide', 'shot at: ducks');
});

test('a bot holding a spot goes to gunfire it just heard, unless it is far off or where it is already watching', () => {
  const w = emptyWorld();
  const bot = spawnAt(w, 1000, 1000, { loadout: { weapon: 'assault' } });
  const hold = startIntent({ k: 'takePosition', spot: { x: 1000, y: 1000 }, facing: { x: 1000, y: 200 } }, { tick: 0, persona: PERSONALITIES.cautious } as IntentCtx);
  const heard = (x: number, y: number, tick: number): Awareness => ({ ...freshAwareness(), heard: [{ x, y, tick, hunted: false }] });
  const after = (x: number, y: number, heardAt: number) => decide(w, bot.id, hold, { tick: 30, aware: heard(x, y, heardAt) });
  const go = after(1900, 1300, 30);
  assert.ok(go.k === 'search' && go.at.x === 1900, `goes to look: ${JSON.stringify(go)}`);
  assert.equal(after(1900, 1300, 20).k, 'takePosition', 'an older shot does not pull it off its spot');
  assert.equal(after(2900, 2900, 30).k, 'takePosition', 'gunfire across the map does not');
  assert.equal(after(1050, 300, 30).k, 'takePosition', 'gunfire where it is already watching does not');
});

test('a search lasts long enough to walk to a far lead and look round, and a near one ends sooner', () => {
  const w = emptyWorld();
  const bot = spawnAt(w, 1000, 1000, { loadout: { weapon: 'assault' } });
  const giveUpAfterS = (x: number) => {
    const s = decide(w, bot.id, { k: 'patrol', goal: { x: 200, y: 200 } }, { tick: 30, aware: { ...freshAwareness(), heard: [{ x, y: 1000, tick: 30, hunted: false }] } });
    assert.equal(s.k, 'search');
    return s.k === 'search' ? (s.giveUpAt - 30) / 30 : 0;
  };
  const walkS = 4000 / effectiveStats(bot).speed;
  const far = giveUpAfterS(5000), close = giveUpAfterS(1300);
  assert.ok(far > walkS, `a lead 4000px off is kept ${far.toFixed(1)}s, longer than the ${walkS.toFixed(1)}s walk`);
  assert.ok(close < far - walkS / 2, `a lead 300px off is kept ${close.toFixed(1)}s`);
});

test('a hurt bot that turned on its pursuer keeps fighting while it backs off a step, and flees only once it has real distance', () => {
  const at = (d: number) => {
    const w = emptyWorld();
    setWalls(w, [pillarWest]);
    const bot = spawnAt(w, 1000, 1000, { loadout: { weapon: 'assault' } });
    spawnAt(w, 1000 + d, 1000);
    if (bot.life.k === 'alive') bot.life.hp = 10;
    return decide(w, bot.id, { k: 'engage', target: 0 }).k;
  };
  assert.equal(at(250), 'engage', 'just past the cornered range it holds');
  assert.equal(at(400), 'retreatAndHeal', 'with room it breaks off');
});

test('a bot whose target slips out of sight for a moment keeps fighting, and gives up the fight once it has been gone a while', () => {
  const w = emptyWorld();
  const bot = spawnAt(w, 1000, 1000, { loadout: { weapon: 'assault' } });
  for (let i = 0; i < 90; i++) step(w, TICK_MS);
  const lost = (agoMs: number) => {
    const aware: Awareness = { ...freshAwareness(), contacts: [{ id: 99, x: 1500, y: 1000, seenTick: w.tick - Math.round(agoMs / TICK_MS), gun: 'assault' }] };
    return decide(w, bot.id, { k: 'engage', target: 99, since: 0, holdUntil: 0 }, { aware, tick: w.tick }).k;
  };
  assert.equal(lost(TICK_MS), 'engage', 'one tick out of sight');
  assert.notEqual(lost(1000), 'engage', 'a second out of sight');
});

test('a searching bot that hears new gunfire on a quick think turns to it at its next plan, not only if the shot lands on the planning tick', () => {
  const w = emptyWorld();
  const bot = spawnAt(w, 1000, 1000, { loadout: { weapon: 'assault' } });
  const persona = PERSONALITIES.cautious, arena = arenaFor(w);
  const ctx = (tick: number, strategic: boolean): IntentCtx => ({ tick, persona, role: null, band: bandFor('assault', persona), arena, rand: seeded(3), strategic, lastPlan: 90 });
  const look = (tick: number, events: Parameters<typeof snapshotFor>[2], aware: Awareness) => {
    const snap = snapshotFor(w, bot.id, events);
    snap.tick = tick;
    return perceive(snap, arena, snap.players.find((p) => p.id === bot.id)!, aware);
  };
  const search: Intent = { k: 'search', at: { x: 1000, y: 2500 }, giveUpAt: 1e9, since: 0, holdUntil: 0 };
  const shot = { e: 'shot' as const, x: 1800, y: 1000, angle: 0, silenced: false, owner: 999, gun: 'pistol' as const };
  const quick = look(96, [shot], freshAwareness());
  const reacted = nextIntent(search, quick.view, ctx(96, false));
  assert.equal(reacted, search, 'a quick think only reacts: the plan waits');
  const planned = nextIntent(reacted, look(108, [], quick.awareness).view, ctx(108, true));
  assert.equal(planned.k, 'search');
  assert.ok(planned.k === 'search' && Math.hypot(planned.at.x - shot.x, planned.at.y - shot.y) < 100, `searches where the shot came from: ${JSON.stringify(planned)}`);
});
