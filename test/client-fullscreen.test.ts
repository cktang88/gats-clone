/// <reference types="node" />
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { canFullscreen, createAutoFullscreen, isFullscreen, requestFullscreen } from '../src/client/fullscreen.ts';

/** A page whose fullscreen calls are recorded: Android Chrome by default, `webkit` for older iPadOS, `none` for an iPhone. */
function page(kind: 'standard' | 'webkit' | 'none' = 'standard', refuse = false) {
  const calls: string[] = [];
  const doc: { fullscreenElement: object | null; webkitFullscreenElement?: object | null; fullscreenEnabled?: boolean; webkitFullscreenEnabled?: boolean } = { fullscreenElement: null };
  const root: { requestFullscreen?: (o?: FullscreenOptions) => Promise<void>; webkitRequestFullscreen?: () => void } = {};
  if (kind === 'standard') {
    doc.fullscreenEnabled = true;
    root.requestFullscreen = async (o) => { calls.push(`request:${o?.navigationUI}`); if (refuse) throw new Error('denied'); doc.fullscreenElement = root; };
  }
  if (kind === 'webkit') {
    doc.webkitFullscreenEnabled = true;
    root.webkitRequestFullscreen = () => { calls.push('webkit'); doc.webkitFullscreenElement = root; };
  }
  const lock = () => { calls.push('lock'); };
  return { doc, root, calls, lock };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

test('the first tap in a match asks for fullscreen, then the landscape lock, once', async () => {
  const p = page();
  const fs = createAutoFullscreen(p.doc as never, p.root as never, { touch: () => true, lock: p.lock });
  assert.equal(fs.tap(), false, 'no ask from the menu, before any match');
  fs.matchStarted();
  assert.equal(fs.tap(), true);
  await flush();
  assert.deepEqual(p.calls, ['request:hide', 'lock'], 'fullscreen with the browser UI hidden, then the lock');
  assert.equal(isFullscreen(p.doc), true);
  assert.equal(fs.tap(), false, 'later taps never ask again');
  assert.deepEqual(p.calls, ['request:hide', 'lock']);
});

test('a player who leaves fullscreen is not pulled back until the next match, which asks again', async () => {
  const p = page();
  const fs = createAutoFullscreen(p.doc as never, p.root as never, { touch: () => true, lock: p.lock });
  fs.matchStarted();
  fs.tap();
  await flush();
  p.doc.fullscreenElement = null; // the back gesture
  assert.equal(fs.tap(), false);
  fs.matchEnded();
  fs.matchStarted();
  assert.equal(fs.tap(), true);
  await flush();
  assert.deepEqual(p.calls, ['request:hide', 'lock', 'request:hide', 'lock']);
});

test('already fullscreen (Play asked), a desktop mouse, an iPhone or a refusal: no ask, and nothing throws', async () => {
  const already = page();
  already.doc.fullscreenElement = {};
  const a = createAutoFullscreen(already.doc as never, already.root as never, { touch: () => true });
  a.matchStarted();
  assert.equal(a.tap(), false);
  assert.deepEqual(already.calls, []);

  const desk = page();
  const d = createAutoFullscreen(desk.doc as never, desk.root as never, { touch: () => false });
  d.matchStarted();
  assert.equal(d.tap(), false, 'a desktop is never pulled into fullscreen by a click (that click is a shot)');
  assert.deepEqual(desk.calls, []);

  const phone = page('none');
  assert.equal(canFullscreen(phone.doc, phone.root), false, 'an iPhone has no page fullscreen');
  const i = createAutoFullscreen(phone.doc as never, phone.root as never, { touch: () => true });
  i.matchStarted();
  assert.equal(i.tap(), false);

  const no = page('standard', true);
  const n = createAutoFullscreen(no.doc as never, no.root as never, { touch: () => true, lock: no.lock });
  n.matchStarted();
  assert.equal(n.tap(), true);
  await flush();
  assert.deepEqual(no.calls, ['request:hide'], 'a refused request skips the lock');
  assert.equal(n.tap(), false, 'and is not asked again this match');
  assert.equal(await requestFullscreen(no.doc, no.root), false);
});

test('older iPadOS goes fullscreen through the prefixed call', async () => {
  const p = page('webkit');
  assert.equal(canFullscreen(p.doc, p.root), true);
  const fs = createAutoFullscreen(p.doc as never, p.root as never, { touch: () => true, lock: p.lock });
  fs.matchStarted();
  assert.equal(fs.tap(), true);
  await flush();
  assert.deepEqual(p.calls, ['webkit', 'lock']);
  assert.equal(isFullscreen(p.doc), true);
});

test('the game asks on the first touch in a match: the canvas and the touch buttons both tap, and a match start arms it', () => {
  const main = readFileSync('src/client/main.ts', 'utf8');
  const canvasDown = main.slice(main.indexOf("canvas.addEventListener('pointerdown'"), main.indexOf("window.addEventListener('pointermove'"));
  assert.match(canvasDown, /autoFullscreen\.tap\(\)/, 'a thumb on the field');
  const buttons = main.slice(main.indexOf("for (const [id, action] of [['touch-ability'"));
  assert.match(buttons.slice(0, 600), /autoFullscreen\.tap\(\)/, 'a thumb on reload or the ability');
  assert.match(main, /was\.phase === 'menu'\) autoFullscreen\.matchStarted\(\)/);
  assert.match(main, /next\.phase === 'menu'\) autoFullscreen\.matchEnded\(\)/);
});
