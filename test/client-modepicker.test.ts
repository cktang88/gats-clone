/// <reference types="node" />
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { listboxAria, listboxKey, loadModePick, modeOptions, mountModePicker, nextLabel, TYPE_AHEAD_MS, typeAhead, type ListState } from '../src/client/modepicker.ts';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const ROOMS = [{ id: 'ffa', mode: 'FFA', players: 18 }, { id: 'tdm', mode: 'TDM', players: 12 }, { id: 'dom', mode: 'DOM', players: 9 }, { id: 'br', mode: 'BR', players: 18 }];
const OPTS = modeOptions(ROOMS, null);
const NAMES = OPTS.map((o) => o.name);
const TAGS = OPTS.map((o) => o.tag);
const closed = (selected = 0): ListState => ({ open: false, active: selected, selected, typed: '', typedAt: 0 });

test('the dropdown offers every fight with its chip, name, one-line pitch and who is in', () => {
  assert.deepEqual(TAGS, ['FFA', 'TDM', 'DOM', 'BR', 'ZOM', 'RANGE']);
  assert.deepEqual(NAMES, ['Free for all', 'Team deathmatch', 'Domination', 'Last standing', 'Zombies squad', 'Shooting range']);
  assert.deepEqual(OPTS.map((o) => o.live), ['18 playing', '12 playing', '9 playing', '18 playing', 'Up to 4', 'Just you']);
  for (const o of OPTS) assert.ok(o.pitch.length > 20 && !o.pitch.includes('\n'), `${o.mode} has a one-line pitch`);
  assert.equal(modeOptions(ROOMS, 'z-abcdef').find((o) => o.mode === 'ZOM')!.live, 'Squad z-abcdef');
  assert.equal(nextLabel('BR'), 'Next: Loadout', 'every fight goes on to its loadout');
  assert.equal(nextLabel('ZOM'), 'Next: Loadout');
  assert.equal(nextLabel('RNG'), 'Open the range', 'the range has no loadout step');
});

test('closed, the button opens the list on the chosen option with arrows, Enter or Space, and Home and End jump to the ends', () => {
  for (const key of ['ArrowDown', 'ArrowUp', 'Enter', ' ']) {
    const step = listboxKey(closed(3), key, NAMES, TAGS, 1000);
    assert.equal(step.state.open, true, key);
    assert.equal(step.state.active, 3, `${key} opens on the chosen option`);
    assert.equal(step.focus, 'list', 'focus moves into the list');
    assert.equal(step.handled, true);
    assert.equal(step.commit, undefined, 'opening chooses nothing');
  }
  assert.equal(listboxKey(closed(3), 'Home', NAMES, TAGS, 0).state.active, 0);
  assert.equal(listboxKey(closed(3), 'End', NAMES, TAGS, 0).state.active, 5);
  assert.equal(listboxKey(closed(3), 'Escape', NAMES, TAGS, 0).handled, false, 'Esc on the closed button is left to the menu (it goes back)');
  assert.equal(listboxKey(closed(3), 'Tab', NAMES, TAGS, 0).handled, false, 'Tab moves on as usual');
});

test('open, arrows move without wrapping, Enter and Space choose and close, Esc closes without choosing, Tab chooses and moves on', () => {
  let s: ListState = { ...closed(1), open: true };
  s = listboxKey(s, 'ArrowDown', NAMES, TAGS, 0).state;
  s = listboxKey(s, 'ArrowDown', NAMES, TAGS, 0).state;
  assert.equal(s.active, 3);
  assert.equal(s.selected, 1, 'moving is not choosing');
  assert.equal(listboxKey({ ...s, active: 5 }, 'ArrowDown', NAMES, TAGS, 0).state.active, 5, 'stops at the last');
  assert.equal(listboxKey({ ...s, active: 0 }, 'ArrowUp', NAMES, TAGS, 0).state.active, 0, 'stops at the first');
  assert.equal(listboxKey(s, 'End', NAMES, TAGS, 0).state.active, 5);
  assert.equal(listboxKey(s, 'Home', NAMES, TAGS, 0).state.active, 0);
  for (const key of ['Enter', ' ']) {
    const pick = listboxKey(s, key, NAMES, TAGS, 0);
    assert.deepEqual([pick.commit, pick.state.open, pick.state.selected, pick.focus, pick.handled], [3, false, 3, 'trigger', true], key);
  }
  const esc = listboxKey(s, 'Escape', NAMES, TAGS, 0);
  assert.deepEqual([esc.commit, esc.state.open, esc.state.selected, esc.state.active, esc.focus, esc.handled], [undefined, false, 1, 1, 'trigger', true]);
  const tab = listboxKey(s, 'Tab', NAMES, TAGS, 0);
  assert.deepEqual([tab.commit, tab.state.open, tab.handled], [3, false, false], 'Tab chooses, closes and lets focus move on');
});

test('type-ahead jumps by name (or chip), a word typed quickly narrows, one letter again cycles, and a pause starts over', () => {
  assert.equal(typeAhead(NAMES, TAGS, 0, 'd'), 2, 'Domination');
  assert.equal(typeAhead(NAMES, TAGS, 0, 'sh'), 5, 'Shooting range');
  assert.equal(typeAhead(NAMES, TAGS, 0, 'rang'), 5, 'RANGE, by its chip');
  assert.equal(typeAhead(NAMES, TAGS, 0, 'q'), -1, 'no match stays put');
  let s: ListState = { ...closed(0), open: true };
  s = listboxKey(s, 't', NAMES, TAGS, 100).state;
  assert.equal(s.active, 1, 'T: Team deathmatch');
  s = listboxKey(s, 'l', NAMES, TAGS, 100 + TYPE_AHEAD_MS + 1).state;
  assert.equal(s.active, 3, 'after a pause, L: Last standing');
  s = listboxKey(s, 'a', NAMES, TAGS, 100 + TYPE_AHEAD_MS + 50).state;
  assert.equal(s.typed, 'la');
  assert.equal(s.active, 3);
  s = listboxKey(s, ' ', NAMES, TAGS, 100 + TYPE_AHEAD_MS + 90).state;
  assert.equal(s.open, true, 'a space inside a typed word is part of the word, not a choice');
  const names = ['Alpha', 'Bravo', 'Able', 'Ace'], tags = ['A1', 'B1', 'A2', 'A3'];
  s = { ...closed(0), open: true };
  for (const [i, want] of [[0, 2], [1, 3], [2, 0], [3, 2]] as const) {
    s = listboxKey(s, 'a', names, tags, 1000 + i * 100).state;
    assert.equal(s.active, want, `A pressed ${i + 1} times`);
  }
  const shut = listboxKey(closed(0), 'z', NAMES, TAGS, 50);
  assert.deepEqual([shut.state.open, shut.state.active, shut.focus], [true, 4, 'list'], 'typing on the closed button opens it on the match');
});

test('the ARIA follows the state: aria-expanded on the button, aria-activedescendant on the list, aria-selected on the chosen option', () => {
  const ids = OPTS.map((o) => `mode-opt-${o.mode.toLowerCase()}`);
  const shut = listboxAria(closed(2), ids);
  assert.equal(shut.trigger['aria-expanded'], 'false');
  assert.equal(shut.list['aria-activedescendant'], '');
  assert.deepEqual(shut.options.map((o) => o['aria-selected']), ['false', 'false', 'true', 'false', 'false', 'false']);
  const open = listboxAria({ ...closed(2), open: true, active: 4 }, ids);
  assert.equal(open.trigger['aria-expanded'], 'true');
  assert.equal(open.list['aria-activedescendant'], 'mode-opt-zom');
  assert.deepEqual(open.options.map((o) => o.active), [false, false, false, false, true, false]);
});

// ---- the mounted dropdown, on just enough DOM ----

type Ev = { key?: string; target?: FakeEl; altKey?: boolean; metaKey?: boolean; ctrlKey?: boolean; pointerType?: string; relatedTarget?: FakeEl | null; defaultPrevented?: boolean; stopped?: boolean };
class FakeEl {
  id = ''; hidden = false; disabled = false; parent: FakeEl | null = null; kids: (FakeEl | string)[] = [];
  attrs = new Map<string, string>(); dataset: Record<string, string> = {}; style: Record<string, string> = {}; cls = new Set<string>();
  on = new Map<string, ((e: Ev) => void)[]>();
  offsetHeight = 0; scrollHeight = 0;
  tagName: string;
  private doc: FakeDoc;
  constructor(tagName: string, doc: FakeDoc) { this.tagName = tagName; this.doc = doc; }
  get className() { return [...this.cls].join(' '); }
  set className(v: string) { this.cls = new Set(v.split(/\s+/).filter(Boolean)); }
  classList = { add: (c: string) => void this.cls.add(c), remove: (c: string) => void this.cls.delete(c), contains: (c: string) => this.cls.has(c), toggle: (c: string, on?: boolean) => { const v = on ?? !this.cls.has(c); if (v) this.cls.add(c); else this.cls.delete(c); return v; } };
  get children() { return this.kids.filter((k): k is FakeEl => typeof k !== 'string'); }
  get lastChild() { const k = this.kids[this.kids.length - 1]; return k === undefined ? null : { textContent: typeof k === 'string' ? k : k.textContent }; }
  get textContent(): string { return this.kids.map((k) => (typeof k === 'string' ? k : k.textContent)).join(''); }
  set textContent(v: string) { this.kids = [v]; }
  append(...kids: (FakeEl | string)[]) { for (const k of kids) { if (typeof k !== 'string') k.parent = this; this.kids.push(k); } }
  prepend(...kids: (FakeEl | string)[]) { this.kids.unshift(...kids); }
  replaceChildren(...kids: (FakeEl | string)[]) { this.kids = []; this.append(...kids); }
  setAttribute(k: string, v: string) { this.attrs.set(k, v); }
  getAttribute(k: string) { return this.attrs.get(k) ?? null; }
  removeAttribute(k: string) { this.attrs.delete(k); }
  addEventListener(type: string, fn: (e: Ev) => void) { this.on.set(type, [...(this.on.get(type) ?? []), fn]); }
  fire(type: string, e: Ev = {}) {
    const ev: Ev = { ...e, target: e.target ?? this };
    const full = Object.assign(ev, { preventDefault() { ev.defaultPrevented = true; }, stopPropagation() { ev.stopped = true; } });
    for (let n: FakeEl | null = this; n && !ev.stopped; n = n.parent) for (const fn of n.on.get(type) ?? []) fn(full);
    if (!ev.stopped) for (const fn of this.doc.on.get(type) ?? []) fn(full);
    return ev;
  }
  matches(sel: string): boolean {
    if (sel.startsWith('.')) return this.cls.has(sel.slice(1));
    if (sel.startsWith('#')) return this.id === sel.slice(1);
    const m = sel.match(/^\[(\w+)="(.*)"\]$/);
    return !!m && this.getAttribute(m[1]!) === m[2];
  }
  closest(sel: string): FakeEl | null { for (let n: FakeEl | null = this; n; n = n.parent) if (n.matches(sel)) return n; return null; }
  querySelectorAll(sel: string): FakeEl[] { return this.children.flatMap((c) => [...(c.matches(sel) ? [c] : []), ...c.querySelectorAll(sel)]); }
  querySelector(sel: string) { return this.querySelectorAll(sel)[0] ?? null; }
  contains(n: FakeEl | null): boolean { for (let p = n; p; p = p.parent) if (p === this) return true; return false; }
  focus() { this.doc.activeElement = this; }
  getBoundingClientRect() { return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }; }
  scrollIntoView() {}
}
class FakeDoc {
  activeElement: FakeEl | null = null;
  on = new Map<string, ((e: Ev) => void)[]>();
  byId = new Map<string, FakeEl>();
  createElement(tag: string) { return new FakeEl(tag, this); }
  getElementById(id: string) { return this.byId.get(id) ?? null; }
  addEventListener(type: string, fn: (e: Ev) => void) { this.on.set(type, [...(this.on.get(type) ?? []), fn]); }
  removeEventListener(type: string, fn: (e: Ev) => void) { this.on.set(type, (this.on.get(type) ?? []).filter((f) => f !== fn)); }
}

/** The mode card's markup (index.html) on the fake DOM, with a fake localStorage; returns the parts and a restore. */
function mountFake(saved: string | null) {
  const g = globalThis as Record<string, unknown>;
  const before = { document: g.document, localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'), addEventListener: g.addEventListener, innerHeight: g.innerHeight, innerWidth: g.innerWidth };
  const doc = new FakeDoc();
  const store = new Map<string, string>(saved ? [['tinwar.mode', saved]] : []);
  g.document = doc;
  Object.defineProperty(globalThis, 'localStorage', { value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }, configurable: true, writable: true });
  g.addEventListener = () => {};
  g.innerHeight = 900; g.innerWidth = 1440;
  const make = (tag: string, id: string, cls = '') => { const n = doc.createElement(tag); n.id = id; n.className = cls; doc.byId.set(id, n); return n; };
  const card = make('div', 'mode-pick', 'mode-pick plate');
  const trigger = make('button', 'mode-trigger', 'mode-trigger');
  const list = make('ul', 'mode-list', 'mode-list');
  list.hidden = true;
  const detail = make('p', 'mode-detail');
  const grid = make('div', 'mode-grid');
  const next = make('button', 'mode-next', 'primary mode-next');
  const label = doc.createElement('span');
  label.className = 'mode-next-label';
  next.append(label);
  const dd = doc.createElement('div');
  dd.append(trigger, list);
  card.append(dd, detail, grid, next);
  const went: string[] = [];
  const picker = mountModePicker(grid as unknown as HTMLElement, { next: (m) => void went.push(m) });
  picker.sync(ROOMS, null);
  const restore = () => {
    g.document = before.document;
    if (before.localStorage) Object.defineProperty(globalThis, 'localStorage', before.localStorage); else delete g.localStorage;
    g.addEventListener = before.addEventListener; g.innerHeight = before.innerHeight; g.innerWidth = before.innerWidth;
  };
  const key = (on: FakeEl, k: string) => on.fire('keydown', { key: k });
  return { doc, trigger, list, detail, next, label, picker, went, store, restore, key };
}

test('the mounted dropdown: keys drive focus and ARIA, a choice is remembered, and Next goes on with it', () => {
  const f = mountFake('TDM');
  try {
    assert.equal(f.picker.mode, 'TDM', 'the remembered pick shows');
    assert.match(f.trigger.textContent, /TDM.*Team deathmatch.*12 playing/);
    assert.equal(f.detail.textContent, OPTS[1]!.pitch, 'its pitch sits under the button');
    assert.equal(f.label.textContent, 'Next: Loadout');
    assert.equal(f.list.children.length, 6);
    assert.deepEqual(f.list.children.map((o) => o.getAttribute('role')), Array(6).fill('option'));
    assert.deepEqual(f.list.children.map((o) => o.id), ['mode-opt-ffa', 'mode-opt-tdm', 'mode-opt-dom', 'mode-opt-br', 'mode-opt-zom', 'mode-opt-rng']);
    assert.equal(f.trigger.getAttribute('aria-expanded'), 'false');

    const down = f.key(f.trigger, 'ArrowDown');
    assert.ok(down.defaultPrevented && down.stopped, 'the arrow is the dropdown\'s, not the menu\'s focus mover');
    assert.equal(f.list.hidden, false);
    assert.equal(f.trigger.getAttribute('aria-expanded'), 'true');
    assert.equal(f.doc.activeElement, f.list, 'focus moves into the list');
    assert.equal(f.list.getAttribute('aria-activedescendant'), 'mode-opt-tdm');
    f.key(f.list, 'ArrowDown');
    f.key(f.list, 'ArrowDown');
    assert.equal(f.list.getAttribute('aria-activedescendant'), 'mode-opt-br');
    assert.equal(f.list.children[3]!.classList.contains('active'), true);
    const esc = f.key(f.list, 'Escape');
    assert.ok(esc.stopped, 'Esc closes the list and does not also leave the step');
    assert.equal(f.list.hidden, true);
    assert.equal(f.doc.activeElement, f.trigger, 'focus returns to the button');
    assert.equal(f.picker.mode, 'TDM', 'Esc chose nothing');
    assert.equal(f.list.getAttribute('aria-activedescendant'), null);

    f.key(f.trigger, 'Enter');
    f.key(f.list, 'End');
    f.key(f.list, 'ArrowUp');
    f.key(f.list, 'Enter');
    assert.equal(f.picker.mode, 'ZOM');
    assert.equal(f.store.get('tinwar.mode'), 'ZOM', 'the pick is remembered on this device');
    assert.equal(f.doc.activeElement, f.trigger);
    assert.deepEqual(f.list.children.map((o) => o.getAttribute('aria-selected')), ['false', 'false', 'false', 'false', 'true', 'false']);
    assert.equal(loadModePick(), 'ZOM');

    f.trigger.fire('click');
    assert.equal(f.list.hidden, false, 'a tap opens it');
    f.doc.byId.get('mode-grid')!.fire('pointerdown');
    assert.equal(f.list.hidden, true, 'a tap anywhere else closes it');
    f.trigger.fire('click');
    const range = f.list.children[5]!.querySelector('.mdd-name')!;
    f.list.fire('click', { target: range });
    assert.equal(f.picker.mode, 'RNG', 'a tap on an option (on any part of it) chooses it');
    assert.equal(f.list.hidden, true);
    assert.equal(f.label.textContent, 'Open the range');
    f.next.fire('click');
    assert.deepEqual(f.went, ['RNG'], 'Next goes on with the picked mode');

    // A poll that only moves the counts keeps an open list open, on the same option.
    f.trigger.fire('click');
    f.key(f.list, 'Home');
    f.picker.sync(ROOMS.map((r) => ({ ...r, players: r.players + 1 })), null);
    assert.equal(f.list.hidden, false);
    assert.equal(f.list.getAttribute('aria-activedescendant'), 'mode-opt-ffa');
    assert.match(f.list.children[0]!.textContent, /19 playing/);
  } finally {
    f.restore();
  }
});

test('the next visit opens on the remembered fight, and a remembered fight no longer offered falls back to the first', () => {
  const again = mountFake('DOM');
  try { assert.equal(again.picker.mode, 'DOM'); } finally { again.restore(); }
  const gone = mountFake('NOPE');
  try { assert.equal(gone.picker.mode, 'FFA'); } finally { gone.restore(); }
});

test('the markup is a button and a listbox, not a native select, and nothing opens in the browser top layer', () => {
  const html = read('public/index.html');
  assert.doesNotMatch(html, /<select id="mode-select"/);
  const trigger = html.match(/<button id="mode-trigger"[^>]*>/)?.[0] ?? '';
  for (const attr of ['aria-haspopup="listbox"', 'aria-expanded="false"', 'aria-controls="mode-list"']) assert.ok(trigger.includes(attr), attr);
  assert.match(html, /<ul id="mode-list" class="mode-list" role="listbox" tabindex="-1" aria-labelledby="mode-label" hidden><\/ul>/);
  assert.match(html, /<button id="mode-next"[^>]*class="primary mode-next"><span class="mode-next-label">Next: Loadout<\/span><span class="mode-next-chev" aria-hidden="true">/, 'label and chevrons side by side');
  assert.doesNotMatch(html, /id="mode-play"|id="mode-gear"|Gear up first/, 'no deploying straight from the mode card, no "Gear up first"');
  const css = read('public/menubars.css');
  const z = [...css.matchAll(/\.mode-list[^{]*\{[^}]*z-index:\s*(\d+)/g)].map((m) => Number(m[1]));
  assert.ok(z.length && z.every((v) => v < 2147483000), 'the list stays under the cursor layer');
  assert.doesNotMatch(read('src/client/modepicker.ts'), /showModal|popover/);
  assert.match(css, /#menu button\.mode-next::after \{ display: none; \}/, 'the absolutely placed chevrons that overlapped the label are off');
  assert.match(css, /#menu \.mdd-opt \{[^}]*min-height: 54px/, 'options are big enough to tap');
});
