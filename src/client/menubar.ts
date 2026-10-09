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

/** Lays the top bar out in `root`, moving the existing account chip into place (it keeps its sheet and its handlers). */
export function renderTopBar(root: HTMLElement, me: Me | null, on: { register(): void; logout(): void }) {
  const chip = document.getElementById('acct-btn')!;
  const nodes = topBarItems(me).map((item): HTMLElement => {
    switch (item.kind) {
      case 'chip': {
        const name = chip.querySelector<HTMLElement>('.acct-name'), lv = chip.querySelector<HTMLElement>('.acct-lv');
        if (name) name.textContent = item.text;
        if (lv) lv.hidden = true;
        return chip;
      }
      case 'pitch': return make('span', { id: item.id, className: 'top-pitch' }, item.text);
      case 'me': {
        const fill = make('i', {});
        fill.style.width = `${Math.round(item.pct * 100)}%`;
        const a = make('a', { id: item.id, className: 'top-me', href: item.href, title: `Your service record · Level ${item.level} · ${item.label}` },
          make('span', { className: 'top-me-row' }, make('b', { className: 'acct-lv' }, `LV ${item.level}${item.prestige ? ` ★${item.prestige}` : ''}`), make('span', { className: 'top-me-name' }, item.name)),
          make('span', { className: 'top-me-bar', ariaLabel: item.label }, fill));
        return a;
      }
      case 'button': {
        const b = make('button', { id: item.id, type: 'button', className: item.primary ? 'top-register' : 'link top-link' }, item.text);
        b.onclick = item.id === 'top-register' ? on.register : on.logout;
        return b;
      }
    }
  });
  root.dataset.signedIn = String(!!me);
  root.replaceChildren(...nodes);
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
