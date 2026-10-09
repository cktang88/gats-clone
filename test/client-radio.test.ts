/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FIXED_RADIO, hiddenRadios, RADIO_REACH, STATION_IDS, type StationId } from '../src/shared/radio.ts';
import type { ClientMsg, Snapshot } from '../src/shared/protocol.ts';
import { getPersonalStation, getRoomStation, getStation, setPersonalStation, setRoomStation } from '../src/client/music.ts';
import { __test, onRoomRadio, radioDebug, radioFinds, radioPress, radioUpdate, stationLabel } from '../src/client/radio.ts';
import { drawRadio, drawRadioPrompt } from '../src/client/radioart.ts';

function snapAt(o: { mode: 'FFA' | 'TDM' | 'DOM' | 'ZOM' | 'RNG' | 'BR'; x: number; y: number; round?: number | null; bullets?: { x: number; y: number }[] }): Snapshot {
  const me = { id: 1, x: o.x, y: o.y, alive: true, team: null };
  return {
    t: 'snap', tick: 1, self: { id: 1 }, players: [me], bullets: (o.bullets ?? []).map((b, i) => ({ id: i, ...b, vx: 0, vy: 0, owner: 2, gun: null })),
    match: { mode: o.mode, map: 'm', roundEndsAt: o.round === undefined ? 1000 : o.round },
  } as unknown as Snapshot;
}
const stateOf = (snap: Snapshot, mapId: string) => ({ phase: 'playing', s: { snaps: { snaps: [snap], serverClockOffset: null }, mapId, rounds: [] } }) as never;
const reset = () => { __test.reset(); setRoomStation(null); setPersonalStation(null); };

test('a hidden radio appears only for the round it belongs to, and walking up to it shows the prompt', () => {
  reset();
  const sent: ClientMsg[] = [];
  const spots = hiddenRadios('museum', 4242);
  radioUpdate(stateOf(snapAt({ mode: 'FFA', x: 10, y: 10, round: 4242 }), 'museum'), 0, (m) => sent.push(m));
  assert.deepEqual(radioDebug().placed.map(({ x, y }) => ({ x, y })), spots);
  assert.ok(radioDebug().placed.every((r) => r.hidden));
  assert.equal(radioDebug().near, null);
  radioUpdate(stateOf(snapAt({ mode: 'FFA', x: spots[0]!.x + RADIO_REACH - 5, y: spots[0]!.y, round: 4242 }), 'museum'), 16, (m) => sent.push(m));
  assert.deepEqual(radioDebug().near, spots[0]);
  radioUpdate(stateOf(snapAt({ mode: 'FFA', x: spots[0]!.x + RADIO_REACH + 30, y: spots[0]!.y, round: 4242 }), 'museum'), 32, (m) => sent.push(m));
  assert.equal(radioDebug().near, null);
  assert.deepEqual(sent, [], 'a hidden radio never talks to the server');
  // A new round moves them.
  radioUpdate(stateOf(snapAt({ mode: 'FFA', x: 10, y: 10, round: 9999 }), 'museum'), 48, () => {});
  assert.deepEqual(radioDebug().placed.map(({ x, y }) => ({ x, y })), hiddenRadios('museum', 9999));
  assert.notDeepEqual(radioDebug().placed.map(({ x, y }) => ({ x, y })), spots);
});

test('E at a hidden radio cycles your own music through the map default and Off, and ends with the round', () => {
  reset();
  const spot = hiddenRadios('plaza', 77)[0]!;
  const state = stateOf(snapAt({ mode: 'TDM', x: spot.x + 20, y: spot.y, round: 77 }), 'plaza');
  const sent: ClientMsg[] = [];
  radioUpdate(state, 0, (m) => sent.push(m));
  assert.equal(radioPress(state, 100, (m) => sent.push(m)), true);
  assert.equal(getPersonalStation(), 'march', 'the first press steps off the map default');
  assert.equal(getStation(), 'march');
  assert.equal(radioFinds(), 1);
  assert.equal(radioPress(state, 700, () => {}), true);
  assert.equal(getPersonalStation(), 'oldtown');
  assert.equal(radioFinds(), 1, 'one radio counts once');
  // Round the dial: the stations, Off, the map default, and on round again (seventeen stops), a step per press.
  const dial: (StationId | null)[] = [null, ...STATION_IDS];
  for (let i = 0; i < 20; i++) {
    radioPress(state, 1000 + i * 400, () => {});
    assert.equal(getPersonalStation(), dial[(dial.indexOf('oldtown') + i + 1) % dial.length], `press ${i + 3}`);
  }
  assert.deepEqual(sent, [], 'no message for a personal radio');
  // Nowhere near a radio: E is not ours.
  radioUpdate(stateOf(snapAt({ mode: 'TDM', x: 5, y: 5, round: 77 }), 'plaza'), 20_000, () => {});
  assert.equal(radioPress(state, 20_100, () => {}), false);
  // The round ends: your tuning goes with it.
  setPersonalStation('park');
  radioUpdate(stateOf(snapAt({ mode: 'TDM', x: 5, y: 5, round: 78 }), 'plaza'), 21_000, () => {});
  assert.equal(getPersonalStation(), null);
});

test('the fixed radio turns at once and tells the server, and the squad\'s station is the one the server says', () => {
  reset();
  const at = FIXED_RADIO.outpost!;
  const state = stateOf(snapAt({ mode: 'ZOM', x: at.x + 30, y: at.y, round: null }), 'outpost');
  const sent: ClientMsg[] = [];
  radioUpdate(state, 0, (m) => sent.push(m));
  assert.deepEqual(radioDebug().placed.map(({ x, y, hidden }) => ({ x, y, hidden })), [{ ...at, hidden: false }]);
  assert.equal(radioPress(state, 50, (m) => sent.push(m)), true);
  assert.deepEqual(sent, [{ t: 'radio', station: 'march' }], 'untuned, the dial starts at the first station');
  assert.equal(getRoomStation(), 'march', 'like a real radio, the station changes as you press, before the server answers');
  assert.equal(radioPress(state, 200, (m) => sent.push(m)), true);
  assert.equal(sent.length, 1, 'a press faster than the server takes them is ignored, so you never drift from the squad');
  onRoomRadio('march', 100);
  assert.equal(getRoomStation(), 'march');
  onRoomRadio('wasteland', 600);
  assert.equal(getStation(), 'wasteland');
  assert.equal(stationLabel('wasteland'), 'Neo Western', 'a recorded station is named for its recording');
  assert.equal(stationLabel('march'), 'Toy March (original)');
  assert.equal(stationLabel('dekalb'), 'Lewis and Dekalb', 'and the radio-only stations too');
  assert.equal(stationLabel('off'), 'Off');
  sent.length = 0;
  radioPress(state, 700, (m) => sent.push(m));
  assert.deepEqual(sent, [{ t: 'radio', station: 'range' }], 'the dial goes on to the next station after wasteland');
});

test('a dead soldier lying beside a radio gets no prompt and cannot tune it', () => {
  reset();
  const spot = hiddenRadios('plaza', 77)[0]!;
  const snap = snapAt({ mode: 'TDM', x: spot.x + 20, y: spot.y, round: 77 });
  (snap.players[0] as { alive: boolean }).alive = false;
  const state = stateOf(snap, 'plaza');
  radioUpdate(state, 0, () => {});
  assert.equal(radioDebug().near, null);
  assert.equal(radioPress(state, 100, () => {}), false);
  assert.equal(getPersonalStation(), null);
});

test('a round through a radio makes it sputter, and the range radio stands where the range says', () => {
  reset();
  const at = FIXED_RADIO.range!;
  const state = stateOf(snapAt({ mode: 'RNG', x: at.x + 200, y: at.y, round: null, bullets: [{ x: at.x + 3, y: at.y - 2 }] }), 'range');
  radioUpdate(state, 5000, () => {});
  assert.ok(radioDebug().placed[0]!.sputtering > 5000);
  radioUpdate(stateOf(snapAt({ mode: 'RNG', x: at.x + 200, y: at.y, round: null }), 'range'), 9000, () => {});
  assert.ok(radioDebug().placed[0]!.sputtering < 9000, 'it settles again');
});

/** A recording context: every fill's colour, every string drawn, and the glow's brightest stop. */
function radioRecorder() {
  const fills: unknown[] = [], texts: string[] = [], glow: number[] = [];
  const target: Record<string | symbol, unknown> = {};
  const ctx = new Proxy(target, {
    get: (t, k) => {
      if (k in t) return t[k];
      if (k === 'measureText') return () => ({ width: 80 });
      if (k === 'fill' || k === 'fillRect') return () => { fills.push(t.fillStyle); };
      if (k === 'fillText') return (s: string) => { texts.push(s); };
      if (k === 'createRadialGradient') return () => ({ addColorStop: (at: number, c: string) => { const a = /^rgba\(255, 190, 90, ([\d.]+)\)$/.exec(c); if (at === 0 && a) glow.push(Number(a[1])); } });
      return () => {};
    },
    set: (t, k, v) => { t[k] = v; return true; },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, fills, texts, glow };
}

test('a radio playing lights its amber lamp and glows; one turned off or sputtering goes dark; the prompt names the station and the key', () => {
  const draw = (o: { off: boolean; sputter: number }) => {
    const r = radioRecorder();
    drawRadio(r.ctx, { x: 10, y: 10, scale: 1.5, now: 1234, pulse: 0.6, dark: 0.5, needle: 0.4, quiet: false, reduced: false, near: false, ...o });
    return r;
  };
  const DARK_LAMP = '#6b4a2c';
  const on = draw({ off: false, sputter: 0 }), off = draw({ off: true, sputter: 0 }), hit = draw({ off: false, sputter: 0.8 });
  assert.equal(on.fills.includes(DARK_LAMP), false, 'tuned in: the lamp is lit');
  assert.equal(off.fills.includes(DARK_LAMP), true, 'off: the lamp is dark');
  assert.equal(hit.fills.includes(DARK_LAMP), true, 'shot: the lamp goes out while it sputters');
  assert.ok(off.glow[0]! < on.glow[0]! * 0.5, `an off radio barely glows (${off.glow[0]} vs ${on.glow[0]})`);
  const prompt = radioRecorder();
  drawRadioPrompt(prompt.ctx, 0, 0, 100, 'Radio · Toy March', 'E', false, 1.45);
  assert.ok(prompt.texts.includes('Radio · Toy March') && prompt.texts.includes('E'), `drew ${prompt.texts}`);
  const touch = radioRecorder();
  drawRadioPrompt(touch.ctx, 0, 0, 100, 'Radio · Off', 'TAP', true);
  assert.ok(touch.texts.includes('Radio · Off') && touch.texts.includes('TAP'));
});
