import { addPulse, decayPulse, decideFx, gradeFor, lightGovernor, vignetteReach, type Context, type FxMode, type Grade } from './fxparams.ts';
import { currentMood } from './mood.ts';
import { createLightGL, type LightGL } from './lightgl.ts';
import { addLight, addShockwave, ambientFor, liveShocks, pushOut, resolveLights, selectLights, setLightingEnabled, TIERS, type Occluder, type ViewRect } from './lighting.ts';

/**
 * The shader pass. The 2D world is uploaded as a texture once a frame and composited into a WebGL canvas that sits under
 * the game canvas: a half-res bloom of only the brightest light (threshold on luminance, so the bone floor never blooms),
 * a per-context colour grade, a soft vignette, a whisper of animated grain and, on big hits, a brief chromatic split.
 * The HUD is drawn afterwards on the (cleared) 2D canvas above, so it stays crisp and unprocessed, and input still lands
 * on the 2D canvas. Anything that goes wrong (no WebGL, software GL, a lost context, a slow upload) turns the pass off
 * and the plain canvas path draws the world exactly as before, at zero cost.
 *
 * When the lighting pass (lightgl.ts) is up as well, drawWorld hands over the world at the moment the night shade would
 * be painted (`captureBase`) and keeps drawing the rest (players, rounds, effects) on the cleared canvas as an overlay.
 * The composite then lights the base with the shadow-casting light buffer, lays the overlay over it unlit, and the bloom,
 * grade and vignette run on the result. If lighting fails or is never enabled, the frame is the plain upload as before.
 */

const VERT = `attribute vec2 a; varying vec2 v; void main(){ v = a * 0.5 + 0.5; gl_Position = vec4(a, 0.0, 1.0); }`;

const BRIGHT = `
precision mediump float;
varying vec2 v; uniform sampler2D src; uniform vec2 texel; uniform float thr;
vec3 pick(vec2 uv){
  vec3 c = texture2D(src, uv).rgb;
  float m = 0.5 * (dot(c, vec3(0.299, 0.587, 0.114)) + max(c.r, max(c.g, c.b)));
  float w = clamp((m - thr) / (1.0 - thr), 0.0, 1.0);
  return c * w * w;
}
void main(){
  vec2 o = texel;
  gl_FragColor = vec4((pick(v + vec2(-o.x, -o.y)) + pick(v + vec2(o.x, -o.y)) + pick(v + vec2(-o.x, o.y)) + pick(v + vec2(o.x, o.y))) * 0.25, 1.0);
}`;

const DOWN = `
precision mediump float;
varying vec2 v; uniform sampler2D src; uniform vec2 texel;
void main(){
  vec2 o = texel;
  gl_FragColor = (texture2D(src, v + vec2(-o.x, -o.y)) + texture2D(src, v + vec2(o.x, -o.y)) + texture2D(src, v + vec2(-o.x, o.y)) + texture2D(src, v + vec2(o.x, o.y))) * 0.25;
}`;

const BLUR = `
precision mediump float;
varying vec2 v; uniform sampler2D src; uniform vec2 dir;
void main(){
  vec3 c = texture2D(src, v).rgb * 0.2270270;
  c += (texture2D(src, v + dir * 1.3846154).rgb + texture2D(src, v - dir * 1.3846154).rgb) * 0.3162162;
  c += (texture2D(src, v + dir * 3.2307692).rgb + texture2D(src, v - dir * 3.2307692).rgb) * 0.0702703;
  gl_FragColor = vec4(c, 1.0);
}`;

const COMPOSITE = `
precision highp float;
varying vec2 v;
uniform sampler2D src, bloomA, bloomB;
uniform float bloom, ca, vig, grain, seed, gamma, sat, gscale;
uniform vec2 reach;
uniform vec3 lift, gain;
float hash(vec2 p){ p = fract(p * vec2(443.897, 441.423)); p += dot(p, p.yx + 19.19); return fract((p.x + p.y) * p.x); }
void main(){
  vec3 c;
  if (ca > 0.0) {
    vec2 d = (v - 0.5) * ca;
    c = vec3(texture2D(src, v + d).r, texture2D(src, v).g, texture2D(src, v - d).b);
  } else c = texture2D(src, v).rgb;
  vec3 b = (texture2D(bloomA, v).rgb * 0.55 + texture2D(bloomB, v).rgb * 0.95) * bloom;
  b *= vec3(1.0, 0.88, 0.7);
  c = 1.0 - (1.0 - c) * (1.0 - min(b, vec3(0.95)));
  float ax = 1.0 - clamp(min(v.x, 1.0 - v.x) / reach.x, 0.0, 1.0);
  float ay = 1.0 - clamp(min(v.y, 1.0 - v.y) / reach.y, 0.0, 1.0);
  float edge = 1.0 - (1.0 - ax * ax) * (1.0 - ay * ay);
  c = mix(c, vec3(0.047, 0.055, 0.078), vig * edge);
  c = max(c * gain + lift * (1.0 - c), 0.0);
  c = pow(c, vec3(1.0 / gamma));
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(vec3(l), c, sat);
  float n = hash(floor(gl_FragCoord.xy / gscale) + seed) - 0.5;
  c += n * 2.0 * grain * (1.0 - 0.5 * l);
  gl_FragColor = vec4(c, 1.0);
}`;

type Prog = { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> };
type Target = { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number };

let canvas: HTMLCanvasElement | null = null;
let gl: WebGLRenderingContext | null = null;
let mode: FxMode = 'off';
let reason = 'not started';
let progs: Record<'bright' | 'down' | 'blur' | 'comp', Prog>;
let srcTex: WebGLTexture;
let half: [Target, Target], quarter: [Target, Target];
let sized = '';
let shown = false;
let pulseNow = 0, pulseAt = 0;
let vigStrength = 0.4;
let chosen: FxMode = 'off';
let broken = false;
let forced = false;
let lightGL: LightGL | null = null;
let baseTex: WebGLTexture | null = null;
let sceneTex: WebGLTexture | null = null;
let lightBroken = false;
/** The pause menu's Effects option (settings.ts `fxPlan`): lighting switched off by choice, and the frame-time governors held back. */
let lightOff = false;
let holdGovernors = false;
/** The menu's attract mode is drawing (attract.ts): its capped, low-resolution frames say nothing about the GPU in a match. */
let attractHold = false;
/** Multipliers from the graphics preset (quality.ts) on the lights, their shadows, the glow and the grain. */
let rendererName: string | undefined;
/** The GPU's name as the browser reports it (undefined when hidden), for the graphics menu. */
export const fxRenderer = (): string | undefined => rendererName;
let plan = { lightMul: 1, shadowMul: 1, bloom: 1, grain: 1 };
let tierIx = 0;
let captured: { view: ViewRect; occluders: readonly Occluder[] } | null = null;
let lastLit = 0;
const governor = lightGovernor();
// A hidden tab, and the moments after it returns, say nothing about the GPU: the governor waits them out.
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => governor.holdUntil(document.hidden ? Infinity : performance.now() + 2000));
/** What the governor and the preset did, newest last, for the dev overlay and the dev probe. */
const fxLog: { at: number; what: string; tier: number; why: string }[] = [];
let lastCpuMs = 0;
let lastDecision = 'not started';
/** When lighting was given up for being slow, and when to try it again at the lowest tier. */
let retryAt = 0;
let retried = 0;
function note(what: string, why: string): void {
  fxLog.push({ at: Math.round(performance.now()), what, tier: tierIx, why });
  if (fxLog.length > 40) fxLog.shift();
  lastDecision = `${what}: ${why}`;
}

/** True while the shaders own the vignette, so ambience.ts leaves it out of the 2D canvas. */
export function owningVignette(): boolean { return mode !== 'off'; }
/** The vignette strength the 2D path would have painted this frame. */
export function setVignette(strength: number): void { vigStrength = strength; }
/** True while the lighting pass can take the night and the shadows from the 2D path this frame. */
export function lightingActive(): boolean { return mode !== 'off' && !!lightGL && !lightBroken && !lightOff; }
/** Dev probe: the lighting tier and what the last lit frame drew. */
export function lightState(): { on: boolean; tier: number; stats: ReturnType<LightGL['stats']> | null } { return { on: lightingActive(), tier: tierIx, stats: lightGL?.stats() ?? null }; }

/**
 * The lighting tier in force: 0 is the richest (TIERS[0]), `TIERS.length - 1` the leanest, and -1 when the lights are off for
 * any reason (no shader pass, the Low preset, a fault, or the governor gave them up). The pause menu reads this.
 */
export function lightingTier(): number { return lightingActive() ? tierIx : -1; }
/** How many lighting tiers there are, richest first. */
export const lightingTierCount = (): number => TIERS.length;
/**
 * Sets the lighting tier (clamped) and holds the frame-time governor at it until `setLightingTier(null)` hands it back (Auto).
 * No effect on a device whose shader pass is not running. Lighting stays off if the preset switched it off.
 */
export function setLightingTier(tier: number | null): void {
  if (tier === null) { pinnedBy = null; holdGovernors = presetHold; governor.reset(); return; }
  tierIx = Math.min(TIERS.length - 1, Math.max(0, Math.round(tier)));
  holdGovernors = true;
  pinnedBy = 'api';
  if (lightBroken) { lightBroken = false; setLightingEnabled(lightingActive()); }
  note('pinned', `tier ${tierIx}`);
}
let pinnedBy: 'api' | null = null;
/** Whether the graphics preset itself holds the governor (any preset but Auto). */
let presetHold = false;
/** The numbers the active tier allows (lights, shadow casters, decor lights), for the feed and the menu. */
export const lightingBudget = (): { lights: number; shadowLights: number; decor: number } => {
  const t = TIERS[tierIx]!;
  return { lights: Math.max(1, Math.round(t.lights * plan.lightMul)), shadowLights: Math.round(t.shadowLights * plan.shadowMul), decor: t.decor };
};
/**
 * One line saying what the lighting is doing and why, for the pause menu's graphics panel and the dev overlay, plus the facts behind it.
 */
export function lightingStatus(): { on: boolean; tier: number; tiers: number; line: string; renderer: string | null; decision: string; cpuMs: number; frameMs: number; limitMs: number; log: readonly { at: number; what: string; tier: number; why: string }[] } {
  const on = lightingActive();
  const g = governor.last();
  let line: string;
  if (on) line = `Lighting on, tier ${tierIx + 1} of ${TIERS.length}${holdGovernors ? ' (fixed)' : ''}`;
  else if (mode === 'off') line = `Plain picture: ${reason}`;
  else if (lightOff) line = 'Lighting off by the graphics preset';
  else line = `Lighting off: ${reason}`;
  return { on, tier: on ? tierIx : -1, tiers: TIERS.length, line, renderer: rendererName ?? null, decision: `${mode}/${reason}${lastDecision ? ` | ${lastDecision}` : ''}`, cpuMs: lastCpuMs, frameMs: g.avg, limitMs: g.limit, log: fxLog };
}

/** Whether the shader pass could run on this device at all (WebGL up, not software, not `?nofx`, not faulted): the Effects option only has a say then. */
export function fxCapable(): boolean { return !broken && !!gl && chosen !== 'off'; }

/**
 * Applies the graphics preset live (quality.ts `Knobs`). A device that never started the pass (no WebGL, software GL, `?nofx`) stays
 * plain whatever is asked. `hold` stops the pass stepping its own lighting tier down: only Auto lets it.
 */
export function setFxPlan(p: { post: boolean; lighting: boolean; tier: number; lightMul: number; shadowMul: number; bloom: number; grain: number; hold: boolean }): void {
  plan = { lightMul: p.lightMul, shadowMul: p.shadowMul, bloom: p.bloom, grain: p.grain };
  lightOff = !p.lighting;
  presetHold = p.hold;
  holdGovernors = p.hold || pinnedBy === 'api';
  if (pinnedBy !== 'api') {
    tierIx = Math.min(TIERS.length - 1, Math.max(0, p.tier));
    // A preset change is a fresh start: forgive earlier slow stretches, so Auto gets to try the lights again.
    if (lightBroken && p.lighting && lightGL) { lightBroken = false; reason = 'ok'; }
    governor.reset();
  }
  if (!p.post || !fxCapable()) mode = 'off';
  else mode = chosen;
  setLightingEnabled(lightingActive());
  note('preset', `${p.post ? (p.lighting ? `lights tier ${p.tier}` : 'post only') : 'plain'}${p.hold ? ', fixed' : ', auto'}`);
  if (mode === 'off') skipFrame();
}

/** Dev probe: the preset multipliers in force. */
export const fxPlanState = () => ({ ...plan, lightOff, holdGovernors, tier: tierIx, mode });

/** Why the pass is on or off, for the dev probe and tests. */
export function fxState(): { mode: FxMode; reason: string } { return { mode, reason }; }

/** A big hit or blast: a brief chromatic split at the screen edges. 0..1; ignored when the pass is off or calm. */
export function pulse(strength: number): void {
  if (mode !== 'full') return;
  pulseNow = addPulse(decayPulse(pulseNow, performance.now() - pulseAt), strength);
  pulseAt = performance.now();
}

function compile(g: WebGLRenderingContext, frag: string, names: string[]): Prog {
  const sh = (type: number, src: string) => {
    const s = g.createShader(type)!;
    g.shaderSource(s, src);
    g.compileShader(s);
    if (!g.getShaderParameter(s, g.COMPILE_STATUS)) throw new Error(g.getShaderInfoLog(s) ?? 'shader');
    return s;
  };
  const p = g.createProgram()!;
  g.attachShader(p, sh(g.VERTEX_SHADER, VERT));
  g.attachShader(p, sh(g.FRAGMENT_SHADER, frag));
  g.bindAttribLocation(p, 0, 'a');
  g.linkProgram(p);
  if (!g.getProgramParameter(p, g.LINK_STATUS)) throw new Error(g.getProgramInfoLog(p) ?? 'link');
  const u: Prog['u'] = {};
  for (const n of names) u[n] = g.getUniformLocation(p, n);
  return { p, u };
}

function texture(g: WebGLRenderingContext): WebGLTexture {
  const t = g.createTexture()!;
  g.bindTexture(g.TEXTURE_2D, t);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
  return t;
}

function target(g: WebGLRenderingContext, w: number, h: number): Target {
  const tex = texture(g);
  g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, w, h, 0, g.RGBA, g.UNSIGNED_BYTE, null);
  const fbo = g.createFramebuffer()!;
  g.bindFramebuffer(g.FRAMEBUFFER, fbo);
  g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, tex, 0);
  return { tex, fbo, w, h };
}

function free(g: WebGLRenderingContext, ts: Target[]) { for (const t of ts) { g.deleteTexture(t.tex); g.deleteFramebuffer(t.fbo); } }

/** Sets the pass up on its canvas. Safe to call once at startup; leaves everything off (and the canvas hidden) on any failure. */
export function initPostfx(el: HTMLCanvasElement): FxMode {
  canvas = el;
  const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
  let renderer: string | undefined;
  try {
    gl = el.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, powerPreference: 'high-performance' }) as WebGLRenderingContext | null;
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    if (gl && info) renderer = String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL));
    rendererName = renderer;
  } catch { gl = null; }
  const decision = decideFx({ search: location.search, reducedMotion, saveData: !!nav.connection?.saveData, deviceMemory: nav.deviceMemory, renderer, glOk: !!gl });
  forced = new URLSearchParams(location.search).has('fx');
  mode = chosen = decision.mode;
  reason = decision.reason;
  note('decide', `${decision.mode}: ${decision.reason}${renderer ? ` (${renderer})` : ''}`);
  // Dev only: flip the pass at runtime to compare the same scene with and without it.
  if (new URLSearchParams(location.search).has('dev')) (window as unknown as { __postfx: unknown }).__postfx = { status: lightingStatus, setTier: setLightingTier, log: () => fxLog, set: (on: boolean) => { mode = on && !broken ? chosen : 'off'; setLightingEnabled(mode !== 'off' && !!lightGL && !lightBroken); if (!on) skipFrame(); }, state: fxState, light: lightState, addLight, addShockwave, lighting: (on: boolean) => { lightBroken = !on; setLightingEnabled(on && mode !== 'off' && !!lightGL); } };
  if (mode !== 'off' && gl) {
    try {
      progs = {
        bright: compile(gl, BRIGHT, ['src', 'texel', 'thr']),
        down: compile(gl, DOWN, ['src', 'texel']),
        blur: compile(gl, BLUR, ['src', 'dir']),
        comp: compile(gl, COMPOSITE, ['src', 'bloomA', 'bloomB', 'bloom', 'ca', 'vig', 'grain', 'seed', 'gamma', 'sat', 'gscale', 'reach', 'lift', 'gain']),
      };
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.disable(gl.BLEND);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      srcTex = texture(gl);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      try {
        lightGL = createLightGL(gl);
        baseTex = texture(gl);
        // The lighting programs rebind the shared triangle themselves; make sure attribute 0 is back on a triangle afterwards.
        setLightingEnabled(true);
      } catch (err) {
        lightGL = null;
        reason = `lighting off: ${String(err).slice(0, 80)}`;
      }
      el.addEventListener('webglcontextlost', (e) => { e.preventDefault(); disable('context lost'); });
    } catch (err) {
      disable(`shader failed: ${String(err).slice(0, 80)}`);
    }
  } else if (gl) {
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    gl = null;
  }
  el.hidden = true;
  return mode;
}

function disable(why: string) {
  mode = 'off';
  setLightingEnabled(false);
  broken = true;
  reason = why;
  note('shaders off', why);
  if (canvas) canvas.hidden = true;
  shown = false;
}

function resizeTargets(w: number, h: number) {
  const g = gl!;
  const key = `${w}x${h}`;
  if (key === sized) return;
  if (sized) free(g, [...half, ...quarter]);
  sized = key;
  const hw = Math.max(2, w >> 1), hh = Math.max(2, h >> 1), qw = Math.max(2, w >> 2), qh = Math.max(2, h >> 2);
  half = [target(g, hw, hh), target(g, hw, hh)];
  quarter = [target(g, qw, qh), target(g, qw, qh)];
}

function pass(g: WebGLRenderingContext, prog: Prog, out: Target | null, w: number, h: number, inputs: WebGLTexture[], names: string[]) {
  g.useProgram(prog.p);
  g.bindFramebuffer(g.FRAMEBUFFER, out ? out.fbo : null);
  g.viewport(0, 0, w, h);
  inputs.forEach((t, i) => { g.activeTexture(g.TEXTURE0 + i); g.bindTexture(g.TEXTURE_2D, t); g.uniform1i(prog.u[names[i]], i); });
  g.drawArrays(g.TRIANGLES, 0, 3);
}

/**
 * drawWorld calls this at the point the night shade would be painted: uploads the world drawn so far as the lit base and
 * remembers what the lights need. The caller then clears the canvas and draws the rest of the frame as the overlay.
 * False means the lighting pass is not running this frame and the 2D path should paint the night itself.
 */
export function captureBase(source: HTMLCanvasElement, view: ViewRect, occluders: readonly Occluder[]): boolean {
  if (!lightingActive() || !gl || !baseTex || gl.isContextLost()) return false;
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, baseTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  captured = { view, occluders };
  return true;
}

/** Turns the lighting off for good (a shader fault, or the frame-time governor ran out of tiers); the plain pass carries on. */
function disableLighting(why: string) {
  lightBroken = true;
  setLightingEnabled(false);
  reason = `lighting off: ${why}`;
  note('lights off', why);
}

/**
 * Composites `source` (the 2D world) into the shader canvas. Returns true when it did, and the caller should then clear
 * the 2D canvas before drawing the HUD over it; false means nothing changed and the 2D canvas already shows the world.
 */
export function processFrame(source: HTMLCanvasElement, c: Context, now: number, cssW: number, cssH: number, dpr: number): boolean {
  if (mode === 'off' || !gl || !canvas) return false;
  if (gl.isContextLost()) { disable('context lost'); return false; }
  const t0 = performance.now();
  const g = gl, w = source.width, h = source.height;
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  if (!shown) { canvas.hidden = false; shown = true; }
  resizeTargets(w, h);
  const grade: Grade = gradeFor(c);
  g.activeTexture(g.TEXTURE0);
  g.bindTexture(g.TEXTURE_2D, srcTex);
  g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, source);
  // A lit frame: the upload above was only the overlay; the lights compose it over the captured base.
  let scene = srcTex;
  const cap = captured;
  captured = null;
  if (cap && lightGL && baseTex) {
    try {
      const tier = TIERS[tierIx]!;
      const lights = selectLights(resolveLights(now), cap.view, Math.max(1, Math.round(tier.lights * plan.lightMul)), Math.round(tier.shadowLights * plan.shadowMul)).map((l) => ({ ...l, ...pushOut(l.x, l.y, cap.occluders) }));
      sceneTex = lightGL.render({ w, h, view: cap.view, occluders: cap.occluders, lights, ambient: ambientFor(c.night, c.storm, currentMood()), tier, shocks: liveShocks(now), now }, baseTex, srcTex);
      if (sceneTex) scene = sceneTex;
      // Frame pacing is the honest GPU meter, but only a sustained stretch of slow frames counts (lightGovernor): step down a tier, then give the lights up.
      const t = performance.now();
      if (lastLit && !forced && !holdGovernors && !attractHold) {
        const step = governor.push(t - lastLit, lastCpuMs, t, tierIx, TIERS.length - 1, true);
        if (step.action === 'down') { tierIx++; note('step down', step.why); }
        else if (step.action === 'up') { tierIx--; note('step up', step.why); }
        else if (step.action === 'off') { disableLighting(step.why); retryAt = t + 45_000 * (retried + 1); }
      }
      lastLit = t;
    } catch (err) {
      disableLighting(String(err).slice(0, 80));
    }
  } else lastLit = 0;
  const [h0, h1] = half, [q0, q1] = quarter;
  g.useProgram(progs.bright.p);
  g.uniform2f(progs.bright.u.texel, 1 / w, 1 / h);
  g.uniform1f(progs.bright.u.thr, grade.bloomThreshold);
  pass(g, progs.bright, h0, h0.w, h0.h, [scene], ['src']);
  g.useProgram(progs.blur.p);
  g.uniform2f(progs.blur.u.dir, 1 / h0.w, 0);
  pass(g, progs.blur, h1, h1.w, h1.h, [h0.tex], ['src']);
  g.uniform2f(progs.blur.u.dir, 0, 1 / h0.h);
  pass(g, progs.blur, h0, h0.w, h0.h, [h1.tex], ['src']);
  g.useProgram(progs.down.p);
  g.uniform2f(progs.down.u.texel, 1 / h0.w, 1 / h0.h);
  pass(g, progs.down, q0, q0.w, q0.h, [h0.tex], ['src']);
  g.useProgram(progs.blur.p);
  g.uniform2f(progs.blur.u.dir, 1 / q0.w, 0);
  pass(g, progs.blur, q1, q1.w, q1.h, [q0.tex], ['src']);
  g.uniform2f(progs.blur.u.dir, 0, 1 / q0.h);
  pass(g, progs.blur, q0, q0.w, q0.h, [q1.tex], ['src']);

  const p = progs.comp, u = p.u;
  g.useProgram(p.p);
  const pl = pulseNow > 0 ? decayPulse(pulseNow, now - pulseAt) : 0;
  const [rx, ry] = vignetteReach(cssW, cssH);
  g.uniform1f(u.bloom, grade.bloomStrength * plan.bloom * (currentMood()?.glow ?? 1) * (1 + 0.35 * Math.min(1, c.night)));
  g.uniform1f(u.ca, pl * 0.012);
  g.uniform1f(u.vig, vigStrength);
  g.uniform1f(u.grain, grade.grain * plan.grain);
  g.uniform1f(u.seed, mode === 'calm' ? 7 : Math.floor(now / 100) % 997);
  g.uniform1f(u.gamma, grade.gamma);
  g.uniform1f(u.sat, grade.sat);
  g.uniform1f(u.gscale, Math.max(1, Math.round(dpr)));
  g.uniform2f(u.reach, rx, ry);
  g.uniform3f(u.lift, ...grade.lift);
  g.uniform3f(u.gain, ...grade.gain);
  pass(g, p, null, w, h, [scene, h0.tex, q0.tex], ['src', 'bloomA', 'bloomB']);
  lastCpuMs = lastCpuMs * 0.9 + (performance.now() - t0) * 0.1;
  if (!forced && !holdGovernors && !attractHold) {
    const t = performance.now();
    if (lightBroken && !lightOff && retryAt && t > retryAt && retried < 2) {
      // Lights were given up for being slow; a long while later, try the leanest tier once more.
      retried++; retryAt = 0; lightBroken = false; tierIx = TIERS.length - 1; governor.reset(); setLightingEnabled(lightingActive());
      note('retry', `lights back on at tier ${tierIx} after a quiet spell`);
    } else if (!lightingActive()) {
      // Lighting is off: a pass that still costs the CPU too much is dropped altogether.
      if (governor.push(16, lastCpuMs, t, tierIx, TIERS.length - 1, false).action === 'plain') disable(`too slow (${lastCpuMs.toFixed(1)} ms of CPU a frame)`);
    }
  }
  return true;
}

/** Holds the lighting governor while the menu's attract mode draws, and hands it a fresh start (after a settling moment) when it stops. */
export function holdForAttract(on: boolean): void {
  if (attractHold === on) return;
  attractHold = on;
  lastLit = 0;
  governor.holdUntil(on ? Infinity : performance.now() + 2000);
}

/** The plain-canvas path drew this frame (a menu with no world, say): hide the shader canvas so a stale frame never shows. */
export function skipFrame(): void { captured = null; if (shown && canvas) { canvas.hidden = true; shown = false; } }
