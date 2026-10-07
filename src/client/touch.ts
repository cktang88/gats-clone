import type { Action } from './input.ts';

type Stick = { id: number; ox: number; oy: number; x: number; y: number };
export type Sticks = { move: Stick | null; aim: Stick | null };

export const NO_STICKS: Sticks = { move: null, aim: null };
const STICK_BASE = 56;
let radius = STICK_BASE;
/** Sticks grow with the phone HUD scale so a thumb's full throw stays comfortable (and >= 44 px wide at the knob). */
export const setStickScale = (ui: number): void => { radius = Math.round(STICK_BASE * ui); };
export const stickRadius = (): number => radius;
const DEADZONE = 0.2;
const AXIS_THRESHOLD = 0.38;
const AIM_RANGE = 700;

export function pressStick(s: Sticks, id: number, x: number, y: number, viewW: number): Sticks {
  const stick = { id, ox: x, oy: y, x, y };
  if (x < viewW / 2) return s.move ? s : { ...s, move: stick };
  return s.aim ? s : { ...s, aim: stick };
}

export function dragStick(s: Sticks, id: number, x: number, y: number): Sticks {
  if (s.move?.id === id) return { ...s, move: { ...s.move, x, y } };
  if (s.aim?.id === id) return { ...s, aim: { ...s.aim, x, y } };
  return s;
}

export function releaseStick(s: Sticks, id: number): Sticks {
  if (s.move?.id === id) return { ...s, move: null };
  if (s.aim?.id === id) return { ...s, aim: null };
  return s;
}

export function stickVector(st: Stick): { x: number; y: number; mag: number } {
  const dx = st.x - st.ox;
  const dy = st.y - st.oy;
  const len = Math.hypot(dx, dy);
  const mag = Math.min(1, len / radius);
  return len === 0 ? { x: 0, y: 0, mag: 0 } : { x: (dx / len) * mag, y: (dy / len) * mag, mag };
}

export function touchMoves(s: Sticks): Action[] {
  if (!s.move) return [];
  const v = stickVector(s.move);
  if (v.mag < DEADZONE) return [];
  const out: Action[] = [];
  if (v.x > AXIS_THRESHOLD) out.push('right');
  if (v.x < -AXIS_THRESHOLD) out.push('left');
  if (v.y > AXIS_THRESHOLD) out.push('down');
  if (v.y < -AXIS_THRESHOLD) out.push('up');
  return out;
}

export function touchAim(s: Sticks): { dx: number; dy: number } | null {
  if (!s.aim) return null;
  const v = stickVector(s.aim);
  if (v.mag < DEADZONE) return null;
  return { dx: v.x * AIM_RANGE, dy: v.y * AIM_RANGE };
}
