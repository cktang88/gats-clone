/**
 * The radios: one fixed toy radio in the range and the Zombies outpost (its tuning is the room's, so a squad hears one station), and two to four
 * hidden ones on every versus map (re-rolled each round from the round's name; tuning one changes only your own music). Walk up, press E (or
 * tap the prompt), and the dial clicks through the stations. Nothing here touches the simulation: a radio has no collision and bots ignore it.
 */
import type { ClientMsg } from '../shared/protocol.ts';
import { newestSnap } from './interp.ts';
import { FIXED_RADIO, cycleStation, hiddenRadios, isStationId, RADIO_INTERVAL_MS, RADIO_MODES, RADIO_REACH, roundKeyOf, STATION_IDS, type SongId, type StationId, type TrackId } from '../shared/radio.ts';
import { beatPulse } from './music.ts';
import { getMapTrack, getPersonalStation, getRoomStation, getStation, musicPrefetch, playTuneIn, setPersonalStation, setRoomStation } from './music.ts';
import { songLabel, synthFor } from './musicstream.ts';
import { drawRadio, drawRadioPrompt, drawRadioToast, drawTuneRings } from './radioart.ts';
import { TRACKS } from './musictracks.ts';
import { isPhoneLandscape } from './phonelayout.ts';
import type { ClientState, Session } from './state.ts';

const SAVED_KEY = 'skirmish.radio.station';
const TOAST_MS = 2400;
const SPUTTER_MS = 1600;
const HIT_R = 22;
const NEEDLE_EASE = 0.12;
/** The radios are drawn big enough to read from the game's wide camera: the fixed one about a soldier's width and a half, the hidden ones a little less. */
const scaleOf = (r: Placed) => (r.hidden ? 1.1 : 1.5);

type Placed = { x: number; y: number; hidden: boolean; sputterUntil: number; tunedAt: number; found: boolean };
type Toast = { text: string; tone: 'station' | 'found'; at: number; x: number; y: number; row: number };

let placed: Placed[] = [];
let placedKey = '';
let near: Placed | null = null;
let toasts: Toast[] = [];
let needle = 0.5;
let sentSaved = false;
let lastRound: number | null = null;
let lastScope = '';
let touchBtn: HTMLButtonElement | null = null;
let finds = 0;
let foundBefore = false;
let pressedAt = -Infinity;
const touchScreen = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

const store = {
  get: () => { try { return localStorage.getItem(SAVED_KEY); } catch { return null; } },
  set: (v: string) => { try { localStorage.setItem(SAVED_KEY, v); } catch { /* the tuning lasts this tab only */ } },
};

/** How many hidden radios this session has found, counted for a possible future challenge (no XP or medal rides on it yet). */
export const radioFinds = () => finds;

/** A song's name on the dial: the recording's title and artist, or the synthesized track's name (the original march). */
export const songName = (song: SongId): string => songLabel(song) ?? TRACKS[synthFor(song)].label;
/** The station's display name. */
export const stationLabel = (id: StationId | null, mapTrack: TrackId = getMapTrack()): string => (id === null ? `${songName(mapTrack)} (map default)` : id === 'off' ? 'Off' : songName(id));

/** Warms the file of the station one press further round the dial, so the next retune is instant. */
function prefetchNext(from: StationId | null, withDefault: boolean) {
  const next = cycleStation(from, withDefault);
  if (next && next !== 'off') musicPrefetch(next);
}

/** Where on the dial a station sits, 0..1, for the needle. */
const dialOf = (id: StationId | null): number => {
  const at = id === null ? STATION_IDS.indexOf(getMapTrack()) : STATION_IDS.indexOf(id);
  return STATION_IDS.length > 1 ? Math.max(0, at) / (STATION_IDS.length - 1) : 0.5;
};

function say(text: string, at: Placed | null, now: number, tone: Toast['tone'] = 'station', row = 0) {
  toasts = [...toasts.filter((t) => t.row !== row), { text, tone, at: now, x: at?.x ?? 0, y: at?.y ?? 0, row }];
}

/** A tune-in on a radio: the sound, the rings and the toast. */
function tuned(r: Placed | null, id: StationId | null, now: number) {
  playTuneIn();
  prefetchNext(id, !!r?.hidden);
  if (r) r.tunedAt = now;
  say(`Radio: ${stationLabel(id)}`, r, now);
}

/** The server's word on the room's radio (Zombies, range): everyone in the room hears the same station. */
export function onRoomRadio(station: StationId | null, now: number) {
  const changed = getRoomStation() !== station;
  setRoomStation(station);
  const fixed = placed.find((p) => !p.hidden) ?? null;
  if (changed) tuned(fixed, station, now);
  if (station && placedKey.startsWith('RNG')) store.set(station);
}

/** Works out which radios stand in this room and round, and which one the player is near. Call once a frame. */
export function radioUpdate(state: ClientState, now: number, send: (msg: ClientMsg) => void) {
  if (state.phase === 'menu') { placed = []; placedKey = ''; near = null; sentSaved = false; lastRound = null; syncTouch(false, ''); return; }
  const s: Session = state.s;
  const snap = newestSnap(s.snaps);
  if (!snap) return;
  const mapId = s.mapId;
  const mode = snap.match.mode;
  if (!mapId) return;
  const round = roundKeyOf(snap);
  if (round !== null) lastRound = round;
  // Your own tuning (a hidden radio's) lasts until the round ends or the map changes.
  const scope = `${mapId}|${round ?? lastRound}`;
  if (scope !== lastScope) { lastScope = scope; if (getPersonalStation() !== null) setPersonalStation(null); }
  const key = RADIO_MODES.includes(mode) ? `${mode}|${mapId}` : `${mode}|${mapId}|${round ?? lastRound ?? 0}`;
  if (key !== placedKey) {
    placedKey = key;
    const spots = RADIO_MODES.includes(mode) ? [FIXED_RADIO[mapId]].flatMap((p) => (p ? [{ ...p, hidden: false }] : [])) : hiddenRadios(mapId, round ?? lastRound ?? 0).map((p) => ({ ...p, hidden: true }));
    placed = spots.map((p) => ({ ...p, sputterUntil: 0, tunedAt: -Infinity, found: false }));
  }
  // Back in the range with a saved tuning: put the room's radio there (the server tells everyone, which is just you).
  if (mode === 'RNG' && !sentSaved) {
    sentSaved = true;
    const saved = store.get();
    if (isStationId(saved) && saved !== getRoomStation()) send({ t: 'radio', station: saved });
  }
  const me = snap.players.find((p) => p.id === snap.self.id);
  const wasNear = near;
  near = null;
  if (me && me.alive) {
    let best = RADIO_REACH * RADIO_REACH;
    for (const r of placed) {
      const d = (r.x - me.x) ** 2 + (r.y - me.y) ** 2;
      if (d < best) { best = d; near = r; }
    }
  }
  // Walking up to a radio warms the station its first press would tune to.
  if (near && near !== wasNear) prefetchNext(near.hidden ? getPersonalStation() : getStation(), near.hidden);
  // A round through a radio makes it sputter.
  for (const r of placed) {
    for (const b of snap.bullets) if ((b.x - r.x) ** 2 + (b.y - r.y) ** 2 < HIT_R * HIT_R) { if (r.sputterUntil < now) playTuneIn(); r.sputterUntil = now + SPUTTER_MS; }
    for (const b of s.rounds) if ((b.x - r.x) ** 2 + (b.y - r.y) ** 2 < HIT_R * HIT_R) { if (r.sputterUntil < now) playTuneIn(); r.sputterUntil = now + SPUTTER_MS; }
  }
  const target = dialOf(getStation());
  needle += (target - needle) * NEEDLE_EASE;
  syncTouch(!!near && state.phase === 'playing', near ? promptLabel() : '');
}

const promptLabel = () => `Radio · ${stationLabel(getStation())}`;

/**
 * E (or a tap on the prompt) while near a radio. Returns whether it was used. A fixed radio asks the server (the whole squad hears it);
 * a hidden one retunes only you, and its first find of the session says so.
 */
export function radioPress(state: ClientState, now: number, send: (msg: ClientMsg) => void): boolean {
  if (state.phase !== 'playing' || !near) return false;
  const r = near;
  if (!r.hidden) {
    // Like a real radio, the dial turns as you press: play the station now and tell the server, whose echo then changes nothing.
    // Presses faster than the server takes them are ignored here too, so what you hear never drifts from what the squad hears.
    if (now - pressedAt < RADIO_INTERVAL_MS + 50) return true;
    pressedAt = now;
    const next = cycleStation(getStation(), false);
    if (next) { send({ t: 'radio', station: next }); onRoomRadio(next, now); }
    return true;
  }
  const next = cycleStation(getPersonalStation(), true);
  setPersonalStation(next);
  tuned(r, next, now);
  if (!r.found) {
    r.found = true;
    finds++;
    // The first radio found this session says so, then names its station.
    if (!foundBefore) { foundBefore = true; say('Found a radio!', r, now, 'found', 1); }
  }
  return true;
}

/** Draws the radios in view, with the near one's prompt and any toast. World coordinates, after the props. */
export function drawRadios(ctx: CanvasRenderingContext2D, now: number, view: { x0: number; y0: number; x1: number; y1: number }, dark: number, reduced: boolean) {
  const pulse = beatPulse(3);
  const off = getStation() === 'off';
  for (const r of placed) {
    if (r.x < view.x0 - 80 || r.x > view.x1 + 80 || r.y < view.y0 - 120 || r.y > view.y1 + 80) continue;
    const sputter = r.sputterUntil > now ? (r.sputterUntil - now) / SPUTTER_MS : 0;
    drawRadio(ctx, { x: r.x, y: r.y, scale: scaleOf(r), now, pulse, dark, needle, sputter, off, quiet: r.hidden, near: r === near, reduced });
    const since = (now - r.tunedAt) / 900;
    if (since >= 0 && since < 1) drawTuneRings(ctx, r.x, r.y - 6, since, scaleOf(r));
  }
}

/** The prompt and toast, drawn over everything else in the world (after the night shade), so they stay readable. */
export function drawRadioOverlay(ctx: CanvasRenderingContext2D, now: number, reduced: boolean) {
  if (near && promptWanted(now)) drawRadioPrompt(ctx, near.x, near.y - 62 * scaleOf(near) - 14, now, promptLabel(), touchScreen ? 'TAP' : 'E', reduced, 1.45);
  toasts = toasts.filter((t) => now - t.at < TOAST_MS);
  for (const t of toasts) drawRadioToast(ctx, t.x, t.y - 62 * 1.5 - 52 - t.row * 34, t.text, Math.max(0, (now - t.at) / TOAST_MS), t.tone, 1.45);
}


/**
 * A phone has its RADIO button beside the aim stick, so the prompt over the radio is a hint it shows once: after a few seconds
 * of it on this device it stays away (phonefocus.ts's rule for hints). Elsewhere the prompt shows whenever you are near.
 */
const HINT_KEY = 'skirmish.radioHint';
const HINT_MS = 4000;
const hint = { seen: (() => { try { return localStorage.getItem(HINT_KEY) === 'seen'; } catch { return false; } })(), shownMs: 0, lastAt: 0 };
function promptWanted(now: number): boolean {
  if (typeof innerWidth !== 'number' || !isPhoneLandscape(innerWidth, innerHeight, touchScreen)) return true;
  if (hint.seen) return false;
  hint.shownMs += Math.min(100, Math.max(0, now - hint.lastAt));
  hint.lastAt = now;
  if (hint.shownMs >= HINT_MS) { hint.seen = true; try { localStorage.setItem(HINT_KEY, 'seen'); } catch { /* a private window forgets */ } }
  return true;
}

/** The phone's tap target for the prompt: a button that shows only while near a radio. */
export function mountRadioButton(parent: HTMLElement, press: () => void) {
  if (!touchScreen || touchBtn) return;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'touch-radio';
  b.setAttribute('aria-label', 'Change radio station');
  b.style.cssText = 'display:none;position:fixed;right:176px;bottom:204px;min-width:64px;height:42px;padding:0 12px;z-index:12;border-radius:22px;border:2px solid rgba(255,198,90,.8);background:rgba(19,21,25,.72);color:#ffe6a6;font:800 14px var(--display);touch-action:none;box-shadow:0 0 0 3px rgba(255,170,70,.25)';
  b.addEventListener('pointerdown', (e) => { e.preventDefault(); press(); });
  parent.append(b);
  touchBtn = b;
}
function syncTouch(show: boolean, label: string) {
  if (!touchBtn) return;
  touchBtn.style.display = show ? 'block' : 'none';
  if (show && touchBtn.getAttribute('aria-label') !== label) touchBtn.setAttribute('aria-label', label);
  if (touchBtn.textContent !== 'RADIO') touchBtn.textContent = 'RADIO';
}

/** What stands where, and which one is near; for tests and the dev probe. */
export const radioDebug = () => ({ placed: placed.map((r) => ({ x: r.x, y: r.y, hidden: r.hidden, sputtering: r.sputterUntil })), near: near ? { x: near.x, y: near.y } : null });

export const __test = { reset() { placed = []; placedKey = ''; near = null; toasts = []; lastRound = null; finds = 0; foundBefore = false; pressedAt = -Infinity; } };
