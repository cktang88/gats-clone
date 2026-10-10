/// <reference types="node" />
// Usage: node frametime.ts <run-dir> [seconds] [width] [height]   Measures client frame cost in a busy FFA room while the driven player fires.
// SQUAD=1 starts a zombies squad through the menu instead and fires at the nearest zombie; point it at a scratch copy whose night holds a full horde.
// `frame cost` times each real frame's draw calls. With SOFTWARE=1 (no GPU canvas) it also logs `rastered frame cost`, which waits for the pixels,
// dropping each batch's first redraw, which waits on the compositor. On the GPU canvas the pixel reads would move it to the CPU mid-run and skew every later frame.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Snapshot } from '../../../../src/shared/protocol.ts';
import { fillSnapshot } from '../../../../src/shared/wire.ts';
import { dirKey, openPage, serversListed, sleep, type Dir } from './lib/browser.ts';

const RUN = process.argv[2];
if (!RUN) { console.error('usage: node frametime.ts <run-dir> [seconds] [width] [height]'); process.exit(2); }
const SECONDS = Number(process.argv[3] ?? 20);
const VIEW = { w: Number(process.argv[4] ?? 1920), h: Number(process.argv[5] ?? 1080) };
const WARMUP_MS = 5000;
const BENCH_EVERY_STEPS = 2;
const BENCH_FRAMES = 8;
const SOFTWARE = process.env.SOFTWARE === '1';
const SQUAD = process.env.SQUAD === '1';
/** PROFILE=<file.cpuprofile> also records a CPU profile of the sampled seconds (open it in DevTools), and logs its top functions and GC. */
const PROFILE = process.env.PROFILE;
/** DPR=3 renders at that many device pixels per CSS pixel (852 393 with DPR=3 is a landscape phone's canvas). */
const DPR = Number(process.env.DPR ?? 1);
const BASE = existsSync(join(RUN, 'url'))
  ? readFileSync(join(RUN, 'url'), 'utf8').trim().replace(/\/$/, '')
  : `http://localhost:${readFileSync(join(RUN, 'port'), 'utf8').trim()}`;
const EV = join(RUN, 'evidence');
mkdirSync(EV, { recursive: true });
const LOG = join(EV, 'frametime.log');
const log = (line: string) => { console.log(line); appendFileSync(LOG, line + '\n'); };

let myId: number | null = null;
let full: Snapshot | null = null;
const busy = { snaps: 0, players: 0, bullets: 0, zombies: 0 };
const rastered: number[] = [];
let sampling = false;
const page = await openPage({
  profile: 'skirmish-frametime-',
  args: SOFTWARE ? ['--disable-gpu', '--disable-accelerated-2d-canvas'] : [],
  viewport: { width: VIEW.w, height: VIEW.h },
  onEvent: (method, params) => {
    if (method !== 'Network.webSocketFrameReceived') return;
    const msg = JSON.parse(params.response.payloadData);
    if (msg.t === 'welcome') myId = msg.id;
    if (msg.t === 'snap') {
      full = fillSnapshot(msg, full) ?? full;
      if (sampling && full) { busy.snaps++; busy.players += full.players.length; busy.bullets += full.bullets.length; busy.zombies += full.zombies?.length ?? 0; }
    }
  },
});
const { cdp, js, exceptions, close } = page;
if (DPR !== 1) await cdp('Emulation.setDeviceMetricsOverride', { width: VIEW.w, height: VIEW.h, deviceScaleFactor: DPR, mobile: false });
await cdp('Page.navigate', { url: `${BASE}/?dev` });
await serversListed(page);
await js(`document.querySelectorAll('#loadout-menu .weapon')[1].click(); document.getElementById('name').value = 'Bench'`);
await js(SQUAD ? `document.getElementById('squad-start').click()` : `document.querySelector('#servers .server').click(); document.getElementById('play').click()`);
for (let i = 0; i < 50 && !full; i++) await sleep(100);

const me = () => full?.players.find((p) => p.id === myId);
const KEYS: Dir[] = ['right', 'down', 'left', 'up'];
const aimAt = (x: number, y: number) => cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
const mouseDown = (x: number, y: number) => cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });

async function fightFor(ms: number) {
  const end = Date.now() + ms;
  let step = 0;
  while (Date.now() < end) {
    if (me()?.alive === false) {
      await js(`document.getElementById('respawn').disabled || document.getElementById('respawn').click()`);
      await sleep(250);
      continue;
    }
    const self = me();
    const targets = SQUAD ? (full?.zombies ?? []).map(([, , x, y]) => ({ x, y })) : (full?.players.filter((p) => p.id !== myId && p.alive) ?? []);
    const foe = self && targets.sort((a, b) => Math.hypot(a.x - self.x, a.y - self.y) - Math.hypot(b.x - self.x, b.y - self.y))[0];
    const [mx, my] = self && foe ? [VIEW.w / 2 + (foe.x - self.x) * 0.5, VIEW.h / 2 + (foe.y - self.y) * 0.5] : [VIEW.w / 2 + 300, VIEW.h / 2];
    await aimAt(mx, my);
    await mouseDown(mx, my);
    const k = KEYS[step++ % KEYS.length]!;
    await dirKey(page, 'keyDown', k);
    await sleep(400);
    await dirKey(page, 'keyUp', k);
    if (SOFTWARE && sampling && step % BENCH_EVERY_STEPS === 0 && me()?.alive) rastered.push(...(await js(`skirmishDev.benchFrames(${BENCH_FRAMES})`)).slice(1));
  }
}

await fightFor(WARMUP_MS);
await js(`skirmishDev.takeFrameCosts()`);
const bakesBefore: number = await js(`skirmishDev.shadowBakes()`);
await js(`window.__raf = []; (function tick(t) { window.__raf.push(t); requestAnimationFrame(tick); })(performance.now())`);
if (PROFILE) { await cdp('Profiler.enable'); await cdp('Profiler.setSamplingInterval', { interval: 200 }); await cdp('Profiler.start'); }
sampling = true;
await fightFor(SECONDS * 1000);
sampling = false;
const profile = PROFILE ? (await cdp('Profiler.stop')).profile : null;
const costs: number[] = await js(`skirmishDev.takeFrameCosts()`);
const bakes = (await js(`skirmishDev.shadowBakes()`)) - bakesBefore;
const stamps: number[] = await js(`window.__raf`);
const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
writeFileSync(join(EV, 'frametime-view.png'), Buffer.from(data, 'base64'));
close();

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? NaN;
  return { n: s.length, avg: s.reduce((a, b) => a + b, 0) / s.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: s.at(-1) ?? NaN };
};
const fmt = (o: ReturnType<typeof stats>) => `n=${o.n} avg=${o.avg.toFixed(2)} p50=${o.p50.toFixed(2)} p95=${o.p95.toFixed(2)} p99=${o.p99.toFixed(2)} max=${o.max.toFixed(2)}ms`;
const intervals = stamps.slice(1).map((t, i) => t - stamps[i]!);
log(`frametime ${VIEW.w}x${VIEW.h}${DPR !== 1 ? ` at DPR ${DPR}` : ''} ${SECONDS}s${SOFTWARE ? ' software-canvas' : ''} at ${new Date().toISOString()}`);
log(`busy: avg ${(busy.players / busy.snaps).toFixed(1)} players, ${(busy.bullets / busy.snaps).toFixed(1)} bullets${SQUAD ? ` and ${(busy.zombies / busy.snaps).toFixed(1)} zombies` : ''} in view per snapshot`);
log(`frame cost  ${fmt(stats(costs))}`);
if (SOFTWARE) log(`rastered frame cost  ${fmt(stats(rastered))}`);
log(`raf interval ${fmt(stats(intervals))}`);
log(`ground layer bakes while sampling: ${bakes} over ${costs.length} frames`);
if (profile) {
  writeFileSync(PROFILE!, JSON.stringify(profile));
  type Node = { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] };
  const nodes = new Map<number, Node>((profile.nodes as Node[]).map((n) => [n.id, n]));
  const name = (n: Node) => `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber + 1}`;
  const self = new Map<string, number>();
  let total = 0, gcMs = 0, gcRuns = 0, inGc = false;
  (profile.samples as number[]).forEach((id, i) => {
    const dt = (profile.timeDeltas[i] ?? 0) / 1000, n = nodes.get(id)!;
    total += dt;
    self.set(name(n), (self.get(name(n)) ?? 0) + dt);
    const gc = n.callFrame.functionName === '(garbage collector)';
    if (gc) { gcMs += dt; if (!inGc) gcRuns++; }
    inGc = gc;
  });
  const busyMs = total - (self.get('(idle) :0') ?? 0) - (self.get('(program) :0') ?? 0);
  log(`profile: ${(busyMs / SECONDS).toFixed(0)} ms of main-thread JS per second; GC ${gcMs.toFixed(0)} ms in ${gcRuns} pauses (${(gcRuns / SECONDS).toFixed(1)}/s); top self time:`);
  for (const [k, ms] of [...self].filter(([k]) => !k.startsWith('(idle)')).sort((a, b) => b[1] - a[1]).slice(0, 25)) log(`  ${(ms / SECONDS).toFixed(2).padStart(6)} ms/s  ${k}`);
}
for (const e of exceptions) log(`exception: ${e}`);
log(exceptions.length || !costs.length ? 'RESULT FAIL' : 'RESULT PASS');
process.exit(exceptions.length || !costs.length ? 1 : 0);
