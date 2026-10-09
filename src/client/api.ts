import { ARMOR_IDS, COLOR_IDS, MODE_IDS, WEAPON_IDS, type ModeId } from '../shared/defs.ts';
import { parseLoadout, type Loadout } from '../shared/protocol.ts';
import { parseMuted, serializeMuted, type MutedNames } from './chatmute.ts';
import { parsePicks, type Equipped, type Picks, type Slot } from '../shared/cosmetics.ts';
import { parseProfile, type ProfileLite } from './progression.ts';

export type ServerInfo = { id: string; mode: ModeId; players: number; humans: number };
type Stats = { name: string; kills: number; deaths: number; score: number; games: number; best: number };
export type Account = { token: string; name: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

async function getJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, init);
  return res.json();
}

export async function fetchServers(): Promise<ServerInfo[]> {
  const data = await getJson('/api/servers');
  if (!Array.isArray(data)) return [];
  return data.flatMap((s): ServerInfo[] =>
    isObj(s) && (typeof s.id === 'string' || typeof s.id === 'number') && MODE_IDS.includes(s.mode as ModeId)
      ? [{ id: String(s.id), mode: s.mode as ModeId, players: n(s.players), humans: n(s.humans) }]
      : []);
}

export async function openSquad(): Promise<{ room: string } | { error: string }> {
  try {
    const r = await getJson('/api/squads', { method: 'POST' });
    if (isObj(r) && typeof r.room === 'string') return { room: r.room };
    return { error: isObj(r) && typeof r.error === 'string' ? r.error : 'Could not start a squad' };
  } catch {
    return { error: 'Could not reach server' };
  }
}

export async function fetchStats(name: string): Promise<Stats | null> {
  const s = await getJson(`/api/stats/${encodeURIComponent(name)}`);
  if (!isObj(s) || typeof s.name !== 'string') return null;
  return { name: s.name, kills: n(s.kills), deaths: n(s.deaths), score: n(s.score), games: n(s.games), best: n(s.best) };
}

/**
 * Logs in or registers. A registration may carry a guest claim token (from a `welcome`), which brings that guest profile's
 * progress into the new account; the reply says whether it did (`carried`), or `guestInvalid` when the server refused the claim.
 * Logging in never sends one: an existing account never takes a guest's progress.
 */
export async function authenticate(kind: 'login' | 'register', name: string, password: string, guest?: string, email?: string): Promise<(Account & { carried: boolean }) | { error: string; guestInvalid?: boolean }> {
  try {
    const r = await getJson(`/api/${kind}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, password, ...(kind === 'register' && guest && { guest }), ...(kind === 'register' && email && { email }) }),
    });
    if (isObj(r) && typeof r.token === 'string' && typeof r.name === 'string') return { token: r.token, name: r.name, carried: r.carried === true };
    return { error: isObj(r) && typeof r.error === 'string' ? r.error : 'Unexpected server reply', ...(isObj(r) && r.guest === 'invalid' && { guestInvalid: true }) };
  } catch {
    return { error: 'Could not reach server' };
  }
}

/** localStorage throws in some private modes and sandboxed frames; preferences are a convenience, never required. */
const store = {
  get(key: string): string | null {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key: string, value: string | null) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {}
  },
};

export function loadAccount(): Account | null {
  const token = store.get('skirmish.token');
  const name = store.get('skirmish.account');
  return token && name ? { token, name } : null;
}

export function saveAccount(a: Account | null) {
  store.set('skirmish.token', a?.token ?? null);
  store.set('skirmish.account', a?.name ?? null);
}

/**
 * Guest claim tokens this browser holds, oldest first: one for each guest name whose profile it made (the server sends it in
 * `welcome`). Registering sends the one for the name last played under, so that profile comes into the new account.
 */
const GUEST_CLAIMS_KEY = 'skirmish.guestClaims';
const GUEST_CLAIMS_MAX = 8;
/** The lowercased guest name a claim token is for (its first part), or null for something that is not one. */
export function guestClaimName(token: string): string | null {
  const m = /^([A-Za-z0-9_-]{1,200})\.[A-Za-z0-9_-]{43}$/.exec(token);
  if (!m) return null;
  try { return new TextDecoder().decode(Uint8Array.from(atob(m[1]!.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))); } catch { return null; }
}
export function loadGuestClaims(): string[] {
  try {
    const v: unknown = JSON.parse(store.get(GUEST_CLAIMS_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string' && guestClaimName(t) !== null) : [];
  } catch { return []; }
}
const saveGuestClaims = (tokens: string[]) => store.set(GUEST_CLAIMS_KEY, tokens.length ? JSON.stringify(tokens.slice(-GUEST_CLAIMS_MAX)) : null);
/** Keeps a claim token, replacing any older one for the same name. */
export function addGuestClaim(token: string) {
  const name = guestClaimName(token);
  if (name === null) return;
  saveGuestClaims([...loadGuestClaims().filter((t) => guestClaimName(t) !== name), token]);
}
export const dropGuestClaim = (token: string) => saveGuestClaims(loadGuestClaims().filter((t) => t !== token));
/** The claim to send with a registration: the one for `name` (the guest name last played under), else the newest. */
export function pickGuestClaim(name: string, tokens = loadGuestClaims()): string | undefined {
  return tokens.find((t) => guestClaimName(t) === name.trim().toLowerCase()) ?? tokens.at(-1);
}

export const loadName = () => store.get('skirmish.name') ?? '';
export const saveName = (name: string) => store.set('skirmish.name', name);

export function loadLoadout(): Loadout {
  let saved: unknown = null;
  try { saved = JSON.parse(store.get('skirmish.loadout') ?? 'null'); } catch {}
  return parseLoadout(saved) ?? { weapon: WEAPON_IDS[0], armor: ARMOR_IDS[1], color: COLOR_IDS[4] };
}

export const saveLoadout = (l: Loadout) => store.set('skirmish.loadout', JSON.stringify(l));

export const loadMuted = () => parseMuted(store.get('skirmish.mutedNames'));
export const saveMuted = (muted: MutedNames) => store.set('skirmish.mutedNames', serializeMuted(muted));

/** A guest's cosmetic picks, kept in the browser and sent with `join`; the server checks them against the name's unlocks. */
export function loadCosmetics(): Picks {
  try { return parsePicks(JSON.parse(store.get('skirmish.cosmetics') ?? 'null')); } catch { return {}; }
}
export const saveCosmetics = (picks: Picks) => store.set('skirmish.cosmetics', JSON.stringify(picks));

/** The profile endpoint: level, XP, unlocks, what is worn and the challenges. Null when the name has no profile yet. */
export async function fetchProfile(name: string): Promise<ProfileLite | null> {
  try {
    const res = await fetch(`/api/profile/${encodeURIComponent(name)}`);
    return res.ok ? parseProfile(await res.json()) : null;
  } catch { return null; }
}

/** Equips one item for a signed-in account. */
export async function postEquip(token: string, slot: Slot, id: string): Promise<{ equipped: Equipped; unlocked: string[] } | { error: string }> {
  try {
    const res = await fetch('/api/equip', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ slot, id }) });
    const r: unknown = await res.json();
    if (res.ok && isObj(r) && isObj(r.equipped)) return { equipped: r.equipped as Equipped, unlocked: Array.isArray(r.unlocked) ? (r.unlocked as string[]) : [] };
    return { error: isObj(r) && typeof r.error === 'string' ? r.error : 'Could not equip that' };
  } catch { return { error: 'Could not reach server' }; }
}

const errorOf = (r: unknown, fallback: string) => (isObj(r) && typeof r.error === 'string' ? r.error : fallback);
const postJson = async (path: string, body: unknown, token?: string): Promise<{ ok: boolean; body: unknown }> => {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) }, body: JSON.stringify(body) });
  return { ok: res.ok, body: await res.json().catch(() => null) };
};

/** Asks for a reset link for an account by its name and the email on file; both must match. The server answers the same whether or not they did. */
export async function requestReset(name: string, email: string): Promise<{ message: string } | { error: string }> {
  try {
    const r = await postJson('/api/reset/request', { name, email });
    return r.ok && isObj(r.body) && typeof r.body.message === 'string' ? { message: r.body.message } : { error: errorOf(r.body, 'Could not send a reset link') };
  } catch { return { error: 'Could not reach server' }; }
}

/** The signed-in account's own email (only its session token can read it), null for none, or undefined when it can't be read. */
export async function fetchOwnEmail(token: string): Promise<string | null | undefined> {
  try {
    const res = await fetch('/api/account', { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' });
    const r: unknown = await res.json();
    return res.ok && isObj(r) ? (typeof r.email === 'string' ? r.email : null) : undefined;
  } catch { return undefined; }
}

/** Adds, changes or (with '') removes the account's email; the current password is required. */
export async function saveOwnEmail(token: string, email: string, password: string): Promise<{ email: string | null } | { error: string }> {
  try {
    const r = await postJson('/api/account/email', { email, password }, token);
    return r.ok && isObj(r.body) ? { email: typeof r.body.email === 'string' ? r.body.email : null } : { error: errorOf(r.body, 'Could not save the email') };
  } catch { return { error: 'Could not reach server' }; }
}
