# Audio credits

Background music for the Tillwick sim (the 🎵 song-cycler button in the renderer; see
`../../music.js`). The button steps a ring: off → track 1 → … → track 10 → off.

**All ten tracks are CC0 / public-domain** — free to use, modify, loop, and redistribute,
with **no attribution legally required**. They're committed to the repo. Courtesy credits
below as good hygiene.

| # | File | Track | Artist | Source | License |
|---|---|---|---|---|---|
| 1 | `town-theme.mp3` | Town Theme RPG | cynicmusic (Pixelsphere) | https://opengameart.org/content/town-theme-rpg | CC0 |
| 2 | `city-loop.mp3` | City Loop | wipics | https://opengameart.org/content/city-loop-0 | CC0 |
| 3 | `happy-wireframes.mp3` | Happy Wireframes | Bobjt | https://opengameart.org/content/happy-wireframes | CC0 |
| 4 | `upbeat-chiptune.mp3` | Upbeat Chiptune Theme | nihilocrat | https://opengameart.org/content/upbeat-chiptune-theme | CC0 |
| 5 | `loop-town.mp3` | Loop Town | Fupi | https://opengameart.org/content/loop-town | CC0 |
| 6 | `happy-adventure.mp3` | Happy Adventure | TinyWorlds | https://opengameart.org/content/happy-adventure-loop | CC0 |
| 7 | `fort-fairy.mp3` | Fort Fairy | iamoneabe | https://opengameart.org/content/fort-fairy | CC0 |
| 8 | `quaint-town.mp3` | Quaint Town (LOOPABLE) | neonarkade | https://opengameart.org/content/quaint-town | CC0 |
| 9 | `flowerbed-fields.mp3` | Flowerbed Fields | Zane Little Music | https://opengameart.org/content/flowerbed-fields-loop | CC0 |
| 10 | `puppy-garden.mp3` | Puppy Playing in The Garden | Spring Spring | https://opengameart.org/content/puppy-playing-in-the-garden | CC0 |

Courtesy credit for Town Theme RPG (optional): `cynicmusic.com pixelsphere.org`.

Each source page was re-checked on 2026-10-05: author as listed above, licence CC0 on every page.

## Notes
- 10 tracks for variety per operator request — cozy + cute NES/chiptune (Zelda / Stardew /
  Shovel Knight charm). Tracks 6–10 added in the expansion-to-10 pass.
- **All normalized to 192 kbps stereo MP3 + loudness-normalized** (ffmpeg `loudnorm`,
  target −16 LUFS / −1.5 dBTP). This (a) gives one uniform `audio/mpeg` content-type — no
  per-codec serving risk, (b) keeps every track at consistent perceived loudness so none
  seems "not to play" from being too quiet, (c) the two former `.ogg` sources
  (Upbeat Chiptune, Loop Town) are now MP3.
- **Every track passes the no-ears bar**: ffprobe valid stream + duration > 20s (46–160s);
  ffmpeg `volumedetect` non-silent (mean −14 to −19 dB); served from :4042 as
  `audio/mpeg` 200 with matching content-length; and the renderer's `audio.src` steps
  through all 10 distinct files on click (verified live).
- More CC0 candidates + full shortlist + licenses:
  a music shortlist kept with the design notes (not included).
