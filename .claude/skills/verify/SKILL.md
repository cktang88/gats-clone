---
name: verify
description: Drive the Tinwar browser game (top-down multiplayer shooter, Node server + Canvas client) against a real, isolated server to prove gameplay and UI behavior. Use after any change to src/client, src/server, src/shared, or public/, before declaring a gameplay or UI change done, or when asked to run, check, or screenshot the game.
---

# Verify Tinwar

Tinwar is a browser game. The user touches the web page served by `src/server/main.ts`: the menu (loadout, rooms, account) and the canvas game (HUD, chat, death screen). The server also exposes `/api/*` JSON routes and a WebSocket at `/ws?room=<ffa|tdm|dom|br>`, or `?room=<code>` for a zombies squad opened with `POST /api/squads`. Bots fill every room, so a single driver always has opponents.

All helpers live in `.claude/skills/verify/scripts/` and take one argument, a run directory you choose. Put it in your session scratchpad, for example `RUN=<scratchpad>/verify-$(date +%s)`. Every instance gets its own port and data dir, so parallel runs never share state. Never drive a server this run did not start, and never touch the user's `data/` directory.

## Launch

```bash
.claude/skills/verify/scripts/launch.sh "$RUN"
```

It runs `npm install` if `node_modules` is missing, rebuilds `public/game.js` with `npm run build`, picks a free port, and starts `node src/server/main.ts` with `PORT` and `DATA_DIR=$RUN/data`. Ready means it printed `ready: http://localhost:<port>`, which follows the server's `Tinwar listening on` log line. The server log is `$RUN/server.log`. Rerunning launch on a live run is a no-op.

## Doctor

```bash
.claude/skills/verify/scripts/doctor.sh "$RUN"
```

Read-only. It checks the pid is alive, the port is owned by that pid, all four rooms answer `/api/servers`, `game.js` is served, and the bundle is newer than every `src/**/*.ts`. A stale bundle means the browser runs old code. Relaunch instead of driving it. Run doctor first whenever a result looks wrong.

## Drive

```bash
node .claude/skills/verify/scripts/drive.ts "$RUN" [step ...]
```

Steps run in order: `menu account join move fire latency chat leave`. No steps means those eight. `touch`, `mute`, `loadout`, `restart`, `reconnect` and `expire` run only when named. `loadout` must come before `join`. It presses the shotgun tile (index 2 of `#loadout-menu .weapon`, in `WEAPON_IDS` order) with a real mouse press, checks that only that tile has `aria-pressed="true"` in both `#loadout-menu` and `#loadout-death`, and checks `skirmish.loadout` in localStorage names `shotgun`. A later `join` then logs `joined player carries the picked weapon (server snapshot)`. `mute` has the observer chat, clicks its name in the chat log, and checks that its earlier and later lines are hidden while its frames still reach the page socket, that the mute and the menu's muted list survive a reload, and that clicking the muted marker shows the observer again. `restart` stops the server and starts it again on the same port and data dir, so a later `join` proves the stored session survived. `reconnect` does the same restart mid-match: it checks the page shows the `#reconnect` overlay while the server is down, then that a new `welcome` arrives on the page socket and the HUD returns within 15s without any click. It skips when the run directory has a `url` file, since it would need the server process. `reconnect` needs the page in a match, so put it after `join` with no `leave` or `restart` between: `restart` reloads the page to the menu, and `restart reconnect` or `leave … reconnect` fail by design. Use `account join reconnect` for a signed-in reconnect and `account join leave restart` for the menu after a restart. `move`, `fire`, `latency`, `chat` and `mute` need `join` earlier in the same invocation. `touch` emulates a phone with a coarse pointer: held upright (390x844) it checks the `.rotate-hint` asks to turn sideways, then on its side (844x390) it checks the hint is gone, drags the left stick to walk and pushes the right one to fire. `fire` also taps the mouse six times just past the weapon's fire cooldown and checks the server's ammo drops by exactly six. `latency` checks the median time from a real keydown to the first frame that draws the player moving stays at or under 50ms at any lag, and logs the largest misprediction the client smoothed meanwhile. Both are read from the page's `?dev` hook `skirmishDev.drawnSelf()`. The same hook's `skirmishDev.drawnOthers()` lists where the page draws every other player, in world and screen coordinates; `scripts/measure-lag-aim.ts` aims with it. `skirmishDev.liveNumbers()` lists the damage numbers on screen with their victim and drawn height. `skirmishDev.panels()` lists where the fading HUD panels were last drawn, `skirmishDev.tags()` lists the body tags of the last frame (which bodies got a name and which a health bar), and `skirmishDev.shadowBakes()` counts how often the ground layer (floor and cast shadows) was rendered. `skirmishDev.trigger()` returns the predicted trigger's `gun`, bloom `heat`, minigun `spin` (0 to 1) and the reticle gap last drawn in px.

To measure feel under latency on localhost, set `LAG=<one-way ms>` and `JITTER=<ms>`. The driver passes them to the client's dev-only `?lag=&jitter=` params, which delay the page's own socket in both directions while keeping message order. Chrome's network emulation does not reliably shape WebSockets, so this is the supported lever. The driver launches headless Chrome (override the binary with `CHROME=`) on a free debug port and talks CDP directly. It proves behavior three independent ways:

- **DOM state** through stable ids: `#servers .server`, `#name`, `#play`, `#account`, `#menu`, `#hud`, `#chat-log`, `#perk-panel` (with `.perk-desc`), `#objective`, `#death`, `#death-title`, `#death-cause`, `#death-lost`, `#respawn`, `#banner`, `#reconnect`.
- **The page's own WebSocket frames**, read with `Network.webSocketFrameReceived`. Position and ammo come from the server's snapshots, not from client state.
- **An observer client** joined to the same room over `ws`. It must see the driven player on its leaderboard and receive the driven player's chat.

`node .claude/skills/verify/scripts/combat.ts "$RUN" [room ...]` is the combat driver. It joins TDM and DOM (or the rooms given), checks the objective banner, shoots until a `dmg` event from the driven player arrives in the page's frames, and opens the perk dock in the first room. Its log is `$RUN/evidence/combat.log`.

`node .claude/skills/verify/scripts/gamefeel.ts "$RUN" [seconds]` plays FFA through real input and screenshots each feedback cue the moment it fires (damage arc, stacked numbers, kill, bounty and assist popups, evolution and hunted callouts, reticle and its reload ring, name tags and your own health bar, edge chevrons, HUD fade, death screen, round banner), and checks the death screen's click guard and when the objective banner returns. Point it at a scratch copy with lowered `LEVELS` and `MAP_MS.FFA`, as [the progression recipe](features/progression-death-modes.md) describes. Its log is `$RUN/evidence/gamefeel.log`.

`node .claude/skills/verify/scripts/abilities.ts "$RUN" [knife] [dash]` earns the ability pick in TDM and proves the dash distance, its client prediction, and the knife slash and hit. Its log is `$RUN/evidence/abilities.log`. See [the progression recipe](features/progression-death-modes.md) for launching a scratch copy with lower level thresholds.

Real input goes through `Input.dispatchKeyEvent` and `Input.dispatchMouseEvent`. Hold `KeyD` to move right. Press the mouse to fire. Press `Enter`, insert text, then press `Enter` to chat. Feature-specific recipes are in [features/README.md](features/README.md).

`scripts/drive.ts` and `scripts/mock-server.ts` at the repo root are a second harness that forces UI states (perk panels, death, winner banner) through mock chat commands. Use it only to check how those states render. Its server is fake, so it proves nothing about gameplay.

### Screens

```bash
node .claude/skills/verify/scripts/screens.ts "$RUN" <out-dir> [view ...]
```

One muted headless Chrome screenshots each art view through real play at 1600x900 (`W=` and `H=` override): `menu`, then `ffa`, `tdm` and `dom` once a frame holds four rounds and two enemies (DOM walks to the nearest zone), by default. `board` shoots TDM while Tab holds the whole leaderboard open. `death` plays FFA without firing until a bot kills it and shoots the death card. `levelup` and `evolve` shoot the perk dock and the evolve dock, then `evolved` just after the pick, and need a scratch copy with low `LEVELS` as in [the progression recipe](features/progression-death-modes.md). `zom-day` and `zom-night` start a squad and need a scratch copy whose night brings a full horde, as in [the zombies feature file](features/zombies.md); pre-placing buildings in its `loadMap` puts turrets and walls in the day shot. Run it against the old and the new build to compare an art change, and set each shot beside `docs/art/gold-standard.webp`, the art-direction reference. It proves nothing about gameplay.

### Muzzle

```bash
LAG=80 JITTER=0 node .claude/skills/verify/scripts/muzzle.ts "$RUN" [seconds]
```

Two muted, lagged browsers join FFA and walk the map's nav paths (`navGrid` and `findPath` from `src/server/bot/nav.ts`) toward each other. If they are not within 380px after 45s the script logs `FAIL` and `RESULT FAIL` and exits. Then both strafe, turn and tap the pistol beside each other. `skirmishDev.firstRounds()` lists each round the first frame the page draws it, with its shooter's drawn muzzle. Shrapnel is left out. The script logs the median, p90 and max gap for own rounds, the second browser's and the bots', and fails when the median gap for own rounds or the second browser's passes 25px, or when the page draws a server copy of either human's gun rounds while their shooter is in view. Its log is `$RUN/evidence/muzzle.log`, with screenshots `muzzle-<own|other>-lag<L>-<ms>ms.png` taken that long after a shot's round trip.

### Fire feel

```bash
LAG=80 node .claude/skills/verify/scripts/firefeel.ts "$RUN"
```

One muted browser taps the pistol, spams it through an empty magazine and a reload, and taps the touch aim stick; a second holds the SMG down (`HOLDS=` sets how often, 3 by default). `skirmishDev.fireFeel()` lists when the page first drew your own round, flash and gun kick, scheduled your shot sound, took back a drawn shot the server never fired (`reject`) or drew a server shot it had not predicted (`late`). The script fails when any cue comes more than 20ms (median) or 34ms (p90) after the real mousedown, when a phase's sounds or flashes differ from the server's own shot events, when any shot is taken back or drawn late, or when the held SMG's mean gap between shots strays 10% from its `fireMs`. Every phase starts from a full magazine, and a phase in which a bot kills the driver or the round ends runs again. Bots chase gunfire from far off, so for a quiet room point it at a scratch copy with `minPlayers` at `0` in `WORLD` in `defs.ts` (the rsync recipe in [the progression recipe](features/progression-death-modes.md); never edit the repo). Its log is `$RUN/evidence/firefeel.log`.

### Guns

```bash
LAG=80 node .claude/skills/verify/scripts/guns.ts "$RUN"
```

One muted browser at a time proves the class gun rules through real input. An assault rifle held for 1.6s must open its reticle to about double (read from `skirmishDev.trigger()`) and close it within 400ms of release. A Minigun held for 2.2s must start with a gap of at least 2.2x its `fireMs` between own shot sounds, reach its `fireMs` by the end, and start slow again after a second off the trigger. A sniper's camera must take in `viewMulFor('sniper', {})` (1.28x) the pistol's view (from `skirmishDev.toScreen`). Every hold must draw each server shot on time with none taken back. Minigun is a stage-2 gun, so point it at a scratch copy (the rsync recipe in [the progression recipe](features/progression-death-modes.md)) whose `addPlayer` in `src/shared/sim.ts` and `resetProgress` in `src/shared/sim/stats.ts` hand an `lmg` loadout the `minigun`, with `minPlayers` at `0` for a quiet room. Screenshots: `guns-assault-idle`, `guns-assault-held` (3x crops round the reticle), `guns-assault-held-full`, `guns-assault-released`, `guns-minigun-spinning-up`, `guns-minigun-spun`, `guns-sniper-view`. Its log is `$RUN/evidence/guns.log`.

### Last Squad

```bash
node .claude/skills/verify/scripts/royale-ui.ts "$RUN"
```

One muted headless Chrome joins the br room through the menu, walks out of the ring and stays there until the ring knocks and kills it, then checks spectating and the result card, with a screenshot of each. Run it on a scratch copy with a fast ring. The recipe and its log lines are in [the Last Squad feature file](features/last-squad.md).

### Zombies

```bash
node .claude/skills/verify/scripts/zombies-ui.ts "$RUN" [step ...]
```

One muted headless Chrome plays a zombies squad through real input. Steps: `menu badlink squad build turrets night` by default, plus `ready` (after `night`), and `variety` (the three wall tiers, upgrades by U, chip and click, and every buildable, with a closeup of each at 3x device pixels), `downed`, `report`, `horde` and `victory`, which need scratch copies (about 3000 starting scrap and a long day, fragile humans and a weak core, a mixed first night, a one-night run). It starts a squad from the menu, follows its invite link, builds and takes down a wall and puts up a sentry with real keys and clicks, reads the ghost and callouts from `skirmishDev.zombies()`, and plays night 1 to dawn, watching the turrets fire and reloading one with E. It checks the warning and dawn forecasts against the night table and that night 1's zombies come only from the forecast side. Its log is `$RUN/evidence/zombies-ui.log`. The recipes and scratch values are in [the zombies feature file](features/zombies.md). `SQUAD=1 frametime.ts` measures frame cost in a squad.

### Two players

```bash
node .claude/skills/verify/scripts/duel.ts "$RUN"
```

Two separate headless Chromes join FFA and walk toward each other along the map's nav paths (`navGrid` and `findPath` from `src/server/bot/nav.ts`, rebuilt from each `welcome` or `walls` frame, with crates stamped in). The hunter taps fire only when the target is within 420px, in its snapshots and in clear line of sight (`clearShot`), until both sockets agree on the hit or 180s pass. It checks that both browsers joined, that each had the other in its own snapshots, that the hunter's socket shows a `dmg` event naming the target, and that the target's socket shows the same hit. It writes `duel.log`, `duel-hunter-view.png` and `duel-target-view.png`. Like `drive.ts`, it targets a deployed site when the run directory has a `url` file.

### Frame time

```bash
node .claude/skills/verify/scripts/frametime.ts "$RUN" [seconds] [width] [height]
```

One headless Chrome joins FFA at 1920x1080 through `?dev`, picks the SMG, and holds fire while it strafes toward the nearest player. After a 5s warmup it logs to `frametime.log` how busy the view was (players and bullets per snapshot), `frame cost` (each real frame's draw calls, from `skirmishDev.takeFrameCosts()`) and the `requestAnimationFrame` interval, then how many times the ground layer was rendered while sampling, which a map's walls never cause after the first frame. The GPU canvas defers rasterizing, so `frame cost` alone misses pixel work. `SOFTWARE=1` turns the GPU canvas off and adds `rastered frame cost`: the current frame redrawn back to back by `skirmishDev.benchFrames(n)`, each waiting for its pixels. Compare both modes before and after any art change, three runs per side, since bot positions vary.

## Evidence

The driver writes `$RUN/evidence/drive.log`, one `ok` or `FAIL` line per check with measured values (for example `x 736 -> 914`, `ammo 12 -> 11`), and a final `RESULT PASS` or `RESULT FAIL`. It saves a PNG per step to `$RUN/evidence/`. It exits non-zero on any failed check, page exception or `console.error`.

Proof standards:
- Drive the real user path. Never call `/api/*` or the sim to cause the behavior you are proving. Reading `/api/*` to confirm a side effect is fine.
- Capture both the action and the resulting state. A screenshot alone is not proof. Pair it with the measured log line.
- Confirm side effects. An account must exist via `GET /api/stats/<name>`. A join must raise `humans` in `/api/servers`. Chat must reach another client.
- The only mock allowed for gameplay proof is none. Bots are real server participants, not mocks.
- When you add a check, break the behavior once (for example, stop `room.ts` from calling `setInput`) and confirm the check fails, then restore the file.

## Cleanup

```bash
.claude/skills/verify/scripts/cleanup.sh "$RUN"
```

Kills only the pid in `$RUN/pid`, then deletes `$RUN/data`, `$RUN/pid` and `$RUN/port`. It keeps `$RUN/evidence/` and `$RUN/server.log`. Run cleanup after every attempt, including failed ones. The driver kills its own Chrome on exit.

## Gotchas

- `/api/servers` counts the observer as a human. Compare against a baseline, never against an absolute number.
- Navigating the page to `about:blank` keeps the old page in Chrome's back/forward cache, so its socket stays open. Use `Page.reload` to unload the page the way closing a tab would.
- The menu's server list re-renders every few seconds, so element handles go stale. Query fresh each time, or click through `Runtime.evaluate`.
- Bots can kill the driven player mid-run, and a dead player has no position in snapshots. `move`, `fire` and `touch` call `ensureAlive`, which respawns through the real death screen and logs a `note` line, so a death no longer fails the run.
