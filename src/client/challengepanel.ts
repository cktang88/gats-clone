import type { ChallengesView, ChallengeView } from '../shared/challenges.ts';
import { RARITY_NAME } from './cosmeticlook.ts';
import { challengePct, formatReset, weeklyReward } from './progression.ts';
import { drawItem } from './preview.ts';
import { SLOT_LABEL } from './progression.ts';

/** The menu's challenges panel: three daily and three weekly with progress, XP, the countdowns to their reset and the weekly reward. */
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
};

/** A challenge's progress bar and its count ("12 / 40", or "Complete"): the same on a row and on the weekly reward card. */
function progressOf(c: ChallengeView): [HTMLElement, HTMLElement] {
  const track = el('div', 'chal-bar');
  const fill = el('i');
  fill.style.width = `${Math.round(challengePct(c) * 100)}%`;
  track.append(fill);
  const count = el('small', 'chal-count', c.done ? 'Complete' : `${Math.min(c.progress, c.target).toLocaleString('en-US')} / ${c.target.toLocaleString('en-US')}`);
  return [track, count];
}

function row(c: ChallengeView, rewardNote: boolean): HTMLElement {
  const li = el('li', `chal${c.done ? ' done' : ''}`);
  const text = el('span', 'chal-text', c.text);
  const xp = el('b', 'chal-xp', `+${c.xp} XP`);
  li.append(text, xp, ...progressOf(c));
  if (rewardNote && c.grant) li.append(el('em', 'chal-gift', 'Reward item'));
  return li;
}

export function createChallengePanel(root: HTMLElement) {
  let view: ChallengesView | null = null;
  let dailyTimer: HTMLElement | null = null, weeklyTimer: HTMLElement | null = null;

  const tick = (now = Date.now()) => {
    if (!view) return;
    if (dailyTimer) dailyTimer.textContent = `Resets in ${formatReset(view.dailyResetsAt - now)}`;
    if (weeklyTimer) weeklyTimer.textContent = `Resets in ${formatReset(view.weeklyResetsAt - now)}`;
  };

  function render(v: ChallengesView | null) {
    view = v;
    if (!v) {
      root.replaceChildren(el('h2', '', 'Challenges'), el('p', 'muted', 'Play a match under your name to start earning challenges.'));
      return;
    }
    const section = (title: string, list: ChallengeView[], timer: 'd' | 'w') => {
      const head = el('div', 'chal-head');
      const h = el('h2', '', title);
      const t = el('span', 'chal-reset');
      if (timer === 'd') dailyTimer = t; else weeklyTimer = t;
      head.append(h, t);
      const ul = el('ul', 'chal-list');
      ul.append(...list.map((c) => row(c, timer === 'w')));
      const sec = el('section', 'chal-section');
      sec.append(head, ul);
      return sec;
    };
    const parts: HTMLElement[] = [section('Daily', v.daily, 'd'), section('Weekly', v.weekly, 'w')];
    const reward = weeklyReward(v);
    if (reward) {
      const card = el('div', `chal-reward r-${reward.item.rarity}${reward.challenge.done ? ' got' : ''}`);
      const art = el('canvas', 'cos-art');
      art.dataset.w = '120'; art.dataset.h = '64';
      const info = el('div', 'chal-reward-info');
      info.append(
        el('small', '', reward.challenge.done ? 'Weekly reward earned' : 'Weekly reward'),
        el('b', '', reward.item.name),
        el('span', 'rarity ' + `r-${reward.item.rarity}`, `${RARITY_NAME[reward.item.rarity]} ${SLOT_LABEL[reward.item.slot].toLowerCase()}`),
        el('small', 'chal-for', `For: ${reward.challenge.text}`),
      );
      const [track, count] = progressOf(reward.challenge);
      const progress = el('div', `chal-reward-progress${reward.challenge.done ? ' done' : ''}`);
      progress.append(track, count);
      info.append(progress);
      card.append(art, info);
      parts.push(card);
      requestAnimationFrame(() => drawItem(art, reward.item));
    }
    root.replaceChildren(...parts);
    tick();
  }
  return { render, tick, get view() { return view; } };
}
