import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { levelState, MAX_LEVEL, PRESTIGE_XP, xpForLevel } from '../src/shared/cosmetics.ts';
import { CHANGELOG, changelogHtml, dayLabel } from '../src/client/changelog.ts';
import { DISCORD_URL } from '../src/client/config.ts';
import { FEEDBACK_EMAIL, feedbackBody, feedbackHref } from '../src/client/contact.ts';
import { applyDiscord, fitLevel, profileHref, REGISTER_PITCH, spillPx, TOP_BTN, TOP_FIT_MAX, topBarItems, topItemClass } from '../src/client/menubar.ts';
import { loadModePick, modeOptions, pickMode, saveModePick } from '../src/client/modepicker.ts';
import { levelBar } from '../src/client/progression.ts';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const ENV = { ua: 'TestBrowser/1.0 (Phone; like Safari)', screen: '932x430 @3x', viewport: '932x370' };

test('the feedback mail goes to halberd8@gmail.com with an encoded subject and a short context body', () => {
  assert.equal(FEEDBACK_EMAIL, 'halberd8@gmail.com');
  const href = feedbackHref('death', { mode: 'TDM', map: 'Wasteland' }, ENV);
  assert.ok(href.startsWith('mailto:halberd8@gmail.com?subject=Tinwar%20feedback&body='), href);
  const body = decodeURIComponent(href.split('&body=')[1]!);
  assert.equal(body, feedbackBody('death', { mode: 'TDM', map: 'Wasteland' }, ENV));
  for (const part of ['Sent from: death card', 'Mode: TDM · Map: Wasteland', 'Screen: 932x430 @3x, window 932x370', 'Browser: TestBrowser/1.0']) assert.ok(body.includes(part), part);
  assert.ok(!/[\s<>@,;:"\r\n]/.test(href.slice('mailto:halberd8@gmail.com?'.length)), 'everything after the address is percent-encoded');
  assert.ok(body.startsWith('\r\n'), 'room to write above the context');
  assert.ok(!feedbackBody('menu', {}, ENV).includes('Mode:'), 'no empty mode line on the menu with nothing picked');
  assert.ok(feedbackBody('pause', {}, { ...ENV, ua: 'x'.repeat(900) }).length < 400, 'a long user agent is cut short');
});

test('the menu footer, death card and pause menu carry the feedback link and the address as text', () => {
  const html = read('public/index.html');
  for (const id of ['menu-feedback', 'death-feedback', 'death-feedback-more']) {
    const tag = html.match(new RegExp(`<a id="${id}"[^>]*>`))?.[0];
    assert.ok(tag, `#${id} exists`);
    assert.match(tag, /href="mailto:halberd8@gmail\.com\?subject=Tinwar%20feedback"/, `#${id} works before the script runs`);
    assert.match(tag, /title="Contact: halberd8@gmail\.com"/);
  }
  assert.match(html, /Contact: halberd8@gmail\.com<\/span>/, 'the address shows as text in the footer');
  assert.match(html, /<footer class="menu-footer">[\s\S]*menu-feedback[\s\S]*privacy\.html[\s\S]*<\/footer>/, 'feedback sits in the footer beside Privacy');
  assert.match(html, /<div class="death-foot">[\s\S]*id="death-feedback"[\s\S]*id="respawn"/, 'desktop: in the death card footer, before Respawn');
  assert.match(html, /<div id="death-more"[\s\S]*id="death-feedback-more"[\s\S]*<\/div>\s*<p id="death-sub"/, 'phone: inside More');
  const css = read('public/menubars.css');
  assert.match(css, /\.death\.compact \.death-feedback \{ display: none; \}/, 'the phone card keeps its button row to More and Try again');
  assert.match(css, /\.death:not\(\.compact\) \.death-contact \{ display: none; \}/, 'no second link on the desktop card');
  const pause = read('src/client/pausemenu.ts');
  assert.match(pause, /feedbackLink\('pause'\)/);
  assert.match(pause, /h\('span', '', FEEDBACK_EMAIL\)/);
  const main = read('src/client/main.ts');
  assert.match(main, /for \(const id of \['menu-feedback', 'death-feedback', 'death-feedback-more'\]\) wireFeedback/, 'every static link gets its context');
});

test('top bar: Log in and Register for a guest, with the reason to register', () => {
  const items = topBarItems(null);
  assert.deepEqual(items.map((i) => i.id), ['top-pitch', 'acct-btn', 'top-register']);
  assert.deepEqual(items.map((i) => ('text' in i ? i.text : '')), [REGISTER_PITCH, 'Log in', 'Register']);
  assert.match(REGISTER_PITCH, /medals & career/);
});

test('top bar: signed in, the name links to your own service record with your level bar, then Account and Log out', () => {
  const xp = xpForLevel(7) + 123;
  const items = topBarItems({ name: 'Ada Lovelace', level: levelState(xp) });
  assert.deepEqual(items.map((i) => i.id), ['top-me', 'acct-btn', 'top-logout']);
  const me = items[0]!;
  assert.equal(me.kind, 'me');
  if (me.kind !== 'me') return;
  assert.equal(me.href, 'profile.html?name=Ada%20Lovelace', 'the same page a profile look-up opens');
  assert.equal(me.href, profileHref('Ada Lovelace'));
  assert.equal(me.level, 7);
  assert.equal(me.label, `123 / ${xpForLevel(8) - xpForLevel(7)} XP`);
  assert.ok(Math.abs(me.pct - 123 / (xpForLevel(8) - xpForLevel(7))) < 1e-9);
  assert.equal(items[1]!.kind === 'chip' && items[1]!.text, 'Account', 'the account sheet (email, reset, stats) stays one tap away');
  assert.match(read('src/client/profile.ts'), /loadAccount\(\)\?\.name\.toLowerCase\(\) === p\.name\.toLowerCase\(\)[\s\S]*href = '\/\?account'/, 'your own record links back to account settings');
  assert.match(read('src/client/main.ts'), /params\.has\('account'\) && account\.current\(\)\) queueMicrotask\(\(\) => \$\('acct-btn'\)\.click\(\)\)/);
});

test('the level bar follows the XP curve at its boundaries, mid-level and past the cap', () => {
  const at = (xp: number) => levelBar(levelState(xp));
  assert.deepEqual([at(0).level, at(0).label, at(0).pct], [1, `0 / ${xpForLevel(2)} XP`, 0]);
  const justShort = at(xpForLevel(2) - 1);
  assert.equal(justShort.level, 1);
  assert.equal(justShort.label, `${xpForLevel(2) - 1} / ${xpForLevel(2)} XP`);
  assert.deepEqual([at(xpForLevel(2)).level, at(xpForLevel(2)).pct], [2, 0], 'a new level starts empty');
  const span = xpForLevel(31) - xpForLevel(30);
  const mid = at(xpForLevel(30) + span / 2);
  assert.equal(mid.level, 30);
  assert.equal(mid.pct, 0.5);
  const cap = at(xpForLevel(MAX_LEVEL));
  assert.deepEqual([cap.level, cap.prestige, cap.max], [MAX_LEVEL, 0, true]);
  const starred = at(xpForLevel(MAX_LEVEL) + 2 * PRESTIGE_XP + 2500);
  assert.deepEqual([starred.level, starred.prestige, starred.pct], [MAX_LEVEL, 2, 0.25]);
  assert.equal(starred.label, `2,500 / ${PRESTIGE_XP.toLocaleString('en-US')} XP to the next star`);
});

test('What\'s new: 10 to 20 plain lines grouped by day, newest first, rendered with every entry', () => {
  const lines = CHANGELOG.flatMap((d) => d.items);
  assert.ok(lines.length >= 10 && lines.length <= 20, `${lines.length} lines`);
  const dates = CHANGELOG.map((d) => d.date);
  assert.deepEqual(dates, [...dates].sort().reverse(), 'newest day first');
  for (const d of dates) assert.match(d, /^\d{4}-\d{2}-\d{2}$/);
  const html = changelogHtml();
  for (const line of lines) assert.ok(html.includes(line.replace(/&/g, '&amp;').replace(/'/g, '&#39;')), line);
  assert.equal((html.match(/<li>/g) ?? []).length, lines.length);
  assert.ok(html.indexOf(dayLabel(dates[0]!)) < html.indexOf(dayLabel(dates.at(-1)!)), 'the newest day renders above the oldest');
  assert.equal(dayLabel('2026-10-09'), 'Oct 9');
  assert.equal(changelogHtml([{ date: '2026-01-02', items: ['<b>&'] }]).includes('&lt;b&gt;&amp;'), true, 'entries are escaped');
  assert.match(read('README.md'), /src\/client\/changelog\.ts/, 'the README tells maintainers to keep it up to date');
});

test('Discord: one constant, and the link stays hidden while it is empty', () => {
  assert.equal(typeof DISCORD_URL, 'string');
  const a = { hidden: false as boolean | string, href: '' };
  applyDiscord(a, '');
  assert.equal(a.hidden, true);
  applyDiscord(a, 'https://discord.gg/abc');
  assert.deepEqual(a, { hidden: false, href: 'https://discord.gg/abc' });
  assert.match(read('public/index.html'), /<a id="menu-discord"[^>]*hidden>/, 'hidden before the script runs too');
});

test('mode picker: rooms in server order then Zombies and the range; the last pick is remembered', () => {
  const rooms = [{ id: 'ffa', mode: 'FFA', players: 18 }, { id: 'tdm', mode: 'TDM', players: 1, humans: 1 }, { id: 'x', mode: 'NOPE', players: 3 }];
  const opts = modeOptions(rooms, null);
  assert.deepEqual(opts.map((o) => o.mode), ['FFA', 'TDM', 'ZOM', 'RNG']);
  assert.deepEqual([opts[0]!.tag, opts[0]!.name, opts[0]!.live], ['FFA', 'Free for all', '18 playing']);
  assert.equal(opts[1]!.detail, '1 player · 1 human');
  assert.equal(modeOptions([], 'ab12').find((o) => o.mode === 'ZOM')!.detail, 'Squad ab12');
  assert.equal(pickMode(opts, null, null), 'FFA', 'the first by default');
  assert.equal(pickMode(opts, null, 'TDM'), 'TDM', 'the one remembered');
  assert.equal(pickMode(opts, 'RNG', 'TDM'), 'RNG', 'what was picked this visit wins');
  assert.equal(pickMode(opts, null, 'BR'), 'FFA', 'a remembered mode no longer offered falls back');
  const mem = new Map<string, string>();
  const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
  saveModePick('ZOM', store);
  assert.equal(loadModePick(store), 'ZOM');
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  assert.doesNotThrow(() => saveModePick('TDM', broken));
  assert.equal(loadModePick(broken), null);
  const html = read('public/index.html');
  assert.match(html, /<button id="mode-trigger"[^>]*aria-haspopup="listbox"/, 'a styled dropdown, not a native select');
  assert.match(html, /id="mode-next"[^>]*><span class="mode-next-label">Next: Loadout</);
  assert.match(html, /<li><button id="crumb-gear"[^>]*><b>2<\/b> Loadout<\/button><\/li>/, 'the steps read Mode, then Loadout');
  assert.match(html, /<h2 id="gear-title" class="step-title">Loadout<\/h2>/);
  assert.match(html, /<div id="menu-backdrop" class="menu-backdrop" aria-hidden="true"><canvas id="menu-scene"/, 'one container behind the menu for its backdrop');
  const main = read('src/client/main.ts');
  assert.match(main, /mountModePicker\(\$\('mode-grid'\), \{\s*next: \(mode\) => \{\s*if \(mode === 'RNG'\) \{ void startRange\(\); return; \}/, 'Next opens the range at once');
  assert.doesNotMatch(main.slice(main.indexOf('mountModePicker($'), main.indexOf('const squadChip')), /requestSubmit/, 'the mode card never deploys by itself: the loadout step\'s Deploy does');
});

test('top bar: every button shares one height class, guest and signed in, and only the guest\'s pitch is plain text', () => {
  const guest = topBarItems(null), me = topBarItems({ name: 'Ada', level: levelState(0) });
  for (const item of [...guest, ...me]) {
    const cls = topItemClass(item).split(' ');
    assert.equal(cls.includes(TOP_BTN), item.kind !== 'pitch', `${item.id}: ${cls.join(' ')}`);
  }
  assert.ok(topItemClass(me[2]!).includes('top-logout') && !topItemClass(me[2]!).includes('link'), 'Log out is a button, not a text link');
  const css = read('public/menubars.css');
  const rule = css.match(/#menu \.menu-auth \.top-btn \{([^}]*)\}/)?.[1] ?? '';
  for (const decl of ['box-sizing: border-box', 'height: var(--top-h)', 'padding: 0 16px', 'align-items: center', 'white-space: nowrap']) assert.ok(rule.includes(decl), decl);
  // No other rule for a top-bar item sets its own height or vertical padding, so nothing can drift off the shared baseline.
  for (const m of css.matchAll(/([^{}]*\.(?:top-me|top-register|top-logout|acct-chip)[^{}]*)\{([^}]*)\}/g)) {
    if (/top-me-|\.acct-lv|::before|\.acct-name/.test(m[1]!)) continue;
    assert.doesNotMatch(m[2]!, /(^|[;\s])height:/, m[1]!);
    for (const pad of m[2]!.matchAll(/(?:^|[;\s])padding:\s*([^;]+)/g)) assert.match(pad[1]!.trim(), /^0(px)? /, `${m[1]!.trim()} keeps vertical padding at 0`);
  }
  assert.match(css, /@media \(max-height: 520px\) and \(min-width: 600px\) \{\s*#menu \{ --top-h: 38px; \}/, 'a phone on its side shares one shorter height');
});

/**
 * A model of the top bar: each piece's width in CSS px at --ui 1, per packing level, as measured in Chrome on a phone on its side
 * (667 to 932 wide), a narrow desktop (up to 1020, where menu.css tightens the tabs) and a desktop. The name chip grows with the name
 * between its min and max widths. The verify run measures the real boxes from 640 to 2560 wide.
 */
const MEASURED = {
  phone: { emblem: 36, logo: 87, tabs: [[79, 82, 111], [79, 82, 111], [76, 78, 107], [76, 78, 107], [64, 67, 93]], login: 69, register: 88, account: 85, logout: 80 },
  narrow: { emblem: 46, logo: 115, tabs: [[86, 89, 123], [86, 89, 123], [82, 85, 117], [82, 85, 117], [70, 73, 103]], login: 83, register: 105, account: 101, logout: 96 },
  desk: { emblem: 46, logo: 133, tabs: [[115, 119, 161], [115, 119, 161], [89, 92, 128], [89, 92, 128], [76, 80, 113]], login: 83, register: 105, account: 101, logout: 96 },
} as const;
function barModel(width: number, regime: keyof typeof MEASURED, signedIn: boolean, nameW: number, level: number) {
  const m = MEASURED[regime], tight = level >= 4 ? 16 : 0;
  const me = Math.min(level >= 4 ? 150 : 230, Math.max(level >= 4 ? 0 : 120, nameW + 60));
  const right = signedIn ? [me, m.account - tight, m.logout - tight] : [...(level >= 1 || regime === 'phone' ? [] : [180]), m.login - tight, m.register - tight];
  const tabs = m.tabs[level]!;
  const gap = level >= 2 || regime !== 'desk' ? 12 : 18, inner = level >= 2 ? 8 : 12, authGap = level >= 4 ? 8 : 10;
  const boxes: { left: number; right: number; top: number; bottom: number }[] = [];
  let x = 0;
  const put = (w: number) => { boxes.push({ left: x, right: x + w, top: 0, bottom: 44 }); x += w; };
  put(m.emblem); x += 12;
  if (level < 3) put(m.logo);
  // The tabs centre in what is left between the wordmark and the right-hand group, as the grid's middle column does.
  const rightW = right.reduce((p, q) => p + q, 0) + authGap * (right.length - 1);
  const tabsW = tabs.reduce((p, q) => p + q, 0) + inner * (tabs.length - 1);
  const free = width - x - gap - rightW - gap;
  x += gap + Math.max(0, (free - tabsW) / 2);
  tabs.forEach((t, i) => { put(t); if (i < tabs.length - 1) x += inner; });
  x = width - rightW;
  right.forEach((w, i) => { put(w); if (i < right.length - 1) x += authGap; });
  return spillPx({ left: 0, right: width }, boxes);
}

test('the top bar packs itself tighter until nothing spills or overlaps, at every width from a phone on its side to 4K', () => {
  assert.equal(fitLevel(() => 0), 0, 'room to spare: everything shows');
  assert.equal(fitLevel((l) => (l < 2 ? 30 : 0)), 2, 'the first level that fits wins');
  assert.equal(fitLevel(() => 50), TOP_FIT_MAX, 'the tightest stands when nothing fits');
  assert.equal(spillPx({ left: 0, right: 100 }, [{ left: 0, right: 101, top: 0, bottom: 10 }]), 0, 'a sub-pixel edge is no spill');
  assert.equal(spillPx({ left: 0, right: 100 }, [{ left: 0, right: 110, top: 0, bottom: 10 }]), 9, 'past the right edge');
  assert.equal(spillPx({ left: 0, right: 100 }, [{ left: 0, right: 50, top: 0, bottom: 10 }, { left: 48, right: 90, top: 0, bottom: 10 }]), 6, 'two buttons touching, plus the 4px gap');
  assert.ok(spillPx({ left: 0, right: 100 }, [{ left: 0, right: 90, top: 0, bottom: 10 }, { left: 0, right: 90, top: 20, bottom: 30 }]) <= 0, 'boxes on different rows do not collide');
  // The bar's width is the viewport less the menu's side padding (20px a side, plus a phone's notch insets), capped at 1180.
  const SCREENS: [number, number, keyof typeof MEASURED][] = [[932, 59, 'phone'], [844, 47, 'phone'], [812, 50, 'phone'], [740, 0, 'phone'], [667, 0, 'phone'], [1000, 0, 'narrow'], [1024, 0, 'desk'], [1280, 0, 'desk'], [1440, 0, 'desk'], [1920, 0, 'desk'], [2560, 0, 'desk']];
  for (const [w, notch, regime] of SCREENS) {
    const bar = Math.min(1180, w - 40 - 2 * notch);
    for (const signedIn of [false, true]) for (const nameW of [40, 70, 170]) {
      const level = fitLevel((l) => barModel(bar, regime, signedIn, nameW, l));
      assert.ok(barModel(bar, regime, signedIn, nameW, level) <= 0, `${w}px (${bar}px bar), ${signedIn ? `signed in, a ${nameW}px name` : 'guest'}: level ${level} fits`);
      if (w >= 1280 && nameW <= 70) assert.equal(level, 0, `${w}px has room for everything`);
    }
  }
});

// ---- The front page held upright. A small model of the cascade: the menu's style sheets, which of their @media blocks apply at a
// given window, and what an exact selector ends up with (source order; the selectors checked here are the ones that set each value).
type Rule = { media: string | null; selectors: string[]; decls: Map<string, string> };
function parseCss(text: string, media: string | null = null, out: Rule[] = []): Rule[] {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, '');
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open < 0) break;
    const head = src.slice(i, open).trim();
    let depth = 1, j = open + 1;
    for (; j < src.length && depth; j++) depth += src[j] === '{' ? 1 : src[j] === '}' ? -1 : 0;
    const body = src.slice(open + 1, j - 1);
    if (head.startsWith('@media')) parseCss(body, head.slice(6).trim(), out);
    else if (!head.startsWith('@')) {
      const decls = new Map<string, string>();
      for (const d of body.split(';')) { const k = d.indexOf(':'); if (k > 0) decls.set(d.slice(0, k).trim(), d.slice(k + 1).replace('!important', '').trim()); }
      out.push({ media, selectors: head.split(',').map((s) => s.trim().replace(/\s+/g, ' ')), decls });
    }
    i = j;
  }
  return out;
}
/** Whether a media query list holds at w x h (width, height and orientation; any other feature, such as reduced motion, reads false). */
function mediaAt(query: string | null, w: number, h: number): boolean {
  if (!query) return true;
  return query.split(',').some((part) => part.trim().split(/\s+and\s+/).every((f) => {
    const m = /^\(\s*([a-z-]+)\s*:\s*([a-z0-9.]+)\s*\)$/.exec(f.trim());
    if (!m) return false;
    const [, name, v] = m as unknown as [string, string, string];
    const n = parseFloat(v);
    switch (name) {
      case 'max-width': return w <= n;
      case 'min-width': return w >= n;
      case 'max-height': return h <= n;
      case 'min-height': return h >= n;
      case 'orientation': return v === (h >= w ? 'portrait' : 'landscape');
      default: return false;
    }
  }));
}
const MENU_CSS = parseCss(['public/style.css', 'public/menu.css', 'public/enlist.css', 'public/menubars.css'].map(read).join('\n'));
const styleAt = (selector: string, w: number, h: number) => {
  const out = new Map<string, string>();
  for (const r of MENU_CSS) if (r.selectors.includes(selector) && mediaAt(r.media, w, h)) for (const [k, v] of r.decls) out.set(k, v);
  return out;
};
const PORTRAIT_WIDTHS = [320, 340, 360, 375, 390, 393, 414, 430, 460, 499];
const PORTRAIT_HEIGHTS = [568, 667, 700, 780, 844, 852, 896, 932];
const CLOSED = '#menu .enlist[data-form="closed"]';

test('portrait: the guest\'s enlist strip never puts its benefits beside its buttons, so nothing in it can overprint', () => {
  assert.ok(mediaAt('(orientation: portrait) and (max-width: 1024px), (max-width: 599px) and (min-height: 521px)', 390, 844), 'the model reads a portrait phone');
  assert.ok(!mediaAt('(max-height: 520px) and (min-width: 600px)', 390, 844));
  for (const w of PORTRAIT_WIDTHS) for (const h of PORTRAIT_HEIGHTS) {
    const at = `${w}x${h}`;
    // The body (benefits and buttons) has no columns of its own: its parts take whole rows of the plate.
    assert.equal(styleAt(`${CLOSED} .enlist-body`, w, h).get('display'), 'contents', `${at}: the body lays out no grid of its own`);
    const plate = styleAt(`${CLOSED} .enlist-plate`, w, h);
    const rows = [...(plate.get('grid-template-areas') ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1]!.trim().split(/\s+/));
    assert.ok(rows.length >= 2, `${at}: the plate names its rows (${plate.get('grid-template-areas')})`);
    for (const row of rows) {
      if (row.includes('perks')) assert.ok(row.every((c) => c === 'perks'), `${at}: the benefits own their row (${row.join(' ')})`);
      if (row.includes('acts')) assert.ok(!row.includes('perks') && !row.includes('head'), `${at}: the buttons share their row with Not now only (${row.join(' ')})`);
    }
    assert.equal(plate.get('grid-template-columns'), 'auto minmax(0, 1fr) auto', `${at}: one flexible column`);
    const perks = styleAt(`${CLOSED} .enlist-perks`, w, h);
    if (perks.get('display') !== 'none') {
      assert.equal(perks.get('grid-template-columns'), 'repeat(2, minmax(0, 1fr))', `${at}: the benefits split the width two by two, never by content`);
      const li = styleAt(`${CLOSED} .enlist-perks li`, w, h);
      assert.equal(li.get('white-space'), 'normal', `${at}: a benefit wraps`);
      assert.equal(li.get('overflow-wrap'), 'anywhere', `${at}: even a long word wraps`);
    } else assert.ok(w < 360, `${at}: the benefits drop out only on the narrowest phones`);
    const actions = styleAt(`${CLOSED} .enlist-actions`, w, h);
    assert.equal(actions.get('display'), 'flex', `${at}: the buttons are a row`);
    assert.equal(actions.get('flex-wrap'), 'wrap', `${at}: that wraps rather than spills`);
  }
  // Wider, below a wide desktop (a tablet on its side, a 1024px laptop), the strip stacks too: one column, benefits over buttons.
  for (const [w, h] of [[1024, 768], [900, 700], [1180, 820]] as const) {
    assert.equal(styleAt(`${CLOSED} .enlist-body`, w, h).get('grid-template-columns'), 'minmax(0, 1fr)', `${w}x${h}: one column`);
    assert.equal(styleAt(`${CLOSED} .enlist-actions`, w, h).get('flex-wrap'), 'wrap', `${w}x${h}: buttons wrap`);
  }
  // A desktop and a phone on its side keep their layout: no portrait rule reaches them.
  for (const [w, h] of [[1440, 900], [1280, 800], [932, 370], [844, 390], [667, 375]] as const) {
    assert.equal(styleAt('#menu .mode-pick', w, h).get('order'), undefined, `${w}x${h}: the mode card keeps its place`);
    assert.equal(styleAt(`${CLOSED} .enlist-body`, w, h).get('display'), undefined, `${w}x${h}: the strip keeps its grid`);
  }
});

test('portrait: the mode card leads, and its dropdown and Next sit above the fold on an iPhone (layout model)', () => {
  const px = (v: string | undefined, fallback = 0) => (v === undefined ? fallback : parseFloat(/(-?[\d.]+)px/.exec(v)?.[1] ?? String(fallback)));
  const box = (v: string | undefined) => { const n = (v ?? '0').split(/\s+/).map((p) => px(p)); return { top: n[0] ?? 0, bottom: n[2] ?? n[0] ?? 0 }; };
  // [width, height, safe top, safe bottom]: an iPhone SE, an iPhone 14 and 15 Pro (with and without the Dynamic Island's insets),
  // Safari's visible part of a 15 Pro behind its bottom bar, and the biggest Pro Max.
  for (const [w, h, st, sb] of [[375, 667, 0, 0], [390, 844, 0, 0], [393, 852, 59, 34], [393, 700, 0, 0], [320, 568, 0, 0], [430, 932, 59, 34]] as const) {
    const at = `${w}x${h}`;
    assert.equal(styleAt('#menu .mode-pick', w, h).get('order'), '1', `${at}: the mode card first`);
    assert.equal(styleAt('#menu .step-modes .enlist', w, h).get('order'), '2', `${at}: the enlist strip under it`);
    assert.equal(styleAt('#menu .mode-pick', w, h).get('margin-top'), '0', `${at}: straight under the bar`);
    const menu = styleAt('#menu', w, h);
    let y = px(menu.get('padding-top')) + st;
    // The bar: a row of --top-h buttons, the row gap, the segmented tabs (their buttons, the well's padding and border), the margin.
    const top = styleAt('#menu .menu-top', w, h), tabs = styleAt('#menu #menu-tabs', w, h);
    y += px(menu.get('--top-h')) + px(top.get('gap')) + px(styleAt('#menu #menu-tabs button', w, h).get('height')) + 2 * px(tabs.get('padding')) + 4 + px(top.get('margin-bottom'));
    // The tip: at most two lines of its text (three at 320px) in a slim strip.
    const tip = styleAt('#menu .a2hs', w, h), tipFont = styleAt('#menu .a2hs p', w, h).get('font') ?? '';
    const [, size, lh] = /(\d+)px\/([\d.]+)/.exec(tipFont) ?? [];
    y += (w < 360 ? 3 : 2) * Number(size) * Number(lh) + box(tip.get('padding')).top + box(tip.get('padding')).bottom + 4 + px(tip.get('margin'));
    // The card: its padding and border, the title row (a crumb is 27px), then the dropdown, the pitch and Next with the card's gap.
    const card = styleAt('#menu .mode-pick', w, h), gap = px(card.get('gap'));
    y += box(card.get('padding')).top + 2 + 4 + 27 + (w < 380 ? 8 + 27 : 0) + gap;
    const trigger = y + px(styleAt('#menu .mode-trigger', w, h).get('min-height'));
    y = trigger + gap + 2.7 * 14 * (w < 340 ? 1.5 : 1) + gap;
    const next = styleAt('#menu button.mode-next', w, h);
    const clamp = /clamp\((\d+)px, ([\d.]+)vw, (\d+)px\)/.exec(next.get('font-size') ?? '');
    assert.ok(clamp, `${at}: Next's type scales with the width`);
    const font = Math.min(Number(clamp![3]), Math.max(Number(clamp![1]), (Number(clamp![2]) * w) / 100));
    const p = box(next.get('padding'));
    const nextBottom = y + 4 + font * 1.1 + p.top + p.bottom + 4 + 9;
    const fold = h - sb;
    assert.ok(trigger <= fold, `${at}: the dropdown ends at ${Math.round(trigger)}px, above the fold at ${fold}px`);
    assert.ok(nextBottom <= fold, `${at}: Next ends at ${Math.round(nextBottom)}px (lip included), above the fold at ${fold}px`);
  }
});
