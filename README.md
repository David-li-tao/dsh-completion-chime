# dsh-completion-chime

A DeepSeek Harness plugin: when one of **your** turns finishes, it rings a short
chime and pops a small card in the top-right corner with the duration, the turn
number and the opening line of the reply. Subagent turns and turns you cancelled
yourself stay silent.

- The card counts down **only while the window is visible and focused** — walk
  away, and it is still there when you come back.
- Rings rotate at random and never repeat back to back.
- Rings are yours: drop any `.wav` into a folder and pick it with a command.
- Nothing is written to the session log; the card is served over one read-only
  local HTTP route.

## Install

From a checkout (the Host side, the Web card, locales and the bundled tones all
live in this package):

```
plugin_manager install_bundle <absolute path to this package>
```

For a published tarball, install it the same way by package spec. After install
the row appears in **Settings → Plugins** as *Completion chime*.

## Bring your own ring

1. `/chime dir` — prints the folder (`~/.dsh/completion-chime/sounds/`).
2. Drop a **44.1 kHz 16-bit WAV** there. Anything else must be converted first:

   ```
   ffmpeg -i song.mp3 -ar 44100 -ac 1 -c:a pcm_s16le song.wav
   ```

3. `/chime list` — it shows up as `mine` with an index.
4. `/chime use 1 3` — rotate through those two (saved).

A file you drop wins over a bundled tone with the same name, and reinstalling
the plugin never touches that folder.

## Commands

| Command | What it does |
|---|---|
| `/chime` | Plays one at random, tells you which |
| `/chime list` | Every available ring: `mine` / `bundled` / `windows`, `●` = rotating |
| `/chime use 2 5` | Rotate only these (name or index); saved |
| `/chime volume 0.3` | Level, `0`–`1`; saved |
| `/chime off` / `/chime on` | Mute/unmute the ring; the card stays |
| `/chime dir` | Print the folder for your own rings |
| `/notice` | Preview the card without waiting for a turn |

Preferences are written to `~/.dsh/completion-chime/config.json`, next to your
rings — not into the plugin, so updates keep them.

## Configuration

The row accepts an optional `config` block in your profile patch; anything you
set there wins over the defaults:

| Field | Default | Meaning |
|---|---|---|
| `soundName` | `['complete','soft','rise']` | Ring or list of rings, rotated at random |
| `volume` | `0.4` | Level, `0`–`1` (samples are scaled: the system player has no volume knob) |
| `popup` | `true` | Show the card |
| `sound` | `true` | Play the ring |
| `onError` | `true` | Also notify when a turn dies with an error |
| `onBlocked` | `false` | Also notify when a turn is blocked |
| `coalesceMs` | `800` | Collapse endings this close together |
| `excerptChars` | `90` | Characters of the reply on the card; `0` hides it |
| `file` | `''` | Absolute WAV path; wins over `soundName` |

```yaml
- id: completion-chime
  name: dsh-completion-chime
  config:
    soundName: ['complete', 'soft']
    volume: 0.35
```

## Platform notes

- **Windows** — playback spawns a hidden `WindowsPowerShell` process. Two
  details cost real debugging time: `stdio: 'ignore'` hands PowerShell invalid
  handles and it exits in ~200 ms doing nothing, and `detached: true` does the
  same in ~125 ms. The working shape is pipes plus no detach. Startup costs
  roughly 0.5–1 s, so the ring lands just after the card.
- **macOS / Linux** — `afplay` / `paplay`. The volume setting is not applied
  there yet; the files play at their recorded level.
- The card is part of the Web UI and needs the Web transport.

## Known limitations

- Rings must be WAV. The browser half could decode anything, but that upload
  path is not implemented.
- The local feed route is unauthenticated: anything running as you on this
  machine can read the folder name and the reply excerpt it carries.
- Scaled copies of a ring are cached per volume level under `%TEMP%`, one folder
  per 1% step; they are not cleaned up automatically.

## Layout

```
index.js        Host half: turn/end listener, ring buffer, feed route, commands
chime.js        Ring resolution (user → bundled → system), volume scaling, playback
client.js       Web half: polls the feed, renders the card in shell.overlay
assets/         Bundled CC0 tones (synthesised, ~1 s)
locale/         Plugin metadata for the plugin list
docs/           Feature image for the bundle detail page
```

## License

Code: MIT (see `LICENSE`). Bundled tones: CC0. No third-party recordings are
included; rings you add are yours to license.