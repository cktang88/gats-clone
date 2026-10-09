import { randomBytes } from 'node:crypto';
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

/**
 * Outgoing mail, used for one thing only: password-reset links. A transport is picked from the environment
 * (`mailerFromEnv`): Resend's HTTPS API (`RESEND_API_KEY`, `MAIL_FROM`), or any SMTP server (`SMTP_URL`, `MAIL_FROM`), with no
 * dependency beyond Node. Tests and the verify harness pass their own `Mailer`. With none, a reset request still answers the
 * same, and the server logs that email is not configured.
 */
export type MailMessage = { to: string; subject: string; text: string; html: string };
export type Mailer = { name: string; send(msg: MailMessage): Promise<void> };

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&${({ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": '#39' } as Record<string, string>)[c]};`);

/** The reset email for one account. Every value in the HTML is escaped (the name is the player's own, the link carries the token). */
export function resetMessage(to: string, name: string, url: string, minutes: number): MailMessage {
  const intro = `Someone asked to reset the password of the Tinwar account "${name}".`;
  const outro = `The link works once, for ${minutes} minutes. If you didn't ask for this, ignore this email: your password stays as it is.`;
  const text = [intro, '', `Set a new password: ${url}`, '', outro].join('\n');
  const html = `<!doctype html><html><body style="font-family:sans-serif;line-height:1.4">`
    + `<p>${escapeHtml(intro)}</p><p><a href="${escapeHtml(url)}">Set a new password</a></p>`
    + `<p style="color:#666;font-size:13px">${escapeHtml(url)}</p><p>${escapeHtml(outro)}</p></body></html>`;
  return { to, subject: 'Reset your Tinwar password', text, html };
}

/** Resend (resend.com), one HTTPS call per message. */
export function resendMailer(apiKey: string, from: string, fetchFn: typeof fetch = fetch): Mailer {
  return {
    name: 'resend',
    async send(msg) {
      const res = await fetchFn('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`resend answered ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    },
  };
}

type Reply = { code: number; text: string };
/** Reads SMTP replies (a multi-line reply ends at the line with a space after its code) from one socket. */
function replies(socket: Socket) {
  let buf = '';
  const lines: string[] = [];
  const waiting: { resolve: (r: Reply) => void; reject: (e: Error) => void }[] = [];
  let failed: Error | null = null;
  const pump = () => {
    while (waiting.length) {
      const end = lines.findIndex((l) => /^\d{3}(?: |$)/.test(l));
      if (end < 0) return;
      const got = lines.splice(0, end + 1);
      waiting.shift()!.resolve({ code: Number(got.at(-1)!.slice(0, 3)), text: got.map((l) => l.slice(4)).join('\n') });
    }
  };
  const onData = (d: Buffer) => {
    buf += d.toString('utf8');
    let i: number;
    while ((i = buf.indexOf('\r\n')) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 2); }
    pump();
  };
  const fail = (e: Error) => { failed = e; for (const w of waiting.splice(0)) w.reject(e); };
  const onClose = () => fail(new Error('smtp connection closed'));
  socket.on('data', onData);
  socket.on('error', fail);
  socket.on('close', onClose);
  return {
    next: () => new Promise<Reply>((resolve, reject) => { if (failed) reject(failed); else { waiting.push({ resolve, reject }); pump(); } }),
    detach() { socket.off('data', onData); socket.off('error', fail); socket.off('close', onClose); },
  };
}

const b64lines = (s: string) => Buffer.from(s, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
const envelopeAddress = (from: string) => /<([^<>\s]+)>\s*$/.exec(from)?.[1] ?? from.trim();

/** The RFC 5322 message, both parts base64 so no line is long and none starts with a dot. */
export function mimeMessage(from: string, msg: MailMessage, now = new Date()): string {
  const boundary = `tinwar-${randomBytes(12).toString('hex')}`;
  const domain = envelopeAddress(from).split('@')[1] ?? 'localhost';
  return [
    `From: ${from}`, `To: ${msg.to}`, `Subject: ${msg.subject}`, `Date: ${now.toUTCString()}`,
    `Message-ID: <${randomBytes(16).toString('hex')}@${domain}>`, 'MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64lines(msg.text),
    `--${boundary}`, 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64lines(msg.html),
    `--${boundary}--`, '',
  ].join('\r\n');
}

/**
 * Any SMTP server: `smtps://user:pass@host:465` (TLS from the start) or `smtp://user:pass@host:587` (STARTTLS, which is required,
 * except to a server on this machine). Logs in with AUTH PLAIN when the URL carries a user.
 */
export function smtpMailer(url: string, from: string): Mailer {
  const u = new URL(url);
  if (u.protocol !== 'smtp:' && u.protocol !== 'smtps:') throw new Error('SMTP_URL must start with smtp:// or smtps://');
  const implicit = u.protocol === 'smtps:';
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const port = Number(u.port || (implicit ? 465 : 587));
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  const user = decodeURIComponent(u.username);
  const pass = decodeURIComponent(u.password);
  return {
    name: 'smtp',
    async send(msg) {
      let socket: Socket = implicit ? tlsConnect({ host, port, servername: host }) : netConnect({ host, port });
      socket.setTimeout(20_000, () => socket.destroy(new Error('smtp timed out')));
      let r = replies(socket);
      const expect = async (want: number, what: string) => {
        const got = await r.next();
        if (got.code !== want) throw new Error(`smtp ${what}: ${got.code} ${got.text.slice(0, 200)}`);
        return got;
      };
      const say = (line: string, want: number, what = line.split(' ')[0]!) => { socket.write(`${line}\r\n`); return expect(want, what); };
      try {
        await expect(220, 'greeting');
        let ehlo = await say('EHLO tinwar', 250);
        if (!implicit) {
          if (/^STARTTLS$/im.test(ehlo.text)) {
            await say('STARTTLS', 220);
            r.detach();
            socket = tlsConnect({ socket, servername: host });
            socket.setTimeout(20_000, () => socket.destroy(new Error('smtp timed out')));
            r = replies(socket);
            ehlo = await say('EHLO tinwar', 250);
          } else if (!local) throw new Error('smtp server offers no STARTTLS; refusing to send in the clear');
        }
        if (user) await say(`AUTH PLAIN ${Buffer.from(`\0${user}\0${pass}`).toString('base64')}`, 235, 'AUTH');
        await say(`MAIL FROM:<${envelopeAddress(from)}>`, 250);
        await say(`RCPT TO:<${msg.to}>`, 250);
        await say('DATA', 354);
        await say(`${mimeMessage(from, msg)}\r\n.`, 250, 'message');
        // The message is accepted at this point; a server that hangs up without answering QUIT changes nothing.
        await say('QUIT', 221).catch(() => {});
      } finally {
        r.detach();
        socket.end();
        socket.destroy();
      }
    },
  };
}

/** For local testing only: logs the message (and so the link) instead of sending it. */
export const logMailer = (log: (line: string) => void = console.log): Mailer => ({
  name: 'log',
  async send(msg) { log(`DEV_MAIL_LOG: mail to ${msg.to}: ${msg.subject}\n${msg.text}`); },
});

/**
 * The mailer the environment asks for, or null for none. `DEV_MAIL_LOG=1` logs links rather than sending them, and is ignored
 * when `NODE_ENV=production`, so a reset token never reaches a production log.
 */
export function mailerFromEnv(env: NodeJS.ProcessEnv, warn: (line: string) => void = console.warn): Mailer | null {
  const from = env.MAIL_FROM?.trim();
  if (env.RESEND_API_KEY) {
    if (from) return resendMailer(env.RESEND_API_KEY, from);
    warn('RESEND_API_KEY is set but MAIL_FROM is not: password-reset email is off');
  }
  if (env.SMTP_URL) {
    if (from) {
      try { return smtpMailer(env.SMTP_URL, from); } catch (err) { warn(`SMTP_URL is unusable (${(err as Error).message}): password-reset email is off`); }
    } else warn('SMTP_URL is set but MAIL_FROM is not: password-reset email is off');
  }
  if (env.DEV_MAIL_LOG === '1') {
    if (env.NODE_ENV === 'production') warn('DEV_MAIL_LOG is ignored in production');
    else return logMailer();
  }
  return null;
}
