import { pickOptions, WORLD, type BuildingKind } from '../shared/defs.ts';
import { cleanName, type ClientMsg, type Loadout, type ServerMsg, type Snapshot, type WallView } from '../shared/protocol.ts';
import { fillSnapshot } from '../shared/wire.ts';
import { fetchServers, loadLoadout, loadMuted, loadName, openSquad, saveLoadout, saveMuted, saveName, type ServerInfo } from './api.ts';
import { toggleMute } from './chatmute.ts';
import { makeCamera, screenToWorld, viewAspect, worldToScreen, type Camera } from './camera.ts';
import { createAudio } from './audio.ts';
import { killOf, lossOf, selfOf } from './derive.ts';
import { walks } from '../shared/sim/movement.ts';
import { isSteady, spreadFor } from '../shared/sim/stats.ts';
import { addFeedback, NO_FEEDBACK } from './feedback.ts';
import { addMoments, NO_MOMENTS } from './moments.ts';
import { buildChipAt, drawHud, drawSticks, setHudInsets } from './hud.ts';
import { actionForKey, assembleInput, perkSlotForKey, type Action } from './input.ts';
import { NO_STICKS, dragStick, pressStick, releaseStick, setStickScale, touchAim, touchMoves, type Sticks } from './touch.ts';
import { NO_INSETS, dismissHomeScreenHint, fullscreenSupported, goFullscreen, installTouchGuards, measureLayout, shouldShowHomeScreenHint, type Layout } from './viewport.ts';
import { releaseDue, scheduleEffects } from './eventclock.ts';
import { EMPTY_BUFFER, TICK_MS, newestSnap, pushSnap, renderTime, sampleAt } from './interp.ts';
import { $, mountAccount, mountLoadoutPicker, renderControls, renderMuted, renderServers, renderSquad, renderSquadChip } from './menu.ts';
import { makeDelay } from './netsim.ts';
import { createOverlays } from './overlays.ts';
import { decayCorrection, drawnPosition, NO_PREDICTION, predictAbility, predictInput, reconcile, selfMotion, solidsOf } from './predict.ts';
import { startEffect } from './effects.ts';
import type { EffectSpec } from './eventclock.ts';
import { createPool } from './particles.ts';
import { coverServerRounds, drawnRounds, recentShooters, roundLive } from './rounds.ts';
import { bodyColor, drawBackdrop, drawWorld } from './render.ts';
import { recordTrail, TRAIL } from './trails.ts';
import { createCracks } from './decals.ts';
import { createShooting, type Hands } from './shooting.ts';
import { installDevProbe, noteFrame, noteFrameCost, noteOwnShotSound } from './devprobe.ts';
import { soundsFor, type SoundCue } from './sfx.ts';
import { committed, nextSprayShot, NO_FIRING, sendInput } from './fire.ts';
import { addTrauma, decay, offset, traumaFor } from './shake.ts';
import { closeVerdict, retryAfterFailure, retryNow, socketRole, startRetry } from './reconnect.ts';
import { EFFECT_LIFE_MS, type ClientState, type Rejoin, type Session } from './state.ts';
import { aimTurrets, nextCoreHitAt } from './siege.ts';
import { buildKindForKey, buildSiteOf, ghostAt, inviteLink, squadFromSearch, withSquad, type Ghost } from './zombies.ts';

const INPUT_MS = 1000 / WORLD.tickHz;
const SERVER_POLL_MS = 5000;
const SESSION_EXPIRED = 'Session expired, log in again.';
const BAD_INVITE = 'That invite link is broken. Ask your squad for a new one, or start your own.';
const squadClosed = (code: string) => `Squad ${code} has closed. Start a new one.`;
const LOST_CONNECTION = 'Lost connection. Press Play to try again.';
const DIAL_TIMEOUT_MS = 4000;
const VIEW_RESEND_MS = 200;
const SERVER_MSG_TYPES: ReadonlySet<string> = new Set<ServerMsg['t']>(['welcome', 'walls', 'snap', 'chat', 'error']);

const canvas = $<HTMLCanvasElement>('game');
const ctx = canvas.getContext('2d')!;
const menuEl = $('menu');
const hudEl = $('hud');
const statusEl = $('menu-status');
const reconnectEl = $('reconnect');
const playBtn = $<HTMLButtonElement>('play');
const nameInput = $<HTMLInputElement>('name');
const serversEl = $('servers');
const squadEl = $('squad');
const squadChip = $('squad-chip');

let state: ClientState = { phase: 'menu', status: { kind: 'idle' } };
let loadout: Loadout = loadLoadout();
let muted = loadMuted();
let servers: ServerInfo[] | null = [];
let selectedRoom: string | null = null;
let squad: string | null = null;
let squadBusy = false;
let revealSquad = false;
let view: Layout = { w: 0, h: 0, dpr: 1, ui: 1, safe: NO_INSETS, phone: false, portraitPhone: false };
let aimCamera: Camera | null = null;
let viewTimer: ReturnType<typeof setTimeout> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
const held = new Set<Action>();
let fullBoard = false;
let firing = false;
const mouse = { x: 0, y: 0 };
/** Set by the first real mouse move; touch play never draws the mouse reticle. */
let mouseAiming = false;
let sticks: Sticks = NO_STICKS;
const audio = createAudio();
let trauma = 0;
let lastFrameAt = 0;

const params = new URLSearchParams(location.search);
const delaySend = makeDelay(Number(params.get('lag')) || 0, 0);
const delayRecv = makeDelay(Number(params.get('lag')) || 0, Number(params.get('jitter')) || 0);
let ghost: Ghost | null = null;

/** The session whose socket is live. While reconnecting the old session is only drawn, never sent to. */
const sessionOf = (st: ClientState): Session | null => (st.phase === 'playing' || st.phase === 'dead' ? st.s : null);
const drawnSessionOf = (st: ClientState): Session | null => (st.phase === 'menu' ? null : st.s);

function send(ws: WebSocket, msg: ClientMsg) {
  const data = JSON.stringify(msg);
  delaySend(() => { if (ws.readyState === WebSocket.OPEN) ws.send(data); });
}

function setState(next: ClientState) {
  const was = state;
  state = next;
  menuEl.hidden = next.phase !== 'menu';
  if (next.phase !== was.phase) {
    const room = next.phase === 'menu' ? null : next.s.rejoin.room;
    renderSquadChip(squadChip, room === squad ? squad : null, squad && inviteLink(location.href, squad));
  }
  hudEl.hidden = next.phase === 'menu';
  canvas.classList.toggle('aiming', next.phase === 'playing');
  reconnectEl.hidden = next.phase !== 'reconnecting';
  clearTimeout(retryTimer);
  if (next.phase === 'reconnecting') {
    reconnectEl.textContent = `Reconnecting… (attempt ${next.retry.attempt})`;
    if (!next.dial) retryTimer = setTimeout(redial, next.retry.nextAt - performance.now());
  }
  if (next.phase === 'menu') {
    overlays.reset();
    held.clear();
    firing = false;
    const st = next.status;
    statusEl.textContent = st.kind === 'error' ? st.message : st.kind === 'connecting' ? 'Connecting…' : '';
    statusEl.classList.toggle('error', st.kind === 'error');
    refreshPlayButton();
    void pollServers();
  }
}

function refreshPlayButton() {
  const connecting = state.phase === 'menu' && state.status.kind === 'connecting';
  playBtn.disabled = connecting || selectedRoom === null;
  playBtn.textContent = connecting ? 'Connecting…' : 'Play';
}

function setLoadout(next: Loadout) {
  loadout = next;
  saveLoadout(next);
  for (const p of pickers) p.refresh();
}

function play(room: string) {
  saveName(nameInput.value);
  const rejoin: Rejoin = { room, name: cleanName(nameInput.value), loadout, token: account.current()?.token };
  setState({ phase: 'menu', status: { kind: 'connecting', ws: dial(rejoin), rejoin } });
}

function redial() {
  if (state.phase !== 'reconnecting' || state.dial) return;
  const ws = dial(state.rejoin);
  setState({ ...state, dial: ws });
  setTimeout(() => { if (state.phase === 'reconnecting' && state.dial === ws) ws.close(); }, DIAL_TIMEOUT_MS);
}

function dial(rejoin: Rejoin): WebSocket {
  const { room, name, token } = rejoin;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?room=${encodeURIComponent(room)}`);
  ws.onopen = () => send(ws, { t: 'join', name, loadout: rejoin.loadout, token, aspect: viewAspect(view.w, view.h) });
  ws.onmessage = (ev) => delayRecv(() => {
    const msg = parseServerMsg(ev.data);
    if (!msg) return;
    onServerMsg(ws, msg);
    if (msg.t === 'welcome' && token && msg.account === null) {
      account.expire(SESSION_EXPIRED);
      sessionOf(state)?.chat.push({ from: '', text: SESSION_EXPIRED, team: null, at: performance.now() });
    }
  });
  ws.onclose = (ev) => onClose(ws, ev.code);
  return ws;
}

function onClose(ws: WebSocket, code: number) {
  const now = performance.now();
  switch (closeVerdict(socketRole(state, ws), code)) {
    case 'connect-failed': {
      const room = state.phase === 'menu' && state.status.kind === 'connecting' ? state.status.rejoin.room : null;
      if (room === null || room !== squad) return setState({ phase: 'menu', status: { kind: 'error', message: 'Disconnected from server.' } });
      setSquad(null);
      return setState({ phase: 'menu', status: { kind: 'error', message: squadClosed(room) } });
    }
    case 'drop':
      return setState({ phase: 'menu', status: { kind: 'error', message: 'Disconnected from server.' } });
    case 'reconnect':
      if (state.phase !== 'playing' && state.phase !== 'dead') return;
      return setState({ phase: 'reconnecting', s: state.s, rejoin: { ...state.s.rejoin, loadout }, retry: startRetry(now, Math.random()), dial: null });
    case 'retry-failed': {
      if (state.phase !== 'reconnecting') return;
      const retry = retryAfterFailure(state.retry, now, Math.random());
      return setState(retry ? { ...state, retry, dial: null } : { phase: 'menu', status: { kind: 'error', message: LOST_CONNECTION } });
    }
    case 'ignore': return;
  }
}

/** A deliberate leave lets go of every socket first, so their close events find nothing to reconnect. */
function leave() {
  const ws = state.phase === 'menu' ? (state.status.kind === 'connecting' ? state.status.ws : null) : state.phase === 'reconnecting' ? state.dial : state.s.ws;
  setState({ phase: 'menu', status: { kind: 'idle' } });
  ws?.close();
}

function parseServerMsg(data: unknown): ServerMsg | null {
  if (typeof data !== 'string') return null;
  try {
    const v: unknown = JSON.parse(data);
    return typeof v === 'object' && v !== null && SERVER_MSG_TYPES.has((v as { t: string }).t) ? (v as ServerMsg) : null;
  } catch {
    return null;
  }
}

function onServerMsg(ws: WebSocket, msg: ServerMsg) {
  const now = performance.now();
  if (state.phase === 'menu' || state.phase === 'reconnecting') {
    const pending = state.phase === 'reconnecting' ? (state.dial === ws ? state : null) : state.status.kind === 'connecting' && state.status.ws === ws ? state.status : null;
    if (!pending) return;
    if (msg.t === 'error') {
      setState({ phase: 'menu', status: { kind: 'error', message: msg.message } });
      ws.close();
    } else if (msg.t === 'welcome') {
      const resumed = state.phase === 'reconnecting' ? state.s : null;
      const s = newSession(ws, pending.rejoin, msg);
      if (resumed) s.chat = [...resumed.chat, { from: '', text: 'Reconnected.', team: null, at: now }];
      setState({ phase: 'playing', s });
    }
    return;
  }
  const s = state.s;
  if (s.ws !== ws) return;
  switch (msg.t) {
    case 'snap': {
      const snap = fillSnapshot(msg, newestSnap(s.snaps));
      return snap ? onSnap(s, snap, now) : undefined;
    }
    case 'walls': s.walls = msg.walls; s.worldSize = msg.worldSize; return;
    case 'chat': s.chat.push({ from: msg.from, text: msg.text, team: msg.team, at: now }); return;
    case 'error': s.chat.push({ from: '', text: msg.message, team: null, at: now }); return;
    case 'welcome': s.myId = msg.id; s.walls = msg.walls; s.worldSize = msg.worldSize; return;
  }
}

function newSession(ws: WebSocket, rejoin: Rejoin, welcome: { id: number; worldSize: number; walls: WallView[] }): Session {
  return {
    ws, rejoin, myId: welcome.id, worldSize: welcome.worldSize, walls: welcome.walls, snaps: EMPTY_BUFFER, seq: 0, shots: 0, predict: NO_PREDICTION, firing: NO_FIRING,
    lastSelf: { x: welcome.worldSize / 2, y: welcome.worldSize / 2 },
    effects: [], rounds: [], roundCover: new Map(), pendingFx: [], pendingShots: [], lastShotAt: new Map(), feedback: NO_FEEDBACK, moments: NO_MOMENTS, feed: [], chat: [], trails: new Map(), hurtAt: new Map(), cracks: createCracks(), pickSentFor: null, walk: { now: false, at: -Infinity }, particles: createPool(),
    coreHitAt: -Infinity, zombieFaces: new Map(), building: false, buildKind: 'wall', turretAims: new Map(),
  };
}

function playCues(s: Session, cues: readonly SoundCue[], viewRadius: number) {
  noteOwnShotSound(cues);
  audio.play(cues, s.lastSelf, viewRadius);
  for (const cue of cues) trauma = addTrauma(trauma, traumaFor(cue, s.lastSelf, viewRadius));
}

const playClick = (s: Session) => playCues(s, [{ id: 'click', ...s.lastSelf, self: true, gain: 1 }], WORLD.viewRadius);

function onSnap(s: Session, snap: Snapshot, now: number) {
  const prev = newestSnap(s.snaps);
  s.snaps = pushSnap(s.snaps, snap, now);
  const motion = selfMotion(snap);
  s.predict = reconcile(s.predict, motion.at, snap.ackSeq, solidsOf(s.walls, snap), motion.speed, s.worldSize);
  playCues(s, soundsFor(prev, snap), snap.self.viewRadius || WORLD.viewRadius);
  s.effects = s.effects.filter((fx) => now - fx.born < EFFECT_LIFE_MS[fx.kind]);
  s.moments = addMoments(s.moments, prev, snap, now);
  s.feedback = addFeedback(s.feedback, snap.events, snap.players, s.myId, selfOf(snap)?.maxHp ?? WORLD.baseHp, now);
  s.pendingFx.push(...scheduleEffects(snap, snap.tick * TICK_MS));
  s.rounds = s.rounds.filter((r) => roundLive(r, now));
  shooting.settleShots(s, snap, now);
  for (const ev of snap.events) if (ev.e === 'kill' || ev.e === 'hunted' || ev.e === 'life') s.feed = [...s.feed.slice(-9), { ...ev, at: now }];
  s.coreHitAt = nextCoreHitAt(prev?.run, snap.run, now, s.coreHitAt);
  aimTurrets(s.turretAims, snap, now);
  if (s.building && (snap.run?.phase !== 'day' || !snap.self.alive)) s.building = false;
  if (snap.self.pending?.level !== s.pickSentFor) s.pickSentFor = null;

  const dead = !snap.self.alive && !selfOf(snap)?.downed;
  if (dead && state.phase === 'playing') setState({ phase: 'dead', s, kill: killOf(snap.events, s.myId), loss: prev && lossOf(prev) });
  else if (dead && state.phase === 'dead' && !state.kill) state.kill = killOf(snap.events, s.myId);
  else if (!dead && state.phase === 'dead') setState({ phase: 'playing', s });
}

const sinceMove = (s: Session) => (s.walk.now ? 0 : performance.now() - s.walk.at);

function hands(s: Session): Hands {
  return { active: state.phase === 'playing' && !overlays.typing, firing, touchAim: touchAim(sticks), reload: held.has('reload'), sinceMove: sinceMove(s), aim: aimOffset(s) };
}

function deathTint(s: Session, spec: EffectSpec): string | undefined {
  if (spec.kind !== 'death') return undefined;
  const victim = newestSnap(s.snaps)?.players.find((p) => p.id === spec.victim);
  return victim && bodyColor(victim);
}

function aimOffset(s: Session): { dx: number; dy: number } {
  const touch = touchAim(sticks);
  if (touch) return touch;
  if (!aimCamera) return { dx: 1, dy: 0 };
  const self = worldToScreen(aimCamera, s.lastSelf);
  return { dx: (mouse.x - self.x) / aimCamera.scale, dy: (mouse.y - self.y) / aimCamera.scale };
}

setInterval(() => {
  const s = sessionOf(state);
  if (!s) return;
  const active = state.phase === 'playing' && !overlays.typing;
  s.seq++;
  const actions = active ? new Set([...held, ...touchMoves(sticks)]) : new Set<Action>();
  const touchAiming = shooting.pullTouchTrigger(s);
  const now = performance.now();
  shooting.fireBeforeSending(s, now);
  const input = committed(s.firing, assembleInput(actions, active && (firing || touchAiming), s.shots, aimOffset(s)));
  s.walk = { now: walks(input), at: walks(input) ? now : s.walk.at };
  const sent = sendInput(s.firing, s.seq, input, now);
  s.firing = sent.firing;
  if (sent.rejected) shooting.takeBack(s, sent.rejected);
  const viewAt = s.snaps.serverClockOffset === null ? null : Math.round(renderTime(s.snaps, performance.now()));
  send(s.ws, { t: 'input', seq: s.seq, input, viewAt });
  const latest = newestSnap(s.snaps);
  const ability = latest ? predictAbility(s.predict, input, latest) : null;
  s.predict = predictInput(s.predict, { seq: s.seq, input, dtMs: INPUT_MS, ability }, solidsOf(s.walls, latest), latest ? selfMotion(latest).speed : 0, performance.now(), s.worldSize);
}, INPUT_MS);

function pick(slot: number) {
  const s = sessionOf(state);
  const snap = s && newestSnap(s.snaps);
  const pending = snap?.self.pending;
  const gun = snap && selfOf(snap)?.gun;
  if (!s || !pending || !gun || s.pickSentFor === pending.level) return;
  const option = pickOptions(pending, gun)[slot];
  if (!option) return;
  send(s.ws, { t: 'pick', level: pending.level, option });
  s.pickSentFor = pending.level;
  playClick(s);
}

function toggleBuild(s: Session) {
  const run = newestSnap(s.snaps)?.run;
  if (!run || state.phase !== 'playing') return;
  if (!s.building && run.phase !== 'day') {
    s.chat.push({ from: '', text: 'You build by day.', team: null, at: performance.now() });
    return;
  }
  s.building = !s.building;
  playClick(s);
}

function pickBuildKind(s: Session, kind: BuildingKind) {
  if (s.buildKind === kind) return;
  s.buildKind = kind;
  playClick(s);
}

function buildClick(s: Session, e: MouseEvent) {
  const chip = e.button === 0 ? buildChipAt(e.clientX / view.ui, e.clientY / view.ui) : null;
  if (chip) return pickBuildKind(s, chip);
  if (!ghost) return;
  if (e.button === 0 && ghost.refusal === null) send(s.ws, { t: 'build', kind: ghost.kind, cx: ghost.cx, cy: ghost.cy });
  else if (e.button === 2 && ghost.refusal === 'taken') send(s.ws, { t: 'demolish', cx: ghost.cx, cy: ghost.cy });
  else return;
  playClick(s);
}

function respawn() {
  if (state.phase === 'dead') send(state.s.ws, { t: 'respawn', loadout });
}

function resize() {
  view = measureLayout();
  const { dpr, ui, safe } = view;
  canvas.width = Math.round(view.w * dpr);
  canvas.height = Math.round(view.h * dpr);
  canvas.style.width = `${view.w}px`;
  canvas.style.height = `${view.h}px`;
  setHudInsets({ l: safe.l / ui, t: safe.t / ui, r: safe.r / ui, b: safe.b / ui });
  setStickScale(ui);
  const root = document.documentElement;
  root.style.setProperty('--ui', String(ui));
  root.style.setProperty('--vw', `${view.w}px`);
  root.style.setProperty('--vh', `${view.h}px`);
  root.classList.toggle('phone', view.phone);
  root.classList.toggle('portrait-phone', view.portraitPhone);
  clearTimeout(viewTimer);
  viewTimer = setTimeout(() => {
    const s = sessionOf(state);
    if (s) send(s.ws, { t: 'view', aspect: viewAspect(view.w, view.h) });
  }, VIEW_RESEND_MS);
}

function updateTrails(s: Session, snap: Snapshot, now: number) {
  for (const p of snap.players) {
    if (!p.alive || (p.hidden && p.id !== s.myId)) continue;
    let trail = s.trails.get(p.id);
    if (!trail) s.trails.set(p.id, (trail = []));
    recordTrail(trail, p.x, p.y, now, p.dashing);
  }
  for (const [id, trail] of s.trails) if (!trail.length || now - trail.at(-1)!.at >= TRAIL.lifeMs) s.trails.delete(id);
}

function frame(now: number) {
  requestAnimationFrame(frame);
  const start = performance.now();
  drawFrame(now);
  noteFrameCost(performance.now() - start);
}

function drawFrame(now: number) {
  const s = drawnSessionOf(state);
  const latest = s && newestSnap(s.snaps);
  const interpolated = s && sampleAt(s.snaps.snaps, renderTime(s.snaps, now));
  if (!s || !interpolated || !latest) {
    drawBackdrop(ctx, view.w, view.h, view.dpr, now);
    return;
  }
  if (s === sessionOf(state)) shooting.fireIfDue(s, performance.now());
  const released = releaseDue(s.pendingFx, renderTime(s.snaps, now));
  s.pendingFx = released.rest;
  for (const { fx } of released.due) startEffect(s, fx, now, deathTint(s, fx));
  s.predict = decayCorrection(s.predict, now - lastFrameAt);
  const drawn = drawnPosition(s.predict, now, INPUT_MS);
  const players = drawn ? interpolated.players.map((p) => (p.id === s.myId ? { ...p, ...drawn, dashing: !!s.predict.afterNewest?.dash } : p)) : interpolated.players;
  const shots = releaseDue(s.pendingShots, renderTime(s.snaps, now));
  s.pendingShots = shots.rest;
  for (const { shot } of shots.due) shooting.fireOthersShot(s, shot, { ...interpolated, players }, now);
  s.roundCover = coverServerRounds(s.roundCover, interpolated.bullets, recentShooters(s.lastShotAt, renderTime(s.snaps, now)));
  const snap = { ...interpolated, players, bullets: drawnRounds(interpolated.bullets, s.rounds, s.roundCover, now) };
  const me = snap.players.find((p) => p.id === s.myId);
  if (me?.alive || me?.downed) s.lastSelf = { x: me.x, y: me.y };
  aimCamera = makeCamera(s.lastSelf, view.w, view.h, snap.self.viewRadius || WORLD.viewRadius);
  trauma = decay(trauma, now - lastFrameAt);
  lastFrameAt = now;
  const shake = offset(trauma, now);
  const shakenCamera = { ...aimCamera, x: aimCamera.x + shake.x / aimCamera.scale, y: aimCamera.y + shake.y / aimCamera.scale };
  updateTrails(s, snap, now);
  const aim = aimOffset(s);
  const selfAngle = state.phase === 'playing' ? Math.atan2(aim.dy, aim.dx) : null;
  noteFrame(s, snap, aimCamera, selfAngle, now);
  const killerId = state.phase === 'dead' ? state.kill?.killerId ?? null : null;
  const site = s.building && mouseAiming ? buildSiteOf(latest, s.walls, s.lastSelf) : null;
  ghost = site && ghostAt(site, s.buildKind, screenToWorld(aimCamera, mouse), s.worldSize);
  drawWorld(ctx, { snap, s, cam: shakenCamera, dpr: view.dpr, now, selfAngle, killerId, ghost });
  const spread = state.phase === 'playing' && mouseAiming && me?.alive && !s.building ? spreadFor(me.gun, snap.self.perks, isSteady(me.gun, sinceMove(s)), nextSprayShot(s.firing)) : null;
  // The HUD is laid out in "UI units" (screen px / ui), so one ui factor grows every panel on a phone; the camera it uses is the same
  // transform with its screen shrunk by ui, so world-anchored HUD (edge arrows, popups, fade-out tests) stays exact.
  const { ui } = view;
  const hudCamera = { ...shakenCamera, w: view.w / ui, h: view.h / ui, scale: shakenCamera.scale / ui };
  drawHud(ctx, view.dpr * ui, hudCamera, snap, s, now, { x: mouse.x / ui, y: mouse.y / ui }, spread, fullBoard);
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  if (state.phase === 'playing') drawSticks(ctx, sticks);
  overlays.update(state, s, latest, now, muted);
}

function onKeyDown(e: KeyboardEvent) {
  const s = sessionOf(state);
  if (!s) return;
  if (overlays.typing) {
    if (e.key === 'Enter') {
      const text = overlays.closeChat();
      if (text) send(s.ws, { t: 'chat', text });
    } else if (e.key === 'Escape') {
      overlays.closeChat();
    }
    return;
  }
  if (e.code === 'Tab') {
    e.preventDefault();
    fullBoard = true;
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    held.clear();
    firing = false;
    overlays.openChat();
    return;
  }
  if (e.code === 'KeyB') {
    toggleBuild(s);
    return;
  }
  if (e.code === 'KeyN' && !e.repeat && newestSnap(s.snaps)?.run?.phase === 'day' && state.phase === 'playing') {
    send(s.ws, { t: 'ready' });
    playClick(s);
    return;
  }
  if (e.code === 'KeyM') {
    const muted = audio.toggleMute();
    s.chat.push({ from: '', text: muted ? 'Sound off (M to turn on)' : 'Sound on', team: null, at: performance.now() });
    if (!muted) playClick(s);
    return;
  }
  const slot = perkSlotForKey(e.code);
  if (slot !== null && state.phase === 'playing' && s.building) {
    const kind = buildKindForKey(e.code);
    if (kind) pickBuildKind(s, kind);
    return;
  }
  if (slot !== null) {
    pick(slot);
    return;
  }
  const action = actionForKey(e.code);
  if (action && state.phase === 'playing') {
    e.preventDefault();
    held.add(action);
  }
}

function onKeyUp(e: KeyboardEvent) {
  if (e.code === 'Tab') fullBoard = false;
  const action = actionForKey(e.code);
  if (action) held.delete(action);
}

for (const type of ['pointerdown', 'keydown'] as const) window.addEventListener(type, audio.unlock, { capture: true });
window.addEventListener('keydown', onKeyDown);
window.addEventListener('keyup', onKeyUp);
window.addEventListener('blur', () => { held.clear(); firing = false; fullBoard = false; sticks = NO_STICKS; });
canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch') return;
  // Suppresses the emulated mousedown so a thumb on the move stick does not also fire.
  e.preventDefault();
  sticks = pressStick(sticks, e.pointerId, e.clientX, e.clientY, view.w);
});
window.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'touch') return;
  sticks = dragStick(sticks, e.pointerId, e.clientX, e.clientY);
  const s = sessionOf(state);
  if (s) shooting.pullTouchTrigger(s);
});
for (const type of ['pointerup', 'pointercancel'] as const) {
  window.addEventListener(type, (e) => { if (e.pointerType === 'touch') sticks = releaseStick(sticks, e.pointerId); });
}
for (const [id, action] of [['touch-ability', 'ability'], ['touch-reload', 'reload']] as const) {
  const button = $(id);
  button.addEventListener('pointerdown', (e) => { e.preventDefault(); held.add(action); });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave'] as const) button.addEventListener(type, () => held.delete(action));
}
window.addEventListener('mousemove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; mouseAiming = true; });
canvas.addEventListener('mousedown', (e) => {
  if (state.phase === 'playing' && state.s.building) return buildClick(state.s, e);
  if (e.button !== 0) return;
  firing = true;
  if (state.phase !== 'playing' || overlays.typing) return;
  state.s.shots++;
  shooting.fireIfDue(state.s, performance.now());
});
window.addEventListener('mouseup', (e) => { if (e.button === 0) firing = false; });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => { resize(); setTimeout(resize, 250); });
window.visualViewport?.addEventListener('resize', resize);
installTouchGuards(canvas);

async function pollServers() {
  if (state.phase !== 'menu') return;
  try {
    servers = await fetchServers();
  } catch {
    servers = null;
  }
  if (servers && selectedRoom !== squad && !servers.some((sv) => sv.id === selectedRoom)) selectedRoom = servers[0]?.id ?? null;
  showServers();
  if (revealSquad && state.phase === 'menu') {
    revealSquad = false;
    squadEl.scrollIntoView({ block: 'center' });
  }
}

let squadKey = '';

function showServers() {
  renderServers(serversEl, servers, selectedRoom, (id) => { selectedRoom = id; showServers(); });
  const key = `${squad}|${selectedRoom === squad}|${squadBusy}`;
  if (key !== squadKey) {
    squadKey = key;
    renderSquad(squadEl, { code: squad, selected: squad !== null && selectedRoom === squad, link: squad && inviteLink(location.href, squad), busy: squadBusy }, {
      start: () => void startSquad(),
      pick: () => { selectedRoom = squad; showServers(); },
    });
  }
  refreshPlayButton();
}

function setSquad(code: string | null) {
  if (code === null && selectedRoom === squad) selectedRoom = servers?.[0]?.id ?? null;
  squad = code;
  history.replaceState(null, '', withSquad(location.href, code));
  showServers();
}

async function startSquad() {
  if (squadBusy || state.phase !== 'menu' || state.status.kind === 'connecting') return;
  squadBusy = true;
  showServers();
  const opened = await openSquad();
  squadBusy = false;
  if ('error' in opened) {
    showServers();
    if (state.phase === 'menu') setState({ phase: 'menu', status: { kind: 'error', message: opened.error } });
    return;
  }
  setSquad(opened.room);
  selectedRoom = opened.room;
  showServers();
  play(opened.room);
}

function toggleMuted(name: string) {
  muted = toggleMute(muted, name);
  saveMuted(muted);
  renderMuted($('muted'), muted, toggleMuted);
}

const overlays = createOverlays(pick, respawn, toggleMuted);
const shooting = createShooting({ hands, playCues });
installDevProbe({ ctx, drawFrame, session: () => drawnSessionOf(state), camera: () => aimCamera, ghost: () => ghost });
renderMuted($('muted'), muted, toggleMuted);
const pickers = [
  mountLoadoutPicker($('loadout-menu'), () => loadout, setLoadout),
  mountLoadoutPicker($('loadout-death'), () => loadout, setLoadout),
];
const account = mountAccount($('account'), (a) => { if (a && !nameInput.value) nameInput.value = a.name; });
nameInput.value = loadName() || account.current()?.name || '';
renderControls($('controls'));
const a2hs = $('a2hs');
a2hs.hidden = !shouldShowHomeScreenHint();
$('a2hs-close').addEventListener('click', () => { dismissHomeScreenHint(); a2hs.hidden = true; });
const fsButton = $('fullscreen');
fsButton.hidden = !fullscreenSupported() || !window.matchMedia('(pointer: coarse)').matches;
fsButton.addEventListener('click', () => void goFullscreen());
$('play-form').addEventListener('submit', (e) => {
  e.preventDefault();
  // Playing is a user gesture, the only moment a browser lets a page take the whole screen.
  if (window.matchMedia('(pointer: coarse)').matches) void goFullscreen();
  if (selectedRoom !== null && !(state.phase === 'menu' && state.status.kind === 'connecting')) play(selectedRoom);
});
window.addEventListener('pagehide', leave);
window.addEventListener('online', () => {
  if (state.phase === 'reconnecting' && !state.dial) setState({ ...state, retry: retryNow(state.retry, performance.now()) });
});
setInterval(() => void pollServers(), SERVER_POLL_MS);

const invited = squadFromSearch(location.search);
if (invited === 'bad') {
  history.replaceState(null, '', withSquad(location.href, null));
  state = { phase: 'menu', status: { kind: 'error', message: BAD_INVITE } };
} else if (invited) {
  squad = selectedRoom = invited;
  revealSquad = true;
}
resize();
setState(state);
requestAnimationFrame(frame);
