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
| `/notice 构建完成，用时 3 分` | Preview the card with your own body text |

Preferences are written to `~/.dsh/completion-chime/config.json`, next to your
rings — not into the plugin, so updates keep them.

## Card skins

Two skins ship, and each notice picks one at random — never the same one twice
in a row:

- **ink** — rice paper: warm gradient, faint fibre noise, one vermilion seal
  stamped with 成 / 误 / 待 / 断 / 止, serif headline, generous leading.
- **taiji** — one monochrome card with a yin-yang mark. An error flips it inside
  out: dark ground, light ink.

Set `cardStyles: ['ink']` (or `['taiji']`) to pin a single skin; unknown names
fall back to `ink`.

## Let an agent raise the notice

The plugin registers a global tool named **`notify`**, so *any* agent — your
own conversation, a subagent, a scheduled session, another preset — can ask for
the user's attention on purpose instead of waiting for a turn to end:

```jsonc
notify({
  "title": "导出完成",              // short headline, defaults to 「任务完成」
  "text": "128 个文件已导出到默认工作区。", // one or two sentences
  "kind": "done",                 // "done" = green rail, "error" = red
  "sound": "home",                // optional; omit to use the user's rotation
  "ring": true                    // optional; false = card only
})
```

The call returns `{ shown, sound }`. The card lands in the same place as a
turn-end notice, and the ring respects the user's mute/volume settings.

Guidance encoded in the tool description (which is what other models read):
call it when the user genuinely needs to come back — a long job finished, a
background task settled, an external event needs a decision. Never as a
substitute for replying, and never when the user just interrupted you.

Turn-end notices are still filtered to your own conversation by default. Set
`includeSubagents: true` to be told about subagent turns too.

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
| `includeSubagents` | `false` | Also notify for subagent turns |
| `agentTool` | `true` | Register the `notify` tool for every agent |
| `coalesceMs` | `800` | Collapse endings this close together |
| `cardStyles` | `['ink','taiji']` | Card skins, one picked per notice, never the same twice in a row |
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