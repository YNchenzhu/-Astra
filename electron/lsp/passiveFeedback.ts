/**
 * Passive LSP feedback — subscribe to textDocument/publishDiagnostics on all servers.
 * Ported from upstream passiveFeedback.ts.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PublishDiagnosticsParams } from 'vscode-languageserver-protocol'
import type { DiagnosticFile } from './diagnosticTypes'
import {
  registerPendingLSPDiagnostic,
  clearDeliveredDiagnosticsForFile,
} from './LSPDiagnosticRegistry'
import type { LSPServerManager } from './LSPServerManager'
import { diagnosticsStore } from '../tools/DiagnosticsStore'
import { getDiagnosticsHub } from '../diagnostics/DiagnosticsHub'

// ---------------------------------------------------------------------------
// One-shot publish-diagnostics waiters
//
// Used by `diskMutationSync.awaitDiskWriteAndFreshDiagnostics` so file-mutation
// tools (edit_file / write_file / NotebookEdit) can attach the LSP's reaction
// to a write inside the SAME tool_result the agent sees, instead of waiting for
// the next turn's system-prompt drain (the legacy behaviour).
//
// Design constraints:
//   - Single-shot: each waiter resolves on the FIRST MATCHING publish.
//   - Path keyed: case-insensitive on Windows, resolved to absolute.
//   - Bounded: timeout always fires; resolve(false) is the timeout signal.
//   - Self-clearing: timer cleared on real publish, waiter map entry deleted.
//   - VERSION-AWARE (added 2026-05): waiters can require
//     `publish.version >= minVersion` so an in-flight publish from a prior
//     analysis (e.g. pyright finishing V4 right as we send didChange V5)
//     does NOT prematurely satisfy the wait. See
//     {@link awaitNextPublishDiagnostics} for the rationale.
// ---------------------------------------------------------------------------

const IS_WINDOWS = process.platform === 'win32'

function canonicalDiagnosticsKey(p: string): string {
  const resolved = path.resolve(p).replace(/\\/g, '/')
  return IS_WINDOWS ? resolved.toLowerCase() : resolved
}

type PublishWaiter = {
  resolve: (arrived: boolean) => void
  timer: ReturnType<typeof setTimeout>
  /**
   * If set, the waiter only resolves when an incoming publish carries a
   * `version >= minVersion`. Publishes without a `version` field (a few
   * niche LSPs omit it despite the spec) ALSO satisfy the waiter — we'd
   * rather accept an unversioned publish than block forever on a server
   * that never sends versions.
   */
  minVersion?: number
}

const publishWaiters = new Map<string, Set<PublishWaiter>>()

/**
 * Resolve all waiters registered for `localPath` whose `minVersion`
 * constraint is satisfied by `incomingVersion`. Called from the
 * publishDiagnostics handler whether the publish carried diagnostics or an
 * "all-clear" empty array — both are valid signals that the server has
 * re-parsed the file and reported the result.
 *
 * Match rule:
 *   - waiter has no minVersion       → match (legacy behaviour)
 *   - incomingVersion is undefined   → match (LSP didn't send version)
 *   - incomingVersion >= minVersion  → match
 *   - else                            → keep waiting (the incoming publish
 *                                       describes a STALER document state)
 */
function emitPublishForPath(
  localPath: string,
  incomingVersion: number | undefined,
): void {
  const key = canonicalDiagnosticsKey(localPath)
  const set = publishWaiters.get(key)
  if (!set || set.size === 0) return
  const resolved: PublishWaiter[] = []
  for (const waiter of set) {
    const ok =
      waiter.minVersion === undefined ||
      incomingVersion === undefined ||
      incomingVersion >= waiter.minVersion
    if (ok) resolved.push(waiter)
  }
  if (resolved.length === 0) return
  for (const waiter of resolved) {
    set.delete(waiter)
    clearTimeout(waiter.timer)
    try {
      waiter.resolve(true)
    } catch {
      /* listener threw — swallow; never propagate to the LSP receive loop */
    }
  }
  if (set.size === 0) publishWaiters.delete(key)
}

/**
 * Wait for the next textDocument/publishDiagnostics matching `filePath`, or
 * the timeout, whichever fires first.
 *
 * Returns `true` when a matching publish landed within the window, `false`
 * on timeout. Callers read the actual diagnostics from `diagnosticsStore`
 * after this resolves — the boolean only signals "fresh" vs "stale".
 *
 * `minVersion`: if set, the waiter ignores publishes describing an older
 * document state. Pass the version that the just-sent `textDocument/didChange`
 * used; this prevents an in-flight publish for the prior version from
 * prematurely resolving the wait (the bug fixed by 2026-05).
 *
 * Registration order vs the didChange is no longer load-bearing — version
 * filtering tolerates either order — but registering BEFORE didChange is
 * still slightly more robust against an unversioned LSP (where filtering
 * has nothing to compare against).
 */
export function awaitNextPublishDiagnostics(
  filePath: string,
  timeoutMs: number,
  minVersion?: number,
): Promise<boolean> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.resolve(false)
  }
  const key = canonicalDiagnosticsKey(filePath)
  return new Promise<boolean>((resolve) => {
    let bucket = publishWaiters.get(key)
    if (!bucket) {
      bucket = new Set<PublishWaiter>()
      publishWaiters.set(key, bucket)
    }
    const waiter: PublishWaiter = {
      resolve,
      timer: setTimeout(() => {
        const live = publishWaiters.get(key)
        if (live) {
          live.delete(waiter)
          if (live.size === 0) publishWaiters.delete(key)
        }
        resolve(false)
      }, timeoutMs),
      minVersion,
    }
    bucket.add(waiter)
  })
}

/** Test helper — reset all waiters (used by Vitest beforeEach). */
export function __resetPublishDiagnosticsWaitersForTests(): void {
  for (const set of publishWaiters.values()) {
    for (const waiter of set) {
      clearTimeout(waiter.timer)
      try {
        waiter.resolve(false)
      } catch { /* ignore */ }
    }
  }
  publishWaiters.clear()
}

/** Test helper — hand-fire a publish event without going through the LSP. */
export function __emitPublishForPathForTests(
  localPath: string,
  version?: number,
): void {
  emitPublishForPath(localPath, version)
}

function mapLSPSeverity(
  lspSeverity: number | undefined,
): 'Error' | 'Warning' | 'Info' | 'Hint' {
  switch (lspSeverity) {
    case 1:
      return 'Error'
    case 2:
      return 'Warning'
    case 3:
      return 'Info'
    case 4:
      return 'Hint'
    default:
      return 'Error'
  }
}

export function formatDiagnosticsForAttachment(
  params: PublishDiagnosticsParams,
): DiagnosticFile[] {
  let uri: string
  try {
    uri = params.uri.startsWith('file://')
      ? fileURLToPath(params.uri)
      : params.uri
  } catch {
    uri = params.uri
  }

  const diagnostics = params.diagnostics.map((diag) => ({
    message: diag.message,
    severity: mapLSPSeverity(diag.severity),
    range: diag.range
      ? {
          start: {
            line: diag.range.start.line,
            character: diag.range.start.character,
          },
          end: {
            line: diag.range.end.line,
            character: diag.range.end.character,
          },
        }
      : undefined,
    source: diag.source,
    code:
      diag.code !== undefined && diag.code !== null
        ? String(diag.code)
        : undefined,
  }))

  return [{ uri, diagnostics }]
}

export type HandlerRegistrationResult = {
  totalServers: number
  successCount: number
  registrationErrors: Array<{ serverName: string; error: string }>
}

export function ingestPublishDiagnosticsFromServer(
  serverName: string,
  diagnosticParams: PublishDiagnosticsParams,
): void {
  const diagnosticFiles = formatDiagnosticsForAttachment(diagnosticParams)
  const firstFile = diagnosticFiles[0]
  if (!firstFile) return

  const localPath = firstFile.uri
  const hub = getDiagnosticsHub()
  const version =
    typeof (diagnosticParams as { version?: number }).version === 'number'
      ? (diagnosticParams as { version?: number }).version
      : undefined

  if (firstFile.diagnostics.length === 0) {
    clearDeliveredDiagnosticsForFile(localPath)
    diagnosticsStore.mergeFromLanguageServer(localPath, [], serverName)
    hub.ingestFromLsp({
      serverName,
      uri: diagnosticParams.uri,
      version,
      diagnostics: [],
      healthy: true,
    })
    emitPublishForPath(localPath, version)
    return
  }

  registerPendingLSPDiagnostic({
    serverName,
    files: diagnosticFiles,
  })

  diagnosticsStore.mergeFromLanguageServer(
    localPath,
    diagnosticParams.diagnostics,
    serverName,
  )

  hub.ingestFromLsp({
    serverName,
    uri: diagnosticParams.uri,
    version,
    diagnostics: diagnosticParams.diagnostics,
    healthy: true,
  })

  emitPublishForPath(localPath, version)
}

export function registerLSPNotificationHandlers(
  manager: LSPServerManager,
): HandlerRegistrationResult {
  const servers = manager.getAllServers()
  const registrationErrors: Array<{ serverName: string; error: string }> = []
  let successCount = 0

  for (const [serverName, serverInstance] of servers.entries()) {
    try {
      if (!serverInstance || typeof serverInstance.onNotification !== 'function') {
        const errorMsg = !serverInstance
          ? 'Server instance is null/undefined'
          : 'Server instance has no onNotification method'
        registrationErrors.push({ serverName, error: errorMsg })
        console.error(`[LSP passive] ${errorMsg} for ${serverName}`)
        continue
      }

      // Optionally flip Hub provider-health to `false` on crash so the UI can
      // display a "server crashed" badge. Not every LSPServerInstance build
      // exposes `onCrash` — we detect it dynamically and fall back to silent
      // operation. Recovery is automatic: the server's next publishDiagnostics
      // (see below) calls `hub.ingestFromLsp({ healthy: true })`.
      const onCrash = (serverInstance as { onCrash?: (cb: () => void) => void }).onCrash
      if (typeof onCrash === 'function') {
        try {
          onCrash(() => {
            try {
              getDiagnosticsHub().setProviderHealth(`lsp:${serverName}`, false)
            } catch (err) {
              console.warn(
                `[LSP passive] setProviderHealth on crash failed: ${(err as Error).message}`,
              )
            }
          })
        } catch (err) {
          console.warn(
            `[LSP passive] failed to install onCrash listener for ${serverName}: ${(err as Error).message}`,
          )
        }
      }

      serverInstance.onNotification(
        'textDocument/publishDiagnostics',
        (params: unknown) => {
          try {
            if (
              !params ||
              typeof params !== 'object' ||
              !('uri' in params) ||
              !('diagnostics' in params)
            ) {
              console.error(
                `[LSP passive] ${serverName} sent invalid diagnostic params`,
              )
              return
            }

            const diagnosticParams = params as PublishDiagnosticsParams
            ingestPublishDiagnosticsFromServer(serverName, diagnosticParams)
          } catch (error) {
            console.error(
              `[LSP passive] Error handling diagnostics from ${serverName}:`,
              error,
            )
          }
        },
      )

      successCount++
    } catch (error) {
      const err = error as Error
      registrationErrors.push({ serverName, error: err.message })
      console.error(
        `[LSP passive] Failed to register handler for ${serverName}:`,
        err,
      )
    }
  }

  const totalServers = servers.size
  if (registrationErrors.length > 0) {
    console.warn(
      `[LSP passive] Registered ${successCount}/${totalServers} diagnostic handler(s)`,
    )
  } else {
    console.log(
      `[LSP passive] Registered diagnostic handlers for ${totalServers} server(s)`,
    )
  }

  return {
    totalServers,
    successCount,
    registrationErrors,
  }
}
