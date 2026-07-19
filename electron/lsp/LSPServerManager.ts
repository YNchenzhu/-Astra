/**
 * LSP Server Manager — multi-server routing and file synchronization.
 *
 * Manages multiple LSP server instances, routes requests by file extension,
 * and handles file synchronization (didOpen/didChange/didClose/didSave).
 *
 * Ported from upstream's LSPServerManager.ts.
 */

import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ServerCapabilities, WorkspaceEdit } from 'vscode-languageserver-protocol'
import {
  createLSPServerInstance,
  type LSPServerInstance,
} from './LSPServerInstance'
import type { ScopedLspServerConfig } from './types'
import { applyWorkspaceEdit } from './applyWorkspaceEdit'
import { getDiagnosticsHub } from '../diagnostics/DiagnosticsHub'

/**
 * Resolve a dotted config section (e.g. `python.analysis`) against a plain
 * object tree (the server's `initializationOptions`), returning the matching
 * sub-tree or `null` when any segment is missing / not an object.
 *
 * Used by the `workspace/configuration` handler so that when a server asks
 * the client "what is my current `python.analysis` setting?", we echo back
 * what we told the server at `initialize` time — rather than `null`, which
 * most servers treat as "reset to built-in defaults".
 */
export function resolveConfigSection(
  root: unknown,
  section: string | null | undefined,
): unknown {
  if (!section || typeof section !== 'string') return root ?? null
  const trimmed = section.trim()
  if (!trimmed) return root ?? null
  let node: unknown = root
  for (const part of trimmed.split('.')) {
    if (!part) continue
    if (!node || typeof node !== 'object' || Array.isArray(node)) return null
    node = (node as Record<string, unknown>)[part]
    if (node === undefined) return null
  }
  return node ?? null
}

export interface LSPServerManager {
  initialize(): Promise<void>
  shutdown(): Promise<void>
  getServerForFile(filePath: string): LSPServerInstance | undefined
  ensureServerStarted(filePath: string): Promise<LSPServerInstance | undefined>
  sendRequest<T>(
    filePath: string,
    method: string,
    params: unknown,
  ): Promise<T | undefined>
  /**
   * Send didOpen (first-time) or didChange (already-open) to the server
   * that owns `filePath`. Returns the document version that was attached
   * to the notification, or `undefined` if no notification was sent (no
   * server available for this file).
   */
  openFile(filePath: string, content: string): Promise<number | undefined>
  /**
   * Send textDocument/didChange. Returns the version emitted, or
   * `undefined` if no notification was sent. Callers that need to wait
   * for a fresh publishDiagnostics MUST pass this version to
   * `awaitNextPublishDiagnostics` so stale in-flight publishes for prior
   * versions don't prematurely satisfy the wait.
   */
  changeFile(filePath: string, content: string): Promise<number | undefined>
  saveFile(filePath: string): Promise<void>
  closeFile(filePath: string): Promise<void>
  isFileOpen(filePath: string): boolean
  /**
   * Whether at least one document is currently open (didOpen'd) on the given
   * server scope. tsserver-style servers only load projects once a document
   * is open, so workspace-wide queries (workspace/symbol → navto) fail with
   * "No Project" on a running-but-empty server.
   */
  hasOpenFilesForServer(serverName: string): boolean
  getAllServers(): Map<string, LSPServerInstance>
  /**
   * Negotiated server capabilities for the server that would handle `filePath`,
   * or `undefined` if no server matches / server not yet initialized.
   */
  getServerCapabilities(filePath: string): ServerCapabilities | undefined
}

/**
 * Create an LSP server manager.
 *
 * @param loadConfigs - Async function that returns server configs (injected dependency)
 */
export function createLSPServerManager(
  loadConfigs: () => Promise<Record<string, ScopedLspServerConfig>>,
): LSPServerManager {
  const servers = new Map<string, LSPServerInstance>()
  const extensionMap = new Map<string, string[]>()
  const openedFiles = new Map<string, string>()
  /**
   * LSP `textDocument.version` per `file://` URI. Must be strictly monotonic for
   * the lifetime of a didOpen…didClose sequence — otherwise tsserver/pyright
   * will either drop the didChange (silent stale state) or throw
   * "ContentModified" retries. We reset to 1 on didOpen, +1 on each didChange,
   * delete on didClose.
   */
  const documentVersions = new Map<string, number>()

  async function initialize(): Promise<void> {
    const serverConfigs = await loadConfigs()

    for (const [scope, config] of Object.entries(serverConfigs)) {
      if (!config.command) {
        console.error(`[LSP] Server '${scope}' missing 'command', skipping`)
        continue
      }
      if (!config.extensionToLanguage || Object.keys(config.extensionToLanguage).length === 0) {
        console.error(`[LSP] Server '${scope}' missing 'extensionToLanguage', skipping`)
        continue
      }

      // Map file extensions to this server
      for (const ext of Object.keys(config.extensionToLanguage)) {
        const normalized = ext.toLowerCase()
        if (!extensionMap.has(normalized)) {
          extensionMap.set(normalized, [])
        }
        extensionMap.get(normalized)!.push(scope)
      }

      // Create server instance
      const instance = createLSPServerInstance(scope, config)
      servers.set(scope, instance)

      // Declare extension coverage to the diagnostics hub up front — this
      // lets Monaco-vs-LSP arbitration suppress Monaco's in-memory TS worker
      // the moment a user opens a file, even before the LSP server has
      // published any per-URI diagnostics. Without this, Monaco's bogus
      // "Cannot find module" errors slip into the Problems panel for every
      // file that tsserver happens to consider clean.
      try {
        getDiagnosticsHub().registerLspCoverage(
          scope,
          Object.keys(config.extensionToLanguage ?? {}),
        )
      } catch (err) {
        console.warn(
          `[LSP] failed to register diagnostics coverage for '${scope}': ${(err as Error).message}`,
        )
      }

      // Handle workspace/configuration requests from the server.
      //
      // REGRESSION WE FIXED HERE: this handler used to return `null` for
      // every requested section. That silently defeated the server's
      // `initializationOptions` at runtime — e.g. Pyright asks the client
      // for `python.analysis` every time it analyzes a file; our `null`
      // answer made Pyright fall back to its built-in defaults
      // (`typeCheckingMode: basic`), which re-enabled all the "opinionated"
      // rules (reportArgumentType, reportUnusedVariable, …) we thought we
      // had silenced in `config.ts`.
      //
      // The fix: when the server asks for a section, walk the server's
      // own `initializationOptions` tree and return the matching sub-tree.
      // This makes the "configuration" channel a faithful mirror of the
      // initialization-time settings; projects that ship a real
      // `pyrightconfig.json` or `pyproject.toml[tool.pyright]` still
      // override via their own (higher-priority) config file path.
      const initOpts = config.initializationOptions ?? {}
      instance.onRequest(
        'workspace/configuration',
        (params: { items: Array<{ section?: string }> }) => {
          const items = Array.isArray(params?.items) ? params.items : []
          return items.map((item) => resolveConfigSection(initOpts, item?.section))
        },
      )

      // Reverse workspace/applyEdit — many servers (notably tsserver's
      // "organize imports" command and all rename-providers) ship edits
      // client-to-server-to-client rather than returning them inline. Without
      // this handler, those features silently no-op.
      //
      // The LSP response shape is `ApplyWorkspaceEditResult`:
      //   { applied: boolean, failureReason?: string, failedChange?: number }
      // Our main-process `applyWorkspaceEdit` returns a richer summary; map
      // it to the spec shape and surface the first failure reason verbatim so
      // the server's own error reporting still works.
      instance.onRequest<
        { label?: string; edit: WorkspaceEdit },
        { applied: boolean; failureReason?: string; failedChange?: number }
      >('workspace/applyEdit', async (params) => {
        try {
          if (!params || typeof params !== 'object' || !params.edit) {
            return { applied: false, failureReason: 'missing edit' }
          }
          const result = await applyWorkspaceEdit(params.edit)
          if (!result.applied && result.failedPaths.length > 0) {
            return {
              applied: false,
              failureReason: result.failedPaths[0].reason,
            }
          }
          if (!result.applied && result.skippedFileOps.length > 0) {
            return {
              applied: false,
              failureReason: result.skippedFileOps[0].reason ?? 'file op rejected',
            }
          }
          const partialFailures = [
            ...result.failedPaths.map((f) => f.reason),
            ...result.skippedFileOps.map((f) => f.reason ?? 'unknown'),
          ].filter(Boolean)
          if (partialFailures.length > 0) {
            return {
              applied: true,
              failureReason: `${partialFailures.length} partial failure(s): ${partialFailures.join('; ')}`,
            }
          }
          return { applied: result.applied }
        } catch (err) {
          return { applied: false, failureReason: (err as Error).message }
        }
      })
    }

    console.log(`[LSP] Manager initialized with ${servers.size} server(s)`)
  }

  async function shutdown(): Promise<void> {
    const toStop = Array.from(servers.values()).filter(
      (s) => s.state === 'running' || s.state === 'error',
    )
    // Capture scope names BEFORE the map is cleared so we can unregister
    // diagnostics coverage below.
    const scopesToUnregister = Array.from(servers.keys())

    const results = await Promise.allSettled(toStop.map((s) => s.stop()))

    servers.clear()
    extensionMap.clear()
    openedFiles.clear()
    documentVersions.clear()

    try {
      const hub = getDiagnosticsHub()
      for (const scope of scopesToUnregister) {
        hub.unregisterLspCoverage(scope)
      }
    } catch (err) {
      console.warn(
        `[LSP] failed to unregister diagnostics coverage during shutdown: ${(err as Error).message}`,
      )
    }

    const errors = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => String(r.reason))

    if (errors.length > 0) {
      console.error(`[LSP] Failed to stop ${errors.length} server(s): ${errors.join('; ')}`)
    }
  }

  function getServerForFile(filePath: string): LSPServerInstance | undefined {
    const ext = path.extname(filePath).toLowerCase()
    const serverNames = extensionMap.get(ext)
    if (!serverNames || serverNames.length === 0) return undefined
    return servers.get(serverNames[0]!)
  }

  async function ensureServerStarted(
    filePath: string,
  ): Promise<LSPServerInstance | undefined> {
    const server = getServerForFile(filePath)
    if (!server) return undefined

    // `start()` is idempotent and de-duplicates in-flight calls, so we can
    // call it unconditionally except when the server is already running
    // or in the middle of being torn down. Previously we short-circuited
    // on 'starting', which made concurrent callers return a server that
    // wasn't ready yet → subsequent `sendNotification` throws.
    if (server.state === 'stopped' || server.state === 'error' || server.state === 'starting') {
      await server.start()
    }

    return server
  }

  async function sendRequest<T>(
    filePath: string,
    method: string,
    params: unknown,
  ): Promise<T | undefined> {
    const server = await ensureServerStarted(filePath)
    if (!server) return undefined

    try {
      return await server.sendRequest<T>(method, params)
    } catch (error) {
      console.error(`[LSP] Request '${method}' failed for ${filePath}: ${(error as Error).message}`)
      throw error
    }
  }

  async function openFile(
    filePath: string,
    content: string,
  ): Promise<number | undefined> {
    const server = await ensureServerStarted(filePath)
    if (!server) return undefined

    const fileUri = pathToFileURL(path.resolve(filePath)).href

    // Already-open case: emit a didChange with the latest content and a bumped
    // version instead of silently returning. Callers routinely invoke openFile
    // from two paths (Monaco tab create, LSP pre-warm, FS watcher "add") and
    // expect the server to always see the freshest buffer.
    if (openedFiles.get(fileUri) === server.name) {
      const prev = documentVersions.get(fileUri) ?? 1
      const next = prev + 1
      documentVersions.set(fileUri, next)
      await server.sendNotification('textDocument/didChange', {
        textDocument: { uri: fileUri, version: next },
        contentChanges: [{ text: content }],
      })
      return next
    }

    const ext = path.extname(filePath).toLowerCase()
    const languageId = server.config.extensionToLanguage[ext] || 'plaintext'

    documentVersions.set(fileUri, 1)
    await server.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri: fileUri,
        languageId,
        version: 1,
        text: content,
      },
    })
    openedFiles.set(fileUri, server.name)
    return 1
  }

  async function changeFile(
    filePath: string,
    content: string,
  ): Promise<number | undefined> {
    const server = getServerForFile(filePath)
    if (!server || server.state !== 'running') {
      return openFile(filePath, content)
    }

    const fileUri = pathToFileURL(path.resolve(filePath)).href
    if (openedFiles.get(fileUri) !== server.name) {
      return openFile(filePath, content)
    }

    const prev = documentVersions.get(fileUri) ?? 1
    const next = prev + 1
    documentVersions.set(fileUri, next)

    await server.sendNotification('textDocument/didChange', {
      textDocument: { uri: fileUri, version: next },
      contentChanges: [{ text: content }],
    })
    return next
  }

  async function saveFile(filePath: string): Promise<void> {
    const server = getServerForFile(filePath)
    if (!server || server.state !== 'running') return

    await server.sendNotification('textDocument/didSave', {
      textDocument: { uri: pathToFileURL(path.resolve(filePath)).href },
    })
  }

  async function closeFile(filePath: string): Promise<void> {
    const server = getServerForFile(filePath)
    if (!server || server.state !== 'running') return

    const fileUri = pathToFileURL(path.resolve(filePath)).href
    await server.sendNotification('textDocument/didClose', {
      textDocument: { uri: fileUri },
    })
    openedFiles.delete(fileUri)
    documentVersions.delete(fileUri)
  }

  function isFileOpen(filePath: string): boolean {
    const fileUri = pathToFileURL(path.resolve(filePath)).href
    return openedFiles.has(fileUri)
  }

  function hasOpenFilesForServer(serverName: string): boolean {
    for (const owner of openedFiles.values()) {
      if (owner === serverName) return true
    }
    return false
  }

  function getAllServers(): Map<string, LSPServerInstance> {
    return servers
  }

  function getServerCapabilities(filePath: string): ServerCapabilities | undefined {
    const server = getServerForFile(filePath)
    return server?.getServerCapabilities()
  }

  return {
    initialize,
    shutdown,
    getServerForFile,
    ensureServerStarted,
    sendRequest,
    openFile,
    changeFile,
    saveFile,
    closeFile,
    isFileOpen,
    hasOpenFilesForServer,
    getAllServers,
    getServerCapabilities,
  }
}
