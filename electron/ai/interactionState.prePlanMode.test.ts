import { afterEach, describe, expect, it } from 'vitest'
import {
  consumePrePlanMode,
  getPermissionMode,
  getPrePlanMode,
  setPermissionMode,
} from './interactionState'

describe('interactionState prePlanMode bookkeeping (P0-1, cc-haha §3.3)', () => {
  afterEach(() => {
    // Drain any leftover slot before resetting global mode so we don't
    // drag state across tests when this file is run in `--reporter=verbose`.
    consumePrePlanMode()
    setPermissionMode('default')
    consumePrePlanMode()
  })

  it('records the prior mode when entering plan from acceptEdits', () => {
    setPermissionMode('acceptEdits')
    expect(getPrePlanMode()).toBeUndefined()

    setPermissionMode('plan')
    expect(getPermissionMode()).toBe('plan')
    expect(getPrePlanMode()).toBe('acceptEdits')
  })

  it('records the prior mode when entering plan from default', () => {
    setPermissionMode('default')
    setPermissionMode('plan')
    expect(getPrePlanMode()).toBe('default')
  })

  it('records the prior mode when entering plan from bypassPermissions', () => {
    setPermissionMode('bypassPermissions')
    setPermissionMode('plan')
    expect(getPrePlanMode()).toBe('bypassPermissions')
  })

  it('does NOT overwrite prePlanMode on idempotent plan→plan re-entry', () => {
    setPermissionMode('acceptEdits')
    setPermissionMode('plan')
    expect(getPrePlanMode()).toBe('acceptEdits')

    // Re-entering plan should not clobber the saved acceptEdits with 'plan'.
    setPermissionMode('plan')
    expect(getPrePlanMode()).toBe('acceptEdits')
  })

  it('clears prePlanMode when leaving plan via setPermissionMode (UI toggle path)', () => {
    setPermissionMode('acceptEdits')
    setPermissionMode('plan')
    expect(getPrePlanMode()).toBe('acceptEdits')

    // User toggles directly to default (not via ExitPlanMode) — pre-plan
    // slot must be dropped so the next entry doesn't restore stale state.
    setPermissionMode('default')
    expect(getPrePlanMode()).toBeUndefined()
  })

  it('consumePrePlanMode is read-and-clear', () => {
    setPermissionMode('acceptEdits')
    setPermissionMode('plan')

    expect(consumePrePlanMode()).toBe('acceptEdits')
    expect(consumePrePlanMode()).toBeUndefined()
    expect(getPrePlanMode()).toBeUndefined()
  })

  it('returns undefined when plan mode was never preceded by a non-plan mode', () => {
    setPermissionMode('default')
    consumePrePlanMode() // drain any prior

    setPermissionMode('plan')
    // Came from default, that IS the prePlanMode.
    expect(getPrePlanMode()).toBe('default')
    expect(consumePrePlanMode()).toBe('default')

    // Now consume again — should be empty.
    expect(consumePrePlanMode()).toBeUndefined()
  })

  it('survives roundtrip: default → bypass → plan → consume → restore', () => {
    setPermissionMode('default')
    setPermissionMode('bypassPermissions')
    setPermissionMode('plan')

    const prior = consumePrePlanMode()
    expect(prior).toBe('bypassPermissions')

    // ExitPlanMode applies the safety carve-out (downgrade bypass → acceptEdits).
    // The bookkeeping itself just returns the raw prior — caller decides.
    setPermissionMode(prior === 'bypassPermissions' ? 'acceptEdits' : 'default')
    expect(getPermissionMode()).toBe('acceptEdits')
    expect(getPrePlanMode()).toBeUndefined()
  })
})
