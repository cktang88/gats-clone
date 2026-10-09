/**
 * Damage over time (a gas cloud, a burning oil slick, the Last Squad ring) lands in pulses, not every step: each source keeps its own
 * clock and every `DOT_MS` hurts whoever is in it at that moment by `DOT_MS` worth of its damage a second. So a body takes one hit, one
 * number and one hit sound per pulse, at the same damage a second as before.
 *
 * A source's first pulse comes `DOT_MS` after it starts (`from`), never the moment it forms: a cloud bursting on you gives you half a second
 * to step out, and a body that walks in takes the source's next pulse, within `DOT_MS`. Stepping out between pulses takes nothing more, and
 * stepping in and out never earns an extra hit. The clock runs on the world's time only, so a replay is exact.
 */
export const DOT_MS = 500;

/** The share of a second's damage one pulse deals. */
export const DOT_SHARE = DOT_MS / 1000;

/** Slack for the float sum `w.now` is: a pulse due at exactly `until` (a cloud's last) still lands. */
const EPS = 1e-6;

/**
 * How many pulses of a clock started at `from` fall in the step that ended at `now` (the span `(now - dtMs, min(now, until)]`): 0 most steps,
 * 1 on a pulse. Pulses fall at `from + DOT_MS`, `from + 2 * DOT_MS`, ..., and one at `until` (a source's end) still counts.
 */
export function dotPulses(from: number, now: number, dtMs: number, until = Infinity): number {
  const start = now - dtMs, end = Math.min(now, until);
  if (end <= start) return 0;
  const count = (t: number) => Math.max(0, Math.floor((t - from) / DOT_MS + EPS));
  return count(end) - count(start);
}
