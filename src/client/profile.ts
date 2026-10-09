import { badgeKey, CAREER, CAREER_IDS, KM_PX, MEDAL_IDS, MEDALS, type Badge, type CareerId, type MedalId, type WeaponId } from '../shared/defs.ts';
import { careerArt, careerName, careerTooltip, medalArt, medalSvg } from './medals.ts';
import { trackRootScale } from './uiscale.ts';
import { loadAccount } from './api.ts';
import { COSMETIC_BY_ID, SLOTS, type Slot } from '../shared/cosmetics.ts';
import { COLORS, COLOR_IDS, type ColorId } from '../shared/defs.ts';
import { hash32 } from '../shared/cosmetics.ts';
import { lookOfEquipped, RARITY_INK } from './cosmeticlook.ts';
import { renderLevelCard, starsHtml } from './levelcard.ts';
import { collectionCounts, parseProfile, SLOT_LABEL } from './progression.ts';
import { drawPreview } from './preview.ts';
import { reducedMotion } from './screenfx.ts';

/**
 * A player's profile page (profile.html?name=...): their worn medal and career numbers, every lifetime track with the
 * highest rung reached and progress to the next, and every match medal with how often they have earned it.
 */
type ProfileJson = {
  name: string; kills: number; deaths: number; games: number; bestStreak: number; distance: number;
  medals: Partial<Record<MedalId, number>>; weaponKills?: Partial<Record<WeaponId, number>>; badges: Record<string, number>; firstSeen: number; featured: Badge | null;
};

const $ = (id: string) => document.getElementById(id)!;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
};

function count(p: ProfileJson, track: CareerId): number {
  const needs = CAREER[track].needs;
  if (needs === 'km') return Math.floor(p.distance / KM_PX);
  if (needs === 'kills' || needs === 'games' || needs === 'bestStreak') return p[needs];
  if (needs.startsWith('kills:')) return p.weaponKills?.[needs.slice(6) as WeaponId] ?? 0;
  return p.medals[needs as MedalId] ?? 0;
}

function trackCard(p: ProfileJson, track: CareerId): HTMLElement {
  const def = CAREER[track];
  const have = count(p, track);
  const top = [3, 2, 1, 0].find((t) => p.badges[badgeKey({ track, tier: t as Badge['tier'] })] !== undefined);
  const card = el('div', `career-card${top === undefined ? ' locked' : ''}`);
  const shown: Badge = { track, tier: (top ?? 0) as Badge['tier'] };
  card.innerHTML = medalSvg(careerArt(shown), 96, careerName(shown));
  card.append(el('b', '', top === undefined ? def.name : careerName(shown)));
  const next = def.at.find((n) => have < n);
  const line = el('span', 'career-line', next === undefined ? `Maxed · ${have.toLocaleString('en-US')} ${def.unit}` : `${have.toLocaleString('en-US')} / ${next.toLocaleString('en-US')} ${def.unit}`);
  const bar = el('i', 'career-bar');
  const from = top === undefined ? 0 : def.at[top]!;
  bar.style.setProperty('--v', next === undefined ? '100%' : `${Math.round(((have - from) / (next - from)) * 100)}%`);
  card.append(line, bar);
  card.title = careerTooltip(track, top === undefined ? undefined : { tier: shown.tier, at: p.badges[badgeKey(shown)]! });
  return card;
}

function medalCard(p: ProfileJson, id: MedalId): HTMLElement {
  const n = p.medals[id] ?? 0;
  const card = el('div', `medal-card${n ? '' : ' locked'}`);
  card.innerHTML = medalSvg(medalArt(id), 72, MEDALS[id].name);
  card.append(el('b', '', MEDALS[id].name), el('span', 'medal-count', `×${n.toLocaleString('en-US')}`));
  card.title = `${MEDALS[id].desc} · +${MEDALS[id].score}`;
  return card;
}

let previewRaf = 0;
/** The level bar, the equipped look on a live soldier, and how much of each slot's collection this player holds. */
function renderLocker(raw: unknown) {
  const prof = parseProfile(raw);
  cancelAnimationFrame(previewRaf);
  if (!prof) return;
  renderLevelCard($('profile-level'), { level: { level: prof.level, prestige: prof.prestige, xpInLevel: prof.xpInLevel, xpToNext: prof.xpToNext } });
  const look = lookOfEquipped(prof.equipped);
  // A player's soldier colour is theirs to pick in the menu and is not on record, so each name gets a steady one of its own.
  const color: ColorId = COLOR_IDS[hash32(prof.name.toLowerCase()) % COLOR_IDS.length]!;
  const canvas = $('profile-view') as HTMLCanvasElement;
  const frame = (now: number) => {
    const calm = reducedMotion();
    drawPreview(canvas, { look, color: COLORS[color], gun: 'assault', aim: Math.PI * 0.08 + (calm ? 0 : Math.sin(now / 1700) * 0.4), now: calm ? 0 : now, scale: 2.2, at: { x: 0.45, y: 0.56 }, walking: !calm && look.helmet === 'h_propeller' });
    if (!calm) previewRaf = requestAnimationFrame(frame);
  };
  previewRaf = requestAnimationFrame(frame);
  $('wear-list').replaceChildren(...SLOTS.map((slot: Slot) => {
    const c = COSMETIC_BY_ID.get(prof.equipped[slot])!;
    const li = el('li');
    li.style.setProperty('--rc', RARITY_INK[c.rarity]);
    li.append(el('small', '', SLOT_LABEL[slot]), el('b', '', c.name));
    return li;
  }));
  const counts = collectionCounts(new Set(prof.unlocked));
  let have = 0, total = 0;
  $('collection').replaceChildren(...SLOTS.map((slot) => {
    const { have: h, total: t } = counts[slot];
    have += h; total += t;
    const d = el('div');
    const n = el('span', '', String(h));
    n.append(el('small', '', ` / ${t}`));
    d.append(el('b', '', SLOT_LABEL[slot]), n);
    return d;
  }));
  $('collection-count').textContent = `${have} of ${total}`;
  void starsHtml;
}

function render(p: ProfileJson) {
  document.title = `${p.name} · Tinwar`;
  const head = $('profile-head');
  head.replaceChildren();
  const worn = el('div', 'profile-worn');
  if (p.featured) worn.innerHTML = medalSvg(careerArt(p.featured), 132, careerName(p.featured));
  if (p.featured) worn.title = careerTooltip(p.featured.track, { tier: p.featured.tier, at: p.badges[badgeKey(p.featured)] ?? p.firstSeen });
  const who = el('div', 'profile-who');
  const lvl = (p as unknown as { level?: number }).level;
  const stars = (p as unknown as { prestige?: number }).prestige ?? 0;
  const sub = el('p', 'profile-sub', `${lvl ? `Level ${lvl}${stars ? ` · ${stars} star${stars === 1 ? '' : 's'}` : ''} · ` : ''}${p.featured ? `Wears ${careerName(p.featured)}` : 'No lifetime medal yet'}`);
  who.append(el('h1', 'profile-name', p.name), sub);
  // Your own record (from the menu's name chip): a way back to the account sheet, where its settings live.
  if (loadAccount()?.name.toLowerCase() === p.name.toLowerCase()) {
    const settings = el('a', 'profile-settings', 'Account settings ›');
    settings.id = 'profile-settings';
    (settings as HTMLAnchorElement).href = '/?account';
    who.append(settings);
  }
  head.append(worn, who);
  const kd = p.deaths ? (p.kills / p.deaths).toFixed(2) : String(p.kills);
  const stats: [string, string][] = [
    ['Kills', p.kills.toLocaleString('en-US')], ['Deaths', p.deaths.toLocaleString('en-US')], ['K/D', kd],
    ['Matches', p.games.toLocaleString('en-US')], ['Best streak', String(p.bestStreak)], ['Walked', `${(p.distance / KM_PX).toFixed(1)} km`],
  ];
  $('profile-stats').replaceChildren(...stats.map(([label, value]) => {
    const d = el('div');
    d.append(el('dt', '', label), el('dd', '', value));
    return d;
  }));
  renderLocker(p);
  const earned = Object.keys(p.badges).length;
  $('career-count').textContent = `${earned} of ${CAREER_IDS.length * 4}`;
  $('career').replaceChildren(...CAREER_IDS.map((t) => trackCard(p, t)));
  $('medal-grid').replaceChildren(...MEDAL_IDS.map((id) => medalCard(p, id)));
}

/** Bumped by every look-up, so an answer to an older one that arrives late never paints over the newer. */
let loadSeq = 0;
async function load(name: string) {
  const seq = ++loadSeq;
  // The last soldier's preview stops with its page hidden.
  cancelAnimationFrame(previewRaf);
  $('profile-status').textContent = 'Loading…';
  $('profile-body').hidden = true;
  try {
    const res = await fetch(`/api/profile/${encodeURIComponent(name)}`);
    if (seq !== loadSeq) return;
    if (res.status === 404) {
      const mine = loadAccount()?.name.toLowerCase() === name.toLowerCase();
      $('profile-status').textContent = mine ? 'Your record starts with your first match. Play one and it shows here.' : `No one called ${name} has played yet.`;
      return;
    }
    if (!res.ok) throw new Error(String(res.status));
    const body = await res.json() as ProfileJson;
    if (seq !== loadSeq) return;
    render(body);
    $('profile-status').textContent = '';
    $('profile-body').hidden = false;
  } catch (err) {
    if (seq !== loadSeq) return;
    console.error('profile page', String(err), (err as Error)?.stack);
    $('profile-status').textContent = 'Could not load the profile. Try again in a moment.';
  }
}

const form = $('profile-search') as HTMLFormElement;
const input = $('profile-name-input') as HTMLInputElement;
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = input.value.trim();
  if (!name) return;
  history.replaceState(null, '', `?name=${encodeURIComponent(name)}`);
  void load(name);
});
const asked = new URLSearchParams(location.search).get('name');
if (asked) { input.value = asked; void load(asked); } else $('profile-status').textContent = 'Look up a player by name.';
trackRootScale();
