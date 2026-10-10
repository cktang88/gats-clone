import { pickOptions, WORLD, ZOM, type BuildingKind, type ModeId } from '../shared/defs.ts';
import { linesOf } from '../shared/sim/build.ts';
import type { MapId } from '../shared/maps.ts';
import { cleanName, type ClientMsg, type Loadout, type PlayerView, type ServerMsg, type Snapshot, type WallView } from '../shared/protocol.ts';
import { fillSnapshot } from '../shared/wire.ts';
import { addGuestClaim, fetchServers, loadGuestClaims, loadLoadout, loadMuted, loadName, openSquad, saveLoadout, saveMuted, saveName, type ServerInfo } from './api.ts';
import { toggleMute } from './chatmute.ts';
import { boundLean, cursorPush, followLook, lookAhead, makeCamera, NO_LOOKCAM, screenToWorld, viewAspect, visibleHalf, worldToScreen, type Camera, type LookCam, type Point } from './camera.ts';
import { LOOK_AHEAD, lookReach } from '../shared/lookahead.ts';
import { createAudio } from './audio.ts';
import { musicDuck, musicProbe, musicStart, musicUpdate, setSoundMuted, toggleMusicMuted } from './music.ts';
import { mountRadioButton, onRoomRadio, radioPress, radioUpdate } from './radio.ts';
import { noteGains } from './pickups.ts';
import { killOf, lossOf, selfOf } from './derive.ts';
import { walks } from '../shared/sim/movement.ts';
import { isDeployed, rangeFor } from '../shared/sim/stats.ts';
import { assistAngle, type AssistTarget } from './aimassist.ts';
import { addFeedback, NO_FEEDBACK } from './feedback.ts';
import { addCareerToast, addMoments, NO_MOMENTS } from './moments.ts';
import { createMedalToasts } from './medaltoasts.ts';
import { freshLog, loadBests, logSnapshot, recapOf, saveBests } from './records.ts';
import { ABILITY_SCORE, abilityHint, boardNameAt, buildChipAt, drawnBoardNames, drawHud, drawnPhoneLayout, drawSticks, hudScaleFor, noteAbilityDenied, noteTopup, phoneBoardTap, setBoardHover, setHudFriends, setHudInsets } from './hud.ts';
import { createFriendsUi } from './friends.ts';
import { applyPhoneHud } from './phonehud.ts';
import { createAutoFullscreen, requestFullscreen } from './fullscreen.ts';
import { crosshairShown, drawPointer, installCursorLayer, pointerFor, type PointerKind } from './cursorlayer.ts';
import { dismissHomeScreenHint, installTouchGuards, measureLayout, shouldShowHomeScreenHint } from './viewport.ts';
import { canvasBox, fitCanvas } from './canvasfit.ts';
import { buttonFaces, createTouchButtons } from './touchbuttons.ts';
import { actionForKey, assembleInput, keyRepeats, perkSlotForKey, type Action } from './input.ts';
import { NO_STICKS, dragStick, pressStick, releaseStick, stickVector, touchAim, touchMoves, type Sticks } from './touch.ts';
import { releaseDue, scheduleEffects } from './eventclock.ts';
import { notePropEvents } from './propfx.ts';
import { layoutOf, noteTargetEvents, releaseTargetFx, resetTargetArt, targetBodies } from './targetart.ts';
import { resetRangeLine } from './rangeline.ts';
import { createRangeUi, openRangeRoom, renderRangeCard } from './rangeui.ts';
import { frameStep, resyncNet } from './resync.ts';
import { nextInputDue, pullsInput } from './inputclock.ts';
import { EMPTY_BUFFER, TICK_MS, newestSnap, pushSnap, renderTime, sampleAt } from './interp.ts';
import { $, mountAccount, mountLoadoutPicker, renderControls, renderMuted, renderServers, renderSquad, renderSquadChip } from './menu.ts';
import { makeDelay } from './netsim.ts';
import { setFeedbackGame, wireFeedback } from './contact.ts';
import { DISCORD_URL } from './config.ts';
import { applyDiscord, mountChangelog, renderTopBar } from './menubar.ts';
import { mountModePicker } from './modepicker.ts';
import { createOverlays } from './overlays.ts';
import { compactDeath, touchControlsShown } from './deathflow.ts';
import { createDelight } from './delight.ts';
import { doorsOf, decayCorrection, drawnPosition, NO_PREDICTION, predictAbility, predictInput, reconcile, selfMotion, solidsOf } from './predict.ts';
import { startEffect } from './effects.ts';
import { startBoom, startSlash } from './blastfx.ts';
import { gunFxOf, impact as gunImpact } from './gunfx.ts';
import { flinchOf, noteFlinch } from './flinch.ts';
import type { EffectSpec } from './eventclock.ts';
import { createPool } from './particles.ts';
import { coverServerRounds, drawnRounds, meetBodies, recentShooters, roundLive, roundScene } from './rounds.ts';
import { bodyColor, drawBackdrop, drawWorld, nightAmount } from './render.ts';
import { enterMap } from './mapscope.ts';
import { drawLightingDev } from './lightdev.ts';
import { initPostfx, processFrame, pulse as fxPulse } from './postfx.ts';
import { createCracks } from './decals.ts';
import { createShooting, type Hands } from './shooting.ts';
import { installDevProbe, noteFrame, noteFrameCost, noteOwnShotSound } from './devprobe.ts';
import { duckFor, emoteCue, soundsFor, type SoundCue } from './sfx.ts';
import { emitSfxAt, setSfxSink } from './sfxbus.ts';
import { startTopup } from './reloadanim.ts';
import { topupCues, topupOf } from './topup.ts';
import { committed, NO_FIRING, sendInput, spreadOf } from './fire.ts';
import { raiseWatch } from './raise.ts';
import { clearHits, drawHitMarker, onDeath, queueHits, releaseQueued, stopClock } from './killfx.ts';
import { stepClock } from './hitstop.ts';
import { drawHeartbeat, drawScreenPulse, reducedMotion, setPulseHook, zoomAt } from './screenfx.ts';
import { addKick, addTrauma, decay, offset, settleKick, traumaFor, type Kick } from './shake.ts';
import { closeVerdict, retryAfterFailure, retryNow, socketRole, startRetry } from './reconnect.ts';
import { EFFECT_LIFE_MS, type ClientState, type Rejoin, type Session } from './state.ts';
import { aimTurrets, nextCoreHitAt } from './siege.ts';
import { noteWrecks, wrecks } from './wrecks.ts';
import { addCorpse, addZombieCorpse, explosiveDeath } from './corpses.ts';
import { buildKindForKey, buildSiteOf, ghostAt, inviteLink, lineGhostAt, nextTier, squadFromSearch, stepItem, upgradeTarget, withSquad, type BuildChip, type Ghost } from './zombies.ts';
import { trackRootScale } from './uiscale.ts';
import { createPauseMenu, showToast } from './pausemenu.ts';
import { installPointerLock, lockWanted } from './pointerlock.ts';
import { escapeAction, takesInput } from './pausegate.ts';
import { lookAheadScale, mouseSensitivity, onSettings, shakeScale, touchAssistOn } from './settings.ts';
import { frameTick, initQuality, qualityProbe } from './qualityrt.ts';
import { MODE_INFO } from './modecards.ts';
import { createCelebration } from './celebrate.ts';
import { resetEmotes, noteEmote, setParty } from './emotefx.ts';
import { chatter, toggleChatter } from './chatter.ts';
import { createEmoteWheel } from './emotewheel.ts';
import { isAnniversary, isCenturion } from './friendly.ts';
import { EMOTES } from '../shared/emotes.ts';
import { COSMETIC_BY_ID, type Slot } from '../shared/cosmetics.ts';
import { cosLook, lookOfEquipped } from './cosmeticlook.ts';
import type { SceneId } from './modecards.ts';
import { createMenuScene } from './menuscene.ts';
import { createAttract } from './attract.ts';
import { createGearStage } from './gearup.ts';
import { createMenuFlow } from './menuflow.ts';
import { createWardrobe } from './wardrobe.ts';
import { createArmory } from './armory.ts';
import { renderLevelCard } from './levelcard.ts';
import { createChallengePanel } from './challengepanel.ts';
import { createXpCard } from './xpcard.ts';
import { createChallengeToasts } from './challengetoast.ts';
import { parseServerMsg, routeServerMsg } from './servermsg.ts';
import { newlyDone, openChallenges } from './progression.ts';
import { guestNudge, isUnrecordedNotice, mountEnlist, type Stakes } from './enlist.ts';

const INPUT_MS = 1000 / WORLD.tickHz;
const SERVER_POLL_MS = 5000;
const SESSION_EXPIRED = 'Session expired, log in again.';
const BAD_INVITE = 'That invite link is broken. Ask your squad for a new one, or start your own.';
const squadClosed = (code: string) => `Squad ${code} has closed. Start a new one.`;
const LOST_CONNECTION = 'Lost connection. Press Play to try again.';
const DIAL_TIMEOUT_MS = 4000;
const VIEW_RESEND_MS = 200;

const canvas = $<HTMLCanvasElement>('game');
const ctx = canvas.getContext('2d')!;
initPostfx($<HTMLCanvasElement>('fx'));
// When the post pass owns the world, a kill's chromatic split is its pulse rather than the 2D one (screenfx.ts).
setPulseHook((strength) => fxPulse(0.6 * strength));
const menuEl = $('menu');
const hudEl = $('hud');
const statusEl = $('menu-status');
const reconnectEl = $('reconnect');
const playBtn = $<HTMLButtonElement>('play');
const nameInput = $<HTMLInputElement>('name');
const serversEl = $('servers');
const squadEl = $('squad');
/** The mode card: first a mode, then Next goes on to its loadout step, whose Deploy joins the match (the range opens at once). */
const roomFor = (mode: SceneId) => servers?.find((x) => x.mode === mode) ?? null;
const modePicker = mountModePicker($('mode-grid'), {
  next: (mode) => {
    if (mode === 'RNG') { void startRange(); return; }
    if (mode === 'ZOM') chooseZombies();
    else { const sv = roomFor(mode); if (sv) chooseRoom(sv.id, sv.mode); }
  },
});
const squadChip = $('squad-chip');

let state: ClientState = { phase: 'menu', status: { kind: 'idle' } };
let loadout: Loadout = loadLoadout();
let muted = loadMuted();
let servers: ServerInfo[] | null = [];
let selectedRoom: string | null = null;
let squad: string | null = null;
let squadBusy = false;
let rangeBusy = false;
/** The mode picked on the first menu step, and whether one has been picked (the cards only show a pick once you made it). */
let mission: SceneId = 'FFA';
/** The loadout pickers, once mounted; each shows Zombies' bounties and perks while the mission is Zombies. */
let loadoutPickers: readonly { refresh(): void }[] = [];
let chosen = false;
let revealSquad = false;
let view = { w: 0, h: 0, dpr: 1 };
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
// Sounds that do not come from a snapshot (celebration, slow-motion, killcam) arrive here.
setSfxSink({ cues: (cues) => { if (state.phase !== 'menu') playCues(state.s, cues, WORLD.viewRadius); }, muffle: (on) => audio.muffle(on) });
const touchScreen = matchMedia('(pointer: coarse)').matches;
/** The first tap in each match asks for fullscreen where the page can have it (fullscreen.ts); an iPhone cannot, see the menu's tip. */
const autoFullscreen = createAutoFullscreen(document, document.documentElement, { touch: () => touchScreen, lock: () => lockLandscape() });
let trauma = 0;
/** A Space press is sent with the next input even if the key was already let go, so a quick tap is never lost between input ticks. */
let abilityTapped = false;
let kick: Kick = { x: 0, y: 0 };
let lastFrameAt = 0;

const params = new URLSearchParams(location.search);
const delaySend = makeDelay(Number(params.get('lag')) || 0, 0);
const delayRecv = makeDelay(Number(params.get('lag')) || 0, Number(params.get('jitter')) || 0);
let ghost: Ghost | null = null;
/** A line being dragged out in build mode: the cell the press began on, till the button comes up (Esc or a right click drops it). */
let drag: { cx: number; cy: number } | null = null;

/** The session whose socket is live. While reconnecting the old session is only drawn, never sent to. */
const sessionOf = (st: ClientState): Session | null => (st.phase === 'playing' || st.phase === 'dead' ? st.s : null);
const drawnSessionOf = (st: ClientState): Session | null => (st.phase === 'menu' ? null : st.s);

/** The radio's messages go to the room we are in, if any. */
function sendRadio(msg: ClientMsg) { const s = sessionOf(state); if (s) send(s.ws, msg); }

function send(ws: WebSocket, msg: ClientMsg) {
  const data = JSON.stringify(msg);
  delaySend(() => { if (ws.readyState === WebSocket.OPEN) ws.send(data); });
}

function setState(next: ClientState) {
  const was = state;
  state = next;
  menuEl.hidden = next.phase !== 'menu';
  flow.setVisible(next.phase === 'menu');
  if (next.phase !== was.phase) {
    if (next.phase === 'menu') autoFullscreen.matchEnded();
    else if (was.phase === 'menu') autoFullscreen.matchStarted();
    const room = next.phase === 'menu' ? null : next.s.rejoin.room;
    renderSquadChip(squadChip, room === squad ? squad : null, squad && inviteLink(location.href, squad));
  }
  hudEl.hidden = next.phase === 'menu';
  canvas.classList.toggle('aiming', next.phase === 'playing');
  // Dead (or spectating), nothing in-match looks tappable: reload, the ability, GG and radio fold away, and a held stick lets go.
  hudEl.classList.toggle('no-touch-controls', !touchControlsShown(next.phase));
  if (next.phase !== was.phase && (next.phase === 'dead' || was.phase === 'dead')) {
    sticks = NO_STICKS;
    held.clear();
    firing = false;
    abilityTapped = false;
    if (next.phase === 'dead') wheel.close();
  }
  reconnectEl.hidden = next.phase !== 'reconnecting';
  clearTimeout(retryTimer);
  if (next.phase === 'reconnecting') {
    reconnectEl.textContent = `Reconnecting… (attempt ${next.retry.attempt})`;
    if (!next.dial) retryTimer = setTimeout(redial, next.retry.nextAt - performance.now());
  }
  if (next.phase === 'menu') {
    overlays.reset();
    pause.reset();
    rangeUi.hide();
    resetTargetArt();
    resetRangeLine();
    xpCard.reset();
    if (was.phase !== 'menu') { void wardrobe.refresh(nameInput.value); flow.go('modes', { focus: false }); }
    if (chatterOpenArmory) { const slot = chatterOpenArmory; chatterOpenArmory = null; queueMicrotask(() => { showTab('tab-armory'); armory.open(slot); }); }
    delight.reset();
    celebrate.reset();
    resetEmotes();
    clearHits();
    chatter.reset();
    wheel.close();
    setParty(false);
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
  playBtn.disabled = connecting || (selectedRoom === null && mission !== 'ZOM');
  playBtn.textContent = connecting ? 'Connecting…' : 'Deploy';
}

function setLoadout(next: Loadout) {
  loadout = next;
  saveLoadout(next);
  for (const p of pickers) p.refresh();
  gearStage.paint();
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
  ws.onopen = () => send(ws, { t: 'join', name, loadout: rejoin.loadout, token, aspect: viewAspect(view.w, view.h), cosmetics: wardrobe.joinPicks() });
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
  friendsUi.reset();
  ws?.close();
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
      // This join made the guest name's profile: keep its claim, so registering later carries that progress over.
      if (msg.guest) addGuestClaim(msg.guest);
      const resumed = state.phase === 'reconnecting' ? state.s : null;
      const s = newSession(ws, pending.rejoin, msg);
      enterMap(msg.map);
      void checkAnniversary(msg.account);
      if (resumed) s.chat = [...resumed.chat, { from: '', text: 'Reconnected.', team: null, at: now }];
      setState({ phase: 'playing', s });
    }
    return;
  }
  const s = state.s;
  if (s.ws !== ws) return;
  // Every type the server sends has its handler here: the compiler refuses one left out (servermsg.ts).
  routeServerMsg(msg, {
    snap: (m) => { const snap = fillSnapshot(m, newestSnap(s.snaps)); if (snap) onSnap(s, snap, now); },
    radio: (m) => onRoomRadio(m.station, now),
    walls: (m) => { s.walls = m.walls; s.worldSize = m.worldSize; s.mapId = m.map; enterMap(m.map); },
    chat: (m) => { s.chat.push({ from: m.from, text: m.text, team: m.team, at: now }); if (isUnrecordedNotice(m.from, m.text)) noteStakes({ unrecorded: true }); },
    emote: (m) => { noteEmote(m.pid, m.id, now); const at = newestSnap(s.snaps), pop = at && emoteCue(at, m.pid); if (pop) playCues(s, [pop], at.self.viewRadius || WORLD.viewRadius); },
    badge: (m) => {
      noteStakes({ medal: true });
      if (isCenturion(m.badge) && aimCamera) { const at = worldToScreen(aimCamera, s.lastSelf); celebrate.puff(at.x, at.y - 30, bodyColor({ color: loadout.color, team: null })); }
      s.moments = addCareerToast(s.moments, m.badge, m.score, now); playCues(s, [{ id: 'fanfare', ...s.lastSelf, self: true, gain: 1 }], WORLD.viewRadius);
    },
    error: (m) => { s.chat.push({ from: '', text: m.message, team: null, at: now }); },
    friendInvite: (m) => friendsUi.onInvite(m.from, m.name),
    friends: (m) => friendsUi.setFriends(m.ids),
    friendNote: (m) => { s.chat.push({ from: '', text: m.text, team: null, at: now }); },
    welcome: (m) => { friendsUi.reset(); s.myId = m.id; s.walls = m.walls; s.worldSize = m.worldSize; s.mapId = m.map; enterMap(m.map); },
    progress: (m) => onProgress(m),
    equipped: (m) => wardrobe.onEquipped(m.equipped),
  });
}

/** Account progress: the new totals reach the menu's cards, the XP card waits to be shown, a completed challenge toasts. */
function onProgress(msg: Extract<ServerMsg, { t: 'progress' }>) {
  for (const c of newlyDone(wardrobe.state().challenges, msg.challenges)) challengeToast(c);
  wardrobe.onProgress(msg);
  xpCard.onProgress(msg);
  if (msg.levelUps.length) noteStakes({ level: true });
}

function newSession(ws: WebSocket, rejoin: Rejoin, welcome: { id: number; worldSize: number; map?: MapId; walls: WallView[] }): Session {
  return {
    ws, rejoin, myId: welcome.id, worldSize: welcome.worldSize, walls: welcome.walls, mapId: welcome.map, snaps: EMPTY_BUFFER, seq: 0, shots: 0, predict: NO_PREDICTION, firing: NO_FIRING,
    lastSelf: { x: welcome.worldSize / 2, y: welcome.worldSize / 2 },
    effects: [], corpses: [], zombieCorpses: { list: [], dawnAt: null }, rounds: [], roundCover: new Map(), pendingFx: [], pendingShots: [], lastShotAt: new Map(), feedback: NO_FEEDBACK, moments: NO_MOMENTS, life: null, bests: loadBests(), feed: [], chat: [], hurtAt: new Map(), cracks: createCracks(), pickSentFor: null, walk: { now: false, at: -Infinity }, particles: createPool(),
    coreHitAt: -Infinity, building: false, buildKind: 'wall', buildTier: 1, buildGhost: null, turretAims: new Map(),
  };
}

function playCues(s: Session, cues: readonly SoundCue[], viewRadius: number) {
  noteOwnShotSound(cues);
  audio.play(cues, s.lastSelf, viewRadius);
  for (const cue of cues) { const d = duckFor(cue, s.lastSelf, viewRadius); if (d) musicDuck(d.depth, d.holdMs); }
  if (!reducedMotion()) for (const cue of cues) trauma = addTrauma(trauma, traumaFor(cue, s.lastSelf, viewRadius) * shakeScale());
}

const playClick = (s: Session) => playCues(s, [{ id: 'click', ...s.lastSelf, self: true, gain: 1 }], WORLD.viewRadius);

/** A kill put `n` rounds back in your mag: a patter of rounds, the support hand's tap and a "+n" on the magazine (topup.ts). */
function onTopup(s: Session, n: number, now: number) {
  for (const c of topupCues(n)) emitSfxAt(c.id, s.lastSelf.x, s.lastSelf.y, true, { gain: c.gain, pitch: c.pitch, ...(c.delayMs ? { delayMs: c.delayMs } : {}) });
  startTopup(s.myId, now);
  noteTopup(n, now);
}

function onSnap(s: Session, snap: Snapshot, now: number) {
  const prev = newestSnap(s.snaps);
  s.snaps = pushSnap(s.snaps, snap, now);
  const motion = selfMotion(snap);
  s.predict = reconcile(s.predict, motion.at, snap.ackSeq, solidsOf(s.walls, snap, doorsOf(s)), motion.speed, s.worldSize);
  playCues(s, soundsFor(prev, snap), snap.self.viewRadius || WORLD.viewRadius);
  s.effects = s.effects.filter((fx) => now - fx.born < EFFECT_LIFE_MS[fx.kind]);
  s.moments = addMoments(s.moments, prev, snap, now, s.bests.kills);
  delight.onSnap(s, snap, prev, now, state.phase);
  queueHits(snap.events, s.myId, snap.tick * TICK_MS);
  noteGains(snap, s.myId, now);
  s.feedback = addFeedback(s.feedback, snap.events, snap.players, s.myId, selfOf(snap)?.maxHp ?? WORLD.baseHp, now);
  celebrate.onSnap(snap, now);
  const topped = topupOf(prev, snap, s.myId);
  if (topped > 0) onTopup(s, topped, now);
  chatter.onSnap(snap, s.myId, now);
  // No frame drains these while the tab is hidden, so they would pile up and all land on the first frame back.
  if (!document.hidden) s.pendingFx.push(...scheduleEffects(snap, snap.tick * TICK_MS));
  notePropEvents(snap, now);
  noteTargetEvents(snap, snap.tick * TICK_MS);
  rangeUi.update(snap, s.myId);
  s.rounds = s.rounds.filter((r) => roundLive(r, now));
  shooting.settleShots(s, snap, now);
  if (document.hidden) s.pendingShots = [];
  for (const ev of snap.events) {
    const repeatsKnock = ev.e === 'life' && ev.k === 'downed' && !!snap.royale;
    if ((ev.e === 'kill' || ev.e === 'hunted' || ev.e === 'life' || ev.e === 'wiped' || ev.e === 'airdrop') && !repeatsKnock) s.feed = [...s.feed.slice(-9), { ...ev, at: now }];
  }
  s.coreHitAt = nextCoreHitAt(prev?.run, snap.run, now, s.coreHitAt);
  aimTurrets(s.turretAims, snap, now);
  wrecks.list = noteWrecks(wrecks.list, prev, snap, now);
  if (s.building && (snap.run?.phase !== 'day' || !snap.self.alive)) s.building = false;
  if (snap.self.pending?.level !== s.pickSentFor) s.pickSentFor = null;

  const dead = !snap.self.alive && !selfOf(snap)?.downed;
  if (!snap.run && (snap.self.alive || s.life)) s.life = logSnapshot(s.life ?? freshLog(now), snap);
  if (dead && state.phase === 'playing') {
    const recap = s.life && recapOf(s.life, now, s.bests);
    s.life = null;
    if (recap) saveBests((s.bests = recap.bests));
    const kill = killOf(snap.events, s.myId);
    setState({ phase: 'dead', s, kill, loss: prev && lossOf(prev), recap });
    delight.onDeath(s, snap, kill, performance.now());
  }
  else if (dead && state.phase === 'dead' && !state.kill) state.kill = killOf(snap.events, s.myId);
  else if (!dead && state.phase === 'dead') setState({ phase: 'playing', s });
}

const sinceMove = (s: Session) => (s.walk.now ? 0 : performance.now() - s.walk.at);

function hands(s: Session): Hands {
  return { active: takesInput(state.phase, overlays.typing, pause.isOpen()), firing, touchAim: touchAim(sticks), reload: held.has('reload'), sinceMove: sinceMove(s), aim: aimOffset(s) };
}

/** The fallen player stays where the killing blow found them, facing the way they last faced, with the gun they held. */
function layCorpse(s: Session, snap: Snapshot, fx: Extract<EffectSpec, { kind: 'death' }>, now: number) {
  // The newest snapshot may already have dropped the dead, so look back to the last one that showed them.
  const lastSeen = (id: number) => [...s.snaps.snaps].reverse().flatMap((sn) => sn.players.filter((p) => p.id === id))[0];
  const victim = lastSeen(fx.victim);
  if (!victim) return;
  const killer = fx.by === null || fx.by === fx.victim ? undefined : lastSeen(fx.by);
  const blow = killer && Math.hypot(fx.x - killer.x, fx.y - killer.y) > 1 ? Math.atan2(fx.y - killer.y, fx.x - killer.x) : null;
  s.corpses = addCorpse(s.corpses, {
    victim: victim.id, x: fx.x, y: fx.y, angle: victim.angle, color: bodyColor(victim), gun: victim.gun, map: snap.match.map, born: now,
    blow, blast: explosiveDeath(fx.weapon), ...(victim.cos && { cos: victim.cos }),
  });
}

/** A dead zombie stays where it fell until dawn, its ichor sprayed away from the squad player who killed it. */
let zombieCorpseIds = 0;
function layZombieCorpse(s: Session, fx: Extract<EffectSpec, { kind: 'splat' }>, now: number) {
  const killer = fx.by === null ? undefined : [...s.snaps.snaps].reverse().flatMap((sn) => sn.players.filter((p) => p.id === fx.by))[0];
  const blow = killer && Math.hypot(fx.x - killer.x, fx.y - killer.y) > 1 ? Math.atan2(fx.y - killer.y, fx.x - killer.x) : null;
  s.zombieCorpses = { ...s.zombieCorpses, list: addZombieCorpse(s.zombieCorpses.list, { id: ++zombieCorpseIds, x: fx.x, y: fx.y, kind: fx.zombie, born: now, blow }) };
}

function deathTint(s: Session, spec: EffectSpec): string | undefined {
  if (spec.kind !== 'death') return undefined;
  const victim = newestSnap(s.snaps)?.players.find((p) => p.id === spec.victim);
  return victim && bodyColor(victim);
}

/** A death as it lands on screen: the burst at the blow, thrown away from whoever fired it. */
function noteDeath(s: Session, fx: Extract<EffectSpec, { kind: 'death' }>, color: string | undefined, realNow: number) {
  const killer = fx.by === null || fx.by === fx.victim ? undefined : [...s.snaps.snaps].reverse().flatMap((sn) => sn.players.filter((p) => p.id === fx.by))[0];
  const dir = killer && Math.hypot(fx.x - killer.x, fx.y - killer.y) > 1 ? Math.atan2(fx.y - killer.y, fx.x - killer.x) : null;
  onDeath({ x: fx.x, y: fx.y, color: color ?? '#7a808b', dir, mine: fx.by === s.myId && fx.victim !== s.myId, self: fx.victim === s.myId, ...(killer?.cos?.k && { fx: killer.cos.k }) }, realNow);
}

/** The enemies drawn this frame with their velocity from the two newest snapshots, for the touch aim assist. */
let assistTargets: AssistTarget[] = [];

function noteAssistTargets(s: Session, drawnPlayers: readonly PlayerView[]) {
  const [older, newer] = s.snaps.snaps.slice(-2);
  const me = drawnPlayers.find((p) => p.id === s.myId);
  if (!older || !newer || !me) { assistTargets = []; return; }
  const dt = ((newer.tick - older.tick) * TICK_MS) / 1000 || 1;
  assistTargets = drawnPlayers.flatMap((p) => {
    if (p.id === s.myId || !p.alive || p.hidden || (p.team !== null && p.team === me.team)) return [];
    const a = older.players.find((q) => q.id === p.id), b = newer.players.find((q) => q.id === p.id);
    return [{ x: p.x, y: p.y, vx: a && b ? (b.x - a.x) / dt : 0, vy: a && b ? (b.y - a.y) / dt : 0 }];
  });
}

/** A thumb's aim, lightly pulled toward the led enemy nearest its line (see `ASSIST`); a mouse aims unassisted. */
function assistedTouch(s: Session, touch: { dx: number; dy: number }): { dx: number; dy: number } {
  const snap = newestSnap(s.snaps);
  const me = snap?.players.find((p) => p.id === s.myId);
  if (!snap || !me?.alive) return touch;
  const angle = Math.atan2(touch.dy, touch.dx), len = Math.hypot(touch.dx, touch.dy);
  const helped = assistAngle(angle, s.lastSelf, me.gun, rangeFor(me.gun, snap.self.perks), assistTargets);
  return { dx: Math.cos(helped) * len, dy: Math.sin(helped) * len };
}

function aimOffset(s: Session): { dx: number; dy: number } {
  const touch = touchAim(sticks);
  if (touch) return touchAssistOn() ? assistedTouch(s, touch) : touch;
  if (!aimCamera) return { dx: 1, dy: 0 };
  const self = worldToScreen(aimCamera, s.lastSelf);
  return { dx: (mouse.x - self.x) / aimCamera.scale, dy: (mouse.y - self.y) / aimCamera.scale };
}

/** The aim look-ahead's camera lean (camera.ts `followLook`), eased on the real clock so a slow motion does not drag it. */
let lookCam: LookCam = NO_LOOKCAM;
let lookFrameAt = 0;

/** Where the lean wants to be: along your aim, as far as the cursor (or the aim stick) is pushed, for your own live soldier only. */
function leanTarget(s: Session, me: PlayerView, viewRadius: number): Point {
  const scale = lookAheadScale();
  if (!scale) return { x: 0, y: 0 };
  const reduced = reducedMotion();
  const reach = lookReach(viewRadius, me.gun) * scale * (reduced ? 0.5 : 1);
  // Reduced motion: a shorter lean on a flatter curve, so small cursor moves leave the view still.
  const ease = reduced ? 1.8 : LOOK_AHEAD.ease;
  const { dx, dy } = aimOffset(s);
  const half = visibleHalf(view.w, view.h, viewRadius);
  // A thumb leans less than a mouse and keeps further from the edge (LOOK_AHEAD.touch, touchEdge); either way your own soldier stays well inside the screen (boundLean).
  if (sticks.aim && touchAim(sticks)) return boundLean(lookAhead({ x: dx, y: dy }, stickVector(sticks.aim).mag, reach * LOOK_AHEAD.touch, ease), half, LOOK_AHEAD.touchEdge);
  if (!mouseAiming || touchScreen) return { x: 0, y: 0 };
  return boundLean(lookAhead({ x: dx, y: dy }, cursorPush(mouse, view.w, view.h), reach, ease), half);
}

/**
 * This frame's lean: it holds still while the soldier takes no input (a menu, the chat line) or builds (the cell under the cursor must
 * not slide while you place), and eases home when you are not playing.
 */
function stepLean(s: Session, snap: Snapshot, me: PlayerView | undefined, eye: PlayerView | undefined, realNow: number): Point {
  const dt = lookFrameAt ? Math.min(250, realNow - lookFrameAt) : 0;
  lookFrameAt = realNow;
  if (!eye) return { x: lookCam.x, y: lookCam.y };
  const own = state.phase === 'playing' && !!me?.alive && eye === me;
  const active = takesInput(state.phase, overlays.typing, pause.isOpen()) && !s.building;
  const target = !own ? { x: 0, y: 0 } : active ? leanTarget(s, me!, snap.self.viewRadius || WORLD.viewRadius) : { x: lookCam.x, y: lookCam.y };
  const quick = own && (firing || isDeployed(me!.gun, sinceMove(s)));
  lookCam = followLook(lookCam, eye, `${eye.id}|${s.mapId}`, target, dt, quick ? LOOK_AHEAD.aimRate : LOOK_AHEAD.rate);
  // The eased lean stays inside the bound its targets keep to; this only binds the frame a resize, a rotated phone or a lost scope shrinks it.
  const bounded = boundLean(lookCam, visibleHalf(view.w, view.h, snap.self.viewRadius || WORLD.viewRadius));
  lookCam = { ...lookCam, x: bounded.x, y: bounded.y };
  return { x: lookCam.x, y: lookCam.y };
}

function sendInputTick() {
  const s = sessionOf(state);
  if (!s) return;
  const hidden = document.hidden;
  const active = !hidden && takesInput(state.phase, overlays.typing, pause.isOpen());
  s.seq++;
  const actions = active ? new Set([...held, ...touchMoves(sticks), ...(abilityTapped ? ['ability' as const] : [])]) : new Set<Action>();
  abilityTapped = false;
  const touchAiming = shooting.pullTouchTrigger(s);
  const now = performance.now();
  shooting.fireBeforeSending(s, now);
  // A shot drawn ahead of this input goes out along the aim it was drawn with, judged against the world drawn then (see `PredictedShot`).
  const ahead = s.firing.ahead;
  const aimed = assembleInput(actions, active && (firing || touchAiming), s.shots, aimOffset(s));
  const input = committed(s.firing, ahead?.angle !== undefined ? { ...aimed, angle: ahead.angle } : aimed);
  s.walk = { now: walks(input), at: walks(input) ? now : s.walk.at };
  // The trigger keeps no sprint through a dash, as the sim does (fire.ts), so it is told whether one runs as this input is taken.
  const sent = sendInput(s.firing, s.seq, { ...input, dashing: !!s.predict.afterNewest?.dash }, now);
  s.firing = sent.firing;
  if (sent.rejected) shooting.takeBack(s, sent.rejected);
  else if (ahead) shooting.respreadShot(s, ahead, spreadOf(sent.firing));
  const viewAt = ahead?.viewAt !== undefined ? ahead.viewAt : s.snaps.serverClockOffset === null ? null : Math.round(renderTime(s.snaps, performance.now()));
  send(s.ws, { t: 'input', seq: s.seq, input, viewAt });
  // A hidden tab's timer is throttled to about 1 Hz: sending neutral inputs keeps the player alive, but predicting a step for each would drift far from the server.
  if (hidden) return;
  const latest = newestSnap(s.snaps);
  const ability = latest ? predictAbility(s.predict, input, latest) : null;
  s.predict = predictInput(s.predict, { seq: s.seq, input, dtMs: INPUT_MS, ability }, solidsOf(s.walls, latest, doorsOf(s)), latest ? selfMotion(latest).speed : 0, performance.now(), s.worldSize);
}

// One input per server tick on average (see inputclock.ts), not setInterval's 30.3 a second.
let inputDueAt = performance.now();
let inputTimer: ReturnType<typeof setTimeout> | undefined;
let inputSentAt = -Infinity;
function inputLoop() {
  inputDueAt = nextInputDue(performance.now(), inputDueAt, INPUT_MS);
  // Scheduled first, so a throw in one tick's input cannot stop the inputs for good.
  inputTimer = setTimeout(inputLoop, Math.max(0, inputDueAt - performance.now()));
  inputSentAt = performance.now();
  sendInputTick();
}
inputLoop();
/** A move key changed: send now and restart the schedule from here (see inputclock.ts `pullsInput`). */
function inputNow() {
  const now = performance.now();
  if (!pullsInput(now, inputSentAt, INPUT_MS)) return;
  clearTimeout(inputTimer);
  inputDueAt = now - INPUT_MS;
  inputLoop();
}

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

/** Picks what build mode puts up; a wall's `lv` is its tier, and its key again steps to the next tier. */
function pickBuildKind(s: Session, kind: BuildingKind, lv?: number) {
  const tier = kind === 'wall' ? (lv ?? (s.buildKind === 'wall' ? nextTier(s.buildTier) : s.buildTier)) : s.buildTier;
  if (s.buildKind === kind && s.buildTier === tier) return;
  s.buildKind = kind;
  s.buildTier = tier;
  playClick(s);
}

/** The wheel steps through everything build mode can put up, walls by tier first. */
function stepBuildItem(s: Session, step: number) {
  const next = stepItem({ kind: s.buildKind, lv: s.buildTier }, step);
  s.buildKind = next.kind;
  s.buildTier = next.lv;
  playClick(s);
}

function sendUpgrade(s: Session, cx: number, cy: number) {
  send(s.ws, { t: 'upgrade', cx, cy });
  playClick(s);
}

/** A click or tap on a chip of the build bar: it picks what to build, or upgrades the building last hovered. */
function pressBuildChip(s: Session, chip: BuildChip) {
  if ('upgrade' in chip) { if (ghost?.hover && ghost.upgrade === null) sendUpgrade(s, ghost.cx, ghost.cy); return; }
  pickBuildKind(s, chip.kind, chip.lv);
}

function buildClick(s: Session, e: MouseEvent) {
  const chip: BuildChip | null = e.button === 0 ? buildChipAt(mouse.x, mouse.y) : null;
  if (chip) return pressBuildChip(s, chip);
  if (!ghost) return;
  if (e.button === 2 && drag) { drag = null; return; }
  // A press on an open cell with a wall or spike strip picked starts a line; letting go builds it (`finishDrag`), a press let go where it began builds the one.
  if (e.button === 0 && linesOf(ghost.kind) && ghost.refusal !== 'taken') { drag = { cx: ghost.cx, cy: ghost.cy }; return; }
  if (e.button === 0 && ghost.refusal === null) send(s.ws, { t: 'build', kind: ghost.kind, cx: ghost.cx, cy: ghost.cy, ...(ghost.kind === 'wall' && ghost.lv > 1 && { lv: ghost.lv }) });
  else if (e.button === 0 && ghost.refusal === 'taken' && ghost.upgrade === null) send(s.ws, { t: 'upgrade', cx: ghost.cx, cy: ghost.cy });
  else if (e.button === 2 && ghost.refusal === 'taken') send(s.ws, { t: 'demolish', cx: ghost.cx, cy: ghost.cy });
  else return;
  playClick(s);
}

/** The button came up on a dragged line: what its ghost showed goes up, the server judging each cell again in the same order. */
function finishDrag() {
  const s = sessionOf(state), line = drag && ghost?.line;
  drag = null;
  if (!s || state.phase !== 'playing' || !s.building || !ghost || !line?.some((c) => c.refusal === null)) return;
  const lv = ghost.kind === 'wall' && ghost.lv > 1 ? { lv: ghost.lv } : {};
  if (line.length === 1) send(s.ws, { t: 'build', kind: ghost.kind, cx: line[0]!.cx, cy: line[0]!.cy, ...lv });
  else send(s.ws, { t: 'build', kind: ghost.kind, cells: line.map((c): [number, number] => [c.cx, c.cy]), ...lv });
  playClick(s);
}

/** The death card's respawn (deathflow.ts), carrying the loadout picked on it. */
function sendFromDeath(msg: ClientMsg) {
  if (state.phase === 'dead') send(state.s.ws, msg);
}

function resize() {
  const { w, h, dpr, safe } = measureLayout();
  view = { w, h, dpr };
  // Sized in CSS px from the visual viewport, so iOS Safari's moving toolbars never leave a strip the canvas does not cover; the
  // shader pass's canvas takes the same box each frame (postfx.ts), so the world it shows lines up with the HUD drawn here.
  fitCanvas(canvas, canvasBox(w, h, dpr));
  setHudInsets(safe);
  applyPhoneHud(hudEl, w, h, safe, touchScreen, hudScaleFor(w, h, touchScreen));
  overlays.setCompact(compactDeath(w, h, touchScreen));
  clearTimeout(viewTimer);
  viewTimer = setTimeout(() => {
    const s = sessionOf(state);
    if (s) send(s.ws, { t: 'view', aspect: viewAspect(view.w, view.h) });
  }, VIEW_RESEND_MS);
}

let lastRaf = 0;
function frame(now: number) {
  requestAnimationFrame(frame);
  const start = performance.now();
  // The gap between frames (not the draw cost) is what the player feels; the graphics preset's governor and the FPS readout use it.
  if (lastRaf) frameTick(now - lastRaf, now, state.phase === 'playing' || state.phase === 'dead');
  lastRaf = now;
  drawFrame(now);
  noteFrameCost(performance.now() - start);
}

/**
 * How the desktop cursor looks (cursorlayer.ts `pointerFor`): the crosshair over the game, an arrow over the UI, a hand over what
 * takes a click, a name on the board included. Looked up often while the mouse moves and a few times a second while it rests,
 * since a popup can open under a cursor that stays still.
 */
let pointer: PointerKind = 'crosshair';
const pointerSeen = { x: NaN, y: NaN, at: -Infinity };
function pointerNow(): PointerKind {
  if (state.phase !== 'playing') return 'crosshair';
  const t = performance.now();
  // At most every 50 ms while the mouse moves (a hit test can force a layout), every 150 ms while it rests.
  if (t - pointerSeen.at > (mouse.x !== pointerSeen.x || mouse.y !== pointerSeen.y ? 50 : 150)) {
    Object.assign(pointerSeen, { x: mouse.x, y: mouse.y, at: t });
    pointer = boardNameAt(mouse.x, mouse.y) ? 'hand' : pointerFor(document.elementFromPoint(mouse.x, mouse.y), canvas);
  }
  return pointer;
}

function drawFrame(realNow: number) {
  // A hit-stop holds what is drawn on one instant for a few ms; the snapshots, inputs and sounds keep the real clock.
  const now = stepClock(stopClock, realNow);
  // The crosshair rides its own layer above every DOM overlay (cursorlayer.ts); a touch screen keeps its reticle on the canvas.
  const top = touchScreen ? undefined : cursorLayer.frame(mouse, crosshairShown({ phase: state.phase, touch: touchScreen, mouseAiming, paused: pause.isOpen(), rangeOpen: rangeUi.isOpen() }), state.phase !== 'menu');
  // Over a piece of the UI the cursor is a plain one, drawn where the crosshair would be (the OS cursor stays hidden under the lock).
  const plain = top && cursorLayer.probe().shown ? pointerNow() : 'crosshair';
  musicUpdate(state, realNow, firing);
  radioUpdate(state, realNow, sendRadio);
  const s = drawnSessionOf(state);
  const latest = s && newestSnap(s.snaps);
  // The slow-motion draws the world a little behind the clock (`rt`); the killcam and highlight reel are delight.ts's.
  const rt = s ? delight.drawnTime(s.snaps, now, realNow) : 0;
  const interpolated = s && sampleAt(s.snaps.snaps, rt);
  if (!s || !interpolated || !latest) {
    // The menu's own diorama covers the screen, so the world's backdrop is not drawn under it.
    if (state.phase === 'menu' && !menuEl.hidden && (attract.frame(realNow, view) || menuScene.running)) return;
    drawBackdrop(ctx, view.w, view.h, view.dpr, now);
    if (processFrame(canvas, { night: 0, storm: false }, now, view.w, view.h, view.dpr)) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); }
    return;
  }
  if (s === sessionOf(state)) shooting.fireIfDue(s, performance.now());
  const released = releaseDue(s.pendingFx, rt);
  s.pendingFx = released.rest;
  for (const { fx } of released.due) {
    if (fx.kind === 'boom') { startBoom(fx.x, fx.y, fx.r, now); const near = 1 - Math.hypot(fx.x - s.lastSelf.x, fx.y - s.lastSelf.y) / 900; if (near > 0) fxPulse(Math.min(1, 0.25 + fx.r / 260) * near); }
    else if (fx.kind === 'slash') startSlash(fx.x, fx.y, fx.angle, now);
    else startEffect(s, fx, now, deathTint(s, fx));
    // A 'building' hit is only ever a zombie's bite (bullets on cover arrive as 'wall'), so it stamps no bullet hole.
    if (fx.kind === 'impact' && fx.surface !== 'building') gunImpact(gunFxOf(s), fx.surface, fx, { walls: s.walls, crates: latest.crates, buildings: latest.buildings, run: latest.run }, now, Math.random, fx);
    if (fx.kind === 'impact' && fx.surface === 'player' && fx.victim !== null && fx.push !== undefined) noteFlinch(flinchOf(s), fx.victim, fx.push, fx.amount ?? 0, now);
    if (fx.kind === 'death') { layCorpse(s, latest, fx, now); noteDeath(s, fx, deathTint(s, fx), realNow); }
    if (fx.kind === 'splat') layZombieCorpse(s, fx, now);
  }
  releaseQueued(rt, realNow);
  releaseTargetFx(rt, now, layoutOf(latest.match.map));
  s.predict = decayCorrection(s.predict, frameStep(now, lastFrameAt));
  const drawn = delight.lag > 0.5 ? null : drawnPosition(s.predict, now, INPUT_MS);
  const players = drawn ? interpolated.players.map((p) => (p.id === s.myId ? { ...p, ...drawn, dashing: !!s.predict.afterNewest?.dash } : p)) : interpolated.players;
  noteAssistTargets(s, players);
  const shots = releaseDue(s.pendingShots, rt);
  s.pendingShots = shots.rest;
  for (const { shot } of shots.due) shooting.fireOthersShot(s, shot, { ...interpolated, players }, now);
  s.roundCover = coverServerRounds(s.roundCover, interpolated.bullets, recentShooters(s.lastShotAt, rt));
  // Rounds stop at the bodies and range targets as drawn this frame, which is the moment of the past the server judges them in.
  const seenNow = { ...interpolated, players };
  const targetsNow = targetBodies(interpolated, rt);
  s.rounds = meetBodies(s.rounds, (owner) => roundScene(seenNow, [], owner, targetsNow).bodies, now);
  const snap = { ...seenNow, bullets: drawnRounds(interpolated.bullets, s.rounds, s.roundCover, now) };
  const me = snap.players.find((p) => p.id === s.myId);
  const eye = me?.alive || me?.downed ? me : snap.players.find((p) => p.id === snap.royale?.watch);
  if (eye) s.lastSelf = { x: eye.x, y: eye.y };
  // The camera leans toward your aim; the aim, the crosshair and the HUD all map through this same camera, so the gun still points at the cursor.
  const lean = stepLean(s, snap, me, eye, realNow);
  const look = delight.look({ x: s.lastSelf.x + lean.x, y: s.lastSelf.y + lean.y }, snap.self.viewRadius || WORLD.viewRadius, realNow);
  aimCamera = makeCamera(look.center, view.w, view.h, look.radius);
  trauma = decay(trauma, frameStep(now, lastFrameAt));
  kick = settleKick(kick, frameStep(now, lastFrameAt));
  lastFrameAt = now;
  const shake = offset(trauma, now);
  // A kill of yours snaps the view in a few percent and lets it back out.
  const punch = zoomAt(realNow);
  const shakenCamera = { ...aimCamera, scale: aimCamera.scale * punch, viewHalfW: aimCamera.viewHalfW / punch, viewHalfH: aimCamera.viewHalfH / punch, x: aimCamera.x + (shake.x + kick.x) / aimCamera.scale, y: aimCamera.y + (shake.y + kick.y) / aimCamera.scale };
  const aim = aimOffset(s);
  const selfAngle = state.phase === 'playing' ? Math.atan2(aim.dy, aim.dx) : null;
  noteFrame(s, snap, aimCamera, selfAngle, now);
  const killerId = state.phase === 'dead' ? state.kill?.killerId ?? null : null;
  const site = s.building && mouseAiming ? buildSiteOf(latest, s.walls, s.lastSelf) : null;
  if (drag && (!site || !linesOf(s.buildKind))) drag = null;
  ghost = site && (drag ? lineGhostAt(site, s.buildKind, drag, screenToWorld(aimCamera, mouse), s.worldSize, s.buildTier) : ghostAt(site, s.buildKind, screenToWorld(aimCamera, mouse), s.worldSize, s.buildTier));
  // With the cursor on the build bar, the cell last hovered stays judged (and shown), so the bar's upgrade chip has a building to act on.
  const held = s.buildGhost;
  if (site && held && !drag && buildChipAt(mouse.x, mouse.y) !== null) ghost = ghostAt(site, s.buildKind, { x: (held.cx + 0.5) * ZOM.cell, y: (held.cy + 0.5) * ZOM.cell }, s.worldSize, s.buildTier);
  s.buildGhost = ghost;
  if (delight.drawKillcam(ctx, s, state.phase === 'dead', view, realNow)) {
    // The killcam's world is lit like the live one: the shader pass must take THIS frame, or its canvas keeps showing the last live frame (the normal camera) while the 2D one has been cleared for it.
    if (processFrame(canvas, { night: nightAmount(), storm: !!snap.royale }, now, view.w, view.h, view.dpr)) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); }
    overlays.update(state, s, latest, now, muted);
    return;
  }
  drawWorld(ctx, { snap, s, cam: shakenCamera, dpr: view.dpr, now, fxNow: realNow, selfAngle, killerId, ghost, cursor: mouseAiming && state.phase === 'playing' ? screenToWorld(aimCamera, mouse) : null });
  // The shader pass takes the finished world; the HUD then draws over a cleared canvas, crisp and unprocessed.
  const glWorld = processFrame(canvas, { night: nightAmount(), storm: !!snap.royale }, now, view.w, view.h, view.dpr);
  if (glWorld) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); }
  const spread = state.phase === 'playing' && mouseAiming && me?.alive && !s.building && plain === 'crosshair' ? spreadOf(s.firing) : null;
  drawScreenPulse(ctx, view.w, view.h, view.dpr, realNow, !glWorld);
  if (me?.alive) drawHeartbeat(ctx, view.w, view.h, view.dpr, now, me.hp / me.maxHp);
  // The crosshair's hit marker is killfx's, so the HUD is handed a feedback without one.
  const fb = s.feedback;
  s.feedback = { ...fb, hitmarker: null };
  drawHud(ctx, view.dpr, shakenCamera, snap, s, now, mouse, spread, fullBoard, top);
  drawLightingDev(ctx, view.dpr);
  s.feedback = fb;
  if (state.phase === 'playing' && plain === 'crosshair') drawHitMarker(top?.ctx ?? ctx, top ? top.local(mouse) : mouse, fb.hitmarker, realNow);
  if (top && plain !== 'crosshair') drawPointer(top.css(), plain, mouse.x, mouse.y);
  if (state.phase === 'playing') drawSticks(ctx, sticks, view.dpr, view.w, view.h, touchScreen);
  medalToasts(state.phase === 'menu' ? [] : s.moments.medals, now);
  xpCard.update(realNow);
  touchButtons(buttonFaces(snap.self, abilityHint(snap.self.pending)[0] === 'Ability' ? ABILITY_SCORE : undefined));
  overlays.update(state, s, latest, now, muted);
  delight.drawReel(s, latest, realNow);
}

function onKeyDown(e: KeyboardEvent) {
  const s = sessionOf(state);
  if (!s) return;
  if (overlays.typing) {
    // A held Enter's repeat would close the chat line it just opened (keyRepeats: Enter acts once per press).
    if (e.repeat) return;
    if (e.key === 'Enter') {
      const text = overlays.closeChat();
      if (text) send(s.ws, { t: 'chat', text });
    } else if (e.key === 'Escape') {
      overlays.closeChat();
    }
    return;
  }
  // Escape closes the innermost thing first and opens the pause menu only when nothing else wants it (pausegate.ts).
  if (e.code === 'Escape') {
    e.preventDefault();
    // A held Escape's repeat would close the pause menu it just opened, as would the Esc that just let the captured mouse go.
    if (e.repeat || plock.escapeSpent(performance.now())) return;
    if (drag) { drag = null; return; }
    const action = escapeAction({ inMatch: true, typing: false, pauseOpen: pause.isOpen(), confirming: pause.confirming(), wheelOpen: wheel.open, rangeOpen: rangeUi.isOpen(), building: s.building });
    if (action === 'cancel-leave') pause.cancelConfirm();
    else if (action === 'close-pause') pause.close();
    else if (action === 'close-wheel') wheel.close();
    else if (action === 'close-range') rangeUi.close();
    else if (action === 'exit-build') s.building = false;
    else if (action === 'open-pause') pause.open();
    return;
  }
  // While the menu is up nothing reaches the soldier: Tab cycles inside it, arrows and Space belong to the focused control.
  if (pause.isOpen()) { pause.handleKey(e); return; }
  // A held toggle or pick acts once, not again on every repeat (input.ts `keyRepeats`).
  if (e.repeat && !keyRepeats(e.code)) return;
  if (e.code === 'Tab') {
    e.preventDefault();
    fullBoard = true;
    return;
  }
  // Space on the death card respawns with the same loadout (once the timer and the click guard are done).
  if (e.code === 'Space' && !e.repeat && state.phase === 'dead' && overlays.quickRespawn(performance.now())) {
    e.preventDefault();
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    held.clear();
    firing = false;
    overlays.openChat();
    return;
  }
  if (e.code === 'KeyT' && state.phase === 'playing') {
    e.preventDefault();
    if (!e.repeat) wheel.openWheel();
    return;
  }
  if (e.code === 'KeyL' && !e.repeat && state.phase === 'playing' && rangeUi.active()) {
    e.preventDefault();
    playClick(s);
    rangeUi.toggle();
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
  // A radio in reach: E changes its station (the held E still opens doors and revives, harmlessly).
  if (e.code === 'KeyE' && !e.repeat && !e.ctrlKey && !e.metaKey && radioPress(state, performance.now(), sendRadio)) return;
  if (e.code === 'KeyM' && e.shiftKey) {
    const off = toggleMusicMuted();
    s.chat.push({ from: '', text: off ? 'Music off (Shift+M to turn on)' : 'Music on', team: null, at: performance.now() });
    return;
  }
  if (e.code === 'KeyC' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
    const on = toggleChatter();
    s.chat.push({ from: '', text: on ? 'Soldier chatter on (C to turn off)' : 'Soldier chatter off (C to turn on)', team: null, at: performance.now() });
    return;
  }
  if (e.code === 'KeyM') {
    const muted = audio.toggleMute();
    setSoundMuted(muted);
    s.chat.push({ from: '', text: muted ? 'Sound off (M to turn on)' : 'Sound on', team: null, at: performance.now() });
    if (!muted) playClick(s);
    return;
  }
  if (e.code === 'KeyU' && !e.repeat && state.phase === 'playing') {
    const snap = newestSnap(s.snaps);
    // In build mode U upgrades what the cursor is over; outside it, the nearest building in reach.
    if (s.building) { if (ghost?.hover && ghost.upgrade === null) sendUpgrade(s, ghost.cx, ghost.cy); }
    else {
      const near = snap && upgradeTarget(snap, s.lastSelf);
      if (near && snap.run && snap.run.scrap >= near.cost) sendUpgrade(s, near.b.cx, near.b.cy);
    }
    return;
  }
  if (e.code === 'KeyQ' && !e.repeat && state.phase === 'playing' && s.building) {
    pickBuildKind(s, 'wall', s.buildKind === 'wall' ? nextTier(s.buildTier) : s.buildTier);
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
    const self = newestSnap(s.snaps)?.self;
    if (action === 'ability' && !e.repeat) abilityTapped = true;
    if (action === 'ability' && !e.repeat && self?.ability && self.abilityReadyIn > 0) {
      noteAbilityDenied(performance.now());
      playClick(s);
    }
    const fresh = !held.has(action);
    held.add(action);
    if (fresh && isMove(action)) inputNow();
  }
}

const isMove = (a: string) => a === 'up' || a === 'down' || a === 'left' || a === 'right';

function onKeyUp(e: KeyboardEvent) {
  if (e.code === 'KeyT') wheel.release();
  if (e.code === 'Tab') fullBoard = false;
  const action = actionForKey(e.code);
  if (action && held.delete(action) && isMove(action) && state.phase === 'playing') inputNow();
}

for (const type of ['pointerdown', 'keydown'] as const) window.addEventListener(type, () => { audio.unlock(); const bus = audio.bus(); if (bus) musicStart(bus.ctx, bus.out); }, { capture: true });
window.addEventListener('keydown', onKeyDown);
window.addEventListener('keyup', onKeyUp);
window.addEventListener('blur', () => { wheel.close(); held.clear(); firing = false; fullBoard = false; sticks = NO_STICKS; });
// Hiding the tab lets go of everything held; coming back also drops the stale snapshots and prediction so the next snapshot starts them afresh.
document.addEventListener('visibilitychange', () => {
  wheel.close(); held.clear(); firing = false; fullBoard = false; sticks = NO_STICKS; abilityTapped = false;
  lastRaf = 0; lastFrameAt = 0; lookCam = { ...lookCam, snap: true };
  if (document.hidden) return;
  const s = sessionOf(state);
  if (s) { Object.assign(s, resyncNet(s)); clearHits(); }
});
canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch') return;
  // Suppresses the emulated mousedown so a thumb on the move stick does not also fire.
  e.preventDefault();
  autoFullscreen.tap();
  // On a phone a tap on the folded scoreboard opens it instead of starting a stick.
  if (phoneBoardTap(e.clientX, e.clientY, performance.now())) return;
  // In build mode a tap on one of the build bar's chips presses it instead of starting a stick.
  const building = state.phase === 'playing' && state.s.building ? state.s : null;
  const chip = building && buildChipAt(e.clientX, e.clientY);
  if (building && chip) { pressBuildChip(building, chip); return; }
  // Only a living soldier takes a stick: a thumb on the world while dead must not wake one up for the respawn.
  if (state.phase !== 'playing') return;
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
const touchButtons = createTouchButtons($('touch-reload'), $('touch-ability'));
const medalToasts = createMedalToasts($('medals'));
const challengeToast = createChallengeToasts($('medals'));
for (const [id, action] of [['touch-ability', 'ability'], ['touch-reload', 'reload']] as const) {
  const button = $(id);
  button.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    autoFullscreen.tap();
    if (state.phase !== 'playing') return;
    held.add(action);
    if (action !== 'ability') return;
    abilityTapped = true;
    const s = sessionOf(state);
    const self = s && newestSnap(s.snaps)?.self;
    if (s && self?.ability && self.abilityReadyIn > 0) {
      noteAbilityDenied(performance.now());
      playClick(s);
    }
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave'] as const) button.addEventListener(type, () => held.delete(action));
}
window.addEventListener('mousemove', (e) => {
  const p = plock.move(e); wheel.move(p.x, p.y); mouse.x = p.x; mouse.y = p.y; mouseAiming = true;
  setBoardHover(state.phase === 'playing' ? boardNameAt(mouse.x, mouse.y)?.id ?? null : null);
});
canvas.addEventListener('mousedown', (e) => {
  // A name on the board is a button: it opens the friend menu instead of firing, and a click anywhere else closes that menu.
  if (state.phase === 'playing' && e.button === 0 && !pause.isOpen()) {
    const pick = boardNameAt(mouse.x, mouse.y);
    if (pick) return friendsUi.openMenu(pick);
    if (friendsUi.isMenuOpen()) return friendsUi.closeMenu();
  }
  if (state.phase === 'playing' && state.s.building) return buildClick(state.s, e);
  if (e.button !== 0) return;
  firing = true;
  if (state.phase !== 'playing' || overlays.typing || pause.isOpen()) return;
  // A click a bolt is not ready for gets a soft "not yet"; a sprint never refuses one (the click ends it and fires, wide).
  if (raiseWatch.click(state.s.firing, performance.now())) emitSfxAt('notReady', state.s.lastSelf.x, state.s.lastSelf.y, true);
  state.s.shots++;
  shooting.fireIfDue(state.s, performance.now());
});
window.addEventListener('mouseup', (e) => { if (e.button === 0) { firing = false; if (drag) finishDrag(); } });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
// In build mode the wheel steps through what can be built instead of zooming or scrolling.
canvas.addEventListener('wheel', (e) => {
  if (state.phase !== 'playing' || !state.s.building || e.deltaY === 0) return;
  e.preventDefault();
  stepBuildItem(state.s, e.deltaY > 0 ? 1 : -1);
}, { passive: false });
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
  if (pendingMode && servers) {
    const want = pendingMode;
    pendingMode = null;
    const sv = servers.find((x) => x.mode === want);
    if (sv) chooseRoom(sv.id, sv.mode);
  }
  if (revealSquad && state.phase === 'menu') revealSquad = false;
}

let squadKey = '';
let rangeKey = '';

function showServers() {
  const picked = chosen ? selectedRoom : null;
  renderServers(serversEl, servers, picked, chooseRoom);
  const key = `${squad}|${picked === squad}|${squadBusy}`;
  if (key !== squadKey) {
    squadKey = key;
    renderSquad(squadEl, { code: squad, selected: squad !== null && picked === squad, link: squad && inviteLink(location.href, squad), busy: squadBusy }, {
      start: () => void startSquad(),
      pick: chooseZombies,
      choose: chooseZombies,
    });
  }
  if (rangeKey !== String(rangeBusy)) {
    rangeKey = String(rangeBusy);
    renderRangeCard($('range-card'), { busy: rangeBusy }, { start: () => void startRange() });
  }
  modePicker.sync(servers, squad);
  refreshMission();
  refreshPlayButton();
}

/** A room card was chosen: the gear-up step follows, with that room to deploy into. */
function chooseRoom(id: string, mode: ModeId) {
  selectedRoom = id;
  mission = mode as SceneId;
  chosen = true;
  modePicker.select(mission);
  showServers();
  flow.go('gear');
}

/** The Zombies card was chosen: gear up, then Deploy joins the squad from an invite link or starts a new one. */
function chooseZombies() {
  mission = 'ZOM';
  chosen = true;
  modePicker.select('ZOM');
  if (squad) selectedRoom = squad;
  showServers();
  flow.go('gear');
}

/** The gear step's header: which fight you are gearing up for. */
function refreshMission() {
  for (const p of loadoutPickers) p.refresh();
  const sv = servers?.find((x) => x.id === selectedRoom);
  flow.setMission({ mode: mission, detail: mission === 'ZOM' ? (squad ? `Squad ${squad}` : 'New squad on Deploy') : sv ? `${sv.players} ${sv.players === 1 ? 'player' : 'players'}` : undefined });
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

/** Opens a private shooting range and deploys into it at once. */
async function startRange() {
  if (rangeBusy || state.phase !== 'menu' || state.status.kind === 'connecting') return;
  rangeBusy = true;
  showServers();
  const opened = await openRangeRoom();
  rangeBusy = false;
  showServers();
  if ('error' in opened) {
    if (state.phase === 'menu') setState({ phase: 'menu', status: { kind: 'error', message: opened.error } });
    return;
  }
  play(opened.room);
}

function toggleMuted(name: string) {
  muted = toggleMute(muted, name);
  saveMuted(muted);
  renderMuted($('muted'), muted, toggleMuted);
}

const overlays = createOverlays(pick, sendFromDeath, toggleMuted, () => loadout);
const delight = createDelight();
const rangeUi = createRangeUi(hudEl, (msg) => { const s = sessionOf(state); if (s) send(s.ws, msg); }, () => { const s = sessionOf(state); if (s) playClick(s); });
const celebrate = createCelebration(document.body);
const wheel = createEmoteWheel(hudEl, (id) => {
  const s = sessionOf(state);
  if (!s) return;
  send(s.ws, { t: 'emote', id });
  playClick(s);
});
/** The pause and settings overlay (Esc, the cog, or Start on a pad): the match keeps running, your soldier takes no input. */
const friendsUi = createFriendsUi({
  send: (msg) => { const s = sessionOf(state); if (s) send(s.ws, msg); },
  onChange: (ids) => setHudFriends(ids),
});
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') friendsUi.closeMenu(); }, { capture: true });

const pause = createPauseMenu(hudEl, {
  audio,
  info: () => {
    const s = sessionOf(state);
    if (!s) return null;
    const mode = newestSnap(s.snaps)?.match.mode;
    const range = mode === 'RNG';
    const code = s.rejoin.room;
    return { range, dead: state.phase === 'dead', invite: code === squad && squad ? inviteLink(location.href, squad) : null, modeName: mode && mode in MODE_INFO ? MODE_INFO[mode as keyof typeof MODE_INFO].name : 'Match' };
  },
  leave,
  blip: () => { const s = sessionOf(state); if (s) playClick(s); },
  onToggle: (open) => {
    // Let go of everything held so the soldier stands still, and close what shares the screen.
    held.clear(); firing = false; fullBoard = false; sticks = NO_STICKS; abilityTapped = false;
    wheel.close();
    if (open) rangeUi.close();
    else queueMicrotask(plock.resume);
  },
});
/** Desktop mouse capture (pointerlock.ts): held while playing with nothing open that needs a real cursor; Esc lets it go and pauses. */
const plock = installPointerLock(canvas, {
  inMatch: () => state.phase === 'playing' || state.phase === 'dead',
  want: () => lockWanted({ phase: state.phase, touch: touchScreen, typing: overlays.typing, paused: pause.isOpen(), rangeOpen: rangeUi.isOpen() }),
  sensitivity: mouseSensitivity,
  origin: () => mouse,
  onUserExit: () => { if (state.phase === 'playing' && !pause.isOpen()) pause.open(); },
}, () => view);
const cursorLayer = installCursorLayer(document);
/** A phone's emote button: taps the wheel open, and a plate sends. */
const emoteButton = document.createElement('button');
emoteButton.type = 'button';
emoteButton.className = 'touch-emote';
emoteButton.setAttribute('aria-label', EMOTES.wave.label);
emoteButton.textContent = 'GG';
emoteButton.style.font = '800 16px var(--display)';
emoteButton.addEventListener('pointerdown', (e) => { e.preventDefault(); wheel.toggle(); });
hudEl.append(emoteButton);
/** A phone's way to tap a radio's prompt. */
mountRadioButton(hudEl, () => radioPress(state, performance.now(), sendRadio));
/** On the account's join anniversary your soldier wears a party hat (and `?party` shows it for a look). */
async function checkAnniversary(account: string | null) {
  if (params.has('party')) { setParty(true); return; }
  if (!account) return;
  try {
    const res = await fetch(`/api/profile/${encodeURIComponent(account)}`);
    const p = res.ok ? ((await res.json()) as { firstSeen?: number }) : null;
    if (p && isAnniversary(p.firstSeen, Date.now())) setParty(true);
  } catch { /* the hat is a nicety */ }
}
if (params.has('dev')) {
  /** `skirmishUi.progress({...})` feeds a fake `progress` message through the real handler, for looking at the XP card. */
  Object.assign(window, { skirmishUi: { progress: (m: Parameters<typeof onProgress>[0]) => onProgress(m), wardrobe: () => wardrobe.state(), showTab: (t: string) => showTab(t) } });
  Object.assign(((window as unknown as { skirmishChatter?: object }).skirmishChatter ??= {}), {
    chatter,
    /** Forces a line from soldier `pid` (default: you): `say(undefined, { personality: 'poet', tag: 'justKilled' })`. */
    say: (pid?: number, opts?: Parameters<typeof chatter.say>[2]) => { const s = sessionOf(state); return s ? chatter.say(pid ?? s.myId, performance.now(), { own: (pid ?? s.myId) === s.myId, ...opts }) : null; },
  });
  void import('./celebratedemo.ts').then((m) => Object.assign(((window as unknown as { skirmishDev?: object }).skirmishDev ??= {}), { celebrate: (kind: string) => celebrate.demo(m.demoCelebration(kind)), topup: (n = 3) => { const s = sessionOf(state); if (s) onTopup(s, n, performance.now()); } }));
}
const shooting = createShooting({ hands, playCues, recoil: (gun, angle) => { if (!reducedMotion() && shakeScale() > 0) kick = addKick(kick, gun, angle, shakeScale()); } });
installDevProbe({ ctx, drawFrame, session: () => drawnSessionOf(state), camera: () => aimCamera, ghost: () => ghost });
if (params.has('dev')) Object.assign(((window as unknown as { skirmishDev?: object }).skirmishDev ??= {}), { friends: { board: () => drawnBoardNames(), myId: () => sessionOf(state)?.myId ?? null } });
if (params.has('dev')) Object.assign(((window as unknown as { skirmishDev?: object }).skirmishDev ??= {}), { phone: { layout: () => drawnPhoneLayout(), fullscreenArmed: () => autoFullscreen.armed() } });
if (params.has('dev')) Object.assign(((window as unknown as { skirmishDev?: object }).skirmishDev ??= {}), { pause: { open: () => pause.open(), close: () => pause.close(), isOpen: () => pause.isOpen(), probe: () => pause.probe(), quality: () => qualityProbe(), held: () => [...held], firing: () => firing }, music: musicProbe });
renderMuted($('muted'), muted, toggleMuted);
const account = mountAccount($('account'), (a) => { if (a && !nameInput.value) nameInput.value = a.name; void wardrobe.refresh(nameInput.value); syncAcct(); });
/** The wardrobe: level, XP, what you own and wear. A change goes down the socket too, so the room sees it at once. */
const wardrobe = createWardrobe({
  account: () => account.current(),
  sendEquip: (slot, id) => { const s = sessionOf(state); if (s) send(s.ws, { t: 'equip', slot, id }); },
});
const skinNow = () => cosLook({ g: wardrobe.state().equipped.gunSkin }).skin;
// The menu's art: the backdrop yard and the gear-up stage, run by the flow (menuflow.ts) only while seen.
const menuScene = createMenuScene($<HTMLCanvasElement>('menu-scene'), reducedMotion);
const gearStage = createGearStage($<HTMLCanvasElement>('gear-view'), { loadout: () => loadout, look: () => lookOfEquipped(wardrobe.state().equipped), calm: reducedMotion });
// A live bot match behind the menu (attract.ts), drawn on the game canvas; the yard stands in until it is ready, and whenever it is off.
const attract = createAttract({ canvas, ctx, menu: menuEl, fallback: menuScene, calm: reducedMotion, restore: resize });
const flow = createMenuFlow({ menu: menuEl, stage: gearStage, scene: attract });
/** The enlist plate on the first screen (guests only), and the death card's one quiet line when a guest has something at stake. */
const enlist = mountEnlist($('enlist'), {
  auth: (kind, name, pass, email) => account.auth(kind, name, pass, email),
  suggestName: () => (nameInput.value.trim() ? cleanName(nameInput.value) : ''),
  afterSignIn: () => flow.go('modes'),
  hasGuestProgress: () => loadGuestClaims().length > 0,
});
const deathNudge = $('death-enlist'), deathNudgeText = $('death-enlist-text');
const syncNudge = () => { const line = guestNudge(!!account.current(), enlist.stakes()); deathNudge.hidden = !line; deathNudgeText.textContent = line ?? ''; };
const noteStakes = (more: Partial<Stakes>) => { if (!account.current()) { enlist.note(more); syncNudge(); } };
$('death-enlist-go').addEventListener('click', () => { leave(); showTab('tab-deploy'); flow.go('modes', { focus: false }); enlist.open('register'); });
/** The account chip in the menu's top bar follows who is signed in and their level. */
const syncAcct = () => {
  flow.setAccount(account.current()?.name ?? null, wardrobe.state().level.level); enlist.sync(!!account.current()); syncNudge();
  const me = account.current();
  renderTopBar($('menu-auth'), me ? { name: me.name, level: wardrobe.state().level } : null, {
    register: () => { flow.closeSheet(); showTab('tab-deploy'); flow.go('modes', { focus: false }); enlist.open('register'); },
    logout: () => account.expire(''),
  });
};
const pickers = [
  mountLoadoutPicker($('loadout-menu'), () => loadout, setLoadout, skinNow, { gear: true, peek: (g) => gearStage.peek(g), colorRoot: $('gear-colors'), zombies: () => mission === 'ZOM' }),
  mountLoadoutPicker($('loadout-death'), () => loadout, setLoadout, skinNow, { zombies: () => mission === 'ZOM' }),
];
loadoutPickers = pickers;
nameInput.value = loadName() || account.current()?.name || '';
/** The menu's link to your own service record follows the name you will play as. */
const myProfile = $<HTMLAnchorElement>('my-profile');
const linkMyProfile = () => {
  const name = cleanName(nameInput.value);
  myProfile.hidden = !nameInput.value.trim();
  myProfile.href = `profile.html?name=${encodeURIComponent(name)}`;
};
nameInput.addEventListener('input', linkMyProfile);
const gearTag = $('gear-tag');
const tagName = () => { gearTag.textContent = cleanName(nameInput.value) || 'Unnamed'; };
nameInput.addEventListener('input', tagName);
tagName();
linkMyProfile();
renderControls($('controls'));
// The bottom bar (What's new, Discord, feedback) and the feedback links on the death card; each mail says where the player was.
setFeedbackGame(() => {
  const snap = (() => { const s = sessionOf(state); return s ? newestSnap(s.snaps) : null; })();
  return snap ? { mode: snap.match.mode, map: snap.match.map } : { mode: modePicker.mode };
});
for (const id of ['menu-feedback', 'death-feedback', 'death-feedback-more']) wireFeedback($<HTMLAnchorElement>(id), id === 'menu-feedback' ? 'menu' : 'death');
applyDiscord($<HTMLAnchorElement>('menu-discord'), DISCORD_URL);
mountChangelog($('menu-changelog'));
// ?account (the Account settings link on your own service record) opens the account sheet.
if (params.has('account') && account.current()) queueMicrotask(() => $('acct-btn').click());

// ---- Progression: the armory, level card and challenges in the menu, and the XP card after a life or a round.
const levelCard = $('level-card');
const challengePanel = createChallengePanel($('challenges'));
const armory = createArmory($('armory'), { wardrobe, loadout: () => loadout });
const chalBadge = $('chal-badge');
const MENU_TABS = [['tab-deploy', 'deploy-panel'], ['tab-armory', 'armory'], ['tab-challenges', 'challenges']] as const;
function showTab(tab: string) {
  for (const [btn, panel] of MENU_TABS) { $(btn).setAttribute('aria-selected', String(btn === tab)); $(panel).hidden = btn !== tab; }
  if (tab === 'tab-armory') armory.show(); else armory.hide();
  if (tab === 'tab-challenges') challengePanel.render(wardrobe.state().challenges);
  flow.setTab(tab);
}
for (const [btn] of MENU_TABS) $(btn).addEventListener('click', () => showTab(btn));
wardrobe.subscribe(() => {
  const st = wardrobe.state();
  renderLevelCard(levelCard, st);
  const open = openChallenges(st.challenges);
  chalBadge.hidden = open === 0;
  chalBadge.textContent = String(open);
  if (!$('challenges').hidden) challengePanel.render(st.challenges);
  for (const p of pickers) p.refresh();
  syncAcct();
  gearStage.paint();
});
setInterval(() => challengePanel.tick(), 30_000);
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
const refreshWardrobe = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => void wardrobe.refresh(nameInput.value), 350); };
nameInput.addEventListener('input', refreshWardrobe);
void wardrobe.refresh(nameInput.value);
renderLevelCard(levelCard, wardrobe.state());
syncAcct();
const xpCard = createXpCard($('xp-card'), {
  blocked: () => ['celebrating', 'dl-slowmo', 'dl-hold', 'dl-play', 'dl-settle'].some((c) => document.body.classList.contains(c)),
  equip: (slot: Slot, id: string) => wardrobe.equip(slot, id),
  openArmory: (slot: Slot) => { const s = sessionOf(state); if (s) { chatterOpenArmory = slot; leave(); } else { showTab('tab-armory'); armory.open(slot); } },
});
let chatterOpenArmory: Slot | null = null;
void COSMETIC_BY_ID;
/**
 * On a phone, Play also asks for fullscreen and a landscape lock, inside the tap that allows them. Browsers that refuse (an
 * iPhone has no page fullscreen) keep the page as it is, and the rotate hint asks the player to turn the phone instead.
 */
const lockLandscape = () => (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> } | undefined)?.lock?.('landscape').catch(() => {});
function fullLandscape() {
  if (!matchMedia('(pointer: coarse)').matches) return;
  if (!document.fullscreenElement) void requestFullscreen(document, document.documentElement, lockLandscape);
  else void lockLandscape();
}

const a2hs = $('a2hs');
a2hs.hidden = !shouldShowHomeScreenHint();
$('a2hs-close').addEventListener('click', () => { dismissHomeScreenHint(); a2hs.hidden = true; });

$('play-form').addEventListener('submit', (e) => {
  e.preventDefault();
  fullLandscape();
  if (mission === 'ZOM' && squad === null) { void startSquad(); return; }
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
  mission = 'ZOM';
  chosen = true;
}
// A deep link names its fight: ?mode=ffa|tdm|dom|br goes to gear up once the rooms are listed, ?mode=zom goes at once, ?mode=range stops on the range card.
const MODE_PARAM: Record<string, SceneId> = { ffa: 'FFA', tdm: 'TDM', dom: 'DOM', br: 'BR', zom: 'ZOM', zombies: 'ZOM', range: 'RNG' };
let pendingMode: SceneId | null = null;
{
  const want = MODE_PARAM[(params.get('mode') ?? '').toLowerCase()];
  if (want === 'ZOM') { mission = 'ZOM'; chosen = true; }
  else if (want === 'RNG') queueMicrotask(() => {
    modePicker.select('RNG'); $('range-card').scrollIntoView({ block: 'center' }); $('range-card').querySelector<HTMLElement>('.mc-hit')?.focus({ preventScroll: true }); });
  else if (want) pendingMode = want;
}
resize();
// The graphics preset needs the shader pass started (it names the GPU) and the canvas sized; the motion option mirrors onto the page for CSS.
initQuality({ resize, toast: showToast });
const syncMotion = () => { document.documentElement.dataset.motion = reducedMotion() ? 'reduced' : 'full'; };
syncMotion();
onSettings(syncMotion);
setState(state);
if (chosen) { modePicker.select(mission); flow.reachable(); flow.go('gear', { focus: false }); }
requestAnimationFrame(frame);
trackRootScale();
