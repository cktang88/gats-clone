/// <reference types="node" />
// Usage: node drive.ts <run-dir> [step ...]   Steps: menu account join move fire latency chat leave (default, in order), plus touch, mute, loadout (before join), restart, reconnect and expire on request.
// reconnect needs the page in a match: put it after join with no leave or restart between (restart reloads to the menu).
// LAG=<one-way ms> and JITTER=<ms> shape the page's own socket through the client's dev-only ?lag/?jitter params.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { GUNS, WEAPON_IDS, type GunId, type WeaponId } from '../../../../src/shared/defs.ts';
import { joinFromMenu, key, openPage, respawnIfDead, serversListed, sleep } from './lib/browser.ts';

const RUN = process.argv[2];
if (!RUN) { console.error('usage: node drive.ts <run-dir> [step ...]'); process.exit(2); }
const ALL = ['menu', 'account', 'join', 'move', 'fire', 'latency', 'chat', 'leave'];
const steps = process.argv.length > 3 ? process.argv.slice(3) : ALL;
const REMOTE_URL = existsSync(join(RUN, 'url')) ? readFileSync(join(RUN, 'url'), 'utf8').trim().replace(/\/$/, '') : null;
const PORT = REMOTE_URL ? '' : readFileSync(join(RUN, 'port'), 'utf8').trim();
const BASE = REMOTE_URL ?? `http://localhost:${PORT}`;
const WS_BASE = BASE.replace(/^http/, 'ws');
const EV = join(RUN, 'evidence');
const LOG = join(EV, 'drive.log');
mkdirSync(EV, { recursive: true });
const NAME = `Verifier${Math.floor(Math.random() * 1e4)}`;
const log = (line: string) => { console.log(line); appendFileSync(LOG, line + '\n'); };
const problems: string[] = [];

type Snap = { t: 'snap'; self: { id: number; ammo: number; reloading: boolean }; players: { id: number; name: string; x: number; y: number; alive: boolean; gun: GunId }[] };
const frames = { welcome: null as null | { id: number; account: string | null }, last: null as null | Snap, sent: 0, snapAt: [] as number[], chat: [] as { from: string; text: string }[] };
const page = await openPage({
  profile: 'skirmish-verify-',
  viewport: { width: 1280, height: 800 },
  onEvent: (method, params) => {
    if (method === 'Network.webSocketFrameReceived') {
      const msg = JSON.parse(params.response.payloadData);
      if (msg.t === 'welcome') frames.welcome = msg;
      if (msg.t === 'snap') { frames.last = msg; frames.snapAt.push(params.timestamp * 1000); }
      if (msg.t === 'chat') frames.chat.push(msg);
    } else if (method === 'Network.webSocketFrameSent') frames.sent++;
  },
  onProblem: (kind, detail) => problems.push(`${kind}: ${detail}`),
});
const { cdp, js } = page;
const shot = async (name: string) => { const { data } = await cdp('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(EV, `${name}.png`), Buffer.from(data, 'base64')); };
const expect = (label: string, ok: boolean, detail = '') => { log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  (${detail})` : ''}`); if (!ok) problems.push(label); };
const until = async (fn: () => boolean | Promise<boolean>, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(100); } return false; };
const press = async (code: string, k: string, holdMs: number) => {
  const vk = k === 'Enter' ? 13 : undefined;
  await key(page, 'keyDown', code, k, vk);
  await sleep(holdMs);
  await key(page, 'keyUp', code, k, vk);
};
const mouse = (type: string, x: number, y: number) => cdp('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
const welcomed = () => frames.welcome;
const me = () => frames.last?.players.find((p) => p.id === frames.welcome?.id);
const ensureAlive = async () => {
  if (me()?.alive) return;
  log('note driven player is dead, respawning through the death screen');
  await respawnIfDead(page, 8000);
  await until(() => !!me()?.alive, 4000);
  await sleep(300);
};
const humansIn = async (room: string) => ((await (await fetch(`${BASE}/api/servers`)).json()) as { id: string; humans: number }[]).find((r) => r.id === room)?.humans;

let humansBefore = 0;
let pickedWeapon: WeaponId | null = null;
const observerChat: { from: string; text: string }[] = [];
let observerBoard: string[] = [];
const openObserver = () => {
  const ws = new WebSocket(`${WS_BASE}/ws?room=ffa`);
  ws.on('open', () => ws.send(JSON.stringify({ t: 'join', name: 'Observer', loadout: { weapon: 'pistol', armor: 'none', color: 'green' } })));
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.t === 'chat') observerChat.push(m);
    if (m.t === 'snap' && m.leaderboard) observerBoard = m.leaderboard.map((r: { name: string }) => r.name);
  });
  return ws;
};
let observer = openObserver();
const clickPlay = () => joinFromMenu(page, { name: NAME, press: true });

await cdp('Page.navigate', { url: `${BASE}/?dev&lag=${Number(process.env.LAG ?? 0)}&jitter=${Number(process.env.JITTER ?? 0)}` });
await serversListed(page, 4000);
log(`drive ${new Date().toISOString()} base=${BASE} name=${NAME} steps=${steps.join(',')}`);

/** Stops the server this run started and starts it again on the same port and data dir. `whileDown` runs between the two. */
const restartServer = async (whileDown = async () => {}) => {
  const pidFile = join(RUN, 'pid');
  const oldPid = Number(readFileSync(pidFile, 'utf8'));
  process.kill(oldPid, 'SIGTERM');
  await until(() => { try { process.kill(oldPid, 0); return false; } catch { return true; } }, 6000);
  await whileDown();
  const out = openSync(join(RUN, 'server.log'), 'a');
  const server = spawn('node', ['src/server/main.ts'], { cwd: join(import.meta.dirname, '../../../..'), env: { ...process.env, PORT, DATA_DIR: join(RUN, 'data') }, detached: true, stdio: ['ignore', out, out] });
  server.unref();
  writeFileSync(pidFile, String(server.pid));
  expect('server restarts on the same port and data dir', await until(async () => { try { return (await fetch(`${BASE}/api/servers`)).ok; } catch { return false; } }, 6000), `pid ${oldPid} -> ${server.pid}`);
  observerBoard = [];
  observer = openObserver();
};

const STEPS: Record<string, () => Promise<void>> = {
  async menu() {
    expect('menu lists four rooms', (await js(`[...document.querySelectorAll('#servers .server')].map(b => b.textContent).join('|')`)).match(/FFA|TDM|DOM|BR/g)?.length === 4);
    // A guest sees the enlist plate on the first screen, with its benefits and both ways in, and the mode cards still in view under it.
    if (!(await js(`localStorage.getItem('skirmish.account')`))) {
      const plate = await js(`(() => { const e = document.getElementById('enlist'), r = e.getBoundingClientRect(), card = document.getElementById('mode-pick').getBoundingClientRect(); return { shown: !e.hidden && r.height > 0, perks: e.querySelectorAll('.enlist-perks li').length, create: !!document.getElementById('enlist-create'), login: !!document.getElementById('enlist-login'), cardTop: Math.round(card.top), cardBottom: Math.round(card.bottom), vh: innerHeight }; })()`);
      expect('signed out: the enlist plate shows on the first screen with its benefits, Create account and Log in', plate.shown && plate.perks >= 3 && plate.create && plate.login, JSON.stringify(plate));
      expect('signed out: the mode card still fits the first screen under it', plate.cardBottom <= plate.vh, `card ${plate.cardTop}-${plate.cardBottom} viewport ${plate.vh}`);
    }
    await cdp('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
    await sleep(300);
    expect('menu has no horizontal scroll at 375px', await js(`document.documentElement.scrollWidth <= innerWidth`));
    await shot('menu-phone');
    if (!(await js(`localStorage.getItem('skirmish.account')`))) expect('the enlist plate fits the phone without a horizontal scroll', await js(`(() => { const r = document.getElementById('enlist').getBoundingClientRect(); return r.right <= innerWidth && r.left >= 0; })()`));
    // Step one lists the rooms as mode cards; picking one goes on to the gear-up step, where Deploy waits (sticky, always in view).
    await js(`document.getElementById('mode-next').click()`);
    await sleep(300);
    expect('picking a mode card opens the gear-up step', await js(`!document.getElementById('play-form').hidden && document.getElementById('step-modes').hidden`));
    expect('gear-up has no horizontal scroll at 375px', await js(`document.documentElement.scrollWidth <= innerWidth`));
    await shot('menu-phone-gear');
    for (const [width, height] of [[1366, 768], [1280, 800]]) {
      await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await sleep(300);
      const r = await js(`(() => { document.getElementById('menu').scrollTop = 0; const r = document.getElementById('play').getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: innerHeight }; })()`);
      expect(`Play button in view without scrolling at ${width}x${height}`, r.top >= 0 && r.bottom <= r.vh, `play top ${r.top} bottom ${r.bottom} viewport ${r.vh}`);
    }
    await shot('menu-desktop');
    await js(`document.getElementById('gear-back').click()`);
    expect('Back returns to the mode cards', await js(`document.getElementById('play-form').hidden && !document.getElementById('step-modes').hidden`));
    await js(`document.getElementById('mode-next').click()`);
  },
  async account() {
    // Register through the first screen's enlist plate: Create account opens the form inline, without leaving the mode cards.
    const onGear = await js(`!document.getElementById('play-form').hidden`);
    if (onGear) await js(`document.getElementById('gear-back').click()`);
    await js(`document.getElementById('enlist-create').click()`);
    expect('Create account opens the register form inline on the mode step', await until(async () => js(`(() => { const e = document.getElementById('enlist'); return !e.hidden && e.dataset.form === 'register' && !!document.getElementById('enlist-name') && !document.getElementById('step-modes').hidden; })()`)));
    // A too-short password gets a clear error before any request.
    await js(`(() => { document.getElementById('enlist-name').value = '${NAME}'; document.getElementById('enlist-pass').value = 'x'; document.getElementById('enlist-submit').click(); })()`);
    expect('a short password shows a clear error', await until(async () => /at least 4/.test(await js(`document.getElementById('enlist-msg').textContent`))));
    await shot('enlist-form-error');
    await js(`(() => { document.getElementById('enlist-pass').value = 'verify-pass'; document.getElementById('enlist-submit').click(); })()`);
    expect('UI shows signed-in name', await until(async () => (await js(`document.getElementById('account').textContent`)).includes(`Signed in as ${NAME}`)));
    expect('signed in: the enlist plate folds away and the top bar shows the name', await until(async () => js(`document.getElementById('enlist').hidden && document.querySelector('#top-me .top-me-name')?.textContent === '${NAME}'`)));
    if (onGear) await js(`document.querySelector('#servers .server').click()`);
    expect('token stored in localStorage', !!(await js(`localStorage.getItem('skirmish.token')`)));
    const stats = await fetch(`${BASE}/api/stats/${NAME}`);
    expect('account exists server-side (GET /api/stats)', stats.ok, `status ${stats.status}`);
    await shot('account-signed-in');
  },
  async join() {
    await until(() => observerBoard.includes('Observer'));
    humansBefore = (await humansIn('ffa')) ?? 0;
    frames.welcome = null;
    const signedIn = await js(`localStorage.getItem('skirmish.account')`);
    await clickPlay();
    expect('welcome frame received on the page socket', await until(() => frames.welcome !== null));
    if (signedIn) expect('server accepts the stored session (welcome.account)', welcomed()?.account === signedIn, `account ${welcomed()?.account}`);
    expect('menu hidden and HUD shown', await until(async () => js(`document.getElementById('menu').hidden && !document.getElementById('hud').hidden`)));
    expect('own player present in snapshots', await until(() => !!me()));
    if (pickedWeapon) expect('joined player carries the picked weapon (server snapshot)', me()?.gun === pickedWeapon, `gun ${me()?.gun}`);
    expect('server human count in ffa rises by one', await until(async () => (await humansIn('ffa')) === humansBefore + 1), `baseline ${humansBefore} incl. observer`);
    expect('observer leaderboard lists the player', await until(() => observerBoard.includes(NAME)));
    await shot('joined');
  },
  async loadout() {
    const index = 2;
    const weapon = WEAPON_IDS[index]!;
    const [x, y] = await js(`(() => { const b = document.querySelectorAll('#loadout-menu .weapon')[${index}]; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    await mouse('mousePressed', x, y);
    await mouse('mouseReleased', x, y);
    for (const picker of ['loadout-menu', 'loadout-death']) {
      const pressed = await js(`[...document.querySelectorAll('#${picker} .weapon')].map(b => b.getAttribute('aria-pressed')).join(',')`);
      expect(`#${picker} marks only the ${weapon} tile pressed`, pressed === WEAPON_IDS.map((_, i) => String(i === index)).join(','), `aria-pressed ${pressed}`);
    }
    const saved = await js(`localStorage.getItem('skirmish.loadout')`);
    expect(`picked weapon saved in localStorage`, JSON.parse(saved ?? 'null')?.weapon === weapon, `skirmish.loadout ${saved}`);
    pickedWeapon = weapon;
    await shot('loadout-picked');
  },
  async move() {
    await ensureAlive();
    await until(() => !!me());
    const before = me()!;
    await press('KeyD', 'd', 700);
    await sleep(200);
    let after = me()!;
    // Some FFA spawn pads sit with cover just to their right; walk left instead before calling it a failure.
    if (after && after.x <= before.x + 50) {
      const from = after;
      await press('KeyA', 'a', 700);
      await sleep(200);
      after = me()!;
      expect('holding A moves the player left on the server (D was blocked by cover)', !!after && after.x < from.x - 50, `x ${from.x.toFixed(0)} -> ${after?.x.toFixed(0)}`);
    } else expect('holding D moves the player right on the server', true, `x ${before.x.toFixed(0)} -> ${after.x.toFixed(0)}`);
    await shot('moved');
  },
  async fire() {
    await ensureAlive();
    const ammo = frames.last!.self.ammo;
    await mouse('mouseMoved', 900, 400);
    await mouse('mousePressed', 900, 400);
    await sleep(80);
    await mouse('mouseReleased', 900, 400);
    expect('click fires: server ammo decreases', await until(() => frames.last!.self.ammo < ammo), `ammo ${ammo} -> ${frames.last!.self.ammo}`);
    await shot('fired');

    const CLICKS = 6;
    const TAP_MS = 8;
    let weapon = GUNS[me()!.gun], before = 0, fired = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      await ensureAlive();
      weapon = GUNS[me()!.gun];
      if (frames.last!.self.ammo < CLICKS) { await press('KeyR', 'r', 60); await until(() => !frames.last!.self.reloading && frames.last!.self.ammo >= CLICKS, weapon.reloadMs + 2000); }
      await sleep(weapon.fireMs);
      before = frames.last!.self.ammo;
      for (let i = 0; i < CLICKS; i++) {
        await mouse('mousePressed', 900, 400);
        await sleep(TAP_MS);
        await mouse('mouseReleased', 900, 400);
        await sleep(weapon.fireMs + 40);
      }
      await sleep(400);
      fired = before - frames.last!.self.ammo;
      if (me()?.alive) break;
      log(`info player died during the click burst; retrying`);
    }
    expect(`${CLICKS} quick clicks fire ${CLICKS} shots (server ammo)`, fired === CLICKS, `${weapon.name} ammo ${before} -> ${frames.last!.self.ammo}, fired ${fired}`);
  },
  async latency() {
    const samples: number[] = [];
    let misses = 0;
    await js(`window.maxCorrection = 0; (function watch() { maxCorrection = Math.max(maxCorrection, skirmishDev.drawnSelf().correction); requestAnimationFrame(watch); })(); 0`);
    for (let i = 0; i < 10; i++) {
      await ensureAlive();
      const [code, k] = i % 2 === 0 ? ['KeyA', 'a'] : ['KeyD', 'd'];
      await js(`window.probe = new Promise((res) => addEventListener('keydown', (e) => {
        const t0 = e.timeStamp, x0 = skirmishDev.drawnSelf().x;
        const poll = () => {
          const d = skirmishDev.drawnSelf();
          if (d.at >= t0 && Math.abs(d.x - x0) > 0.5) res(d.at - t0);
          else if (performance.now() - t0 > 2000) res(null);
          else requestAnimationFrame(poll);
        };
        requestAnimationFrame(poll);
      }, { once: true, capture: true })); 0`);
      await press(code, k, 250);
      const ms = await js('window.probe');
      if (typeof ms === 'number') samples.push(ms); else misses++;
      await sleep(500);
    }
    const inOrder = samples.map((s) => s.toFixed(0)).join(",");
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)] ?? NaN;
    const p95 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))] ?? NaN;
    const gaps = frames.snapAt.slice(1).map((t, i) => t - frames.snapAt[i]!).sort((a, b) => a - b);
    log(`info snapshot arrival gaps at the page: median ${gaps[gaps.length >> 1]!.toFixed(0)}ms p95 ${gaps[Math.floor(gaps.length * 0.95)]!.toFixed(0)}ms max ${gaps[gaps.length - 1]!.toFixed(0)}ms over ${gaps.length}`);
    log(`info largest misprediction being smoothed while moving: ${Number(await js('maxCorrection')).toFixed(1)}px`);
    expect('own movement drawn within 50ms of keydown (median)', median <= 50 && samples.length >= 5,
      `median ${median.toFixed(0)}ms p95 ${p95.toFixed(0)}ms n=${samples.length} misses=${misses} lag=${process.env.LAG ?? 0} jitter=${process.env.JITTER ?? 0} samples in order=${inOrder}`);
  },
  async chat() {
    const text = `hello ${Date.now()}`;
    await press('Enter', 'Enter', 30);
    await cdp('Input.insertText', { text });
    await press('Enter', 'Enter', 30);
    expect('own chat log shows the message', await until(async () => (await js(`document.getElementById('chat-log').textContent`)).includes(text)));
    expect('observer in the same room receives it', await until(() => observerChat.some((c) => c.from === NAME && c.text === text)));
    await shot('chat');
  },
  async mute() {
    const chatLog = () => js(`document.getElementById('chat-log').textContent`) as Promise<string>;
    let sentAt = 0;
    const observerSays = async (text: string) => {
      await sleep(Math.max(0, sentAt + 1100 - Date.now()));
      sentAt = Date.now();
      observer.send(JSON.stringify({ t: 'chat', text }));
      return until(() => frames.chat.some((c) => c.text === text));
    };
    const clickChatName = async (label: string) => {
      const at = await js(`(() => { const b = [...document.querySelectorAll('#chat-log .chat-name')].find(b => b.textContent.startsWith(${JSON.stringify(label)})); if (!b) return null; const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
      if (!at) return false;
      await mouse('mousePressed', at[0], at[1]);
      await mouse('mouseReleased', at[0], at[1]);
      return true;
    };
    const before = `before mute ${Date.now()}`;
    expect('page socket receives the observer chat', await observerSays(before));
    const sender = frames.chat.find((c) => c.text === before)!.from;
    expect('chat log shows the observer line', await until(async () => (await chatLog()).includes(before)));
    expect('clicking the sender name in the chat log is possible', await clickChatName(`${sender}: `));
    expect('muted name stored in localStorage', await until(async () => JSON.parse(await js(`localStorage.getItem('skirmish.mutedNames')`) ?? '[]').includes(sender)));
    expect('earlier line from the muted player is hidden', await until(async () => !(await chatLog()).includes(before)));
    expect('chat log shows a muted marker for the player', (await js(`[...document.querySelectorAll('#chat-log .muted-line')].map(l => l.textContent).join('|')`)).includes(`${sender}muted`));
    const later = `after mute ${Date.now()}`;
    expect('page socket still receives the muted player chat', await observerSays(later));
    await sleep(300);
    expect('later line from the muted player is not shown', !(await chatLog()).includes(later));
    await shot('chat-muted');

    await cdp('Page.reload', { ignoreCache: true });
    await serversListed(page, 4000);
    expect('menu lists the muted player after a reload', await until(async () => js(`!document.getElementById('muted').hidden && document.getElementById('muted').textContent.includes(${JSON.stringify(sender)})`)));
    await shot('menu-muted-list');
    frames.welcome = null;
    await clickPlay();
    expect('rejoined after the reload', await until(() => frames.welcome !== null) && await until(async () => js(`!document.getElementById('hud').hidden`)));
    const afterReload = `after reload ${Date.now()}`;
    expect('page socket receives the muted player chat after the reload', await observerSays(afterReload));
    await sleep(300);
    expect('muted player stays hidden after the reload', !(await chatLog()).includes(afterReload));
    await shot('chat-muted-after-reload');
    expect('clicking the muted marker is possible', await clickChatName(sender));
    const unmuted = `after unmute ${Date.now()}`;
    await observerSays(unmuted);
    expect('after unmuting, the player is shown again', await until(async () => (await chatLog()).includes(unmuted)));
    expect('unmuting clears the stored name', !JSON.parse(await js(`localStorage.getItem('skirmish.mutedNames')`) ?? '[]').includes(sender));
  },
  async touch() {
    await ensureAlive();
    await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }] });
    await sleep(300);
    expect('a phone held upright is asked to turn sideways', await js(`getComputedStyle(document.querySelector('.rotate-hint')).display !== 'none'`));
    await shot('touch-portrait');
    await cdp('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 2, mobile: true });
    await sleep(300);
    expect('turned sideways, the hint is gone', await js(`getComputedStyle(document.querySelector('.rotate-hint')).display === 'none'`));
    expect('touch buttons visible on a coarse pointer', await js(`getComputedStyle(document.querySelector('.touch-buttons')).display !== 'none'`));
    const touch = (type: string, points: { x: number; y: number; id: number }[]) => cdp('Input.dispatchTouchEvent', { type, touchPoints: points });
    const before = me()!;
    await touch('touchStart', [{ x: 110, y: 290, id: 1 }]);
    for (let i = 1; i <= 5; i++) { await touch('touchMove', [{ x: 110 + i * 12, y: 290, id: 1 }]); await sleep(30); }
    await sleep(600);
    await shot('touch-move');
    await touch('touchEnd', []);
    const after = me()!;
    expect('left thumb drag moves the player right on the server', !!after && after.x > before.x + 50, `x ${before.x.toFixed(0)} -> ${after?.x.toFixed(0)}`);
    const ammo = frames.last!.self.ammo;
    await touch('touchStart', [{ x: 600, y: 250, id: 2 }]);
    for (let i = 1; i <= 4; i++) { await touch('touchMove', [{ x: 600, y: 250 - i * 15, id: 2 }]); await sleep(30); }
    const fired = await until(() => frames.last!.self.ammo < ammo);
    await touch('touchEnd', []);
    expect('right thumb push fires: server ammo decreases', fired, `ammo ${ammo} -> ${frames.last!.self.ammo}`);
    await cdp('Emulation.setTouchEmulationEnabled', { enabled: false });
    await cdp('Emulation.setEmulatedMedia', { features: [] });
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  },
  async restart() {
    await restartServer();
    await cdp('Page.reload', { ignoreCache: true });
    await serversListed(page, 4000);
    expect('menu still shows signed in after the restart', (await js(`document.getElementById('account').textContent`)).includes(`Signed in as ${NAME}`));
    await shot('account-after-restart');
  },
  async reconnect() {
    if (REMOTE_URL) { log('skip reconnect: it restarts the server, so it runs only against a local run'); return; }
    expect('page is in a match before the restart', !!welcomed() && await js(`!document.getElementById('hud').hidden`));
    const oldId = welcomed()?.id;
    let overlay = '';
    await restartServer(async () => {
      frames.welcome = null;
      overlay = await until(async () => js(`!document.getElementById('reconnect').hidden`)) ? await js(`document.getElementById('reconnect').textContent`) : '';
      expect('page shows the reconnecting overlay over the game while the server is down', /^Reconnecting… \(attempt \d+\)$/.test(overlay), `overlay "${overlay}"`);
      expect('page stays out of the menu while reconnecting', await js(`document.getElementById('menu').hidden && !document.getElementById('hud').hidden`));
      await shot('reconnecting');
    });
    const startedAt = Date.now();
    expect('a new welcome arrives on the page socket without any click', await until(() => frames.welcome !== null, 15_000), `id ${oldId} -> ${welcomed()?.id} after ${Date.now() - startedAt}ms`);
    const signedIn = await js(`localStorage.getItem('skirmish.account')`);
    if (signedIn) expect('the rejoin carries the stored session (welcome.account)', welcomed()?.account === signedIn, `account ${welcomed()?.account}`);
    expect('HUD is back and the overlay is gone', await until(async () => js(`document.getElementById('reconnect').hidden && document.getElementById('menu').hidden && !document.getElementById('hud').hidden`)));
    expect('own player present in snapshots from the new server', await until(() => !!me()));
    expect('observer on the restarted server lists the player', await until(() => observerBoard.includes(NAME), 6000));
    expect('chat says the player reconnected', await until(async () => (await js(`document.getElementById('chat-log').textContent`)).includes('Reconnected.')));
    await shot('reconnected');
  },
  async expire() {
    await js(`localStorage.setItem('skirmish.token', 'forged.token'); localStorage.setItem('skirmish.account', '${NAME}')`);
    await cdp('Page.reload', { ignoreCache: true });
    await serversListed(page, 4000);
    frames.welcome = null;
    await clickPlay();
    expect('server joins a forged session as a guest (welcome.account null)', await until(() => frames.welcome !== null) && welcomed()?.account === null);
    expect('client drops the stored token', await until(async () => (await js(`localStorage.getItem('skirmish.token')`)) === null));
    expect('chat tells the player the session expired', await until(async () => (await js(`document.getElementById('chat-log').textContent`)).includes('Session expired')));
    await shot('session-expired-chat');
    await cdp('Page.reload', { ignoreCache: true });
    await serversListed(page, 4000);
    expect('menu shows signed out after an expired session', (await js(`document.getElementById('account').textContent`)).includes('Log in to keep stats'));
  },
  async leave() {
    await cdp('Page.reload', { ignoreCache: true });
    expect('the departed player drops off the observer leaderboard after the page unloads (reload)', await until(() => !observerBoard.includes(NAME), REMOTE_URL ? 25_000 : 6000));
    // A public site can gain or lose real visitors mid-run, so the head count is only meaningful against a private local server.
    if (!REMOTE_URL) expect('server human count returns to baseline after the page unloads (reload)', await until(async () => (await humansIn('ffa')) === humansBefore, 6000), `baseline ${humansBefore}`);
  },
};

for (const s of steps) {
  if (!STEPS[s]) { expect(`known step "${s}"`, false); continue; }
  try { await STEPS[s](); } catch (e) { expect(`step ${s} ran without throwing`, false, String(e)); }
}
for (const p of problems.filter((p) => p.startsWith('page') || p.startsWith('console'))) log(p);
log(problems.length ? `RESULT FAIL (${problems.length})` : 'RESULT PASS');
observer.close(); page.close();
process.exit(problems.length ? 1 : 0);
