import type { createAudio } from './audio.ts';
import { CONTROLS, TOUCH_NOTES } from './input.ts';
import { getMusicVolume, isMusicMuted, musicGainNow, setMusicVolume, setSoundMuted, toggleMusicMuted } from './music.ts';
import { allCredits, MARCH_CREDIT } from './musicstream.ts';
import { chatterOn, setChatterOn } from './chatter.ts';
import { copyText } from './menu.ts';
import { padIntent, type PadSample } from './pausegate.ts';
import { fxCapable, fxState, lightingStatus } from './postfx.ts';
import { CRITTER_STEPS, DPR_STEPS, PRESET_IDS, PRESET_INFO, knobs, type Adv } from './quality.ts';
import { effectivePreset, qualityState } from './qualityrt.ts';
import {
  CROSSHAIR_COLORS, CROSSHAIR_IDS, LOOK_AHEAD_IDS, SHAKE_IDS, MOTION_IDS, UI_PERCENT, gainOfPercent, percentOfGain, resetSettings, setSetting, settings,
  type CrosshairColor, type CrosshairStyle, type EffectsQuality, type LookAheadMode, type MotionMode, type ShakeMode,
} from './settings.ts';

/**
 * The in-game pause and settings overlay. The match cannot stop for everyone else, so this is a plate over a dimmed, blurred
 * world: while it is open your soldier takes no input (main.ts releases every key and the input tick sends nothing), and a "match
 * is live" note says so. Field-kit plates as in the menu (public/menu.css) and styled by public/pause.css; it scales with `--ui`.
 */

type Audio = ReturnType<typeof createAudio>;

export type PauseInfo = {
  /** The shooting range is a private room for one: nobody else is affected. */
  range: boolean;
  dead: boolean;
  /** The squad invite link, in a squad (Zombies) match. */
  invite: string | null;
  modeName: string;
};

export type PauseDeps = {
  audio: Audio;
  /** What the match is, or null when there is no match to pause. */
  info(): PauseInfo | null;
  /** Leaves the match for the mode select. */
  leave(): void;
  /** A short effect heard at the current effects volume (the preview while a slider is dragged). */
  blip(): void;
  /** The menu opened or closed: release held keys and sticks, close what shares the screen. */
  onToggle(open: boolean): void;
};

type Tab = 'home' | 'settings' | 'controls';
const TABS: readonly [Tab, string][] = [['home', 'Pause'], ['settings', 'Settings'], ['controls', 'Controls']];

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', ...kids: (Node | string | null)[]): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  node.append(...kids.filter((k): k is Node | string => k !== null));
  return node;
};

/** A button that never keeps focus from a mouse press, so a Space pressed for the ability later is not swallowed by it. */
const plate = (cls: string, ...kids: (Node | string)[]): HTMLButtonElement => {
  const b = h('button', cls, ...kids);
  b.type = 'button';
  b.addEventListener('mousedown', (e) => e.preventDefault());
  return b;
};

let uid = 0;

const link = (href: string, text: string) => { const a = h('a', '', text); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a; };

/** The soundtrack's credits, as each recording's licence asks: title, artist, source, licence and what was changed. */
function musicCredits(): HTMLElement {
  const items = allCredits().map((c) => h('li', 'pz-credit',
    h('strong', '', `"${c.title}"`), ` by ${c.artist}. `, link(c.source, 'Source'), ' · ', link(c.licenceUrl, `Licensed under ${c.licence}`), `. ${c.changes}.`));
  const box = h('details', 'pz-credits', h('summary', 'pz-h', 'Music credits'),
    h('p', '', `${MARCH_CREDIT}. Recordings:`), h('ul', '', ...items),
    h('p', '', 'Full list: ', link('music/tracks/CREDITS.md', 'music/tracks/CREDITS.md')));
  box.id = 'music-credits';
  return box;
}

export function createPauseMenu(hud: HTMLElement, deps: PauseDeps) {
  const { audio } = deps;
  let isOpen = false;
  let confirming = false;
  let tab: Tab = 'home';
  let blipAt = 0;

  // ---- the cog in the HUD corner (also the phone's pause button) ----
  const cog = plate('pause-cog');
  cog.id = 'pause-cog';
  cog.setAttribute('aria-label', 'Pause menu');
  cog.title = 'Pause menu (Esc)';
  cog.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="${gearPath()}" fill="currentColor" stroke="#1c1f26" stroke-width="1.6" stroke-linejoin="round" fill-rule="evenodd"/></svg>`;
  cog.addEventListener('click', () => (isOpen ? close() : open()));
  hud.append(cog);

  // ---- the overlay ----
  const root = h('div', 'pause');
  root.id = 'pause';
  root.hidden = true;
  const titleId = `pz-title-${++uid}`;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-labelledby', titleId);
  const dim = h('div', 'pause-dim');
  dim.addEventListener('mousedown', (e) => e.preventDefault());
  const wrap = h('div', 'pause-wrap');
  const card = h('section', 'pz-card');
  wrap.append(card);
  root.append(dim, wrap);

  const title = h('h2', 'pz-title', 'Paused');
  title.id = titleId;
  const live = h('span', 'pz-live', h('i', 'pz-dot'), 'Match is live');
  const note = h('p', 'pz-note');
  const closeBtn = plate('pz-x', 'Resume', h('kbd', '', 'Esc'));
  closeBtn.setAttribute('aria-label', 'Resume the match');
  closeBtn.addEventListener('click', () => close());
  const head = h('header', 'pz-head', h('div', 'pz-headline', title, live), closeBtn, note);

  const tabBar = h('div', 'pz-tabs');
  tabBar.setAttribute('role', 'tablist');
  const tabBtns = new Map<Tab, HTMLButtonElement>();
  const panels = new Map<Tab, HTMLElement>();
  for (const [id, label] of TABS) {
    const b = plate('pz-tab', label);
    b.id = `pz-tab-${id}`;
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-controls', `pz-panel-${id}`);
    b.addEventListener('click', () => show(id));
    b.addEventListener('keydown', (e) => {
      const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!dir) return;
      e.preventDefault();
      const next = TABS[(TABS.findIndex(([t]) => t === id) + dir + TABS.length) % TABS.length]![0];
      show(next);
      tabBtns.get(next)!.focus();
    });
    tabBtns.set(id, b);
    tabBar.append(b);
    const p = h('div', `pz-panel pz-${id}`);
    p.id = `pz-panel-${id}`;
    p.setAttribute('role', 'tabpanel');
    p.setAttribute('aria-labelledby', b.id);
    panels.set(id, p);
  }
  const body = h('div', 'pz-body', ...panels.values());
  card.append(head, tabBar, body);

  // ---- Pause tab ----
  const resume = plate('pz-resume', h('b', '', 'Resume'), h('kbd', '', 'Esc'));
  resume.id = 'pause-resume';
  resume.addEventListener('click', () => close());
  const toSettings = plate('pz-nav', 'Settings');
  toSettings.id = 'pause-to-settings';
  toSettings.addEventListener('click', () => { show('settings'); focusFirst(); });
  const toControls = plate('pz-nav', 'Controls');
  toControls.id = 'pause-to-controls';
  toControls.addEventListener('click', () => { show('controls'); focusFirst(); });
  const inviteInput = h('input', 'pz-invite-link');
  inviteInput.readOnly = true;
  inviteInput.setAttribute('aria-label', 'Squad invite link');
  const copy = plate('pz-copy', 'Copy link');
  copy.addEventListener('click', () => void copyText(inviteInput.value, copy));
  const invite = h('div', 'pz-invite', h('span', 'pz-label', 'Squad invite'), h('span', 'pz-invite-row', inviteInput, copy));
  const leaveBtn = plate('pz-leave', 'Leave match');
  leaveBtn.id = 'pause-leave';
  leaveBtn.addEventListener('click', () => askLeave(true));
  const confirmText = h('p', 'pz-confirm-text');
  const stay = plate('pz-stay', 'Stay');
  stay.id = 'pause-stay';
  stay.addEventListener('click', () => askLeave(false));
  const reallyLeave = plate('pz-leave pz-leave-yes', 'Leave');
  reallyLeave.id = 'pause-leave-yes';
  reallyLeave.addEventListener('click', () => { const was = deps.info(); close(); if (was) deps.leave(); });
  const confirm = h('div', 'pz-confirm', h('b', 'pz-confirm-title', 'Leave this match?'), confirmText, h('span', 'pz-confirm-row', stay, reallyLeave));
  confirm.hidden = true;
  confirm.setAttribute('role', 'alertdialog');
  panels.get('home')!.append(resume, h('div', 'pz-navrow', toSettings, toControls), invite, h('div', 'pz-spacer'), leaveBtn, confirm);

  // ---- Settings tab ----
  const sync: (() => void)[] = [];
  const section = (name: string, ...rows: HTMLElement[]) => h('section', 'pz-section', h('h3', 'pz-h', name), ...rows);
  const row = (label: string, hint: string | null, control: HTMLElement, id?: string) => {
    const lid = `pz-l-${++uid}`;
    const l = h('span', 'pz-rowlabel', h('b', '', label), hint ? h('small', '', hint) : null);
    l.id = lid;
    control.setAttribute('aria-labelledby', lid);
    const r = h('div', 'pz-row', l, control);
    if (id) r.id = id;
    return r;
  };

  function slider(opts: { min: number; max: number; step: number; get(): number; set(v: number): void; text?(v: number): string; id?: string; preview?: boolean }) {
    const input = h('input', 'pz-range');
    input.type = 'range';
    input.min = String(opts.min); input.max = String(opts.max); input.step = String(opts.step);
    if (opts.id) input.id = opts.id;
    const out = h('output', 'pz-out');
    const text = opts.text ?? ((v: number) => `${v}%`);
    const paint = () => {
      const v = Number(input.value);
      input.style.setProperty('--fill', `${((v - opts.min) / (opts.max - opts.min)) * 100}%`);
      out.textContent = text(v);
      input.setAttribute('aria-valuetext', text(v));
    };
    input.addEventListener('input', () => {
      opts.set(Number(input.value));
      paint();
      // A short effect while the slider moves, so its loudness can be judged without leaving the menu.
      const now = performance.now();
      if (opts.preview && now - blipAt > 140) { blipAt = now; deps.blip(); }
    });
    sync.push(() => { input.value = String(opts.get()); paint(); });
    return h('span', 'pz-slider', input, out);
  }

  function toggle(get: () => boolean, set: (on: boolean) => void, id?: string) {
    const b = plate('pz-switch');
    if (id) b.id = id;
    b.setAttribute('role', 'switch');
    const paint = () => { const on = get(); b.setAttribute('aria-checked', String(on)); b.textContent = on ? 'On' : 'Off'; };
    b.addEventListener('click', () => { set(!get()); paint(); });
    sync.push(paint);
    return b;
  }

  function segmented<T extends string>(opts: { options: readonly (readonly [T, string])[]; get(): T; set(v: T): void; id?: string; disabled?: () => boolean; icon?: (v: T, c: CanvasRenderingContext2D) => void }) {
    const group = h('div', 'pz-seg');
    group.setAttribute('role', 'radiogroup');
    if (opts.id) group.id = opts.id;
    const btns = opts.options.map(([v, label]) => {
      const b = plate('pz-opt');
      b.setAttribute('role', 'radio');
      b.dataset.value = v;
      if (opts.icon) {
        const c = h('canvas', 'pz-icon');
        c.width = c.height = 40;
        b.append(c);
      }
      b.append(h('span', '', label));
      b.addEventListener('click', () => { opts.set(v); paint(); });
      b.addEventListener('keydown', (e) => {
        const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
        if (!dir) return;
        e.preventDefault();
        const live = btns.filter((x) => !x.disabled);
        const to = live[(live.indexOf(b) + dir + live.length) % live.length]!;
        opts.set(to.dataset.value as T);
        paint();
        to.focus();
      });
      return b;
    });
    function paint() {
      const cur = opts.get();
      const off = opts.disabled?.() ?? false;
      for (const b of btns) {
        const on = b.dataset.value === cur;
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on ? 0 : -1;
        b.disabled = off && !on;
        const c = b.querySelector('canvas');
        const g = c?.getContext('2d');
        if (c && g && opts.icon) { g.clearRect(0, 0, c.width, c.height); opts.icon(b.dataset.value as T, g); }
      }
    }
    group.append(...btns);
    sync.push(paint);
    return group;
  }

  // ---- Graphics preset: a dropdown, what each tier is, what Auto picked, a live FPS readout, and the individual knobs under Advanced ----
  const presetSelect = h('select', 'pz-select');
  presetSelect.id = 'set-quality';
  for (const id of ['auto', ...PRESET_IDS] as EffectsQuality[]) presetSelect.append(new Option(id === 'auto' ? 'Auto (recommended)' : PRESET_INFO[id].name, id));
  presetSelect.addEventListener('change', () => {
    // A preset is a clean start: the individual overrides go with it.
    setSetting('adv', {});
    setSetting('quality', presetSelect.value as EffectsQuality);
    for (const f of sync) f();
  });
  const autoLine = h('p', 'pz-autoline');
  autoLine.id = 'set-auto-line';
  const tierList = h('ul', 'pz-tiers', ...PRESET_IDS.map((id) => {
    const li = h('li', '', h('b', '', PRESET_INFO[id].name), ` ${PRESET_INFO[id].blurb}`);
    li.dataset.tier = id;
    return li;
  }));
  const fpsLine = h('p', 'pz-fps');
  fpsLine.id = 'set-fps';
  const paintFps = () => {
    const q = qualityState();
    fpsLine.textContent = q.fps === null ? 'Measuring frame rate...' : `${q.fps} FPS · ${q.ms} ms per frame · slowest ${q.worst} ms`;
  };
  const adv = (patch: Adv) => { setSetting('adv', { ...settings().adv, ...patch }); for (const f of sync) f(); };
  // Lighting runs inside the shader pass (knobsFor), so switching it on switches the pass on too: alone it would stay Off (Low has no pass).
  const advToggle = (key: 'post' | 'lighting' | 'waterGL', id: string) => toggle(() => knobs()[key], (on) => adv(key === 'lighting' && on ? { lighting: true, post: true } : { [key]: on }), id);
  const stepsFor = (steps: readonly (readonly [number, string])[], key: 'critters' | 'dprCap', id: string) => segmented<string>({
    id, options: steps.map(([v, label]) => [String(v), label] as const),
    get: () => String(steps.reduce((a, st) => (Math.abs(st[0] - knobs()[key]) < Math.abs(a[0] - knobs()[key]) ? st : a))[0]),
    set: (v) => adv({ [key]: Number(v) }),
  });
  const advanced = h('details', 'pz-adv', h('summary', '', 'Advanced'),
    row('Lighting and shadows', null, advToggle('lighting', 'adv-lighting')),
    row('Glow, grain and colour grade', null, advToggle('post', 'adv-post')),
    row('GPU water', 'harbour map', advToggle('waterGL', 'adv-water')),
    row('Ambient critters', null, stepsFor(CRITTER_STEPS, 'critters', 'adv-critters')),
    row('Resolution cap', null, stepsFor(DPR_STEPS, 'dprCap', 'adv-dpr')));
  advanced.id = 'set-advanced';
  const paintPreset = () => {
    const q = settings().quality, st = qualityState();
    presetSelect.value = q;
    presetSelect.disabled = nofx();
    for (const li of tierList.children as HTMLCollectionOf<HTMLElement>) li.classList.toggle('on', li.dataset.tier === st.preset);
    const gpu = st.renderer ? ` GPU: ${st.renderer}.` : '';
    autoLine.textContent = nofx() ? 'Effects are off because the address has ?nofx.'
      : q === 'auto' ? `Auto → ${PRESET_INFO[st.preset].name}: ${st.autoWhy}.${fxCapable() ? ' If frames stay slow for about 10 seconds it steps down.' : ' The shader pass is not running on this device.'}`
        : `${PRESET_INFO[st.preset].name} is fixed: it never changes by itself.${gpu}${fxCapable() ? '' : ' The shader pass is not running on this device.'}`;
    if (!nofx() && fxCapable()) autoLine.textContent += ` ${lightingStatus().line}.`;
    paintFps();
  };
  sync.push(paintPreset);
  const presetBlock = h('div', 'pz-preset', row('Graphics quality', null, presetSelect), autoLine, tierList, fpsLine, advanced);
  setInterval(() => { if (isOpen && tab === 'settings') paintPreset(); }, 500);
  const settingsPanel = panels.get('settings')!;
  settingsPanel.append(
    section('Audio',
      row('Sound', 'M', toggle(() => !audio.isMuted(), (on) => { audio.setMuted(!on); setSoundMuted(!on); }, 'set-sound')),
      row('Master volume', null, slider({ min: 0, max: 100, step: 5, id: 'set-master', get: () => percentOfGain(audio.getMasterVolume()), set: (v) => audio.setMasterVolume(gainOfPercent(v)), preview: true })),
      row('Music volume', null, slider({ min: 0, max: 100, step: 5, id: 'set-music', get: () => percentOfGain(getMusicVolume()), set: (v) => setMusicVolume(gainOfPercent(v)) })),
      row('Sound effects volume', null, slider({ min: 0, max: 100, step: 5, id: 'set-sfx', get: () => percentOfGain(audio.getSfxVolume()), set: (v) => audio.setSfxVolume(gainOfPercent(v)), preview: true })),
      row('Music', 'Shift+M', toggle(() => !isMusicMuted(), (on) => { if (isMusicMuted() === on) toggleMusicMuted(); }, 'set-music-on')),
    ),
    section('Graphics',
      presetBlock,
      row('Screen shake', null, segmented<ShakeMode>({ id: 'set-shake', options: SHAKE_IDS.map((s) => [s, s === 'on' ? 'On' : s === 'reduced' ? 'Reduced' : 'Off'] as const), get: () => settings().shake, set: (v) => setSetting('shake', v) })),
      row('Reduced motion', null, segmented<MotionMode>({ id: 'set-motion', options: MOTION_IDS.map((m) => [m, m === 'system' ? 'System' : m === 'on' ? 'On' : 'Off'] as const), get: () => settings().motion, set: (v) => setSetting('motion', v) })),
      row('UI scale', null, slider({
        min: UI_PERCENT.min - UI_PERCENT.step, max: UI_PERCENT.max, step: UI_PERCENT.step, id: 'set-ui',
        get: () => settings().uiScale || UI_PERCENT.min - UI_PERCENT.step,
        set: (v) => setSetting('uiScale', v < UI_PERCENT.min ? 0 : v),
        text: (v) => (v < UI_PERCENT.min ? 'Auto' : `${v}%`),
      })),
    ),
    section('Gameplay',
      row('Soldier chatter', 'C', toggle(chatterOn, setChatterOn, 'set-chatter')),
      row('Damage numbers', null, toggle(() => settings().damageNumbers, (on) => setSetting('damageNumbers', on), 'set-dmgnums')),
      row('Crosshair', null, segmented<CrosshairStyle>({
        id: 'set-crosshair',
        options: CROSSHAIR_IDS.map((c) => [c, c === 'classic' ? 'Classic' : c === 'dot' ? 'Dot' : c === 'ring' ? 'Ring' : 'Open'] as const),
        get: () => settings().crosshair, set: (v) => setSetting('crosshair', v),
        icon: (v, g) => drawCrosshairIcon(g, v, CROSSHAIR_COLORS[settings().crosshairColor]),
      })),
      row('Crosshair colour', null, segmented<CrosshairColor>({
        id: 'set-crosshair-color',
        options: (Object.keys(CROSSHAIR_COLORS) as CrosshairColor[]).map((c) => [c, c[0]!.toUpperCase() + c.slice(1)] as const),
        get: () => settings().crosshairColor, set: (v) => { setSetting('crosshairColor', v); for (const f of sync) f(); },
        icon: (v, g) => { g.fillStyle = CROSSHAIR_COLORS[v]; g.strokeStyle = '#1c1f26'; g.lineWidth = 3; g.beginPath(); g.arc(20, 20, 11, 0, Math.PI * 2); g.stroke(); g.fill(); },
      })),
      row('Touch aim assist', 'phones', toggle(() => settings().touchAssist, (on) => setSetting('touchAssist', on), 'set-assist')),
      row('Aim look-ahead', null, segmented<LookAheadMode>({ id: 'set-lookahead', options: LOOK_AHEAD_IDS.map((m) => [m, m === 'off' ? 'Off' : m === 'low' ? 'Low' : 'Normal'] as const), get: () => settings().lookAhead, set: (v) => setSetting('lookAhead', v) })),
    ),
  );
  const reset = plate('pz-reset', 'Reset to defaults');
  reset.id = 'set-reset';
  reset.addEventListener('click', () => {
    resetSettings();
    audio.setMasterVolume(1); audio.setSfxVolume(1); setMusicVolume(1);
    audio.setMuted(false); setSoundMuted(false);
    if (isMusicMuted()) toggleMusicMuted();
    setChatterOn(true);
    for (const f of sync) f();
  });
  settingsPanel.append(h('div', 'pz-resetrow', reset));

  // ---- Controls tab ----
  const controlsPanel = panels.get('controls')!;
  controlsPanel.append(
    h('dl', 'pz-keys', ...CONTROLS.flatMap(([key, what]) => [h('dt', '', h('kbd', '', key)), h('dd', '', what)])),
    h('section', 'pz-touch', h('h3', 'pz-h', 'Touch'), h('ul', '', ...TOUCH_NOTES.map((t) => h('li', '', t)))),
    musicCredits(),
  );

  document.body.append(root);

  // ---- behaviour ----
  function show(next: Tab) {
    tab = next;
    for (const [id, p] of panels) p.hidden = id !== next;
    for (const [id, b] of tabBtns) { b.setAttribute('aria-selected', String(id === next)); b.tabIndex = id === next ? 0 : -1; }
    body.scrollTop = 0;
  }

  // The graphics dropdown and the Advanced disclosure's summary take focus too: left out, Tab and the pad could never reach them (or the knobs inside).
  const focusables = (): HTMLElement[] =>
    [...root.querySelectorAll<HTMLElement>('button, input, select, summary, [tabindex]')].filter((e) => !(e as HTMLButtonElement).disabled && e.tabIndex >= 0 && e.getClientRects().length > 0 && !e.closest('[hidden]'));
  function focusFirst() {
    const first = tab === 'home' ? (confirming ? stay : resume) : focusables().find((e) => e !== closeBtn && !e.classList.contains('pz-tab')) ?? closeBtn;
    first.focus({ preventScroll: true });
  }

  function askLeave(on: boolean) {
    confirming = on;
    confirm.hidden = !on;
    leaveBtn.hidden = on;
    const info = deps.info();
    confirmText.textContent = info?.range ? 'Back to the mode select. The range closes when you go.' : 'Back to the mode select. Your soldier leaves the match, and the others play on.';
    if (on) stay.focus({ preventScroll: true }); else leaveBtn.focus({ preventScroll: true });
  }

  function paintNote() {
    const info = deps.info();
    live.hidden = !info;
    note.textContent = !info ? '' : info.range
      ? 'You are alone on a private range. This menu does not stop it: the targets and the clock keep running.'
      : info.dead
        ? 'The match is still on for everyone else. You are out for now, and respawning waits until you resume.'
        : 'The match keeps running for everyone else. Your soldier stands still, will not fire, and can still be shot.';
    title.textContent = info ? `Paused · ${info.modeName}` : 'Paused';
    const link = info?.invite ?? null;
    invite.hidden = !link;
    inviteInput.value = link ?? '';
  }

  function open() {
    if (isOpen || !deps.info()) return;
    isOpen = true;
    confirming = false;
    confirm.hidden = true;
    leaveBtn.hidden = false;
    paintNote();
    for (const f of sync) f();
    show('home');
    root.hidden = false;
    document.body.classList.add('paused');
    cog.setAttribute('aria-expanded', 'true');
    deps.onToggle(true);
    resume.focus({ preventScroll: true });
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    confirming = false;
    root.hidden = true;
    document.body.classList.remove('paused');
    cog.setAttribute('aria-expanded', 'false');
    // Nothing keeps focus: a focused button would swallow the Space the ability uses.
    (document.activeElement as HTMLElement | null)?.blur?.();
    deps.onToggle(false);
  }

  /** Escape and Tab while the menu is up. Returns true when the key was dealt with. Arrows and Space reach the focused control as usual. */
  function handleKey(e: KeyboardEvent): boolean {
    if (!isOpen) return false;
    if (e.key === 'Tab') {
      const list = focusables();
      if (!list.length) return false;
      const at = list.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey ? (at <= 0 ? list.length - 1 : at - 1) : (at < 0 || at >= list.length - 1 ? 0 : at + 1);
      e.preventDefault();
      list[next]!.focus();
      return true;
    }
    return false;
  }

  // ---- gamepad: d-pad or left stick moves focus, A presses, B or Start resumes; Start opens it in a match ----
  let padBefore: PadSample | null = null;
  let padTimer: ReturnType<typeof setInterval> | undefined;
  const padPoll = () => {
    const gp = [...(navigator.getGamepads?.() ?? [])].find((g) => g && g.connected);
    if (!gp) { padBefore = null; return; }
    const sample: PadSample = { buttons: gp.buttons.map((b) => b.pressed), x: gp.axes[0] ?? 0, y: gp.axes[1] ?? 0 };
    const intent = padIntent(padBefore, sample);
    padBefore = sample;
    if (!intent) return;
    if (!isOpen) { if (intent === 'start') open(); return; }
    padStep(intent);
  };
  function padStep(intent: NonNullable<ReturnType<typeof padIntent>>) {
    const active = document.activeElement as HTMLElement | null;
    if (intent === 'start' || intent === 'back') { if (confirming) askLeave(false); else close(); return; }
    if (intent === 'accept') { if (active && root.contains(active) && active.tagName !== 'INPUT') active.click(); return; }
    if ((intent === 'left' || intent === 'right') && active && root.contains(active)) {
      const key = intent === 'left' ? 'ArrowLeft' : 'ArrowRight';
      if (active instanceof HTMLInputElement && active.type === 'range') {
        (intent === 'left' ? active.stepDown : active.stepUp).call(active);
        active.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
      if (active instanceof HTMLSelectElement) {
        const to = Math.min(active.options.length - 1, Math.max(0, active.selectedIndex + (intent === 'left' ? -1 : 1)));
        if (to !== active.selectedIndex) { active.selectedIndex = to; active.dispatchEvent(new Event('change', { bubbles: true })); }
        return;
      }
      if (active.getAttribute('role') === 'radio' || active.getAttribute('role') === 'tab') { active.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); return; }
    }
    const list = focusables();
    const at = Math.max(0, list.indexOf(active as HTMLElement));
    const step = intent === 'up' || intent === 'left' ? -1 : 1;
    list[Math.min(list.length - 1, Math.max(0, at + step))]?.focus();
  }
  const startPad = () => { if (!padTimer && typeof navigator.getGamepads === 'function') padTimer = setInterval(padPoll, 70); };
  addEventListener('gamepadconnected', startPad);
  if ([...(navigator.getGamepads?.() ?? [])].some((g) => g?.connected)) startPad();

  show('home');

  return {
    isOpen: () => isOpen,
    confirming: () => confirming,
    open,
    close,
    toggle: () => (isOpen ? close() : open()),
    cancelConfirm: () => askLeave(false),
    handleKey,
    /** The match ended under it (the page went back to the menu). */
    reset: () => { if (isOpen) close(); },
    /** Dev probe: the live audio graph values, to prove the sliders reach the gain nodes. */
    probe: () => ({
      open: isOpen, tab, confirming,
      gains: audio.gains(),
      music: musicGainNow(),
      quality: { ...qualityState(), preset: effectivePreset(), knobs: knobs() },
      volumes: { master: audio.getMasterVolume(), music: getMusicVolume(), sfx: audio.getSfxVolume() },
      muted: audio.isMuted(),
    }),
  };
}

/** `?nofx` in the address pins the effects off whatever the setting says. */
const nofx = (): boolean => new URLSearchParams(location.search).has('nofx');

/** A chunky eight-tooth cog with a hole, as one even-odd path in a 24x24 box. */
function gearPath(): string {
  const pts: string[] = [];
  const teeth = 8;
  for (let i = 0; i < teeth * 2; i++) {
    const a0 = (i / (teeth * 2)) * Math.PI * 2 - Math.PI / 16;
    const a1 = ((i + 1) / (teeth * 2)) * Math.PI * 2 - Math.PI / 16;
    const r = i % 2 === 0 ? 10.2 : 7.6;
    for (const a of [a0 + 0.06, a1 - 0.06]) pts.push(`${(12 + Math.cos(a) * r).toFixed(2)} ${(12 + Math.sin(a) * r).toFixed(2)}`);
  }
  return `M${pts.join('L')}ZM12 8.6a3.4 3.4 0 1 0 0.01 0Z`;
}

/** A 40x40 sample of a crosshair style for its option button. */
function drawCrosshairIcon(g: CanvasRenderingContext2D, style: CrosshairStyle, color: string) {
  const ink = '#1c1f26';
  g.lineCap = 'round';
  const ticks = () => {
    for (const [w, c] of [[5, ink], [2.4, color]] as const) {
      g.lineWidth = w; g.strokeStyle = c; g.beginPath();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { g.moveTo(20 + dx * 6, 20 + dy * 6); g.lineTo(20 + dx * 14, 20 + dy * 14); }
      g.stroke();
    }
  };
  const dot = (r: number) => { g.fillStyle = ink; g.fillRect(20 - r - 1.5, 20 - r - 1.5, r * 2 + 3, r * 2 + 3); g.fillStyle = color; g.fillRect(20 - r, 20 - r, r * 2, r * 2); };
  if (style === 'classic' || style === 'open') ticks();
  if (style === 'ring') for (const [w, c] of [[5.5, ink], [2.6, color]] as const) { g.lineWidth = w; g.strokeStyle = c; g.beginPath(); g.arc(20, 20, 11, 0, Math.PI * 2); g.stroke(); }
  if (style === 'classic') dot(1.5);
  if (style === 'dot' || style === 'ring') dot(2.5);
}

/** A small plate near the top of the screen that says what the game just did on its own (Auto lowering the graphics). */
export function showToast(message: string, ms = 7000) {
  const t = h('div', 'pz-toast', message);
  t.setAttribute('role', 'status');
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}
