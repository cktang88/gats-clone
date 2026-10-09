import { GLINT, GLINT_WHITE, GLSL_SHOULDER, GLSL_TONE, PUDDLE, glf } from './exposure.ts';

/**
 * GLSL for the lighting pass (lightgl.ts). WebGL1-safe: no extensions, RGBA8 targets, constant loop bounds.
 *
 * The pipeline per frame, all at half resolution except the last:
 *  1. MASK   the standing solids rasterised into a texture: R = inside a solid, G = on a solid's front face.
 *  2. LIGHT  each light drawn additively over its bounding box. A pixel on open floor marches toward the light through
 *            the mask (one ray, or three spread across the source's width for a soft penumbra); a pixel on a wall's
 *            top is lit unshadowed (it stands above the light); a pixel on a front face is lit only by lights south of it.
 *  3. SHAFT  a cheap radial smear of the light buffer toward the brightest lights, for crepuscular rays at night.
 *  4. SCENE  the 2D world (base) lit by the buffer, floor darkened beside walls, the HUD-less overlay (players, rounds,
 *            effects) laid over it unlit, and a shock ring's refraction applied to all of it. Full resolution.
 */

export const FULL_VERT = `attribute vec2 a; varying vec2 v; void main(){ v = a * 0.5 + 0.5; gl_Position = vec4(a, 0.0, 1.0); }`;

export const MASK_VERT = `attribute vec3 a; varying float f; void main(){ f = a.z; gl_Position = vec4(a.xy, 0.0, 1.0); }`;
export const MASK_FRAG = `precision mediump float; varying float f; void main(){ gl_FragColor = vec4(1.0, f, 0.0, 1.0); }`;

const HIGHP = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
`;

export const LIGHT_FRAG = `${HIGHP}
uniform sampler2D mask;
uniform vec2 size;
uniform vec4 L;      // x, y (buffer px, GL origin), radius px, level
uniform vec3 col;
uniform vec4 cone;   // dir x, dir y, cos(half), soft; soft 0 means omni
uniform vec4 prm;    // source size px, ignore radius px, casts shadows 0/1, max steps
uniform float rays;
void main(){
  vec2 p = gl_FragCoord.xy;
  vec2 d = L.xy - p;
  float dist = length(d);
  if (dist >= L.z) discard;
  float t = dist / L.z;
  float att = 1.0 - t * t; att *= att;
  float hot = 1.0 - t; hot *= hot; hot *= hot;
  att *= (1.0 + 1.2 * hot) / 2.2;
  if (cone.w > 0.0) {
    float c = dot(-d / max(dist, 1.0), cone.xy);
    float cf = smoothstep(cone.z - cone.w, cone.z + cone.w, c);
    att *= mix(1.0, cf, smoothstep(0.02, 0.2, t));
  }
  vec2 uv = p / size;
  vec4 m = texture2D(mask, uv);
  float vis = 1.0;
  if (m.r > 0.5) {
    // A solid. Its top stands above the light, so it takes the light plainly; its front face only from lights to the south.
    vis = m.g > 0.5 ? 0.62 * smoothstep(-4.0, 8.0, p.y - L.y) : 0.9;
  } else if (prm.z > 0.5) {
    vec2 dir = d / max(dist, 1.0);
    vec2 nrm = vec2(-dir.y, dir.x);
    float j = fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
    float n = clamp(dist / 4.0, 4.0, prm.w);
    float lit = 0.0, cnt = 0.0;
    for (int r = 0; r < 3; r++) {
      if (float(r) >= rays) break;
      float off = rays > 1.5 ? float(r) - 1.0 : 0.0;
      float occ = 0.0;
      for (int i = 0; i < 24; i++) {
        if (float(i) >= n) break;
        float s = (float(i) + j) / n;
        float travelled = s * dist;
        if (travelled < 3.0) continue;
        if (dist - travelled < prm.y) break;
        vec2 q = p + d * s + nrm * (off * prm.x * s);
        occ = max(occ, texture2D(mask, q / size).r);
      }
      lit += 1.0 - clamp(occ * 1.1, 0.0, 1.0);
      cnt += 1.0;
    }
    vis = lit / cnt;
  }
  gl_FragColor = vec4(col * (L.w * att * vis * 0.5), 1.0);
}`;

export const SHAFT_FRAG = `${HIGHP}
varying vec2 v;
uniform sampler2D light;
uniform vec2 lc;       // the light's centre in uv
uniform vec3 col;
uniform float k, reach, aspect, time;
void main(){
  vec2 d = lc - v;
  vec2 da = vec2(d.x * aspect, d.y);
  float dist = length(da);
  float fade = 1.0 - clamp(dist / reach, 0.0, 1.0);
  if (fade <= 0.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  float acc = 0.0;
  for (int i = 0; i < 14; i++) {
    float s = (float(i) + 0.5) / 14.0;
    vec3 c = texture2D(light, v + d * s).rgb;
    acc += dot(c, vec3(0.3, 0.59, 0.11)) * (1.0 - 0.5 * s);
  }
  float ang = atan(da.y, da.x);
  float beams = 0.72 + 0.28 * sin(ang * 17.0 + time * 0.0004) * sin(ang * 5.0 - time * 0.0002);
  gl_FragColor = vec4(col * (acc / 14.0 * fade * fade * k * beams), 1.0);
}`;

/**
 * A visible shaft of light through the air: a cone from the source that widens with distance, brightest on its axis and
 * fading toward its end, with dust and mist drifting through it. Drawn additively into a small buffer the composite
 * adds on top of the lit world (under the soldiers), so a lighthouse or a floodlight reads as a beam, not just a pool.
 */
export const BEAM_FRAG = `${HIGHP}
uniform vec4 L;      // x, y (buffer px, GL origin), reach px, level
uniform vec3 col;
uniform vec4 dirw;   // dir x, dir y, tan(half), source half-width px
uniform float time, seed;
void main(){
  vec2 d = gl_FragCoord.xy - L.xy;
  float along = dot(d, dirw.xy);
  if (along <= 0.0 || along >= L.z) discard;
  float perp = dot(d, vec2(-dirw.y, dirw.x));
  float hw = along * dirw.z + dirw.w;
  float across = abs(perp) / hw;
  if (across >= 1.0) discard;
  float side = 1.0 - across; side = side * side * (3.0 - 2.0 * side);
  float core = 1.0 - across * across * 0.7;
  float t = along / L.z;
  float fall = (1.0 - t) * (1.0 - t) * smoothstep(0.0, 0.06, t);
  // A wide beam spreads the same light thinner.
  float thin = 1.0 / (1.0 + dirw.z * along / max(dirw.w * 6.0, 8.0));
  float mote = 0.78 + 0.22 * sin(along * 0.11 - time * 0.0017 + seed) * sin(perp * 0.09 + along * 0.03 + time * 0.0009);
  gl_FragColor = vec4(col * (L.w * side * core * fall * thin * mote), 1.0);
}`;

export const SCENE_FRAG = `${HIGHP}
varying vec2 v;
uniform sampler2D base, over, light, mask, shaft, beam;
uniform vec2 ltexel;      // one light-buffer texel in uv
uniform vec3 amb;
uniform float gain, ao, shafts;
uniform float aspect, time;
uniform vec4 vw;          // the view in world units: x0, y0, width, height
uniform vec4 fogc;        // fog colour, density
uniform vec4 fogp;        // fog scale, drift x, drift y, 0
uniform vec4 wx;          // wet 0..1, rain 0..1, beams on 0/1, emissive wash
float hash21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p){ return vnoise(p) * 0.62 + vnoise(p * 2.07 + 17.3) * 0.38; }
float rainStreak(vec2 uv){
  vec2 p = vec2(uv.x * aspect * 64.0 + uv.y * 7.0, uv.y * 2.4);
  float c = floor(p.x), r = hash21(vec2(c, 3.1));
  float y = fract(p.y + time * 0.0012 * (0.8 + r * 0.7) + r * 13.0);
  float len = 0.035 + 0.05 * r;
  float s = smoothstep(0.0, 0.004, y) * (1.0 - smoothstep(len * 0.4, len, y));
  s *= 1.0 - smoothstep(0.03, 0.14, abs(fract(p.x) - 0.5));
  return s * step(0.5, hash21(vec2(c, 9.7)));
}
uniform int nshock;
uniform vec4 sk[4];       // centre uv x, y, ring radius (screen heights), progress 0..1
uniform vec4 sp[4];       // strength, 0, 0, 0
${GLSL_SHOULDER}

vec3 lightAt(vec2 uv){
  vec2 o = ltexel * 0.5;
  return (texture2D(light, uv + vec2(-o.x, -o.y)).rgb + texture2D(light, uv + vec2(o.x, -o.y)).rgb
        + texture2D(light, uv + vec2(-o.x, o.y)).rgb + texture2D(light, uv + vec2(o.x, o.y)).rgb) * 0.25;
}

void main(){
  vec2 uv = v;
  for (int i = 0; i < 4; i++) {
    if (i >= nshock) break;
    vec2 c = sk[i].xy, r = (v - c) * vec2(aspect, 1.0);
    float dist = length(r), k = sk[i].w, R = sk[i].z;
    float edge = R * (1.0 - (1.0 - k) * (1.0 - k));
    float width = 0.018 + 0.03 * k;
    float rw = (dist - edge) / width;
    float ring = exp(-rw * rw);
    float life = (1.0 - k) * (1.0 - k);
    vec2 dir = r / max(dist, 1e-4);
    float shimmer = sin(v.y * 140.0 + time * 0.012) * sin(v.x * 90.0 - time * 0.009);
    float heat = (1.0 - smoothstep(R * 0.2, R, dist)) * (1.0 - k) * (1.0 - k) * 0.0016 * shimmer;
    vec2 off = dir * ring * life * 0.016 * sp[i].x;
    uv -= vec2(off.x / aspect, off.y) + vec2(heat, heat * 0.6) * sp[i].x;
  }
  vec3 b = texture2D(base, uv).rgb;
  vec4 o = texture2D(over, uv);
  // Lights add up, so they are tone-mapped to a fixed ceiling (exposure.ts): a mood's gain steepens the curve but never lifts
  // the ceiling, so overlapping lamps saturate to a warm pool instead of burning the floor white or orange.
  vec3 raw = lightAt(uv) * 2.0 + texture2D(shaft, uv).rgb * shafts;
  ${GLSL_TONE}
  float occ = 0.0;
  vec4 m = texture2D(mask, uv);
  if (ao > 0.0 && m.r < 0.5) {
    vec2 t1 = ltexel * 3.0, t2 = ltexel * 7.0;
    occ = texture2D(mask, uv + vec2(t1.x, 0.0)).r + texture2D(mask, uv - vec2(t1.x, 0.0)).r
        + texture2D(mask, uv + vec2(0.0, t1.y)).r + texture2D(mask, uv - vec2(0.0, t1.y)).r
        + 0.7 * (texture2D(mask, uv + vec2(t2.x, 0.0)).r + texture2D(mask, uv - vec2(t2.x, 0.0)).r
        + texture2D(mask, uv + vec2(0.0, t2.y)).r + texture2D(mask, uv - vec2(0.0, t2.y)).r);
    occ = occ / 6.8;
  }
  float a = 1.0 - ao * occ;
  // Under a strong light the cool ambient gives way to the light's own colour, so a lamp's pool reads amber, not grey.
  float strength = clamp(dot(L, vec3(0.3, 0.59, 0.11)) * 1.5, 0.0, 1.0);
  vec3 lit = b * (amb * a * (1.0 - 0.8 * strength) + L) + L * wx.w;
  float unlit = max(b.r * amb.r, max(b.g * amb.g, b.b * amb.b)) * a;
  vec2 wp = vec2(vw.x + uv.x * vw.z, vw.y + (1.0 - uv.y) * vw.w);
  // Water sits deep and dark at night, so the lamps on it read.
  float deep = smoothstep(0.02, 0.1, b.b - b.r) * clamp(1.0 - dot(amb, vec3(0.33)) * 1.4, 0.0, 0.6);
  lit *= 1.0 - 0.45 * deep;
  if (wx.x > 0.0 && m.r < 0.5) {
    // Wet ground: puddles hold the lights' colour as a sheen, and the stone glints where a lamp's light lands.
    float stone = 1.0 - smoothstep(0.02, 0.1, b.b - b.r);
    float pn = fbm(wp / 230.0 + 3.7);
    float pud = smoothstep(0.55, 0.64, pn) * stone * wx.x;
    float glint = pow(vnoise(wp / 7.0 + time * 0.0003), 7.0) * stone * wx.x;
    float lum = dot(L, vec3(0.3, 0.59, 0.11));
    lit = mix(lit, lit * 0.72 + L * ${glf(PUDDLE)} * (0.5 + 0.5 * a) + amb * 0.1, pud * 0.85);
    lit += L * glint * ${glf(GLINT)} * (0.25 + lum) + vec3(0.9, 0.95, 1.0) * glint * lum * ${glf(GLINT_WHITE)};
    if (wx.y > 0.0) {
      // Raindrops ringing the puddles.
      vec2 rp = wp / 26.0; vec2 cell = floor(rp);
      float ph = fract(time * 0.0009 + hash21(cell) * 7.0);
      float rd = (length(fract(rp) - 0.5) - ph * 0.5) * 18.0;
      float ring = exp(-rd * rd) * (1.0 - ph) * step(0.6, hash21(cell + 4.0));
      lit += (L + vec3(0.06)) * ring * pud * 0.9;
    }
  }
  if (fogc.a > 0.0 && m.r < 0.5) {
    // Low fog banks drifting over the ground, lit from within by whatever shines into them.
    vec2 q = wp / fogp.x;
    float n = 0.58 * fbm(q + fogp.yz * time * 0.001 / fogp.x) + 0.42 * fbm(q * 1.7 - fogp.yz * time * 0.0007 / fogp.x + 9.1);
    float f = smoothstep(0.34, 0.78, n) * fogc.a;
    vec3 fogCol = fogc.rgb * (amb * 0.75 + L * 1.7 + 0.04);
    lit = mix(lit, fogCol, f * 0.55);
  }
  if (wx.z > 0.5) lit += texture2D(beam, uv).rgb;
  if (wx.y > 0.0) {
    float rs = rainStreak(uv) * wx.y;
    lit += vec3(0.62, 0.74, 0.95) * rs * (0.12 + 0.9 * dot(L, vec3(0.3, 0.59, 0.11)));
  }
  // The highlight shoulder: lit ground rolls off below the bloom threshold; lamp glass and the unlit overlay keep their glare.
  lit = shoulder(lit, unlit, max(b.r, max(b.g, b.b)));
  gl_FragColor = vec4(lit * (1.0 - o.a) + o.rgb, 1.0);
}`;
