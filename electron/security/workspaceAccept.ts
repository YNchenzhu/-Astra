/**
 * Self-audit fix A2 (2026-05) — IPC boundary check for renderer-supplied
 * workspace paths.
 *
 * Problem (pre-fix): `setWorkspacePath()` accepted any string the
 * renderer threw at it. A compromised webContents could call
 * `memory:set-workspace("/some/sensitive/dir")`, after which the
 * skill loader / agentic tools / LSP would all happily read files
 * under that path. The G12 fix in `electron/skills/handlers.ts`
 * (skill:reload) was easily bypassed because it asked
 * `getWorkspacePath()`, which would already point to the attacker
 * path.
 *
 * This module is the single chokepoint. The three production IPC
 * entry points (memory:set-workspace, ai:send-message,
 * streamHandler) MUST route through `acceptWorkspacePathFromRenderer`
 * before calling `setWorkspacePath` directly. Tests and the
 * sub-agent worker can still call `setWorkspacePath` raw — they are
 * NOT renderer-facing.
 *
 * Policy:
 *   - trusted path                       → pass through
 *   - untrusted path + legacy mode       → auto-trust + console.warn
 *     (preserves current "just open any folder" UX while leaving an
 *      audit trail; matches the pre-fix behaviour but with
 *      observability)
 *   - untrusted path + strict mode       → reject (throw)
 *
 * Trust check is memoized against the path so high-frequency callers
 * (streamHandler fires per message) don't pay the JSON file read on
 * every IPC call. Cache is invalidated when:
 *   - `addTrustedWorkspaceRoot` is called via the existing IPC
 *     channel (the trust handler invokes `invalidateAcceptCache`)
 *   - `removeTrustedWorkspaceRoot` is called similarly
 *   - the trust mode setting changes
 */

import {
  addTrustedWorkspaceRoot,
  isWorkspaceTrusted,
} from './workspaceTrust'
import { parseWorkspaceTrustMode } from './workspaceTrustSettings'
import { readDiskSettings } from '../settings/settingsAccess'

export type WorkspaceAcceptOutcome =
  | { ok: true; effective: string; status: 'trusted' | 'auto-trusted' }
  | { ok: false; reason: string }

interface CacheEntry {
  /** Resolved/normalized path that was checked. */
  path: string
  /** Outcome status — never an `ok:false` (we don't cache rejections). */
  status: 'trusted' | 'auto-trusted'
  /** Trust-mode at time of decision; rechecks on mode change. */
  mode: 'legacy' | 'strict'
}

const acceptCache = new Map<string, CacheEntry>()

/**
 * Drop the per-path memoized trust result. Wired into the existing
 * `workspace-trust:add` / `workspace-trust:remove` IPC handlers so
 * the next acceptance call re-reads `trusted-workspaces.json`.
 */
export function invalidateAcceptCache(reason?: string): void {
  acceptCache.clear()
  if (reason) {
    console.log(`[workspaceAccept] cache invalidated: ${reason}`)
  }
}

function normalizeForCache(p: string): string {
  const t = p.trim()
  return process.platform === 'win32' ? t.toLowerCase() : t
}

function currentMode(): 'legacy' | 'strict' {
  return parseWorkspaceTrustMode(readDiskSettings().workspaceTrustMode)
}

/**
 * The boundary check. Returns an outcome the caller transports back
 * to the renderer (handlers should `throw new Error(reason)` on
 * `ok:false`).
 *
 * `opts.source` is the IPC channel name; appears in the audit log
 * line so an operator can trace which entry point auto-trusted /
 * rejected a path.
 */
export function acceptWorkspacePathFromRenderer(
  requestedRaw: unknown,
  opts: { source: string } = { source: 'unknown' },
): WorkspaceAcceptOutcome {
  if (requestedRaw == null) {
    return { ok: true, effective: '', status: 'trusted' }
  }
  const requested = typeof requestedRaw === 'string' ? requestedRaw.trim() : ''
  if (!requested) {
    return { ok: true, effective: '', status: 'trusted' }
  }

  const cacheKey = normalizeForCache(requested)
  const mode = currentMode()
  const cached = acceptCache.get(cacheKey)
  if (cached && cached.mode === mode) {
    return { ok: true, effective: requested, status: cached.status }
  }

  if (isWorkspaceTrusted(requested)) {
    acceptCache.set(cacheKey, { path: cacheKey, status: 'trusted', mode })
    return { ok: true, effective: requested, status: 'trusted' }
  }

  if (mode === 'strict') {
    // Do NOT cache rejections — the user can add the path via the
    // existing `workspace-trust:add` IPC and the next call should
    // succeed without restart.
    return {
      ok: false,
      reason:
        `workspace path "${requested}" is not in the trust list (strict mode). ` +
        'Add it via Settings → 权限 → 工作区信任 or the workspace-trust:add IPC, then retry.',
    }
  }

  // Legacy mode: auto-trust + audit log. upstream equivalent: implicit
  // trust on first open, but they don't carry a list. We DO carry one,
  // so we explicitly add — that gives the user a chance to inspect /
  // revoke later, and the next access pays no JSON read.
  addTrustedWorkspaceRoot(requested)
  acceptCache.set(cacheKey, { path: cacheKey, status: 'auto-trusted', mode })
  console.warn(
    `[workspaceAccept] auto-trusting "${requested}" (legacy mode, source=${opts.source}). ` +
      'Set workspaceTrustMode=strict in Settings to require explicit trust instead.',
  )
  return { ok: true, effective: requested, status: 'auto-trusted' }
}

/** @internal Test seam — reset module state between scenarios. */
export function _resetWorkspaceAcceptCacheForTests(): void {
  acceptCache.clear()
}

/** @internal Test seam — snapshot cache contents. */
export function _snapshotWorkspaceAcceptCacheForTests(): Array<{
  path: string
  status: 'trusted' | 'auto-trusted'
  mode: 'legacy' | 'strict'
}> {
  return Array.from(acceptCache.values())
}
