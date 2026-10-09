import { ARMORS, ARMOR_IDS, COLORS, COLOR_IDS, GUNS, WEAPON_IDS, type ModeId, type WeaponId } from '../shared/defs.ts';
import { HANDLING } from '../shared/handling.ts';
import type { Loadout } from '../shared/protocol.ts';
import { CLASS_ROLES } from '../shared/roles.ts';
import { authenticate, dropGuestClaim, fetchOwnEmail, fetchStats, loadAccount, requestReset, saveOwnEmail, loadGuestClaims, loadName, pickGuestClaim, saveAccount, type Account, type ServerInfo } from './api.ts';
import { CARRY_LINE } from './enlist.ts';
import { EMAIL_MAX, emailError } from '../shared/email.ts';
import type { MutedNames } from './chatmute.ts';
import { CONTROLS } from './input.ts';
import { drawGunCard } from './gunart.ts';
import { MODE_INFO, type SceneId } from './modecards.ts';

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node: HTMLElementTagNameMap[K] = Object.assign(document.createElement(tag), props);
  node.append(...kids);
  return node;
}

type LoadoutPicker = { refresh(): void };

/**
 * A class gun's kit card bars, each against the best of the six classes: power is the damage of one trigger pull, rate its
 * shots a second, reach its range, and mobility how fast it lets you walk.
 */
export function gunBars(id: WeaponId): { label: string; value: number }[] {
  const raw = (g: WeaponId) => {
    const d = GUNS[g];
    return [d.damage * d.pellets, 1000 / d.fireMs, d.range, d.moveMul];
  };
  const best = [0, 1, 2, 3].map((i) => Math.max(...WEAPON_IDS.map((g) => raw(g)[i]!)));
  return ['PWR', 'RATE', 'REACH', 'MOVE'].map((label, i) => ({ label, value: raw(id)[i]! / best[i]! }));
}

function gunStats(id: WeaponId): HTMLElement {
  return el('span', { className: 'gun-stats' }, ...gunBars(id).flatMap(({ label, value }) => {
    const bar = el('i');
    bar.style.setProperty('--v', `${Math.round(Math.max(0.08, value) * 100)}%`);
    return [el('span', {}, label), bar];
  }));
}

/** `gear` is the menu's gear-up screen: bigger gun art, paint pots for colours, and `peek` hears which gun the pointer is on. */
export type PickerOpts = { gear?: boolean; peek?: (gun: WeaponId | null) => void; /** Where the colour pots go, when they sit apart from the guns and armor. */ colorRoot?: HTMLElement };

export function mountLoadoutPicker(root: HTMLElement, get: () => Loadout, set: (l: Loadout) => void, skin: () => string = () => '', opts: PickerOpts = {}): LoadoutPicker {
  let paintedSkin = skin();
  const size = opts.gear ? { w: 190, h: 64 } : { w: 150, h: 56 };
  const weaponButtons = WEAPON_IDS.map((id) => {
    const w = GUNS[id];
    const art = el('canvas', { className: 'gun-art' });
    const b = el('button', { type: 'button', className: 'tile weapon', title: `${w.name}: ${CLASS_ROLES[id]}` },
      art, el('b', {}, w.name), el('small', {}, `${w.damage}${w.pellets > 1 ? `×${w.pellets}` : ''} dmg · ${w.mag} mag`), gunStats(id));
    b.onclick = () => set({ ...get(), weapon: id });
    if (opts.peek) {
      b.addEventListener('pointerenter', (e) => { if (e.pointerType !== 'touch') opts.peek!(id); });
      b.addEventListener('pointerleave', () => opts.peek!(null));
      b.addEventListener('focus', () => opts.peek!(id));
      b.addEventListener('blur', () => opts.peek!(null));
    }
    drawGunCard(art, id, size.w, size.h, [id], paintedSkin);
    return [id, b] as const;
  });
  const colorButtons = COLOR_IDS.map((id) => {
    const b = el('button', { type: 'button', className: 'swatch', title: id, ariaLabel: id });
    b.style.setProperty('--swatch', COLORS[id]);
    b.onclick = () => set({ ...get(), color: id });
    return [id, b] as const;
  });
  const armorButtons = ARMOR_IDS.map((id) => {
    const a = ARMORS[id];
    // What its weight costs in walk speed (handling.ts: every kg carried takes the same share off).
    const speed = Math.round(a.kg * HANDLING.load.perKg * 100);
    const tier = ARMOR_IDS.indexOf(id);
    const meter = el('span', { className: 'meter' }, ...[1, 2, 3].map((n) => el('i', { className: n <= tier ? 'on' : '' })));
    const cost = a.blockFrac
      ? [el('small', {}, `+${Math.round(a.blockFrac * 100)}% ${opts.gear ? 'block' : 'dmg blocked'}`), el('small', {}, `−${speed}% speed`)]
      : [el('small', {}, 'Full speed')];
    const b = el('button', { type: 'button', className: 'tile armor', title: a.blockFrac ? `${a.name}: blocks ${Math.round(a.blockFrac * 100)}% of damage, ${speed}% slower` : `${a.name}: no armor, full speed` }, el('b', {}, a.name), meter, ...cost);
    b.onclick = () => set({ ...get(), armor: id });
    return [id, b] as const;
  });
  const colors = [el('h2', {}, 'Color'), el('div', { className: 'swatches' }, ...colorButtons.map(([, b]) => b))];
  root.replaceChildren(
    el('h2', {}, 'Weapon'), el('div', { className: 'weapons' }, ...weaponButtons.map(([, b]) => b)),
    ...(opts.colorRoot ? [] : colors),
    el('h2', {}, 'Armor'), el('div', { className: 'armors' }, ...armorButtons.map(([, b]) => b)),
  );
  opts.colorRoot?.replaceChildren(...colors);
  const refresh = () => {
    const l = get();
    for (const [id, b] of weaponButtons) b.ariaPressed = String(id === l.weapon);
    if (skin() !== paintedSkin) {
      // The gun cards wear the skin you have equipped.
      paintedSkin = skin();
      for (const [id, b] of weaponButtons) { const art = b.querySelector('canvas'); if (art) drawGunCard(art, id, size.w, size.h, [id], paintedSkin); }
    }
    for (const [id, b] of colorButtons) b.ariaPressed = String(id === l.color);
    for (const [id, b] of armorButtons) b.ariaPressed = String(id === l.armor);
  };
  refresh();
  return { refresh };
}

export function renderControls(root: HTMLElement) {
  root.replaceChildren(...CONTROLS.flatMap(([key, what]) => [el('dt', {}, el('kbd', {}, key)), el('dd', {}, what)]));
}

export function renderMuted(root: HTMLElement, muted: MutedNames, unmute: (name: string) => void) {
  root.hidden = muted.size === 0;
  root.replaceChildren(el('h2', {}, 'Muted in chat'), el('ul', { className: 'muted-list' }, ...[...muted].map((name) => {
    const b = el('button', { type: 'button', className: 'link' }, 'Unmute');
    b.onclick = () => unmute(name);
    return el('li', {}, el('span', {}, name), b);
  })));
}

type CardRefs = { wrap: HTMLElement; btn: HTMLButtonElement; live: HTMLElement };
const cardCache = new WeakMap<HTMLElement, { key: string; cards: Map<string, CardRefs> }>();

/** Who is in, as a small pill (empty until the count is known). */
export function livePill(live: string): { pill: HTMLElement; live: HTMLElement } {
  const n = el('span', { className: 'n' }, live);
  return { pill: el('span', { className: 'mc-live' }, el('i'), n), live: n };
}

/** A mode's info, in type only: its chip, name and who is in, then its one-line pitch and anything it adds (its own buttons). */
export function cardPlate(mode: SceneId, pill: HTMLElement, ...more: (Node | string)[]): HTMLElement {
  const info = MODE_INFO[mode];
  return el('span', { className: 'mc-plate' },
    el('span', { className: 'mc-head' }, el('span', { className: `mode mode-${mode.toLowerCase()}` }, mode), el('b', { className: 'mc-name' }, info.name), pill),
    el('span', { className: 'mc-pitch' }, info.pitch), ...more);
}

/**
 * The public rooms as mode cards (screen one): the mode's name and pitch, and who is in. The cards stay put between polls, and only
 * the live counts and the picked state change.
 */
export function renderServers(root: HTMLElement, servers: ServerInfo[] | null, selected: string | null, pick: (id: string, mode: ModeId) => void) {
  const old = cardCache.get(root);
  if (servers === null || !servers.length) {
    cardCache.delete(root);
    root.replaceChildren(el('p', { className: 'muted mc-empty' }, servers === null ? 'Could not load servers. Retrying…' : 'No servers running.'));
    return;
  }
  const key = servers.map((sv) => `${sv.id}:${sv.mode}`).join('|');
  let entry = old;
  if (!entry || entry.key !== key) {
    const cards = new Map<string, CardRefs>();
    root.replaceChildren(...servers.map((sv) => {
      const { pill, live } = livePill('');
      const btn = el('button', { type: 'button', className: `server mode-card plate mc-${sv.mode.toLowerCase()}` },
        el('span', { className: 'mc-face' }, cardPlate(sv.mode as SceneId, pill)));
      btn.dataset.room = sv.id;
      btn.onclick = () => pick(sv.id, sv.mode);
      const wrap = el('div', { className: 'mc-wrap' }, btn);
      cards.set(sv.id, { wrap, btn, live });
      return wrap;
    }));
    entry = { key, cards };
    cardCache.set(root, entry);
  }
  for (const sv of servers) {
    const c = entry.cards.get(sv.id);
    if (!c) continue;
    const text = `${sv.players} ${sv.players === 1 ? 'player' : 'players'}${sv.humans ? ` · ${sv.humans} human` : ''}`;
    if (c.live.textContent !== text) c.live.textContent = text;
    c.btn.ariaPressed = String(sv.id === selected);
  }
}

type SquadMenu = { code: string | null; selected: boolean; link: string | null; busy: boolean };

/**
 * The Zombies card: the Bastion squad's name and pitch, with a button that starts a squad at once (a shortcut that deploys with
 * the loadout you last picked) and, once a squad exists, its room chip and invite link. The rest of the card chooses Zombies and
 * goes on to the gear screen, where Deploy starts the squad (or joins the one from an invite link).
 */
export function renderSquad(root: HTMLElement, squad: SquadMenu, on: { start(): void; pick(): void; choose?(): void }) {
  const start = el('button', { type: 'button', id: 'squad-start', className: 'mc-btn', disabled: squad.busy }, squad.busy ? 'Starting…' : squad.code ? 'New squad' : 'Start a squad');
  start.onclick = on.start;
  const actions = el('span', { className: 'mc-actions' });
  if (squad.code && squad.link) {
    const room = el('button', { type: 'button', className: 'server mc-room', id: 'squad-room' },
      el('span', { className: 'mode mode-zom' }, 'ZOM'),
      el('span', { className: 'server-name' }, `Squad ${squad.code}`),
      el('span', { className: 'count' }, 'private'));
    room.ariaPressed = String(squad.selected);
    room.onclick = on.pick;
    const link = el('input', { id: 'squad-link', readOnly: true, value: squad.link, ariaLabel: 'Invite link' });
    const copy = el('button', { type: 'button', id: 'squad-copy', className: 'mc-btn' }, 'Copy link');
    copy.onclick = () => void copyText(link.value, copy);
    actions.append(room, el('span', { className: 'invite' }, link, copy));
  }
  const { pill } = livePill(squad.code ? 'private squad' : 'up to 4 players');
  actions.prepend(el('span', { className: 'mc-cta' }, start));
  const hit = el('button', { type: 'button', className: 'mc-hit', ariaLabel: 'Zombies: choose your gear' });
  hit.onclick = on.choose ?? on.pick;
  root.replaceChildren(el('span', { className: 'mc-face' }, cardPlate('ZOM', pill, actions)), hit);
}

/** Each copy button's resting label and its pending restore, so a second press inside the 1.6 s never takes "Copied" for the label. */
const copyLabels = new WeakMap<HTMLButtonElement, { label: string; timer: ReturnType<typeof setTimeout> | undefined }>();

/** Copies `text` and says so on `button` for a moment (the menu's invite links and the pause menu's). */
export async function copyText(text: string, button: HTMLButtonElement) {
  let st = copyLabels.get(button);
  if (!st) { st = { label: button.textContent ?? '', timer: undefined }; copyLabels.set(button, st); }
  const rest = st;
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    const scratch = el('textarea', { value: text });
    document.body.append(scratch);
    scratch.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    scratch.remove();
  }
  button.textContent = ok ? 'Copied' : 'Copy failed';
  clearTimeout(rest.timer);
  rest.timer = setTimeout(() => { button.textContent = rest.label; rest.timer = undefined; }, 1600);
}

export function renderSquadChip(root: HTMLElement, code: string | null, link: string | null) {
  root.hidden = code === null;
  if (!code || !link) return;
  const copy = el('button', { type: 'button', id: 'squad-chip-copy' }, 'Copy invite link');
  // A focused button would also take the Space that triggers the ability.
  copy.onmousedown = (e) => e.preventDefault();
  copy.onclick = () => void copyText(link, copy);
  root.replaceChildren(el('span', {}, `Squad ${code}`), copy);
}

/** For a player locked out of an account with no email: it can't be reset, and how to make the next one resettable. */
export const NO_EMAIL_LINE = 'Add an email in your account to enable password reset.';

/**
 * The signed-in account's reset email: what is on file (only its owner sees it), and a small form to add, change or remove it,
 * which asks for the current password.
 */
function emailSection(a: Account): HTMLElement {
  const state = el('span', { className: 'muted' }, 'Checking…');
  const input = el('input', { type: 'email', id: 'account-email', placeholder: 'you@example.com', autocomplete: 'email', maxLength: EMAIL_MAX });
  const pass = el('input', { type: 'password', id: 'account-email-pass', placeholder: 'Current password', autocomplete: 'current-password', maxLength: 128 });
  const save = el('button', { type: 'submit' }, 'Save');
  const remove = el('button', { type: 'button', className: 'secondary' }, 'Remove');
  const msg = el('p', { className: 'status', role: 'status' });
  const form = el('form', { className: 'auth acct-email-form', noValidate: true }, input, pass, el('div', { className: 'row' }, save, remove), msg);
  const box = el('details', { className: 'acct-email', id: 'account-email-box' }, el('summary', {}, 'Password reset email: ', state), el('p', { className: 'muted' }, 'Optional. Only used to reset your password; never shown to anyone.'), form);
  const show = (email: string | null) => {
    state.textContent = email ?? 'none';
    state.className = email ? '' : 'muted';
    input.value = email ?? '';
    remove.hidden = !email;
    if (!email) { box.open = true; msg.textContent = 'Add an email to enable password reset.'; }
  };
  void fetchOwnEmail(a.token).then((e) => { if (e === undefined) state.textContent = 'unavailable'; else show(e); });
  const submit = async (email: string) => {
    const local = email ? emailError(email) : null;
    if (local) { msg.textContent = local; input.focus(); return; }
    if (!pass.value) { msg.textContent = 'Enter your current password to change the email.'; pass.focus(); return; }
    msg.textContent = 'Saving…';
    const r = await saveOwnEmail(a.token, email, pass.value);
    if ('error' in r) { msg.textContent = /wrong/i.test(r.error) ? 'Wrong password.' : r.error; return; }
    pass.value = '';
    show(r.email);
    msg.textContent = r.email ? 'Saved. Password reset links go to this address.' : 'Email removed. Add one again to enable password reset.';
  };
  form.onsubmit = (e) => { e.preventDefault(); void submit(input.value.trim()); };
  remove.onclick = () => void submit('');
  return box;
}

export function mountAccount(root: HTMLElement, onChange: (a: Account | null) => void): { current(): Account | null; expire(message: string): void; auth(kind: 'login' | 'register', name: string, password: string, email?: string): Promise<string | null> } {
  let account = loadAccount();
  /** Logs in or registers (from this sheet or the enlist plate); resolves to the server's error, or null once signed in. */
  const auth = async (kind: 'login' | 'register', name: string, password: string, email?: string): Promise<string | null> => {
    const guest = kind === 'register' ? pickGuestClaim(loadName()) : undefined;
    const r = await authenticate(kind, name, password, guest, email);
    if ('error' in r) {
      // A spent or refused claim is no use again: forget it, so the next try makes a fresh account.
      if (guest && r.guestInvalid) dropGuestClaim(guest);
      return r.error;
    }
    if (guest && r.carried) dropGuestClaim(guest);
    account = { token: r.token, name: r.name };
    saveAccount(account);
    onChange(account);
    showSignedIn(account);
    return null;
  };

  const showSignedIn = (a: Account) => {
    const stats = el('dl', { className: 'stats' }, el('dd', { className: 'muted' }, 'Loading stats…'));
    const out = el('button', { type: 'button', className: 'link' }, 'Log out');
    out.onclick = () => { account = null; saveAccount(null); onChange(null); showSignedOut(); };
    root.replaceChildren(el('h2', {}, 'Account'), el('p', {}, 'Signed in as ', el('b', {}, a.name), ' ', out), stats, emailSection(a));
    fetchStats(a.name).then((s) => {
      if (!s) { stats.replaceChildren(el('dd', { className: 'muted' }, 'No games yet.')); return; }
      const kd = s.deaths ? (s.kills / s.deaths).toFixed(2) : String(s.kills);
      const cells: [string, string | number][] = [['Kills', s.kills], ['Deaths', s.deaths], ['K/D', kd], ['Score', s.score], ['Games', s.games], ['Best', s.best]];
      stats.replaceChildren(...cells.map(([k, v]) => el('div', {}, el('dt', {}, k), el('dd', {}, String(v)))));
    }).catch(() => stats.replaceChildren(el('dd', { className: 'muted' }, 'Stats unavailable.')));
  };

  const showSignedOut = (notice = '') => {
    const name = el('input', { placeholder: 'Account name', autocomplete: 'username', maxLength: 16, required: true });
    const pass = el('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password', required: true });
    const msg = el('p', { className: 'status', role: 'status' }, notice);
    const login = el('button', { type: 'submit' }, 'Log in');
    const register = el('button', { type: 'button', className: 'secondary' }, 'Register');
    const form = el('form', { className: 'auth' }, name, pass, el('div', { className: 'row' }, login, register), msg);
    const submit = async (kind: 'login' | 'register') => {
      if (!form.reportValidity()) return;
      msg.textContent = kind === 'login' ? 'Logging in…' : 'Creating account…';
      const error = await auth(kind, name.value, pass.value);
      if (error) msg.textContent = error;
    };
    form.onsubmit = (e) => { e.preventDefault(); void submit('login'); };
    register.onclick = () => void submit('register');
    const forgot = el('button', { type: 'button', className: 'link', id: 'account-forgot' }, 'Forgot password?');
    forgot.onclick = () => showForgot(name.value.trim());
    root.replaceChildren(el('h2', {}, 'Account'), el('p', { className: 'muted' }, loadGuestClaims().length ? `Log in to keep stats across games. ${CARRY_LINE}` : 'Log in to keep stats across games.'), form, forgot);
  };

  /** Asks for a reset link with the account's name and its email; the server's answer is the same whether or not they matched. */
  const showForgot = (prefill: string) => {
    const name = el('input', { placeholder: 'Account name', autocomplete: 'username', maxLength: 16, required: true, value: prefill });
    const query = el('input', { type: 'email', placeholder: 'Email on the account', autocomplete: 'email', maxLength: EMAIL_MAX, required: true });
    const send = el('button', { type: 'submit' }, 'Send reset link');
    const back = el('button', { type: 'button', className: 'secondary' }, 'Back');
    const msg = el('p', { className: 'status', role: 'status' });
    const form = el('form', { className: 'auth' }, name, query, el('div', { className: 'row' }, send, back), msg);
    back.onclick = () => showSignedOut();
    form.onsubmit = async (e) => {
      e.preventDefault();
      if (!form.reportValidity()) return;
      const bad = emailError(query.value);
      if (bad) { msg.textContent = bad; query.focus(); return; }
      msg.textContent = 'Sending…';
      const r = await requestReset(name.value.trim(), query.value.trim());
      msg.textContent = 'error' in r ? r.error : r.message;
    };
    root.replaceChildren(el('h2', {}, 'Reset password'), el('p', { className: 'muted' }, `Enter the account name and the email on it; both must match. Accounts without an email can’t be reset. ${NO_EMAIL_LINE}`), form);
    (prefill ? query : name).focus();
  };

  if (account) showSignedIn(account);
  else showSignedOut();
  return {
    current: () => account,
    auth,
    expire(message) {
      account = null;
      saveAccount(null);
      onChange(null);
      showSignedOut(message);
    },
  };
}
