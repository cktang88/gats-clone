# Accounts and stats

A player can register or log in from the menu's account box. While signed in, each life credits its kills, death and score to that account, and the box shows the saved stats.

## Sub-features

- `acct-register` creates an account and signs in. The name must already be clean (3 to 16 letters, digits, spaces, `_`, `.` or `-`) and the password 4 to 128 characters. Names are unique ignoring case.
- `acct-guest-carry` brings a guest's profile into the account they register. The join that makes a guest name's profile gets a claim token in `welcome.guest`, which the page keeps in `skirmish.guestClaims`; `Register` sends it as `guest`, the reply says `carried: true`, and the form's line under `Create your account` reads `Your stats and medals come with you.` while a claim is on file. `GET /api/profile/<account>` then shows the guest's kills, medals, lifetime medals, XP and unlocks, and the guest name has no profile. Logging in never carries one over, and a spent, forged or another browser's claim answers 403 with `guest: "invalid"`. `test/guest-carry.test.ts` covers the rules; to see it in the page, play FFA as a guest until `/api/profile/<guest>` counts a kill, reload, register from the enlist plate and open `profile.html?name=<account>`.
- `acct-login` signs in to an existing account and shows an error for a wrong password. While a request is in flight the status reads `Logging in…` or `Creating account…`. A network failure reads `Could not reach server`.
- `acct-token` keeps the session in `localStorage` under `skirmish.token`. The token is HMAC-signed with a secret in `$RUN/data/session-secret` and lasts 30 days, so it survives a server restart. An automatic reconnect rejoins with the same token, so it stays signed in.
- `acct-expired` drops a token the server rejects. `welcome.account` is null, the client clears the token, chat says `Session expired, log in again.`, and the menu shows signed out.
- `acct-stats` shows a grid of `Kills`, `Deaths`, `K/D`, `Score`, `Games` and `Best`, which persist in `$RUN/data/accounts.json`. Before the read it shows `Loading stats…`, then `No games yet.` when the read finds nothing and `Stats unavailable.` when it fails.
- `acct-credit` credits each life when it ends: at death, at a round reset and on leave. `kills` and `score` add that life's totals, `deaths` adds one only for a death, and `best` is the best single-life score. `games` rises by one at each join. A zombies down or bleed-out never credits a death. Saves are batched about 2s apart, and SIGTERM or SIGINT flushes them before exit.
- `acct-name` makes a signed-in player play under the account name. Guests and bots cannot take that name. The menu's `#name` field starts with the account name when no name was stored.
- `acct-logout` clears both `skirmish.token` and `skirmish.account` from localStorage.
- `acct-leaderboard` serves the top 20 accounts by score at `GET /api/leaderboard`. No page shows it. The in-game Tab board ranks only the current match.
- `acct-errors` answers a wrong password or an unknown name with 401 `Wrong name or password`, bad credentials with 400, a taken name on register with 409 `Name taken`, a malformed stats name such as `/api/stats/%E0%A4%A` with 400, and an unknown stats name with 404 `No such player`. Login and register share a per-IP token bucket: a burst of 10, then one more every 6s. Past it they answer 429.
- `acct-privacy` is the menu footer's privacy page. It lists what an account stores (name, scrypt hash and salt, stats), the localStorage keys, and that chat is never saved.

## How to get to it (user POV)

- The `Account` panel on the menu, with `Account name`, `Password`, `Log in` and `Register`.

## Driving it with drive.ts

Preconditions:

- Doctor passes. The run's data dir is fresh, so any name is free.

- **Register.** Run `node drive.ts "$RUN" account`. It fills `#account input` and clicks `Register`. Log lines `UI shows signed-in name`, `token stored in localStorage`, `account exists server-side (GET /api/stats)`. Screenshot `account-signed-in.png`.
- **Wrong password and login.** Not scripted yet. After registering, reload, enter a wrong password, click `Log in`, and assert the `#account .status` text shows the server error. Then log in correctly and assert `Signed in as <name>`.
- **Session survives a restart.** Run `node drive.ts "$RUN" account restart join`. `restart` stops the server with SIGTERM and starts it again on the same port and data dir. Log lines `server restarts on the same port and data dir`, `menu still shows signed in after the restart`, `server accepts the stored session (welcome.account)`. Screenshot `account-after-restart.png`. `restart` reloads the page to the menu, so a `reconnect` after it fails by design. To see a signed-in match survive a restart, run `account join reconnect`, which logs `the rejoin carries the stored session (welcome.account)`.
- **Expired or forged session.** Run `node drive.ts "$RUN" expire`. It stores a forged token, reloads and joins. Log lines `server joins a forged session as a guest (welcome.account null)`, `client drops the stored token`, `chat tells the player the session expired`, `menu shows signed out after an expired session`. Screenshot `session-expired-chat.png`.
- **Stats credit.** Not scripted yet. `games` increments at join, so `node drive.ts "$RUN" account join leave restart join` followed by `GET /api/stats/<name>` showing `games` 2 proves only joins. To prove life credit, record `kills`, `deaths` and `score`, join signed in, earn a kill or die, leave, and assert the matching field rose.
- **Error codes.** Not in drive.ts. `POST` a wrong password or an unknown name as JSON `{name, password}` to `/api/login` and expect 401. Register the same name twice and expect 409. Post `{name:'ab', password:'x'}` and expect 400. `GET /api/stats/%E0%A4%A` expects 400 and `GET /api/stats/nobody123` expects 404. Send 11 quick `/api/login` or `/api/register` attempts from one IP and expect 429.

## Gotchas

- `cleanup.sh` deletes `$RUN/data`, including the session secret, so a relaunch after cleanup rejects old tokens. Use the `restart` step to keep the data dir.
- `restart` changes `$RUN/pid`. Run `cleanup.sh` afterwards as usual; it reads the new pid.
- localStorage is per origin, so a server on a different port starts the page signed out. That is why `restart` reuses the port.
- Every login or register attempt in the same run spends the auth bucket, including the `account` step and the 400, 401 and 409 checks. The 429 can arrive before the 11th attempt of the burst.
- The driver uses a random `Verifier####` name per run, so reruns against the same data dir do not collide.
