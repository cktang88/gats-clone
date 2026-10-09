import { ARMORS, ARMOR_IDS, EVOLUTIONS, GUNS, PERK_INFO, PERK_TIERS, WEAPON_IDS, type ArmorId, type GunId, type PerkId, type Tier } from '../shared/defs.ts';
import type { ClientMsg, Snapshot } from '../shared/protocol.ts';
import { TARGETS } from '../shared/range.ts';
import { drawGunCard } from './gunart.ts';
import { iconSvg, PERK_ICONS } from './icons.ts';
import { livePill } from './menu.ts';
import { MODE_INFO } from './modecards.ts';

/**
 * The shooting range's own interface (mode `RNG`): the menu card that opens a private range, the readout plate (last hit, DPS over
 * three seconds, accuracy, time to kill) and the loadout panel (any gun and evolution, any armor, any perk in each tier, set or
 * cleared at will). Field kit per docs/art/STYLE.md; everything sits in `#hud`, which `--ui` already scales.
 */
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  node.className = className;
  node.append(...kids);
  return node;
};

/** A button that never takes focus, so a Space pressed for the ability is not swallowed by the plate last clicked. */
const plate = (className: string, ...kids: (Node | string)[]): HTMLButtonElement => {
  const b = el('button', className, ...kids);
  b.type = 'button';
  b.addEventListener('mousedown', (e) => e.preventDefault());
  return b;
};

export async function openRangeRoom(): Promise<{ room: string } | { error: string }> {
  try {
    const res = await fetch('/api/range', { method: 'POST' });
    const r: unknown = await res.json();
    if (typeof r === 'object' && r !== null && typeof (r as { room?: unknown }).room === 'string') return { room: (r as { room: string }).room };
    return { error: typeof r === 'object' && r !== null && typeof (r as { error?: unknown }).error === 'string' ? (r as { error: string }).error : 'Could not open the range' };
  } catch {
    return { error: 'Could not reach server' };
  }
}

/** The menu card: what the range is in one line, and a button (or the whole card) that opens one for you alone. */
export function renderRangeCard(root: HTMLElement, state: { busy: boolean }, on: { start(): void }) {
  const start = plate('mc-btn range-start', state.busy ? 'Opening…' : 'Open the range');
  start.id = 'range-start';
  start.disabled = state.busy;
  start.addEventListener('click', on.start);
  const pitch = el('span', 'range-pitch mc-plate',
    el('span', 'range-title mc-head', el('span', 'mode mode-rng', 'RNG'), el('b', 'mc-name', 'Shooting range'), livePill('private · just you').pill),
    el('span', 'mc-pitch', MODE_INFO.RNG.pitch));
  pitch.append(el('span', 'mc-actions', el('span', 'mc-cta', start)));
  const hit = el('button', 'mc-hit');
  hit.type = 'button';
  hit.setAttribute('aria-label', 'Shooting range: open a private range');
  hit.disabled = state.busy;
  hit.addEventListener('click', on.start);
  root.replaceChildren(el('span', 'mc-face', pitch), hit);
}

type Send = (msg: ClientMsg) => void;
type Mine = { gun: GunId; armor: ArmorId; perks: Partial<Record<Tier, PerkId>> };

const ARMOR_BLURB = (id: ArmorId) => (ARMORS[id].blockFrac ? `+${Math.round(ARMORS[id].blockFrac * 100)}% blocked` : 'none');
const fmt = (n: number, digits = 0) => n.toFixed(digits);

export function createRangeUi(hud: HTMLElement, send: Send, click: () => void) {
  const open = plate('range-open', el('b', '', 'Loadout'), el('kbd', '', 'L'));
  open.id = 'range-open';
  const readout = el('aside', 'range-hud');
  readout.id = 'range-hud';
  const panel = el('section', 'range-panel');
  panel.id = 'range-panel';
  panel.setAttribute('aria-label', 'Range loadout');
  readout.hidden = panel.hidden = true;
  hud.append(readout, panel);

  let mine: Mine | null = null;
  let shown = '';
  let isOpen = false;
  let live = false;

  // ---- the panel, built once
  const gunTiles = new Map<GunId, HTMLButtonElement>();
  const gunColumn = (base: (typeof WEAPON_IDS)[number]) => {
    const tree: GunId[] = [base];
    for (const a of EVOLUTIONS[base]) tree.push(a, ...EVOLUTIONS[a]);
    const tiles = tree.map((id) => {
      const g = GUNS[id];
      const art = el('canvas', 'rp-art');
      const b = plate('rp-tile', art, el('b', '', g.name), el('small', '', `${g.damage}${g.pellets > 1 ? `×${g.pellets}` : ''} · ${Math.round(60_000 / g.fireMs)} rpm`));
      b.dataset.stage = String(g.stage);
      b.title = `${g.name}: ${g.desc}`;
      b.addEventListener('click', () => { click(); choose({ gun: id }); });
      drawGunCard(art, id, 62, 23, tree);
      gunTiles.set(id, b);
      return b;
    });
    return el('div', 'rp-col', el('h3', '', GUNS[base].name), ...tiles);
  };
  const armorTiles = new Map<ArmorId, HTMLButtonElement>();
  const armors = ARMOR_IDS.map((id) => {
    const b = plate('rp-chip armor', el('b', '', ARMORS[id].name), el('small', '', ARMOR_BLURB(id)));
    b.addEventListener('click', () => { click(); choose({ armor: id }); });
    armorTiles.set(id, b);
    return b;
  });
  const perkTiles = new Map<string, HTMLButtonElement>();
  const TIER_NAMES: Record<Tier, string> = { 1: 'Tier 1 · attachment', 2: 'Tier 2 · perk', 3: 'Tier 3 · ability' };
  const tierRow = (tier: Tier) => {
    const none = plate('rp-chip none', el('b', '', 'None'));
    none.addEventListener('click', () => { click(); choose({ perks: { [tier]: null } }); });
    perkTiles.set(`${tier}:`, none);
    const chips = (PERK_TIERS[tier] as readonly PerkId[]).map((perk) => {
      const b = plate('rp-chip', iconSvg(PERK_ICONS[perk], 'rp-icon'), el('b', '', PERK_INFO[perk].name));
      b.title = `${PERK_INFO[perk].name}: ${PERK_INFO[perk].desc}`;
      b.addEventListener('click', () => { click(); choose({ perks: { [tier]: mine?.perks[tier] === perk ? null : perk } }); });
      perkTiles.set(`${tier}:${perk}`, b);
      return b;
    });
    return el('div', 'rp-tier', el('h3', '', TIER_NAMES[tier]), el('div', 'rp-chips', none, ...chips));
  };
  const reset = plate('rp-action', 'Reset stats and targets');
  reset.id = 'range-reset-panel';
  reset.addEventListener('click', () => { click(); send({ t: 'range', a: 'reset' }); });
  const close = plate('rp-action ghost', 'Close ', el('kbd', '', 'L'));
  close.addEventListener('click', () => toggle(false));
  panel.append(
    el('header', 'rp-head', el('h2', '', 'Range loadout'), el('p', '', 'Any gun, any perk: it applies at once, with a full health bar and magazine. Click a chosen perk again to clear it.'), el('div', 'rp-actions', reset, close)),
    el('div', 'rp-body',
      el('h3', 'rp-label', 'Gun and evolutions'), el('div', 'rp-guns', ...WEAPON_IDS.map(gunColumn)),
      el('h3', 'rp-label', 'Armor'), el('div', 'rp-armors', ...armors),
      el('h3', 'rp-label', 'Perks'), tierRow(1), tierRow(2), tierRow(3),
    ),
  );

  function choose(change: { gun?: GunId; armor?: ArmorId; perks?: { [T in Tier]?: PerkId | null } }) {
    const msg = { t: 'range', a: 'loadout', ...change } as Extract<ClientMsg, { t: 'range'; a: 'loadout' }>;
    send(msg);
    // Show the choice at once; the next snapshot says what the server made of it.
    if (!mine) return;
    const perks = { ...mine.perks };
    for (const tier of [1, 2, 3] as const) {
      const p = msg.perks?.[tier];
      if (p === null) delete perks[tier]; else if (p) perks[tier] = p;
    }
    mine = { gun: msg.gun ?? mine.gun, armor: msg.armor ?? mine.armor, perks };
    paint();
  }

  function paint() {
    if (!mine) return;
    for (const [id, b] of gunTiles) b.ariaPressed = String(id === mine.gun);
    for (const [id, b] of armorTiles) b.ariaPressed = String(id === mine.armor);
    for (const [key, b] of perkTiles) {
      const [tier, perk] = key.split(':') as [string, string];
      const current = mine.perks[Number(tier) as Tier];
      b.ariaPressed = String(perk === '' ? current === undefined : current === perk);
    }
  }

  function toggle(on = !isOpen) {
    if (!live) return;
    isOpen = on;
    panel.hidden = !on;
    open.ariaPressed = String(on);
    if (on) paint();
  }
  open.addEventListener('click', () => { click(); toggle(); });

  // ---- the readout
  const cell = (label: string, value: string, note = '') => el('div', 'rs', el('span', '', label), el('b', '', value), el('small', '', note));
  const resetStats = plate('rs-reset', 'Reset');
  resetStats.id = 'range-reset';
  resetStats.title = 'Start the readout over and stand every target and barrel up';
  resetStats.addEventListener('click', () => { click(); send({ t: 'range', a: 'reset' }); });

  function update(snap: Snapshot, myId: number) {
    const range = snap.range;
    live = !!range;
    readout.hidden = !live;
    if (!range) { panel.hidden = true; isOpen = false; return; }
    const me = snap.players.find((p) => p.id === myId);
    if (me) {
      const next: Mine = { gun: me.gun, armor: me.armorTier, perks: { ...snap.self.perks } };
      const key = JSON.stringify(next);
      if (key !== JSON.stringify(mine)) { mine = next; paint(); }
    }
    const pct = range.shots ? Math.round((range.hits / range.shots) * 100) : null;
    const key = JSON.stringify(range);
    if (key === shown) return;
    shown = key;
    const last = range.last, ttk = range.ttk;
    readout.replaceChildren(
      open,
      el('div', 'rs-body',
        el('div', 'rs-head', el('span', '', 'Range'), resetStats),
        el('div', 'rs-grid',
          cell('Last hit', last ? fmt(last.dmg, last.dmg < 10 && last.dmg % 1 ? 1 : 0) : '–', last ? `${last.dist} px away` : 'nothing yet'),
          cell('DPS · 3 s', fmt(range.dps, 0), 'damage per second'),
          cell('Accuracy', pct === null ? '–' : `${pct}%`, `${range.hits} of ${range.shots} shots`),
          cell('Time to kill', ttk ? `${(ttk.ms / 1000).toFixed(2)} s` : '–', ttk ? `${TARGETS[ttk.kind].name.split(' ')[0]} at ${ttk.dist} px` : `${range.downs} down`),
        ),
      ),
    );
  }

  return {
    update,
    toggle: () => toggle(),
    close: () => toggle(false),
    isOpen: () => isOpen,
    active: () => live,
    hide() { live = false; isOpen = false; readout.hidden = panel.hidden = true; shown = ''; mine = null; },
  };
}
