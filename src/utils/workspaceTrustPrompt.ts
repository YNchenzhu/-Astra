/**
 * Renderer-side companion to the A2 backend boundary check
 * (`electron/security/workspaceAccept.ts`). When the main-process IPC
 * rejects an untrusted workspace path, this helper surfaces a
 * "Trust this workspace?" prompt and lets the caller retry the
 * original action.
 *
 * Why this lives here rather than inside the store:
 *   - the same recovery flow is needed by multiple call sites
 *     (`useWorkspaceStore.setWorkspace`, future chat-send retry, etc.);
 *   - the error-shape detection and copy strings are concentrated in
 *     one place, so changing the backend reason string only requires
 *     updating `isUntrustedWorkspacePathError` here;
 *   - tests can drive the recovery flow without booting Electron.
 *
 * UX choice: native `window.confirm`. The project's
 * `reportUserActionError` already documents the rationale —
 * there is no toast infrastructure, and `window.alert` /
 * `window.confirm` are the project's deliberate baseline (consistent
 * with `useWorkspaceStore.openWorkspace`, `Sidebar.tsx`).
 */

import { reportUserActionError } from './reportUserActionError'

/**
 * Match the backend's rejection reason. The reason string is defined in
 * `electron/security/workspaceAccept.ts::acceptWorkspacePathFromRenderer`
 * and currently reads:
 *   `workspace path "<p>" is not in the trust list (strict mode). ...`
 *
 * We accept either substring — "not in the trust list" OR
 * "(strict mode)" — so a future copy tweak on one side of the wire
 * doesn't silently break the renderer detection.
 */
export function isUntrustedWorkspacePathError(error: unknown): boolean {
  const msg =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : ''
  if (!msg) return false
  return (
    msg.includes('not in the trust list') ||
    msg.toLowerCase().includes('strict mode')
  )
}

interface WorkspaceTrustApi {
  add: (payload: { path: string }) => Promise<{ success: boolean; error?: string }>
}

/**
 * Pure decision step — no UI, easy to unit-test.
 *
 * Returns the next state given the user's prompt response and trust
 * IPC outcome:
 *   - 'retry' → caller should re-run the original IPC
 *   - 'reverted' → user said no / trust IPC failed; caller should
 *     revert renderer state
 */
export type TrustRecoveryDecision = 'retry' | 'reverted'

export async function applyTrustDecision(
  path: string,
  userAgreed: boolean,
  api: WorkspaceTrustApi | undefined,
): Promise<TrustRecoveryDecision> {
  if (!userAgreed) return 'reverted'
  if (!api) {
    // Without the IPC bridge we cannot durably trust the path. The
    // backend will reject again next call. Be honest to the user.
    reportUserActionError(
      '信任工作区',
      new Error('workspaceTrust IPC unavailable — cannot persist trust.'),
    )
    return 'reverted'
  }
  try {
    const r = await api.add({ path })
    if (!r.success) {
      reportUserActionError(
        '信任工作区',
        new Error(r.error || 'workspace-trust:add returned success=false'),
      )
      return 'reverted'
    }
    return 'retry'
  } catch (e) {
    reportUserActionError('信任工作区', e)
    return 'reverted'
  }
}

/**
 * High-level helper. Returns:
 *   - `true` if the user trusted and the retry path should run
 *   - `false` if the user declined / trust IPC failed (caller should
 *     revert any optimistic state)
 *
 * Side-effects: shows a `window.confirm` dialog. The `confirm` call is
 * wrapped so a test environment without a real `confirm` (jsdom,
 * Playwright) can stub it.
 */
export async function promptTrustWorkspace(
  path: string,
  api: WorkspaceTrustApi | undefined,
  options?: { confirm?: (message: string) => boolean },
): Promise<boolean> {
  const message =
    `工作区未在信任列表中：\n\n${path}\n\n` +
    '严格信任模式下，技能、Agent 和 LSP 不会在该目录下运行。\n' +
    '是否信任此工作区并继续？'
  const confirmFn = options?.confirm ?? (typeof window !== 'undefined' ? window.confirm.bind(window) : undefined)
  if (!confirmFn) {
    // No prompt surface available — log + abort.
    reportUserActionError(
      '信任工作区',
      new Error('No window.confirm available; cannot ask user.'),
      { silent: true },
    )
    return false
  }
  const userAgreed = confirmFn(message)
  const decision = await applyTrustDecision(path, userAgreed, api)
  return decision === 'retry'
}
