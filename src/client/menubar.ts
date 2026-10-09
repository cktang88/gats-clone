import { changelogHtml } from './changelog.ts';
import type { LevelState } from '../shared/cosmetics.ts';
import { levelBar } from './progression.ts';

/**
 * The menu's two bars, as on a classic .io front page. Top right: Log in and Register for a guest (with the one reason to register
 * beside them); once signed in, your name and level bar (to your own service record, the page a profile look-up shows), Account
 * (the sheet with your account settings) and Log out. Bottom: What's new, Discord, Give feedback and the privacy policy. The forms
 * themselves stay where they are (the enlist plate and the account sheet); these are only ways in.
 */
export type TopItem =
  | { kind: 'pitch'; id: string; text: string }
  | { kind: 'chip'; id: 'acct-btn'; text: string }
  | { kind: 'me'; id: string; name: string; href: string; level: number; prestige: number; pct: number; label: string }
  | { kind: 'button'; id: string; text: string; primary?: boolean };

export const REGISTER_PITCH = 'Register to keep your medals & career';
export type Me = { name: string; level: LevelState };

/** Your own service record: the same page a look-up of your name opens. */
export const profileHref = (name: string) => `profile.html?name=${encodeURIComponent(name)}`;

/** What the top bar holds, in order. `acct-btn` is the existing account chip (Log in for a guest, Account once signed in). */
export function topBarItems(me: Me | null): TopItem[] {
  if (!me) {
    return [
      { kind: 'pitch', id: 'top-pitch', text: REGISTER_PITCH },
      { kind: 'chip', id: 'acct-btn', text: 'Log in' },
      { kind: 'button', id: 'top-register', text: 'Register', primary: true },
    ];
  }
  const bar = levelBar(me.level);
  return [
    { kind: 'me', id: 'top-me', name: me.name, href: profileHref(me.name), level: bar.level, prestige: bar.prestige, pct: bar.pct, label: bar.label },
    { kind: 'chip', id: 'acct-btn', text: 'Account' },
    { kind: 'button', id: 'top-logout', text: 'Log out' },
  ];
}

const make = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]>, ...kids: (Node | string)[]) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids);
  return n;
};

/** The one class every top-bar button carries: one height, one padding, one baseline (menubars.css). */
export const TOP_BTN = 'top-btn';

/** The classes each top-bar item gets: every button-like item shares `TOP_BTN`; only the guest's pitch is plain text. */
export function topItemClass(item: TopItem): string {
  switch (item.kind) {
    case 'pitch': return 'top-pitch';
    case 'chip': return `acct-chip ${TOP_BTN}`;
    case 'me': return `top-me ${TOP_BTN}`;
    case 'button': return `${item.primary ? 'top-register' : 'top-logout'} ${TOP_BTN}`;
  }
}

/**
 * How tightly the top bar packs, from 0 (everything) to `TOP_FIT_MAX`: 1 drops the guest's pitch, 2 tightens the tabs, 3 shows the
 * emblem without the word, 4 shortens your name. `overflow(level)` is how many px the bar would spill at that level (the DOM's own
 * measure, or a model in the tests); the first level that fits wins, and the last one stands if none does.
 */
export const TOP_FIT_MAX = 4;
export function fitLevel(overflow: (level: number) => number): number {
  for (let level = 0; level < TOP_FIT_MAX; level++) if (overflow(level) <= 0) return level;
  return TOP_FIT_MAX;
}

/**
 * How far the bar's pieces spill at the current packing, in px: past either edge of the bar, or into each other (the logo, every tab
 * and every top-bar button, taken left to right on each row, need a 4px gap). 0 or less means it fits.
 */
export function spillPx(bar: { left: number; right: number }, boxes: readonly { left: number; right: number; top: number; bottom: number }[]): number {
  let worst = -Infinity;
  // A pixel of slack at the edges: sub-pixel layout can put a button's edge a fraction past the bar's.
  for (const b of boxes) worst = Math.max(worst, b.right - bar.right - 1, bar.left - b.left - 1);
  const rows = [...boxes].sort((p, q) => p.left - q.left);
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const p = rows[i]!, q = rows[j]!;
      if (p.bottom <= q.top || q.bottom <= p.top) continue; // different rows
      worst = Math.max(worst, p.right + 4 - q.left);
    }
  }
  return worst === -Infinity ? 0 : worst;
}

/** Packs the bar (`.menu-top`) to the first level at which nothing spills or overlaps; runs again whenever the menu changes size. */
export function fitTopBar(bar: HTMLElement) {
  const spill = (level: number) => {
    bar.dataset.fit = String(level);
    const parts = [...bar.querySelectorAll<HTMLElement & SVGElement>('.wordmark .emblem, .wordmark .logo, .menu-tabs > button, .menu-auth > *')].filter((e) => e.getClientRects().length);
    // Layout boxes, not painted ones: a chip mid-stamp (scaled up for 0.3 s) must not read as overlapping its neighbour.
    const b = bar.getBoundingClientRect();
    const zoom = bar.offsetWidth ? b.width / bar.offsetWidth : 1;
    return spillPx(b, parts.map((e) => {
      const r = e.getBoundingClientRect(), cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
      const hw = ((e.offsetWidth || r.width / zoom) * zoom) / 2, hh = ((e.offsetHeight || r.height / zoom) * zoom) / 2;
      return { left: cx - hw, right: cx + hw, top: cy - hh, bottom: cy + hh };
    }));
  };
  bar.dataset.fit = String(fitLevel(spill));
}

/** Lays the top bar out in `root`, moving the existing account chip into place (it keeps its sheet and its handlers). */
export function renderTopBar(root: HTMLElement, me: Me | null, on: { register(): void; logout(): void }) {
  const chip = document.getElementById('acct-btn')!;
  const nodes = topBarItems(me).map((item): HTMLElement => {
    const className = topItemClass(item);
    switch (item.kind) {
      case 'chip': {
        const name = chip.querySelector<HTMLElement>('.acct-name'), lv = chip.querySelector<HTMLElement>('.acct-lv');
        if (name) name.textContent = item.text;
        if (lv) lv.hidden = true;
        chip.classList.add(TOP_BTN);
        return chip;
      }
      case 'pitch': return make('span', { id: item.id, className }, item.text);
      case 'me': {
        const fill = make('i', {});
        fill.style.width = `${Math.round(item.pct * 100)}%`;
        const a = make('a', { id: item.id, className, href: item.href, title: `Your service record · Level ${item.level} · ${item.label}` },
          make('span', { className: 'top-me-row' }, make('b', { className: 'acct-lv' }, `LV ${item.level}${item.prestige ? ` ★${item.prestige}` : ''}`), make('span', { className: 'top-me-name' }, item.name)),
          make('span', { className: 'top-me-bar', ariaLabel: item.label }, fill));
        return a;
      }
      case 'button': {
        const b = make('button', { id: item.id, type: 'button', className }, item.text);
        b.onclick = item.id === 'top-register' ? on.register : on.logout;
        return b;
      }
    }
  });
  root.dataset.signedIn = String(!!me);
  root.replaceChildren(...nodes);
  const bar = root.closest<HTMLElement>('.menu-top');
  if (bar) {
    const refit = () => { if (bar.clientWidth) fitTopBar(bar); };
    refit();
    // Once more after the frame settles (the UI scale and the fonts can land after the first render).
    requestAnimationFrame(() => requestAnimationFrame(refit));
    if (!bar.dataset.fitWatch) {
      // Again whenever the menu changes size (a resize, or the menu coming back after a match) and once the fonts are in.
      bar.dataset.fitWatch = '1';
      const menu = bar.closest('#menu');
      if (menu && typeof ResizeObserver === 'function') new ResizeObserver(refit).observe(menu);
      else addEventListener('resize', refit);
      void document.fonts?.ready.then(refit);
    }
  }
}

/** Shows the Discord link only when there is an invite to point at. */
export function applyDiscord(a: { hidden: boolean | string; href: string }, url: string) {
  a.hidden = !url;
  if (url) a.href = url;
}

/**
 * The What's new panel: a dialog over the menu, readable on a phone, closed by its button, Esc or a tap outside. It opens
 * non-modally (`show`, not `showModal`) so it stays out of the browser's top layer, under the cursor layer; the dimming is
 * its own wide shadow.
 */
export function mountChangelog(opener: HTMLElement): { open(): void; close(): void } {
  const dialog = document.createElement('dialog');
  dialog.id = 'changelog';
  dialog.className = 'changelog';
  dialog.setAttribute('aria-labelledby', 'changelog-title');
  dialog.innerHTML = `<header class="cl-head"><h2 id="changelog-title">What's new</h2><button type="button" class="cl-close" aria-label="Close">Close</button></header><div class="cl-body">${changelogHtml()}</div>`;
  document.body.append(dialog);
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); } };
  const onDown = (e: PointerEvent) => { if (!dialog.contains(e.target as Node) && e.target !== opener) close(); };
  function close() {
    if (!dialog.open) return;
    dialog.close();
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onDown, true);
    opener.focus({ preventScroll: true });
  }
  dialog.querySelector<HTMLButtonElement>('.cl-close')!.onclick = close;
  const open = () => {
    if (dialog.open) return;
    dialog.show();
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
    dialog.querySelector<HTMLButtonElement>('.cl-close')!.focus({ preventScroll: true });
  };
  opener.addEventListener('click', (e) => { e.preventDefault(); open(); });
  return { open, close };
}
