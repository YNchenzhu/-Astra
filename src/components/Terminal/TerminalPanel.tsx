import React, { useEffect, useRef, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { useLayoutStore } from '../../stores/useLayoutStore'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'
import { useDiagnosticStore } from '../../stores/useDiagnosticStore'
import { useOutputStore } from '../../stores/useOutputStore'
import { onLifecycleLog } from '../../services/electronAPI'
import { reportUserActionError } from '../../utils/reportUserActionError'
import { ProblemsPanel } from './ProblemsPanel'
import { OutputPanel } from './OutputPanel'
import { DebugConsole } from './DebugConsole'
import { setTerminalSessionsVisibility, type TerminalSessionRecord } from './terminalSessionLayout'
import { useT } from '../../i18n'
import '@xterm/xterm/css/xterm.css'
import './TerminalPanel.css'

type PanelTabId = 'terminal' | 'problems' | 'output' | 'debug'

/**
 * xterm.js draws its own canvas and is therefore *not* styled by CSS — we
 * have to hand it a fully-resolved colour map at construction time (and
 * whenever the app theme changes). These fallbacks mirror the original
 * Catppuccin Mocha palette so there's still something reasonable if
 * `getComputedStyle` can't see the CSS variables for some reason (e.g.
 * the terminal panel mounts before `global.css` is loaded in tests).
 */
const XTERM_FALLBACK_THEME = {
  background: '#1e1e2e',
  foreground: '#cdd6f4',
  cursor: '#f5e0dc',
  cursorAccent: '#1e1e2e',
  selectionBackground: '#585b7066',
  black: '#45475a',
  red: '#f38ba8',
  green: '#a6e3a1',
  yellow: '#f9e2af',
  blue: '#89b4fa',
  magenta: '#f5c2e7',
  cyan: '#94e2d5',
  white: '#bac2de',
  brightBlack: '#585b70',
  brightRed: '#f38ba8',
  brightGreen: '#a6e3a1',
  brightYellow: '#f9e2af',
  brightBlue: '#89b4fa',
  brightMagenta: '#f5c2e7',
  brightCyan: '#94e2d5',
  brightWhite: '#a6adc8',
}

/**
 * Build an xterm theme from the current CSS custom properties on `:root`.
 *
 * The mapping uses:
 *   background     ← `--bg-base`
 *   foreground     ← `--text-primary`
 *   cursor         ← `--accent-peach`      (warm highlight that reads well
 *                                           on every background)
 *   cursorAccent   ← `--bg-base`           (inverse colour of the cursor
 *                                           glyph so text under it stays
 *                                           legible)
 *   selection      ← `--selection-bg`
 *   ANSI 16        ← `--accent-*` / surface + text scale
 *
 * If any variable comes back empty (missing stylesheet in tests), we fall
 * back to `XTERM_FALLBACK_THEME`'s value for that slot.
 */
function buildXtermThemeFromCss(): typeof XTERM_FALLBACK_THEME {
  if (typeof document === 'undefined') return XTERM_FALLBACK_THEME
  const cs = getComputedStyle(document.documentElement)
  const pick = (name: string, fallback: string): string => {
    const raw = cs.getPropertyValue(name).trim()
    return raw || fallback
  }
  // selectionBackground needs a trailing alpha channel — the Catppuccin
  // default uses #xxxxxx66 (≈40 % opacity). We append the same alpha on
  // top of `--selection-bg` so the terminal's selection rectangle doesn't
  // paint an opaque strip over text.
  const rawSelection = pick('--selection-bg', '#585b70')
  const selectionBackground =
    rawSelection.startsWith('#') && (rawSelection.length === 7 || rawSelection.length === 4)
      ? rawSelection + '66'
      : rawSelection

  return {
    background:     pick('--bg-base',        XTERM_FALLBACK_THEME.background),
    foreground:     pick('--text-primary',   XTERM_FALLBACK_THEME.foreground),
    cursor:         pick('--accent-peach',   XTERM_FALLBACK_THEME.cursor),
    cursorAccent:   pick('--bg-base',        XTERM_FALLBACK_THEME.cursorAccent),
    selectionBackground,
    black:          pick('--bg-surface1',    XTERM_FALLBACK_THEME.black),
    red:            pick('--accent-red',     XTERM_FALLBACK_THEME.red),
    green:          pick('--accent-green',   XTERM_FALLBACK_THEME.green),
    yellow:         pick('--accent-yellow',  XTERM_FALLBACK_THEME.yellow),
    blue:           pick('--accent-blue',    XTERM_FALLBACK_THEME.blue),
    magenta:        pick('--accent-pink',    XTERM_FALLBACK_THEME.magenta),
    cyan:           pick('--accent-teal',    XTERM_FALLBACK_THEME.cyan),
    white:          pick('--text-secondary', XTERM_FALLBACK_THEME.white),
    brightBlack:    pick('--text-subtext',   XTERM_FALLBACK_THEME.brightBlack),
    brightRed:      pick('--accent-red',     XTERM_FALLBACK_THEME.brightRed),
    brightGreen:    pick('--accent-green',   XTERM_FALLBACK_THEME.brightGreen),
    brightYellow:   pick('--accent-yellow',  XTERM_FALLBACK_THEME.brightYellow),
    brightBlue:     pick('--accent-blue',    XTERM_FALLBACK_THEME.brightBlue),
    brightMagenta:  pick('--accent-mauve',   XTERM_FALLBACK_THEME.brightMagenta),
    brightCyan:     pick('--accent-teal',    XTERM_FALLBACK_THEME.brightCyan),
    brightWhite:    pick('--text-primary',   XTERM_FALLBACK_THEME.brightWhite),
  }
}

interface TerminalPanelProps {
  style?: React.CSSProperties
}

export const TerminalPanel: React.FC<TerminalPanelProps> = ({ style }) => {
  const t = useT()
  const panelTabs: { id: PanelTabId; label: string }[] = [
    { id: 'terminal', label: t.terminal.tabTerminal },
    { id: 'problems', label: t.terminal.tabProblems },
    { id: 'output', label: t.terminal.tabOutput },
    { id: 'debug', label: t.terminal.tabDebug },
  ]
  const {
    terminalHeight, setTerminalHeight,
    activeTerminalTab, setActiveTerminalTab,
    toggleTerminal,
    terminalInstances, activeTerminalId,
    addTerminalInstance,
    removeTerminalInstance,
    clearTerminalInstances,
    setActiveTerminalId,
  } = useLayoutStore()
  const { rootPath } = useWorkspaceStore()
  const problemCount = useDiagnosticStore((s) => s.diagnostics.length)
  const sessionsRef = useRef<Map<number, TerminalSessionRecord>>(new Map())
  /** Bumped when the initial-session effect cleans up (rootPath / deps) so in-flight `create` closes PTY instead of orphaning DOM. */
  const terminalSessionGenRef = useRef(0)
  /** Tracks whether the component is still mounted — prevents DOM orphans after async PTY creation. */
  const isMountedRef = useRef(false)
  const containerHostRef = useRef<HTMLDivElement>(null)
  const isResizing = useRef(false)
  const startY = useRef(0)
  const startHeight = useRef(0)
  const [resizing, setResizing] = React.useState(false)
  const [maximized, setMaximized] = React.useState(false)
  const prevHeightRef = useRef(220)

  useEffect(() => {
    return onLifecycleLog((payload) => {
      useOutputStore.getState().addEntry(
        'app',
        `[${payload.channelId}] ${payload.message}`,
        payload.type ?? 'info',
      )
    })
  }, [])

  // Wire up output:append IPC
  useEffect(() => {
    if (!window.electronAPI?.output?.onAppend) return
    const unsub = window.electronAPI.output.onAppend((data: { channelId: string; message: string; type?: string }) => {
      const t = data.type
      const level =
        t === 'error' || t === 'warning' || t === 'info' ? t : 'info'
      useOutputStore.getState().addEntry(data.channelId, data.message, level)
    })
    return unsub
  }, [])

  const createNewSession = useCallback(async () => {
    if (!window.electronAPI?.terminal || !containerHostRef.current) return

    try {
      const genAtStart = terminalSessionGenRef.current
      const result = await window.electronAPI.terminal.create(rootPath || undefined)
      if (genAtStart !== terminalSessionGenRef.current) {
        void window.electronAPI.terminal.close(result.sessionId)
        return
      }

      // Mounted guard after the async await — if component unmounted, close PTY and skip DOM append.
      if (!isMountedRef.current) {
        void window.electronAPI.terminal.close(result.sessionId)
        return
      }

      const host = containerHostRef.current
      if (!host) {
        void window.electronAPI.terminal.close(result.sessionId)
        return
      }

      const sessionId = result.sessionId

      const container = document.createElement('div')
      container.className = 'terminal-xterm-container'
      container.style.display = 'none'
      host.appendChild(container)

      const xterm = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Consolas', monospace",
        lineHeight: 1.2,
        theme: buildXtermThemeFromCss(),
      })

      const fitAddon = new FitAddon()
      xterm.loadAddon(fitAddon)
      xterm.open(container)
      fitAddon.fit()

      const unsubData = window.electronAPI.terminal.onData(sessionId, (data) => {
        xterm.write(data)
      })

      const unsubExit = window.electronAPI.terminal.onExit(sessionId, () => {
        xterm.write('\r\n\x1b[90m[Process exited]\x1b[0m\r\n')
      })

      const onDataDisposable = xterm.onData((data) => {
        void window.electronAPI!.terminal.write(sessionId, data)
      })
      const disposeLocalOnData =
        onDataDisposable && typeof (onDataDisposable as { dispose?: () => void }).dispose === 'function'
          ? () => (onDataDisposable as { dispose: () => void }).dispose()
          : null

      sessionsRef.current.set(sessionId, {
        xterm,
        fitAddon,
        container,
        unsubData,
        unsubExit,
        disposeLocalOnData,
      })

      const shellLabel = window.electronAPI.platform === 'win32' ? 'PowerShell' : 'bash'
      addTerminalInstance({ id: sessionId, label: shellLabel, cwd: rootPath || '' })

      return sessionId
    } catch (error) {
      // Previously: `terminal.create` rejection became an unhandled promise
      // rejection — the "新建终端" button appeared dead. Now the user
      // sees a real explanation (missing preload bridge, spawn failure, etc.).
      reportUserActionError('新建终端', error)
      return undefined
    }
  }, [rootPath, addTerminalInstance])

  // Create initial session; cleanup disposes PTYs and clears layout store (fixes Strict Mode / stale tabs).
  useEffect(() => {
    isMountedRef.current = true

    if (!window.electronAPI?.terminal || !containerHostRef.current) return

    void createNewSession()

    // Capture the ref value at effect-mount time. ESLint's hook rule warns that
    // `sessionsRef.current` in cleanup may have been replaced — for our case it isn't
    // (the ref points to a stable Map for the panel's lifetime) but capturing locally
    // is both safer and silences the lint heuristic.
    const sessionsMap = sessionsRef.current
    return () => {
      isMountedRef.current = false
      terminalSessionGenRef.current += 1
      const snapshot = new Map(sessionsMap)
      for (const [sessionId, session] of snapshot) {
        session.unsubData?.()
        session.unsubExit?.()
        session.disposeLocalOnData?.()
        window.electronAPI?.terminal.close(sessionId)
        session.xterm.dispose()
        session.container.remove()
      }
      sessionsMap?.clear()
      clearTerminalInstances()
    }
  }, [createNewSession, clearTerminalInstances])

  // Show/hide session containers based on activeTerminalId
  useEffect(() => {
    setTerminalSessionsVisibility(
      sessionsRef.current,
      activeTerminalId,
      activeTerminalTab === 'terminal',
    )
    const activeSessionId = activeTerminalId
    if (activeSessionId == null) return
    const active = sessionsRef.current.get(activeSessionId)
    if (active && activeTerminalTab === 'terminal') {
      const timer = window.setTimeout(() => {
        const latest = sessionsRef.current.get(activeSessionId)
        if (!latest) return
        if (activeTerminalTab !== 'terminal') return
        latest.fitAddon.fit()
        window.electronAPI?.terminal.resize(activeSessionId, latest.xterm.cols, latest.xterm.rows)
      }, 50)
      return () => window.clearTimeout(timer)
    }
  }, [activeTerminalId, activeTerminalTab])

  // Resize all visible terminals when panel height changes
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!activeTerminalId) return
      const active = sessionsRef.current.get(activeTerminalId)
      if (active) {
        active.fitAddon.fit()
        window.electronAPI?.terminal.resize(activeTerminalId, active.xterm.cols, active.xterm.rows)
      }
    }, 100)
    return () => window.clearTimeout(timer)
  }, [terminalHeight, activeTerminalId])

  // Listen for external clear event
  useEffect(() => {
    const handler = () => {
      if (!activeTerminalId) return
      sessionsRef.current.get(activeTerminalId)?.xterm.clear()
    }
    document.addEventListener('terminal:clear', handler)
    return () => document.removeEventListener('terminal:clear', handler)
  }, [activeTerminalId])

  /**
   * Theme re-sync.
   *
   * xterm.js paints its own canvas with a plain JS theme object — it does
   * not read CSS at runtime. So when the user switches between dark /
   * light / cursor in Settings → Appearance, the terminal panel stays
   * frozen on whatever palette it booted with unless we explicitly push
   * a new theme into every live xterm.
   *
   * We listen for `data-theme` attribute mutations on `<html>` (the
   * mechanism `AppInner` uses to apply theme changes) and, whenever it
   * flips, rebuild the theme from the freshly-applied CSS variables and
   * assign it to every session via `xterm.options.theme = …`. xterm
   * picks that up on the next frame and repaints without losing scroll
   * history or the active line buffer.
   *
   * The observer only fires when the attribute actually changes — idle
   * cost is essentially zero.
   */
  useEffect(() => {
    const applyToAll = () => {
      const nextTheme = buildXtermThemeFromCss()
      for (const { xterm } of sessionsRef.current.values()) {
        // Narrow options mutation — xterm types `options` as mutable.
        xterm.options.theme = nextTheme
      }
    }
    // Apply once on mount in case the theme changed between store load
    // and the first terminal session being created.
    applyToAll()
    const obs = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'attributes' && r.attributeName === 'data-theme') {
          applyToAll()
          break
        }
      }
    })
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
  }, [])

  const handleCloseSession = useCallback((id: number) => {
    const session = sessionsRef.current.get(id)
    if (session) {
      session.unsubData?.()
      session.unsubExit?.()
      session.disposeLocalOnData?.()
      session.xterm.dispose()
      session.container.remove()
      sessionsRef.current.delete(id)
    }
    void window.electronAPI?.terminal.close(id)
    removeTerminalInstance(id)
  }, [removeTerminalInstance])

  const onTerminalResizePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      e.preventDefault()
      const el = e.currentTarget
      el.setPointerCapture(e.pointerId)
      isResizing.current = true
      startY.current = e.clientY
      startHeight.current = terminalHeight
      setResizing(true)

      const onMove = (ev: PointerEvent) => {
        if (!isResizing.current) return
        const delta = startY.current - ev.clientY
        setTerminalHeight(startHeight.current + delta)
      }
      const end = (ev: PointerEvent) => {
        try {
          el.releasePointerCapture(ev.pointerId)
        } catch {
          /* noop */
        }
        el.removeEventListener('pointermove', onMove)
        el.removeEventListener('pointerup', end)
        el.removeEventListener('pointercancel', end)
        el.removeEventListener('lostpointercapture', onLostCapture)
        isResizing.current = false
        setResizing(false)
      }
      const onLostCapture = () => {
        el.removeEventListener('pointermove', onMove)
        el.removeEventListener('pointerup', end)
        el.removeEventListener('pointercancel', end)
        el.removeEventListener('lostpointercapture', onLostCapture)
        isResizing.current = false
        setResizing(false)
      }
      el.addEventListener('pointermove', onMove)
      el.addEventListener('pointerup', end)
      el.addEventListener('pointercancel', end)
      el.addEventListener('lostpointercapture', onLostCapture)
    },
    [terminalHeight, setTerminalHeight],
  )

  return (
    <div className="terminal-panel" style={{ height: terminalHeight, ...style }}>
      <div
        className={`terminal-resize-handle ${resizing ? 'active' : ''}`}
        onPointerDown={onTerminalResizePointerDown}
      />
      <div className="terminal-tabs" onDoubleClick={() => {
        if (maximized) {
          setTerminalHeight(prevHeightRef.current)
          setMaximized(false)
        } else {
          prevHeightRef.current = terminalHeight
          setTerminalHeight(window.innerHeight - 80)
          setMaximized(true)
        }
      }}>
        <div className="terminal-tabs-left">
          {panelTabs.map((tab) => (
            <button
              key={tab.id}
              className={`terminal-tab ${activeTerminalTab === tab.id ? 'active' : ''}`}
              onClick={() => setActiveTerminalTab(tab.id)}
            >
              {tab.label}
              {tab.id === 'problems' && problemCount > 0 && (
                <span className="terminal-badge">{problemCount}</span>
              )}
            </button>
          ))}
        </div>
        <div className="terminal-tabs-right">
          {activeTerminalTab === 'terminal' && (
            <>
              <button className="terminal-action-btn" title={t.terminal.newTerminal} onClick={createNewSession}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 1a.75.75 0 0 1 .75.75v4.5h4.5a.75.75 0 0 1 0 1.5h-4.5v4.5a.75.75 0 0 1-1.5 0v-4.5h-4.5a.75.75 0 0 1 0-1.5h4.5v-4.5A.75.75 0 0 1 8 1z" />
                </svg>
              </button>
              <button
                type="button"
                className="terminal-action-btn"
                title={t.terminal.clear}
                disabled={!activeTerminalId}
                onClick={() => {
                  if (!activeTerminalId) return
                  const session = sessionsRef.current.get(activeTerminalId)
                  session?.xterm.clear()
                }}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zM6.25 4.39l.07-.07a.25.25 0 0 1 .35 0L8 5.64l1.33-1.32a.25.25 0 0 1 .35.01l.07.07a.25.25 0 0 1 0 .35L8.36 6l1.32 1.33a.25.25 0 0 1-.01.35l-.07.07a.25.25 0 0 1-.35 0L8 6.36l-1.33 1.32a.25.25 0 0 1-.35-.01l-.07-.07a.25.25 0 0 1 0-.35L7.64 6 6.32 4.67a.25.25 0 0 1 .01-.35z" />
                </svg>
              </button>
            </>
          )}
          <button className="terminal-action-btn" title={t.terminal.closePanel} onClick={toggleTerminal}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 8.707l3.646 3.647.708-.707L8.707 8l3.647-3.646-.707-.708L8 7.293 4.354 3.646l-.707.708L7.293 8l-3.646 3.646.707.708L8 8.707z" />
            </svg>
          </button>
        </div>
      </div>

      {/* Terminal instance tabs — only visible when terminal tab is active */}
      {activeTerminalTab === 'terminal' && terminalInstances.length > 0 && (
        <div className="terminal-instance-tabs">
          {terminalInstances.map((inst) => (
            <div
              key={inst.id}
              className={`terminal-instance-tab ${inst.id === activeTerminalId ? 'active' : ''}`}
              onClick={() => setActiveTerminalId(inst.id)}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" className="terminal-instance-icon">
                <path d="M6 9l3-3-3-3-.7.7L7.6 6 5.3 8.3z" />
                <path d="M9 11H5v1h4z" />
              </svg>
              <span className="terminal-instance-label">{inst.label}</span>
              <button
                type="button"
                className="terminal-instance-close"
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  handleCloseSession(inst.id)
                }}
                title={t.terminal.closeTerminal}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="terminal-content">
        <div ref={containerHostRef} className="terminal-sessions-host" style={{ display: activeTerminalTab === 'terminal' ? 'block' : 'none', height: '100%' }} />
        {activeTerminalTab === 'problems' && <ProblemsPanel />}
        {activeTerminalTab === 'output' && <OutputPanel />}
        {activeTerminalTab === 'debug' && <DebugConsole />}
      </div>
    </div>
  )
}
