# Map rotation

Tinwar has four 6000 px versus maps, Causeway, Plaza, Old Town and Quarry. Each is drawn in `src/shared/maps/` as the west half of a 50px-cell text grid, and `src/shared/mapgrid.ts` builds the east half by a half turn, so the map's size comes from its row count. The 3000 px Outpost (`src/shared/maps.ts`) is the zombies map. Each versus mode rotates through its own order. The Tab view names the current map, and a pill warns before the next one.

## Sub-features

- `map-rotate-rounds` changes the map at each round restart in FFA, TDM and DOM. Zombies stays on Outpost.
- `map-layout` keeps every spot walkable from a spawn, the team spawns out of each other's sight, walls, spawns, crates and zones the same after a half turn, walls and crates inside the map and crates off the walls, and three DOM zones, each reachable, inside the map and off walls and crates. `node scripts/map-lint.ts` prints any problem and each map's longest sightline, and always exits 0. `test/map-lint.test.ts` fails on a problem.
- `map-rotate-timer` ends an FFA round after 10 minutes if no human reached 30 kills first. The player with the most kills wins, and the next round starts on the next map. With no kills at all, the map changes without a round end. TDM (12 minutes) and DOM (15 minutes) have clocks too. When one runs out the team ahead on score, then on kills, wins with the note `Time ran out`. A dead heat crowns nobody and the next round starts on the next map at once.
- `map-notice` shows a gold `Next map: X in Ns` pill under the top panel for the last 15s before a change. A round win puts the change 8s away, so after a win the pill appears at once and counts down from 8.
- `map-radios` hides two to four small radios on every versus map, tucked into corners and alcoves (`src/shared/radiopool.ts`, built by `scripts/radio-pool.ts`) and re-rolled each round from a seed the clients share (`match.roundEndsAt`, or `royale.round` in Last Squad). Walking near one shows an E prompt; E cycles your own music (every track, Map default, Off) until the round ends. Client only: no message, no collision, bots ignore them, and the golden replay is untouched. The first one found says "Found a radio!".
- `map-name` names the current map in the objective line, which shows only while Tab is held.
- `map-respawn` teleports every living player to a fresh spawn on the new map. Everyone is parked off the map first, so each spawn keeps clear of players already placed on the new map, not of old positions.
- `map-reset` reloads the new map's walls, crates (drawn as planters) and, in DOM, its three zones (one marked in the west half, the centre, and its half-turn twin), and clears bullets, thrown items and dashes. Each change sends one `walls` frame with the new `worldSize` and walls, and the minimap rescales to it. A `walls` frame also goes out whenever an engineer wall goes up or expires (`wallsVersion` in `src/shared/sim/abilities.ts`), so detect a map change from `match.map`, not from `walls` frames.
- `map-materials` draws walls as concrete, sandstone or planter, as the grid marks them.
- `map-objective` shows the `#objective` banner for 4s again on each new map.

## How to get to it (user POV)

- Play TDM or DOM until a team wins the round. The next round starts on the next map.
- Stay in FFA for 10 minutes, or until a human reaches 30 kills.

## Driving it with drive.ts

Preconditions:

- Doctor passes on a scratch copy with short rounds. Never edit the repo itself.

- **Scratch copy.** `rsync -a --exclude node_modules --exclude .git --exclude data <repo>/ "$RUN/repo/"`, then `ln -s <repo>/node_modules "$RUN/repo/node_modules"`. In `$RUN/repo/src/shared/defs.ts` set `tdmWinScore` to `2`. In `$RUN/repo/src/shared/maps.ts` set `MAP_MS.FFA` to `30_000`. Launch with `$RUN/repo/.claude/skills/verify/scripts/launch.sh "$RUN/run"`.
- **Watcher.** Open a `ws` client to `ws://localhost:<port>/ws?room=tdm` and another to `?room=ffa`, and send `{t:'join', name, loadout:{weapon:'pistol', armor:'none', color:'green'}}` on each. On every `snap`, keep the last `match` and log `match.map`, `match.winner`, `match.nextMap` and `match.mapChangeIn` when they change.
- **Proof in TDM.** A winner appears with a next-map notice, then `match.map` advances. The TDM rotation is Causeway, Plaza, Quarry, then Old Town.
- **Proof in FFA.** A next-map notice appears. Once a bot has a kill, the timer ends the round instead: `match.winner.name` names the top killer, then `match.map` advances at the restart. With no kills at all the timer starts the next round on the next map at once, with no winner. TDM has a 12-minute clock too (`MAP_MS.TDM`) and DOM a 15-minute one; set either to `30_000` in the scratch `maps.ts` to watch a time-limit win. Lower `ffaWinKills` in the scratch `defs.ts` and reach it as a human to see the kill-target win; bots at the target do not end the round.
- **Layout and play.** `node scripts/map-lint.ts` and `npm test` check the layouts. `node scripts/map-overview.ts <out> all` draws each map whole in headless Chrome (override with `CHROME=`). `node scripts/bench-maps.ts TDM rotation 10 18 <heat-dir>` (mode, maps, minutes, players, heat directory as the 5th argument) then `map-overview.ts <out> none <heat files>` shows where bots fight and die. None needs a server.
- **HUD and pill.** Not scripted. Screenshot the page in the same scratch run during the last 15s to see the pill. Hold `Tab` (a `keyDown` with code `Tab`) to see the map name. `node screens.ts "$RUN" <out> board` shoots the Tab view.

## Gotchas

- Snapshots omit `match` when it has not changed. A raw reader must refill it from the last snapshot, as `fillSnapshot` in `src/shared/wire.ts` does.
- Never drive `abilities.ts` on this scratch config. Rounds end every few seconds and reset level and perks. See [progression](./progression-death-modes.md).
- A map change moves every living player, so a move check that spans one can fail.
