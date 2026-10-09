import type { WebSocket } from 'ws';
import type { Player } from '../shared/sim/world.ts';
import { CAREER_PAY, CAREER_TIERS, COLOR_IDS, GUN_IDS, GUNS, ROYALE, WORLD, ZOM, type GunId, type MedalId, type ModeId, type PlayerKind, type WeaponId } from '../shared/defs.ts';
import { MAPS, rotationMap, type MapId } from '../shared/maps.ts';
import { parseClientMsg, type ClientMsg, type GameEvent, type Loadout, type ServerMsg, type Snapshot, type Team } from '../shared/protocol.ts';
import { addPlayer, removePlayer, respawn, setInput, step } from '../shared/sim.ts';
import { rewindCapFor } from '../shared/sim/combat.ts';
import { benchUntilNextMatch, placeOf, redeploysOpen, seatFor, takeSeat } from '../shared/sim/royale.ts';
import { build, demolish, toggleReady, upgrade } from '../shared/sim/run.ts';
import { interestLook, snapshotFor, wallViews } from '../shared/sim/snapshot.ts';
import { holdLook, NO_LOOK, type LookSides } from '../shared/lookahead.ts';
import { addScore, choosePick } from '../shared/sim/stats.ts';
import { MODES, TEAM_NAME } from '../shared/sim/modes.ts';
import { createWorld, rand, type World } from '../shared/sim/world.ts';
import { makeSnapshotEncoder } from '../shared/wire.ts';
import { botCosmetics, XP } from '../shared/cosmetics.ts';
import type { Accounts } from './accounts.ts';
import { NO_PROFILES, type Profiles } from './profiles.ts';
import { applyRangeMsg, isPractice } from './range.ts';
import { botName, botSeats, newBotMemory, randomLoadout, type BotMemory } from './bots.ts';
import { thinkBots } from './bot/tick.ts';
import { enqueueInput, newInputQueue, takeInput, type InputQueue } from './inputs.ts';
import { makeModerator, type Moderator } from './moderation.ts';
import { LIMITS, makeFaultLog, makeTokenBucket, type Limits, type WindowGate } from './limits.ts';
import { uniqueName } from './names.ts';
import { EMOTE_INTERVAL_MS, EMOTE_RANGE } from '../shared/emotes.ts';
import { RADIO_INTERVAL_MS, RADIO_MODES, type StationId } from '../shared/radio.ts';

const TICK_MS = 1000 / WORLD.tickHz;
const CHAT_INTERVAL_MS = 1000;
const RTT_SAMPLES = 5;
/**
 * A side short of humans gets this many bots for each one it lacks. Set when humans carried more health than bots; they now carry the
 * same, a bot's hits counting 0.8 on them (`BOT_DAMAGE_TO_HUMAN`), so this wants measuring again.
 * Measured when humans carried triple health, over 24 seeded TDM rounds with bot-driven humans: 1v0, 2v0, 0v2, 3v0 and 2v1 each land between a third and two thirds of wins; at 2.5 one split went 88% to the humans and at 2 another went 92%.
 */
const BOTS_PER_HUMAN = 3;
/** Told once, at join, to a guest whose new name got no profile because their address hit the new-profile limit. */
export const UNRECORDED_NOTICE = "Your stats aren't being saved for new names right now — register to keep them.";

type Client =
  | { k: 'lobby'; ws: WebSocket; ip: string }
  /** `guest` is the name a guest's play is recorded under, fixed at join; null for an account, or a guest playing unrecorded. */
  | { k: 'joined'; ws: WebSocket; playerId: number; account: string | null; guest: string | null; lastChatAt: number; lastEmoteAt: number; lastRadioAt: number; aspect: number; look: LookSides | null; lookAt: number; since: number; encode: (snap: Snapshot) => string; inputs: InputQueue };

export type RoomInfo = { id: string; mode: ModeId; players: number; humans: number };

export type Room = {
  id: string;
  world: World;
  /** `ip` is the client's address (as the socket cap derives it), for the new-profile limit. */
  connect(ws: WebSocket, ip?: string): void;
  tick(): void;
  info(): RoomInfo;
  /** Dev counters for netcode measurement: per-human input backlog, bytes and snapshots sent and skipped since the last call. */
  netStats(): RoomNetStats;
  /** Stops recording guests seated under `name` (any case): its profile was just carried into an account. */
  forgetGuest(name: string): void;
  close(): void;
};

export type RoomNetStats = { id: string; mode: ModeId; humans: number; players: number; queues: number[]; bytes: number; snaps: number; skipped: number; ticked: number };

/** A kill event names the gun by its label; its class credits the weapon mastery tracks. */
const GUN_BY_NAME = new Map<string, GunId>(GUN_IDS.map((g) => [GUNS[g].name, g]));

export function createRoom(id: string, mode: ModeId, seed: number, accounts: Accounts, stepsPerTick = 1, limits: Limits = LIMITS, moderator: Moderator = makeModerator(), profiles: Profiles = NO_PROFILES, newProfiles: WindowGate | null = null): Room {
  // SKIRMISH_MAP=geo-test starts the versus rooms on the geometry test range (dev only; it is in no rotation).
  const devMap = process.env.SKIRMISH_MAP;
  const world = createWorld(mode, seed, (devMap && devMap in MAPS && (mode === 'FFA' || mode === 'TDM' || mode === 'DOM') ? devMap : rotationMap(mode, seed, 0)) as MapId);
  const botRand = () => rand(world);
  const bots = new Map<number, BotMemory>();
  const clients = new Map<WebSocket, Client>();
  /** When each socket's unsent backlog first went over the cap, for sockets still over it. */
  const backlogSince = new Map<WebSocket, number>();
  let wallsVersion = world.wallsVersion;
  const fault = makeFaultLog(limits.faultLogMs);
  /** The room's radio: the squad's in Zombies, the lone player's in the range. Null until someone tunes it (each map then plays its own track). */
  let radioStation: StationId | null = null;
  const net = { bytes: 0, snaps: 0, skipped: 0, ticked: 0, botMs: 0, stepMs: 0, advanceMs: 0, sendMs: 0 };

  const send = (ws: WebSocket, msg: ServerMsg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); };
  const joined = () => [...clients.values()].filter((c): c is Extract<Client, { k: 'joined' }> => c.k === 'joined');
  const names = () => [...world.players.values()].map((pl) => pl.name);
  const registered = (name: string) => accounts.stats(name) !== null;

  /** A practice room (the range) is one player's own: nothing in it counts toward an account, a profile, XP or a medal, and no bots join. */
  const practice = isPractice(mode);
  const humanCap = practice ? 1 : mode === 'ZOM' ? ZOM.squadSize : limits.humansPerRoom;

  function botTargets(): [Team, number][] {
    if (practice) return [];
    const humans = (team: Team) => [...world.players.values()].filter((p) => p.kind === 'human' && p.team === team).length;
    if (mode === 'FFA') return [[null, Math.max(0, limits.minPlayers - humans(null))]];
    if (mode === 'ZOM') return [['red', Math.max(0, ZOM.squadSize - humans('red'))]];
    if (mode === 'BR') return COLOR_IDS.map((team) => [team, Math.max(0, ROYALE.squadSize - humans(team))]);
    const seats = botSeats({ red: humans('red'), blue: humans('blue') }, limits.minPlayers, BOTS_PER_HUMAN, limits.minPlayers);
    return [['red', seats.red], ['blue', seats.blue]];
  }

  function addBot(team: Team) {
    const name = uniqueName(botName(new Set(names()), botRand), names(), registered);
    const p = addPlayer(world, name, randomLoadout(botRand), { team });
    bots.set(p.id, newBotMemory(botRand));
    p.cos = botCosmetics(name);
    return p;
  }

  const seatOpen = (team: Team) => !world.royale || (redeploysOpen(world.royale) && world.match.k === 'playing' && (team === null || !world.royale.out.includes(team)));

  function balanceBots() {
    for (const [team, want] of botTargets()) {
      const mine = [...bots.keys()].filter((id) => world.players.get(id)?.team === team);
      for (const id of mine.slice(want)) {
        bots.delete(id);
        removePlayer(world, id);
      }
      if (seatOpen(team)) for (let i = mine.length; i < want; i++) addBot(team);
    }
  }

  /**
   * An account plays under its own name: a bot, or a guest seated before the name was registered, holding it is renamed.
   * A second session of the same account keeps the suffix `uniqueName` gives it, and its play still goes to the account.
   */
  function freeName(account: string) {
    const holder = [...world.players.values()].find((pl) => pl.name.toLowerCase() === account.toLowerCase());
    if (!holder) return;
    const signedIn = joined().find((c) => c.playerId === holder.id)?.account;
    if (signedIn?.toLowerCase() === account.toLowerCase()) return;
    holder.name = uniqueName(holder.name, names(), registered);
  }

  function seatHuman(name: string, loadout: Loadout) {
    const seat = seatFor(world);
    const p = addPlayer(world, name, loadout, { kind: 'human', team: seat?.team ?? null, ...(seat && { at: seat }) });
    if (!seat) { benchUntilNextMatch(p); return p; }
    takeSeat(world, p, seat);
    bots.delete(seat.id);
    removePlayer(world, seat.id);
    return p;
  }

  /** Humans split evenly first, so a lone pair lands on opposite sides; balanceBots then evens the sides out with bots. */
  function teamForHuman(): Team {
    if (mode === 'FFA' || mode === 'ZOM' || practice) return MODES[mode].assignTeam(world);
    const count = (team: Team, kind?: PlayerKind) => [...world.players.values()].filter((p) => p.team === team && (kind === undefined || p.kind === kind)).length;
    const redHumans = count('red', 'human'), blueHumans = count('blue', 'human');
    if (redHumans !== blueHumans) return redHumans < blueHumans ? 'red' : 'blue';
    return count('red') <= count('blue') ? 'red' : 'blue';
  }

  /** Where each human stood last tick and how far they have walked since their profile last heard, for the Marathon track. */
  const walked = new Map<number, { x: number; y: number; px: number }>();
  const WALK_FLUSH_PX = 2000;
  /**
   * Whose profile a human's play goes to: a signed-in player's account, whatever name they are seated under, or a guest's
   * own name, unless that name has since been registered by someone else, which a guest seated before the registration
   * still holds; such a guest keeps no profile. A guest is recorded only under the name they joined with (one renamed to
   * make way for an account stops recording), and not at all when their join was refused a new profile.
   */
  function profileKey(c: Extract<Client, { k: 'joined' }>, name: string): string | null {
    if (c.account) return c.account;
    return c.guest !== null && c.guest.toLowerCase() === name.toLowerCase() && !registered(name) ? name : null;
  }
  /** Folds a change into a human's profile, and pays, announces and puts on any lifetime medal it earned. */
  function profile(playerId: number, delta: Parameters<Profiles['record']>[1]) {
    if (practice) return;
    const p = world.players.get(playerId);
    const c = joined().find((j) => j.playerId === playerId);
    const name = c && p ? profileKey(c, p.name) : null;
    if (!name) return;
    const earned = profiles.record(name, delta);
    for (const badge of earned) {
      const score = CAREER_PAY[CAREER_TIERS[badge.tier]!];
      if (p) addScore(world, p, score);
      if (c) send(c.ws, { t: 'badge', badge, score });
    }
    if (p && earned.length) p.badge = profiles.featured(name);
  }

  /** A finished life pays its account's stats and its profile's XP. */
  function creditLives(departed?: Extract<Client, { k: 'joined' }>) {
    if (practice) { world.lifeRecords.length = 0; return; }
    const owners = new Map<number, Extract<Client, { k: 'joined' }>>();
    for (const c of departed ? [...joined(), departed] : joined()) owners.set(c.playerId, c);
    for (const r of world.lifeRecords.splice(0)) {
      const c = owners.get(r.id);
      if (!c) continue;
      if (c.account) accounts.credit(c.account, { kills: r.kills, deaths: r.died ? 1 : 0, score: r.score, games: 0 });
      const key = profileKey(c, r.name);
      if (key) profiles.life(key, { score: r.score, kills: r.kills });
    }
  }

  /** Tells a player what their last moments earned: XP, level-ups, unlocks, challenges done. A level-up changes the level their name shows. */
  function notify(c: Extract<Client, { k: 'joined' }>) {
    if (practice) return;
    const p = world.players.get(c.playerId);
    const key = p && profileKey(c, p.name);
    const msg = key ? profiles.notice(key) : null;
    if (!p || !key || !msg) return;
    send(c.ws, msg);
    if (msg.levelUps.length) p.cos = profiles.cos(key);
  }

  const wonRound = (p: Player): boolean => {
    const m = world.match;
    if (m.k !== 'over') return false;
    if (mode === 'FFA') return m.winner.id === p.id;
    if (mode === 'BR') return !!(world.royale && p.team && placeOf(world, world.royale, p.team) === 1);
    return p.team !== null && m.winner.name === (TEAM_NAME as Record<string, string>)[p.team];
  };
  let roundPaid = false;
  let roundStartAt = 0;
  /** Versus rounds pay each seated human once when the round is over, if they were there for a while. */
  function payRound() {
    if (world.match.k !== 'over') { if (roundPaid) { roundPaid = false; roundStartAt = world.now; } return; }
    if (roundPaid) return;
    roundPaid = true;
    for (const c of joined()) {
      const p = world.players.get(c.playerId);
      const key = p && profileKey(c, p.name);
      if (!p || !key || world.now - Math.max(c.since, roundStartAt) < XP.minRoundPlayMs) continue;
      profiles.round(key, { won: wonRound(p), finished: true });
    }
  }

  /** Zombies pay for each night survived at dawn, and the finish and the Bastion when the run ends. */
  let run: object | null = null, runNight = 0, nightAt = 0, runPhase = '', runPaid = false;
  function payRun() {
    const r = world.run;
    if (!r) return;
    if (r !== run) { run = r; runNight = r.night; nightAt = world.now; runPhase = r.phase.k; runPaid = false; }
    if (r.phase.k === 'night' && runPhase !== 'night') nightAt = world.now;
    runPhase = r.phase.k;
    const seated = () => joined().flatMap((c) => { const p = world.players.get(c.playerId); const key = p && profileKey(c, p.name); return key && c.since <= nightAt ? [key] : []; });
    if (r.night > runNight) { runNight = r.night; for (const key of seated()) profiles.round(key, { won: false, finished: false, nights: 1 }); }
    if (r.phase.k === 'over' && !runPaid) {
      runPaid = true;
      for (const key of seated()) profiles.round(key, { won: r.phase.won, finished: true, nights: r.phase.won ? 1 : 0, bastion: r.phase.won });
    }
  }

  /**
   * Each human's kills, deaths, medals and ground covered this step go to their profile as they happen, so a lifetime
   * medal lands the moment it is earned rather than when the life ends.
   */
  function creditProfiles(events: readonly GameEvent[]) {
    const deltas = new Map<number, { kills: number; deaths: number; medals: MedalId[]; weaponKills: WeaponId[]; zkills: number }>();
    const delta = (id: number) => {
      let d = deltas.get(id);
      if (!d) deltas.set(id, (d = { kills: 0, deaths: 0, medals: [], weaponKills: [], zkills: 0 }));
      return d;
    };
    for (const e of events) {
      if (e.e === 'medal') delta(e.id).medals.push(e.medal);
      if (e.e === 'kill' && e.killerId !== null && e.killerId !== e.victimId) {
        delta(e.killerId).kills++;
        const gun = GUN_BY_NAME.get(e.weapon);
        if (gun) delta(e.killerId).weaponKills.push(GUNS[gun].base);
      }
      if (e.e === 'kill' && !e.knock) delta(e.victimId).deaths++;
      if (e.e === 'zkill' && e.by !== null) delta(e.by).zkills++;
    }
    for (const c of joined()) {
      const p = world.players.get(c.playerId);
      if (!p) continue;
      const d = deltas.get(c.playerId);
      if (d) profile(p.id, { ...d, streak: p.lifeKills });
      const w = walked.get(p.id);
      const step = w ? Math.hypot(p.x - w.x, p.y - w.y) : 0;
      // A respawn's jump is not a walk.
      const px = (w?.px ?? 0) + (p.life.k === 'alive' && step < WORLD.baseSpeed ? step : 0);
      if (px >= WALK_FLUSH_PX) { profile(p.id, { distance: px }); walked.set(p.id, { x: p.x, y: p.y, px: 0 }); }
      else walked.set(p.id, { x: p.x, y: p.y, px });
    }
  }

  function handle(client: Client, msg: ClientMsg, rewindCapMs: number) {
    if (client.k === 'lobby') {
      if (msg.t !== 'join') return;
      if (joined().length >= humanCap) {
        send(client.ws, { t: 'error', message: 'Room full' });
        client.ws.close(1013, 'room full');
        return;
      }
      const account = msg.token ? accounts.nameForToken(msg.token) : null;
      if (account) freeName(account);
      const takenByAnotherAccount = (n: string) => registered(n) && n.toLowerCase() !== account?.toLowerCase();
      const name = uniqueName(account ?? (moderator.isClean(msg.name) ? msg.name : 'Player'), names(), takenByAnotherAccount);
      const p = mode === 'BR' ? seatHuman(name, msg.loadout) : addPlayer(world, name, msg.loadout, { kind: 'human', team: teamForHuman() });
      // Sitting out the rest of the night means leaving and rejoining cannot get a downed or bled-out player up early.
      if (world.run?.phase.k === 'night') p.life = { k: 'dead', respawnAt: Infinity };
      if (account && !practice) accounts.credit(account, { kills: 0, deaths: 0, score: 0, games: 1 });
      // A guest name with no profile yet would make a permanent one: each address may make only so many (LIMITS.newProfile*).
      const unrecorded = !account && !practice && !registered(name) && profiles.get(name) === null && newProfiles !== null && !newProfiles.take(client.ip, Date.now());
      const joinedClient: Extract<Client, { k: 'joined' }> = { k: 'joined', ws: client.ws, playerId: p.id, account, guest: account || unrecorded ? null : name, lastChatAt: -Infinity, lastEmoteAt: -Infinity, lastRadioAt: -Infinity, aspect: msg.aspect, look: null, lookAt: world.now, since: world.now, encode: makeSnapshotEncoder(), inputs: newInputQueue() };
      const key = profileKey(joinedClient, name);
      // The guest who makes a name's profile is its owner: their claim token is what carries it into an account they register.
      const guestClaim = key && !account && !practice ? profiles.adoptGuest(key) : null;
      p.badge = key ? profiles.featured(key) : null;
      clients.set(client.ws, joinedClient);
      balanceBots();
      send(client.ws, { t: 'welcome', id: p.id, mode, worldSize: MAPS[world.map].size, map: world.map, walls: wallViews(world), account, ...(guestClaim && { guest: guestClaim }) });
      if (radioStation) send(client.ws, { t: 'radio', station: radioStation, by: null });
      if (unrecorded) send(client.ws, { t: 'chat', from: '', text: UNRECORDED_NOTICE, team: null });
      profile(p.id, { games: 1 });
      if (key) {
        // Looking is free in practice; changing a profile, or reading its news (which clears it), is not.
        if (msg.cosmetics && !practice) profiles.equip(key, msg.cosmetics);
        p.cos = profiles.cos(key);
        const state = practice ? null : profiles.state(key);
        if (state) send(client.ws, state);
      }
      return;
    }
    const id = client.playerId;
    switch (msg.t) {
      case 'join': return;
      case 'view': client.aspect = msg.aspect; return;
      case 'input': enqueueInput(client.inputs, { seq: msg.seq, input: msg.input, viewAt: msg.viewAt, rewindCapMs, arrivedTick: world.tick }); return;
      case 'pick': choosePick(world, id, msg.level, msg.option); return;
      case 'respawn': respawn(world, id, msg.loadout); return;
      case 'build': build(world, id, msg.kind, msg.cx, msg.cy, msg.lv); return;
      case 'demolish': demolish(world, id, msg.cx, msg.cy); return;
      case 'upgrade': upgrade(world, id, msg.cx, msg.cy); return;
      case 'ready': toggleReady(world, id); return;
      case 'range': { const refused = applyRangeMsg(world, id, msg); if (refused) send(client.ws, { t: 'error', message: refused }); return; }
      case 'equip': {
        const p = world.players.get(id);
        const key = p && profileKey(client, p.name);
        if (!p || !key) { send(client.ws, { t: 'error', message: 'Sign in or pick another name to change your look' }); return; }
        const r = profiles.equip(key, { [msg.slot]: msg.id }, true);
        p.cos = profiles.cos(key);
        send(client.ws, { t: 'equipped', equipped: r.equipped });
        if (!r.ok) send(client.ws, { t: 'error', message: 'That item is locked' });
        return;
      }
      case 'emote': {
        const now = Date.now();
        const p = world.players.get(id);
        // Too fast, or from a body that is not standing: dropped without a word, so spamming gets nothing back.
        if (!p || p.life.k !== 'alive' || now - client.lastEmoteAt < EMOTE_INTERVAL_MS) return;
        client.lastEmoteAt = now;
        for (const c of joined()) {
          const q = world.players.get(c.playerId);
          const near = q && Math.hypot(q.x - p.x, q.y - p.y) <= EMOTE_RANGE;
          if (c === client || near || (p.team !== null && q?.team === p.team)) send(c.ws, { t: 'emote', pid: p.id, id: msg.id });
        }
        return;
      }
      case 'radio': {
        // Only the squad's room and the range have a radio; anything else, or a client tuning too fast, is dropped without a word.
        const now = Date.now();
        const p = world.players.get(id);
        if (!RADIO_MODES.includes(mode) || !p || now - client.lastRadioAt < RADIO_INTERVAL_MS) return;
        client.lastRadioAt = now;
        radioStation = msg.station;
        for (const c of joined()) send(c.ws, { t: 'radio', station: radioStation, by: p.name });
        return;
      }
      case 'chat': {
        const now = Date.now();
        if (now - client.lastChatAt < CHAT_INTERVAL_MS) { send(client.ws, { t: 'error', message: 'Slow down' }); return; }
        client.lastChatAt = now;
        const p = world.players.get(id);
        if (!p) return;
        const text = moderator.mask(msg.text);
        for (const c of joined()) send(c.ws, { t: 'chat', from: p.name, text, team: p.team });
        return;
      }
    }
  }

  function disconnect(ws: WebSocket) {
    const c = clients.get(ws);
    clients.delete(ws);
    backlogSince.delete(ws);
    if (c?.k !== 'joined') return;
    const left = world.players.get(c.playerId);
    if (mode === 'BR' && left?.team && seatOpen(left.team)) takeSeat(world, addBot(left.team), left);
    const walk = walked.get(c.playerId);
    const key = left ? profileKey(c, left.name) : null;
    if (key && walk?.px && !practice) profiles.record(key, { distance: walk.px });
    walked.delete(c.playerId);
    removePlayer(world, c.playerId);
    creditLives(c);
    if (key && !practice) profiles.notice(key);
    balanceBots();
  }

  function applyInputs() {
    for (const c of joined()) {
      const next = takeInput(c.inputs, world.tick);
      if (next) setInput(world, c.playerId, next.seq, next.input, next.viewAt, next.rewindCapMs);
    }
  }

  function advance(): GameEvent[] {
    const events: GameEvent[] = [];
    for (let i = 0; i < stepsPerTick; i++) {
      applyInputs();
      const t0 = performance.now();
      thinkBots(world, bots, botRand);
      const t1 = performance.now();
      step(world, TICK_MS);
      net.botMs += t1 - t0; net.stepMs += performance.now() - t1;
      events.push(...world.events);
      if (!practice) creditProfiles(world.events);
      creditLives();
    }
    if (practice) { /* nothing is paid */ } else if (mode === 'ZOM') payRun(); else payRound();
    for (const c of joined()) notify(c);
    return events;
  }

  balanceBots();
  let seatedRoyale = world.royale;
  /** Set by close(): a socket that reaches a closed room is turned away (one still finishing its close handshake was already let go). */
  let closed = false;

  return {
    id,
    world,
    connect(ws, ip = '') {
      if (closed) { ws.close(1001, 'room closed'); return; }
      clients.set(ws, { k: 'lobby', ws, ip });
      const allow = makeTokenBucket(limits.messagesPerSec, limits.messageBurst);
      const joinTimer = setTimeout(() => { if (clients.get(ws)?.k === 'lobby') ws.close(1008, 'join timeout'); }, limits.joinTimeoutMs);
      // A socket can die without a close frame (a dropped network, a proxy that lingers); unanswered pings are the only signal.
      let answeredPing = true;
      // The worst of the last few round trips, so ordinary jitter between pings does not shrink the rewind a shot needs.
      let rtts: number[] = [];
      let pinged: { id: number; at: number } | null = null;
      let pingId = 0;
      const ping = () => {
        pinged = { id: ++pingId, at: Date.now() };
        ws.ping(String(pinged.id));
      };
      ws.on('pong', (data) => {
        answeredPing = true;
        if (pinged === null || String(data) !== String(pinged.id)) return;
        rtts = [...rtts.slice(1 - RTT_SAMPLES), Date.now() - pinged.at];
        pinged = null;
      });
      const heartbeat = setInterval(() => {
        if (!answeredPing) { ws.terminate(); return; }
        answeredPing = false;
        ping();
      }, limits.heartbeatMs);
      const rttTimer = setInterval(ping, limits.rttPingMs);
      ws.on('message', (data, isBinary) => {
        if (!allow(Date.now())) { ws.close(1008, 'too many messages'); return; }
        const msg = isBinary ? null : parseClientMsg(data.toString());
        if (!msg) { send(ws, { t: 'error', message: 'Bad message' }); return; }
        const client = clients.get(ws);
        // Thrown here, inside the socket's event, a fault in one message would be an uncaught exception: the whole process, every room, gone.
        try {
          if (client) handle(client, msg, rewindCapFor(rtts.length > 0 ? Math.max(...rtts) : null));
        } catch (err) {
          fault(`room ${id} handling '${msg.t}'`, err);
        }
      });
      ws.on('close', () => { clearTimeout(joinTimer); clearInterval(heartbeat); clearInterval(rttTimer); disconnect(ws); });
      // ws emits 'error' for protocol violations like oversized frames; unhandled, it kills the process.
      ws.on('error', () => ws.terminate());
    },
    tick() {
      // A room nobody is playing in stands still: its bots would otherwise burn the server's whole CPU share around the clock.
      if (joined().length === 0) return;
      net.ticked++;
      const a0 = performance.now();
      const events = advance();
      net.advanceMs += performance.now() - a0;
      if (world.royale !== seatedRoyale) {
        seatedRoyale = world.royale;
        balanceBots();
      }
      if (world.wallsVersion !== wallsVersion) {
        wallsVersion = world.wallsVersion;
        const walls = wallViews(world);
        for (const c of joined()) send(c.ws, { t: 'walls', worldSize: MAPS[world.map].size, map: world.map, walls });
      }
      const now = Date.now();
      const s0 = performance.now();
      for (const c of joined()) {
        const ws = c.ws;
        if (ws.readyState !== ws.OPEN) continue;
        // A reader that has stopped (a throttled or frozen tab, a dead link) must not be fed: every queued snapshot is stale by the time it is read,
        // and the backlog is memory and write work the room keeps paying for. The encoder runs only for snapshots that go out, so its deltas stay true.
        if (ws.bufferedAmount > limits.maxBufferedBytes) {
          const since = backlogSince.get(ws) ?? now;
          backlogSince.set(ws, since);
          if (now - since >= limits.stallMs) ws.terminate();
          net.skipped++;
          continue;
        }
        backlogSince.delete(ws);
        // The aim look-ahead's widening is held per client as its camera eases (lookahead.ts), stepped only for snapshots that go out.
        const me = world.players.get(c.playerId);
        c.look = holdLook(c.look, me ? interestLook(world, me) : NO_LOOK, world.now - c.lookAt);
        c.lookAt = world.now;
        const data = c.encode(snapshotFor(world, c.playerId, events, c.aspect, c.look));
        net.bytes += data.length;
        net.snaps++;
        ws.send(data);
      }
      net.sendMs += performance.now() - s0;
    },
    info() {
      return { id, mode, players: world.players.size, humans: joined().length };
    },
    netStats() {
      const sizeOf = (v: unknown) => (Array.isArray(v) ? v.length : v instanceof Map || v instanceof Set ? v.size : null);
      const sizes: Record<string, number> = {};
      for (const [k, v] of Object.entries(world)) { const n = sizeOf(v); if (n !== null) sizes[k] = n; }
      for (const p of world.players.values()) for (const [k, v] of Object.entries(p)) { const n = sizeOf(v); if (n !== null) sizes[`p.${k}`] = (sizes[`p.${k}`] ?? 0) + n; }
      const out = { id, mode, humans: joined().length, players: world.players.size, queues: joined().map((c) => c.inputs.waiting.length), buffered: joined().map((c) => c.ws.bufferedAmount), botMemKb: Math.round(JSON.stringify([...bots.values()]).length / 1024), sizes, ...net };
      net.bytes = net.snaps = net.skipped = net.ticked = net.botMs = net.stepMs = net.advanceMs = net.sendMs = 0;
      return out;
    },
    forgetGuest(name) {
      for (const c of joined()) if (c.guest?.toLowerCase() === name.toLowerCase()) c.guest = null;
    },
    close() {
      // Seated players leave now, so their lives and walks are credited before a shutting-down server flushes and exits;
      // a 'close' event that comes later (or never, from a peer that ignores the close frame) then finds nothing to do.
      closed = true;
      for (const ws of [...clients.keys()]) {
        disconnect(ws);
        ws.close();
      }
    },
  };
}
