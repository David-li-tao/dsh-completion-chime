/**
 * Completion notice — a small card that slides into the frame's top-right
 * corner when one of your turns finishes.
 *
 * It owns no session state. The Host half keeps the notices and exposes one
 * read-only feed route; this module polls it with a cursor and renders.
 */
window.__ModuleLoader__.load({
  id: 'dsh-completion-chime',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    /** Must match the Host half's route. */
    const FEED = '/completion-notice/feed'
    const POLL_MS = 1200
    /** When the Host half is not serving the feed, back off instead of hammering. */
    const IDLE_POLL_MS = 15000
    /**
     * How long the card stays once you are actually looking at the window. It
     * only counts down while this page is visible AND focused: a card that
     * arrives while you are in another app waits for you instead of expiring in
     * a corner nobody is watching.
     */
    const LINGER_MS = 12000
    /** Matches the exit animation so a dismissing card is fully gone when removed. */
    const EXIT_MS = 160
    const MAX_VISIBLE = 3

    const COPY = {
      zh: {
        completed: '任务完成',
        'max-tokens': '输出被截断',
        blocked: '等你确认',
        error: '任务出错',
        unknown: '这一轮结束',
        close: '关闭提示',
        turn: (n) => `第 ${n} 轮`,
        sec: '秒',
        min: '分',
        hour: '小时',
      },
      en: {
        completed: 'Task finished',
        'max-tokens': 'Output truncated',
        blocked: 'Waiting for you',
        error: 'Task failed',
        unknown: 'Turn ended',
        close: 'Dismiss',
        turn: (n) => `Turn ${n}`,
        sec: 's',
        min: 'm',
        hour: 'h',
      },
    }

    /**
     * One accent per ending. The tone only picks a color: the text always comes
     * from COPY so the card stays translatable.
     */
    const TONE = {
      completed: 'success',
      'max-tokens': 'warn',
      blocked: 'warn',
      error: 'error',
      unknown: 'idle',
    }

    /** One character per ending, stamped like a seal on the ink card. */
    const SEAL = {
      completed: '成',
      error: '误',
      blocked: '待',
      'max-tokens': '断',
      unknown: '止',
    }

    const STYLE = [
      '.dsh-cn-stack{position:fixed;top:52px;right:18px;z-index:60;display:flex;flex-direction:column;',
      'gap:9px;width:336px;max-width:calc(100vw - 36px);pointer-events:none;font-family:inherit}',
      '.dsh-cn-card{pointer-events:auto;position:relative;box-sizing:border-box;display:flex;align-items:flex-start;',
      'padding:14px 15px 15px;border-radius:14px;',
      // The theme's surface tokens are alpha layers meant to sit on a page, so a
      // single one leaves the transcript showing through the card. Stack the same
      // layer three times (each pass raises opacity) and frost what is left.
      'background-color:var(--dsw-alias-bg-overlay,rgba(24,24,27,.9));',
      'background-image:linear-gradient(var(--dsw-alias-bg-overlay,rgba(0,0,0,0)),var(--dsw-alias-bg-overlay,rgba(0,0,0,0))),',
      'linear-gradient(var(--dsw-alias-bg-overlay,rgba(0,0,0,0)),var(--dsw-alias-bg-overlay,rgba(0,0,0,0)));',
      'backdrop-filter:blur(28px) saturate(1.15);-webkit-backdrop-filter:blur(28px) saturate(1.15);',
      // A hairline that is mostly an inner highlight: the edge should catch the
      // light, not draw a box.
      'box-shadow:0 1px 1px rgba(0,0,0,.10),0 2px 6px rgba(0,0,0,.10),',
      '0 20px 44px -18px rgba(0,0,0,.46),inset 0 0 0 1px rgba(255,255,255,.055),inset 0 1px 0 rgba(255,255,255,.07);',
      'color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.45;',
      'animation:dsh-cn-in .19s cubic-bezier(.2,.75,.3,1) both;',
      'transition:box-shadow .18s ease}',
      '.dsh-cn-card:hover{box-shadow:0 1px 1px rgba(0,0,0,.10),0 3px 8px rgba(0,0,0,.12),',
      '0 24px 52px -18px rgba(0,0,0,.52),inset 0 0 0 1px rgba(255,255,255,.075),inset 0 1px 0 rgba(255,255,255,.09)}',
      '.dsh-cn-body{flex:1 1 auto;min-width:0}',
      '.dsh-cn-head{display:flex;align-items:baseline;gap:8px;min-width:0}',
      // One 5px dot carries the outcome. A full-height colour bar reads as a
      // system banner; a dot reads as a considered detail.
      '.dsh-cn-dot{flex:none;width:5px;height:5px;border-radius:50%;margin-right:1px;',
      'background:var(--dsh-cn-accent,var(--dsw-alias-brand-primary));',
      'box-shadow:0 0 0 3px rgba(255,255,255,.035);transform:translateY(-2px)}',
      '.dsh-cn-title{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
      'font-weight:600;letter-spacing:.012em}',
      '.dsh-cn-meta{margin-left:auto;flex:0 1 auto;min-width:0;max-width:60%;text-align:right;',
      'color:var(--dsw-alias-label-tertiary);font-size:11px;letter-spacing:.01em;line-height:1.35;',
      'font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-cn-excerpt{margin-top:7px;color:var(--dsw-alias-label-secondary);font-size:12.5px;',
      'line-height:1.65;letter-spacing:.005em;opacity:.92;',
      'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}',
      '.dsh-cn-close{position:absolute;top:9px;right:9px;width:18px;height:18px;padding:0;border:0;border-radius:5px;',
      'background:transparent;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1;',
      'cursor:pointer;opacity:0;transition:opacity .15s ease,background .15s ease,color .15s ease}',
      '.dsh-cn-card:hover .dsh-cn-close,.dsh-cn-close:focus-visible{opacity:.85}',
      '.dsh-cn-close:hover{background:rgba(255,255,255,.08);color:var(--dsw-alias-label-primary);opacity:1}',
      '.dsh-cn-card[data-tone="success"]{--dsh-cn-accent:var(--dsw-alias-state-success-primary)}',
      '.dsh-cn-card[data-tone="warn"]{--dsh-cn-accent:var(--dsw-alias-state-warn-primary)}',
      '.dsh-cn-card[data-tone="error"]{--dsh-cn-accent:var(--dsw-alias-state-error-primary)}',
      '.dsh-cn-card[data-tone="idle"]{--dsh-cn-accent:var(--dsw-alias-state-idle-primary)}',
      // ── 水墨 ink card ───────────────────────────────────────────────────────
      // Rice paper, ink type and one vermilion seal. The paper is drawn rather
      // than tinted: a warm gradient, a faint fibre noise, and a hairline rule
      // under the headline. Serif is used only where it reads at this size.
      '.dsh-cn-seal{display:none}',
      '.dsh-cn-card.dsh-cn-ink{width:328px;padding:15px 16px 16px;border-radius:8px;',
      'background-color:#f5efe2;',
      'background-image:url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'160\' height=\'160\'><filter id=\'n\'><feTurbulence type=\'fractalNoise\' baseFrequency=\'0.9\' numOctaves=\'3\'/><feColorMatrix type=\'saturate\' values=\'0\'/></filter><rect width=\'160\' height=\'160\' filter=\'url(%23n)\' opacity=\'0.045\'/></svg>"),',
      'linear-gradient(158deg,#faf6ec,#f2e9d8 58%,#eadfcb);',
      'backdrop-filter:none;-webkit-backdrop-filter:none;',
      'box-shadow:inset 0 0 0 1px rgba(74,58,40,.10),inset 0 1px 0 rgba(255,255,255,.7),',
      '0 2px 5px rgba(52,38,22,.10),0 16px 38px -18px rgba(52,38,22,.44);',
      'color:#241f1a;animation:dsh-cn-in .26s cubic-bezier(.2,.75,.3,1) both}',
      '.dsh-cn-ink .dsh-cn-head{align-items:center;gap:9px;padding-bottom:9px;',
      'border-bottom:1px solid;border-image:linear-gradient(90deg,rgba(60,48,34,.26),rgba(60,48,34,.06) 58%,transparent) 1}',
      '.dsh-cn-ink .dsh-cn-dot{display:none}',
      '.dsh-cn-ink .dsh-cn-seal{display:flex;flex:none;align-items:center;justify-content:center;',
      'width:21px;height:21px;border-radius:3px;background:#a8382c;color:#f8f1e2;',
      'font-size:11.5px;line-height:1;font-family:"Songti SC","STSong","SimSun",serif;',
      'transform:rotate(-3deg);box-shadow:0 1px 2px rgba(90,40,30,.35),inset 0 0 0 1px rgba(255,236,214,.22)}',
      '.dsh-cn-ink .dsh-cn-title{font-family:"Songti SC","STSong","SimSun","Noto Serif SC",serif;',
      'font-size:14px;font-weight:600;letter-spacing:.05em;color:#211c17}',
      '.dsh-cn-ink .dsh-cn-meta{color:#8b7d6b;font-size:10.5px;letter-spacing:.03em}',
      '.dsh-cn-ink .dsh-cn-excerpt{margin-top:10px;color:#564d44;font-size:12.5px;line-height:1.8;opacity:1}',
      '.dsh-cn-ink .dsh-cn-close{top:7px;right:7px;color:#8b7d6b}',
      '.dsh-cn-ink .dsh-cn-close:hover{background:rgba(70,56,40,.10);color:#3a322a}',
      '.dsh-cn-ink[data-leaving="1"]{animation:dsh-cn-out .2s ease forwards}',
      // ── 太极 taiji: one monochrome card, and an error flips yin and yang ───
      '.dsh-cn-glyph{display:none}',
      // 阴 / 阳 in one card: ink masses blurred until they melt into the paper,
      // with a pale counter-lobe so the black and white read as intermingled
      // rather than as two halves. Text sits on the paper side of the wash.
      '.dsh-cn-card.dsh-cn-taiji{--dsh-cn-inkc:#0f0f11;--dsh-cn-paperc:#fbfaf6;',
      'width:330px;padding:14px 16px 15px;border-radius:10px;',
      'background-color:#f7f5ef;',
      // Scrim first: the ink is free to go as dark as it likes on the right and
      // bottom edges, while the column the text occupies stays paper.
      'background-image:linear-gradient(96deg,#f7f5ef 0%,#f7f5ef 50%,rgba(247,245,239,.62) 72%,rgba(247,245,239,0) 96%),',
      'url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'360\' height=\'200\' viewBox=\'0 0 360 200\'><defs><filter id=\'b\' x=\'-40%\' y=\'-40%\' width=\'180%\' height=\'180%\'><feGaussianBlur stdDeviation=\'26\'/></filter></defs><g filter=\'url(%23b)\'><ellipse cx=\'388\' cy=\'132\' rx=\'152\' ry=\'150\' fill=\'%230c0c0f\' opacity=\'0.64\'/><ellipse cx=\'290\' cy=\'238\' rx=\'118\' ry=\'96\' fill=\'%230c0c0f\' opacity=\'0.5\'/><ellipse cx=\'176\' cy=\'-22\' rx=\'76\' ry=\'42\' fill=\'%230c0c0f\' opacity=\'0.16\'/><ellipse cx=\'248\' cy=\'70\' rx=\'42\' ry=\'30\' fill=\'%23ffffff\' opacity=\'0.55\'/></g></svg>");',
      'background-repeat:no-repeat;background-size:100% 100%;',
      'color:var(--dsh-cn-inkc);',
      'backdrop-filter:none;-webkit-backdrop-filter:none;',
      'box-shadow:inset 0 0 0 1px rgba(0,0,0,.10),inset 0 1px 0 rgba(255,255,255,.9),',
      '0 2px 6px rgba(0,0,0,.10),0 18px 40px -18px rgba(0,0,0,.46);',
      'animation:dsh-cn-in .22s cubic-bezier(.2,.75,.3,1) both}',
      '.dsh-cn-taiji .dsh-cn-head{align-items:center;gap:9px;padding-bottom:9px;',
      'border-bottom:1px solid rgba(0,0,0,.10)}',
      '.dsh-cn-taiji .dsh-cn-dot{display:none}',
      '.dsh-cn-taiji .dsh-cn-glyph{display:flex;flex:none;width:20px;height:20px}',
      '.dsh-cn-taiji .dsh-cn-glyph svg{display:block;width:20px;height:20px}',
      '.dsh-cn-taiji .dsh-cn-title{font-size:13.5px;font-weight:600;letter-spacing:.02em;',
      'color:var(--dsh-cn-inkc)}',
      '.dsh-cn-taiji .dsh-cn-meta{color:#58585a;font-size:10.5px;letter-spacing:.02em}',
      '.dsh-cn-taiji .dsh-cn-excerpt{margin-top:9px;color:#3c3c3d;font-size:12.5px;line-height:1.65;opacity:1}',
      '.dsh-cn-taiji .dsh-cn-close{color:#8a8a8c}',
      '.dsh-cn-taiji .dsh-cn-close:hover{background:rgba(0,0,0,.07);color:#111}',
      // 阴面: an error turns the card inside out — same shapes, inverted ground.
      '.dsh-cn-card.dsh-cn-taiji[data-tone="error"]{--dsh-cn-inkc:#f3f1ec;--dsh-cn-paperc:#141416;',
      'background-color:#121214;',
      'background-image:radial-gradient(70% 95% at 16% 104%,rgba(255,255,255,.18),transparent 62%),',
      'radial-gradient(72% 92% at 88% -4%,rgba(255,255,255,.12),transparent 58%),',
      'radial-gradient(60% 80% at 52% 50%,rgba(255,255,255,.04),transparent 70%);',
      'box-shadow:inset 0 0 0 1px rgba(255,255,255,.12),inset 0 1px 0 rgba(255,255,255,.10),',
      '0 2px 6px rgba(0,0,0,.28),0 20px 44px -18px rgba(0,0,0,.66)}',
      '.dsh-cn-taiji[data-tone="error"] .dsh-cn-head{border-bottom-color:rgba(255,255,255,.12)}',
      '.dsh-cn-taiji[data-tone="error"] .dsh-cn-meta{color:#9a9a9c}',
      '.dsh-cn-taiji[data-tone="error"] .dsh-cn-excerpt{color:#cfcdc7}',
      '.dsh-cn-taiji[data-tone="error"] .dsh-cn-close{color:#8f8f91}',
      '.dsh-cn-taiji[data-tone="error"] .dsh-cn-close:hover{background:rgba(255,255,255,.10);color:#fff}',
      '.dsh-cn-taiji[data-leaving="1"]{animation:dsh-cn-out .18s ease forwards}',
      '.dsh-cn-card[data-leaving="1"]{animation:dsh-cn-out .16s ease forwards}',
      '@keyframes dsh-cn-in{from{opacity:0;transform:translate3d(0,-6px,0)}to{opacity:1;transform:none}}',
      '@keyframes dsh-cn-out{to{opacity:0;transform:translate3d(0,-4px,0)}}',
      '@media (prefers-reduced-motion:reduce){.dsh-cn-card{animation:none}}',
    ].join('')

    /** Card skins this half can draw; anything else falls back to ink. */
    const STYLES = {
      ink: 'dsh-cn-card dsh-cn-ink',
      taiji: 'dsh-cn-card dsh-cn-taiji',
    }

    /** Yin-yang mark for the taiji skin; colours come from CSS variables. */
    function taijiGlyph() {
      return h(
        'svg',
        { viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' },
        h('circle', { cx: 12, cy: 12, r: 10, fill: 'var(--dsh-cn-paperc)' }),
        h('path', { d: 'M12 2a10 10 0 0 0 0 20 5 5 0 0 0 0-10 5 5 0 0 1 0-10z', fill: 'var(--dsh-cn-inkc)' }),
        h('circle', { cx: 12, cy: 7, r: 2, fill: 'var(--dsh-cn-paperc)' }),
        h('circle', { cx: 12, cy: 17, r: 2, fill: 'var(--dsh-cn-inkc)' }),
        h('circle', {
          cx: 12,
          cy: 12,
          r: 9.4,
          fill: 'none',
          stroke: 'var(--dsh-cn-inkc)',
          strokeWidth: 1,
        }),
      )
    }

    function pickCopy(ctx) {
      let id = ''
      try {
        const snapshot = ctx.get('locale')?.getLocale?.()
        id = typeof snapshot?.id === 'string' ? snapshot.id : typeof snapshot?.locale === 'string' ? snapshot.locale : ''
      } catch {
        id = ''
      }
      return { copy: id.toLowerCase().startsWith('en') ? COPY.en : COPY.zh, locale: id || 'zh-CN' }
    }

    function timeLabel(at, locale) {
      try {
        return new Date(at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
      } catch {
        return ''
      }
    }

    /** Compact, locale-aware duration: `12 秒` / `4 分 12 秒` / `1 小时 5 分`. */
    function durationLabel(ms, copy) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 1000) return ''
      const total = Math.round(ms / 1000)
      if (total < 60) return `${total} ${copy.sec}`
      const minutes = Math.floor(total / 60)
      const seconds = total % 60
      if (minutes < 60) {
        return seconds ? `${minutes} ${copy.min} ${seconds} ${copy.sec}` : `${minutes} ${copy.min}`
      }
      const hours = Math.floor(minutes / 60)
      const rest = minutes % 60
      return rest ? `${hours} ${copy.hour} ${rest} ${copy.min}` : `${hours} ${copy.hour}`
    }

    function Notice({ item, copy, locale, onDismiss }) {
      // Two gates before the countdown may run. `visible` covers a minimized or
      // occluded window; `focused` covers "the app is on screen but I am typing
      // in another one". Either one closing keeps the card put.
      const [visible, setVisible] = useState(() => document.visibilityState === 'visible')
      const [focused, setFocused] = useState(() => {
        try {
          return document.hasFocus()
        } catch {
          return true
        }
      })

      useEffect(() => {
        function onVisibility() {
          setVisible(document.visibilityState === 'visible')
        }
        function onFocus() {
          setFocused(true)
        }
        function onBlur() {
          setFocused(false)
        }
        document.addEventListener('visibilitychange', onVisibility)
        window.addEventListener('focus', onFocus)
        window.addEventListener('blur', onBlur)
        return () => {
          document.removeEventListener('visibilitychange', onVisibility)
          window.removeEventListener('focus', onFocus)
          window.removeEventListener('blur', onBlur)
        }
      }, [])

      const armed = visible && focused

      // An exit that matches the entrance. React would otherwise yank the card
      // out on the frame the countdown ends, which is what makes a toast feel
      // cheap; hold it for EXIT_MS and let it fade.
      const [leaving, setLeaving] = useState(false)
      const leavingRef = useRef(false)
      const dismissRef = useRef(onDismiss)
      dismissRef.current = onDismiss
      const leave = useCallback(() => {
        if (leavingRef.current) return
        leavingRef.current = true
        setLeaving(true)
        window.setTimeout(() => dismissRef.current(), EXIT_MS)
      }, [])

      useEffect(() => {
        if (!armed) return undefined
        const timer = window.setTimeout(leave, LINGER_MS)
        return () => window.clearTimeout(timer)
      }, [armed, leave])

      const kind = Object.prototype.hasOwnProperty.call(TONE, item.kind) ? item.kind : 'unknown'
      const tone = TONE[kind]
      const duration = durationLabel(item.durationMs, copy)
      // Duration first (the number you actually want), folder last so it is the
      // piece that gives way when the line runs out of room.
      const meta = [
        duration,
        item.turn ? copy.turn(item.turn) : '',
        timeLabel(item.at, locale),
        item.folder,
      ]
        .filter(Boolean)
        .join(' · ')
      const excerpt = typeof item.excerpt === 'string' ? item.excerpt.trim() : ''

      return h(
        'div',
        {
          className: STYLES[item.style] || STYLES.ink,
          'data-tone': tone,
          'data-leaving': leaving ? '1' : undefined,
          role: 'status',
          'aria-live': 'polite',
        },
        h(
          'div',
          { className: 'dsh-cn-body' },
          h(
            'div',
            { className: 'dsh-cn-head' },
            h('span', { className: 'dsh-cn-dot', 'aria-hidden': 'true' }),
            h('span', { className: 'dsh-cn-seal', 'aria-hidden': 'true' }, SEAL[kind] || SEAL.unknown),
            h('span', { className: 'dsh-cn-glyph', 'aria-hidden': 'true' }, taijiGlyph()),
            h('div', { className: 'dsh-cn-title' }, item.title ? String(item.title) : copy[kind]),
            meta ? h('div', { className: 'dsh-cn-meta', title: meta }, meta) : null,
          ),
          excerpt ? h('div', { className: 'dsh-cn-excerpt' }, excerpt) : null,
        ),
        h(
          'button',
          { type: 'button', className: 'dsh-cn-close', 'aria-label': copy.close, title: copy.close, onClick: leave },
          '×',
        ),
      )
    }

    function NoticeLayer(props) {
      const ctx = props && typeof props === 'object' ? props.dshCtx : undefined
      const setup = useRef(null)
      if (setup.current === null) setup.current = pickCopy(ctx || { get: () => undefined })

      const [items, setItems] = useState([])
      const cursor = useRef(null)

      useEffect(() => {
        let alive = true
        let timer = 0
        let inflight = false
        let delay = POLL_MS

        async function tick() {
          if (inflight) return
          inflight = true
          try {
            const url = cursor.current === null ? FEED : FEED + '?since=' + cursor.current
            const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin' })
            if (!alive) return
            if (response.status === 404) {
              // Host half not serving the feed (disabled or not reloaded yet).
              delay = IDLE_POLL_MS
            } else if (response.ok) {
              delay = POLL_MS
              const data = await response.json()
              if (!alive) return
              if (typeof data.cursor === 'number') {
                // A restarting Host can hand back a cursor below ours. Rebase
                // instead of stalling: otherwise every later notice would look
                // older than the one we already saw.
                const rebase = cursor.current !== null && data.cursor < cursor.current
                cursor.current = data.cursor
                if (rebase) return
              }
              if (Array.isArray(data.items) && data.items.length > 0) {
                const fresh = data.items.filter((entry) => entry && typeof entry.id === 'number')
                if (fresh.length > 0) {
                  setItems((previous) => previous.concat(fresh).slice(-MAX_VISIBLE))
                }
              }
            }
          } catch {
            // Transient: a closed window, a restarting Host, a dropped socket.
            delay = POLL_MS
          } finally {
            inflight = false
            if (alive) timer = window.setTimeout(tick, delay)
          }
        }

        // Coming back to the window asks right away instead of waiting out the
        // interval, so a notice that landed while you were away shows at once.
        function kick() {
          if (!alive) return
          window.clearTimeout(timer)
          tick()
        }

        tick()
        document.addEventListener('visibilitychange', kick)
        window.addEventListener('focus', kick)
        return () => {
          alive = false
          window.clearTimeout(timer)
          document.removeEventListener('visibilitychange', kick)
          window.removeEventListener('focus', kick)
        }
      }, [])

      const dismiss = useCallback((id) => {
        setItems((previous) => previous.filter((entry) => entry.id !== id))
      }, [])

      if (items.length === 0) return null

      return h(
        'div',
        { className: 'dsh-cn-stack' },
        h('style', { key: 'style' }, STYLE),
        items
          .slice()
          .reverse()
          .map((item) =>
            h(Notice, {
              key: item.id,
              item,
              copy: setup.current.copy,
              locale: setup.current.locale,
              onDismiss: () => dismiss(item.id),
            }),
          ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // The locale is read once, at apply time; the layer needs nothing else
        // from the context, so hand it in through a wrapper.
        function Bound(props) {
          return h(NoticeLayer, Object.assign({}, props, { dshCtx: ctx }))
        }
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'completion-notice', order: 900 }, Bound),
        )
      },
    }
  },
})