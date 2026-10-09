import { MODE_INFO, type SceneId } from './modecards.ts';

/**
 * The menu's mode picker: one dropdown in place of a wall of cards. Choosing a mode shows just that mode's info (its name,
 * one-line pitch, who is in, and its own controls: the squad invite for Zombies, the range's opener), and Play deploys into it with
 * the loadout you last picked; Gear up goes to the loadout step first. The last mode picked is remembered on this device.
 */
export type ModeRoom = { id: string; mode: string; players: number; humans?: number };
export type ModeOption = { mode: SceneId; label: string; detail: string };

const STORE_KEY = 'tinwar.mode';
/** The fights that are not public rooms: a private squad and a private range. */
const EXTRA: readonly SceneId[] = ['ZOM', 'RNG'];

const isScene = (m: string): m is SceneId => m in MODE_INFO;

/** The dropdown's options: the public rooms in the server's order (with how many are in), then Zombies and the range; `detail` goes under it. */
export function modeOptions(rooms: readonly ModeRoom[] | null, squad: string | null = null): ModeOption[] {
  const out: ModeOption[] = [];
  for (const r of rooms ?? []) {
    if (!isScene(r.mode) || out.some((o) => o.mode === r.mode)) continue;
    const detail = `${r.players} ${r.players === 1 ? 'player' : 'players'}${r.humans ? ` · ${r.humans} human` : ''}`;
    out.push({ mode: r.mode, label: `${MODE_INFO[r.mode].name} · ${r.players}`, detail });
  }
  for (const m of EXTRA) {
    const detail = m === 'ZOM' ? (squad ? `Squad ${squad}` : 'Up to 4 players') : 'Private · just you';
    out.push({ mode: m, label: m === 'ZOM' ? 'Zombies squad' : MODE_INFO[m].name, detail });
  }
  return out;
}

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

export type ModePickerDeps = {
  /** Deploys into `mode` at once (Play). */
  play(mode: SceneId): void;
  /** Goes on to the loadout step for `mode` (Gear up). */
  gear(mode: SceneId): void;
};

/**
 * Wires the dropdown (`#mode-select`), Play (`#mode-play`) and Gear up (`#mode-gear`) to the cards in `grid`: every card's wrapper
 * gets `data-mode`, and only the picked one shows.
 */
export function mountModePicker(grid: HTMLElement, deps: ModePickerDeps) {
  const select = document.getElementById('mode-select') as HTMLSelectElement;
  const playBtn = document.getElementById('mode-play') as HTMLButtonElement;
  const gearBtn = document.getElementById('mode-gear') as HTMLButtonElement;
  const detail = document.getElementById('mode-detail') as HTMLElement;
  let options: ModeOption[] = [];
  let picked: SceneId | null = null;

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
    if (picked && select.value !== picked) select.value = picked;
    const opt = options.find((o) => o.mode === picked);
    detail.textContent = opt ? opt.detail : '';
    playBtn.disabled = !picked;
    // The range has no loadout step: its own panel picks the gun once you are in.
    gearBtn.hidden = picked === 'RNG';
  };

  const choose = (mode: SceneId, remember = true) => {
    picked = mode;
    if (remember) saveModePick(mode);
    paint();
  };

  select.addEventListener('change', () => { if (isScene(select.value)) choose(select.value); });
  playBtn.addEventListener('click', () => { if (picked) deps.play(picked); });
  gearBtn.addEventListener('click', () => { if (picked) deps.gear(picked); });

  return {
    get mode() { return picked; },
    /** The rooms changed (a poll) or a card was rendered: refresh the options' live counts and which card shows. */
    sync(rooms: readonly ModeRoom[] | null, squad: string | null) {
      options = modeOptions(rooms, squad);
      const key = options.map((o) => o.mode).join('|');
      if (select.dataset.key !== key) {
        select.dataset.key = key;
        select.replaceChildren(...options.map((o) => Object.assign(document.createElement('option'), { value: o.mode, textContent: o.label })));
      } else {
        // Only the counts moved: retitle in place, so an open dropdown stays open.
        options.forEach((o, i) => { const el = select.options[i]; if (el && el.textContent !== o.label) el.textContent = o.label; });
      }
      picked = pickMode(options, picked, loadModePick());
      paint();
    },
    select: (mode: SceneId) => choose(mode),
  };
}
export type ModePicker = ReturnType<typeof mountModePicker>;
