# Tinwar verification map

This directory is the maintained source for verifying what a Tinwar player can do. Read this index before driving the game, then use the matching feature file as the recipe.

## Baseline preconditions

- Launch with `.claude/skills/verify/scripts/launch.sh "$RUN"` and require `doctor.sh "$RUN"` to print only `ok` lines.
- Each run has its own port and `$RUN/data`, so accounts start empty.
- Every room starts with bots, so the driven player always has opponents.
- Never drive a server this run did not start.

## Driving conventions

- Drive with `node .claude/skills/verify/scripts/drive.ts "$RUN" <steps>`. Steps run in the order given, in one browser session.
- Prefer element ids (`#play`, `#account`, `#chat-log`) over coordinates.
- Read gameplay results from the page's WebSocket frames or an observer client, never from the client's internal state.
- Clean up with `cleanup.sh "$RUN"` after every attempt.

## Proof and skip reporting

- Report the `drive.log` line with its measured values, plus the matching screenshot.
- Confirm side effects through `/api/*` reads or the observer client.
- A feature whose state the driver cannot reach on the real server (for example a full-length match at the stock win score) is reported as not verified, with the reason. Mock-server screenshots do not count as verification.

## Feature entry contract

Each feature file starts with an H1 and one paragraph on the user-visible behavior, then four H2s in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with drive.ts`, `Gotchas`.

## Features

- [Menu and loadout](./menu-loadout.md) covers the room list, weapon, color and armor pickers and their saved pick, the saved name, the controls panel, menu errors, phone layout, the privacy link and the muted panel.
- [Accounts and stats](./accounts.md) covers register, login, the token, per-life stat credit, the stats panel, the leaderboard, the privacy page and error codes.
- [Joining and playing](./join-play.md) covers joining a room, room limits and standstill, moving, the input queue, firing, hit feedback, the reticle, HUD fading, leaving, the duel, muzzle-drawn rounds, reconnect, the view rectangle and lag compensation.
- [Chat](./chat.md) covers sending and receiving, the chat log and system lines, the rate limit, word masking, renaming blocked names, and mute.
- [Progression, death and modes](./progression-death-modes.md) covers perks, gun evolution and its callouts, the score pill, Tab board and level bar, the hunted marker, edge chevrons and bounty, kill popups, abilities, the death screen, respawn, TDM and DOM scoring, and round end.
- [Map rotation](./maps.md) covers the four maps, per-mode rotation, round clocks, per-map resets and the next-map notice.
- [Last Squad](./last-squad.md) covers the br room, its seats, the ring, knocks and finishes, redeploys and last lives, supply drops, spectating, the squad tracker, the result card, the squad bots and the bench.
- [Zombies](./zombies.md) covers squad rooms by code and invite links, empty-room standstill, bot errands, the horde's pathing, the day and night run, the horde, the core and walls in the browser, build mode, scrap, downs and revives, the run HUD, callouts, sounds and report, the night table and its forecast, the Bastion's survivors, ready-up, the win, and the bench.
- [Shooting range](./range.md) covers the private range room opened from the menu, its lanes and painted distances, the targets and their regeneration, the damage paths, the readout, the loadout panel and its message, the practice room's no-profile guarantee, and the browser capture.
