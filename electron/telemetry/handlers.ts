/**
 * IPC handlers for the telemetry ring buffer.
 *
 * Exposed to the renderer so Settings / debug UI can display a recent-events
 * panel and users can export a bundle when reporting bugs.
 *
 * The renderer should NEVER be the source of truth — all events are emitted
 * in the main process and only *read* from the renderer. That avoids IPC
 * churn on every tool / compact event and keeps the ring buffer authoritative.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  getRecentTelemetryEvents,
  getTelemetryLogFilePath,
  summarizeRecentTelemetry,
  type TelemetryEvent,
  type ContextEventKind,
  type ProviderErrorKind,
} from './contextEvents'

export interface TelemetryExportBundle {
  /** ISO-8601 timestamp the bundle was generated at. */
  generatedAt: string
  /** Most recent events (default 500, newest first). */
  events: TelemetryEvent[]
  /** Aggregated counts for the last hour — quick glance at a bug report. */
  summaryLastHour: {
    total: number
    context: Partial<Record<ContextEventKind, number>>
    providerErrors: Partial<Record<ProviderErrorKind, number>>
  }
  /** Absolute path of the ndjson log file, if disk logging is active. */
  logFile: string | null
  /** Environment hints useful for debugging cross-OS differences. */
  env: {
    platform: NodeJS.Platform
    osRelease: string
    nodeVersion: string
  }
}

function makeBundle(events: TelemetryEvent[]): TelemetryExportBundle {
  const oneHourAgo = Date.now() - 60 * 60 * 1000
  return {
    generatedAt: new Date().toISOString(),
    events,
    summaryLastHour: summarizeRecentTelemetry(oneHourAgo),
    logFile: getTelemetryLogFilePath(),
    env: {
      platform: process.platform,
      osRelease: os.release(),
      nodeVersion: process.version,
    },
  }
}

export function registerTelemetryHandlers(ipcMain: Electron.IpcMain): void {
  /**
   * Return recent in-memory events. Fast — no disk access. Supports:
   *   - `limit`  : cap return count (default 100)
   *   - `sinceMs`: ignore events older than this absolute timestamp
   *   - `kind`   : 'context' | 'provider_error'
   */
  ipcMain.handle(
    'telemetry:recent-events',
    (
      _event,
      payload?: { limit?: number; sinceMs?: number; kind?: 'context' | 'provider_error' },
    ) => {
      return getRecentTelemetryEvents({
        limit: payload?.limit ?? 100,
        sinceMs: payload?.sinceMs,
        kind: payload?.kind,
      })
    },
  )

  /**
   * Return a full bug-report bundle — in-memory events + summary + env.
   * Used by the "Copy bug report" / "Export telemetry" Settings action.
   */
  ipcMain.handle(
    'telemetry:export-bundle',
    (_event, payload?: { limit?: number }) => {
      const events = getRecentTelemetryEvents({ limit: payload?.limit ?? 500 })
      return makeBundle(events)
    },
  )

  /**
   * Write the bundle to disk (so users can attach it verbatim to an issue).
   * Returns the absolute path.
   */
  ipcMain.handle(
    'telemetry:write-bundle-to-disk',
    async (_event, payload?: { destination?: string; limit?: number }) => {
      const events = getRecentTelemetryEvents({ limit: payload?.limit ?? 500 })
      const bundle = makeBundle(events)
      const target =
        payload?.destination?.trim() ||
        path.join(os.tmpdir(), `astra-telemetry-${Date.now()}.json`)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, JSON.stringify(bundle, null, 2), 'utf8')
      return { path: target }
    },
  )

  /**
   * Quick aggregate for status-line / debug pill. Counts events since the
   * optional `sinceMs`.
   */
  ipcMain.handle(
    'telemetry:summary',
    (_event, payload?: { sinceMs?: number }) => {
      return summarizeRecentTelemetry(payload?.sinceMs)
    },
  )
}
