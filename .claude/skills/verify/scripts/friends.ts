/**
 * Friends through real input: two muted headless Chromes join FFA, the first hovers and clicks the second's name on the board
 * (from `skirmishDev.friends.board()`), presses Add friend in the menu that opens, and the second presses Accept on the invite
 * plate. Proves the menu, the invite, the friendship on both sockets, the friend's heart on the minimap (the `friend` mark in
 * the snapshots) and that the desktop has no pause cog over the board. Run it on a scratch copy with `minPlayers` at 0 in
 * `WORLD` (defs.ts) so the two people are the whole board.
 *
 *   node .claude/skills/verify/scripts/friends.ts <run-dir>
 *
 * Log: <run-dir>/evidence/friends.log; screenshots friends-*.png beside it.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { joinFromMenu, openPage, sleep, type Page } from './lib/browser.ts';

const RUN = process.argv[2];
if (!RUN) throw new Error('usage: friends.ts <run-dir>');
const url = existsSync(join(RUN, 'url')) ? readFileSync(join(RUN, 'url'), 'utf8').trim() : `http://localhost:${readFileSync(join(RUN, 'port'), 'utf8').trim()}`;
const OUT = join(RUN, 'evidence');
mkdirSync(OUT, { recursive: true });
const LOG = join(OUT, 'friends.log');
writeFileSync(LOG, '');
let failed = false;
const log = (line: string) => { appendFileSync(LOG, line + '\n'); console.log(line); };
const ok = (cond: boolean, what: string, detail = '') => { if (!cond) failed = true; log(`${cond ? 'ok  ' : 'FAIL'} ${what}${detail ? `  (${detail})` : ''}`); };
const W = 1600, H = 900;

async function open(name: string) {
  const frames: string[] = [];
  const problems: string[] = [];
  const page = await openPage({
    profile: `friends-${name}-`, viewport: { width: W, height: H },
    onEvent: (method, params) => { if (method === 'Network.webSocketFrameReceived') frames.push(params.response.payloadData); },
    onProblem: (kind, detail) => problems.push(`${kind}: ${detail}`),
  });
  await page.cdp('Page.navigate', { url: `${url}/?dev` });
  await sleep(1200);
  await page.fitViewport();
  await joinFromMenu(page, { name, press: true });
  for (let i = 0; i < 80 && !(await page.js(`!document.getElementById('hud').hidden && window.skirmishDev?.friends?.myId() != null`)); i++) await sleep(100);
  return { page, frames, problems, id: (await page.js(`window.skirmishDev.friends.myId()`)) as number };
}

const shot = async (page: Page, file: string, clip?: { x: number; y: number; width: number; height: number }) => {
  const r = await page.cdp('Page.captureScreenshot', { format: 'png', ...(clip && { clip: { ...clip, scale: 2 } }) });
  writeFileSync(join(OUT, file), Buffer.from(r.data, 'base64'));
};
const mouse = async (page: Page, type: 'mouseMoved' | 'mousePressed' | 'mouseReleased', x: number, y: number) =>
  page.cdp('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
const click = async (page: Page, x: number, y: number) => { await mouse(page, 'mouseMoved', x, y); await sleep(60); await mouse(page, 'mousePressed', x, y); await sleep(40); await mouse(page, 'mouseReleased', x, y); };
const rectOf = (page: Page, sel: string) => page.js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, text: e.textContent }; })()`);
const lastOf = (frames: string[], t: string) => frames.map((f) => { try { return JSON.parse(f); } catch { return null; } }).filter((m) => m?.t === t).at(-1);

const a = await open('Ann');
const b = await open('Ben');
try {
  ok(a.id > 0 && b.id > 0, 'both players joined', `Ann ${a.id}, Ben ${b.id}`);
  ok((await a.page.js(`getComputedStyle(document.getElementById('pause-cog')).display`)) === 'none', 'the desktop HUD has no pause cog over the board');

  let row: { x: number; y: number; w: number; h: number; human: boolean } | undefined;
  for (let i = 0; i < 60 && !row; i++) { row = ((await a.page.js(`window.skirmishDev.friends.board()`)) as { id: number; x: number; y: number; w: number; h: number; human: boolean }[]).find((n) => n.id === b.id); if (!row) await sleep(100); }
  ok(!!row && row.human, "Ben's name is a button on Ann's board, marked as a person", row ? `${row.x.toFixed(0)},${row.y.toFixed(0)} ${row.w.toFixed(0)}x${row.h.toFixed(0)}` : 'not drawn');
  if (!row) throw new Error('no row');
  const cx = row.x + row.w / 2, cy = row.y + row.h / 2;
  const board = { x: row.x - 70, y: Math.max(0, row.y - 40), width: W - (row.x - 70), height: 120 };
  await mouse(a.page, 'mouseMoved', cx, cy);
  await sleep(200);
  await shot(a.page, 'friends-hover.png', board);
  const ammoBefore = lastOf(a.frames, 'snap')?.self?.ammo;
  await click(a.page, cx, cy);
  await sleep(300);
  const menu = await rectOf(a.page, '.friend-menu');
  ok(!!menu && /Ben/.test(menu.text) && /Add friend/.test(menu.text), 'clicking the name opens the friend menu beside the board', menu ? `"${menu.text}" right edge ${(menu.x + menu.w).toFixed(0)} <= board ${row.x.toFixed(0)}` : 'none');
  const ammoAfter = lastOf(a.frames, 'snap')?.self?.ammo;
  ok(ammoBefore === ammoAfter, 'the click on the name did not fire', `ammo ${ammoBefore} -> ${ammoAfter}`);
  await shot(a.page, 'friends-menu.png', { x: Math.max(0, (menu?.x ?? 1200) - 20), y: Math.max(0, (menu?.y ?? 0) - 30), width: W - Math.max(0, (menu?.x ?? 1200) - 20), height: 160 });
  const add = await rectOf(a.page, '.friend-menu .friend-btn');
  if (add) await click(a.page, add.x + add.w / 2, add.y + add.h / 2);

  let invite = null;
  for (let i = 0; i < 40 && !invite; i++) { invite = await rectOf(b.page, '.friend-invite'); if (!invite) await sleep(100); }
  ok(!!invite && /Ann/.test(invite.text), 'Ben gets an invite plate naming Ann', invite?.text ?? 'none');
  ok(!!lastOf(b.frames, 'friendInvite'), "the invite arrived on Ben's socket");
  if (invite) await shot(b.page, 'friends-invite.png', { x: invite.x - 20, y: invite.y - 20, width: invite.w + 40, height: invite.h + 40 });
  const accept = await rectOf(b.page, '.friend-invite .friend-btn');
  if (accept) await click(b.page, accept.x + accept.w / 2, accept.y + accept.h / 2);
  await sleep(600);
  ok(JSON.stringify(lastOf(a.frames, 'friends')?.ids) === JSON.stringify([b.id]) && JSON.stringify(lastOf(b.frames, 'friends')?.ids) === JSON.stringify([a.id]), 'both sockets list each other as friends');
  ok(!(await rectOf(b.page, '.friend-invite')), 'the plate goes once answered');

  let marked = false;
  for (let i = 0; i < 30 && !marked; i++) { marked = a.frames.slice(-10).some((f) => f.includes('"friend":true')); if (!marked) await sleep(100); }
  ok(marked, "Ben shows on Ann's minimap as a friend (snapshot mark)");
  await sleep(300);
  await shot(a.page, 'friends-board-heart.png', board);
  await shot(a.page, 'friends-full.png');
  ok(!a.problems.length && !b.problems.length, 'no page exceptions or console errors', [...a.problems, ...b.problems].join(' | ') || 'none');
} finally {
  a.page.close();
  b.page.close();
  log(`RESULT ${failed ? 'FAIL' : 'PASS'}`);
  process.exit(failed ? 1 : 0);
}
