import { cleanName, NAME_MAX } from '../shared/protocol.ts';
import { EMAIL_MAX, emailError } from '../shared/email.ts';
import { requestReset } from './api.ts';

/**
 * The enlist plate: on the first menu screen a guest sees what an account keeps (medals, cosmetics, a reserved name, a place on the
 * board) and can make one inline, without leaving the mode cards. Signed in, it folds away to the name chip in the top bar. "Not
 * now" hides it for this visit (sessionStorage), so it comes back next time. In a match, the death card carries one quiet line
 * when a guest has something at stake: a lifetime medal, a level, or play the server is not recording at all.
 */
export type AuthKind = 'login' | 'register';
/** `forgot` asks for a password-reset link by email or name. */
export type FormMode = 'closed' | AuthKind | 'forgot';
/** What a guest stands to lose this visit, loudest first: nothing saved at all, then a lifetime medal, then a level. */
export type Stakes = { unrecorded: boolean; medal: boolean; level: boolean };
export const NO_STAKES: Stakes = { unrecorded: false, medal: false, level: false };

const DISMISS_KEY = 'skirmish.enlist.notNow';
const STAKES_KEY = 'skirmish.enlist.stakes';

/** The plate shows only to a guest who has not said "not now" this visit; an open form stays up whatever else changes. */
export function enlistVisible(signedIn: boolean, dismissed: boolean, form: FormMode = 'closed'): boolean {
  if (signedIn) return false;
  return form !== 'closed' || !dismissed;
}

/**
 * What registering does with a guest's progress: the guest profile this browser made comes into the new account, once
 * (`/api/register` with its claim token; logging in to an existing account never takes it). Every line below says the same.
 */
export const CARRY_LINE = 'Your stats and medals come with you.';

/** The plate's headline and line under it, sharpened when this guest has something at stake. */
export function enlistPitch(stakes: Stakes): { title: string; sub: string } {
  if (stakes.unrecorded) return { title: 'Your stats aren’t being saved', sub: 'Guest play from here isn’t recorded. A free account keeps every match.' };
  if (stakes.medal) return { title: 'Bank your medals', sub: 'Guest medals sit on a name anyone can take. Enlist and they come with you.' };
  if (stakes.level) return { title: 'Keep climbing', sub: 'Guest levels sit on a name anyone can take. Enlist and your level comes with you.' };
  return { title: 'Enlist', sub: 'Free, ten seconds. Or just pick a fight as a guest.' };
}

/** The line under "Create your account": a guest with progress on file is told it comes along. */
export function registerSub(hasGuestProgress: boolean): string {
  return hasGuestProgress ? `Pick the name you want to keep. ${CARRY_LINE}` : 'Pick the name you want to keep.';
}

/** The sign-up form's line under the email field: it is optional, and what it is for. */
export const EMAIL_HINT = 'Optional. Only used to reset your password.';
/** What the forgot-password form says under its headline. */
export const FORGOT_SUB = 'Enter your soldier name and the email on that account; both must match. An account with no email can’t be reset: add one in your account to enable password reset.';

/** The one line on the death card for a guest with something at stake, or null to stay quiet. */
export function guestNudge(signedIn: boolean, stakes: Stakes): string | null {
  if (signedIn) return null;
  if (stakes.unrecorded) return 'Guest stats aren’t being saved.';
  if (stakes.medal) return 'Enlist to keep your guest medals.';
  if (stakes.level) return 'Enlist to keep your guest level.';
  return null;
}

/** The server's own rule for account names and passwords (`parseCredentials`), checked before the round trip so the error says why. */
export function credentialError(name: string, password: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Pick a name for your soldier.';
  if (trimmed.length > NAME_MAX) return `Names are at most ${NAME_MAX} characters.`;
  if (cleanName(trimmed) !== trimmed) return 'Names use letters, digits, spaces, dots, dashes and underscores only.';
  if (trimmed.length < 3) return 'Names need at least 3 characters.';
  if (password.length < 4) return 'Passwords need at least 4 characters.';
  if (password.length > 128) return 'Passwords are at most 128 characters.';
  return null;
}

/** The server's reply in the plate's voice: a taken name says what to do about it. */
export function authErrorText(kind: AuthKind, error: string): string {
  if (kind === 'register' && /taken/i.test(error)) return 'That name is already enlisted. Pick another, or log in if it’s yours.';
  if (kind === 'login' && /wrong/i.test(error)) return 'Wrong name or password.';
  if (/reach/i.test(error)) return 'Couldn’t reach the server. Check your connection and try again.';
  return error;
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const session = (): Store | null => { try { return globalThis.sessionStorage ?? null; } catch { return null; } };

export function loadDismissed(store: Store | null = session()): boolean {
  try { return store?.getItem(DISMISS_KEY) === '1'; } catch { return false; }
}
export function saveDismissed(on: boolean, store: Store | null = session()) {
  try { if (on) store?.setItem(DISMISS_KEY, '1'); else store?.removeItem(DISMISS_KEY); } catch {}
}
export function loadStakes(store: Store | null = session()): Stakes {
  try {
    const v = JSON.parse(store?.getItem(STAKES_KEY) ?? 'null') as Partial<Stakes> | null;
    return v && typeof v === 'object' ? { unrecorded: v.unrecorded === true, medal: v.medal === true, level: v.level === true } : NO_STAKES;
  } catch { return NO_STAKES; }
}
export function saveStakes(s: Stakes, store: Store | null = session()) {
  try { store?.setItem(STAKES_KEY, JSON.stringify(s)); } catch {}
}

/** Whether a system chat line is the server's "your stats aren't being saved" notice (room.ts `UNRECORDED_NOTICE`). */
export const isUnrecordedNotice = (from: string, text: string) => from === '' && /aren.t being saved/i.test(text) && /register/i.test(text);

// ---- The plate itself.

const SVG = 'http://www.w3.org/2000/svg';
function svg(markup: string, cls: string, box = '0 0 24 24'): SVGSVGElement {
  const s = document.createElementNS(SVG, 'svg');
  s.setAttribute('viewBox', box);
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('class', cls);
  s.innerHTML = markup;
  return s;
}
const INK = '#1c1f26';
/** Chunky toy icons: ink outline, flat paint, one lit step (STYLE.md). */
const ICONS = {
  medal: `<path d="M7 2h4l2 7H9zM13 2h4l-2 7h-4z" fill="#ff5a1f" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="15.5" r="6" fill="#ffd34d" stroke="${INK}" stroke-width="2"/><path d="M12 12.4l1 2 2.2.3-1.6 1.5.4 2.2-2-1.1-2 1.1.4-2.2-1.6-1.5 2.2-.3z" fill="#b8860b"/>`,
  hat: `<path d="M4 15c0-5 3.6-8.5 8-8.5s8 3.5 8 8.5z" fill="#6c7356" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/><path d="M6.4 11.4c1.2-2.4 3.2-3.6 5.6-3.6" stroke="#8d9572" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M2 15h20v3.4H2z" fill="#4f5a3e" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/><circle cx="16.5" cy="11.5" r="1.6" fill="#ffd34d" stroke="${INK}" stroke-width="1.2"/>`,
  name: `<path d="M3 6.5h12.5l5.5 5.5-5.5 5.5H3z" fill="#cfc7b3" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/><circle cx="16" cy="12" r="1.6" fill="${INK}"/><path d="M6 10h6M6 14h4.5" stroke="${INK}" stroke-width="2" stroke-linecap="round"/>`,
  board: `<path d="M8.5 9h7v12h-7z" fill="#ffd34d" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/><path d="M2 11.5h6.5V21H2zM15.5 14H22v7h-6.5z" fill="#808a99" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/><path d="M12 1.2l1.3 2.6 2.8.4-2 2 .5 2.8-2.6-1.4-2.6 1.4.5-2.8-2-2 2.8-.4z" fill="#ffd34d" stroke="${INK}" stroke-width="1.3" stroke-linejoin="round"/><path d="M12 11v5.5" stroke="${INK}" stroke-width="2.2" stroke-linecap="round"/>`,
} as const;
export const BENEFITS: { icon: keyof typeof ICONS; text: string }[] = [
  { icon: 'medal', text: 'Keep your medals & career' },
  { icon: 'hat', text: 'Unlock hats, camo & badges' },
  { icon: 'name', text: 'Reserve your name' },
  { icon: 'board', text: 'Climb the leaderboard' },
];

/** A stamped steel dog tag on a ball chain: the plate's emblem. */
function dogTag(): SVGSVGElement {
  // The chain runs up from the tag's hole and off the top, two strands in a V.
  const beads = [-1, 1].flatMap((side) => [0, 1, 2, 3].map((i) => ({ x: 23 + side * (3 + i * 4.4), y: 11 - i * 3.2 }))).map(({ x, y }) => {
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.1" fill="#9aa3b0" stroke="${INK}" stroke-width="1.2"/>`;
  }).join('');
  return svg(`
    ${beads}
    <path d="M5 16a6 6 0 0 1 6-6h24a6 6 0 0 1 6 6v36a6 6 0 0 1-6 6H11a6 6 0 0 1-6-6z" fill="${INK}" transform="translate(3 4)" opacity="0.55"/>
    <path d="M5 16a6 6 0 0 1 6-6h24a6 6 0 0 1 6 6v36a6 6 0 0 1-6 6H11a6 6 0 0 1-6-6z" fill="#808a99" stroke="${INK}" stroke-width="2.5"/>
    <path d="M8 16a3 3 0 0 1 3-3h24a3 3 0 0 1 3 3v3H8z" fill="#a3acb8"/>
    <circle cx="23" cy="17" r="3" fill="${INK}"/>
    <path d="M12 26h22M12 33h16M12 40h20M12 47h12" stroke="#3d4450" stroke-width="3" stroke-linecap="round"/>
    <path d="M12 26h7" stroke="#ff5a1f" stroke-width="3" stroke-linecap="round"/>
  `, 'enlist-tag', '0 0 46 62');
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node: HTMLElementTagNameMap[K] = Object.assign(document.createElement(tag), props);
  node.append(...kids);
  return node;
}

type Deps = {
  /** Logs in or registers; resolves to an error message, or null once signed in. */
  auth(kind: AuthKind, name: string, password: string, email?: string): Promise<string | null>;
  /** The name typed on the gear step, to prefill the form. */
  suggestName?(): string;
  /** Where focus goes once the plate folds away (the first mode card). */
  afterSignIn?(): void;
  /** Whether this browser holds a guest profile's claim, so registering carries its progress over. */
  hasGuestProgress?(): boolean;
};

export function mountEnlist(root: HTMLElement, deps: Deps) {
  let signedIn = false;
  let dismissed = loadDismissed();
  let stakes = loadStakes();
  let form: FormMode = 'closed';
  let busy = false;

  const title = el('h3', { className: 'enlist-title', id: 'enlist-title' });
  const sub = el('p', { className: 'enlist-sub' });
  root.setAttribute('aria-labelledby', 'enlist-title');
  const head = el('div', { className: 'enlist-head' }, title, sub);

  const perks = el('ul', { className: 'enlist-perks' }, ...BENEFITS.map((b) => el('li', {}, svg(ICONS[b.icon], 'enlist-icon'), el('span', {}, b.text))));

  const create = el('button', { type: 'button', id: 'enlist-create', className: 'enlist-go' }, 'Create account');
  const login = el('button', { type: 'button', id: 'enlist-login', className: 'link enlist-alt' }, 'I have one · Log in');
  const actions = el('div', { className: 'enlist-actions' }, create, login);

  const notNow = el('button', { type: 'button', id: 'enlist-dismiss', className: 'link enlist-x', title: 'Hide until your next visit' }, 'Not now');

  // The inline form: one plate, name and password, and one way to flip between making an account and logging in.
  const nameIn = el('input', { id: 'enlist-name', maxLength: NAME_MAX, autocomplete: 'username', spellcheck: false, placeholder: '3–16 letters or digits' });
  const passIn = el('input', { id: 'enlist-pass', type: 'password', maxLength: 128, placeholder: '4+ characters' });
  const submit = el('button', { type: 'submit', id: 'enlist-submit', className: 'enlist-go' });
  const flip = el('button', { type: 'button', id: 'enlist-flip', className: 'link enlist-alt' });
  const cancel = el('button', { type: 'button', id: 'enlist-cancel', className: 'link enlist-x' }, 'Cancel');
  const msg = el('p', { className: 'enlist-msg', id: 'enlist-msg', role: 'alert' });
  const emailIn = el('input', { id: 'enlist-email', type: 'email', maxLength: EMAIL_MAX, autocomplete: 'email', spellcheck: false, placeholder: 'you@example.com · optional' });
  const forgotIn = el('input', { id: 'enlist-forgot-email', type: 'email', maxLength: EMAIL_MAX, autocomplete: 'email', spellcheck: false, placeholder: 'you@example.com' });
  const forgot = el('button', { type: 'button', id: 'enlist-forgot', className: 'link enlist-alt' }, 'Forgot password?');
  const passLabel = el('span', {}, 'Password');
  const nameField = el('label', { className: 'enlist-field' }, el('span', {}, 'Soldier name'), nameIn);
  const passField = el('label', { className: 'enlist-field' }, passLabel, passIn);
  const emailField = el('label', { className: 'enlist-field enlist-email' }, el('span', {}, 'Email ', el('small', { className: 'enlist-hint', id: 'enlist-email-hint' }, EMAIL_HINT)), emailIn);
  emailIn.setAttribute('aria-describedby', 'enlist-email-hint');
  const forgotField = el('label', { className: 'enlist-field' }, el('span', {}, 'Email on the account'), forgotIn);
  const fields = el('div', { className: 'enlist-fields' });
  const foot = el('div', { className: 'enlist-form-foot' }, flip, msg);
  const formEl = el('form', { className: 'enlist-form', noValidate: true }, fields, foot);

  const body = el('div', { className: 'enlist-body' });
  root.replaceChildren(el('div', { className: 'enlist-plate' }, dogTag(), head, body, notNow));

  const render = () => {
    root.hidden = !enlistVisible(signedIn, dismissed, form);
    root.dataset.form = form;
    if (form === 'closed') {
      const p = enlistPitch(stakes);
      title.textContent = p.title;
      sub.textContent = p.sub;
      root.classList.toggle('stakes', stakes.unrecorded || stakes.medal || stakes.level);
      if (body.firstChild !== perks) body.replaceChildren(perks, actions);
      notNow.hidden = false;
      cancel.remove();
      return;
    }
    title.textContent = form === 'register' ? 'Create your account' : form === 'forgot' ? 'Reset your password' : 'Welcome back';
    sub.textContent = form === 'register' ? registerSub(deps.hasGuestProgress?.() ?? false) : form === 'forgot' ? FORGOT_SUB : 'Log in to pick up your record and your gear.';
    submit.textContent = form === 'register' ? 'Enlist' : form === 'forgot' ? 'Send link' : 'Log in';
    flip.textContent = form === 'register' ? 'Already enlisted? Log in' : form === 'forgot' ? 'Back to log in' : 'New here? Create an account';
    const want = form === 'register' ? [nameField, passField, emailField, submit] : form === 'forgot' ? [nameField, forgotField, submit] : [nameField, passField, submit];
    if (want.some((f, i) => fields.children[i] !== f) || fields.children.length !== want.length) fields.replaceChildren(...want);
    if (form === 'login') { if (!forgot.isConnected) flip.after(forgot); } else forgot.remove();
    passIn.autocomplete = form === 'register' ? 'new-password' : 'current-password';
    passIn.placeholder = form === 'register' ? '4+ characters' : '';
    nameIn.placeholder = form === 'register' ? '3–16 letters or digits' : '';
    if (body.firstChild !== formEl) body.replaceChildren(formEl);
    notNow.hidden = true;
    if (!cancel.isConnected) notNow.after(cancel);
  };

  const setError = (text: string, field?: HTMLInputElement) => {
    msg.textContent = text;
    msg.classList.toggle('error', !!text);
    for (const f of [nameIn, passIn, emailIn, forgotIn]) f.toggleAttribute('aria-invalid', f === field);
    if (field) field.focus();
  };

  const open = (mode: AuthKind | 'forgot', focus = true) => {
    form = mode;
    setError('');
    if (!nameIn.value) nameIn.value = (deps.suggestName?.() ?? '').trim();
    render();
    if (focus) requestAnimationFrame(() => (mode === 'forgot' ? (nameIn.value ? forgotIn : nameIn) : nameIn.value ? passIn : nameIn).focus({ preventScroll: true }));
  };
  const close = (focusOn: HTMLElement = create) => {
    form = 'closed';
    render();
    requestAnimationFrame(() => focusOn.isConnected && focusOn.focus({ preventScroll: true }));
  };

  create.onclick = () => open('register');
  login.onclick = () => open('login');
  flip.onclick = () => { const to = form === 'login' ? 'register' : 'login'; open(to, false); (nameIn.value ? passIn : nameIn).focus(); };
  forgot.onclick = () => open('forgot');
  cancel.onclick = () => close();
  notNow.onclick = () => { dismissed = true; saveDismissed(true); render(); deps.afterSignIn?.(); };
  formEl.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } });
  for (const f of [nameIn, passIn, emailIn, forgotIn]) f.addEventListener('input', () => { if (f.hasAttribute('aria-invalid')) setError(''); });

  formEl.onsubmit = async (e) => {
    e.preventDefault();
    if (busy || form === 'closed') return;
    if (form === 'forgot') {
      if (!nameIn.value.trim()) { setError('Enter your soldier name.', nameIn); return; }
      const bad = forgotIn.value.trim() ? emailError(forgotIn.value) : 'Enter the email on your account.';
      if (bad) { setError(bad, forgotIn); return; }
      busy = true;
      submit.disabled = true;
      msg.classList.remove('error');
      msg.textContent = 'Sending…';
      const r = await requestReset(nameIn.value.trim(), forgotIn.value.trim());
      busy = false;
      submit.disabled = false;
      if ('error' in r) setError(authErrorText('login', r.error), forgotIn);
      else { setError(''); msg.textContent = r.message; }
      return;
    }
    const kind = form;
    const local = credentialError(nameIn.value, passIn.value) ?? (kind === 'register' ? emailError(emailIn.value) : null);
    if (local) { setError(local, /^Pass/.test(local) ? passIn : /email/i.test(local) ? emailIn : nameIn); return; }
    busy = true;
    submit.disabled = true;
    msg.classList.remove('error');
    msg.textContent = kind === 'register' ? 'Enlisting…' : 'Logging in…';
    const err = await deps.auth(kind, nameIn.value.trim(), passIn.value, kind === 'register' ? emailIn.value.trim() || undefined : undefined);
    busy = false;
    submit.disabled = false;
    if (err) { setError(authErrorText(kind, err), /password/i.test(err) && kind === 'login' ? passIn : /email/i.test(err) ? emailIn : nameIn); return; }
    passIn.value = '';
    emailIn.value = '';
    setError('');
    form = 'closed';
    // `sync(true)` from the account change has already folded the plate away.
    render();
    deps.afterSignIn?.();
  };

  render();
  return {
    /** Follows who is signed in: an account folds the plate away (the name chip in the top bar takes over). */
    sync(isIn: boolean) { signedIn = isIn; if (isIn) form = 'closed'; render(); },
    /** Opens the form (from the death card's nudge, or a deep link), bringing a dismissed plate back. */
    open(mode: AuthKind = 'register') { dismissed = false; saveDismissed(false); open(mode); root.scrollIntoView?.({ block: 'nearest' }); },
    /** Notes what a guest stands to lose, for the headline here and the death card's line. */
    note(more: Partial<Stakes>) {
      const next = { ...stakes, ...more };
      if (next.unrecorded === stakes.unrecorded && next.medal === stakes.medal && next.level === stakes.level) return;
      stakes = next;
      saveStakes(stakes);
      render();
    },
    stakes: () => stakes,
    get form() { return form; },
  };
}
export type Enlist = ReturnType<typeof mountEnlist>;
