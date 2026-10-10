/**
 * The phone's way to take a gun off the floor in Last Standing: E has no key on a touch screen, so a TAKE button shows while a floor gun
 * is within reach, and holding it is holding E (the server takes one gun per press, see royale.ts `tickGuns`).
 */
const touchScreen = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
let btn: HTMLButtonElement | null = null;

/** On a touch screen, builds the button; `hold` and `release` press and let go of E. */
export function mountTakeButton(parent: HTMLElement, hold: () => void, release: () => void) {
  if (!touchScreen || btn) return;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'touch-take';
  b.style.cssText = 'display:none;position:fixed;right:176px;bottom:256px;min-width:64px;height:42px;padding:0 12px;z-index:12;border-radius:22px;border:2px solid rgba(159,196,255,.85);background:rgba(19,21,25,.72);color:#dce8ff;font:800 14px var(--display);touch-action:none;box-shadow:0 0 0 3px rgba(120,160,255,.25)';
  b.addEventListener('pointerdown', (e) => { e.preventDefault(); hold(); });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave'] as const) b.addEventListener(type, release);
  parent.append(b);
  btn = b;
}

/** Shows the button with the gun in reach (its name), or hides it with none. */
export function syncTakeButton(gun: string | null) {
  if (!btn) return;
  btn.style.display = gun ? 'block' : 'none';
  const label = gun ? `TAKE ${gun.toUpperCase()}` : '';
  if (btn.textContent !== label) { btn.textContent = label; btn.setAttribute('aria-label', label || 'Take gun'); }
}

/** What the floor plate says to press: a key on a keyboard, the button on a touch screen. */
export const takeKey = touchScreen ? 'TAP' : '[E]';
