/**
 * Rolling stock for the vehicle kit: the steam express locomotive with its tender (the Rail Yard's), a passenger carriage
 * (solid, or the hollow walk-through one), the diesel of shapes.ts `locomotive`, and the freight boxcar of `trainCar`.
 * Models in metres, nose toward +x, sized to the collision they stand on.
 */
import { Model, chain, mat, move, rotY, rotZ, type Paint } from './vehiclemesh.ts';

const GLASS = mat('#1e2a3a', { gloss: true });
const FONT = (px: number) => `700 ${px}px "Barlow Condensed", "Arial Narrow", sans-serif`;
const hex = (h: string) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const darker = (h: string, k: number) => `#${hex(h).map((v) => Math.round(v * (1 - k)).toString(16).padStart(2, '0')).join('')}`;
const near = (v: number, step: number, w: number) => { const r = ((v % step) + step) % step; return r < w || r > step - w; };
/** Coal: lumps on a jittered grid, each its own shade. */
const hash = (a: number, b: number) => { const v = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return v - Math.floor(v); };
const lump = (x: number, y: number) => {
  const s = 0.22, gx = Math.floor(x / s), gy = Math.floor(y / s);
  let best = 9, id = 0;
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    const cx = (gx + i + hash(gx + i, gy + j)) * s, cy = (gy + j + hash(gy + j, gx + i + 7)) * s, d = (x - cx) ** 2 + (y - cy) ** 2;
    if (d < best) { best = d; id = hash(gx + i + 3, gy + j + 5); }
  }
  return id;
};

function stencil(g: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, color: string, rot = 0, spacing = 0.08) {
  g.save(); g.translate(x, y); g.rotate(rot);
  g.font = FONT(100); g.textAlign = 'center'; g.textBaseline = 'middle';
  g.scale(size / 100, size / 100);
  (g as unknown as { letterSpacing: string }).letterSpacing = `${spacing * 100}px`;
  g.fillStyle = color; g.fillText(s, 0, 0);
  g.restore();
}

/** Two- or three-axle bogie wheels on both sides at `xs`. */
function railWheels(m: Model, xs: readonly number[], y: number, r: number, rim = '#8a8f98') {
  const tyre = m.part('#2b2e34'), hub = m.part(rim);
  for (const x of xs) for (const s of [-1, 1]) m.wheel(tyre, hub, x, s * y, r, 0.16);
}

/* -- the steam express ------------------------------------------------------------------------------------------------------ */

type SteamLivery = { body: string; line: string; smoke: string; beam: string; name: string };
const STEAM: Record<string, SteamLivery> = {
  green: { body: '#3f6a4a', line: '#d9b24a', smoke: '#26292e', beam: '#b4524a', name: 'TINWAR EXPRESS' },
  mail: { body: '#5a5f66', line: '#c9c2b0', smoke: '#1f2226', beam: '#b4524a', name: 'NIGHT MAIL' },
};

/** The Rail Yard's tank engine and tender: 10 x 2.2 m, tender -5..-2.3, cab -2.3..-0.6, boiler to 4.5, pilot to 5.2 (nose +x). */
export function loco(livery = 'green'): Model {
  const L = STEAM[livery] ?? STEAM.green!;
  const m = new Model();
  m.top = 3.3;
  const body = mat(L.body), line = mat(L.line), smoke = mat(L.smoke), brass = mat('#c9a23c', { gloss: true }), beam = mat(L.beam), coal = mat('#1f2124'), coalHi = mat('#3a3d42');
  // Footplate and frames.
  const plate = m.part((_x, _y, _z, _nx, ny) => (ny > 0.6 || ny < -0.6 ? beam : mat('#2b2e34')));
  m.box(plate, -2.3, -1.0, 1.15, 4.55, 1.0, 1.35, 0.04);
  // Driving wheels with red rims, and the bogie wheels under the smokebox.
  railWheels(m, [0.2, 1.55, 2.9], 0.84, 0.72, L.beam);
  railWheels(m, [4.05], 0.8, 0.42);
  // The boiler: lined bands, the smokebox in black, its door at the front.
  const boiler = m.part((x, _y, _z, _nx, _ny, nz) => (nz > -0.2 && (Math.abs(x - 0.6) < 0.05 || Math.abs(x - 2.4) < 0.05) ? line : body));
  m.tube(boiler, -0.6, 3.9, 0, 2.2, 0.8, { ring: 26, cap: 0.05 });
  const box = m.part((x, y, z, nx) => (nx > 0.6 ? (Math.hypot(y, z - 2.2) < 0.1 ? brass : near(Math.hypot(y, z - 2.2), 0.32, 0.03) ? mat('#3d4450') : smoke) : smoke));
  m.tube(box, 3.85, 4.55, 0, 2.18, 0.85, { ring: 26, cap: 0.08 });
  // Chimney, dome and safety valve.
  const stack = m.part(smoke);
  m.tube(stack, 2.9, 3.65, 0, 0, 0.26, { ring: 16, xf: chain(rotY(-Math.PI / 2), move(4.15, 0, 0)) });
  m.tube(stack, 3.55, 3.7, 0, 0, 0.34, { ring: 16, xf: chain(rotY(-Math.PI / 2), move(4.15, 0, 0)) });
  const dome = m.part(brass);
  m.blob(dome, 2.0, 0, 2.95, 0.42, 0.38, 0.32);
  m.blob(dome, 0.2, 0, 2.98, 0.2, 0.18, 0.16);
  // Buffer beam, buffers, the pilot and the lamps.
  const bufBeam = m.part(beam);
  m.box(bufBeam, 4.5, -1.0, 0.75, 4.7, 1.0, 1.35, 0.04);
  const buffer = m.part(mat('#3d4450', { gloss: true }));
  for (const s of [-1, 1]) m.tube(buffer, 4.7, 5.05, s * 0.62, 1.05, 0.14, { ring: 12 });
  const pilot = m.part((x) => (near(x, 0.12, 0.03) ? mat('#3d4450') : mat('#2b2e34')));
  m.slab(pilot, [[4.7, -0.42], [5.18, -0.2], [5.18, 0.2], [4.7, 0.42]], 0.1, 0.6, { bevel: 0.04 });
  const lamp = m.part(mat('#ffe8b0', { gloss: true }));
  for (const s of [-1, 1]) m.blob(lamp, 4.62, s * 0.55, 1.55, 0.1, 0.12, 0.12);
  // The cab: lined sides, the spectacle windows, a curved roof.
  const cabPaint: Paint = (x, y, z, nx, ny, nz) => {
    if (nz > 0.6) return mat(darker(L.body, 0.15));
    if (nx > 0.6 && z > 2.45 && z < 2.95 && Math.abs(Math.abs(y) - 0.55) < 0.25) return GLASS;
    if ((ny > 0.6 || ny < -0.6) && z > 2.2 && z < 2.95 && x > -1.9 && x < -1.0) return mat('#1d2128');
    if ((ny > 0.6 || ny < -0.6) && (Math.abs(z - 1.65) < 0.04 || Math.abs(x + 2.2) < 0.04 || Math.abs(x + 0.72) < 0.04)) return line;
    return body;
  };
  const cab = m.part(cabPaint);
  m.box(cab, -2.32, -1.08, 1.35, -0.62, 1.08, 3.1, 0.04);
  const roof = m.part((x) => (near(x + 1.5, 0.5, 0.03) ? mat(darker(L.body, 0.3)) : mat(darker(L.body, 0.12))), { group: m.group() });
  m.loft(roof, [{ x: -2.45, w: 0, h: 0, z: 3.12 }, { x: -2.45, w: 1.14, h: 0.18, z: 3.12, n: 2.4 }, { x: -0.5, w: 1.14, h: 0.18, z: 3.12, n: 2.4 }, { x: -0.5, w: 0, h: 0, z: 3.12 }], { ring: 24, sub: 1 });
  // The tender: lined tank, heaped coal on top.
  const tenderPaint: Paint = (x, _y, z, _nx, ny) => ((ny > 0.6 || ny < -0.6) && (Math.abs(z - 1.25) < 0.04 || Math.abs(z - 2.35) < 0.04 || Math.abs(x + 4.88) < 0.04 || Math.abs(x + 2.48) < 0.04) ? line : body);
  const tender = m.part(tenderPaint);
  m.box(tender, -5.0, -1.06, 0.85, -2.36, 1.06, 2.5, 0.06);
  const coalMid = mat('#2a2d31');
  const heap = m.part((x, y) => { const v = lump(x, y); return v > 0.66 ? coalHi : v > 0.33 ? coalMid : coal; });
  m.loft(heap, [{ x: -4.85, w: 0, h: 0, z: 2.45 }, { x: -4.8, w: 0.85, h: 0.12, z: 2.45, n: 2.6 }, { x: -3.6, w: 0.95, h: 0.42, z: 2.45, n: 2.4 }, { x: -2.7, w: 0.9, h: 0.25, z: 2.45, n: 2.6 }, { x: -2.5, w: 0, h: 0, z: 2.45 }], { ring: 20, sub: 2, half: true });
  railWheels(m, [-4.3, -3.05], 0.84, 0.45);
  m.lights.push({ key: 'firebox', at: [-1.4, 0, 2.0], color: '#ff9a3c', radius: 150, intensity: 0.55, size: 6 });
  m.lights.push({ key: 'lampL', at: [4.62, -0.55, 1.55], color: '#ffe8b0', radius: 120, intensity: 0.45, size: 4 });
  m.lights.push({ key: 'lampR', at: [4.62, 0.55, 1.55], color: '#ffe8b0', radius: 120, intensity: 0.45, size: 4 });
  m.sideDecals(-5.1, 0.8, -2.2, 2.6, 48, [tender], (g) => { stencil(g, livery === 'mail' ? 'MAIL' : 'S R', -3.68, -1.8, 0.55, L.line, 0, 0.12); });
  return m;
}

/* -- carriages ---------------------------------------------------------------------------------------------------------- */

type CarLivery = { upper: string; lower: string; line: string; roof: string; name: string };
const CARRIAGE: Record<string, CarLivery> = {
  green: { upper: '#d8cfb4', lower: '#7a2e2a', line: '#d9b24a', roof: '#5a5f66', name: 'FIRST' },
  mail: { upper: '#7a2e2a', lower: '#7a2e2a', line: '#d9b24a', roof: '#3d4450', name: 'ROYAL MAIL' },
};

/**
 * A passenger carriage, 8.44 x 2.19 m (the Rail Yard's 540 x 140 px), chamfered ends. `hollow` is the walk-through car: no
 * roof, the floor and seats inside, side walls with two door openings each (the map's sliding doors fill them).
 */
export function carriage(livery = 'green', variant = 'solid'): Model {
  const L = CARRIAGE[livery] ?? CARRIAGE.green!;
  const m = new Model();
  const len = 8.44, wid = 2.19, X = len / 2, Y = wid / 2;
  const upper = mat(L.upper), lower = mat(L.lower), line = mat(L.line), win = GLASS, roof = mat(L.roof), vent = mat('#3d4450');
  let bodIdx = -1;
  const side: Paint = (x, _y, z, _nx, ny, nz) => {
    if (nz > 0.6) return roof;
    const flank = ny > 0.5 || ny < -0.5;
    if (flank && z > 2.05 && z < 2.6 && livery !== 'mail' && !near(x + X - 0.35, 0.95, 0.12) && Math.abs(x) < X - 0.4) return win;
    if (flank && (Math.abs(z - 1.95) < 0.035 || Math.abs(z - 2.72) < 0.035)) return line;
    return z > 1.95 ? upper : lower;
  };
  if (variant === 'hollow') {
    m.top = 2.9;
    // Floor, end walls, side walls with door gaps, two rows of seats.
    const floor = m.part((x) => (near(x, 0.3, 0.03) ? mat('#5a4632') : mat('#7a5a3a')));
    m.box(floor, -X, -Y, 1.0, X, Y, 1.12, 0.02);
    const wall = m.part(side, { inner: '#b9ae90' });
    const w = 0.22, doors = [[-2.97, -1.41], [1.41, 2.97]] as const;
    for (const s of [-1, 1]) {
      let x0 = -X + 0.4;
      for (const [d0, d1] of [...doors, [X - 0.4, X - 0.4]] as const) {
        if (d0 > x0) m.box(wall, x0, s > 0 ? Y - w : -Y, 1.0, d0, s > 0 ? Y : -Y + w, 2.9, 0.05);
        x0 = d1;
      }
    }
    for (const x of [-X, X - 0.4]) m.slab(wall, [[x, -Y + 0.4], [x + 0.4, -Y], [x + 0.4, Y], [x, Y - 0.4]].map(([a, b]) => (x < 0 ? [a!, b!] : [2 * x + 0.4 - a!, b!])) as [number, number][], 1.0, 2.9, { bevel: 0.05 });
    const seat = m.part('#4f6a8a');
    for (let x = -X + 0.9; x < X - 0.8; x += 0.95) {
      if (Math.abs(x) > 1.3 && Math.abs(x) < 3.1) continue;
      for (const s of [-1, 1]) m.box(seat, x - 0.28, s > 0 ? 0.25 : -0.85, 1.12, x + 0.28, s > 0 ? 0.85 : -0.25, 1.55, 0.08);
    }
  } else {
    m.top = 3.0;
    const bod = (bodIdx = m.part(side));
    // A rounded box with a domed roof: the chamfered plan is matched by pinching the ends.
    m.loft(bod, [
      { x: -X, w: 0, h: 0, z: 1.95 }, { x: -X, w: Y - 0.4, h: 0.82, z: 1.95, n: 3.2 }, { x: -X + 0.4, w: Y, h: 1.0, z: 1.98, n: 3.6 },
      { x: X - 0.4, w: Y, h: 1.0, z: 1.98, n: 3.6 }, { x: X, w: Y - 0.4, h: 0.82, z: 1.95, n: 3.2 }, { x: X, w: 0, h: 0, z: 1.95 },
    ], { ring: 30, sub: 1 });
    const ventP = m.part(vent);
    for (let x = -X + 1.2; x < X - 1; x += 1.6) m.blob(ventP, x, 0, 2.97, 0.22, 0.16, 0.1, { rows: 6 });
    m.lights.push({ key: 'windows', at: [0, Y, 2.3], color: '#ffd9a0', radius: 180, intensity: 0.35, size: 10 });
  }
  const under = m.part('#2b2e34');
  m.box(under, -X + 0.6, -Y + 0.3, 0.55, X - 0.6, Y - 0.3, 0.98, 0.03);
  railWheels(m, [-X + 1.0, -X + 2.0, X - 2.0, X - 1.0], 0.85, 0.42);
  const buf = m.part(mat('#3d4450', { gloss: true }));
  for (const s of [-1, 1]) for (const e of [-1, 1]) m.tube(buf, e > 0 ? X : -X - 0.25, e > 0 ? X + 0.25 : -X, s * 0.65, 1.05, 0.13, { ring: 10 });
  if (bodIdx >= 0 && livery === 'mail') m.sideDecals(-X, 0.5, X, 3.0, 48, [bodIdx], (g) => { stencil(g, L.name, 0, -2.35, 0.42, L.line, 0, 0.12); });
  return m;
}

/* -- diesel and freight --------------------------------------------------------------------------------------------------- */

/** The diesel of shapes.ts `locomotive`: 19 m, a long engine hood toward the nose (+x), the cab at the back. */
export function dieselLoco(livery = 'freight'): Model {
  const col = livery === 'green' ? '#3f6a4a' : livery === 'rust' ? '#8a4a3a' : '#c9a23c';
  const m = new Model();
  m.top = 3.55;
  const c = mat(col), stripe = mat('#1c1f26'), grille = mat(darker(col, 0.35)), roofC = mat(darker(col, 0.08));
  // The deck the full width of the collision, with yellow-and-black edge and a rail along each side.
  const deck = m.part((x, _y, z, _nx, ny) => ((ny > 0.6 || ny < -0.6) && z < 1.25 ? (near(x, 0.6, 0.3) ? stripe : mat('#d9b24a')) : mat('#3d4450')));
  m.slab(deck, [[-9.3, -1.55], [6.4, -1.4], [9.45, -0.7], [9.45, 0.7], [6.4, 1.4], [-9.3, 1.55]], 0.95, 1.3, { bevel: 0.05 });
  // The long hood: a narrow rounded box with louvres, the radiator fans on top and the short nose ahead.
  const hood = m.part((x, y, _z, _nx, ny, nz) => {
    if (nz > 0.85 && x > 3.0 && x < 5.8 && near(x - 3.0, 1.4, 0.62) && Math.abs(y) < 0.55) return near(Math.hypot(x - 3.0 - Math.round((x - 3.0) / 1.4) * 1.4, y), 0.12, 0.03) ? stripe : grille;
    if ((ny > 0.6 || ny < -0.6) && near(x, 0.9, 0.05)) return grille;
    if (nz > 0.85 && near(x, 1.8, 0.03)) return grille;
    return c;
  });
  m.slab(hood, [[-3.85, -1.0], [6.0, -1.0], [6.0, 1.0], [-3.85, 1.0]], 1.3, 3.15, { bevel: 0.22 });
  const nose = m.part((_x, y, z, nx) => (nx > 0.6 && z > 1.6 && Math.abs(Math.abs(y) - 0.5) < 0.2 ? mat('#ffe8b0', { gloss: true }) : c));
  m.slab(nose, [[6.0, -0.95], [8.6, -0.8], [9.3, -0.5], [9.3, 0.5], [8.6, 0.8], [6.0, 0.95]], 1.3, 2.3, { bevel: 0.15 });
  const exhaust = m.part('#2b2e34');
  m.box(exhaust, 0.4, -0.25, 3.1, 1.0, 0.25, 3.32, 0.05);
  // The cab at the back: windows all round, a lighter roof.
  const cab = m.part((x, y, z, nx, ny, nz) => {
    if (nz > 0.8) return roofC;
    if (z > 2.55 && z < 3.15 && (nx > 0.5 || nx < -0.5 || ny > 0.6 || ny < -0.6) && Math.abs(y) > 0.08 && Math.abs(x + 6.6) > 0.06) return GLASS;
    if ((ny > 0.6 || ny < -0.6) && Math.abs(z - 1.7) < 0.1) return stripe;
    return c;
  });
  m.slab(cab, [[-9.35, -1.35], [-9.1, -1.6], [-3.85, -1.6], [-3.85, 1.6], [-9.1, 1.6], [-9.35, 1.35]], 1.3, 3.55, { bevel: 0.2 });
  railWheels(m, [-7.9, -6.6, -5.3, 4.2, 5.5, 6.8], 1.25, 0.5);
  const rail = m.part('#c9a23c');
  for (const s of [-1, 1]) m.tube(rail, -3.7, 8.4, s * 1.32, 2.0, 0.04, { ring: 6 });
  const horn = m.part(mat('#8a8f98', { gloss: true }));
  m.tube(horn, -4.6, -4.0, 0, 3.7, 0.1, { ring: 10 });
  const beacon = m.part(mat('#e8a23a', { gloss: true }));
  m.blob(beacon, -6.6, 0, 3.6, 0.14, 0.14, 0.12);
  m.lights.push({ key: 'head', at: [9.3, 0, 1.9], color: '#ffe8b0', radius: 220, intensity: 0.6, size: 6 });
  m.lights.push({ key: 'beacon', at: [-6.6, 0, 3.7], color: '#ffb347', radius: 140, intensity: 0.45, blinkMs: 1300, size: 5 });
  m.decals(-9.4, -1.6, 9.5, 1.6, 40, [cab, hood], (g) => { stencil(g, '7741', -6.6, 0, 0.6, '#1c1f26', -Math.PI / 2, 0.1); });
  return m;
}

/** A freight boxcar, 20 x 3 m (shapes.ts `trainCar`): ribbed sides, a sliding door, a roof walk and a ladder at each end. */
export function boxcar(livery = 'rust', variant?: string): Model {
  const col = livery === 'green' ? '#4a6a56' : livery === 'grey' ? '#6b7480' : '#8a4a3a';
  const m = new Model();
  m.top = 3.4;
  const c = mat(col), rib = mat(darker(col, 0.2)), door = mat(darker(col, 0.1)), roofC = mat(darker(col, 0.12)), rust = mat('#a8552e');
  const bod = m.part((x, y, z, _nx, ny, nz) => {
    if (nz > 0.8) return near(x, 1.0, 0.04) ? rib : roofC;
    if (ny > 0.5 || ny < -0.5) {
      if (Math.abs(x) < 1.6) return near(x, 0.4, 0.04) || Math.abs(Math.abs(x) - 1.6) < 0.06 ? rib : door;
      if (near(x, 0.9, 0.06)) return rib;
      if (variant === 'rust' && Math.sin(x * 3.1 + z * 4) * Math.sin(z * 5 - x) > 0.55) return rust;
    }
    void y;
    return c;
  });
  m.slab(bod, [[-10, -1.15], [-9.65, -1.5], [9.65, -1.5], [10, -1.15], [10, 1.15], [9.65, 1.5], [-9.65, 1.5], [-10, 1.15]], 0.95, 3.25, { bevel: 0.12 });
  const walk = m.part((x) => (near(x, 0.6, 0.05) ? mat('#4a4038') : mat('#6a5a44')));
  m.box(walk, -9.6, -0.3, 3.25, 9.6, 0.3, 3.4, 0.02);
  const under = m.part('#2b2e34');
  m.box(under, -9.2, -1.2, 0.5, 9.2, 1.2, 0.95, 0.03);
  railWheels(m, [-8.4, -7.2, 7.2, 8.4], 1.3, 0.45);
  const ladder = m.part('#c9a23c');
  for (const e of [-1, 1]) for (const s of [-1, 1]) m.box(ladder, e * 9.75 - 0.05, s * 1.1 - 0.25, 0.9, e * 9.75 + 0.05, s * 1.1 + 0.25, 3.35, 0.01);
  m.sideDecals(-10, 0.9, 10, 3.3, 40, [bod], (g) => { stencil(g, 'TINWAR RAIL', -5.6, -2.5, 0.48, '#e2dccb', 0, 0.1); stencil(g, '40 TONS', 5.6, -1.4, 0.28, '#e2dccb', 0, 0.08); });
  void rotZ;
  return m;
}
