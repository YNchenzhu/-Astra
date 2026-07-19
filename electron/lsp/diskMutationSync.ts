/**
 * After Agent (or tool) writes to disk, notify language servers (upstream FileWrite/FileEdit parity).
 */

import { pathToFileURL } from 'node:url'
import { getLspServerManager, waitForInitialization } from './manager'
import {
  awaitNextPublishDiagnostics,
  ingestPublishDiagnosticsFromServer,
} from './passiveFeedback'
import type { Diagnostic } from 'vscode-languageserver-protocol'

/**
 * Default timeout used by file-mutation tools when waiting for the LSP to
 * publish fresh diagnostics. 3000ms covers more tsserver / pyright project
 * graph refreshes without making the agent feel stuck; callers may override
 * per-call.
 */
export const DEFAULT_LSP_DIAGNOSTICS_TIMEOUT_MS = 3000

type PullDiagnosticReport =
  | { kind?: 'full'; items?: Diagnostic[] }
  | { kind?: 'unchanged'; resultId?: string }

function serverSupportsPullDiagnostics(capabilities: unknown): boolean {
  if (!capabilities || typeof capabilities !== 'object') return false
  return 'diagnosticProvider' in capabilities && Boolean(
    (capabilities as { diagnosticProvider?: unknown }).diagnosticProvider,
  )
}

async function tryPullFreshDiagnostics(resolvedPath: string): Promise<boolean> {
  const mgr = getLspServerManager()
  if (!mgr) return false
  const server = mgr.getServerForFile(resolvedPath)
  if (!server || server.state !== 'running') return false
  if (!serverSupportsPullDiagnostics(server.getServerCapabilities())) return false

  const uri = pathToFileURL(resolvedPath).href
  try {
    const report = await server.sendRequest<PullDiagnosticReport>(
      'textDocument/diagnostic',
      { textDocument: { uri } },
      { timeoutMs: 2500 },
    )
    if (!report || report.kind === 'unchanged' || !('items' in report)) return false
    const items = Array.isArray(report.items) ? report.items : []
    ingestPublishDiagnosticsFromServer(server.name, { uri, diagnostics: items })
    return true
  } catch (err) {
    console.warn(
      `[LSP] pull diagnostics failed for ${resolvedPath}: ${(err as Error).message}`,
    )
    return false
  }
}

/**
 * Fire-and-forget: push buffer to LSP and didSave so diagnostics refresh. Never throws to caller.
 *
 * Use this when the caller does NOT need the LSP's reaction in its return
 * value (e.g. background batch operations, FS watcher reflows). Tools that
 * want to expose fresh diagnostics in their tool_result must use
 * {@link awaitDiskWriteAndFreshDiagnostics} instead.
 */
export function afterSuccessfulDiskWrite(
  resolvedPath: string,
  newContent: string,
): void {
  void (async () => {
    try {
      await waitForInitialization().catch(() => {})
      const mgr = getLspServerManager()
      if (!mgr || !mgr.getServerForFile(resolvedPath)) return
      await mgr.changeFile(resolvedPath, newContent)
      await mgr.saveFile(resolvedPath)
    } catch (err) {
      console.warn(
        `[LSP] diskMutationSync failed for ${resolvedPath}: ${(err as Error).message}`,
      )
    }
  })()
}

export type DiskWriteSyncResult = {
  /** True iff an LSP server is configured for this file's extension. */
  lspApplicable: boolean
  /**
   * True iff a publishDiagnostics for this path landed within the timeout
   * window AFTER the didChange/didSave we just sent. False on timeout, on
   * "no server", or when LSP initialization never completed.
   *
   * Callers that report diagnostics to the AI should still consult the
   * authoritative `diagnosticsStore` (some servers re-publish stale
   * diagnostics; others suppress publish on no-op edits) — this flag only
   * signals "the trailer is fresh-from-server" vs "trailer may be stale".
   */
  diagnosticsArrived: boolean
}

/**
 * Awaitable variant of {@link afterSuccessfulDiskWrite}. Pushes didChange +
 * didSave to the matching language server and then waits up to
 * `timeoutMs` for the next textDocument/publishDiagnostics for this path.
 *
 * NEVER throws — LSP failures are swallowed (the file is already on disk and
 * the tool's success result must not be invalidated by a flaky LSP). The
 * returned struct lets callers decide whether to render a fresh-or-stale
 * diagnostics trailer.
 */
export async function awaitDiskWriteAndFreshDiagnostics(
  resolvedPath: string,
  newContent: string,
  timeoutMs: number = DEFAULT_LSP_DIAGNOSTICS_TIMEOUT_MS,
): Promise<DiskWriteSyncResult> {
  try {
    await waitForInitialization().catch(() => {})
    const mgr = getLspServerManager()
    if (!mgr || !mgr.getServerForFile(resolvedPath)) {
      return { lspApplicable: false, diagnosticsArrived: false }
    }
    // Push the buffer first so we know which document version the server
    // saw, then register a version-aware waiter. Without this version check,
    // an in-flight publishDiagnostics for the PRIOR version (e.g. pyright
    // still finishing V4 analysis when we send V5) would prematurely resolve
    // the wait and the trailer would show pre-edit diagnostics — the exact
    // bug that caused the agent's "verification loop" feedback.
    //
    // Ordering note: registering the waiter AFTER changeFile is safe because
    // version filtering does the heavy lifting — a V4 publish that lands
    // before we register simply drops on the floor (correct; we want V5).
    // A V5 publish can't arrive until after changeFile's notification is
    // processed, so the JS event loop guarantees we re-enter and register
    // before the server can possibly respond.
    const sentVersion = await mgr.changeFile(resolvedPath, newContent)
    const waiter = awaitNextPublishDiagnostics(
      resolvedPath,
      timeoutMs,
      sentVersion,
    )
    await mgr.saveFile(resolvedPath)
    let arrived = await waiter
    if (!arrived) {
      arrived = await tryPullFreshDiagnostics(resolvedPath)
    }
    return { lspApplicable: true, diagnosticsArrived: arrived }
  } catch (err) {
    console.warn(
      `[LSP] awaitDiskWriteAndFreshDiagnostics failed for ${resolvedPath}: ${(err as Error).message}`,
    )
    return { lspApplicable: false, diagnosticsArrived: false }
  }
}
