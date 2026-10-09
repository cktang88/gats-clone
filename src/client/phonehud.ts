import { setChatterCompact } from './chatter.ts';
import { deathBox } from './deathflow.ts';
import { FOCUS, type PhoneElement } from './phonefocus.ts';
import { isPhoneLandscape, phoneLayout, type Box } from './phonelayout.ts';
import type { Insets } from './viewport.ts';

/**
 * The DOM half of the phone-on-its-side HUD: puts the touch buttons, the cog, the chat and the level-up pill in their boxes from
 * phonelayout.ts (the canvas half is in hud.ts), and flags the page `phone-hud` so style.css can fold the rest away (the round's
 * objective banner, which the canvas flashes in its top line instead, and the squad chip, whose invite link is in the pause menu).
 * Off a phone it puts every element back as the stylesheet had it.
 *
 * What shows when is phonefocus.ts's call: hud.ts asks it each frame and hands the answer to `syncPhoneFocus`, which flags the
 * page so style.css shows the chat only once its pip is tapped, the emote (GG) button only near a round's end, and the range's
 * readout folded to its last hit until tapped.
 */
const PLACED: [selector: string, slot: 'ability' | 'reload' | 'emote' | 'cog' | 'context' | 'chat' | 'chatPip' | 'medal', size: 'box' | 'width' | null][] = [
  ['#touch-ability', 'ability', 'box'],
  ['#touch-reload', 'reload', 'box'],
  ['.touch-emote', 'emote', 'box'],
  ['.pause-cog', 'cog', 'box'],
  ['.touch-radio', 'context', null],
  ['.chat', 'chat', 'width'],
  ['.chat-pip', 'chatPip', 'box'],
  ['#medals', 'medal', 'width'],
];
/** The DOM side of the phone's focus: when the chat pip and the range readout were last tapped open. */
const taps = { chat: -Infinity, range: -Infinity };
let chatLog: HTMLElement | null = null;
let pip: HTMLButtonElement | null = null;

/** What hud.ts's focus needs from the page: the chat lines a player said that are still up, and the DOM taps. */
export function phoneDomState(): { chatLines: number; chatTapAt: number; rangeTapAt: number } {
  const chatLines = chatLog ? chatLog.querySelectorAll('li:not(.system):not(.muted-line)').length : 0;
  return { chatLines, chatTapAt: taps.chat, rangeTapAt: taps.range };
}

const FLAGS: [PhoneElement, string][] = [['chatOpen', 'phone-chat-open'], ['chatPip', 'phone-chat-pip'], ['gg', 'phone-gg'], ['rangeFull', 'phone-range-full']];
let flagged = '';
/** Flags the page with what the phone shows this frame (only touching the DOM when that changes). */
export function syncPhoneFocus(F: Record<PhoneElement, boolean>) {
  const key = FLAGS.map(([el]) => (F[el] ? '1' : '0')).join('');
  if (key === flagged) return;
  flagged = key;
  for (const [el, cls] of FLAGS) document.body.classList.toggle(cls, F[el]);
  if (pip) {
    pip.setAttribute('aria-expanded', String(F.chatOpen));
    pip.setAttribute('aria-label', F.chatOpen ? 'Hide chat' : 'Show chat');
  }
}

/** The chat's pip (a speech bubble with the count of lines waiting), and the range readout's tap to unfold. Built once. */
function mountOnDemand(root: HTMLElement) {
  if (pip) return;
  chatLog = root.querySelector<HTMLElement>('#chat-log') ?? document.getElementById('chat-log');
  pip = document.createElement('button');
  pip.type = 'button';
  pip.className = 'chat-pip';
  pip.setAttribute('aria-label', 'Show chat');
  pip.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v10H10l-4 4v-4H4z"/></svg><b></b>';
  const count = pip.querySelector('b')!;
  pip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const now = performance.now();
    taps.chat = now - taps.chat < FOCUS.chatOpenMs ? -Infinity : now;
  });
  root.append(pip);
  if (chatLog) new MutationObserver(() => { const n = phoneDomState().chatLines; count.textContent = n ? String(n) : ''; }).observe(chatLog, { childList: true });
  root.querySelector<HTMLElement>('#range-hud')?.addEventListener('pointerdown', (e) => {
    if (!document.body.classList.contains('phone-hud') || !(e.target as HTMLElement).closest('.rs-grid')) return;
    const now = performance.now();
    taps.range = now - taps.range < FOCUS.mapOpenMs ? -Infinity : now;
  });
}

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
  if (on) mountOnDemand(root);
  if (!on && flagged) { flagged = ''; for (const [, cls] of FLAGS) document.body.classList.remove(cls); }
  setChatterCompact(on);
  const L = on ? phoneLayout(w, h, safe, k) : null;
  for (const [sel, slot, size] of PLACED) {
    const el = root.querySelector<HTMLElement>(sel) ?? document.querySelector<HTMLElement>(sel);
    if (!el) continue;
    // The context button (the radio) is a pill as wide as its word: it centres on its box.
    place(el, L && L[slot], size, slot === 'context');
  }
  // The death card takes the visible screen inside the insets, clear of the cog (deathflow.ts), and scrolls inside itself.
  const death = root.querySelector<HTMLElement>('#death');
  if (death) {
    // The HUD is zoomed by --ui (a UI scale option above 100%), so the box is given in its zoomed px.
    const z = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui')) || 1;
    const b = on ? deathBox(w, h, safe, k) : null;
    place(death, b && { x: b.x / z, y: b.y / z, w: b.w / z, h: b.h / z }, 'box');
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
