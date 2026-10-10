import { GUN_IDS, GUNS, isPerkId, PERK_INFO, pickOptions, STREAK, type GunId, type PendingPick, type PerkId } from '../shared/defs.ts';
import type { ClientMsg, Loadout, Snapshot } from '../shared/protocol.ts';
import { deathAct, deathGist, deathView, firstStep, quickRespawn, type DeathAct, type DeathButton, type DeathCtx, type DeathStep } from './deathflow.ts';
import { selfOf } from './derive.ts';
import { chatEntries, type ChatEntry, type MutedNames } from './chatmute.ts';
import { clock, deathScreenArmed, deathText, nextObjectiveSeen, NO_OBJECTIVE_SEEN, OBJECTIVE_MS, objectiveFor, objectiveVisible, roundPodium, roundTimeLeft, seconds } from './derive.ts';
import { serverNow } from './interp.ts';
import { PERK_ICONS, TRAIT_ICONS, iconSvg } from './icons.ts';
import { perkKeyLabel } from './input.ts';
import { $ } from './menu.ts';
import { TEAM_COLORS } from './palette.ts';
import { drawGunCard } from './gunart.ts';
import { GUN_ROLES, TRAITS } from '../shared/roles.ts';
import type { ChatLine, ClientState, Session } from './state.ts';
import { resultTitle } from './royale.ts';
import type { Recap } from './records.ts';
import { outTillDawnText, reportRows, reportTitle, turretLine } from './zombies.ts';

const CHAT_VISIBLE_MS = 15000;

/** Tile labels short enough for a 58px tile. */
const PERK_SHORT: Record<PerkId, string> = {
  optics: 'Optics', thermal: 'Thermal', ghillie: 'Ghillie', piercing: 'Piercing', extended: 'Ext. mag',
  grip: 'Grip', silencer: 'Silencer', lightweight: 'Light', longRange: 'Range', quickReload: 'Reload', choke: 'Choke', shield: 'Shield', thickSkin: 'Thick skin',
  firstAid: 'First aid', fragGrenade: 'Frag', gasGrenade: 'Gas', claymore: 'Claymore', knife: 'Knife',
  engineer: 'Shield', dash: 'Dash', radar: 'Radar', healPole: 'Heal pole',
  marathon: 'Marathon', steadyHands: 'Steady', secondWind: '2nd wind', adrenaline: 'Rush', bloodlust: 'Bloodlust', recon: 'Recon', ninja: 'Ninja',
  overclock: 'Overclock', demolitions: 'Demo', fastHands: 'Hands', tracker: 'Tracker', brace: 'Brace',
};
const CHAT_LINES = 8;
const PERK_DESC_HINT = 'Hover a choice to read what it does.';
const PODIUM_SIZE = 3;

/** `onDeathSend` takes the death card's respawn (with the loadout picked); `loadout` reads the current pick. */
export function createOverlays(onPick: (slot: number) => void, onDeathSend: (msg: ClientMsg) => void, onToggleMute: (name: string) => void, loadout: () => Loadout) {
  const perkPanel = $('perk-panel');
  const chatLog = $('chat-log');
  const chatInput = $<HTMLInputElement>('chat-input');
  const banner = $('banner');
  const objective = $('objective');
  const death = $('death');
  const deathTitle = $('death-title');
  const deathSub = $('death-sub');
  const deathCause = $('death-cause');
  const deathLost = $('death-lost');
  const deathRecap = $('death-recap');
  const deathGistEl = $('death-gist');
  const deathMore = $('death-more');
  const moreToggle = $<HTMLButtonElement>('death-more-toggle');
  const deathBack = $<HTMLButtonElement>('death-back');
  // The XP card's home in the HUD, to put it back after it sat in the compact card's More.
  const xpCardEl = $('xp-card');
  const xpHome = xpCardEl.parentElement, xpHomeNext = xpCardEl.nextElementSibling;
  let recapShown: Recap | null = null;
  let recapCompact = false;
  const respawn = $<HTMLButtonElement>('respawn');
  const report = $('report');
  const deathLoadout = $('loadout-death');
  // The death card's flow (deathflow.ts): its step, whether More is open, and what the buttons do now.
  let compact = false;
  let step: DeathStep = 'all';
  let moreOpen = false;
  let wasDead = false;
  let ctx: DeathCtx = { compact: false, run: false, wait: 0 };
  const buttonActs = new Map<HTMLButtonElement, DeathAct>();
  const press = (act: DeathAct) => {
    const next = deathAct(step, act, ctx, loadout(), moreOpen);
    step = next.step;
    moreOpen = next.moreOpen;
    keys.death = '';
    if (next.send) onDeathSend(next.send);
  };
  for (const b of [respawn, deathBack, moreToggle]) b.onclick = () => { const act = buttonActs.get(b); if (act && !b.disabled) press(act); };
  const showButton = (b: HTMLButtonElement, spec: DeathButton | null) => {
    b.hidden = !spec;
    if (!spec) { buttonActs.delete(b); return; }
    buttonActs.set(b, spec.act);
    b.textContent = spec.label;
    b.disabled = spec.disabled;
  };
  const keys = { perk: '', chat: '', banner: '', death: '', objective: '', report: '' };
  // On a touch screen the dock opens collapsed to a pill, so a level-up never covers the fight until the player taps it open.
  const touchScreen = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  let docked = touchScreen;
  const setDocked = (on: boolean) => { docked = on; perkPanel.classList.toggle('collapsed', on); };
  let objectiveSeen = NO_OBJECTIVE_SEEN;
  let deathAt = -Infinity;

  const perkTile = (perk: PerkId) => {
    const { name, desc } = PERK_INFO[perk];
    const icon = iconSvg(PERK_ICONS[perk], 'perk-icon');
    const label = document.createElement('b');
    label.textContent = PERK_SHORT[perk];
    const line = document.createElement('small');
    line.className = 'perk-line';
    line.textContent = desc;
    return { className: 'perk', name, desc, parts: [icon, label, line] };
  };

  /** An evolution says how it plays: one line of role, and an icon for each thing it changes (hover reads them out). */
  const gunTile = (gun: GunId) => {
    const { name, desc } = GUNS[gun];
    const { role, traits } = GUN_ROLES[gun];
    const art = document.createElement('canvas');
    drawGunCard(art, gun, 108, 34, GUN_IDS.filter((id) => GUNS[id].from === GUNS[gun].from));
    const label = document.createElement('b');
    label.textContent = name;
    const detail = document.createElement('small');
    detail.textContent = role;
    const chips = document.createElement('span');
    chips.className = 'traits';
    chips.append(...traits.map((trait) => {
      const chip = document.createElement('span');
      chip.className = 'trait';
      chip.title = `${TRAITS[trait].label}: ${TRAITS[trait].hint}`;
      const text = document.createElement('i');
      text.textContent = TRAITS[trait].label;
      chip.append(iconSvg(TRAIT_ICONS[trait], 'trait-icon'), text);
      return chip;
    }));
    return { className: 'perk evolve', name, desc: `${desc}. ${traits.map((t) => TRAITS[t].hint).join('; ')}.`, parts: [art, label, detail, chips] };
  };

  const renderPick = (pending: PendingPick | null, gun: GunId) => {
    const key = pending ? `${pending.level}|${gun}` : '';
    if (key === keys.perk) return;
    keys.perk = key;
    perkPanel.hidden = pending === null;
    if (pending === null) return;
    const options = pickOptions(pending, gun);
    const title = document.createElement('h2');
    const hint = document.createElement('span');
    hint.textContent = touchScreen ? ' · tap a choice' : ` · press 1-${perkKeyLabel(options.length - 1)} or click`;
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'perk-toggle';
    toggle.setAttribute('aria-label', 'Hide or show the level-up choices');
    toggle.onclick = (e) => { e.stopPropagation(); setDocked(!docked); };
    title.append(pending.k === 'perk' ? `Level up · tier ${pending.tier} perk` : `Level up · evolve your ${GUNS[gun].name}`, hint, toggle);
    title.onclick = () => { if (docked) setDocked(false); };
    setDocked(docked);
    const desc = document.createElement('p');
    desc.className = 'perk-desc';
    const describe = (tile?: { name: string; desc: string }) => {
      if (!tile) return desc.replaceChildren(PERK_DESC_HINT);
      const name = document.createElement('strong');
      name.textContent = tile.name;
      desc.replaceChildren(name, ` · ${tile.desc}`);
    };
    describe();
    const list = document.createElement('div');
    list.className = 'perk-list';
    options.forEach((option, slot) => {
      const tile = isPerkId(option) ? perkTile(option) : gunTile(option);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = tile.className;
      b.style.setProperty('--i', String(slot));
      b.setAttribute('aria-label', `${tile.name}: ${tile.desc}`);
      const kbd = document.createElement('kbd');
      kbd.textContent = perkKeyLabel(slot);
      b.append(kbd, ...tile.parts);
      b.onclick = () => onPick(slot);
      b.onmouseenter = b.onfocus = () => describe(tile);
      b.onmouseleave = b.onblur = () => describe();
      list.append(b);
    });
    perkPanel.replaceChildren(title, desc, list);
  };

  const sender = (name: string, label: string, title: string) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chat-name';
    b.textContent = label;
    b.title = title;
    // A focused button would also take the Space that triggers the ability.
    b.onmousedown = (e) => e.preventDefault();
    b.onclick = () => onToggleMute(name);
    return b;
  };

  const renderChat = (lines: ChatLine[], muted: MutedNames, selfName: string | undefined, now: number, open: boolean) => {
    const entryAt = (e: ChatEntry) => (e.kind === 'said' ? e.line.at : e.at);
    const shown = chatEntries(lines, muted).slice(-CHAT_LINES).filter((e) => open || now - entryAt(e) < CHAT_VISIBLE_MS);
    const key = `${open}|${[...muted].join('\n')}|${shown.length}|${lines.at(-1)?.at ?? 0}`;
    if (key === keys.chat) return;
    keys.chat = key;
    chatLog.replaceChildren(...shown.map((e) => {
      const li = document.createElement('li');
      if (e.kind === 'muted') {
        const tag = document.createElement('span');
        tag.className = 'muted-tag';
        tag.textContent = 'muted';
        li.className = 'muted-line';
        li.append(sender(e.from, e.from, `Unmute ${e.from}`), tag);
        return li;
      }
      const l = e.line;
      if (!l.from) {
        li.className = 'system';
        li.append(l.text);
        return li;
      }
      const label = `${l.from}: `;
      const who = l.from === selfName ? Object.assign(document.createElement('b'), { textContent: label }) : sender(l.from, label, `Mute ${l.from}`);
      if (l.team) who.style.color = TEAM_COLORS[l.team];
      li.append(who, l.text);
      return li;
    }));
  };

  const renderBanner = (snap: Snapshot) => {
    const { winner, restartIn } = snap.match;
    const { rows: podium, score: teamLine } = roundPodium(snap.match, snap.leaderboard, PODIUM_SIZE);
    const key = winner === null || snap.royale ? '' : `${winner.name}|${winner.note}|${teamLine}|${seconds(restartIn)}|${podium.map((r) => `${r.id}:${r.kills}`).join(',')}`;
    if (key === keys.banner) return;
    keys.banner = key;
    banner.hidden = key === '';
    if (winner === null || key === '') return;
    const h = document.createElement('h2');
    h.textContent = `${winner.name} wins the round`;
    const note = document.createElement('p');
    note.textContent = winner.note ?? '';
    note.hidden = winner.note === null;
    const teamScore = document.createElement('p');
    teamScore.className = 'team-score';
    teamScore.textContent = teamLine ?? '';
    teamScore.hidden = teamLine === null;
    const list = document.createElement('ol');
    list.className = 'podium';
    list.append(...podium.map((r) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = r.name;
      if (r.team) name.style.color = TEAM_COLORS[r.team];
      const score = document.createElement('b');
      score.textContent = String(r.kills);
      li.append(name, score);
      return li;
    }));
    const p = document.createElement('p');
    p.textContent = `Next round in ${seconds(restartIn)}s`;
    banner.replaceChildren(h, note, teamScore, list, p);
  };

  const renderObjective = (state: ClientState, snap: Snapshot, now: number, clockNow: number | null) => {
    const team = snap.players.find((p) => p.id === snap.self.id)?.team ?? null;
    objectiveSeen = nextObjectiveSeen(objectiveSeen, state.phase, snap.match, team, now);
    const show = objectiveVisible(state.phase, snap.match, now - objectiveSeen.at);
    const key = show ? `${objectiveSeen.at}|${snap.match.mode}|${team}` : '';
    if (key === keys.objective) return;
    keys.objective = key;
    objective.hidden = !show;
    if (!show) return;
    objective.textContent = objectiveFor(snap.match.mode, team, roundTimeLeft(snap.match, clockNow)).banner;
    objective.style.animationDuration = `${OBJECTIVE_MS}ms`;
    objective.style.borderColor = team && !snap.run ? TEAM_COLORS[team] : '';
    objective.classList.toggle('siege', !!snap.run);
  };

  const renderResult = (snap: Snapshot) => {
    const result = snap.royale?.result ?? null;
    const { winner, restartIn } = snap.match;
    const key = result ? `${result.place}|${result.of}|${result.kills}|${result.knocks}|${result.revives}|${winner?.name}|${seconds(restartIn)}` : '';
    if (key === keys.report) return;
    keys.report = key;
    report.hidden = !result;
    if (!result) return;
    report.classList.toggle('won', result.place === 1);
    const h = document.createElement('h2');
    h.textContent = resultTitle(result);
    const table = document.createElement('table');
    const head = document.createElement('tr');
    const row = document.createElement('tr');
    row.className = 'you';
    for (const [label, v] of [['Kills', result.kills], ['Knocks', result.knocks], ['Revives', result.revives]] as const) {
      head.append(Object.assign(document.createElement('th'), { textContent: label }));
      row.append(Object.assign(document.createElement('td'), { textContent: String(v) }));
    }
    table.append(head, row);
    const next = document.createElement('p');
    next.textContent = winner ? `${winner.name} wins · next match in ${seconds(restartIn)}s` : 'Your squad is out · watching the rest of the match';
    report.replaceChildren(h, table, next);
  };

  const renderReport = (snap: Snapshot, clockNow: number | null) => {
    if (snap.royale) { renderResult(snap); return; }
    const run = snap.run;
    const done = run?.phase === 'over' && run.report ? run.report : null;
    const left = done && run?.phaseEndsAt != null && clockNow !== null ? seconds(run.phaseEndsAt - clockNow) : null;
    const key = done ? `${done.won}|${done.night}|${left}|${done.players.map((p) => `${p.name}:${p.kills}:${p.revives}:${p.built}`).join(',')}|${turretLine(done)}` : '';
    if (key === keys.report) return;
    keys.report = key;
    report.hidden = !done;
    if (!done) return;
    report.classList.toggle('won', done.won);
    const h = document.createElement('h2');
    h.textContent = reportTitle(done);
    const length = document.createElement('p');
    length.textContent = `The run lasted ${clock(done.durationMs)}`;
    const table = document.createElement('table');
    const head = document.createElement('tr');
    for (const label of ['Player', 'Kills', 'Revives', 'Built']) head.append(Object.assign(document.createElement('th'), { textContent: label }));
    table.append(head, ...reportRows(done, snap.players.find((p) => p.id === snap.self.id)?.name).map((r) => {
      const tr = document.createElement('tr');
      if (r.you) tr.className = 'you';
      for (const v of [r.name, r.kills, r.revives, r.built]) tr.append(Object.assign(document.createElement('td'), { textContent: String(v) }));
      return tr;
    }));
    const turrets = turretLine(done);
    const next = document.createElement('p');
    next.textContent = left === null ? 'A fresh run starts soon' : `Next run in ${left}s`;
    report.replaceChildren(h, length, table, ...(turrets ? [Object.assign(document.createElement('p'), { textContent: turrets })] : []), next);
  };

  const renderDeath = (state: ClientState, snap: Snapshot, now: number) => {
    const dead = state.phase === 'dead';
    if (dead && !wasDead) { deathAt = now; step = firstStep(compact); moreOpen = false; }
    wasDead = dead;
    const inert = dead && !deathScreenArmed(deathAt, now);
    if (death.inert !== inert) death.inert = inert;
    const wait = seconds(snap.self.respawnIn);
    const run = snap.run;
    ctx = { compact, run: !!run, wait };
    const view = deathView(step, ctx, moreOpen);
    // On a phone the XP card folds into More (deathflow.ts `xpInMore`), under the tiles; More wears a gold pip while it waits there.
    const xpDocked = dead && !snap.royale && view.xpInMore;
    if (xpDocked !== (xpCardEl.parentElement === deathMore)) {
      if (xpDocked) deathMore.insertBefore(xpCardEl, deathMore.querySelector('.death-enlist'));
      else xpHome?.insertBefore(xpCardEl, xpHomeNext);
    }
    moreToggle.classList.toggle('has-xp', xpDocked && !xpCardEl.hidden && !moreOpen);
    const key = dead ? `${state.kill?.killer}|${state.kill?.weapon}|${wait}|${run?.phase}|${run?.waveLeft}|${view.step}|${moreOpen}|${compact}` : '';
    if (key === keys.death) return;
    keys.death = key;
    death.hidden = !dead || !!snap.royale;
    if (!dead || snap.royale) return;
    death.dataset.step = view.step;
    death.classList.toggle('compact', compact);
    deathTitle.hidden = !view.title;
    deathLoadout.hidden = !view.loadout;
    deathMore.hidden = !view.recap;
    deathSub.hidden = !view.sub;
    showButton(respawn, view.primary);
    showButton(deathBack, view.secondary);
    showButton(moreToggle, view.more ? { label: moreOpen ? 'Less' : 'More', act: 'more', disabled: false } : null);
    moreToggle.setAttribute('aria-expanded', String(moreOpen));
    if (run) {
      // Dawn gets everyone up, so a death this run can only be tonight's bleed-out; a night joiner has none.
      const text = outTillDawnText(run, snap.self.deaths > 0, snap.self.respawnIn);
      deathTitle.textContent = text.title;
      deathSub.textContent = text.sub;
      deathCause.hidden = deathLost.hidden = deathRecap.hidden = deathGistEl.hidden = true;
      return;
    }
    if (state.recap !== recapShown || compact !== recapCompact) {
      recapShown = state.recap;
      recapCompact = compact;
      const killer = state.kill?.killerId !== null && state.kill?.killerId !== state.s.myId ? state.kill?.killer ?? null : null;
      const human = snap.players.find((p) => p.id === state.kill?.killerId)?.kind === 'human';
      renderRecap(deathRecap, state.recap, killer, human, compact);
    }
    const text = deathText(state.kill, state.loss);
    deathTitle.textContent = text.title;
    deathCause.textContent = text.cause;
    deathCause.hidden = !text.cause || !view.title;
    deathLost.textContent = text.lost;
    deathLost.hidden = !text.lost;
    const gist = deathGist(state.recap);
    deathGistEl.textContent = gist;
    deathGistEl.hidden = !view.gist || !gist;
    deathSub.textContent = wait > 0 ? `Respawn in ${wait}s. Change your loadout below.` : 'Ready. Change your loadout or press Space to jump back in.';
  };

  return {
    get typing() { return !chatInput.hidden; },
    openChat() {
      chatInput.hidden = false;
      chatInput.value = '';
      chatInput.focus();
    },
    closeChat(): string {
      const text = chatInput.value.trim();
      chatInput.value = '';
      chatInput.hidden = true;
      chatInput.blur();
      return text;
    },
    /** A phone on its side gets the stepped death card (deathflow.ts); set from the page's size. */
    setCompact(on: boolean) {
      if (on === compact) return;
      compact = on;
      keys.death = '';
    },
    /** Space on an open, armed death card: respawn with the same loadout. False when it is not the card's to take. */
    quickRespawn(now: number): boolean {
      // Not while the killcam holds the card back or settles (its own key handler takes that press to skip).
      const held = ['dl-hold', 'dl-play', 'dl-settle'].some((c) => document.body.classList.contains(c));
      if (death.hidden || death.inert || held || !deathScreenArmed(deathAt, now)) return false;
      const msg = quickRespawn(ctx, loadout());
      if (msg) onDeathSend(msg);
      return true;
    },
    update(state: ClientState, s: Session, snap: Snapshot, now: number, muted: MutedNames) {
      const pending = snap.self.pending;
      const gun = selfOf(snap)?.gun;
      perkPanel.classList.toggle('siege', !!snap.run);
      // Build mode takes the number keys and the strip above the hints, so the dock waits until it is done.
      renderPick(state.phase === 'playing' && !s.building && gun && pending?.level !== s.pickSentFor ? pending : null, gun ?? 'pistol');
      const selfName = snap.players.find((p) => p.id === snap.self.id)?.name ?? snap.leaderboard.find((r) => r.id === snap.self.id)?.name;
      renderChat(s.chat, muted, selfName, now, !chatInput.hidden);
      renderBanner(snap);
      renderObjective(state, snap, now, serverNow(s.snaps, now));
      renderDeath(state, snap, now);
      renderReport(snap, serverNow(s.snaps, now));
    },
    reset() {
      keys.perk = keys.chat = keys.banner = keys.death = keys.objective = keys.report = '';
      wasDead = false;
      objectiveSeen = NO_OBJECTIVE_SEEN;
      perkPanel.hidden = banner.hidden = death.hidden = objective.hidden = report.hidden = true;
      chatLog.replaceChildren();
      chatInput.hidden = true;
    },
  };
}

/** The life just lost as a row of stat tiles, each stamped when it set a record, then the records and who to take revenge on. */
function renderRecap(el: HTMLElement, recap: Recap | null, nemesis: string | null, nemesisHuman: boolean, compact: boolean) {
  el.hidden = !recap;
  if (!recap) return;
  const tiles = recap.stats.map((s, i) => {
    const tile = Object.assign(document.createElement('div'), { className: s.best ? 'recap-stat best' : 'recap-stat' });
    tile.style.setProperty('--i', String(i));
    tile.append(
      Object.assign(document.createElement('b'), { textContent: s.value }),
      Object.assign(document.createElement('span'), { textContent: s.label }),
    );
    if (s.best) tile.append(Object.assign(document.createElement('i'), { textContent: 'New best' }));
    return tile;
  });
  const row = Object.assign(document.createElement('div'), { className: 'recap-row' });
  row.append(...tiles);
  const b = recap.bests;
  const best = Object.assign(document.createElement('p'), {
    className: 'recap-bests',
    textContent: `Your best · ${b.kills} kills · ${Math.round(b.damage).toLocaleString('en-US')} damage · level ${b.level}`,
  });
  const lines: HTMLElement[] = [row, best];
  if (nemesis) {
    // On a phone the line is as short as it can be: who, and what revenge pays.
    const line = Object.assign(document.createElement('p'), { className: 'recap-nemesis', textContent: compact ? `Nemesis ${nemesis} · +${STREAK.revengeScore} revenge ` : `${nemesis} is your nemesis now. Kill them for +${STREAK.revengeScore}. ` });
    // A human killer has a service record worth a look; bots keep none.
    if (nemesisHuman) line.append(Object.assign(document.createElement('a'), { href: `profile.html?name=${encodeURIComponent(nemesis)}`, target: '_blank', rel: 'noopener', textContent: 'Their record ›' }));
    lines.push(line);
  }
  el.replaceChildren(...lines);
}
