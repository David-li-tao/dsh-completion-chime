/**
 * Completion notice — shows a card in the Web UI whenever one of your own turns
 * finishes, so a long task can be left running in the background.
 *
 * The framework drives the decision: every finished turn commits a durable
 * `turn/end` session event. The listener below decides whether that ending is
 * worth interrupting you, enriches it with what the turn did (how long it ran,
 * the opening line of the reply), and keeps a tiny ring buffer that the Client
 * half reads over one read-only feed route. Nothing is written to the log.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DATA_DIR, SOUNDS_DIR, playChime, userTone } from './chime.js'

/** Per-install preferences written by the `/chime` commands, kept out of the package. */
const PREFS_FILE = join(DATA_DIR, 'config.json')

/** Windows Media names that make a passable notification. */
const SYSTEM_RINGS = ['notify', 'chimes', 'ding', 'tada', 'chord']

/** The path the Client half polls. One exact route, read-only, no auth state. */
const FEED_PATH = '/completion-notice/feed'

/** How many notices the feed keeps. A Client that was away still gets the recent ones. */
const MAX_KEPT = 20

const DEFAULTS = {
  enabled: true,
  /** Show the floating card. */
  popup: true,
  /** Ring a short system sound together with the card: you hear it first, the card waits for you. */
  sound: true,
  /**
   * One tone, or a list rotated at random (never the same one twice in a row).
   * A name resolves against the user's sounds folder first, then the bundled
   * tones, then the Windows Media folder; an absolute `.wav` path always wins.
   */
  soundName: ['complete', 'soft', 'rise'],
  /** Absolute audio file; wins over `soundName`. */
  file: '',
  /** Playback level, 0–1. Samples are scaled, since the system player has no volume. */
  volume: 0.4,
  /** Notify when a turn dies with a model or tool error. */
  onError: true,
  /** Notify when a turn is blocked (for example by a refused approval). */
  onBlocked: false,
  /** Also notify for subagent turns, not just your own conversation. */
  includeSubagents: false,
  /** Expose the `notify` tool so any agent can raise a notice on purpose. */
  agentTool: true,
  /** Collapse several turns ending this close together into one notice, ms. */
  coalesceMs: 800,
  /** Card skins; one is picked per notice, never the same twice in a row. */
  cardStyles: ['ink', 'taiji'],
  /** Characters of the reply carried into the card; 0 turns the excerpt off. */
  excerptChars: 90,
}

/** The user stopped these himself, so there is nothing to come back for. */
const SILENT_REASONS = new Set(['aborted', 'interrupted', 'forked'])

/** Last sound played, so a random pick never repeats back to back. */
let lastSound = ''

/** Last card skin used, for the same reason. */
let lastStyle = ''

/** Pick one card skin, never the same one twice in a row. */
function pickStyle(styles) {
  const list = Array.isArray(styles) ? styles.filter((name) => typeof name === 'string' && name) : []
  if (list.length === 0) return 'ink'
  if (list.length === 1) return list[0]
  const pool = list.filter((name) => name !== lastStyle)
  const choice = pool[Math.floor(Math.random() * pool.length)] ?? list[0]
  lastStyle = choice
  return choice
}

/**
 * `soundName` may be one name or a list. With a list the chime rotates at
 * random, and never plays the same file twice in a row.
 */
function pickSound(soundName) {
  const list = Array.isArray(soundName)
    ? soundName.filter((name) => typeof name === 'string' && name)
    : typeof soundName === 'string' && soundName
      ? [soundName]
      : []
  if (list.length === 0) return ''
  if (list.length === 1) return list[0]
  const pool = list.filter((name) => name !== lastSound)
  const choice = pool[Math.floor(Math.random() * pool.length)] ?? list[0]
  lastSound = choice
  return choice
}

function normalize(config) {
  const options = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) }
  // 1.0 took `sound` as the sound *name*. Keep an old row working instead of
  // silently turning a string into a truthy boolean.
  if (typeof options.sound === 'string') {
    options.soundName = options.sound || DEFAULTS.soundName
    options.sound = true
  }
  return options
}

/** Preferences written by `/chime …`, merged over the defaults but under the row config. */
function readPrefs() {
  try {
    const raw = JSON.parse(readFileSync(PREFS_FILE, 'utf8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

function writePrefs(patch) {
  const next = { ...readPrefs(), ...patch }
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(PREFS_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  } catch {
    // A read-only profile still lets this run change its own session.
  }
  return next
}

/** Everything `soundName` can point at, in precedence order. */
function listRings() {
  const rings = []
  const push = (name, source) => {
    if (!rings.some((ring) => ring.name === name)) rings.push({ name, source })
  }
  try {
    for (const entry of readdirSync(SOUNDS_DIR)) {
      if (entry.toLowerCase().endsWith('.wav')) push(entry.slice(0, -4), 'mine')
    }
  } catch {
    // The folder appears the first time someone drops a file or runs a command.
  }
  try {
    for (const entry of readdirSync(fileURLToPath(new URL('./assets/', import.meta.url)))) {
      if (entry.toLowerCase().endsWith('.wav')) push(entry.slice(0, -4), 'bundled')
    }
  } catch {
    // A bundle without tones still works with the system sounds.
  }
  for (const name of SYSTEM_RINGS) push(name, 'windows')
  return rings
}

/** First line of an assistant message, flattened and cut to a card-sized excerpt. */
function replyExcerpt(message, limit) {
  if (limit <= 0) return ''
  const blocks = Array.isArray(message?.content) ? message.content : []
  for (const block of blocks) {
    if (!block || block.type !== 'text' || typeof block.text !== 'string') continue
    const flat = block.text
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[#>*`_]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!flat) continue
    if (flat.length <= limit) return flat
    return flat.slice(0, limit).trimEnd() + '…'
  }
  return ''
}

export function apply(ctx, config) {
  const options = normalize({ ...readPrefs(), ...(config && typeof config === 'object' ? config : {}) })
  if (options.enabled === false) return
  // Sound fields can change at runtime through `/chime`; the rest is fixed at apply.
  const state = { sound: options.sound, soundName: options.soundName, volume: options.volume, file: options.file }

  /** Ring buffer of notices; `id` is a monotonic cursor the Client polls with. */
  const notices = []
  // Seeded from the clock so the sequence keeps rising across a plugin restart:
  // a Client that remembered a larger cursor would otherwise never see a notice
  // again (`id > since` would stay false for the fresh 1, 2, 3…).
  let cursor = Date.now()
  let lastNotifiedAt = 0
  /** Live per-session scratch, dropped again when that session's turn ends. */
  const turnStartedAt = new Map()
  const lastReply = new Map()

  function remember(kind, session, event, extra) {
    const cwd = typeof session?.header?.cwd === 'string' ? session.header.cwd : ''
    const notice = {
      id: ++cursor,
      kind,
      at: Date.now(),
      folder: cwd ? basename(cwd) : '',
      turn: typeof event?.data?.turn === 'number' ? event.data.turn : 0,
      durationMs: extra?.durationMs ?? 0,
      excerpt: extra?.excerpt ?? '',
      title: extra?.title ?? '',
      style: extra?.style || pickStyle(options.cardStyles),
    }
    notices.push(notice)
    if (notices.length > MAX_KEPT) notices.splice(0, notices.length - MAX_KEPT)
    return notice
  }

  function ring() {
    if (state.sound) playChime({ sound: pickSound(state.soundName), file: state.file, volume: state.volume })
    return state.sound ? 'on' : 'off'
  }

  function notify(kind, session, event, extra) {
    if (options.popup) remember(kind, session, event, extra)
    ring()
  }

  /**
   * A notice raised on purpose — by the `notify` tool or by `/notice` — rather
   * than by a turn ending. Returns the ring that was used, or '' when silent.
   */
  function raise({ kind = 'completed', title = '', text = '', sound = '', ring: shouldRing = true } = {}) {
    if (options.popup) remember(kind, undefined, undefined, { title, excerpt: text })
    if (!shouldRing || !state.sound) return ''
    const named = sound && listRings().some((entry) => entry.name === sound) ? sound : pickSound(state.soundName)
    playChime({ sound: named, file: state.file, volume: state.volume })
    return named
  }

  ctx.on('session/event', (session, event) => {
    // Delegated children end turns constantly; only the user's own conversation
    // is worth an interruption unless the profile asks for every session.
    if (session.header.origin === 'subagent' && !options.includeSubagents) return
    const type = event?.type

    if (type === 'turn/start') {
      turnStartedAt.set(session.id, typeof event.time === 'number' ? event.time : Date.now())
      return
    }
    if (type === 'assistant/message') {
      const text = replyExcerpt(event.data?.message, options.excerptChars)
      if (text) lastReply.set(session.id, text)
      return
    }
    if (type !== 'turn/end') return

    const kind = event.data?.reason?.kind
    const startedAt = turnStartedAt.get(session.id)
    const excerpt = lastReply.get(session.id) || ''
    turnStartedAt.delete(session.id)
    lastReply.delete(session.id)

    if (SILENT_REASONS.has(kind)) return
    if (kind === 'error' && !options.onError) return
    if (kind === 'blocked' && !options.onBlocked) return
    const now = Date.now()
    if (now - lastNotifiedAt < options.coalesceMs) return
    lastNotifiedAt = now
    notify(kind, session, event, {
      durationMs: typeof startedAt === 'number' ? Math.max(0, now - startedAt) : 0,
      excerpt,
    })
  })

  // Any Agent may raise a notice on purpose — a long job it started, an event
  // it was watching. Registered globally, so subagents and scheduled sessions
  // get it too, not only the user's own conversation.
  if (options.agentTool) {
    ctx.inject(['tools'], (toolCtx) => {
      const tools = toolCtx.get('tools')
      toolCtx.effect(() =>
        tools.register({
          name: 'notify',
          description:
            '向用户发一条完成提示：右上角弹出卡片，并按用户当前设置响一声。用在你确实需要用户回来看一眼的时候——长任务收尾、后台作业完成、需要用户决策的外部事件。普通对话回复不要调用，用户主动打断你时也不要调用。卡片内容用户会直接看到，写清楚「完成了什么」即可，不要复述整篇回答。',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              title: { type: 'string', description: '卡片标题，短一些，例如「导出完成」。省略则显示「任务完成」。' },
              text: { type: 'string', description: '卡片正文，一两句话。省略则不显示正文。' },
              kind: { type: 'string', enum: ['done', 'error'], description: 'done = 绿条（默认），error = 红条。' },
              sound: { type: 'string', description: '指定铃声名（`/chime list` 可查）。省略则按用户当前轮换随机。' },
              ring: { type: 'boolean', description: '是否响铃，默认 true。用户关掉提示音时不会响。' },
            },
          },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: { shown: { type: 'boolean' }, sound: { type: 'string' } },
            },
            render: (_args, value) => [
              {
                type: 'text',
                text: value?.shown
                  ? `已弹出提示卡片${value.sound ? `，铃声 ${value.sound}` : '（未响铃）'}。不要向用户复述这张卡片。`
                  : '用户关闭了提示卡片；本次未显示。',
              },
            ],
          },
          execute: async (args) => {
            const input = args && typeof args === 'object' ? args : {}
            const sound = raise({
              kind: input.kind === 'error' ? 'error' : 'completed',
              title: typeof input.title === 'string' ? input.title : '',
              text: typeof input.text === 'string' ? input.text : '',
              sound: typeof input.sound === 'string' ? input.sound : '',
              ring: input.ring !== false,
            })
            return { shown: options.popup !== false, sound }
          },
          isConcurrencySafe: () => true,
        }),
      )
    })
  }

  // The Client half holds no session state: it asks for notices newer than the
  // last cursor it saw. A first request without `since` only learns the cursor,
  // so reloading the page never replays history.
  // The web server (and the command registry) may not exist yet when a bundle
  // is applied at startup — asking `ctx.get` once loses them silently. This
  // waits for the service, so a cold start and a hot reload behave the same.
  ctx.inject(['webServer'], (webCtx) => {
    const web = webCtx.get('webServer')
    webCtx.effect(() =>
      web.register({
        kind: 'exact',
        path: FEED_PATH,
        handler: (req, res) => {
          let since = null
          try {
            const raw = new URL(req.url ?? FEED_PATH, 'http://localhost').searchParams.get('since')
            const parsed = raw === null ? Number.NaN : Number(raw)
            if (Number.isFinite(parsed)) since = parsed
          } catch {
            since = null
          }
          const items = since === null ? [] : notices.filter((notice) => notice.id > since)
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(JSON.stringify({ cursor, items }))
        },
      }),
    )
  })

  // `/notice` pops a card on demand, which makes the Client half verifiable
  // without waiting for a real turn to end. `/chime` still previews the sound.
  ctx.inject(['commands'], (cmdCtx) => {
    const commands = cmdCtx.get('commands')
    cmdCtx.effect(() =>
      commands.register({
        name: 'notice',
        description: '弹出一个提示小窗（试看）。可带正文：/notice 导出完成了，共 128 个文件',
        handler: (invocation) => {
          const raw = typeof invocation?.rawInput === 'string' ? invocation.rawInput.trim() : ''
          const text = raw || '这是一张试用卡片：任务结束时它会带着用时、轮次和最后一句话出现。'
          const sound = raise({ kind: 'completed', text })
          return {
            kind: 'success',
            text: options.popup ? `小窗已弹出${sound ? `（${sound}）` : ''}` : '弹窗已关闭（config.popup = false）',
          }
        },
      }),
    )
    cmdCtx.effect(() =>
      commands.register({
        name: 'chime',
        description: '完成提示音：直接发 = 试听；list 看全部；use 名字/序号；volume 0-1；off / on；dir 看自定义目录',
        handler: (invocation) => {
          const raw = typeof invocation?.rawInput === 'string' ? invocation.rawInput.trim() : ''
          const parts = raw.replace(/,/g, ' ').split(/\s+/).filter(Boolean)
          const verb = parts[0]
          const args = parts.slice(1)

          if (!verb) {
            const sound = pickSound(state.soundName)
            playChime({ sound, file: state.file, volume: state.volume })
            return { kind: 'success', text: `🔔 ${sound || '提示音'}（音量 ${state.volume}）` }
          }
          if (verb === 'list') {
            const rings = listRings()
            const active = new Set(Array.isArray(state.soundName) ? state.soundName : [state.soundName])
            const rows = rings.map((ring, index) => `${active.has(ring.name) ? '●' : '·'} ${index + 1}. ${ring.name}  ${ring.source}`)
            return {
              kind: 'success',
              text: `铃声（● 正在轮换，共 ${rings.length} 个；轮换 ${active.size} 个）\n${rows.join('\n')}`,
            }
          }
          if (verb === 'dir') {
            return { kind: 'success', text: `把 wav 丢进这里：${SOUNDS_DIR}` }
          }
          if (verb === 'use') {
            const rings = listRings()
            const picked = args
              .map((token) => (/^\d+$/.test(token) ? rings[Number(token) - 1]?.name : token.replace(/\.wav$/i, '')))
              .filter(Boolean)
            if (picked.length === 0) {
              return { kind: 'error', text: '用法：/chime use home shiqi 或 /chime use 1 4（先 /chime list 看序号）' }
            }
            const known = new Set(rings.map((ring) => ring.name))
            const missing = picked.filter((name) => !known.has(name))
            if (missing.length > 0) {
              return { kind: 'error', text: `没有这些铃声：${missing.join(', ')}。wav 放到 ${SOUNDS_DIR} 后重试。` }
            }
            writePrefs({ soundName: picked })
            state.soundName = picked
            const sound = pickSound(picked)
            playChime({ sound, file: state.file, volume: state.volume })
            return { kind: 'success', text: `轮换改为 ${picked.join(' / ')}（已保存，现在放一个：${sound}）` }
          }
          if (verb === 'volume') {
            const value = Number(args[0])
            if (!Number.isFinite(value)) return { kind: 'error', text: '用法：/chime volume 0.4（0 静音，1 原声）' }
            const clamped = Math.min(1, Math.max(0, value))
            writePrefs({ volume: clamped })
            state.volume = clamped
            playChime({ sound: pickSound(state.soundName), file: state.file, volume: clamped })
            return { kind: 'success', text: `音量 ${clamped}（已保存）` }
          }
          if (verb === 'off' || verb === 'on') {
            const on = verb === 'on'
            writePrefs({ sound: on })
            state.sound = on
            if (on) playChime({ sound: pickSound(state.soundName), file: state.file, volume: state.volume })
            return { kind: 'success', text: on ? '提示音已打开' : '提示音已关闭（卡片照常）' }
          }
          return { kind: 'error', text: `不认识的参数：${verb}。可用：list / use / volume / off / on / dir` }
        },
      }),
    )
  })
}
