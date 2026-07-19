/**
 * LSP Admin IPC — lets the Settings "LSP 服务器" panel observe and steer the
 * bundled language servers at runtime.
 *
 *   lsp:list-servers        -> current server inventory + stats + providerHealth
 *   lsp:restart-server      -> force-restart a single server by name
 *   lsp:set-server-enabled  -> persist disabled-list into settings; triggers a
 *                              full manager re-init so the change takes effect
 *   lsp:set-server-trace    -> enable/disable JSON-RPC tracing per server;
 *                              trace logs are written to userData/logs/
 *
 * Stats are read from the DiagnosticsHub so we never run a second queue or
 * duplicate counters.
 */

import type { BrowserWindow, IpcMain } from 'electron'
import path from 'node:path'
import { getLspServerManager, reinitializeLspServerManager } from './manager'
import { getDiagnosticsHub } from '../diagnostics/DiagnosticsHub'
import { readDiskSettings, writeDiskSettingsPartial } from '../settings/settingsAccess'
import { getWorkspacePath } from '../tools/workspaceState'
import { app } from 'electron'
import {
  DISABLED_LSP_SERVERS_KEY,
  getDisabledLspServers,
} from './disabledServers'

/** Settings key storing the set of servers with tracing enabled. */
const TRACED_LSP_SERVERS_KEY = 'lspTracedServers'

export { DISABLED_LSP_SERVERS_KEY, getDisabledLspServers }

async function persistDisabledServers(next: string[]): Promise<void> {
  await writeDiskSettingsPartial({ [DISABLED_LSP_SERVERS_KEY]: next })
}

interface ServerListEntry {
  name: string
  state: 'stopped' | 'starting' | 'running' | 'stopping' | 'error'
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

interface ServerListResponse {
  servers: ServerListEntry[]
  providerHealth: Record<string, boolean>
  workspacePath: string | null
}

function getTracedServers(): string[] {
  const raw = readDiskSettings()[TRACED_LSP_SERVERS_KEY]
  if (!Array.isArray(raw)) return []
  return raw.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
}

async function persistTracedServers(next: string[]): Promise<void> {
  await writeDiskSettingsPartial({ [TRACED_LSP_SERVERS_KEY]: next })
}

function traceFileFor(serverName: string): string {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const safe = serverName.replace(/[^a-zA-Z0-9_-]+/g, '_')
  return path.join(app.getPath('userData'), 'logs', `lsp-${safe}-${stamp}.log`)
}

function collectDiagnosticStatsByProvider(): Map<
  string,
  { count: number; lastAt: number; uris: Set<string> }
> {
  const stats = new Map<string, { count: number; lastAt: number; uris: Set<string> }>()
  const hub = getDiagnosticsHub()
  for (const file of hub.getAllAuthoritative()) {
    for (const diag of file.diagnostics) {
      const entry = stats.get(diag.providerKey) ?? {
        count: 0,
        lastAt: 0,
        uris: new Set<string>(),
      }
      entry.count += 1
      entry.uris.add(file.uri)
      stats.set(diag.providerKey, entry)
    }
  }
  return stats
}

export function registerLspAdminIpcHandlers(
  ipcMain: IpcMain,
  options: { getMainWindow: () => BrowserWindow | null },
): void {
  ipcMain.handle('lsp:list-servers', (): ServerListResponse => {
    const manager = getLspServerManager()
    const disabled = new Set(getDisabledLspServers())
    const traced = new Set(getTracedServers())
    const hub = getDiagnosticsHub()
    const providerHealth = hub.getProviderHealth()
    const perProvider = collectDiagnosticStatsByProvider()

    const servers: ServerListEntry[] = []
    if (manager) {
      for (const [name, instance] of manager.getAllServers()) {
        const providerKey = `lsp:${name}`
        const stats = perProvider.get(providerKey)
        servers.push({
          name,
          state: instance.state,
          disabled: disabled.has(name),
          quarantined: instance.isQuarantined(),
          traceEnabled: traced.has(name),
          tracePath: traced.has(name) ? traceFileFor(name) : undefined,
          extensions: Object.keys(instance.config.extensionToLanguage ?? {}),
          command: instance.config.command,
          lastError: instance.lastError?.message,
          docCount: stats?.uris.size ?? 0,
          crashCount: instance.getCrashCount(),
          lastPublishAt: stats?.lastAt,
          diagnosticCount: stats?.count ?? 0,
          positionEncoding: instance.getPositionEncoding(),
        })
      }
    }

    // Also include disabled servers that aren't spawned so the UI can show them
    // as "disabled" toggles even if the manager filtered them out.
    for (const name of disabled) {
      if (!servers.some((s) => s.name === name)) {
        servers.push({
          name,
          state: 'stopped',
          disabled: true,
          quarantined: false,
          traceEnabled: traced.has(name),
          extensions: [],
          command: '(disabled)',
          docCount: 0,
          crashCount: 0,
          diagnosticCount: 0,
        })
      }
    }

    return {
      servers: servers.sort((a, b) => a.name.localeCompare(b.name)),
      providerHealth,
      workspacePath: getWorkspacePath() ?? null,
    }
  })

  ipcMain.handle('lsp:restart-server', async (_event, name: string) => {
    if (typeof name !== 'string' || !name.trim()) {
      return { success: false, error: 'server name required' }
    }
    const manager = getLspServerManager()
    if (!manager) {
      return { success: false, error: 'LSP manager not initialized' }
    }
    const instance = manager.getAllServers().get(name)
    if (!instance) {
      return { success: false, error: `No LSP server named '${name}'` }
    }
    try {
      // A manual restart is always a user intent to resume — clear the
      // quarantine flag up-front so `instance.start()` doesn't bail.
      instance.clearQuarantine()
      await instance.restart()
      // Mark the provider healthy on successful restart; the next publish will
      // re-confirm. We don't wait for it.
      try {
        getDiagnosticsHub().setProviderHealth(`lsp:${name}`, true)
      } catch {
        /* non-fatal */
      }
      try {
        options.getMainWindow()?.webContents.send('lsp:server-state', {
          name,
          state: instance.state,
        })
      } catch {
        /* non-fatal */
      }
      return { success: true }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('lsp:resume-server', async (_event, name: string) => {
    // Explicitly clear quarantine without a full restart (useful when the user
    // wants to retry a background recovery path rather than cold-starting).
    if (typeof name !== 'string' || !name.trim()) {
      return { success: false, error: 'server name required' }
    }
    const manager = getLspServerManager()
    const instance = manager?.getAllServers().get(name)
    if (!instance) return { success: false, error: `No LSP server named '${name}'` }
    instance.clearQuarantine()
    return { success: true, quarantined: instance.isQuarantined() }
  })

  ipcMain.handle(
    'lsp:set-server-enabled',
    async (_event, params: { name: string; enabled: boolean }) => {
      if (!params || typeof params.name !== 'string' || !params.name.trim()) {
        return { success: false, error: 'server name required' }
      }
      const name = params.name.trim()
      const enabled = !!params.enabled
      const current = new Set(getDisabledLspServers())
      if (enabled) current.delete(name)
      else current.add(name)

      try {
        await persistDisabledServers([...current].sort())
      } catch (err) {
        return { success: false, error: (err as Error).message }
      }

      // If disabling, proactively stop the instance so diagnostics vanish
      // immediately instead of waiting for reinit to finish.
      if (!enabled) {
        const manager = getLspServerManager()
        const instance = manager?.getAllServers().get(name)
        if (instance) {
          try {
            await instance.stop()
          } catch {
            /* ignore */
          }
          try {
            getDiagnosticsHub().clearProvider(`lsp:${name}`)
          } catch {
            /* ignore */
          }
        }
      }

      // Regardless of direction, trigger a re-init so `loadLspConfigs` re-reads
      // the disabled list and spawns / skips servers accordingly.
      try {
        const ws = getWorkspacePath() ?? undefined
        const userData = app.getPath('userData')
        reinitializeLspServerManager(ws, userData)
      } catch (err) {
        console.warn('[LSP admin] reinit after set-enabled failed:', (err as Error).message)
      }

      return { success: true }
    },
  )

  ipcMain.handle(
    'lsp:set-server-trace',
    async (_event, params: { name: string; enabled: boolean }) => {
      if (!params || typeof params.name !== 'string' || !params.name.trim()) {
        return { success: false, error: 'server name required' }
      }
      const name = params.name.trim()
      const enabled = !!params.enabled

      const current = new Set(getTracedServers())
      if (enabled) current.add(name)
      else current.delete(name)
      try {
        await persistTracedServers([...current].sort())
      } catch (err) {
        return { success: false, error: (err as Error).message }
      }

      const manager = getLspServerManager()
      const instance = manager?.getAllServers().get(name)
      if (!instance) {
        // Server isn't spawned (disabled or not yet started). The setting is
        // persisted, so the trace will kick in when it next starts.
        return { success: true, logPath: enabled ? traceFileFor(name) : undefined }
      }
      const logPath = enabled ? traceFileFor(name) : null
      let activePath: string | null = null
      try {
        activePath = instance.setTraceLog(logPath)
      } catch (err) {
        return { success: false, error: (err as Error).message }
      }
      return {
        success: true,
        logPath: activePath ?? undefined,
      }
    },
  )

  ipcMain.handle(
    'lsp:get-stderr-tail',
    async (_event, params: { name: string; maxBytes?: number }) => {
      if (!params || typeof params.name !== 'string' || !params.name.trim()) {
        return { success: false, error: 'server name required' }
      }
      const manager = getLspServerManager()
      const instance = manager?.getAllServers().get(params.name.trim())
      if (!instance) {
        return { success: true, text: '' }
      }
      try {
        const tail = instance.getStderrTail(params.maxBytes ?? 64_000)
        return { success: true, text: tail }
      } catch (err) {
        return { success: false, error: (err as Error).message }
      }
    },
  )
}

/**
 * Wire persisted trace state into a freshly-initialized manager. Called after
 * every `initializeLspServerManager` + `registerLSPNotificationHandlers`; this
 * is what makes trace settings survive restarts.
 */
export function applyPersistedTraceSettings(): void {
  const manager = getLspServerManager()
  if (!manager) return
  const traced = new Set(getTracedServers())
  for (const [name, instance] of manager.getAllServers()) {
    try {
      instance.setTraceLog(traced.has(name) ? traceFileFor(name) : null)
    } catch (err) {
      console.warn(
        `[LSP admin] failed to apply trace setting for ${name}: ${(err as Error).message}`,
      )
    }
  }
}
