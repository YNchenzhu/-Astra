/**
 * Renderer-side A2-UX coverage. Pins:
 *   - `isUntrustedWorkspacePathError` recognises both the "not in
 *     the trust list" and "(strict mode)" substrings produced by
 *     `electron/security/workspaceAccept.ts`, AND rejects unrelated
 *     errors so the recovery path doesn't hijack real failures.
 *   - `applyTrustDecision` correctly:
 *       * skips IPC when user said no
 *       * calls add() when yes
 *       * returns 'reverted' on IPC failure
 *   - `promptTrustWorkspace` integrates the confirm + add path
 *     (using an injected confirm stub to avoid jsdom's real
 *     `window.confirm`).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyTrustDecision,
  isUntrustedWorkspacePathError,
  promptTrustWorkspace,
} from './workspaceTrustPrompt'

describe('isUntrustedWorkspacePathError', () => {
  it('matches the exact backend message verbatim', () => {
    expect(
      isUntrustedWorkspacePathError(
        new Error(
          'workspace path "/evil" is not in the trust list (strict mode). Add it via …',
        ),
      ),
    ).toBe(true)
  })

  it('matches when only the "not in the trust list" substring is present', () => {
    expect(
      isUntrustedWorkspacePathError(new Error('foo: path is not in the trust list')),
    ).toBe(true)
  })

  it('matches when only the "strict mode" substring is present (forward compat)', () => {
    expect(isUntrustedWorkspacePathError(new Error('Rejected: strict mode'))).toBe(true)
    expect(
      isUntrustedWorkspacePathError(new Error('Rejected: STRICT MODE override')),
    ).toBe(true)
  })

  it('accepts string errors (not just Error instances)', () => {
    expect(
      isUntrustedWorkspacePathError('workspace path "x" is not in the trust list'),
    ).toBe(true)
  })

  it('returns false for unrelated errors', () => {
    expect(isUntrustedWorkspacePathError(new Error('network timeout'))).toBe(false)
    expect(isUntrustedWorkspacePathError(undefined)).toBe(false)
    expect(isUntrustedWorkspacePathError(null)).toBe(false)
    expect(isUntrustedWorkspacePathError(42)).toBe(false)
    expect(isUntrustedWorkspacePathError({})).toBe(false)
  })
})

describe('applyTrustDecision', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns "reverted" when user said no, without touching the IPC', async () => {
    const add = vi.fn()
    const decision = await applyTrustDecision('/p', false, { add })
    expect(decision).toBe('reverted')
    expect(add).not.toHaveBeenCalled()
  })

  it('returns "retry" when user agreed and IPC reports success', async () => {
    const add = vi.fn().mockResolvedValue({ success: true })
    const decision = await applyTrustDecision('/p', true, { add })
    expect(decision).toBe('retry')
    expect(add).toHaveBeenCalledWith({ path: '/p' })
  })

  it('returns "reverted" when IPC reports success=false', async () => {
    const add = vi.fn().mockResolvedValue({ success: false, error: 'denied' })
    // Stub `alert` from `reportUserActionError` so the test environment
    // doesn't fail when it tries to surface the popup.
    vi.stubGlobal('alert', vi.fn())
    const decision = await applyTrustDecision('/p', true, { add })
    expect(decision).toBe('reverted')
  })

  it('returns "reverted" when IPC throws', async () => {
    const add = vi.fn().mockRejectedValue(new Error('ipc dead'))
    vi.stubGlobal('alert', vi.fn())
    const decision = await applyTrustDecision('/p', true, { add })
    expect(decision).toBe('reverted')
  })

  it('returns "reverted" when the trust API bridge is missing entirely', async () => {
    vi.stubGlobal('alert', vi.fn())
    const decision = await applyTrustDecision('/p', true, undefined)
    expect(decision).toBe('reverted')
  })
})

describe('promptTrustWorkspace integration', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns true when user confirms and IPC succeeds', async () => {
    const add = vi.fn().mockResolvedValue({ success: true })
    const confirm = vi.fn().mockReturnValue(true)
    const result = await promptTrustWorkspace('/p', { add }, { confirm })
    expect(result).toBe(true)
    expect(confirm).toHaveBeenCalledOnce()
    expect(confirm.mock.calls[0][0]).toContain('/p')
    expect(add).toHaveBeenCalledWith({ path: '/p' })
  })

  it('returns false when user declines (no IPC call)', async () => {
    const add = vi.fn()
    const confirm = vi.fn().mockReturnValue(false)
    const result = await promptTrustWorkspace('/p', { add }, { confirm })
    expect(result).toBe(false)
    expect(add).not.toHaveBeenCalled()
  })

  it('returns false when the trust IPC throws', async () => {
    const add = vi.fn().mockRejectedValue(new Error('boom'))
    const confirm = vi.fn().mockReturnValue(true)
    vi.stubGlobal('alert', vi.fn())
    const result = await promptTrustWorkspace('/p', { add }, { confirm })
    expect(result).toBe(false)
  })

  it('returns false when confirm is unavailable and the IPC bridge is absent', async () => {
    vi.stubGlobal('alert', vi.fn())
    const result = await promptTrustWorkspace('/p', undefined, {
      confirm: undefined as unknown as (m: string) => boolean,
    })
    expect(result).toBe(false)
  })
})
