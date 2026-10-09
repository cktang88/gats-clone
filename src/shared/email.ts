/**
 * The optional account email: only ever used to send that account a password-reset link. The client and the server share this
 * rule, so a sign-up form refuses what the server would refuse and says why. It checks the shape only (no verification mail).
 */
export const EMAIL_MAX = 254;

const LOCAL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}$/;
const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/**
 * The address in its stored form (trimmed, domain lowercased), or null when it is not a plain `local@domain.tld` address
 * under `EMAIL_MAX` characters. Quoted local parts, IP-literal domains, spaces and control characters are refused, which also
 * keeps the address safe to put in a mail header.
 */
export function normalizeEmail(raw: string): string | null {
  const email = raw.trim();
  if (email.length > EMAIL_MAX) return null;
  const at = email.lastIndexOf('@');
  if (at < 1) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1).toLowerCase();
  if (!LOCAL.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return null;
  const labels = domain.split('.');
  if (labels.length < 2 || domain.length > 253 || !labels.every((l) => LABEL.test(l)) || !/^[a-z]{2,63}$|^xn--[a-z0-9-]{1,59}$/.test(labels.at(-1)!)) return null;
  return `${local}@${domain}`;
}

/** Two stored addresses name the same mailbox for a reset when they match ignoring case. */
export const sameEmail = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The sign-up form's error for the email field, or null when it is empty (it is optional) or well formed. */
export function emailError(raw: string): string | null {
  if (!raw.trim()) return null;
  if (raw.trim().length > EMAIL_MAX) return `Emails are at most ${EMAIL_MAX} characters.`;
  return normalizeEmail(raw) ? null : 'That doesn’t look like an email address.';
}
