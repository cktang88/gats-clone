import { polygon, roundBox, TAU, type Trace } from './cel.ts';
import { INK, shadeHex } from './palette.ts';

/**
 * Helmet styles for the soldier's head (the `h_` cosmetics). Each is a few chunky ink-outlined toy shapes drawn in the world's
 * frame over the head's cached sprite: the head is a disc of radius `u` standing `T` px up-screen of the body, and a hat sits
 * on it, so tall pieces (a cone, a chef's puffs, horns, a crown's points) stand up-screen of it and the oriented ones (a
 * visor, earflaps, a crest) turn with the aim `a`. The player's colour stays on the helmet where a real one would show it, so a
 * team is still a team under a party hat. Every id in the catalog has a style here (test/client-cosmetics.test.ts).
 */
export type HeadKit = {
  g: CanvasRenderingContext2D;
  /** Head disc radius, the head's lift above the body, the ink width and the lip (thickness) of a helmet, all in px. */
  u: number; T: number; ink: number; lip: number;
  /** The aim, and the player's colour. */
  a: number; color: string;
  /** A ground-plane offset from the head's centre: `f` along the aim and `s` to its right, in head radii, as px. */
  xy(f: number, s: number): [number, number];
  /** A cel-shaded part standing from `rise` px above the body to `rise + lip`; coordinates are in the head's frame. */
  part(trace: Trace, base: string, lip?: number, rise?: number, size?: number): void;
};

export type HelmetDef = {
  /** The farthest the style reaches from the head's top centre, in head radii, so the sprite is big enough for it. */
  reach: number;
  paint(k: HeadKit): void;
};

const OLIVE = '#6c7356', KHAKI = '#b4a07a', BONE = '#e2dccb', RUST = '#a8552e', ORANGE = '#ff5a1f', GOLD = '#ffd34d', STEEL = '#26304a';
const RED = '#e8433a', BLUE = '#3a7be8', TANK = '#3d4450';

/** A rotated ellipse. */
const ell = (cx: number, cy: number, rx: number, ry: number, rot = 0): Trace => (g) => {
  g.moveTo(cx + Math.cos(rot) * rx, cy + Math.sin(rot) * rx);
  g.ellipse(cx, cy, rx, ry, rot, 0, TAU);
};
const circle = (cx: number, cy: number, r: number): Trace => ell(cx, cy, r, r);

/** The helmet pot itself, in the player's colour: the base most hats sit on. */
const pot = (k: HeadKit, base = k.color) => k.part(circle(0, 0, k.u), shadeHex(base, 0.92), k.lip, k.T - k.lip);
/** Where a part sitting on top of the pot stands. */
const topOf = (k: HeadKit) => k.T;

function spec(k: HeadKit, x: number, y: number, r: number, lift = 0) {
  k.g.fillStyle = 'rgba(255, 255, 255, 0.6)';
  k.g.beginPath();
  k.g.arc(x, y - k.T - lift, r, 0, TAU);
  k.g.fill();
}

function stroke(k: HeadKit, pts: readonly (readonly [number, number])[], w: number, color: string, lift: number, close = false) {
  const g = k.g;
  g.save();
  g.translate(0, -lift);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.strokeStyle = color;
  g.lineWidth = w;
  g.beginPath();
  g.moveTo(pts[0]![0], pts[0]![1]);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i]![0], pts[i]![1]);
  if (close) g.closePath();
  g.stroke();
  g.restore();
}

/** A scalloped fur ring: bumps round a circle, for the ushanka. */
const fur = (cx: number, cy: number, r: number, n: number, bump: number): Trace => (g) => {
  g.moveTo(cx + r + bump, cy);
  for (let i = 0; i < n; i++) {
    const a = (i * TAU) / n;
    g.moveTo(cx + Math.cos(a) * r + bump, cy + Math.sin(a) * r);
    g.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, bump, 0, TAU);
  }
  g.moveTo(cx + r, cy);
  g.arc(cx, cy, r, 0, TAU);
};

export const HELMETS: Record<string, HelmetDef> = {
  h_standard: { reach: 1, paint() { /* drawn by bodies.ts: the classic steel pot with its goggles */ } },

  // A soft flat disc slouched to one side with a nub, a player-colour badge on the brow.
  h_beret: {
    reach: 1.5,
    paint(k) {
      const { u } = k;
      pot(k);
      const [cx, cy] = k.xy(0, 0.2);
      const rise = topOf(k) - k.lip * 0.4;
      k.part(ell(cx, cy, 1.28 * u, 1.12 * u, k.a + 0.3), OLIVE, u * 0.34, rise);
      k.part(circle(cx, cy, 0.17 * u), shadeHex(OLIVE, 0.7), 0, rise + u * 0.34);
      const [bx, by] = k.xy(0.78, -0.5);
      k.part(circle(bx, by, 0.24 * u), k.color, 0, rise + u * 0.34);
      spec(k, cx - 0.4 * u, cy - 0.38 * u, 0.12 * u, u * 0.34 - k.lip * 0.4);
    },
  },

  // A knotted cloth over the head: a darker band across the brow, dots, and a knot with two tails behind.
  h_bandana: {
    reach: 2.3,
    paint(k) {
      const { u } = k;
      const [kx, ky] = k.xy(-1.05, 0);
      for (const side of [-1, 1]) {
        const [tx, ty] = k.xy(-2.0, side * 0.75), [mx, my] = k.xy(-1.2, side * 0.3), [nx, ny] = k.xy(-1.35, side * 0.05);
        k.part(polygon([mx, my], [tx, ty], [nx, ny]), shadeHex(RUST, 0.85), 0, k.T - k.lip);
      }
      k.part(circle(kx, ky, 0.34 * u), shadeHex(RUST, 0.8), 0, k.T - k.lip);
      k.part(circle(0, 0, u), RUST, k.lip, k.T - k.lip);
      const top = k.T;
      const [f0x, f0y] = k.xy(0.75, -0.62), [f1x, f1y] = k.xy(0.75, 0.62);
      stroke(k, [[f0x, f0y], [f1x, f1y]], u * 0.34, shadeHex(RUST, 0.62), top - 0, false);
      k.g.fillStyle = BONE;
      k.g.beginPath();
      for (const [f, s] of [[-0.2, -0.45], [0.1, 0.25], [-0.35, 0.5]] as const) { const [x, y] = k.xy(f, s); k.g.moveTo(x + u * 0.11, y - top); k.g.arc(x, y - top, u * 0.11, 0, TAU); }
      k.g.fill();
      spec(k, -0.4 * u, -0.4 * u, 0.1 * u);
    },
  },

  // Fur ring, a khaki crown, flaps out to the sides, a badge in the player's colour at the front.
  h_ushanka: {
    reach: 1.7,
    paint(k) {
      const { u } = k;
      const rise = k.T - k.lip;
      for (const side of [-1, 1]) {
        const [x, y] = k.xy(-0.1, side * 1.05);
        k.part(ell(x, y + 0.18 * u, 0.55 * u, 0.7 * u, k.a + Math.PI / 2), BONE, 0, rise);
      }
      k.part(fur(0, 0, 0.82 * u, 8, 0.38 * u), BONE, k.lip * 0.8, rise);
      k.part(circle(0, 0, 0.82 * u), KHAKI, k.lip * 0.5, rise + k.lip * 0.8);
      const [bx, by] = k.xy(0.55, 0);
      k.part(circle(bx, by, 0.22 * u), k.color, 0, rise + k.lip * 1.3);
      spec(k, -0.3 * u, -0.35 * u, 0.1 * u, k.lip * 1.3 - k.lip);
    },
  },

  // A padded dark cap: stitched ridges front to back, ear cups, a player-colour stripe, a goggle strap.
  h_tanker: {
    reach: 1.25,
    paint(k) {
      const { u } = k;
      for (const side of [-1, 1]) { const [x, y] = k.xy(-0.05, side * 1.0); k.part(circle(x, y, 0.34 * u), shadeHex(TANK, 0.8), 0, k.T - k.lip); }
      k.part(circle(0, 0, u), TANK, k.lip, k.T - k.lip);
      const top = k.T;
      for (const s of [-0.45, 0, 0.45]) { const [x0, y0] = k.xy(-0.8, s * 1.1), [x1, y1] = k.xy(0.8, s * 1.1); stroke(k, [[x0, y0], [x1, y1]], u * 0.1, 'rgba(255, 255, 255, 0.2)', top); }
      const [sx0, sy0] = k.xy(0.45, -0.85), [sx1, sy1] = k.xy(0.45, 0.85);
      stroke(k, [[sx0, sy0], [sx1, sy1]], u * 0.3, k.color, top);
      const [gx0, gy0] = k.xy(0.85, -0.45), [gx1, gy1] = k.xy(0.85, 0.45);
      stroke(k, [[gx0, gy0], [gx1, gy1]], u * 0.22, INK, top);
      spec(k, -0.4 * u, -0.45 * u, 0.1 * u);
    },
  },

  // A wide khaki brim round an olive crown with a darker band.
  h_boonie: {
    reach: 1.75,
    paint(k) {
      const { u } = k;
      const rise = k.T - k.lip;
      k.part(ell(0, 0, 1.62 * u, 1.5 * u, 0.12), KHAKI, k.lip * 0.35, rise);
      k.part(circle(0, 0, 0.98 * u), OLIVE, k.lip * 1.2, rise + k.lip * 0.35);
      const top = rise + k.lip * 1.55;
      k.g.save();
      k.g.translate(0, -top);
      k.g.strokeStyle = shadeHex(KHAKI, 0.7);
      k.g.lineWidth = u * 0.22;
      k.g.beginPath();
      k.g.arc(0, 0, 0.98 * u - u * 0.11, 0, TAU);
      k.g.stroke();
      k.g.restore();
      k.part(circle(0, 0, 0.6 * u), OLIVE, 0, top);
      spec(k, -0.3 * u, -0.28 * u, 0.1 * u, top - k.T);
    },
  },

  // An orange traffic cone standing on its square foot, a white reflective band across it.
  h_cone: {
    reach: 3.0,
    paint(k) {
      const { u } = k;
      const rise = k.T - k.lip * 0.5;
      k.part(roundBox(-0.95 * u, -0.5 * u, 0.95 * u, 0.5 * u, 0.2 * u), shadeHex(ORANGE, 0.85), k.lip * 0.5, rise);
      const h = 2.3 * u, w0 = 0.78 * u, w1 = 0.2 * u;
      const body = polygon([-w0, 0], [w0, 0], [w1, -h], [-w1, -h]);
      k.part(body, ORANGE, 0, rise + k.lip * 0.5, u * 1.4);
      // The white band, clipped to the cone.
      const g = k.g;
      g.save();
      g.translate(0, -(rise + k.lip * 0.5));
      g.beginPath();
      body(g);
      g.clip();
      const t = (f: number) => w0 + (w1 - w0) * f;
      g.fillStyle = BONE;
      g.beginPath();
      g.moveTo(-t(0.34), -h * 0.34); g.lineTo(t(0.34), -h * 0.34); g.lineTo(t(0.62), -h * 0.62); g.lineTo(-t(0.62), -h * 0.62);
      g.closePath();
      g.fill();
      g.fillStyle = 'rgba(10, 12, 20, 0.22)';
      g.beginPath();
      g.moveTo(w0 * 0.1, 0); g.lineTo(w0, 0); g.lineTo(w1, -h); g.lineTo(w1 * 0.1, -h);
      g.closePath();
      g.fill();
      g.fillStyle = 'rgba(255, 255, 255, 0.45)';
      g.beginPath();
      g.moveTo(-w0 * 0.6, -u * 0.2); g.lineTo(-w0 * 0.4, -u * 0.2); g.lineTo(-w1 * 0.1, -h * 0.9); g.lineTo(-w1 * 0.7, -h * 0.9);
      g.closePath();
      g.fill();
      g.restore();
      g.save();
      g.translate(0, -(rise + k.lip * 0.5));
      g.lineJoin = 'round';
      g.strokeStyle = INK;
      g.lineWidth = k.ink * 2;
      g.beginPath();
      body(g);
      g.stroke();
      g.restore();
    },
  },

  // A tall pleated white toque: a band and three puffs, with the lit dot on the round of each.
  h_chef: {
    reach: 3.0,
    paint(k) {
      const { u } = k;
      const rise = k.T - k.lip * 0.6;
      k.part(ell(0, 0, 1.0 * u, 0.95 * u), BONE, k.lip * 1.2, rise);
      const base = rise + k.lip * 1.2;
      k.part(circle(-0.62 * u, -0.1 * u, 0.7 * u), BONE, u * 0.45, base);
      k.part(circle(0.62 * u, -0.1 * u, 0.7 * u), BONE, u * 0.45, base);
      k.part(circle(0, -0.95 * u, 0.82 * u), BONE, u * 0.5, base + u * 0.3);
      k.part(circle(0, -0.1 * u, 0.74 * u), BONE, u * 0.4, base + u * 0.75);
      const y = -(base + u * 1.15);
      k.g.strokeStyle = 'rgba(28, 31, 38, 0.3)';
      k.g.lineWidth = u * 0.1;
      k.g.lineCap = 'round';
      k.g.beginPath();
      for (const dx of [-0.38, 0.38]) { k.g.moveTo(dx * u, y + u * 0.45); k.g.lineTo(dx * u * 1.05, y + u * 1.0); }
      k.g.stroke();
    },
  },

  // A leather cap with ear flaps, a strap across the brow and a pair of gold-rimmed goggles pushed up on it.
  h_pilot: {
    reach: 1.5,
    paint(k) {
      const { u } = k;
      const rise = k.T - k.lip;
      for (const side of [-1, 1]) { const [x, y] = k.xy(-0.1, side * 1.0); k.part(ell(x, y, 0.5 * u, 0.62 * u, k.a + Math.PI / 2), shadeHex(RUST, 0.8), 0, rise); }
      k.part(circle(0, 0, u), RUST, k.lip, rise);
      const top = k.T;
      const [a0x, a0y] = k.xy(0.55, -0.9), [a1x, a1y] = k.xy(0.55, 0.9);
      stroke(k, [[a0x, a0y], [a1x, a1y]], u * 0.3, '#2c3037', top);
      for (const side of [-1, 1]) {
        const [x, y] = k.xy(0.65, side * 0.42);
        k.part(circle(x, y, 0.36 * u), GOLD, 0, top - 0.02 * u);
        k.g.fillStyle = '#9cd0ea';
        k.g.beginPath();
        k.g.arc(x, y - top, 0.2 * u, 0, TAU);
        k.g.fill();
        k.g.fillStyle = 'rgba(255, 255, 255, 0.7)';
        k.g.beginPath();
        k.g.arc(x - 0.07 * u, y - top - 0.07 * u, 0.06 * u, 0, TAU);
        k.g.fill();
      }
      spec(k, -0.45 * u, -0.4 * u, 0.1 * u);
    },
  },

  // A tri-colour beanie in six wedges with a button; the blades are drawn live by `drawPropeller`, spinning with the walk.
  h_propeller: {
    reach: 2.2,
    paint(k) {
      const { u } = k;
      const rise = k.T - k.lip;
      k.part(circle(0, 0, u), shadeHex(k.color, 0.9), k.lip * 0.6, rise);
      const g = k.g;
      const top = rise + k.lip * 0.6;
      const cols = [RED, BLUE, GOLD];
      g.save();
      g.translate(0, -top);
      g.lineJoin = 'round';
      g.strokeStyle = INK;
      g.lineWidth = k.ink * 2;
      g.beginPath();
      g.arc(0, 0, 1.02 * u, 0, TAU);
      g.stroke();
      g.save();
      g.beginPath();
      g.arc(0, 0, 1.0 * u, 0, TAU);
      g.clip();
      for (let i = 0; i < 6; i++) {
        g.fillStyle = cols[i % 3]!;
        g.beginPath();
        g.moveTo(0, 0);
        g.arc(0, 0, 1.3 * u, k.a + (i * TAU) / 6, k.a + ((i + 1) * TAU) / 6);
        g.closePath();
        g.fill();
      }
      g.strokeStyle = 'rgba(28, 31, 38, 0.5)';
      g.lineWidth = u * 0.07;
      g.beginPath();
      for (let i = 0; i < 6; i++) { g.moveTo(0, 0); g.lineTo(Math.cos(k.a + (i * TAU) / 6) * u, Math.sin(k.a + (i * TAU) / 6) * u); }
      g.stroke();
      g.restore();
      // A dark crescent away from the key light, a light one toward it.
      g.fillStyle = 'rgba(10, 12, 20, 0.25)';
      g.beginPath();
      g.arc(0, 0, 1.0 * u, -0.1, Math.PI * 0.6);
      g.arc(-0.2 * u, -0.16 * u, 1.0 * u, Math.PI * 0.6, -0.1, true);
      g.fill();
      g.restore();
      k.part(circle(0, 0, 0.2 * u), GOLD, u * 0.28, top);
      stroke(k, [[0, 0], [0, 0]], u * 0.16, INK, top + u * 0.7);
      spec(k, -0.35 * u, -0.42 * u, 0.1 * u, top - k.T);
    },
  },

  // A pot in the player's colour with a band of khaki and two curved bone horns with tipped ends.
  h_viking: {
    reach: 3.4,
    paint(k) {
      const { u } = k;
      const rise = k.T - k.lip;
      const g = k.g;
      for (const side of [-1, 1]) {
        const [rx, ry] = k.xy(0.0, side * 0.8);
        const [cx, cy] = k.xy(0.0, side * 1.55);
        const tx = cx + 0.12 * u, ty = cy - 1.25 * u;
        const lift = rise + k.lip * 0.5;
        g.save();
        g.translate(0, -lift);
        g.lineCap = 'round';
        const horn = (w: number, col: string, from = 0) => {
          g.strokeStyle = col;
          g.lineWidth = w;
          g.beginPath();
          const q = (t: number): [number, number] => [(1 - t) * (1 - t) * rx + 2 * (1 - t) * t * cx + t * t * tx, (1 - t) * (1 - t) * ry + 2 * (1 - t) * t * (cy - 0.1 * u) + t * t * ty];
          const [sx, sy] = q(from);
          g.moveTo(sx, sy);
          for (let t = from + 0.1; t <= 1.001; t += 0.1) { const [x, y] = q(t); g.lineTo(x, y); }
          g.stroke();
        };
        horn(0.68 * u + k.ink * 2, INK);
        horn(0.68 * u, BONE);
        horn(0.38 * u, KHAKI, 0.72);
        horn(0.2 * u, 'rgba(255, 255, 255, 0.45)', 0.1);
        g.restore();
      }
      k.part(circle(0, 0, u), k.color, k.lip, rise);
      const top = k.T;
      k.g.save();
      k.g.translate(0, -top);
      k.g.strokeStyle = KHAKI;
      k.g.lineWidth = u * 0.3;
      k.g.beginPath();
      k.g.arc(0, 0, u * 0.82, k.a - 2.0, k.a + 2.0);
      k.g.stroke();
      k.g.fillStyle = INK;
      k.g.beginPath();
      for (const dA of [-1.3, 0, 1.3]) { const x = Math.cos(k.a + dA) * u * 0.82, y = Math.sin(k.a + dA) * u * 0.82; k.g.moveTo(x + u * 0.08, y); k.g.arc(x, y, u * 0.08, 0, TAU); }
      k.g.fill();
      k.g.restore();
      spec(k, -0.4 * u, -0.4 * u, 0.1 * u);
    },
  },

  // A gold band with five points up-screen, a ruby in the player's colour at the front. Heavy is the head.
  h_crown: {
    reach: 2.2,
    paint(k) {
      const { u } = k;
      const rise = k.T - k.lip * 0.7;
      k.part(circle(0, 0, 0.95 * u), shadeHex(k.color, 0.9), k.lip * 0.6, k.T - k.lip);
      k.part(ell(0, 0, 1.0 * u, 0.95 * u), GOLD, k.lip * 1.3, rise);
      const base = rise + k.lip * 1.3;
      const w = 1.0 * u, pts: [number, number][] = [];
      pts.push([-w, 0.1 * u]);
      for (let i = 0; i < 5; i++) { const x0 = -w + (i * 2 * w) / 5, x1 = x0 + (2 * w) / 5; pts.push([x0 + (x1 - x0) * 0.1, -0.12 * u], [(x0 + x1) / 2, -1.25 * u], [x1 - (x1 - x0) * 0.1, -0.12 * u]); }
      pts.push([w, 0.1 * u]);
      k.part(polygon(...pts), GOLD, 0, base - u * 0.1, u * 0.9);
      for (let i = 0; i < 5; i++) { const x = -w + (i * 2 * w) / 5 + w / 5; k.part(circle(x, -1.25 * u + 0.05 * u, 0.15 * u), '#ffe08a', 0, base - u * 0.1); }
      const [gx, gy] = k.xy(0.5, 0);
      k.part(circle(gx * 0 + 0, 0.18 * u, 0.22 * u), RED, 0, base + 0.02 * u);
      void gx; void gy;
      spec(k, -0.5 * u, 0.0, 0.1 * u, k.lip * 1.3 - k.lip * 0.7);
    },
  },

  // A bronze helmet in the player's colour, a gold rim, and a transverse rust crest across the top.
  h_centurion: {
    reach: 2.6,
    paint(k) {
      const { u } = k;
      const rise = k.T - k.lip;
      const g = k.g;
      k.part(circle(0, 0, u), k.color, k.lip, rise);
      const top = k.T;
      g.save();
      g.translate(0, -top);
      g.strokeStyle = GOLD;
      g.lineWidth = u * 0.2;
      g.beginPath();
      g.arc(0, 0, u * 0.86, 0, TAU);
      g.stroke();
      g.restore();
      const [px, py] = k.xy(0, 1);
      const len = 1.75 * u, wd = 0.62 * u;
      const rot = Math.atan2(py, px);
      const crest = (g2: CanvasRenderingContext2D) => {
        g2.save();
        g2.rotate(rot);
        roundBox(-len, -wd / 2, len, wd / 2, wd * 0.4)(g2);
        g2.restore();
      };
      k.part(crest, RUST, u * 0.28, top + u * 0.18);
      // Bristles along the crest and gold studs at its ends.
      g.save();
      g.translate(0, -(top + u * 0.46));
      g.rotate(rot);
      g.strokeStyle = shadeHex(RUST, 0.6);
      g.lineWidth = u * 0.07;
      g.lineCap = 'round';
      g.beginPath();
      for (let x = -len * 0.8; x <= len * 0.8; x += u * 0.36) { g.moveTo(x, -wd * 0.3); g.lineTo(x, wd * 0.3); }
      g.stroke();
      g.fillStyle = GOLD;
      g.beginPath();
      for (const e of [-1, 1]) { g.moveTo(e * len * 0.92 + u * 0.12, 0); g.arc(e * len * 0.92, 0, u * 0.12, 0, TAU); }
      g.fill();
      g.restore();
    },
  },

  // A dark hooded cowl with a peak behind and a black opening at the front where two pale eyes look out.
  h_phantom: {
    reach: 2.3,
    paint(k) {
      const { u } = k;
      const rise = k.T - k.lip;
      const g = k.g;
      const [px, py] = k.xy(-2.3, 0), [qx, qy] = k.xy(-0.5, 0.95), [rx, ry] = k.xy(-0.5, -0.95);
      k.part(polygon([qx, qy], [px, py], [rx, ry]), shadeHex(STEEL, 0.9), 0, rise);
      k.part(circle(0, 0, 1.06 * u), STEEL, k.lip * 1.1, rise);
      const top = rise + k.lip * 1.1;
      const [ox, oy] = k.xy(0.55, 0);
      g.save();
      g.translate(0, -top);
      g.fillStyle = INK;
      g.beginPath();
      g.ellipse(ox, oy, 0.5 * u, 0.62 * u, k.a, 0, TAU);
      g.fill();
      g.fillStyle = '#e8e2d0';
      for (const s of [-1, 1]) { const [ex, ey] = k.xy(0.78, s * 0.24); g.beginPath(); g.arc(ex, ey, 0.09 * u, 0, TAU); g.fill(); }
      g.restore();
      spec(k, -0.45 * u, -0.45 * u, 0.1 * u, top - k.T);
    },
  },

  // A builder's yellow hard hat: a peak out front along the aim, a raised ridge from front to back, a lamp on the brow and a hazard band.
  h_hardhat: {
    reach: 1.45,
    paint(k) {
      const { u } = k;
      const rise = k.T - k.lip;
      const g = k.g;
      const [bx, by] = k.xy(0.38, 0);
      k.part(ell(bx, by, 1.32 * u, 1.12 * u, k.a), shadeHex(GOLD, 0.82), k.lip * 0.3, rise);
      k.part(circle(0, 0, 0.98 * u), GOLD, k.lip * 1.1, rise + k.lip * 0.3);
      const top = rise + k.lip * 1.4;
      const [r0x, r0y] = k.xy(-0.86, 0), [r1x, r1y] = k.xy(0.86, 0);
      stroke(k, [[r0x, r0y], [r1x, r1y]], u * 0.3, shadeHex(GOLD, 0.7), top);
      stroke(k, [[r0x, r0y], [r1x, r1y]], u * 0.12, '#fff1a8', top + u * 0.04);
      // The hazard band round the crown: short ink dashes.
      g.save();
      g.translate(0, -(rise + k.lip * 0.7));
      g.strokeStyle = INK;
      g.lineWidth = u * 0.16;
      g.setLineDash([u * 0.32, u * 0.32]);
      g.beginPath();
      g.arc(0, 0, 1.0 * u, 0, TAU);
      g.stroke();
      g.restore();
      const [lx, ly] = k.xy(0.82, 0);
      k.part(circle(lx, ly, 0.26 * u), '#3d4450', 0, top - u * 0.1);
      g.fillStyle = '#fff6c8';
      g.beginPath();
      g.arc(lx, ly - top + u * 0.1, 0.15 * u, 0, TAU);
      g.fill();
      spec(k, -0.4 * u, -0.38 * u, 0.1 * u, top - k.T);
    },
  },

  // A striped paper cone leaning back, with a gold pompom at the tip and the elastic under the chin.
  h_party: {
    reach: 3.0,
    paint(k) {
      const { u } = k;
      const rise = k.T - k.lip;
      const g = k.g;
      k.part(circle(0, 0, u), shadeHex(k.color, 0.9), k.lip, rise);
      const top = k.T;
      const h = 2.2 * u, w = 0.8 * u, lean = 0.28 * u;
      const body = polygon([-w, 0], [w, 0], [lean + 0.1 * u, -h], [lean - 0.1 * u, -h]);
      g.save();
      g.translate(0, -top);
      g.lineJoin = 'round';
      g.strokeStyle = INK;
      g.lineWidth = k.ink * 2;
      g.beginPath();
      body(g);
      g.stroke();
      g.beginPath();
      body(g);
      g.clip();
      const cols = [RED, BLUE, GOLD];
      for (let i = -2; i < 7; i++) {
        g.fillStyle = cols[((i % 3) + 3) % 3]!;
        g.beginPath();
        g.moveTo(-w * 1.3, -i * 0.45 * u + 0.2 * u);
        g.lineTo(w * 1.3, -i * 0.45 * u - 0.45 * u);
        g.lineTo(w * 1.3, -i * 0.45 * u - 0.9 * u);
        g.lineTo(-w * 1.3, -i * 0.45 * u - 0.25 * u);
        g.closePath();
        g.fill();
      }
      g.fillStyle = 'rgba(10, 12, 20, 0.24)';
      g.beginPath();
      g.moveTo(w * 0.15, 0); g.lineTo(w, 0); g.lineTo(lean + 0.1 * u, -h); g.lineTo(lean, -h);
      g.closePath();
      g.fill();
      g.fillStyle = 'rgba(255, 255, 255, 0.4)';
      g.beginPath();
      g.moveTo(-w * 0.7, -u * 0.2); g.lineTo(-w * 0.45, -u * 0.2); g.lineTo(lean - 0.06 * u, -h * 0.9); g.lineTo(lean - 0.1 * u, -h * 0.9);
      g.closePath();
      g.fill();
      g.restore();
      k.part(circle(lean, -h + 0.02 * u, 0.3 * u), GOLD, 0, top);
      spec(k, lean - 0.1 * u, -h - 0.08 * u, 0.08 * u, 0);
    },
  },
};

/** The helmet ids with a style, for the coverage test. */
export const HELMET_IDS: readonly string[] = Object.keys(HELMETS);

/**
 * The propeller beanie's blades, drawn live over the head (they spin with the walk, so they cannot be cached): two blades on a
 * stalk, flattened by the three-quarter view, blurred to a disc at a run. `spin` is in radians; `T` and `u` as in `HeadKit`.
 */
export function drawPropeller(g: CanvasRenderingContext2D, u: number, T: number, lip: number, spin: number, amount: number) {
  const top = T - lip + lip * 0.6 + u * 0.28 + u * 0.7;
  g.save();
  g.translate(0, -top);
  g.scale(1, 0.55);
  if (amount > 0.55) {
    g.fillStyle = 'rgba(232, 67, 58, 0.22)';
    g.beginPath();
    g.arc(0, 0, u * 1.65, 0, TAU);
    g.fill();
  }
  for (const [i, col] of [[0, RED], [1, BLUE]] as const) {
    g.save();
    g.rotate(spin + i * Math.PI);
    g.lineJoin = 'round';
    const blade: Trace = (c) => { c.moveTo(0, -u * 0.2); c.lineTo(u * 1.75, -u * 0.38); c.lineTo(u * 1.75, u * 0.18); c.lineTo(0, u * 0.2); c.closePath(); };
    g.beginPath();
    blade(g);
    g.strokeStyle = INK;
    g.lineWidth = u * 0.34;
    g.stroke();
    g.fillStyle = col;
    g.fill();
    g.fillStyle = 'rgba(255, 255, 255, 0.3)';
    g.fillRect(u * 0.2, -u * 0.18, u * 1.4, u * 0.1);
    g.restore();
  }
  g.fillStyle = GOLD;
  g.strokeStyle = INK;
  g.lineWidth = u * 0.14;
  g.beginPath();
  g.arc(0, 0, u * 0.2, 0, TAU);
  g.fill();
  g.stroke();
  g.restore();
}

/** The party hat ornaments etc. share one tall-piece reach table: how far a style stands up-screen of the head (for sprite sizing). */
export const helmetReach = (id: string): number => HELMETS[id]?.reach ?? 1;
