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

    const STYLE = [
      '.dsh-cn-stack{position:fixed;top:52px;right:18px;z-index:60;display:flex;flex-direction:column;',
      'gap:8px;width:340px;max-width:calc(100vw - 36px);pointer-events:none;font-family:inherit}',
      '.dsh-cn-card{pointer-events:auto;position:relative;display:flex;align-items:flex-start;',
      'box-sizing:border-box;padding:13px 14px 13px 15px;border-radius:12px;',
      'border:1px solid var(--dsw-alias-border-l1);',
      // The theme's surface tokens are alpha layers meant to sit on a page, so a
      // single one leaves the transcript showing through the card. Stack the same
      // layer three times (each pass raises opacity) and frost what is left, so
      // the card reads as a surface instead of a smudge.
      'background-color:var(--dsw-alias-bg-overlay,rgba(24,24,27,.9));',
      'background-image:linear-gradient(var(--dsw-alias-bg-overlay,rgba(0,0,0,0)),var(--dsw-alias-bg-overlay,rgba(0,0,0,0))),',
      'linear-gradient(var(--dsw-alias-bg-overlay,rgba(0,0,0,0)),var(--dsw-alias-bg-overlay,rgba(0,0,0,0)));',
      'backdrop-filter:blur(24px) saturate(1.2);-webkit-backdrop-filter:blur(24px) saturate(1.2);',
      'color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.35;',
      'box-shadow:0 16px 36px -20px rgba(0,0,0,.5),0 2px 6px rgba(0,0,0,.1),inset 0 1px 0 rgba(255,255,255,.06);',
      'animation:dsh-cn-in .22s cubic-bezier(.22,.68,.32,1) both;',
      'transition:box-shadow .16s ease,border-color .16s ease}',
      '.dsh-cn-card:hover{border-color:var(--dsw-alias-border-l2);',
      'box-shadow:0 18px 40px -20px rgba(0,0,0,.55),0 2px 8px rgba(0,0,0,.12),inset 0 1px 0 rgba(255,255,255,.08)}',
      // The tone lives in one solid rail down the left edge: you read the
      // outcome from the color before you read the words.
      '.dsh-cn-card::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;',
      'background:var(--dsh-cn-accent,var(--dsw-alias-brand-primary));border-radius:12px 0 0 12px}',
      '.dsh-cn-body{flex:1 1 auto;min-width:0}',
      // Title and the small print share one baseline row: the eye reads the
      // headline first, the numbers sit out of the way on the right instead of
      // stacking a second full-width line under it.
      '.dsh-cn-head{display:flex;align-items:baseline;gap:8px;min-width:0}',
      '.dsh-cn-title{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
      'font-weight:600;letter-spacing:.005em}',
      '.dsh-cn-meta{margin-left:auto;flex:0 1 auto;min-width:0;max-width:62%;text-align:right;',
      'color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:1.3;',
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-cn-excerpt{margin-top:6px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;',
      'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}',
      '.dsh-cn-close{position:absolute;top:8px;right:8px;width:20px;height:20px;padding:0;border:0;border-radius:6px;',
      'background:transparent;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:1;',
      'cursor:pointer;opacity:0;transition:opacity .15s ease,background .15s ease,color .15s ease}',
      '.dsh-cn-card:hover .dsh-cn-close,.dsh-cn-close:focus-visible{opacity:1}',
      '.dsh-cn-close:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.dsh-cn-card[data-tone="success"]{--dsh-cn-accent:var(--dsw-alias-state-success-primary)}',
      '.dsh-cn-card[data-tone="warn"]{--dsh-cn-accent:var(--dsw-alias-state-warn-primary)}',
      '.dsh-cn-card[data-tone="error"]{--dsh-cn-accent:var(--dsw-alias-state-error-primary)}',
      '.dsh-cn-card[data-tone="idle"]{--dsh-cn-accent:var(--dsw-alias-state-idle-primary)}',
      '.dsh-cn-card[data-leaving="1"]{animation:dsh-cn-out .16s ease forwards}',
      '@keyframes dsh-cn-in{from{opacity:0;transform:translate3d(0,-6px,0)}to{opacity:1;transform:none}}',
      '@keyframes dsh-cn-out{to{opacity:0;transform:translate3d(0,-4px,0)}}',
      '@media (prefers-reduced-motion:reduce){.dsh-cn-card{animation:none}}',
    ].join('')

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
          className: 'dsh-cn-card',
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