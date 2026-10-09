import { MODE_INFO, type SceneId } from './modecards.ts';

/**
 * The menu's flow: two steps (choose your fight, then gear up) under three tabs (Deploy, Armory, Challenges), the account sheet,
 * and the keyboard and gamepad navigation that moves focus between cards by where they sit. It also decides what runs: the backdrop
 * while the menu is up, the gear stage only on the gear step of the Deploy tab, and
 * nothing at all while the tab is hidden or a match has the screen.
 */
export type Step = 'modes' | 'gear';
type Runner = { start(): void; stop(): void };
type Deps = { menu: HTMLElement; stage: Runner & { paint(): void }; scene: Runner; onStep?: (s: Step) => void; onEscape?: () => boolean };

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function createMenuFlow(d: Deps) {
  let step: Step = 'modes';
  let tab = 'tab-deploy';
  let visible = false;
  let lastCard: HTMLElement | null = null;
  const modes = byId('step-modes'), gear = byId('play-form'), crumbModes = byId<HTMLButtonElement>('crumb-modes'), crumbGear = byId<HTMLButtonElement>('crumb-gear');
  const sheet = byId('acct-sheet'), acctBtn = byId<HTMLButtonElement>('acct-btn');
  let chosen = false;

  /** Starts what the current view needs and stops the rest. */
  const sync = () => {
    const live = visible && !document.hidden;
    if (live) d.scene.start(); else d.scene.stop();
    if (live && tab === 'tab-deploy' && step === 'gear') d.stage.start(); else d.stage.stop();
  };

  const focusable = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('button, input, select, a[href], summary')].filter((e) => !(e as HTMLButtonElement).disabled && e.getClientRects().length > 0);

  function go(next: Step, opts: { focus?: boolean } = {}) {
    if (next === 'gear') chosen = true;
    step = next;
    d.menu.dataset.step = next;
    modes.hidden = next !== 'modes';
    gear.hidden = next !== 'gear';
    crumbModes.setAttribute('aria-current', next === 'modes' ? 'step' : 'false');
    crumbGear.setAttribute('aria-current', next === 'gear' ? 'step' : 'false');
    crumbGear.disabled = !chosen;
    d.menu.scrollTop = 0;
    sync();
    d.onStep?.(next);
    if (opts.focus === false) return;
    requestAnimationFrame(() => {
      if (next === 'gear') (gear.querySelector<HTMLElement>('.weapon[aria-pressed="true"]') ?? gear.querySelector<HTMLElement>('button'))?.focus({ preventScroll: true });
      else (lastCard && lastCard.isConnected && lastCard.getClientRects().length ? (lastCard.matches('button') ? lastCard : lastCard.querySelector<HTMLElement>('.mc-hit')) : modes.querySelector<HTMLElement>('#mode-select') ?? modes.querySelector<HTMLElement>('.server'))?.focus({ preventScroll: true });
    });
  }

  crumbModes.onclick = () => go('modes');
  crumbGear.onclick = () => go('gear');
  byId('gear-back').onclick = () => go('modes');
  // Remember which card was chosen so Back returns focus to it.
  d.menu.addEventListener('click', (e) => { const c = (e.target as HTMLElement).closest<HTMLElement>('.mode-card'); if (c) lastCard = c; }, true);

  const setSheet = (open: boolean) => {
    sheet.hidden = !open;
    acctBtn.setAttribute('aria-expanded', String(open));
  };
  acctBtn.onclick = () => setSheet(sheet.hidden === true);
  document.addEventListener('pointerdown', (e) => {
    if (sheet.hidden) return;
    const t = e.target as Node;
    if (!sheet.contains(t) && !acctBtn.contains(t)) setSheet(false);
  });

  /** Moves focus to the nearest control in the arrow's direction, by where controls sit on screen. */
  function moveFocus(dir: 'left' | 'right' | 'up' | 'down'): boolean {
    const root = !sheet.hidden ? sheet : tab !== 'tab-deploy' ? byId(tab === 'tab-armory' ? 'armory' : 'challenges') : step === 'modes' ? modes : gear;
    const all = [...focusable(root), ...(root === sheet ? [] : focusable(byId('menu-tabs')))];
    const cur = document.activeElement as HTMLElement | null;
    if (!cur || !all.includes(cur)) { all[0]?.focus(); return !!all[0]; }
    const a = cur.getBoundingClientRect();
    const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
    let best: HTMLElement | null = null, bestScore = Infinity;
    for (const o of all) {
      if (o === cur || (cur.closest('.mode-card') && cur.closest('.mode-card') === o.closest('.mode-card'))) continue;
      const r = o.getBoundingClientRect();
      const dx = r.left + r.width / 2 - ax, dy = r.top + r.height / 2 - ay;
      const [p, q] = dir === 'right' ? [dx, dy] : dir === 'left' ? [-dx, dy] : dir === 'down' ? [dy, dx] : [-dy, dx];
      if (p < 6) continue;
      const score = p + Math.abs(q) * 2.4;
      if (score < bestScore) { bestScore = score; best = o; }
    }
    if (!best) return false;
    best.focus();
    best.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return true;
  }

  const KEYS: Record<string, 'left' | 'right' | 'up' | 'down'> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
  const back = () => {
    if (!sheet.hidden) { setSheet(false); acctBtn.focus(); return true; }
    if (d.onEscape?.()) return true;
    if (tab === 'tab-deploy' && step === 'gear') { go('modes'); return true; }
    return false;
  };
  window.addEventListener('keydown', (e) => {
    if (!visible || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape') { if (back()) e.preventDefault(); return; }
    const dir = KEYS[e.key];
    if (!dir) return;
    const t = e.target as HTMLElement;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || t.isContentEditable) return;
    if (moveFocus(dir)) e.preventDefault();
  });

  // Gamepad: the d-pad and left stick move focus, A presses, B goes back. Polled only while the menu is up and a pad is connected.
  let pad = false, prev: boolean[] = [], padTimer = 0;
  const poll = () => {
    if (!visible || document.hidden) return;
    const gp = [...(navigator.getGamepads?.() ?? [])].find((g) => g && g.connected);
    if (!gp) return;
    const now = gp.buttons.map((b) => b.pressed);
    const ax = gp.axes[0] ?? 0, ay = gp.axes[1] ?? 0;
    const pressed = (i: number) => !!now[i] && !prev[i];
    if (pressed(14) || (ax < -0.6 && !prev[100])) moveFocus('left');
    if (pressed(15) || (ax > 0.6 && !prev[101])) moveFocus('right');
    if (pressed(12) || (ay < -0.6 && !prev[102])) moveFocus('up');
    if (pressed(13) || (ay > 0.6 && !prev[103])) moveFocus('down');
    if (pressed(0)) (document.activeElement as HTMLElement | null)?.click();
    if (pressed(1)) back();
    if (pressed(9)) byId<HTMLButtonElement>('play').click();
    prev = [...now]; prev[100] = ax < -0.6; prev[101] = ax > 0.6; prev[102] = ay < -0.6; prev[103] = ay > 0.6;
  };
  addEventListener('gamepadconnected', () => { if (!pad) { pad = true; padTimer = window.setInterval(poll, 90); } });
  addEventListener('gamepaddisconnected', () => { if (pad && ![...(navigator.getGamepads?.() ?? [])].some((g) => g?.connected)) { pad = false; clearInterval(padTimer); } });
  document.addEventListener('visibilitychange', sync);

  return {
    get step() { return step; },
    go,
    /** The menu is on screen (or a match has the screen). */
    setVisible(v: boolean) { visible = v; sync(); },
    /** The Deploy, Armory or Challenges tab is showing. */
    setTab(t: string) { tab = t; sync(); if (t !== 'tab-deploy') setSheet(false); },
    /** Marks the gear step reachable without having clicked a card (a deep link). */
    reachable() { chosen = true; crumbGear.disabled = false; },
    closeSheet: () => setSheet(false),
    /** The account chip: the name (or "Log in") and the level. */
    setAccount(name: string | null, level?: number) {
      byId('acct-name').textContent = name ?? 'Log in';
      const lv = byId('acct-lv');
      lv.hidden = level === undefined || !name;
      lv.textContent = level === undefined ? '' : `LV ${level}`;
      acctBtn.classList.toggle('in', !!name);
    },
    /** The mission strip on the gear step: the mode's chip, name and where you are deploying. */
    setMission(m: { mode: SceneId; detail?: string }) {
      const root = byId('mission');
      const chip = document.createElement('span');
      chip.className = `mode mode-${m.mode.toLowerCase()}`;
      chip.textContent = m.mode;
      const name = document.createElement('b');
      name.textContent = MODE_INFO[m.mode].name;
      root.replaceChildren(chip, name);
      if (m.detail) { const s = document.createElement('span'); s.className = 'mission-detail'; s.textContent = m.detail; root.append(s); }
    },
  };
}
export type MenuFlow = ReturnType<typeof createMenuFlow>;
