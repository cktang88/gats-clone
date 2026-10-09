# Writing a map theme

The map themes are written to a small set of pop-songwriting rules. The rules exist because of player feedback: the first
pass of map music "didn't really feel memorable or evoke any emotion, kinda sounded messy", and the recordings that replaced
it were "meh". What players do like is the toy march (`musicclassic.ts`), Eric Skiff's catchy 8-bit melodies, and epic tracks
with deep bass drops and phonk energy. All of those are simple and catchy, and they build.

The engine is `src/client/musicpop.ts`. The themes, one `PopSpec` each, are in `src/client/musicthemes.ts`, and
`test/client-musicpop.test.ts` checks every rule below that can be checked.

## The rules

1. **One hook.** A theme has one strong, singable hook: a motif of 4 to 8 notes with a rhythm you could tap. It is the
   first bar of the four-bar hook phrase (call, answer, call again, closing answer). The third bar repeats the call, either
   exactly or moved along the scale to fit its chord (a sequence). The rhythm stays the same and the contour moves the same
   way. Everything else in the theme serves the hook. The hook stays within an octave and a third, and its answers end on a
   chord tone.
2. **Four chords.** A theme loops one four-chord progression, one chord per bar, in a key and mode that suit the map. The
   progressions are the proven ones: I-V-vi-IV, vi-IV-I-V, I-vi-IV-V, IV-V-iii-vi, ii-V-I-vi for bright themes; i-VI-III-VII,
   i-VII-VI-VII, i-VII-VI-V (Andalusian), i-VI-iv-V, i-iv-VII-III and i-VI-VII-V for dark or epic ones; and the
   mixolydian I-bVII-IV-I for the blues. Pop songs share progressions all the time, so two themes may use the same one in
   different keys and genres.
3. **Build in layers.** Every theme follows the same arc. It opens on an 8-bar intro: 4 bars of beat and pad, then 4 bars
   with the bass added and the hook teased. Then comes a 32-bar loop of 8-bar sections:
   - **hook**: the full hook over the groove.
   - **groove**: call and response. The hook voice sings the calls, a counter voice answers, and in a fight the lead jumps
     an octave for the second half.
   - **break**: 4 bars of breakdown (drums and bass out, the call alone over a pad), then 4 bars of build (a riser, a
     pulsing kick and bass, a snare roll). The last beat before the drop is silent.
   - **drop**: an impact, the big bass (an 808 with slides on the trap and phonk themes, octave-pumping bass on the others)
     and the hook on top. The phonk and trap drops go half-time.

   After the drop the loop goes back to the hook section, not to the intro.
4. **Vary every 8 bars.** No two neighbouring 8-bar sections are arranged the same way. Each section's last bar has a
   fill, and its fourth bar has a smaller one. Every other time round the loop, the drop doubles the hook an octave up and
   the comping changes. The seed only picks which fill plays; the hook, chords and bass never depend on it.
5. **Leave space.** Few voices play at once: in calm, a pad or a comp, the bass, a light kick and hat, and the hook. The
   pad and comp sit at middle C and above, and only the bass and kick live below it, so the low mids stay clear of mud. The
   kick and the bass riff are written together so they hit together, and the calm beat is catchy on its own.
6. **Fit the game.** The arc runs inside the intensity layers the director already has. The calm layer is a complete
   small version of the song (the hook is always there). A fight adds the backbeat, the full kit and the lead. A streak
   adds the counter-melody, the finale adds sixteenth hats and a harmony a third under, and the Zombies night adds a
   heartbeat. Kill stings ring the current chord's tones, so they are always in key, and the win and loss cadences sit on
   the theme's tonic.
7. **Own identity.** Each map has its own tempo, key, groove and band, and no two themes share a lead voice or an opening
   hook. Four themes have the phonk and trap energy players asked for: Quarry (drift phonk, cowbell hook, distorted 808),
   Sub Pen (dark trap, sonar hook, 808 slides), Airbase (trap anthem, brass hook, half-time 808 drop) and Wasteland
   (western phonk, whistle hook, cowbell counter, 808).

## The themes

| Map | Theme | Tempo, key | Progression | Hook |
| --- | --- | --- | --- | --- |
| Old Town | Cobblestone Kolo | 136, A minor | i-VII-VI-V | bandoneon, a skipping pickup leaping to the octave with a G# twist; violin in a fight |
| Quarry | Rockfall Phonk | 144, G minor | i-VI-iv-V | cowbell 3-3-2 tresillo climbing to the fifth; a saw an octave under in a fight |
| Causeway | Harbour Lights | 112 swung, D dorian | i-VII-VI-VII | accordion shanty call with a dotted pickup; fiddle in a fight; stomp-clap kit |
| Night Market | Lantern Arcade | 132, E major | I-V-vi-IV | chiptune arpeggio up and back down (the stand-in: Skiff's recording plays the map) |
| Museum | Velvet Rope | 100 swung, E minor | i-iv-VII-III | tip-toe vibes with a chromatic step, played as a sequence; sax in a fight |
| Sub Pen | Deep Contact | 140, F minor | i-VI-III-VII | sonar ping rising a minor sixth; acid lead in a fight; 808 slides |
| Park | Picnic Parade | 118, C major | I-V-vi-IV | glockenspiel skip up to the octave; flute in a fight |
| Rail Yard | Freight Boogie | 126 shuffle, A mixolydian | I-bVII-IV-I | clean-guitar blues lick with a flat seventh; harmonica in a fight |
| Summit | Whiteout | 128, B minor | i-VI-III-VII | chime fanfare from the low fifth; French horn in a fight; half-time tom drop |
| Embassy | Gala Night | 116, F major | ii-V-I-vi (sevenths) | piano disco stab figure; muted trumpet in a fight; string runs |
| Airbase | Scramble | 150, C major (A minor) | vi-IV-I-V | trumpet anthem up the triad; synth brass in a fight; half-time 808 drop |
| Wasteland | Dust Devil | 96, E minor | i-VI-VII-V | long whistle call falling from the fifth; slide guitar in calm; cowbell counter |
| Range | Practice Lane | 84 swung, E-flat major | IV-V-iii-vi (sevenths) | Rhodes lo-fi sigh; nylon guitar in a fight |
| Outpost (day) | Bastion | 112, G major | I-vi-IV-V | marimba bounce; harp in a fight |
| Outpost (night) | Horde Night | 108, G minor | i-iv-VI-V | bell figure through the raised seventh; organ in a fight; heartbeat |
