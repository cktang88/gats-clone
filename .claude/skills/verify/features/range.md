# Shooting range

The shooting range is mode `RNG`: a private practice room for one player, opened from the menu's Shooting range card, with one target at each painted distance across an open field (100 to 1250 px), two sliding targets, a training dummy, a small blast corner with two barrels and two props, a loadout panel for any gun, evolution, armor and perk, and a readout of the last hit, damage per second, accuracy and time to kill. Targets fall when killed and stand up again after about four seconds. Nothing in the room counts toward an account, a profile, XP or a medal.

## Sub-features

- `range-open` is `POST /api/range`, answering `{ room: 'r-xxxxxx' }`. The room takes one human, has no bots, is not in `/api/servers`, and closes `rangeIdleMs` (30 s) after its player leaves; `rangeRooms` (40) caps how many run at once.
- `range-targets` are `World.range.targets` (ten of them: six in the field, one per painted distance on a bowed diagonal, two sliders in the Moving bay, and the dummy and the paper soldier behind the low wall in the Blast bay) (`src/shared/sim/targets.ts`), laid out by `MAPS.range.range` and listed on the wire as `snap.targets`, one number each in layout order: tenths of health 1 to 10, or 0 while knocked down. Sliders carry no position on the wire; `targetPos(def, serverMs)` places them on both sides.
- `range-damage` is the normal damage path: rounds (`moveBullet`, judged at the time the shooter saw), blasts (`explode`), the knife, gas, fire and land mines. A hit is a `dmg` event of `kind: 'target'` (damage numbers, hit marker, sound); a fall and a standing up are `target` events with `k: 'down'` or `'up'`.
- `range-regen` is `RANGE.regenMs` (4 s) for a fallen target, `RANGE.healMs` (4 s) for a hurt one left alone, and `RANGE.propRespawnMs` (6 s) for barrels and props.
- `range-radio` is the toy radio by the booth (`FIXED_RADIO.range` in `src/shared/radio.ts`): walk within 90 px and an E prompt floats over it; E (or the phone's Radio button) sends `{ t: 'radio', station }`, the server answers every client in the room with the same message, and the music crossfades to that track (or goes silent for Off). The pick is saved in `localStorage` `skirmish.radio.station`. Shooting the radio makes it sputter; it is never destroyed. To see it, run a scratch copy whose join puts you beside the spot (the sim never moves a player for a screenshot).
- `range-readout` is `snap.range`: `last` (damage, distance), `dps` (over 3 s), `shots` and `hits` (a trigger pull counts once however many pellets land), `ttk` (ms, distance, kind), `downs`, `total`. The `#range-hud` plate shows it.
- `range-loadout` is the client message `{ t: 'range', a: 'loadout', gun?, armor?, perks? }` and `{ t: 'range', a: 'reset' }`. Only a Range room applies them; any other room answers an `error`. The `#range-panel` (key L, or the `#range-open` button) sends them.
- `range-reach` is the held gun's reach (`src/client/rangeline.ts`): a dotted orange arc round you at `MUZZLE_PX + rangeFor(gun, perks)`, a faint falloff band, a `MAX RANGE … · GUN` plate at its far point (pinned to the right edge with a chevron when off screen) and a chip under each standing target (orange tick: full damage; half orange: falloff; dark cross: out of reach). Pick a pistol, SMG, bolt-action and Piercer in the panel and screenshot each from the firing line, aiming east so the view leans out; `W=844 H=390` for a phone. `test/range-reach.test.ts` proves it against real rounds.
- `range-practice` is `createRoom`'s practice flag: no `accounts.credit`, no `profiles.record`, `life`, `round`, `equip`, `state` or `notice`, no payout, no bots.

## How to get to it (user POV)

- On the menu press Open the range (`#range-start`) in the Shooting range block. Press L for the loadout panel, click a gun, an armor and a perk in each tier, aim with the mouse and fire. The Reset buttons start the readout over and stand every target up.

## Driving it with drive.ts

Preconditions:

- Doctor passes and lists four rooms. A range is not one of them.

- **The browser.** `node .claude/skills/verify/scripts/range-ui.ts "$RUN" <out-dir>` opens a range through the menu card with a real mouse press, opens the panel with L, picks the Hailstorm, Grip, Steady hands, Frag grenade and Medium armor, shoots the field's paper target 100 px out until it falls, times its standing up by the server's ticks (expect 4000 ms), and screenshots the card, the booth, the panel, the readout mid-fire, the fall, the lying target, the spring up, the sliders (`12-rails`), the far end of the field (`13-field`) and the blast corner (`14-blast-lane`). It logs `RESULT PASS` or `RESULT FAIL` to `<out-dir>/range-ui.log`. `W=` and `H=` set the viewport, for example `W=844 H=390` for a phone on its side.
- **The map.** `CHROME=... node scripts/map-overview.ts <out-dir> range` draws the whole range with its floor paint and targets; `node scripts/map-lint.ts` checks every target and rail stands clear of walls, barrels and props and can be shot from somewhere a player can stand.
- **The rules without a browser.** `node --test test/range.test.ts test/client-range.test.ts` covers damage, falling and regenerating on time, the readout, every weapon path (round, blast, knife, gas, mine), the rewound slider, barrel and prop respawn, the loadout for every gun and perk, the message being refused outside a range, no profile writes, determinism, and the HTTP room.

## Gotchas

- The golden replay (`node scripts/golden-replay.ts`) never plays a range, so its hash holds; `World.range` is absent in every other mode and the snapshot omits `targets` and `range` there.
- A shot judged in the past meets a slider where it was; one fired by the test helpers has no `viewAt`, so it meets the slider where it is.
- The range's player cannot be hurt (`damagePlayer` returns at once in `RNG`), so a grenade at your own feet shows no damage or shove.
- A dead-still headless browser needs a real mouse press on `#range-start`, or audio never unlocks (it does not affect the run).
