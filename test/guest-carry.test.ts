/// <reference types="node" />
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import WebSocket from 'ws';
import { startServer, type RunningServer } from '../src/server/main.ts';
import { openProfiles } from '../src/server/profiles.ts';
import { COSMETIC_BY_ID } from '../src/shared/cosmetics.ts';
import { PISTOL } from './helpers.ts';

/**
 * A guest's progress comes into the account they register, proven by the claim token their own join was handed, once; logging
 * in never takes it; and the move survives a restart and a crash between the two files it touches.
 */

type Welcome = { t: 'welcome'; account: string | null; guest?: string };
type Srv = { server: RunningServer; dataDir: string; base: string; start(): Promise<void>; stop(): Promise<void> };

async function boot(t: { after(fn: () => Promise<void>): void }, limits: Record<string, number> = {}): Promise<Srv> {
  const dataDir = await mkdtemp(join(tmpdir(), 'skirmish-guestcarry-'));
  const s: Srv = {
    server: null as unknown as RunningServer, dataDir, base: '',
    async start() {
      s.server = await startServer({ port: 0, dataDir, limits: { authPerMin: 1000, newProfileGapMs: 0, ...limits } });
      s.base = `http://localhost:${s.server.port}`;
    },
    async stop() { await s.server.close(); },
  };
  await s.start();
  t.after(async () => { await s.server.close().catch(() => {}); await rm(dataDir, { recursive: true, force: true }); });
  return s;
}

/** Joins FFA as a guest (or with an account token), waits for the welcome, and leaves. */
function joinOnce(s: Srv, name: string, token?: string, cosmetics?: Record<string, string>): Promise<Welcome> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${s.server.port}/ws?room=ffa`);
    ws.on('error', reject);
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as { t: string };
      if (msg.t !== 'welcome') return;
      ws.once('close', () => setTimeout(() => resolve(msg as Welcome), 50));
      ws.close();
    });
    ws.once('open', () => ws.send(JSON.stringify({ t: 'join', name, loadout: PISTOL, aspect: 1.5, ...(token && { token }), ...(cosmetics && { cosmetics }) })));
  });
}

const post = async (s: Srv, path: string, body: unknown) => {
  const res = await fetch(s.base + path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const profile = async (s: Srv, name: string) => {
  const res = await fetch(`${s.base}/api/profile/${encodeURIComponent(name)}`);
  return res.ok ? ((await res.json()) as Record<string, unknown>) : null;
};
const readJson = async (s: Srv, file: string) => JSON.parse(await readFile(join(s.dataDir, file), 'utf8')) as Record<string, Record<string, unknown>>;

/** What a guest earns over some play, written straight into the saved guest profile while the server is down (owner kept). */
const PLAYED = {
  kills: 57, deaths: 21, bestStreak: 9, distance: 412_000,
  medals: { longShot: 4, doubleKill: 3 }, weaponKills: { pistol: 30, smg: 27 },
  badges: { 'kills:0': 1_700_000_000_000, 'games:0': 1_700_000_000_001 },
  xp: 6_400, lastWinDay: '2026-10-08',
};
async function play(s: Srv, guest: string) {
  await s.stop();
  const saved = await readJson(s, 'profiles.json');
  const p = saved[guest.toLowerCase()]!;
  assert.ok(typeof p.owner === 'string', 'the guest profile was saved with its owner');
  Object.assign(p, PLAYED);
  await writeFile(join(s.dataDir, 'profiles.json'), JSON.stringify(saved));
  await s.start();
}

test('a guest who registers keeps their stats, medals, badges, bests, XP and equipped look; the guest name is left empty', { timeout: 20_000 }, async (t) => {
  const s = await boot(t);
  const w = await joinOnce(s, 'Rook');
  assert.ok(w.guest, 'the join that made the profile is handed its claim token');
  await play(s, 'Rook');
  // The guest wears something their level unlocked, the way a guest does: picks sent with a join.
  const unlocked = (await profile(s, 'Rook'))!.unlocked as string[];
  const wear = unlocked.map((id) => COSMETIC_BY_ID.get(id)!).find((c) => 'level' in c.unlock && c.unlock.level > 1)!;
  assert.ok(wear, 'the played guest has a level unlock to wear');
  await joinOnce(s, 'Rook', undefined, { [wear.slot]: wear.id });
  const before = (await profile(s, 'Rook'))!;
  assert.equal(before.owner, undefined, 'the owner hash is never served');
  assert.equal(before.kills, 57);
  assert.equal((before.equipped as Record<string, string>)[wear.slot], wear.id, 'the guest wears it');

  const reg = await post(s, '/api/register', { name: 'RookPrime', password: 'secret-1', guest: w.guest });
  assert.equal(reg.status, 200);
  assert.equal(reg.body.carried, true);
  const after = (await profile(s, 'RookPrime'))!;
  for (const k of ['kills', 'deaths', 'bestStreak', 'distance', 'xp', 'level', 'lastWinDay'] as const) assert.deepEqual(after[k], before[k], k);
  assert.deepEqual(after.medals, PLAYED.medals);
  assert.deepEqual(after.weaponKills, PLAYED.weaponKills);
  assert.deepEqual(after.badges, before.badges);
  assert.deepEqual(Object.keys(after.badges as object).sort(), ['games:0', 'kills:0', 'streak:0'], 'lifetime medals, the ones played for and one the last guest join stamped');
  assert.equal(after.games, 2, 'the guest joins counted games, and they came along');
  assert.deepEqual(after.unlocked, before.unlocked, 'cosmetics unlocked as a guest stay unlocked');
  assert.deepEqual(after.equipped, before.equipped, 'and what the guest wore is still worn');
  assert.deepEqual(after.challenges, before.challenges, 'challenge progress comes along');
  assert.deepEqual(after.featured, before.featured, 'the worn lifetime medal comes along');
  assert.equal(after.name, 'RookPrime');
  assert.equal(await profile(s, 'Rook'), null, 'nothing is left under the guest name');
  const stats = (await (await fetch(`${s.base}/api/stats/RookPrime`)).json()) as Record<string, number>;
  assert.deepEqual([stats.kills, stats.deaths, stats.games], [57, 21, 2], 'the account sheet starts from the guest career');

  // The account now owns it: a signed-in join adds to the same profile.
  const token = reg.body.token as string;
  const back = await joinOnce(s, 'whatever', token);
  assert.equal(back.account, 'RookPrime');
  assert.equal(back.guest, undefined, 'an account is never handed a guest claim');
  assert.equal((await profile(s, 'RookPrime'))!.games, 3);
  assert.equal((await post(s, '/api/equip', { token, slot: wear.slot, id: wear.id })).status, 200, 'and can wear what the guest unlocked');
});

test('the same guest progress cannot be claimed by a second registration, in turn or at once', { timeout: 20_000 }, async (t) => {
  const s = await boot(t);
  const a = await joinOnce(s, 'Vole');
  await play(s, 'Vole');
  assert.equal((await post(s, '/api/register', { name: 'VoleOne', password: 'secret-1', guest: a.guest })).body.carried, true);
  const again = await post(s, '/api/register', { name: 'VoleTwo', password: 'secret-2', guest: a.guest });
  assert.equal(again.status, 403);
  assert.equal(again.body.guest, 'invalid');
  assert.equal((await post(s, '/api/login', { name: 'VoleTwo', password: 'secret-2' })).status, 401, 'a refused claim makes no account');
  assert.equal((await profile(s, 'VoleOne'))!.kills, 57, 'the first account keeps it');

  // Someone new takes the guest name: a fresh profile, a fresh token, and the old token still opens nothing.
  const b = await joinOnce(s, 'Vole');
  assert.ok(b.guest && b.guest !== a.guest);
  assert.equal((await profile(s, 'Vole'))!.kills, 0);
  assert.equal((await post(s, '/api/register', { name: 'VoleThree', password: 'secret-3', guest: a.guest })).status, 403);

  // Two registrations racing on one token: exactly one carries it.
  const c = await joinOnce(s, 'Wren');
  await play(s, 'Wren');
  const both = await Promise.all([
    post(s, '/api/register', { name: 'WrenA', password: 'secret-a', guest: c.guest }),
    post(s, '/api/register', { name: 'WrenB', password: 'secret-b', guest: c.guest }),
  ]);
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 403]);
  const winner = both.find((r) => r.status === 200)!.body.name as string;
  const loser = winner === 'WrenA' ? 'WrenB' : 'WrenA';
  assert.equal((await profile(s, winner))!.kills, 57);
  assert.equal(await profile(s, loser), null);
});

test('logging in to an existing account never merges a guest profile, even with a valid claim in the body', { timeout: 20_000 }, async (t) => {
  const s = await boot(t);
  const reg = await post(s, '/api/register', { name: 'Owner', password: 'secret-1' });
  assert.equal(reg.status, 200);
  assert.equal(reg.body.carried, false);
  await joinOnce(s, 'x', reg.body.token as string);
  const w = await joinOnce(s, 'Stray');
  await play(s, 'Stray');
  const ownerBefore = (await profile(s, 'Owner'))!;

  const login = await post(s, '/api/login', { name: 'Owner', password: 'secret-1', guest: w.guest });
  assert.equal(login.status, 200);
  assert.equal(login.body.carried, undefined);
  const ownerAfter = (await profile(s, 'Owner'))!;
  assert.deepEqual([ownerAfter.kills, ownerAfter.games, ownerAfter.medals], [ownerBefore.kills, ownerBefore.games, ownerBefore.medals], 'the account is untouched');
  assert.equal((await profile(s, 'Stray'))!.kills, 57, 'the guest profile is untouched');
  // A signed-in join with the guest token around does not touch it either.
  await joinOnce(s, 'Stray', login.body.token as string);
  assert.equal((await profile(s, 'Stray'))!.kills, 57);

  // The claim was not spent: the guest can still bring it into a new account of their own.
  const fresh = await post(s, '/api/register', { name: 'StrayNew', password: 'secret-2', guest: w.guest });
  assert.equal(fresh.body.carried, true);
  assert.equal((await profile(s, 'StrayNew'))!.kills, 57);
  assert.equal((await profile(s, 'Owner'))!.kills, ownerBefore.kills);
});

test('a forged or guessed claim is refused and makes no account; a name alone proves nothing', { timeout: 20_000 }, async (t) => {
  const s = await boot(t);
  const w = await joinOnce(s, 'Mark');
  await play(s, 'Mark');
  const nameKey = Buffer.from('mark').toString('base64url');
  const forged = [
    `${nameKey}.${'A'.repeat(43)}`,
    `${nameKey}.${w.guest!.split('.')[1]!.replace(/^./, (c) => (c === 'A' ? 'B' : 'A'))}`,
    `${Buffer.from('rook').toString('base64url')}.${w.guest!.split('.')[1]}`,
    'Mark', 'mark', nameKey, '1', 42, { name: 'Mark' }, ['Mark'],
  ];
  for (const [i, guest] of forged.entries()) {
    const r = await post(s, '/api/register', { name: `Thief${i}`, password: 'secret-x', guest });
    assert.equal(r.status, 403, `forged claim ${JSON.stringify(guest)}`);
    assert.equal((await post(s, '/api/login', { name: `Thief${i}`, password: 'secret-x' })).status, 401, 'no account was made');
  }
  // Registering the guest's very name without the token wipes the name (as before), it does not inherit it.
  const squat = await post(s, '/api/register', { name: 'Mark', password: 'secret-y' });
  assert.equal(squat.body.carried, false);
  assert.equal(await profile(s, 'Mark'), null, 'the squatter gets nothing the guest earned');
  assert.equal((await post(s, '/api/register', { name: 'MarkReal', password: 'secret-z', guest: w.guest })).status, 403, 'and the wiped profile is gone for good');
});

test('only the join that makes a guest profile gets its claim; a guest refused a new profile gets none', { timeout: 20_000 }, async (t) => {
  const s = await boot(t, { newProfilesPerDay: 1 });
  const first = await joinOnce(s, 'Pip');
  assert.ok(first.guest);
  const sharer = await joinOnce(s, 'Pip');
  assert.equal(sharer.guest, undefined, 'a second guest under the same name shares the profile but cannot claim it');
  const refused = await joinOnce(s, 'Pop');
  assert.equal(refused.guest, undefined, 'past the new-profile limit there is no profile and no claim');
  assert.equal(await profile(s, 'Pop'), null);
  // Carrying Pip over does not refund the address's new-profile allowance.
  assert.equal((await post(s, '/api/register', { name: 'PipAcct', password: 'secret-1', guest: first.guest })).body.carried, true);
  assert.equal((await joinOnce(s, 'Pup')).guest, undefined, 'still limited after the claim');
  assert.equal(await profile(s, 'Pup'), null);
});

test('the carried profile survives a restart, and the spent claim stays spent', { timeout: 20_000 }, async (t) => {
  const s = await boot(t);
  const w = await joinOnce(s, 'Kite');
  await play(s, 'Kite');
  const reg = await post(s, '/api/register', { name: 'KiteAce', password: 'secret-1', guest: w.guest });
  assert.equal(reg.body.carried, true);
  await s.stop();
  const accounts = await readJson(s, 'accounts.json');
  assert.equal((accounts.kiteace!.claim as { from: string }).from, 'kite', 'the account records which guest profile it took');
  const files = await readJson(s, 'profiles.json');
  assert.equal(files.kite, undefined);
  assert.equal(files.kiteace!.owner, undefined, 'the carried profile no longer has a guest owner');
  await s.start();
  const p = (await profile(s, 'KiteAce'))!;
  assert.deepEqual([p.kills, p.deaths, p.medals], [57, 21, PLAYED.medals]);
  assert.equal((p.badges as Record<string, number>)['kills:0'], PLAYED.badges['kills:0']);
  assert.equal(await profile(s, 'Kite'), null);
  assert.equal((await post(s, '/api/register', { name: 'KiteTwo', password: 'secret-2', guest: w.guest })).status, 403);
  assert.equal((await post(s, '/api/login', { name: 'KiteAce', password: 'secret-1' })).status, 200);
});

test('a crash between saving the account and saving the profiles is finished on the next start, once', { timeout: 20_000 }, async (t) => {
  const s = await boot(t);
  const w = await joinOnce(s, 'Moth');
  await play(s, 'Moth');
  await s.stop();
  const beforeClaim = join(s.dataDir, 'profiles.before.json');
  await copyFile(join(s.dataDir, 'profiles.json'), beforeClaim);
  await s.start();
  assert.equal((await post(s, '/api/register', { name: 'MothKing', password: 'secret-1', guest: w.guest })).body.carried, true);
  await s.stop();
  // As if the process died after accounts.json was written but before profiles.json was.
  await copyFile(beforeClaim, join(s.dataDir, 'profiles.json'));
  assert.ok((await readJson(s, 'profiles.json')).moth, 'the guest profile is back on disk, unmoved');
  await s.start();
  assert.equal((await profile(s, 'MothKing'))!.kills, 57, 'the move is finished at startup');
  assert.equal(await profile(s, 'Moth'), null, 'and not duplicated');
  assert.equal((await post(s, '/api/register', { name: 'MothTwo', password: 'secret-2', guest: w.guest })).status, 403);
  // A second restart changes nothing.
  await s.stop();
  await s.start();
  assert.equal((await profile(s, 'MothKing'))!.kills, 57);
  assert.equal(await profile(s, 'Moth'), null);

  // A crash before accounts.json is written leaves the guest as they were: no account, the claim still good.
  const v = await joinOnce(s, 'Gnat');
  await play(s, 'Gnat');
  await s.stop();
  assert.equal((await readJson(s, 'accounts.json')).gnatking, undefined);
  await s.start();
  assert.equal((await profile(s, 'Gnat'))!.kills, 57);
  assert.equal((await post(s, '/api/register', { name: 'GnatKing', password: 'secret-3', guest: v.guest })).body.carried, true);
});

test('reconcile leaves a later guest under the old name alone and wipes guest leftovers under an account name', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skirmish-reconcile-'));
  const profiles = await openProfiles(dir);
  const token = profiles.adoptGuest('Bee')!;
  const held = profiles.reserveClaim(token)!;
  assert.equal(profiles.reserveClaim(token), null, 'a held claim cannot be held twice');
  profiles.releaseClaim(held);
  const again = profiles.reserveClaim(token)!;
  assert.equal(await profiles.commitClaim(again, 'BeeAcct'), true);
  // A new guest takes the name; a replay of the recorded claim must not move them.
  profiles.adoptGuest('Bee');
  profiles.record('Bee', { kills: 3 });
  profiles.adoptGuest('Squat');
  await profiles.reconcile([{ name: 'BeeAcct', claim: again }, { name: 'Squat' }]);
  assert.equal(profiles.get('Bee')?.kills, 3);
  assert.equal(profiles.get('BeeAcct')?.owner, undefined);
  assert.equal(profiles.get('Squat'), null, 'a guest-owned profile under an account name is wiped');
  await profiles.flush();
  await rm(dir, { recursive: true, force: true });
});
