# Tinwar art bible

**One idea: toy soldiers fighting a real night op.** Chunky, tactile figures in the spirit of Advanced Wars 1+2 Re-Boot Camp, set in a diorama that is lit with intent, as Intravenous lights its levels. Every pixel answers one of three questions: *what is it made of, where is the light, and what does the player need to see.* If a detail answers none of them, cut it.

## Pillars

1. **Tactile.** Everything looks like an object you could pick up: chunky rounded shapes, bold ink outlines, flat paint, two hard shade steps. Nothing is wispy, hairline or photographic.
2. **Lit with intent.** One key light for the whole world, and every bright thing (muzzle, blast, lamp, core, sparks) is a *light source* that briefly lights its surroundings. Darkness is a design tool, not a filter.
3. **Restraint.** A small palette, short effects and quiet surfaces, so the moments that matter (a kill, a medal, a blast) are the loudest thing on screen.
4. **Readable first.** Players, rounds and threats always pop against the floor. Atmosphere never hides gameplay.

## Palette (use these tokens; don't invent colours)

| Role | Colour | Use |
|---|---|---|
| Ink | `#1c1f26` | Every outline, punched holes, deepest shadow |
| Night-op concrete | `#615d54` (slabs `#6a655b` / `#58544c`, seams `#3b3833`, wear `#7d776a`, grime `#2e2b27`) | The floor, day and night: mid-dark warm concrete (`FLOOR` in `palette.ts`) |
| Floor paint | `#b79a4a` (stencil/bone `#d2cab4`) | Lane lines, hazard bands, range digits; desaturated ochre |
| Bone | `#e2dccb` → `#cfc7b3` | Dust, chalk, stencil paint, UI text; never a floor |
| Gunmetal | `#4f5560` / `#3d4450` | Concrete plates, guns, turrets, UI plates |
| Khaki | `#b4a07a` | Sandstone, sandbags, built walls (darker `#978562`) |
| Olive | `#6c7356` | Planters, crates, packs, ammo boxes |
| Rust | `#a8552e` | Wear, barrels, hazard dirt |
| Signal orange | `#ff5a1f` | What *you* can act on, and danger aimed at you |
| Gold | `#ffd34d` | Reward only: score, medals, bounty |
| Lamp amber | `#ffb347` | Practical light: lamps, muzzle glow, fire core |
| Night steel | `#141c3c` → `#26304a` | Shadow and night ambient (cool, never black) |
| Team colours | the six player colours | Only on soldiers' helmets/torsos and team markings |
| Horde | `#8a9a5b`, `#6f7a4e`, `#5c6b6e`, `#7a5a46` | Zombies: sickly versions of olive, steel and rust |

Fire ramps from white to `#ffe08a` to `#ff9a3c` to `#d9541f` to smoke `#5a5550`. Sparks are `#ffd27a`. Heal and revive use `#8ff0c4`, sparingly.

## Light

- **Key light** comes from the top left (`LIGHT = {x: 0.62, y: 0.78}` in `src/client/tilt.ts`). All shadows fall down and to the right; never mix directions.
- **Cel steps**: a highlight band 24% toward white on the lit side and a shade band 30% toward black on the far side, both with hard edges. Gradients are allowed only on light itself (glows, pools, flashes), never on solid paint.
- **Contrast rules (floor is mid-dark, value about 37%)**: wall and crate *top faces* are lighter than the floor and their front faces darker; decals (bullet holes, scorch, blood, oil, cracks) are *darker* than the floor; dust, chalk, casings and floor paint are *lighter*. Concrete top `#78808c`, slate `#667080`, steel `#808a99`. Night multiplies the world by `[0.28, 0.34, 0.62]` so the floor stays readable under amber pools.
- **Contact shadows** sit under every standing thing: `rgba(10, 12, 18, 0.42)`, tight and crisp.
- **Practical lights**: muzzle flashes, explosions, the core, lamps and turret fire paint a short-lived warm pool on the floor (additive or `lighter`, amber, 80–250 ms, longer for blasts). At night these are the main light. A lit thing lights the floor around it.
- **Day** is an overcast yard: soft, low-contrast floor and crisp shadows. **Night** is dark cool steel with amber pools, lamps that flicker rarely, and dust motes that show only inside light.

## Line and shape

- Outline in ink, **2 px at 1× zoom** for bodies, solids, props and guns, and 1–1.5 px for small debris (casings, chips). Never outline light, smoke, glow or text-free FX.
- No stroke thinner than 1 px anywhere, and **no hairlines**: damage reads as chunks, pits and cutouts.
- Shapes are chunky and slightly rounded, like toys. Proportions are a little squat: big helmeted heads, short limbs, fat barrels, thick slabs.
- One small specular dot on round toy forms (helmets, barrels, the core crystal), on the lit side.

## Perspective

- **Three-quarter view everywhere**: the top face is the gameplay footprint, and a darker front face hangs below its south edge (walls 12–16 px, crates and props about 8–10 px, turret mounts about 6 px, the podium the same rule).
- Figures put the head up-screen of the torso. Held guns are side profiles foreshortened about 0.6 and mirrored when aiming left.
- Anything new (barrels, airdrop crates, podiums, core) follows the same top-face and front-face rule and the same light.

## Motion

- The language is **anticipation, then snap, then settle**: squash on impact, stretch on launch, and ease out (cubic) to rest.
- Durations: micro feedback 80–150 ms; hits 150–250 ms; kill bursts at most 400 ms; celebrations at most 1.2 s; hit-stop 30–60 ms.
- Nothing loops faster than 4 Hz except fire flicker. Idle life is slow and small (breathing, an occasional glint).
- Respect `prefers-reduced-motion`: drop shake, zoom and flashes, and keep the information.

## Effects

- **Layering**: a light flash, then the shape (fireball, burst), then particles, then a residue decal. The residue persists so the arena tells the story of the fight: bullet holes 4 min, scorch about 15 s, blood and ichor until it fades, rubble while the wall stands.
- **Counts** are capped and pooled. Effects are batched by colour and culled to the view.
- **Colour**: effects use the fire, spark and smoke ramps above. Team colour appears in effects only for that player's own confetti and kill burst.

## Interface

- One field kit: matte gunmetal plates with clipped top-right and bottom-left corners, an orange corner bracket, Barlow Condensed in bone `#ece6d6`, orange for actions and gold for reward.
- Any text drawn over the world sits on a plate. The UI scales with `--ui` and never goes below 13 px at 1×.
- UI motion follows the same anticipation, snap and settle language. Medals stamp, numbers tick up, and nothing bounces forever.

## Sound and music

The music is a toy-military march (Advanced Wars CO-theme spirit), and the sound effects are punchy and physical. Big visual moments always have a sound, and loud sounds always have a visual.

## Never

- Pure white fills over large areas, neon outside gameplay-critical cues, or rainbow gradients.
- Shadows in more than one direction, or soft blurry halos on solid objects.
- Hairline cracks, thin wispy strokes or photographic textures.
- Emoji or system-font UI.
- An effect without a light or sound, or a light without a source.
- Busy floors that compete with players.
