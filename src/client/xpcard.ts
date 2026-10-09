import { COSMETIC_BY_ID, DEFAULTS, type ProgressMsg, type Slot } from '../shared/cosmetics.ts';
import type { ChallengeView } from '../shared/challenges.ts';
import { emitSfx } from './sfxbus.ts';
import { RARITY_INK, RARITY_NAME, unlockLabel } from './cosmeticlook.ts';
import { barSteps, foldProgress, revealOrder, SLOT_LABEL, xpLines, xpTotal, type BarStep, type CardState } from './progression.ts';
import { drawItem } from './preview.ts';
import { starsHtml } from './levelcard.ts';
import { reducedMotion } from './screenfx.ts';

/**
 * The XP card: after a life or a round, a field-kit plate lists what you earned, ticks the XP bar up through each level, stamps
 * LEVEL UP, and reveals any new cosmetics with an Equip button. It waits for the death card, killcam and round celebration to
 * finish (`blocked`), docks at the side, and never takes input from the match: respawning and playing go on under it.
 */
type Deps = {
  /** True while something else owns the screen (the killcam, slow-motion, the round-end celebration). */
  blocked(): boolean;
  equip(slot: Slot, id: string): Promise<boolean>;
  openArmory(slot: Slot, id: string): void;
};

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
};
const ease = (t: number) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;
const nf = (n: number) => Math.round(n).toLocaleString('en-US');

export const STEP_MS = { base: 700, perLevel: 520, line: 140 } as const;

export function createXpCard(root: HTMLElement, deps: Deps) {
  let pending: CardState | null = null;
  let last: ProgressMsg | null = null;
  let shownAt = 0;
  let hideAt = 0;
  let hovering = false;
  let wasDocked = false;
  let runId = 0;
  root.hidden = true;
  root.addEventListener('pointerenter', () => { hovering = true; });
  root.addEventListener('pointerleave', () => { hovering = false; hideAt = Math.max(hideAt, performance.now() + 4000); });

  const hide = () => { root.hidden = true; root.classList.remove('in'); runId++; };

  function reveal(ids: string[]): HTMLElement {
    const box = el('div', 'xp-reveal');
    let cur = 0;
    const main = el('div', 'xp-reveal-main');
    const art = el('canvas', 'cos-art');
    art.dataset.w = '132'; art.dataset.h = '88';
    const info = el('div', 'xp-reveal-info');
    const chips = el('div', 'xp-chips');
    const paint = () => {
      const c = COSMETIC_BY_ID.get(ids[cur]!)!;
      main.className = `xp-reveal-main r-${c.rarity}`;
      main.style.setProperty('--r', RARITY_INK[c.rarity]);
      const tag = el('small', 'xp-new', `New ${SLOT_LABEL[c.slot].toLowerCase()} unlocked`);
      const name = el('b', 'xp-reveal-name', c.name);
      name.style.color = RARITY_INK[c.rarity];
      const rar = el('span', `rarity r-${c.rarity}`, `${RARITY_NAME[c.rarity]} · ${unlockLabel(c)}`);
      const desc = el('p', '', c.desc);
      const worn = el('button', 'primary xp-equip', 'Equip');
      worn.type = 'button';
      worn.onclick = async () => {
        worn.disabled = true;
        const ok = await deps.equip(c.slot, c.id);
        worn.textContent = ok ? 'Equipped' : 'Locked';
        if (ok) hideAt = Math.max(hideAt, performance.now() + 5000);
      };
      const look = el('button', 'link xp-look', 'Open the armory');
      look.type = 'button';
      look.onclick = () => { deps.openArmory(c.slot, c.id); hide(); };
      info.replaceChildren(tag, name, rar, desc, el('div', 'xp-actions'));
      info.lastElementChild!.append(worn, look);
      requestAnimationFrame(() => drawItem(art, c, performance.now()));
      chips.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-pressed', String(i === cur)));
    };
    main.append(el('i', 'reveal-rays'), art, info);
    if (ids.length > 1) {
      ids.forEach((id, i) => {
        const c = COSMETIC_BY_ID.get(id)!;
        const b = el('button', `xp-chip r-${c.rarity}`, c.name);
        b.type = 'button';
        b.onclick = () => { cur = i; paint(); };
        chips.append(b);
      });
    }
    paint();
    box.append(main, chips);
    return box;
  }

  /** Builds the card for `card` and runs its animation. */
  function present(card: CardState, msg: ProgressMsg) {
    const id = ++runId;
    const calm = reducedMotion();
    const lines = xpLines(card.gained);
    const total = xpTotal(card.gained);
    root.replaceChildren();
    root.hidden = false;
    root.classList.add('in');
    const head = el('header', 'xp-head');
    const close = el('button', 'xp-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.onclick = hide;
    head.append(el('b', '', total > 0 ? 'Field report' : 'Progress'), close);
    const list = el('ul', 'xp-lines');
    lines.forEach((l, i) => {
      const li = el('li', l.reason === 'challenge' ? 'chal' : '');
      li.style.setProperty('--i', String(i));
      li.append(el('span', '', l.label), el('b', '', l.text));
      list.append(li);
    });
    const totalRow = el('div', 'xp-total');
    const totalNum = el('b', '', calm ? `+${nf(total)} XP` : '+0 XP');
    totalRow.append(el('span', '', 'Total'), totalNum);
    totalRow.hidden = total === 0;
    const lvl = el('div', 'xp-level');
    const chip = el('span', 'lv-chip');
    const stars = el('span', 'lv-stars');
    const track = el('div', 'xp-bar big');
    const fill = el('i');
    track.append(fill);
    const label = el('small', 'lv-label');
    const stamp = el('div', 'xp-stamp');
    lvl.append(chip, stars, track, label, stamp);
    root.append(head, list, totalRow, lvl);

    const steps: BarStep[] = barSteps(card.from, card.to);
    const setLevel = (level: number, prestige: number) => {
      chip.innerHTML = `<small>LV</small><b>${level}</b>`;
      stars.innerHTML = starsHtml(prestige);
    };
    const first = steps[0]!;
    setLevel(first.level, first.prestige);
    fill.style.width = `${Math.round(first.from * 100)}%`;
    label.textContent = '';
    const finish = () => {
      if (id !== runId) return;
      const levelled = card.levelUps.length > 0 || steps.length > 1;
      setLevel(msg.level, msg.prestige);
      fill.style.width = `${Math.round((msg.xpInLevel / Math.max(1, msg.xpInLevel + msg.xpToNext)) * 100)}%`;
      label.textContent = `${nf(msg.xpInLevel)} / ${nf(msg.xpInLevel + msg.xpToNext)} XP`;
      totalNum.textContent = `+${nf(total)} XP`;
      const ids = revealOrder(card.unlocks.filter((u) => COSMETIC_BY_ID.get(u) && COSMETIC_BY_ID.get(u)!.id !== DEFAULTS[COSMETIC_BY_ID.get(u)!.slot]));
      if (ids.length) {
        root.append(reveal(ids));
        // Room for the reveal: the lines fold away once they have been read.
        setTimeout(() => { if (id === runId) list.classList.add('folded'); }, calm ? 0 : 1600);
        const top = COSMETIC_BY_ID.get(ids[0]!)!;
        emitSfx(top.rarity === 'legendary' ? 'fanfare' : 'medal:silver', { gain: 0.9 });
        hideAt = performance.now() + 24_000;
      } else hideAt = performance.now() + (levelled ? 9000 : 7000);
    };

    // The lines land one by one; then the bar fills through each level, a stamp at each level-up.
    const lineMs = calm ? 0 : lines.length * STEP_MS.line + 250;
    let stepIndex = 0, stepStart = 0, started = false;
    const t0 = performance.now();
    const tick = (now: number) => {
      if (id !== runId) return;
      if (!started) {
        const waited = now - t0;
        if (waited < lineMs) { totalNum.textContent = `+${nf(total * ease(waited / Math.max(1, lineMs)))} XP`; requestAnimationFrame(tick); return; }
        started = true;
        stepStart = now;
        totalNum.textContent = `+${nf(total)} XP`;
      }
      const step = steps[stepIndex]!;
      const dur = STEP_MS.base + (step.up ? STEP_MS.perLevel * (1 - step.from) : 0) * 0.4 + (step.to - step.from) * 400;
      const k = ease((now - stepStart) / dur);
      const v = step.from + (step.to - step.from) * k;
      fill.style.width = `${Math.round(v * 100)}%`;
      setLevel(step.level, step.prestige);
      if (now - stepStart >= dur) {
        if (step.up) {
          const next = steps[stepIndex + 1]!;
          setLevel(next.level, next.prestige);
          stamp.textContent = next.prestige > step.prestige ? 'NEW STAR' : `LEVEL ${next.level}`;
          stamp.classList.remove('hit');
          void stamp.offsetWidth;
          stamp.classList.add('hit');
          emitSfx(next.prestige > step.prestige ? 'fanfare' : 'medal:gold', { gain: 0.8 });
          stepIndex++;
          stepStart = now + 260;
          requestAnimationFrame(tick);
          return;
        }
        finish();
        return;
      }
      if (now < stepStart) { requestAnimationFrame(tick); return; }
      requestAnimationFrame(tick);
    };
    shownAt = performance.now();
    hideAt = shownAt + 60_000;
    if (calm) { setLevel(msg.level, msg.prestige); finish(); if (card.levelUps.length) stamp.textContent = `LEVEL ${msg.level}`; stamp.classList.add('hit'); } else requestAnimationFrame(tick);
  }

  return {
    /** A `progress` message: gains, level-ups and unlocks join the card waiting to be shown. */
    onProgress(msg: ProgressMsg) {
      last = msg;
      pending = foldProgress(pending, msg);
    },
    /** Called every frame: shows a waiting card once nothing else owns the screen, and hides a finished one. */
    update(now: number) {
      // Folded into a phone death card's More (overlays.ts), the card waits there until you respawn, then lingers a moment.
      const docked = !!root.closest('.death-more');
      if (docked !== wasDocked) { wasDocked = docked; if (!docked) hideAt = Math.max(hideAt, now + 4000); }
      if (pending && last && !deps.blocked()) {
        const card = pending;
        pending = null;
        present(card, last);
      } else if (!root.hidden && !hovering && !docked && hideAt > 0 && now > hideAt) hide();
    },
    reset() { pending = null; last = null; hide(); },
    get visible() { return !root.hidden; },
  };
}
export type XpCard = ReturnType<typeof createXpCard>;
export type { ChallengeView };
