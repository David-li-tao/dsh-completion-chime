/**
 * System-sound playback for the completion chime.
 *
 * Deliberately dumb: spawn the platform player, detach it, forget it. A sound
 * that fails to play must never disturb the agent loop, so every path swallows
 * its own errors instead of reporting them upward.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const MAC_DEFAULT = '/System/Library/Sounds/Glass.aiff'
const LINUX_DEFAULT = '/usr/share/sounds/freedesktop/stereo/complete.oga'

/**
 * Where a user drops their own rings. Kept outside the package on purpose: the
 * source tree then ships clean (no third-party recordings) while a running
 * install still has whatever the user added, and reinstalling the bundle never
 * touches it.
 */
export const DATA_DIR = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'completion-chime')
export const SOUNDS_DIR = join(DATA_DIR, 'sounds')

const isWindows = process.platform === 'win32'

function spawnDetached(command, args) {
  try {
    const child = spawn(command, args, {
      // Not `'ignore'`: on Windows that hands the child invalid std handles, and
      // PowerShell 5.1 then exits within ~200ms with code 0 without running the
      // command at all — a silent no-op. Pipes keep the handles real; the
      // player prints nothing, so both streams are drained and dropped.
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // Also not `detached` on Windows: DETACHED_PROCESS leaves the console-less
      // PowerShell exiting in ~125ms without running anything (measured here).
      // `unref` alone is enough for the player to outlive this process.
      detached: !isWindows,
    })
    child.stdout?.on('data', () => {})
    child.stderr?.on('data', () => {})
    child.on('error', () => {})
    child.unref()
  } catch {
    // Missing player, locked file, no audio device: nothing to report.
  }
}

/** PowerShell single-quoted literal. */
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function windowsMediaPath(name) {
  const file = name.endsWith('.wav') ? name : `${name}.wav`
  return join(process.env.windir ?? 'C:\\Windows', 'Media', file)
}

/**
 * The tone this plugin ships with. It is deliberately not a Windows system
 * sound: `chord` is a hard four-note stab, `chimes` is too quiet to notice, and
 * `tada` outstays its welcome. `complete.wav` is two soft bell notes a fifth
 * apart, about a second long.
 */
function bundledTone(name) {
  if (!name) return null
  const file = fileURLToPath(new URL(`./assets/${name}.wav`, import.meta.url))
  return existsSync(file) ? file : null
}

/** A ring the user dropped into `SOUNDS_DIR`; wins over a bundled tone of the same name. */
export function userTone(name) {
  if (!name) return null
  const file = join(SOUNDS_DIR, name.endsWith('.wav') ? name : `${name}.wav`)
  return existsSync(file) ? file : null
}

/**
 * `SoundPlayer` has no volume knob, so the level has to live in the samples.
 * Scaled copies are cached per level under `%TEMP%`; once written, a play only
 * costs a `stat`, and changing the level just writes a new directory.
 */
function scaledCopy(file, volume) {
  const level = Math.round(volume * 100)
  const dir = join(tmpdir(), 'dsh-completion-chime', `v${level}`)
  const target = join(dir, basename(file))
  try {
    if (existsSync(target) && statSync(target).mtimeMs >= statSync(file).mtimeMs) return target
    mkdirSync(dir, { recursive: true })
    const buffer = readFileSync(file)
    if (buffer.toString('ascii', 0, 4) !== 'RIFF') return file
    // Walk the chunks instead of assuming a 44-byte header: `data` is not always
    // the first chunk after `fmt `.
    let at = 12
    let start = -1
    let size = 0
    while (at + 8 <= buffer.length) {
      const id = buffer.toString('ascii', at, at + 4)
      const length = buffer.readUInt32LE(at + 4)
      if (id === 'data') {
        start = at + 8
        size = Math.min(length, buffer.length - start)
        break
      }
      at += 8 + length + (length % 2)
    }
    if (start < 0) return file
    const scale = level / 100
    for (let i = start; i + 1 < start + size; i += 2) {
      const sample = Math.round(buffer.readInt16LE(i) * scale)
      buffer.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i)
    }
    writeFileSync(target, buffer)
    return target
  } catch {
    return file
  }
}

function playOnWindows(options) {
  const source =
    options.file ||
    userTone(options.sound) ||
    bundledTone(options.sound) ||
    windowsMediaPath(options.sound || 'complete')
  const volume = typeof options.volume === 'number' ? Math.max(0, Math.min(1, options.volume)) : 1
  const file =
    volume < 1 && existsSync(source) && source.toLowerCase().endsWith('.wav')
      ? scaledCopy(source, volume)
      : source
  const powershell = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  )
  // PlaySync blocks until the sound has finished, so the child process does not
  // cut the audio off by exiting early. Without a usable wav, fall back to the
  // motherboard beeper (silent on machines that have none, never an error).
  const script = existsSync(file)
    ? `(New-Object System.Media.SoundPlayer ${psQuote(file)}).PlaySync()`
    : '[console]::beep(880,200)'
  spawnDetached(powershell, [
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle',
    'Hidden',
    '-Command',
    script,
  ])
}

export function playChime(options = {}) {
  if (process.platform === 'win32') {
    playOnWindows(options)
    return
  }
  const mac = process.platform === 'darwin'
  const file = options.file || (mac ? MAC_DEFAULT : LINUX_DEFAULT)
  if (!existsSync(file)) return
  spawnDetached(mac ? 'afplay' : 'paplay', [file])
}