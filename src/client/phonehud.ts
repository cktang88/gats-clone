import { setChatterCompact } from './chatter.ts';
import { isPhoneLandscape, phoneLayout, type Box } from './phonelayout.ts';
import type { Insets } from './viewport.ts';

/**
 * The DOM half of the phone-on-its-side HUD: puts the touch buttons, the cog, the chat and the level-up pill in their boxes from
 * phonelayout.ts (the canvas half is in hud.ts), and flags the page `phone-hud` so style.css can fold the rest away (the round's
 * objective banner, which the canvas flashes in its top line instead, and the squad chip, whose invite link is in the pause menu).
 * Off a phone it puts every element back as the stylesheet had it.
 */
const PLACED: [selector: string, slot: 'ability' | 'reload' | 'emote' | 'cog' | 'context' | 'chat', size: 'box' | 'width' | null][] = [
  ['#touch-ability', 'ability', 'box'],
  ['#touch-reload', 'reload', 'box'],
  ['.touch-emote', 'emote', 'box'],
  ['.pause-cog', 'cog', 'box'],
  ['.touch-radio', 'context', null],
  ['.touch-use', 'context', null],
  ['.chat', 'chat', 'width'],
];
const PROPS = ['left', 'top', 'right', 'bottom', 'width', 'height', 'transform'] as const;
const saved = new WeakMap<HTMLElement, Partial<Record<(typeof PROPS)[number], string>>>();

function place(el: HTMLElement, b: Box | null, size: 'box' | 'width' | null, center = false) {
  if (!saved.has(el)) saved.set(el, Object.fromEntries(PROPS.map((p) => [p, el.style[p]])));
  if (!b) { Object.assign(el.style, saved.get(el)); return; }
  Object.assign(el.style, { left: `${center ? b.x + b.w / 2 : b.x}px`, top: `${b.y}px`, right: 'auto', bottom: 'auto', transform: center ? 'translateX(-50%)' : 'none' });
  if (size) el.style.width = `${b.w}px`;
  if (size === 'box') el.style.height = `${b.h}px`;
}

export function applyPhoneHud(root: HTMLElement, w: number, h: number, safe: Insets, touch: boolean, k: number): boolean {
  const on = isPhoneLandscape(w, h, touch);
  document.body.classList.toggle('phone-hud', on);
  setChatterCompact(on);
  const L = on ? phoneLayout(w, h, safe, k) : null;
  for (const [sel, slot, size] of PLACED) {
    const el = root.querySelector<HTMLElement>(sel) ?? document.querySelector<HTMLElement>(sel);
    if (!el) continue;
    // The context button (use, radio) is a pill as wide as its word: it centres on its box.
    place(el, L && L[slot], size, slot === 'context');
  }
  const chat = root.querySelector<HTMLElement>('.chat');
  if (chat) chat.dataset.lines = L ? String(Math.round(L.chat.h / (18 * (k / 0.9)))) : '';
  // Low between the sticks, standing on the bottom line: the level-up dock (folded to a pill; open, it grows up from there) and
  // the range's readout, which never share a match (the range has no level picks).
  for (const sel of ['#perk-panel', '#range-hud']) {
    const el = root.querySelector<HTMLElement>(sel);
    if (!el) continue;
    if (!saved.has(el)) saved.set(el, { left: el.style.left, bottom: el.style.bottom, top: el.style.top });
    Object.assign(el.style, L ? { left: `${L.bottom.x + L.bottom.w / 2}px`, bottom: `${h - L.bottom.y - L.bottom.h}px`, top: 'auto' } : saved.get(el));
  }
  return on;
}
