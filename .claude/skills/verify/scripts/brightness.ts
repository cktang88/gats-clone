/// <reference types="node" />
// Usage:
//   node brightness.ts prep <scratch-repo>                         copy this repo there, with a /tp chat command and no bots
//   node brightness.ts <run-dir> <tag> <preset> <outDir> [x,y ...]  sweep the map's west half (or the given points) at a preset
// Launch the scratch copy with `SKIRMISH_MAP=<map> <scratch-repo>/.claude/skills/verify/scripts/launch.sh <run-dir>` between the two.
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { openPage, joinFromMenu, sleep } from './lib/browser.ts';

/** The same limits test/client-exposure.test.ts holds the exposure math to, on the 0..255 screenshot. */
const HOT = 215, CLIP = 250;
/** A frame fails when more than this share of it is HOT, or when a 16px block field of that size is (a blown-out pool, not a lamp head). */
const MAX_HOT = 0.01, MAX_HOT_BLOCKS = 40;

const args = process.argv.slice(2);
if (args[0] === 'prep') {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..'), dest = resolve(args[1]!);
  cpSync(repo, dest, { recursive: true, filter: (src) => !/[/\\](node_modules|\.git|data|worktrees)$/.test(src) });
  if (!existsSync(join(dest, 'node_modules'))) symlinkSync(join(repo, 'node_modules'), join(dest, 'node_modules'));
  const patch = (file: string, from: string, to: string) => {
    const p = join(dest, file), s = readFileSync(p, 'utf8');
    if (!s.includes(from)) throw new Error(`prep: ${file} no longer has ${JSON.stringify(from)}`);
    writeFileSync(p, s.replace(from, to));
  };
  // Scratch only: a chat line `/tp x y` moves the sender, and no bots join (a quiet frame: no muzzle flashes or blasts).
  patch('src/server/room.ts', 'const text = moderator.mask(msg.text);', 'const tp = /^\\/tp (\\d+) (\\d+)/.exec(msg.text);\n        if (tp) { p.x = Number(tp[1]); p.y = Number(tp[2]); return; }\n        const text = moderator.mask(msg.text);');
  patch('src/server/room.ts', 'if (now - client.lastChatAt < CHAT_INTERVAL_MS)', "if (!msg.text.startsWith('/tp') && now - client.lastChatAt < CHAT_INTERVAL_MS)");
  patch('src/shared/defs.ts', 'minPlayers: 18,', 'minPlayers: 0,');
  console.log(`prepared ${dest}`);
  process.exit(0);
}

const [RUN, TAG, PRESET, OUT, ...pts] = args;
if (!RUN || !TAG || !PRESET || !OUT) { console.error('usage: node brightness.ts <run-dir> <tag> <low|medium|high|ultra|auto> <outDir> [x,y ...]'); process.exit(2); }
mkdirSync(OUT, { recursive: true });

function decodePng(buf: Buffer): { w: number; h: number; px: Uint8Array } {
  let p = 8, w = 0, h = 0, ct = 0;
  const idat: Buffer[] = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]!; }
    else if (type === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  const bpp = ct === 6 ? 4 : 3, raw = inflateSync(Buffer.concat(idat)), stride = w * bpp, px = new Uint8Array(w * h * 3);
  let prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]!, row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp]! : 0, b = prev[i]!, c = i >= bpp ? prev[i - bpp]! : 0, x = row[i]!;
      const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
      cur[i] = (f === 0 ? x : f === 1 ? x + a : f === 2 ? x + b : f === 3 ? x + ((a + b) >> 1) : x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
    }
    for (let x = 0; x < w; x++) for (let k = 0; k < 3; k++) px[(y * w + x) * 3 + k] = cur[x * bpp + k]!;
    [prev, cur] = [cur, prev];
  }
  return { w, h, px };
}

/** Luma stats on the frame less an 8% margin (the HUD): mean, 99th and 99.9th percentile, HOT and CLIP shares, hot 16px blocks. */
function stats({ w, h, px }: { w: number; h: number; px: Uint8Array }) {
  const x0 = Math.floor(w * 0.08), x1 = Math.ceil(w * 0.92), y0 = Math.floor(h * 0.08), y1 = Math.ceil(h * 0.92), B = 16;
  const hist = new Uint32Array(256), bw = Math.ceil((x1 - x0) / B), blocks = new Uint16Array(bw * Math.ceil((y1 - y0) / B));
  let n = 0, hot = 0, clip = 0, sum = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const o = (y * w + x) * 3, r = px[o]!, g = px[o + 1]!, b = px[o + 2]!, Y = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
    hist[Y]!++; n++; sum += Y;
    if (Y >= HOT) { hot++; blocks[Math.floor((y - y0) / B) * bw + Math.floor((x - x0) / B)]!++; }
    if (r >= CLIP || g >= CLIP || b >= CLIP) clip++;
  }
  const pct = (q: number) => { let acc = 0; for (let i = 0; i < 256; i++) if ((acc += hist[i]!) >= q * n) return i; return 255; };
  return { mean: sum / n, p99: pct(0.99), p999: pct(0.999), hot: hot / n, clip: clip / n, hotBlocks: [...blocks].filter((c) => c > B * B * 0.5).length };
}

const port = readFileSync(join(RUN, 'port'), 'utf8').trim();
const W = Number(process.env.W ?? 1600), H = Number(process.env.H ?? 900);
// `?fx` keeps the shader pass on under a software GPU, so headless Chrome draws what Medium, High and Ultra players see.
const page = await openPage({ profile: `bright-${TAG}-`, viewport: { width: W, height: H }, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
await page.cdp('Page.navigate', { url: `http://localhost:${port}/?dev&fx` });
await sleep(1500);
await page.js(`localStorage.setItem('skirmish.settings', JSON.stringify({ quality: '${PRESET}' })); localStorage.setItem('skirmish.muted', '1'); localStorage.setItem('skirmish.chatter', '0'); location.reload()`);
await sleep(2000);
await page.fitViewport();
const inMatch = async () => (await page.js(`!document.getElementById('hud').hidden`)) === true;
for (let attempt = 0; attempt < 3 && !(await inMatch()); attempt++) {
  await joinFromMenu(page, { room: 0, name: 'Probe' });
  for (let i = 0; i < 100 && !(await inMatch()); i++) await sleep(200);
}
if (!(await inMatch())) { console.error('never got into the match'); page.close(); process.exit(3); }
await page.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: W / 2, y: H / 2 });
await sleep(1500);
const knobs = await page.js(`JSON.stringify(window.skirmishDev?.pause?.quality?.()?.knobs ?? null)`);
appendFileSync(join(OUT, 'log.txt'), `# ${TAG} ${PRESET} knobs=${knobs}\n`);

const points: [number, number][] = pts.map((s) => s.split(',').map(Number) as [number, number]);
if (!points.length) {
  // The east half is the west half turned about the centre, so the west half and the middle column cover the map.
  const S = Number(process.env.SIZE ?? 6000);
  for (let y = 450; y < S; y += 800) for (let x = 700; x <= S / 2 + 200; x += 1250) points.push([x, Math.min(y, S - 450)]);
}
const enter = async () => { await page.cdp('Input.dispatchKeyEvent', { type: 'keyDown', code: 'Enter', key: 'Enter', windowsVirtualKeyCode: 13 }); await sleep(40); await page.cdp('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Enter', key: 'Enter', windowsVirtualKeyCode: 13 }); };
const teleport = async (x: number, y: number) => {
  for (let tries = 0; tries < 3; tries++) {
    await enter(); await sleep(150);
    await page.cdp('Input.insertText', { text: `/tp ${x} ${y}` }); await sleep(150);
    await enter(); await sleep(200);
    if (!(await page.js(`document.activeElement?.tagName === 'INPUT'`))) break;
    await page.cdp('Input.dispatchKeyEvent', { type: 'keyDown', code: 'Escape', key: 'Escape' });
    await page.cdp('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Escape', key: 'Escape' });
  }
  // A software GPU draws a frame a second or so: wait until the page draws us there, then let the lights and water settle.
  const t0 = Date.now();
  while (Date.now() - t0 < 25_000 && (await page.js(`(() => { const s = window.skirmishDev.drawnSelf(); return s ? Math.hypot(s.x - ${x}, s.y - ${y}) : 1e9 })()`)) > 80) await sleep(300);
  await sleep(Number(process.env.SETTLE ?? 2000));
};

let failed = 0;
for (const [x, y] of points) {
  await teleport(x, y);
  const buf = Buffer.from((await page.cdp('Page.captureScreenshot', { format: 'png' })).data, 'base64');
  const s = stats(decodePng(buf));
  const bad = s.hot > MAX_HOT || s.hotBlocks > MAX_HOT_BLOCKS;
  if (bad) failed++;
  writeFileSync(join(OUT, `${TAG}-${PRESET}-${x}-${y}.png`), buf);
  const line = `${bad ? 'FLAG' : 'ok'} ${TAG} ${PRESET} ${x},${y} mean=${s.mean.toFixed(1)} p99=${s.p99} p999=${s.p999} hot=${(s.hot * 100).toFixed(2)}% clip=${(s.clip * 100).toFixed(2)}% hotBlocks=${s.hotBlocks}`;
  appendFileSync(join(OUT, 'log.txt'), `${line}\n`);
  console.log(line);
}
console.log(`RESULT ${failed ? 'FAIL' : 'PASS'} (${failed} of ${points.length} frames over ${MAX_HOT * 100}% hot or ${MAX_HOT_BLOCKS} hot blocks)`);
page.close();
process.exit(failed ? 1 : 0);
