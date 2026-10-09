import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

type Stats = { kills: number; deaths: number; score: number; games: number; best: number };
type StatsRow = Stats & { name: string };
/**
 * The guest profile a registration carried over (see `GuestClaim` in profiles.ts), written in the same atomic save that makes
 * the account, so `Profiles.reconcile` can finish a move a crash cut short and can tell a finished one (the profile no longer has
 * that owner) from an unfinished one.
 */
type Claim = { from: string; owner: string; at: number };
type Account = { name: string; salt: string; hash: string; stats: Stats; claim?: Claim };
type Session = { token: string; name: string };
/** A guest profile held for a registration, with the career numbers that seed the new account's stats. */
export type HeldClaim = { from: string; owner: string; kills: number; deaths: number; games: number };

export type Accounts = {
  /**
   * Makes an account. `claim`, when given, runs once the name is known to be free, in the same synchronous step that takes it,
   * and must hold the guest profile being carried over (or return null, which refuses the registration with 'unclaimable').
   */
  register(name: string, password: string): Promise<Session | null>;
  register(name: string, password: string, claim: () => HeldClaim | null): Promise<Session | null | 'unclaimable'>;
  /** Every account's name and the guest claim it was registered with, for `Profiles.reconcile`. */
  claims(): { name: string; claim?: { from: string; owner: string } }[];
  login(name: string, password: string): Promise<Session | null>;
  nameForToken(token: string): string | null;
  stats(name: string): StatsRow | null;
  leaderboard(limit: number): StatsRow[];
  credit(name: string, delta: { kills: number; deaths: number; score: number; games: number }): void;
  flush(): Promise<void>;
};

const key = (name: string) => name.toLowerCase();

async function writeFileAtomic(file: string, data: string) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}
const SAVE_DELAY_MS = 2000;
const UNKNOWN_ACCOUNT_SALT = randomBytes(16);

async function loadSecret(file: string): Promise<Buffer> {
  try {
    return await readFile(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  try {
    await writeFile(file, randomBytes(32), { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  return readFile(file);
}

export async function openAccounts(dataDir: string, sessionMs: number): Promise<Accounts> {
  await mkdir(dataDir, { recursive: true });
  const secret = await loadSecret(join(dataDir, 'session-secret'));
  const mac = (payload: string) => createHmac('sha256', secret).update(payload).digest();
  const file = join(dataDir, 'accounts.json');
  const byKey = new Map<string, Account>();
  try {
    const saved = JSON.parse(await readFile(file, 'utf8')) as Record<string, Account>;
    for (const account of Object.values(saved)) byKey.set(key(account.name), account);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  let saveQueue = Promise.resolve();
  const save = () => {
    saveQueue = saveQueue
      .then(() => writeFileAtomic(file, JSON.stringify(Object.fromEntries(byKey))))
      .catch((err: unknown) => console.error('accounts save failed', err));
    return saveQueue;
  };
  let pending: ReturnType<typeof setTimeout> | null = null;
  const saveSoon = () => {
    pending ??= setTimeout(() => { pending = null; void save(); }, SAVE_DELAY_MS);
  };

  /** Join messages truncate tokens to 128 characters. Base-36 seconds and a base64url MAC keep the longest name at 124. */
  const issue = (account: Account): Session => {
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAt = Math.floor((Date.now() + sessionMs) / 1000);
    const payload = [Buffer.from(key(account.name)).toString('base64url'), issuedAt.toString(36), expiresAt.toString(36)].join('.');
    return { token: `${payload}.${mac(payload).toString('base64url')}`, name: account.name };
  };
  const row = (a: Account): StatsRow => ({ name: a.name, ...a.stats });

  async function register(name: string, password: string, claim?: () => HeldClaim | null): Promise<Session | null | 'unclaimable'> {
    if (byKey.has(key(name))) return null;
    const salt = randomBytes(16);
    const hash = await scryptAsync(password, salt, 64);
    if (byKey.has(key(name))) return null;
    const held = claim ? claim() : null;
    if (claim && !held) return 'unclaimable';
    const account: Account = {
      name, salt: salt.toString('hex'), hash: hash.toString('hex'),
      stats: { kills: held?.kills ?? 0, deaths: held?.deaths ?? 0, score: 0, games: held?.games ?? 0, best: 0 },
      ...(held && { claim: { from: held.from, owner: held.owner, at: Date.now() } }),
    };
    byKey.set(key(name), account);
    await save();
    return issue(account);
  }

  return {
    register: register as Accounts['register'],
    async login(name, password) {
      const account = byKey.get(key(name));
      const hash = await scryptAsync(password, account ? Buffer.from(account.salt, 'hex') : UNKNOWN_ACCOUNT_SALT, 64);
      return account && timingSafeEqual(hash, Buffer.from(account.hash, 'hex')) ? issue(account) : null;
    },
    nameForToken(token) {
      const parts = token.split('.');
      if (parts.length !== 4) return null;
      const [name, , expiresAt, signature] = parts as [string, string, string, string];
      const given = Buffer.from(signature, 'base64url');
      const expected = mac(parts.slice(0, 3).join('.'));
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
      if (parseInt(expiresAt, 36) * 1000 <= Date.now()) return null;
      return byKey.get(Buffer.from(name, 'base64url').toString())?.name ?? null;
    },
    claims() {
      return [...byKey.values()].map((a) => ({ name: a.name, ...(typeof a.claim?.from === 'string' && typeof a.claim.owner === 'string' && { claim: { from: a.claim.from, owner: a.claim.owner } }) }));
    },
    stats(name) {
      const a = byKey.get(key(name));
      return a ? row(a) : null;
    },
    leaderboard(limit) {
      return [...byKey.values()].map(row).sort((a, b) => b.score - a.score).slice(0, limit);
    },
    credit(name, delta) {
      const a = byKey.get(key(name));
      if (!a) return;
      a.stats.kills += delta.kills;
      a.stats.deaths += delta.deaths;
      a.stats.score += delta.score;
      a.stats.games += delta.games;
      a.stats.best = Math.max(a.stats.best, delta.score);
      saveSoon();
    },
    flush() {
      if (pending) { clearTimeout(pending); pending = null; void save(); }
      return saveQueue;
    },
  };
}
