/**
 * Background task pill — compact status-bar indicator for in-flight
 * shell / agent / cloud sessions. upstream parity for the spinner
 * pill rendered by `src/components/Spinner.tsx` in the upstream
 * CLI.
 *
 * Data source: `electron.tasks.getPillLabel()` IPC, which aggregates
 * `taskStateManager`'s `getBackgroundTasks()` / `getForegroundTasks()`
 * into a `{ label, needsCta, needsInput, backgroundCount,
 * foregroundCount }` payload. The handler has lived in
 * `electron/ipc/handlers/taskHandlers.ts` since the upgrade landed;
 * this component is the renderer wiring the audit identified as
 * missing.
 *
 * Polling cadence:
 *   - 5s when label is non-empty (active work — keep timer tight)
 *   - 30s when label is empty (idle — background pulse only)
 *
 * Plus an opportunistic refresh on every V2 task lifecycle event
 * (free piggyback over the existing IPC stream); when the user
 * spawns a TaskCreate that becomes a backgrounded run, that
 * lifecycle event triggers a near-instant pill refresh without
 * waiting for the slow idle pulse.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { onStreamEvent } from '../../services/electronAPI'

interface PillState {
  label: string
  needsCta: boolean
  needsInput: boolean
  backgroundCount: number
  foregroundCount: number
}

const EMPTY: PillState = {
  label: '',
  needsCta: false,
  needsInput: false,
  backgroundCount: 0,
  foregroundCount: 0,
}

const ACTIVE_POLL_MS = 5_000
const IDLE_POLL_MS = 30_000

export const TaskPill: React.FC = () => {
  const [pill, setPill] = useState<PillState>(EMPTY)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(async () => {
    const api = window.electronAPI?.tasks
    if (!api?.getPillLabel) return
    try {
      const result = await api.getPillLabel()
      setPill({
        label: result.pill.label,
        needsCta: result.pill.needsCta,
        needsInput: result.pill.needsInput,
        backgroundCount: result.backgroundCount,
        foregroundCount: result.foregroundCount,
      })
    } catch {
      // Ignore — pill is best-effort UI; transient IPC failures
      // shouldn't blip the status bar.
    }
  }, [])

  // Adaptive polling driven by `pill.label` non-empty.
  useEffect(() => {
    let cancelled = false

    const tick = () => {
      if (cancelled) return
      void refresh()
      const interval = pill.label ? ACTIVE_POLL_MS : IDLE_POLL_MS
      timerRef.current = setTimeout(tick, interval)
    }

    // Initial fetch + start the timer.
    tick()

    return () => {
      cancelled = true
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [refresh, pill.label])

  // Opportunistic refresh on any V2 task lifecycle event. The pill
  // covers a different store (taskStateManager, runtime tasks) but
  // V2 lifecycle events typically coincide with runtime activity
  // (a TaskCreate that goes to bash also triggers a runtime task),
  // so refreshing on the V2 stream is a cheap way to dodge the
  // polling lag for the common case.
  useEffect(() => {
    let unsubscribe: (() => void) | null = null
    try {
      const off = onStreamEvent((event) => {
        if (event?.type === 'task-v2:lifecycle' || event?.type === 'task:output-chunk') {
          void refresh()
        }
      })
      unsubscribe = typeof off === 'function' ? off : null
    } catch {
      /* noop */
    }
    return () => {
      if (unsubscribe) {
        try { unsubscribe() } catch { /* noop */ }
      }
    }
  }, [refresh])

  if (!pill.label) return null

  const title =
    `${pill.foregroundCount} 前台 · ${pill.backgroundCount} 后台` +
    (pill.needsInput ? '\n需要输入' : pill.needsCta ? '\n有可查看的结果' : '')

  return (
    <div
      className={
        'statusbar-item statusbar-task-pill'
        + (pill.needsInput ? ' statusbar-task-pill-input' : '')
        + (pill.needsCta && !pill.needsInput ? ' statusbar-task-pill-cta' : '')
      }
      title={title}
    >
      <span className="statusbar-task-pill-dot" aria-hidden />
      <span>{pill.label}</span>
      {pill.needsInput && <span className="statusbar-task-pill-badge">!</span>}
    </div>
  )
}
