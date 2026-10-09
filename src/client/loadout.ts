import { GUNS, LEVELS, PERK_INFO, type AbilityId, type GunId, type PendingPick, type PerkId, type Tier } from '../shared/defs.ts';

/**
 * The loadout strip: what you have picked this life, one slot each, as plain data so hud.ts draws it and the test reads the same
 * answer. A slot exists only once its thing is yours: the evolved gun (a class gun is not a pick), the attachment, the tier-2 perk
 * and the ability. Nothing is drawn for what is still locked; a single progress line says what comes next and how far off it is.
 */
export type SlotKind = 'gun' | 'attachment' | 'perk' | 'ability';
export type LoadoutSlot = {
  kind: SlotKind;
  /** Changes when the slot's contents change (a second evolve), so the strip pops it again. */
  key: string;
  /** The item's full name and a short one that fits under its icon. */
  name: string;
  label: string;
  /** What kind of thing it is, for the hover card ("Attachment", "Gun · evolution 1"). */
  kindLabel: string;
  desc: string;
  gun?: GunId;
  perk?: PerkId;
};

/** Short names for the items whose full name will not fit under a 64 px tile at 14 px. */
const SHORT: Partial<Record<PerkId, string>> = {
  extended: 'Ext. mag', quickReload: 'Q. reload', longRange: 'Range', lightweight: 'Light', piercing: 'AP rounds',
  thickSkin: 'Thick skin', firstAid: 'First aid', steadyHands: 'Steady', secondWind: '2nd wind', demolitions: 'Demo',
  fastHands: 'Fast hands', fragGrenade: 'Frag', gasGrenade: 'Gas', smokeGrenade: 'Smoke', landMine: 'Mine', flashbang: 'Flash',
  ghillie: 'Ghillie', overclock: 'Overclock', adrenaline: 'Adrenaline',
};
export const shortLabel = (id: PerkId): string => SHORT[id] ?? PERK_INFO[id].name;

const perkSlot = (kind: SlotKind, perk: PerkId, kindLabel: string): LoadoutSlot =>
  ({ kind, key: `${kind}:${perk}`, name: PERK_INFO[perk].name, label: shortLabel(perk), kindLabel, desc: PERK_INFO[perk].desc, perk });

/** The slots for a life, in strip order: gun, attachment, perk, ability. Empty until the first pick. */
export function loadoutSlots(gun: GunId, perks: Partial<Record<Tier, PerkId>>, ability: AbilityId | null, abilityKey = 'Space'): LoadoutSlot[] {
  const slots: LoadoutSlot[] = [];
  const def = GUNS[gun];
  if (def.stage > 0) {
    slots.push({ kind: 'gun', key: `gun:${gun}`, name: def.name, label: def.name, kindLabel: `Gun · evolution ${def.stage} of 2${def.stage === 2 ? ' · hunted' : ''}`, desc: def.desc, gun });
  }
  if (perks[1]) slots.push(perkSlot('attachment', perks[1], 'Attachment'));
  if (perks[2]) slots.push(perkSlot('perk', perks[2], 'Perk'));
  const ab = ability ?? (perks[3] as AbilityId | undefined) ?? null;
  if (ab) slots.push(perkSlot('ability', ab, abilityKey ? `Ability · press ${abilityKey}` : 'Ability'));
  return slots;
}

const PICK_NAME = (p: (typeof LEVELS)[number]['pick']): string =>
  p === null ? '' : p.k === 'evolve' ? 'Evolve' : p.tier === 1 ? 'Attachment' : p.tier === 2 ? 'Perk' : 'Ability';
const PENDING_LINE = (p: PendingPick): string =>
  p.k === 'evolve' ? 'Evolve your gun' : p.tier === 1 ? 'Pick an attachment' : p.tier === 2 ? 'Pick a perk' : 'Pick an ability';

/**
 * The one progress line: "Next: Attachment · 120 / 220" with the share of the way there, "Pick a perk" while a pick waits in
 * the dock, or the life's score once the ladder is done. `level` is the server's level (an index into `LEVELS`).
 */
export type Progress = { level: number; text: string; next: string | null; frac: number; pick: boolean };
export function progressLine(level: number, score: number, pending: PendingPick | null): Progress {
  const displayLevel = level + 1;
  const s = Math.max(0, Math.round(score));
  if (pending) return { level: displayLevel, text: PENDING_LINE(pending), next: null, frac: 1, pick: true };
  const at = LEVELS.findIndex((l) => l.score > s);
  if (at < 0) return { level: displayLevel, text: `Score ${s}`, next: null, frac: 1, pick: false };
  const to = LEVELS[at]!, from = LEVELS[at - 1]?.score ?? 0;
  const next = PICK_NAME(to.pick);
  return { level: displayLevel, text: `Next: ${next} · ${s} / ${to.score}`, next, frac: Math.max(0, Math.min(1, (s - from) / (to.score - from))), pick: false };
}

/** Where each slot sits in the strip, left to right from `x`. A gun tile is wider: its art is a side profile. */
export const TILE = { w: 64, gunW: 88, h: 58, gap: 8, compactW: 52, compactGunW: 72, compactH: 46 } as const;
export type SlotBox = { x: number; y: number; w: number; h: number };
export function slotBoxes(slots: readonly LoadoutSlot[], x: number, y: number, compact = false): SlotBox[] {
  const h = compact ? TILE.compactH : TILE.h;
  let at = x;
  return slots.map((s) => {
    const w = s.kind === 'gun' ? (compact ? TILE.compactGunW : TILE.gunW) : compact ? TILE.compactW : TILE.w;
    const b = { x: at, y, w, h };
    at += w + TILE.gap;
    return b;
  });
}
