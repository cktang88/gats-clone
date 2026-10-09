import type { AbilityId } from '../shared/defs.ts';
import { abilityCooldownMs } from '../shared/sim/stats.ts';
import type { Snapshot } from '../shared/protocol.ts';
import { iconSvg, PERK_ICONS, UI_ICONS } from './icons.ts';

type SelfView = Snapshot['self'];

/**
 * What the touch buttons show, as icons instead of letters. Reload is a circular arrow that fills round as the reload runs
 * and glows when the mag is empty. The ability button shows the ability's own icon with a sweep for its cooldown and the
 * seconds left; before an ability is picked it is not shown at all (a locked thing takes no room; the level-up dock offers the
 * pick when it comes). On a phone on its side the reload
 * button also carries the rounds left in the mag (style.css shows it there), so no count floats beside your soldier.
 */
export type ButtonFaces = {
  reload: { sweep: number; empty: boolean; ammo: string; low: boolean };
  /** Null until an ability is picked: the button hides. */
  ability: { icon: AbilityId; sweep: number; label: string; ready: boolean } | null;
};

/** `_unlockAt` (the score that unlocks an ability) is no longer drawn: a locked ability shows nothing. */
export function buttonFaces(self: SelfView, _unlockAt?: number): ButtonFaces {
  const reload = { sweep: self.reloading ? self.reloadFrac : 0, empty: !self.reloading && self.ammo === 0, ammo: self.reloading ? '' : String(self.ammo), low: !self.reloading && self.ammo <= Math.max(1, Math.round(self.mag * 0.25)) };
  if (!self.ability) return { reload, ability: null };
  const left = Math.max(0, self.abilityReadyIn);
  return {
    reload,
    ability: {
      icon: self.ability,
      sweep: left > 0 ? 1 - Math.min(1, left / abilityCooldownMs(self.ability, self.perks ?? {})) : 0,
      label: left > 0 ? String(Math.ceil(left / 1000)) : '',
      ready: left <= 0,
    },
  };
}

/** Applies faces to the buttons, touching the DOM only when something visible changed. */
export function createTouchButtons(reload: HTMLElement, ability: HTMLElement) {
  const ammo = document.createElement('span');
  ammo.className = 'touch-ammo';
  reload.replaceChildren(iconSvg(UI_ICONS.reload, 'touch-icon'), ammo);
  const icon = document.createElement('span');
  const count = document.createElement('span');
  count.className = 'touch-count';
  ability.replaceChildren(icon, count);
  let shown = '';
  let shownIcon = '';
  return (faces: ButtonFaces) => {
    const r = faces.reload, a = faces.ability;
    const key = `${r.sweep.toFixed(2)}|${r.empty}|${r.ammo}|${r.low}|${a ? `${a.icon}|${a.sweep.toFixed(2)}|${a.label}|${a.ready}` : '-'}`;
    if (key === shown) return;
    shown = key;
    reload.style.setProperty('--sweep', String(r.sweep));
    reload.classList.toggle('busy', r.sweep > 0);
    reload.classList.toggle('empty', r.empty);
    reload.classList.toggle('low', r.low);
    ammo.textContent = r.ammo;
    ability.hidden = a === null;
    if (!a) return;
    if (a.icon !== shownIcon) {
      shownIcon = a.icon;
      icon.replaceChildren(iconSvg(PERK_ICONS[a.icon], 'touch-icon'));
    }
    ability.style.setProperty('--sweep', String(a.sweep));
    ability.classList.toggle('busy', a.sweep > 0);
    ability.classList.toggle('ready', a.ready);
    count.textContent = a.label;
  };
}
