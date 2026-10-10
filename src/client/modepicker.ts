import { MODE_INFO, type SceneId } from './modecards.ts';

/**
 * The menu's mode picker: one compact card with a styled dropdown (a button and a listbox, not a native select), the picked mode's
 * pitch, and Next, which goes on to the loadout step with that mode (the loadout step's Deploy joins the match). The range has no
 * loadout step, so its Next opens the range at once. The last mode picked is remembered on this device.
 */
export type ModeRoom = { id: string; mode: string; players: number; humans?: number };
export type ModeOption = {
  mode: SceneId;
  /** The short code on its chip: FFA, TDM, DOM, BR, ZOM or RANGE. */
  tag: string;
  name: string;
  pitch: string;
  /** Who is in, short, for the pill: "18 playing", "Up to 4", "Just you". */
  live: string;
  /** Who is in, in full, for the line under the picker and the gear step. */
  detail: string;
};

const STORE_KEY = 'tinwar.mode';
const isScene = (m: string): m is SceneId => m in MODE_INFO;

/** The dropdown's options: the public rooms in the server's order (with how many are in), then the fights that are not public rooms, a private Zombies squad and a private range. */
export function modeOptions(rooms: readonly ModeRoom[] | null, squad: string | null = null): ModeOption[] {
  const out: ModeOption[] = [];
  for (const r of rooms ?? []) {
    if (!isScene(r.mode) || out.some((o) => o.mode === r.mode)) continue;
    const detail = `${r.players} ${r.players === 1 ? 'player' : 'players'}${r.humans ? ` · ${r.humans} human` : ''}`;
    out.push({ mode: r.mode, tag: r.mode, name: MODE_INFO[r.mode].name, pitch: MODE_INFO[r.mode].pitch, live: `${r.players} playing`, detail });
  }
  out.push({ mode: 'ZOM', tag: 'ZOM', name: 'Zombies squad', pitch: MODE_INFO.ZOM.pitch, live: squad ? `Squad ${squad}` : 'Up to 4', detail: squad ? `Squad ${squad}` : 'Up to 4 players' });
  out.push({ mode: 'RNG', tag: 'RANGE', name: MODE_INFO.RNG.name, pitch: MODE_INFO.RNG.pitch, live: 'Just you', detail: 'Private · just you' });
  return out;
}

/** What the card's main button says: the range opens at once, every other fight goes on to its loadout. */
export const nextLabel = (mode: SceneId | null) => (mode === 'RNG' ? 'Open the range' : 'Next: Loadout');

/** Which mode shows: the one already picked (this visit, a deep link or a card chosen), else the one remembered, else the first offered. */
export function pickMode(options: readonly ModeOption[], current: string | null, saved: string | null): SceneId | null {
  for (const want of [current, saved]) if (want && options.some((o) => o.mode === want)) return want as SceneId;
  return options[0]?.mode ?? null;
}

export function loadModePick(store: Pick<Storage, 'getItem'> | null = safeStore()): string | null {
  try { return store?.getItem(STORE_KEY) ?? null; } catch { return null; }
}
export function saveModePick(mode: string, store: Pick<Storage, 'setItem'> | null = safeStore()) {
  try { store?.setItem(STORE_KEY, mode); } catch { /* private mode or storage off: the pick lasts this visit only */ }
}
function safeStore(): Storage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

// ---- The listbox's keyboard, as a pure step (the DOM below only applies what it returns). ----

/** The dropdown's state: open or not, the option the keyboard is on, the option chosen, and the type-ahead buffer. */
export type ListState = { open: boolean; active: number; selected: number; typed: string; typedAt: number };
/** What a key did: the next state, an option to choose (`commit`), where focus goes, and whether the key was used (prevent default). */
export type ListStep = { state: ListState; commit?: number; focus?: 'trigger' | 'list'; handled: boolean };

/** How long a pause ends a type-ahead word, in ms. */
export const TYPE_AHEAD_MS = 600;

/** The option a typed word lands on: names first, then chip codes; one letter pressed again cycles through the names that start with it. */
export function typeAhead(names: readonly string[], tags: readonly string[], from: number, typed: string): number {
  const q = typed.toLowerCase();
  const n = names.length;
  if (!q || !n) return -1;
  const cycle = q.length > 1 && [...q].every((c) => c === q[0]);
  const word = cycle ? q[0]! : q;
  const start = cycle || q.length === 1 ? from + 1 : from;
  for (const list of [names, tags]) {
    for (let k = 0; k < n; k++) {
      const i = (start + k) % n;
      if (list[i]!.toLowerCase().startsWith(word)) return i;
    }
  }
  return -1;
}

/**
 * One key on the dropdown. Closed, on the button: arrows, Enter, Space, Home and End open it (on the chosen option, or the first or
 * last), and typing opens it on the match. Open, on the list: arrows, Home and End move, typing jumps, Enter or Space chooses and
 * closes, Esc closes without choosing, and Tab chooses and lets focus move on.
 */
export function listboxKey(s: ListState, key: string, names: readonly string[], tags: readonly string[], now: number): ListStep {
  const n = names.length;
  if (!n) return { state: s, handled: false };
  const last = n - 1;
  const printable = key.length === 1 && key !== ' ';
  const typing = (base: ListState): ListStep => {
    const buf = (now - base.typedAt < TYPE_AHEAD_MS ? base.typed : '') + key;
    const at = typeAhead(names, tags, base.active, buf);
    return { state: { ...base, open: true, active: at < 0 ? base.active : at, typed: buf, typedAt: now }, focus: base.open ? undefined : 'list', handled: true };
  };
  if (!s.open) {
    const open = (active: number): ListStep => ({ state: { ...s, open: true, active, typed: '', typedAt: 0 }, focus: 'list', handled: true });
    switch (key) {
      case 'ArrowDown': case 'ArrowUp': case 'Enter': case ' ': return open(s.selected);
      case 'Home': return open(0);
      case 'End': return open(last);
    }
    return printable ? typing({ ...s, active: s.selected }) : { state: s, handled: false };
  }
  const move = (active: number): ListStep => ({ state: { ...s, active: Math.max(0, Math.min(last, active)) }, handled: true });
  const close = (commit?: number): ListState => ({ ...s, open: false, typed: '', typedAt: 0, selected: commit ?? s.selected, active: commit ?? s.selected });
  switch (key) {
    case 'ArrowDown': return move(s.active + 1);
    case 'ArrowUp': return move(s.active - 1);
    case 'Home': case 'PageUp': return move(0);
    case 'End': case 'PageDown': return move(last);
    case 'Enter': return { state: close(s.active), commit: s.active, focus: 'trigger', handled: true };
    case ' ':
      // A space inside a type-ahead word is part of the word ("last standing"); otherwise it chooses.
      if (s.typed && now - s.typedAt < TYPE_AHEAD_MS) return typing(s);
      return { state: close(s.active), commit: s.active, focus: 'trigger', handled: true };
    case 'Escape': return { state: close(), focus: 'trigger', handled: true };
    case 'Tab': return { state: close(s.active), commit: s.active, handled: false };
  }
  return printable ? typing(s) : { state: s, handled: false };
}

/** The ARIA a state puts on the button and the list. */
export function listboxAria(s: ListState, ids: readonly string[]) {
  return {
    trigger: { 'aria-expanded': String(s.open) },
    list: { 'aria-activedescendant': s.open ? ids[s.active] ?? '' : '' },
    options: ids.map((_, i) => ({ 'aria-selected': String(i === s.selected), active: s.open && i === s.active })),
  };
}

export type ModePickerDeps = {
  /** Goes on with `mode`: to the loadout step, or straight into the range. */
  next(mode: SceneId): void;
};

const optId = (mode: SceneId) => `mode-opt-${mode.toLowerCase()}`;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, ...kids: (Node | string)[]) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  n.append(...kids);
  return n;
};

/** A mode's chip, name and pill, the same on the button and in every option. */
function modeRow(o: ModeOption, withPitch: boolean): Node[] {
  const pill = el('span', 'mdd-live', el('i', ''), o.live);
  const name = el('span', 'mdd-name', o.name);
  const text = withPitch ? el('span', 'mdd-text', name, el('span', 'mdd-pitch', o.pitch)) : el('span', 'mdd-text', name);
  return [el('span', `mode mode-${o.mode.toLowerCase()}`, o.tag), text, pill];
}

/**
 * Wires the dropdown (`#mode-trigger` and `#mode-list`), the pitch line (`#mode-detail`) and Next (`#mode-next`) to the cards in
 * `grid`: every card's wrapper gets `data-mode`, and only the picked one's extras show (a squad's invite link).
 */
export function mountModePicker(grid: HTMLElement, deps: ModePickerDeps) {
  const trigger = document.getElementById('mode-trigger') as HTMLButtonElement;
  const list = document.getElementById('mode-list') as HTMLUListElement;
  const nextBtn = document.getElementById('mode-next') as HTMLButtonElement;
  const nextText = nextBtn.querySelector<HTMLElement>('.mode-next-label') ?? nextBtn;
  const detail = document.getElementById('mode-detail') as HTMLElement;
  const card = trigger.closest<HTMLElement>('.mode-pick') ?? trigger.parentElement!;
  let options: ModeOption[] = [];
  let picked: SceneId | null = null;
  let st: ListState = { open: false, active: 0, selected: 0, typed: '', typedAt: 0 };

  const index = (mode: SceneId | null) => Math.max(0, options.findIndex((o) => o.mode === mode));
  const names = () => options.map((o) => o.name);
  const tags = () => options.map((o) => o.tag);

  /**
   * Puts the list below the button, else above it, wherever it fits whole; when neither does (a short screen, a phone on its side)
   * it opens beside the card, over the empty scene, its foot level with the card's. Its height is capped to the room it has.
   */
  const place = () => {
    const r = trigger.getBoundingClientRect(), c = card.getBoundingClientRect();
    const zoom = trigger.offsetHeight ? r.height / trigger.offsetHeight : 1;
    list.style.maxHeight = '';
    list.dataset.place = 'down';
    const want = list.scrollHeight * zoom + 12;
    const below = innerHeight - r.bottom - 10, above = r.top - 10, side = c.bottom - 8, right = innerWidth - c.right;
    const where = want <= below ? 'down' : want <= above ? 'up' : right >= 340 * zoom && side > Math.max(above, below) ? 'side' : above > below ? 'up' : 'down';
    list.dataset.place = where;
    list.style.maxHeight = `${Math.floor((where === 'down' ? below : where === 'up' ? above : side) / zoom)}px`;
  };

  const apply = (focus?: 'trigger' | 'list') => {
    const ids = options.map((o) => optId(o.mode));
    const aria = listboxAria(st, ids);
    trigger.setAttribute('aria-expanded', aria.trigger['aria-expanded']);
    const wasOpen = !list.hidden;
    list.hidden = !st.open;
    card.classList.toggle('mdd-open', st.open);
    if (aria.list['aria-activedescendant']) list.setAttribute('aria-activedescendant', aria.list['aria-activedescendant']);
    else list.removeAttribute('aria-activedescendant');
    [...list.children].forEach((li, i) => {
      const a = aria.options[i];
      if (!a) return;
      li.setAttribute('aria-selected', a['aria-selected']);
      li.classList.toggle('active', a.active);
    });
    if (st.open) {
      if (!wasOpen) place();
      list.children[st.active]?.scrollIntoView({ block: 'nearest' });
    }
    if (focus === 'list') list.focus({ preventScroll: true });
    if (focus === 'trigger') trigger.focus({ preventScroll: true });
    if (st.open && !wasOpen) document.addEventListener('pointerdown', outside, true);
    if (!st.open && wasOpen) document.removeEventListener('pointerdown', outside, true);
  };
  const outside = (e: PointerEvent) => {
    const t = e.target as Node;
    if (trigger.contains(t) || list.contains(t)) return;
    st = { ...st, open: false, active: st.selected, typed: '' };
    apply();
  };

  const paint = () => {
    grid.classList.add('picking');
    grid.dataset.pick = picked ?? '';
    for (const wrap of grid.querySelectorAll<HTMLElement>('.mc-wrap')) {
      const room = wrap.querySelector<HTMLElement>('.server[data-room]');
      if (wrap.querySelector('#squad')) wrap.dataset.mode = 'ZOM';
      else if (wrap.querySelector('#range-card')) wrap.dataset.mode = 'RNG';
      else if (room) wrap.dataset.mode = room.querySelector('.mode')?.textContent ?? '';
      wrap.classList.toggle('mc-off', wrap.dataset.mode !== picked);
    }
    const opt = options.find((o) => o.mode === picked);
    trigger.replaceChildren(...(opt ? modeRow(opt, false) : [el('span', 'mdd-text', el('span', 'mdd-name', 'Loading fights…'))]), el('span', 'mdd-caret'));
    detail.textContent = opt ? opt.pitch : '';
    nextText.textContent = nextLabel(picked);
    nextBtn.disabled = !picked;
    st = { ...st, selected: index(picked), active: st.open ? st.active : index(picked) };
    apply();
  };

  const choose = (mode: SceneId, remember = true) => {
    picked = mode;
    if (remember) saveModePick(mode);
    paint();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.altKey && e.key === 'ArrowUp' && st.open) { e.preventDefault(); e.stopPropagation(); st = { ...st, open: false }; apply('trigger'); return; }
    if (e.metaKey || e.ctrlKey) return;
    const step = listboxKey(st, e.key, names(), tags(), performance.now());
    if (!step.handled && step.commit === undefined) return;
    if (step.handled) { e.preventDefault(); e.stopPropagation(); }
    st = step.state;
    if (step.commit !== undefined && options[step.commit]) choose(options[step.commit]!.mode);
    apply(step.focus);
  };
  trigger.addEventListener('keydown', onKey);
  list.addEventListener('keydown', onKey);
  trigger.addEventListener('click', () => {
    st = st.open ? { ...st, open: false, active: st.selected } : { ...st, open: true, active: st.selected, typed: '' };
    apply(st.open ? 'list' : 'trigger');
  });
  list.addEventListener('pointermove', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('[role="option"]');
    const i = li ? [...list.children].indexOf(li) : -1;
    if (i >= 0 && i !== st.active && e.pointerType === 'mouse') { st = { ...st, active: i }; apply(); }
  });
  list.addEventListener('click', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('[role="option"]');
    const i = li ? [...list.children].indexOf(li) : -1;
    if (i < 0 || !options[i]) return;
    st = { ...st, open: false, selected: i, active: i, typed: '' };
    choose(options[i]!.mode);
    apply('trigger');
  });
  // Focus leaving the open list (a click elsewhere, Tab handled above) closes it.
  list.addEventListener('focusout', (e) => {
    const to = e.relatedTarget as Node | null;
    if (st.open && to && !list.contains(to) && to !== trigger) { st = { ...st, open: false, active: st.selected }; apply(); }
  });
  addEventListener('resize', () => { if (st.open) place(); });
  nextBtn.addEventListener('click', () => { if (picked) deps.next(picked); });

  return {
    get mode() { return picked; },
    get open() { return st.open; },
    /** The rooms changed (a poll) or a card was rendered: refresh the options' live counts and which card shows. */
    sync(rooms: readonly ModeRoom[] | null, squad: string | null) {
      options = modeOptions(rooms, squad);
      const key = options.map((o) => o.mode).join('|');
      if (list.dataset.key !== key) {
        list.dataset.key = key;
        list.replaceChildren(...options.map((o) => {
          const li = el('li', 'mdd-opt', ...modeRow(o, true));
          li.id = optId(o.mode);
          li.setAttribute('role', 'option');
          return li;
        }));
      } else {
        // Only the counts moved: retitle in place, so an open list stays open and keeps its place.
        options.forEach((o, i) => { const pill = list.children[i]?.querySelector('.mdd-live'); if (pill && pill.lastChild?.textContent !== o.live) pill.replaceChildren(el('i', ''), o.live); });
      }
      picked = pickMode(options, picked, loadModePick());
      paint();
    },
    select: (mode: SceneId) => choose(mode),
  };
}
export type ModePicker = ReturnType<typeof mountModePicker>;
