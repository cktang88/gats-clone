# Why a good player beats the bots

A first-principles list of what a good human does in Tinwar that the bots did not, whether the bots do it now, and where. A human wins
on information (a top-down view shows everyone around them at once), on picking fights, and on cover: they see a man coming, pre-aim the angle
he will come from, take only the fights they will win, poke from cover, and leave a fight the moment it turns. The bot brain lives in
`src/server/bot/` (tiers in `tick.ts`, plans in `intent.ts`, hands in `motor.ts`, the read of the fight in `tactics.ts`).

Bots stay fair throughout: they see by the same snapshot culling as a person (with the biggest screen a person can have), read only what a
person's screen shows (health bars, guns, levels, armor, the reload arm animation, where someone faces), turn their guns by hand at capped
rates, and take a reaction time to take in anyone they see. Nothing here sees through walls or smoke.

| What a good player does | Bots before | Bots now | Where |
| --- | --- | --- | --- |
| **Sees everything round him.** A big monitor shows the whole radius. | Saw a 16:9 box (780 x 439 px each way). | See the squarest view the game honours (`BOT_VIEW_ASPECT` = `VIEW_ASPECT.min`, 780 px every way): as much as any person's screen. | `protocol.ts`, `awareness.ts`, `tick.ts` |
| **Remembers how each enemy stood**: where, facing where, planted or moving, reloading. | Only the last position (`Awareness.contacts`). | `Sighting` per enemy: position, facing, still, reload end (read off `rl`, which every screen animates), gun. | `tactics.ts` `observe` |
| **Pre-aims where the next man comes from**, never stares at a wall. | Faced the last-known spot (often straight into its own cover) or its route. | With nobody in sight but someone about, the gun sits on the edge of the cover he is behind, on his side of it (`watchPoint`, `edgeToward`), or on where a shot came from, whatever the bot is doing. | `tactics.ts`, `motor.ts` |
| **Shoots first at a man who walks into his pre-aim.** | Same 220 to 350 ms reaction whatever. | 0.6 of its reaction time for one who shows within 10 degrees of where it was already watching (`PRE_AIMED_REACT`). | `motor.ts` |
| **Picks fights he wins**: health vs health, gun vs gun at this range, armor, who is aimed at whom, who is reloading or just sprinted, his own suppression, mates and enemies near. | Engaged anyone in sight (only very low health, or 2 on 1 under half health, sent it away). | `fightOdds`: the log of his time to kill it over its time to kill him, from all of those. Below its temper's `takesOdds` (hothead -0.45, marksman -0.2, careful -0.05) it does not walk in: it breaks line and holds an angle on him from cover (`hold`). A hunted enemy is fought on odds 1 worse (the room hunts him). | `tactics.ts`, `intent.ts` `engageOnSight`, `hold` |
| **Never a 1v2.** Moves off before a second man gets on him; finishes the first only if he is nearly dead. | Fought whoever was in front of it. | Every other enemy that can get on it (in sight within 750 px, or seen there in the last 2.5 s) costs 0.45 of odds (less if he is turned away, busy), every mate by it gives 0.45 back; a fight that sinks 0.3 under its line is left on the spot for cover hidden from all of them (`leaveTurnedFight`). One under 30% it can drop in 0.6 s is finished. | `tactics.ts` `othersOn`, `intent.ts` |
| **Commits to a won fight.** | Rolled peek-and-hide even when winning. | Odds over 0.6 (he is hurt, reloading, outnumbered) and it pushes rather than peeks; over 0.9 a peek-and-hide turns into a push. | `intent.ts` `engage`, `peekAndHide` |
| **Pokes**: sees him coming, takes cover with a lane on him, out for a burst, back before he answers. | Engaged in the open on sight; peeked by a temper roll for a fixed 0.7 to 1.8 s whatever happened. | A fight not clearly its own (odds under 0.3) seen coming, out of his fire, is met from cover it pokes from, and a fight in hand is poked 0.3 likelier than its temper's roll; shot at 250 ms into a peek, it ducks back at once; it leaves the cover to push only at odds 0.9. | `intent.ts` `engageOnSight`, `engage`, `advancePeekPhase` |
| **Does not swing into a held angle.** | Swung out on a timer. | A peek into an angle the enemy was last seen holding (planted, facing within 15 degrees of the peek) is put off up to twice, then it goes round another way (`flank`); a lost enemy last seen holding the way it would come is flanked or held, not chased round his corner. | `intent.ts` `advancePeekPhase`, `lostSight` |
| **Punishes a reload.** | Did not read reloads. | Seen reloading, he is worth more odds; its hide is cut short to peek while he is at it. | `tactics.ts`, `intent.ts` |
| **Reloads behind cover, never in the open.** | Reloaded under half a magazine anywhere with nobody in sight. | With an enemy seen lately and a line to where he was, it holds its reload until under 20% of the magazine. | `motor.ts` |
| **Shoots the right man first**: the one shooting him, then the one he drops soonest. | Shooters, then danger (level, hunted), then nearest. | Shooters, then danger, then low health, reloading, facing it, nearest (`rankThreats`). | `tactics.ts` |
| **Third-parties a weakened winner, and stays out of other people's fights.** | No. | Partly: an enemy turned on someone else counts as a lesser threat, and low health raises the odds, so a weakened fighter is taken and a busy pair is not walked into. | `tactics.ts` |
| **Heals and retreats when losing.** | Yes (`fleeLosingFight`, `retreatAndHeal`). | Unchanged. | `intent.ts` |
| **Uses the game's tricks**: flash before a swing, smoke to cross, barrels by enemies, suppression, the post-sprint bloom, a sniper's bolt. | Flash at a lost enemy's corner, smoke when hurt, barrels and props, settle before a long shot after a sprint. | Also in the odds: a sprinting enemy's lowered gun, a bolt-action or slug that has just fired at it (pushed while it cycles), and its own suppression and post-sprint bloom. | `motor.ts`, `tactics.ts` |

## Still open

- Counting an enemy's rounds against his magazine (a person hears the dry click coming): only the reload animation is read.
- Holding doors shut, ambushing behind a swing leaf, smoke to cross open ground or
  cover a revive, playing safer one kill short of an evolve, ganging up on a hunted player as a team, airdrop timing.
- Bots do not share sightings with mates (a person calls out); each bot reads only its own screen.
