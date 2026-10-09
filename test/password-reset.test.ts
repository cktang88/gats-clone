import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import WebSocket from 'ws';
import { openAccounts, RESET_MS } from '../src/server/accounts.ts';
import { LIMITS, type Limits } from '../src/server/limits.ts';
import { escapeHtml, mailerFromEnv, resendMailer, resetMessage, smtpMailer, type MailMessage, type Mailer } from '../src/server/mail.ts';
import { RESET_INVALID, RESET_SENT, startServer, type RunningServer } from '../src/server/main.ts';
import { emailError, normalizeEmail } from '../src/shared/email.ts';
import { takeToken } from '../src/client/reset.ts';
import { PISTOL } from './helpers.ts';

/**
 * The optional account email and the password reset it enables: the email is private, a reset needs the account's name and
 * its email to match, every reset request answers the same, and a reset token is single-use, short-lived and stored only as a hash.
 */

type Fake = Mailer & { sent: MailMessage[] };
const fakeMailer = (): Fake => {
  const sent: MailMessage[] = [];
  return { name: 'fake', sent, async send(m) { sent.push(m); } };
};
type Srv = { server: RunningServer; base: string; dataDir: string; restart(): Promise<void> };

async function serve(t: TestContext, opts: { mailer?: Mailer | null; limits?: Partial<Limits>; publicUrl?: string } = {}): Promise<Srv> {
  const dataDir = await mkdtemp(join(tmpdir(), 'tinwar-reset-'));
  const make = () => startServer({ port: 0, dataDir, limits: { authPerMin: 1000, ...opts.limits }, mailer: opts.mailer ?? null, publicUrl: opts.publicUrl ?? 'https://tinwar.test' });
  const s: Srv = { server: await make(), base: '', dataDir, async restart() { await s.server.close(); s.server = await make(); s.base = `http://localhost:${s.server.port}`; } };
  s.base = `http://localhost:${s.server.port}`;
  t.after(async () => { await s.server.close().catch(() => {}); await rm(dataDir, { recursive: true, force: true }); });
  return s;
}
const post = async (s: Srv, path: string, body: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(s.base + path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, text: '' };
};
const accountsFile = async (s: Srv) => readFile(join(s.dataDir, 'accounts.json'), 'utf8');
const tokenOf = (m: MailMessage) => /\/reset\?token=([A-Za-z0-9_-]{43})/.exec(m.text)?.[1] ?? '';

test('the email is optional at sign-up, refused when malformed, and stored normalised', async (t) => {
  const s = await serve(t);
  assert.equal((await post(s, '/api/register', { name: 'NoMail', password: 'pass1' })).status, 200, 'no email is fine');
  assert.equal((await post(s, '/api/register', { name: 'Blank', password: 'pass1', email: '' })).status, 200, 'an empty email is no email');
  for (const email of ['nope', 'a@b', 'a b@x.com', 'x@-bad.com', '<a>@x.com', 'a@x.com\r\nBcc: v@x.com', `${'a'.repeat(250)}@x.com`, 42]) {
    const r = await post(s, '/api/register', { name: 'BadMail', password: 'pass1', email });
    assert.equal(r.status, 400, `refused: ${JSON.stringify(email)}`);
    assert.match(String(r.body.error), /email/i);
  }
  assert.equal((await post(s, '/api/login', { name: 'BadMail', password: 'pass1' })).status, 401, 'a refused email makes no account');
  assert.equal((await post(s, '/api/register', { name: 'Mailer', password: 'pass1', email: '  Ann.Lee+tw@Example.COM ' })).status, 200);
  await s.restart();
  const saved = JSON.parse(await accountsFile(s)) as Record<string, { email?: string }>;
  assert.equal(saved.mailer!.email, 'Ann.Lee+tw@example.com', 'trimmed, domain lowercased, local part kept');
  assert.equal(saved.nomail!.email, undefined);
  assert.equal(saved.blank!.email, undefined);
});

test('the shared email rule: shape only, capped, normalised', () => {
  assert.equal(normalizeEmail(' Bo@Mail.Example.org '), 'Bo@mail.example.org');
  for (const bad of ['', '@x.com', 'a@', 'a@x', 'a..b@x.com', '.a@x.com', 'a@x..com', 'a@x.c0m', 'a@[1.2.3.4]', '"q"@x.com', 'a\n@x.com']) assert.equal(normalizeEmail(bad), null, bad);
  assert.equal(emailError(''), null, 'empty is fine: it is optional');
  assert.match(emailError('nope')!, /email/i);
  assert.match(emailError(`${'a'.repeat(250)}@x.com`)!, /254/);
});

test('the email is never served to anyone else: not in stats, the leaderboard, a profile, a welcome or a snapshot', async (t) => {
  const s = await serve(t);
  const email = 'secret.soldier@hidden.example';
  const reg = await post(s, '/api/register', { name: 'Hider', password: 'pass1', email });
  assert.equal(reg.status, 200);
  assert.ok(!JSON.stringify(reg.body).includes('hidden.example'), 'not even echoed by registration');
  const pages = await Promise.all(['/api/stats/Hider', '/api/leaderboard', '/api/profile/Hider', '/api/servers'].map(async (p) => (await fetch(s.base + p)).text()));
  for (const page of pages) assert.ok(!page.includes('hidden.example'), page.slice(0, 80));
  // A signed-in join: the welcome and the snapshots the room sends.
  const frames: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${s.server.port}/ws?room=ffa`);
    ws.on('error', reject);
    ws.on('message', (d) => { frames.push(String(d)); if (frames.filter((f) => f.includes('"snap"')).length >= 3) ws.close(); });
    ws.on('close', () => resolve());
    ws.once('open', () => ws.send(JSON.stringify({ t: 'join', name: 'Hider', loadout: PISTOL, aspect: 1.5, token: reg.body.token })));
  });
  assert.ok(frames.some((f) => f.includes('"welcome"')) && frames.some((f) => f.includes('"snap"')), 'joined and got snapshots');
  assert.ok(frames.some((f) => f.includes('Hider')), 'the account name is in them');
  for (const f of frames) assert.ok(!f.includes('hidden.example'), 'the email is not');
  // Only its own session reads it back.
  assert.equal((await fetch(`${s.base}/api/account`)).status, 401);
  const own = await fetch(`${s.base}/api/account`, { headers: { authorization: `Bearer ${reg.body.token}` } });
  assert.deepEqual(await own.json(), { name: 'Hider', email });
  assert.equal(own.headers.get('cache-control'), 'no-store');
});

test('a reset request answers the same for a match, a wrong name, a wrong email and an account with no email; only a match is mailed', async (t) => {
  const mailer = fakeMailer();
  const s = await serve(t, { mailer, publicUrl: 'https://tinwar.test/' });
  await post(s, '/api/register', { name: 'Ann', password: 'old-pass', email: 'ann@example.com' });
  await post(s, '/api/register', { name: 'Bo', password: 'bo-pass', email: 'bo@example.com' });
  await post(s, '/api/register', { name: 'Cy', password: 'cy-pass' });
  const cases = [
    { name: 'Nobody', email: 'ann@example.com' },     // no such name
    { name: 'Ann', email: 'bo@example.com' },          // another account's email
    { name: 'Ann', email: 'other@example.com' },       // wrong email
    { name: 'Cy', email: 'cy@example.com' },           // an account with no email
  ];
  const answers = [];
  for (const c of cases) answers.push(await post(s, '/api/reset/request', c));
  const hit = await post(s, '/api/reset/request', { name: 'ann', email: ' ANN@Example.com ' });
  for (const a of answers) assert.deepEqual(a, hit, 'identical status and body');
  assert.deepEqual([hit.status, hit.body.message], [200, RESET_SENT]);
  assert.equal(mailer.sent.length, 1, 'only the match is mailed');
  const m = mailer.sent[0]!;
  assert.equal(m.to, 'ann@example.com');
  assert.match(m.text, /^Someone asked to reset the password of the Tinwar account "Ann"/);
  assert.match(m.text, /https:\/\/tinwar\.test\/reset\?token=[A-Za-z0-9_-]{43}\n/, 'the link uses the public URL, not the Host header');
  assert.ok(m.html.includes(`href="https://tinwar.test/reset?token=${tokenOf(m)}"`));
  // A malformed request is told what is missing, which says nothing about any account.
  assert.equal((await post(s, '/api/reset/request', { name: 'Ann' })).status, 400);
  assert.equal((await post(s, '/api/reset/request', { name: 'Ann', email: 'not-an-email' })).status, 400);
  assert.equal(mailer.sent.length, 1);
});

test('the reply goes out before the mail, so a slow mail provider cannot time a match', async (t) => {
  let calls = 0;
  const s = await serve(t, { mailer: { name: 'stuck', send: () => { calls++; return new Promise<void>(() => {}); } } });
  await post(s, '/api/register', { name: 'Slow', password: 'pass1', email: 'slow@example.com' });
  const r = await Promise.race([post(s, '/api/reset/request', { name: 'Slow', email: 'slow@example.com' }), new Promise<null>((done) => setTimeout(() => done(null), 3000))]);
  assert.ok(r, 'answered while the mail is still in flight');
  assert.deepEqual(r.body.message, RESET_SENT);
  assert.equal(calls, 1);
});

test('a reset link sets a new password once, signs out old sessions, and only its hash is ever stored', async (t) => {
  const mailer = fakeMailer();
  const s = await serve(t, { mailer });
  const reg = await post(s, '/api/register', { name: 'Dee', password: 'old-pass', email: 'dee@example.com' });
  const oldSession = reg.body.token as string;
  await post(s, '/api/reset/request', { name: 'Dee', email: 'dee@example.com' });
  await post(s, '/api/reset/request', { name: 'Dee', email: 'dee@example.com' });
  const [first, second] = mailer.sent.map(tokenOf) as [string, string];
  assert.ok(first && second && first !== second);
  await s.restart();
  const file = await accountsFile(s);
  assert.ok(!file.includes(first) && !file.includes(second), 'no token on disk');
  const saved = (JSON.parse(file) as Record<string, { reset?: { hash: string; expires: number } }>).dee!;
  assert.equal(saved.reset!.hash, createHash('sha256').update(second).digest('hex'), 'the newest token’s SHA-256 is kept, and survives a restart');
  assert.ok(saved.reset!.expires > Date.now() && saved.reset!.expires <= Date.now() + RESET_MS);

  assert.deepEqual(await post(s, '/api/reset/confirm', { token: first, password: 'new-pass' }), { status: 400, body: { error: RESET_INVALID }, text: '' }, 'a newer request killed the older token');
  assert.equal((await post(s, '/api/reset/confirm', { token: second, password: 'abc' })).status, 400, 'the sign-up password rule holds');
  assert.equal((await post(s, '/api/reset/confirm', { token: second, password: 'new-pass' })).status, 200);
  assert.equal((await post(s, '/api/reset/confirm', { token: second, password: 'newer-pass' })).status, 400, 'single use');
  assert.equal((await post(s, '/api/login', { name: 'Dee', password: 'old-pass' })).status, 401, 'the old password is gone');
  const fresh = await post(s, '/api/login', { name: 'Dee', password: 'new-pass' });
  assert.equal(fresh.status, 200, 'the new one logs in at once');
  assert.equal((await fetch(`${s.base}/api/account`, { headers: { authorization: `Bearer ${oldSession}` } })).status, 401, 'a session from before the reset is signed out');
  assert.equal((await fetch(`${s.base}/api/account`, { headers: { authorization: `Bearer ${fresh.body.token}` } })).status, 200, 'a session from after it works');
  assert.ok(!(await accountsFile(s)).includes('"reset"'), 'the used token’s hash is gone');
});

test('a reset token expires after 30 minutes, and a forged one opens nothing', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'tinwar-reset-unit-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const accounts = await openAccounts(dataDir, LIMITS.sessionMs);
  await accounts.register('Eve', 'old-pass', undefined, 'eve@example.com');
  assert.equal(accounts.requestReset('Eve', 'eve@example.com', () => false), null, 'a refused rate limit makes no token');
  const late = accounts.requestReset('Eve', 'eve@example.com', () => true)!;
  const real = Date.now;
  t.mock.method(Date, 'now', () => real() + RESET_MS + 1000);
  assert.equal(await accounts.confirmReset(late.token, 'new-pass'), null, 'expired');
  t.mock.restoreAll();
  const ok = accounts.requestReset('Eve', 'eve@example.com', () => true)!;
  const forged = ok.token.slice(0, -1) + (ok.token.endsWith('A') ? 'B' : 'A');
  for (const bad of [forged, '', 'x'.repeat(43), ok.token + 'x']) assert.equal(await accounts.confirmReset(bad, 'new-pass'), null);
  assert.equal(await accounts.confirmReset(ok.token, 'new-pass'), 'Eve');
  assert.ok(await accounts.login('Eve', 'new-pass'));
  await accounts.flush();
});

test('reset requests are rate-limited per address and per account, and still answer the same', async (t) => {
  const mailer = fakeMailer();
  const s = await serve(t, { mailer, limits: { resetPerIpPerHour: 6, resetPerAccountPerHour: 2 } });
  await post(s, '/api/register', { name: 'Fay', password: 'pass1', email: 'fay@example.com' });
  const statuses = [];
  for (let i = 0; i < 7; i++) statuses.push((await post(s, '/api/reset/request', { name: 'Fay', email: 'fay@example.com' })).status);
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200, 429], 'six an hour from one address');
  assert.equal(mailer.sent.length, 2, 'two emails an hour to one account, though every request got the same answer');
});

test('with no mail provider a reset request answers the same and logs that email is not configured', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const s = await serve(t, { mailer: null });
  await post(s, '/api/register', { name: 'Gus', password: 'pass1', email: 'gus@example.com' });
  const r = await post(s, '/api/reset/request', { name: 'Gus', email: 'gus@example.com' });
  assert.deepEqual([r.status, r.body.message], [200, RESET_SENT]);
  assert.ok(warn.mock.calls.some((c) => /not configured/.test(String(c.arguments[0]))));
  assert.ok(!(await accountsFile(s)).includes('"reset"'), 'no token is made that could never be delivered');
});

test('changing the email needs a session and the current password, and removing it turns reset off', async (t) => {
  const mailer = fakeMailer();
  const s = await serve(t, { mailer });
  const reg = await post(s, '/api/register', { name: 'Hal', password: 'hal-pass' });
  const auth = { authorization: `Bearer ${reg.body.token}` };
  assert.equal((await post(s, '/api/account/email', { email: 'hal@example.com', password: 'hal-pass' })).status, 401, 'no session');
  assert.equal((await post(s, '/api/account/email', { email: 'hal@example.com', password: 'wrong' }, auth)).status, 403, 'wrong password');
  assert.equal((await post(s, '/api/account/email', { email: 'hal@example.com' }, auth)).status, 400, 'no password');
  assert.equal((await post(s, '/api/account/email', { email: 'bad', password: 'hal-pass' }, auth)).status, 400, 'bad email');
  assert.equal(await (await fetch(`${s.base}/api/account`, { headers: auth })).json().then((r) => (r as { email: unknown }).email), null, 'nothing changed');
  assert.deepEqual((await post(s, '/api/account/email', { email: 'Hal@Example.com', password: 'hal-pass' }, auth)).body, { email: 'Hal@example.com' });
  await post(s, '/api/reset/request', { name: 'Hal', email: 'hal@example.com' });
  assert.equal(mailer.sent.length, 1, 'an added email enables reset');
  assert.deepEqual((await post(s, '/api/account/email', { email: '', password: 'hal-pass' }, auth)).body, { email: null });
  assert.equal((await post(s, '/api/reset/confirm', { token: tokenOf(mailer.sent[0]!), password: 'new-pass' })).status, 400, 'changing the email kills a link sent to the old one');
  await post(s, '/api/reset/request', { name: 'Hal', email: 'hal@example.com' });
  assert.equal(mailer.sent.length, 1, 'no email, no reset');
  await s.restart();
  assert.equal((JSON.parse(await accountsFile(s)) as Record<string, { email?: string }>).hal!.email, undefined, 'the removal persisted');
});

test('the account routes refuse a cross-site request', async (t) => {
  const mailer = fakeMailer();
  const s = await serve(t, { mailer });
  await post(s, '/api/register', { name: 'Ivy', password: 'pass1', email: 'ivy@example.com' });
  const body = JSON.stringify({ name: 'Ivy', email: 'ivy@example.com' });
  const forged: Record<string, string>[] = [
    { 'content-type': 'text/plain' },
    { 'content-type': 'application/json', origin: 'https://evil.example' },
    { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
  ];
  for (const headers of forged) {
    for (const path of ['/api/reset/request', '/api/reset/confirm', '/api/account/email']) {
      assert.equal((await fetch(s.base + path, { method: 'POST', body, headers })).status, 403, `${path} ${JSON.stringify(headers)}`);
    }
  }
  assert.equal(mailer.sent.length, 0);
  assert.equal((await post(s, '/api/reset/request', { name: 'Ivy', email: 'ivy@example.com' }, { origin: `http://localhost:${s.server.port}` })).status, 200, 'the site’s own origin is fine');
  assert.equal((await post(s, '/api/reset/request', { name: 'Ivy', email: 'ivy@example.com' }, { origin: 'https://tinwar.test' })).status, 200, 'and so is the public URL');
});

test('the reset page is served without caching or a referrer, and takes the token out of the address', async (t) => {
  const s = await serve(t);
  const res = await fetch(`${s.base}/reset?token=abc`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /id="reset-form"/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  const token = 'A'.repeat(43);
  let replaced = '';
  assert.equal(takeToken({ search: `?token=${token}`, pathname: '/reset' }, (u) => { replaced = u; }), token);
  assert.equal(replaced, '/reset', 'the address bar loses the token');
  assert.equal(takeToken({ search: '?token=short', pathname: '/reset' }, () => {}), null);
});

test('the reset email escapes what it shows', () => {
  const m = resetMessage('a@x.com', 'A<b>"&', 'https://t.test/reset?token=x&y="z"', 30);
  assert.ok(!m.html.includes('<b>') && m.html.includes('A&lt;b&gt;&quot;&amp;'));
  assert.ok(m.html.includes('href="https://t.test/reset?token=x&amp;y=&quot;z&quot;"'));
  assert.equal(escapeHtml(`<'&">`), '&lt;&#39;&amp;&quot;&gt;');
});

test('the mailer comes from the environment, and the dev log never runs in production', () => {
  const warns: string[] = [];
  const w = (l: string) => { warns.push(l); };
  assert.equal(mailerFromEnv({}, w), null);
  assert.equal(mailerFromEnv({ RESEND_API_KEY: 'k', MAIL_FROM: 'Tinwar <no-reply@tinwar.io>' }, w)?.name, 'resend');
  assert.equal(mailerFromEnv({ RESEND_API_KEY: 'k' }, w), null, 'no sender, no mail');
  assert.equal(mailerFromEnv({ SMTP_URL: 'smtps://u:p@mail.test', MAIL_FROM: 'a@b.co' }, w)?.name, 'smtp');
  assert.equal(mailerFromEnv({ SMTP_URL: 'http://x', MAIL_FROM: 'a@b.co' }, w), null);
  assert.equal(mailerFromEnv({ DEV_MAIL_LOG: '1' }, w)?.name, 'log');
  assert.equal(mailerFromEnv({ DEV_MAIL_LOG: '1', NODE_ENV: 'production' }, w), null);
  assert.ok(warns.some((l) => /production/.test(l)));
});

test('the Resend transport posts the message with the key', async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const fetchFn = (async (url: string, init: RequestInit) => { seen = { url, init }; return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
  await resendMailer('re_key', 'Tinwar <no-reply@tinwar.io>', fetchFn).send({ to: 'a@x.com', subject: 'S', text: 'T', html: 'H' });
  assert.equal(seen!.url, 'https://api.resend.com/emails');
  assert.equal((seen!.init.headers as Record<string, string>).authorization, 'Bearer re_key');
  assert.deepEqual(JSON.parse(String(seen!.init.body)), { from: 'Tinwar <no-reply@tinwar.io>', to: ['a@x.com'], subject: 'S', text: 'T', html: 'H' });
  const failing = (async () => new Response('nope', { status: 422 })) as unknown as typeof fetch;
  await assert.rejects(resendMailer('k', 'a@b.co', failing).send({ to: 'a@x.com', subject: 'S', text: 'T', html: 'H' }), /422/);
});

test('the SMTP transport speaks SMTP with Node alone: auth, envelope, a base64 MIME body', async (t) => {
  const lines: string[] = [];
  let data = '';
  const server = createServer((sock) => {
    let buf = '';
    let inData = false;
    sock.write('220 fake ESMTP\r\n');
    sock.on('data', (d) => {
      buf += String(d);
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) { if (line === '.') { inData = false; sock.write('250 queued\r\n'); } else data += `${line}\n`; continue; }
        lines.push(line);
        if (line.startsWith('EHLO')) sock.write('250-fake\r\n250 AUTH PLAIN\r\n');
        else if (line.startsWith('AUTH')) sock.write('235 ok\r\n');
        else if (line === 'DATA') { inData = true; sock.write('354 go\r\n'); }
        else if (line === 'QUIT') sock.end('221 bye\r\n');
        else sock.write('250 ok\r\n');
      }
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const msg = resetMessage('ann@example.com', 'Ann', 'https://tinwar.test/reset?token=abc', 30);
  await smtpMailer(`smtp://user%40x:p%3Ass@127.0.0.1:${port}`, 'Tinwar <no-reply@tinwar.io>').send(msg);
  assert.deepEqual(lines.filter((l) => !l.startsWith('EHLO')), [`AUTH PLAIN ${Buffer.from('\0user@x\0p:ss').toString('base64')}`, 'MAIL FROM:<no-reply@tinwar.io>', 'RCPT TO:<ann@example.com>', 'DATA', 'QUIT']);
  assert.match(data, /^From: Tinwar <no-reply@tinwar.io>\nTo: ann@example.com\nSubject: Reset your Tinwar password\n/);
  const parts = [...data.matchAll(/base64\n\n([A-Za-z0-9+/=\n]+)\n--/g)].map((m) => Buffer.from(m[1]!.replace(/\n/g, ''), 'base64').toString());
  assert.equal(parts[0], msg.text);
  assert.equal(parts[1], msg.html);
});
