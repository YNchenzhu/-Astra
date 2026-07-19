/**
 * Worker-side state holder for the tool utilityProcess.
 *
 * The host sends `tool_init` after boot (and may re-send after settings
 * changes) plus a full `diskSettingsSnapshot` on **every** tool RPC so
 * `readDiskSettings()` inside the child always mirrors the main-process
 * merged settings (WebSearch API keys, default shell metadata, etc.).
 */

import { setToolWorkerDiskSettingsOverride } from '../../settings/settingsAccess'
import { importReceipts } from '../readFileState'
import type { ToolRpcInit, ToolRpcReadReceipt } from './wireProtocol'

let lastInit: ToolRpcInit | null = null

export function applyDiskSettingsForExecution(snapshot: Record<string, unknown>): void {
  setToolWorkerDiskSettingsOverride(snapshot)
}

/**
 * Hydrate this process's `readFileState` with the main-process receipts
 * forwarded on a file-mutation `tool_request` (SA-5). Idempotent — the
 * import skips same-readId re-imports and never clobbers a newer local
 * receipt (see {@link importReceipts}). No-op when the host sent none.
 */
export function applyReadReceiptsForExecution(
  receipts: ToolRpcReadReceipt[] | undefined,
): void {
  if (!receipts || receipts.length === 0) return
  try {
    importReceipts(receipts)
  } catch {
    // Receipt hydration must never fail a dispatch — worst case the
    // worker's gates behave as they did before forwarding existed.
  }
}

export function applyToolInit(msg: ToolRpcInit): void {
  lastInit = msg
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ws = require('../workspaceState') as {
      setWorkspacePath?: (p: string | null) => void
    }
    if (typeof ws.setWorkspacePath === 'function') {
      ws.setWorkspacePath(msg.workspacePath)
    }
  } catch {
    /* worker test seam */
  }
  if (msg.diskSettingsSnapshot && typeof msg.diskSettingsSnapshot === 'object') {
    setToolWorkerDiskSettingsOverride(msg.diskSettingsSnapshot)
  }
}

export function getToolInitSnapshot(): ToolRpcInit | null {
  return lastInit
}
