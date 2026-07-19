import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  RefreshCw,
  Power,
  PowerOff,
  RotateCcw,
  AlertCircle,
  Activity,
  FileCode,
  Play,
  Terminal as TerminalIcon,
} from 'lucide-react'
import { useT, type Messages } from '../../i18n'
import './LspServersPanel.css'

type LspMessages = Messages['settings']['lsp']

type ServerState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'

interface ServerListEntry {
  name: string
  state: ServerState
  disabled: boolean
  quarantined: boolean
  traceEnabled: boolean
  tracePath?: string
  extensions: string[]
  command: string
  lastError?: string
  docCount: number
  crashCount: number
  lastPublishAt?: number
  diagnosticCount: number
  positionEncoding?: 'utf-8' | 'utf-16' | 'utf-32'
}

interface ListResponse {
  servers: ServerListEntry[]
  providerHealth: Record<string, boolean>
  workspacePath: string | null
}

function stateLabel(t: LspMessages, state: ServerState): string {
  switch (state) {
    case 'stopped': return t.stateStopped
    case 'starting': return t.stateStarting
    case 'running': return t.stateRunning
    case 'stopping': return t.stateStopping
    case 'error': return t.stateError
  }
}

function formatLastPublishAt(t: LspMessages, ts?: number): string {
  if (!ts) return t.emptyDash
  const diff = Date.now() - ts
  if (diff < 60_000) return t.agoSec(Math.max(1, Math.round(diff / 1000)))
  if (diff < 3_600_000) return t.agoMin(Math.round(diff / 60_000))
  return new Date(ts).toLocaleString()
}

export const LspServersPanel: React.FC = () => {
  const t = useT().settings.lsp
  const [data, setData] = useState<ListResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [banner, setBanner] = useState<{ type: 'info' | 'error'; text: string } | null>(null)
  const [busyServer, setBusyServer] = useState<string | null>(null)
  /** Server name whose stderr tail is currently expanded. */
  const [stderrOpen, setStderrOpen] = useState<string | null>(null)
  const [stderrText, setStderrText] = useState<string>('')
  const [stderrLoading, setStderrLoading] = useState(false)
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(async (silent = false) => {
    const api = window.electronAPI?.lsp?.listServers
    if (!api) {
      setBanner({
        type: 'error',
        text: t.apiUnavailable,
      })
      return
    }
    if (!silent) setLoading(true)
    try {
      const resp = await api()
      setData(resp)
    } catch (err) {
      setBanner({ type: 'error', text: t.loadFailed((err as Error).message) })
    } finally {
      if (!silent) setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void refresh()
    pollTimer.current = setInterval(() => void refresh(true), 2500)
    const unsub = window.electronAPI?.lsp?.onServerStateChanged?.(() => {
      void refresh(true)
    })
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current)
      pollTimer.current = null
      unsub?.()
    }
  }, [refresh])

  const handleRestart = useCallback(
    async (name: string) => {
      const api = window.electronAPI?.lsp?.restartServer
      if (!api) return
      setBusyServer(name)
      setBanner(null)
      try {
        const res = await api(name)
        if (!res.success) {
          setBanner({ type: 'error', text: t.restartFailed(name, res.error ?? t.unknownError) })
        } else {
          setBanner({ type: 'info', text: t.restarted(name) })
        }
      } catch (err) {
        setBanner({ type: 'error', text: t.restartError(name, (err as Error).message) })
      } finally {
        setBusyServer(null)
        void refresh(true)
      }
    },
    [refresh, t],
  )

  const handleResume = useCallback(
    async (name: string) => {
      const api = window.electronAPI?.lsp?.resumeServer
      if (!api) return
      setBusyServer(name)
      setBanner(null)
      try {
        const res = await api(name)
        if (!res.success) {
          setBanner({ type: 'error', text: t.resumeFailed(name, res.error ?? t.unknownError) })
        } else {
          setBanner({
            type: 'info',
            text: t.resumed(name),
          })
        }
      } catch (err) {
        setBanner({ type: 'error', text: t.resumeError(name, (err as Error).message) })
      } finally {
        setBusyServer(null)
        void refresh(true)
      }
    },
    [refresh, t],
  )

  const handleToggleEnabled = useCallback(
    async (name: string, nextEnabled: boolean) => {
      const api = window.electronAPI?.lsp?.setServerEnabled
      if (!api) return
      setBusyServer(name)
      setBanner(null)
      try {
        const res = await api(name, nextEnabled)
        if (!res.success) {
          setBanner({
            type: 'error',
            text: t.toggleFailed(nextEnabled ? t.actionEnable : t.actionDisable, name, res.error ?? t.unknownError),
          })
        }
      } catch (err) {
        setBanner({ type: 'error', text: t.toggleError(name, (err as Error).message) })
      } finally {
        setBusyServer(null)
        void refresh(true)
      }
    },
    [refresh, t],
  )

  const handleTrace = useCallback(
    async (name: string, enabled: boolean) => {
      const api = window.electronAPI?.lsp?.setServerTrace
      if (!api) return
      setBanner(null)
      setBusyServer(name)
      try {
        const res = await api(name, enabled)
        if (res.success) {
          setBanner({
            type: 'info',
            text:
              enabled && res.logPath
                ? t.traceOnLog(name, res.logPath)
                : enabled
                ? t.traceOnNoServer(name)
                : t.traceOff(name),
          })
        } else {
          setBanner({ type: 'error', text: res.error ?? t.actionFailed })
        }
      } catch (err) {
        setBanner({ type: 'error', text: (err as Error).message })
      } finally {
        setBusyServer(null)
        void refresh(true)
      }
    },
    [refresh, t],
  )

  const handleShowStderr = useCallback(
    async (name: string) => {
      const api = window.electronAPI?.lsp?.getStderrTail
      if (!api) return
      if (stderrOpen === name) {
        setStderrOpen(null)
        setStderrText('')
        return
      }
      setStderrOpen(name)
      setStderrLoading(true)
      try {
        const res = await api(name, 64_000)
        setStderrText(res.success ? res.text ?? t.empty : res.error ?? t.readFailed)
      } catch (err) {
        setStderrText((err as Error).message)
      } finally {
        setStderrLoading(false)
      }
    },
    [stderrOpen, t],
  )

  const totals = useMemo(() => {
    const servers = data?.servers ?? []
    return {
      total: servers.length,
      running: servers.filter((s) => s.state === 'running').length,
      errored: servers.filter((s) => s.state === 'error' || s.quarantined).length,
      disabled: servers.filter((s) => s.disabled).length,
      diagnostics: servers.reduce((acc, s) => acc + s.diagnosticCount, 0),
    }
  }, [data])

  return (
    <div className="lsp-panel">
      <div className="lsp-panel-header">
        <div>
          <h3>{t.title}</h3>
          <p className="lsp-panel-subtitle">
            {t.subtitle}
          </p>
        </div>
        <button
          className="lsp-btn lsp-btn-bordered"
          onClick={() => void refresh()}
          disabled={loading}
          title={t.refresh}
        >
          <RefreshCw size={13} className={loading ? 'lsp-spin' : ''} />
          <span>{t.refresh}</span>
        </button>
      </div>

      <div className="lsp-summary">
        <span className={`lsp-summary-item ${totals.running > 0 ? 'is-ok' : ''}`}>
          <strong>{totals.running}</strong> / {totals.total}{t.runningLabel}
        </span>
        <span className={`lsp-summary-item ${totals.errored > 0 ? 'is-error' : ''}`}>
          <strong>{totals.errored}</strong>{t.errorLabel}
        </span>
        <span className="lsp-summary-item">
          <strong>{totals.disabled}</strong>{t.disabledLabel}
        </span>
        <span className="lsp-summary-item">
          <strong>{totals.diagnostics}</strong>{t.diagnosticsLabel}
        </span>
        {data?.workspacePath && (
          <span className="lsp-summary-workspace" title={data.workspacePath}>
            {data.workspacePath}
          </span>
        )}
      </div>

      {banner && (
        <div className={`lsp-banner lsp-banner-${banner.type}`}>
          <AlertCircle size={13} />
          <span>{banner.text}</span>
          <button className="lsp-banner-close" onClick={() => setBanner(null)}>
            ×
          </button>
        </div>
      )}

      <div className="lsp-server-list">
        {(data?.servers ?? []).length === 0 && !loading && (
          <div className="lsp-empty">
            {t.emptyList}
          </div>
        )}

        {(data?.servers ?? []).map((srv) => {
          const providerKey = `lsp:${srv.name}`
          const health = data?.providerHealth[providerKey]
          const isOk = srv.state === 'running' && health !== false && !srv.quarantined
          const isError = srv.state === 'error' || srv.quarantined || health === false
          const rowClasses = [
            'lsp-server-row',
            srv.disabled ? 'is-disabled' : '',
            srv.quarantined ? 'is-quarantined' : '',
          ]
            .filter(Boolean)
            .join(' ')

          const stateSuffix = srv.quarantined
            ? t.suffixQuarantined
            : srv.disabled
            ? t.suffixDisabled
            : health === false
            ? t.suffixUnhealthy
            : ''

          return (
            <div key={srv.name} className={rowClasses}>
              {/* primary line : dot · name · state · badges · actions */}
              <div className="lsp-row-primary">
                <div className="lsp-row-id">
                  <span className={`lsp-state-dot lsp-state-${srv.state}`} />
                  <span className="lsp-server-name" title={srv.command}>
                    {srv.name}
                  </span>
                  <span
                    className={`lsp-server-state ${
                      isError ? 'is-error' : isOk ? 'is-ok' : ''
                    }`}
                  >
                    {stateLabel(t, srv.state)}
                    {stateSuffix}
                  </span>
                  {srv.traceEnabled && (
                    <span className="lsp-badge lsp-badge-info" title={srv.tracePath}>
                      {t.badgeTracing}
                    </span>
                  )}
                  {srv.positionEncoding && srv.positionEncoding !== 'utf-16' && (
                    <span
                      className="lsp-badge lsp-badge-warn"
                      title={t.badgeEncodingTitle}
                    >
                      {srv.positionEncoding}
                    </span>
                  )}
                </div>

                <div className="lsp-row-actions">
                  <button
                    className="lsp-btn lsp-btn-icon"
                    onClick={() => void handleRestart(srv.name)}
                    disabled={busyServer === srv.name || srv.disabled}
                    title={t.restartThisTitle}
                    aria-label={t.restartAria}
                  >
                    <RotateCcw size={14} />
                  </button>
                  {srv.quarantined && (
                    <button
                      className="lsp-btn lsp-btn-primary"
                      onClick={() => void handleResume(srv.name)}
                      disabled={busyServer === srv.name}
                      title={t.resumeTitle}
                    >
                      <Play size={12} />
                      {t.resume}
                    </button>
                  )}
                  <button
                    className={`lsp-btn lsp-btn-icon ${
                      srv.disabled ? 'lsp-btn-active' : 'lsp-btn-danger'
                    }`}
                    onClick={() => void handleToggleEnabled(srv.name, srv.disabled)}
                    disabled={busyServer === srv.name}
                    title={srv.disabled ? t.enableTitle : t.disableTitle}
                    aria-label={srv.disabled ? t.enableTitle : t.disableTitle}
                  >
                    {srv.disabled ? <Power size={14} /> : <PowerOff size={14} />}
                  </button>
                  <button
                    className={`lsp-btn lsp-btn-icon ${
                      srv.traceEnabled ? 'lsp-btn-active' : ''
                    }`}
                    onClick={() => void handleTrace(srv.name, !srv.traceEnabled)}
                    disabled={busyServer === srv.name}
                    title={
                      srv.traceEnabled
                        ? t.traceOffTitle(srv.tracePath ?? t.logDir)
                        : t.traceOnTitle
                    }
                    aria-label={t.badgeTracing}
                  >
                    <Activity size={14} />
                  </button>
                  <button
                    className={`lsp-btn lsp-btn-icon ${
                      stderrOpen === srv.name ? 'lsp-btn-active' : ''
                    }`}
                    onClick={() => void handleShowStderr(srv.name)}
                    title={t.stderrTitle}
                    aria-label={t.stderrAria}
                  >
                    <TerminalIcon size={14} />
                  </button>
                </div>
              </div>

              {/* secondary line : stats inline + extensions */}
              <div className="lsp-row-meta">
                <span>
                  <strong>{srv.diagnosticCount}</strong>{t.metaDiagnostics}
                </span>
                <span className="lsp-row-meta-sep">
                  <strong>{srv.docCount}</strong>{t.metaFiles}
                </span>
                {srv.crashCount > 0 && (
                  <span className="lsp-row-meta-sep lsp-row-meta-warn">
                    <strong>{srv.crashCount}</strong>{t.metaCrashes}
                  </span>
                )}
                <span className="lsp-row-meta-sep">
                  {t.metaUpdatedPre}<strong>{formatLastPublishAt(t, srv.lastPublishAt)}</strong>
                </span>
                {srv.extensions.length > 0 && (
                  <span className="lsp-row-extensions lsp-row-meta-sep">
                    <FileCode size={11} />
                    {srv.extensions.slice(0, 8).map((ext, i) => (
                      <span key={ext} className="lsp-ext-chip">
                        {ext}
                        {i < Math.min(srv.extensions.length, 8) - 1 ? ' ' : ''}
                      </span>
                    ))}
                    {srv.extensions.length > 8 && (
                      <span className="lsp-ext-more">
                        +{srv.extensions.length - 8}
                      </span>
                    )}
                  </span>
                )}
              </div>

              {srv.lastError && (
                <div className="lsp-row-error" title={srv.lastError}>
                  <AlertCircle size={11} /> {srv.lastError}
                </div>
              )}

              {stderrOpen === srv.name && (
                <div className="lsp-row-stderr">
                  <div className="lsp-row-stderr-head">
                    <TerminalIcon size={11} />
                    <span>stderr tail</span>
                    {stderrLoading && <span className="lsp-stderr-loading">loading…</span>}
                  </div>
                  <pre className="lsp-row-stderr-body">{stderrText || t.empty}</pre>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
