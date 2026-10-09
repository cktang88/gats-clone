import { sanitizeAdv, type Adv, type PresetId } from './quality.ts';

/**
 * The player's options, kept in one place so the pause menu (pausemenu.ts) and the code that obeys them agree.
 *
 * The audio sliders and switches already own their keys (`skirmish.volume`, `skirmish.sfx.volume`, `skirmish.music.volume`,
 * `skirmish.muted`, `skirmish.chatter`), so those stay where they are; everything else lives in one JSON value, `skirmish.settings`.
 * Reads never throw (private windows, blocked storage): a failed read gives the defaults and a failed write lasts the tab.
 * No DOM at import, so the pure half is unit-tested in node.
 */

export type EffectsQuality = 'auto' | PresetId;
export type ShakeMode = 'on' | 'reduced' | 'off';
export type MotionMode = 'system' | 'on' | 'off';
export type CrosshairStyle = 'classic' | 'dot' | 'ring' | 'open';
export type CrosshairColor = 'bone' | 'orange' | 'gold' | 'mint';
/** How far the camera leans toward where you aim (shared/lookahead.ts): not at all, the old subtle lean (0.4), or the full reach. */
export type LookAheadMode = 'off' | 'low' | 'normal';

export type Settings = {
  /** The graphics preset (quality.ts): Auto picks from the device and steps down if frames stay slow. */
  quality: EffectsQuality;
  /** Individual graphics knobs the player set over the preset (Advanced). */
  adv: Adv;
  shake: ShakeMode;
  /** `on` forces reduced motion, `off` forces full motion, `system` follows `prefers-reduced-motion`. */
  motion: MotionMode;
  /** 0 is Auto; otherwise a percent of the automatic scale, UI_PERCENT.min..max. */
  uiScale: number;
  damageNumbers: boolean;
  crosshair: CrosshairStyle;
  crosshairColor: CrosshairColor;
  touchAssist: boolean;
  lookAhead: LookAheadMode;
};

export const DEFAULTS: Readonly<Settings> = { quality: 'auto', adv: {}, shake: 'on', motion: 'system', uiScale: 0, damageNumbers: true, crosshair: 'classic', crosshairColor: 'bone', touchAssist: true, lookAhead: 'normal' };

export const UI_PERCENT = { min: 80, max: 150, step: 10 } as const;
export const SETTINGS_KEY = 'skirmish.settings';

export const QUALITY_IDS: readonly EffectsQuality[] = ['auto', 'low', 'medium', 'high', 'ultra'];
export const SHAKE_IDS: readonly ShakeMode[] = ['on', 'reduced', 'off'];
export const MOTION_IDS: readonly MotionMode[] = ['system', 'on', 'off'];
export const CROSSHAIR_IDS: readonly CrosshairStyle[] = ['classic', 'dot', 'ring', 'open'];
export const LOOK_AHEAD_IDS: readonly LookAheadMode[] = ['off', 'low', 'normal'];
/** Reticle paints, all from the art bible's palette: bone, signal orange, gold, heal mint. */
export const CROSSHAIR_COLORS: Readonly<Record<CrosshairColor, string>> = { bone: '#ffffff', orange: '#ff5a1f', gold: '#ffd34d', mint: '#8ff0c4' };

const oneOf = <T extends string>(ids: readonly T[], v: unknown, fallback: T): T => (ids.includes(v as T) ? (v as T) : fallback);

/** Anything stored, made safe: unknown fields drop, bad values fall back to the default one by one. */
export function sanitize(raw: unknown): Settings {
  const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const ui = Number(r.uiScale);
  return {
    // 'off' was the first version's lowest choice; it is Low now.
    quality: oneOf(QUALITY_IDS, r.quality === 'off' ? 'low' : r.quality, DEFAULTS.quality),
    adv: sanitizeAdv(r.adv),
    shake: oneOf(SHAKE_IDS, r.shake, DEFAULTS.shake),
    motion: oneOf(MOTION_IDS, r.motion, DEFAULTS.motion),
    uiScale: r.uiScale !== undefined && Number.isFinite(ui) && ui > 0 ? Math.min(UI_PERCENT.max, Math.max(UI_PERCENT.min, Math.round(ui))) : 0,
    damageNumbers: typeof r.damageNumbers === 'boolean' ? r.damageNumbers : DEFAULTS.damageNumbers,
    crosshair: oneOf(CROSSHAIR_IDS, r.crosshair, DEFAULTS.crosshair),
    crosshairColor: oneOf(Object.keys(CROSSHAIR_COLORS) as CrosshairColor[], r.crosshairColor, DEFAULTS.crosshairColor),
    touchAssist: typeof r.touchAssist === 'boolean' ? r.touchAssist : DEFAULTS.touchAssist,
    lookAhead: oneOf(LOOK_AHEAD_IDS, r.lookAhead, DEFAULTS.lookAhead),
  };
}

export type Store = { get(key: string): string | null; set(key: string, value: string): void };

/** localStorage behind try/catch (it throws in some private modes and sandboxed frames). */
export const browserStore: Store = {
  get: (k) => { try { return typeof localStorage === 'undefined' ? null : localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* the setting lasts this tab only */ } },
};

export function loadSettings(store: Store): Settings {
  const raw = store.get(SETTINGS_KEY);
  if (raw === null) return { ...DEFAULTS };
  try { return sanitize(JSON.parse(raw)); } catch { return { ...DEFAULTS }; }
}

// ---- pure mappings the rest of the client uses ----

/** A 0..100 slider position and a 0..1 gain are the same line, so the stored gains (`skirmish.volume` and friends) need no migration. */
export const gainOfPercent = (pct: number): number => (Number.isFinite(pct) ? Math.min(1, Math.max(0, Math.round(pct) / 100)) : 1);
export const percentOfGain = (gain: number): number => (Number.isFinite(gain) ? Math.round(Math.min(1, Math.max(0, gain)) * 100) : 100);

/** How much of the camera shake and gun recoil kick to keep. */
export const shakeFactor = (mode: ShakeMode): number => (mode === 'off' ? 0 : mode === 'reduced' ? 0.35 : 1);

/** The share of the aim look-ahead's full reach to use. */
/** Low is 0.4 of Normal: about the first, subtler lean, for anyone who preferred it. */
export const lookAheadFactor = (mode: LookAheadMode): number => (mode === 'off' ? 0 : mode === 'low' ? 0.4 : 1);

/** Whether to treat motion as reduced, given the setting and what the system asks for. */
export const motionReduced = (mode: MotionMode, systemPrefers: boolean): boolean => (mode === 'on' ? true : mode === 'off' ? false : systemPrefers);

/** The user's share of the automatic UI scale (Auto is 1). */
export const uiFactor = (uiScale: number): number => (uiScale > 0 ? Math.min(UI_PERCENT.max, Math.max(UI_PERCENT.min, uiScale)) / 100 : 1);

// ---- the live value ----

let current: Settings | null = null;
let store: Store = browserStore;
const listeners = new Set<(s: Settings, changed: keyof Settings | null) => void>();

export function settings(): Settings {
  return (current ??= loadSettings(store));
}

/** Changes one option: it is stored and every listener hears of it at once. */
export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): Settings {
  const next = sanitize({ ...settings(), [key]: value });
  current = next;
  store.set(SETTINGS_KEY, JSON.stringify(next));
  for (const fn of listeners) fn(next, key);
  return next;
}

export function resetSettings(): Settings {
  current = { ...DEFAULTS };
  store.set(SETTINGS_KEY, JSON.stringify(current));
  for (const fn of listeners) fn(current, null);
  return current;
}

export function onSettings(fn: (s: Settings, changed: keyof Settings | null) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Tests swap the store (and drop the cached value) to prove persistence without a browser. */
export function useStore(next: Store | null): void {
  store = next ?? browserStore;
  current = null;
}

// ---- convenience reads the draw code calls every frame ----

export const damageNumbersOn = (): boolean => settings().damageNumbers;
export const touchAssistOn = (): boolean => settings().touchAssist;
export const shakeScale = (): number => shakeFactor(settings().shake);
export const lookAheadScale = (): number => lookAheadFactor(settings().lookAhead);
export const crosshairLook = (): { style: CrosshairStyle; color: string } => ({ style: settings().crosshair, color: CROSSHAIR_COLORS[settings().crosshairColor] });
