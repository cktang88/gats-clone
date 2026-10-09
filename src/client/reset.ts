/**
 * The password-reset page (`/reset?token=…`, linked from the reset email). The token is read from the address once, then
 * taken out of it (and so out of history, a bookmark or a shared screenshot) and kept only in memory, to go in the POST body.
 */
// Its own tiny fetch, not api.ts: that would bundle the game's definitions into this one-form page.
async function confirmReset(token: string, password: string): Promise<{ name: string } | { error: string }> {
  try {
    const res = await fetch('/api/reset/confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, password }) });
    const r = (await res.json().catch(() => null)) as { name?: unknown; error?: unknown } | null;
    if (res.ok && typeof r?.name === 'string') return { name: r.name };
    return { error: typeof r?.error === 'string' ? r.error : 'Could not reset the password' };
  } catch { return { error: 'Could not reach server' }; }
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function takeToken(loc: Pick<Location, 'search' | 'pathname'>, replace: (url: string) => void): string | null {
  const token = new URLSearchParams(loc.search).get('token');
  if (loc.search) replace(loc.pathname);
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

if (typeof document !== 'undefined') {
  const token = takeToken(location, (url) => history.replaceState(null, '', url));
  const form = $<HTMLFormElement>('reset-form');
  const pass = $<HTMLInputElement>('reset-pass');
  const pass2 = $<HTMLInputElement>('reset-pass2');
  const submit = $<HTMLButtonElement>('reset-submit');
  const status = $('reset-status');
  if (!token) status.textContent = 'This reset link is incomplete. Open the link from the email again, or ask for a new one from the game’s log-in form.';
  else { form.hidden = false; pass.focus(); }
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (!token) return;
    if (pass.value.length < 4 || pass.value.length > 128) { status.textContent = 'Passwords need 4 to 128 characters.'; pass.focus(); return; }
    if (pass.value !== pass2.value) { status.textContent = 'The two passwords don’t match.'; pass2.focus(); return; }
    submit.disabled = true;
    status.textContent = 'Saving…';
    const r = await confirmReset(token, pass.value);
    if ('error' in r) { submit.disabled = false; status.textContent = r.error; return; }
    form.hidden = true;
    pass.value = pass2.value = '';
    status.textContent = `Password changed for ${r.name}. Log in with the new one.`;
    $('reset-done').hidden = false;
  };
}
