import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../agents/bundles/bundleRegistryQueries', () => ({
  // Factory default is `undefined` (can't reference helpers here — vi.mock
  // is hoisted); the `beforeEach` below re-points it at a code-dev stub so
  // the historical gate-on tests run against the affirmative code policy.
  // Since the 2026-07 fix, no-active-bundle resolves to `'none'` (gate OFF).
  getActiveBundle: vi.fn(() => undefined),
}))

vi.mock('../../agents/agentContext', () => ({
  getAgentContext: vi.fn(() => ({
    agentId: 'main',
    streamConversationId: 'conv-gate-1',
  })),
}))

import {
  VERIFICATION_GATE_MARKER,
  VERIFICATION_PENDING_REMINDER_MARKER,
  activeBundleUsesCodeVerification,
  getActiveBundleVerificationPolicy,
  buildVerificationGateDirective,
  buildVerificationGateSignal,
  buildVerificationPendingReminderText,
  shouldFireVerificationGate,
  withEphemeralVerificationPendingReminder,
} from './verificationGate'
import { getAgentContext } from '../../agents/agentContext'
import type { BundleExecutionPolicy } from '../../agents/bundles/types'
import {
  __resetVerificationGateStateForTests,
  noteWorkspaceMutation,
  recordVerificationVerdict,
  getVerificationGateState,
} from '../../planning/verificationGateState'
import { getActiveBundle } from '../../agents/bundles/bundleRegistryQueries'
import { decideIterationOutcome } from './iterationDecision'
import type { StopFamilyHookOutcome } from '../../tools/hooks/engine'

const CONV = 'conv-gate-1'

/** Minimal bundle stub — `activeBundleUsesCodeVerification` only reads `meta.id`. */
const bundleWithId = (id: string) => ({ meta: { id } }) as unknown as ReturnType<typeof getActiveBundle>

/** Bundle stub carrying an explicit executionPolicy (id is incidental). */
const bundleWithPolicy = (id: string, executionPolicy: BundleExecutionPolicy) =>
  ({ meta: { id }, executionPolicy }) as unknown as ReturnType<typeof getActiveBundle>

beforeEach(() => {
  // Affirmative code policy by default — tests exercising other bundles /
  // the no-bundle fallback override this explicitly.
  vi.mocked(getActiveBundle).mockReturnValue(bundleWithId('code-dev'))
  vi.mocked(getAgentContext).mockReturnValue({
    agentId: 'main',
    streamConversationId: CONV,
  } as ReturnType<typeof getAgentContext>)
})

afterEach(() => {
  __resetVerificationGateStateForTests()
  delete process.env.POLE_VERIFICATION_GATE
})

const noStop: StopFamilyHookOutcome = { kind: 'neutral' }

describe('shouldFireVerificationGate', () => {
  it('does not fire without an entry', () => {
    expect(shouldFireVerificationGate(undefined)).toBe(false)
  })

  it('fires after the first mutation at the code-dev default threshold', () => {
    expect(
      shouldFireVerificationGate({ needsVerification: true, mutationCount: 1 }),
    ).toBe(true)
  })

  it('fires for substantive unverified edits', () => {
    expect(
      shouldFireVerificationGate({ needsVerification: true, mutationCount: 3 }),
    ).toBe(true)
  })

  it('fires when the last verdict was FAIL', () => {
    expect(
      shouldFireVerificationGate({
        needsVerification: true,
        mutationCount: 5,
        lastVerdict: 'FAIL',
      }),
    ).toBe(true)
  })

  it('does not fire once verification is no longer needed (PASS cleared it)', () => {
    expect(
      shouldFireVerificationGate({
        needsVerification: false,
        mutationCount: 0,
        lastVerdict: 'PASS',
      }),
    ).toBe(false)
  })
})

describe('buildVerificationGateDirective', () => {
  it('uses the never-verified variant by default', () => {
    const body = buildVerificationGateDirective({
      needsVerification: true,
      mutationCount: 4,
    })
    expect(body).toContain(VERIFICATION_GATE_MARKER)
    expect(body).toContain('Verification agent')
    expect(body).toContain('4 workspace file edit(s)')
  })

  it('uses the FAIL variant and quotes the report excerpt', () => {
    const body = buildVerificationGateDirective({
      needsVerification: true,
      mutationCount: 4,
      lastVerdict: 'FAIL',
      failDetail: 'build error: TS2304',
    })
    expect(body).toContain('VERDICT: FAIL')
    expect(body).toContain('build error: TS2304')
  })
})

describe('buildVerificationGateSignal', () => {
  it('returns undefined when disabled via env', () => {
    process.env.POLE_VERIFICATION_GATE = '0'
    noteWorkspaceMutation(CONV)
    noteWorkspaceMutation(CONV)
    noteWorkspaceMutation(CONV)
    expect(buildVerificationGateSignal(CONV)).toBeUndefined()
  })

  it('returns a directive once the gate condition holds', () => {
    noteWorkspaceMutation(CONV)
    const sig = buildVerificationGateSignal(CONV)
    expect(sig?.directiveBody).toContain(VERIFICATION_GATE_MARKER)
  })

  it('returns undefined after a PASS clears the gate', () => {
    noteWorkspaceMutation(CONV)
    noteWorkspaceMutation(CONV)
    noteWorkspaceMutation(CONV)
    recordVerificationVerdict(CONV, 'PASS')
    expect(getVerificationGateState(CONV)?.needsVerification).toBe(false)
    expect(buildVerificationGateSignal(CONV)).toBeUndefined()
  })

  it('fires for the coding bundle (code-dev)', () => {
    vi.mocked(getActiveBundle).mockReturnValue(bundleWithId('code-dev'))
    noteWorkspaceMutation(CONV)
    expect(buildVerificationGateSignal(CONV)?.directiveBody).toContain(
      VERIFICATION_GATE_MARKER,
    )
  })

  it('is suppressed for a non-coding bundle (writing-assistant)', () => {
    vi.mocked(getActiveBundle).mockReturnValue(bundleWithId('writing-assistant'))
    noteWorkspaceMutation(CONV)
    noteWorkspaceMutation(CONV)
    noteWorkspaceMutation(CONV)
    expect(buildVerificationGateSignal(CONV)).toBeUndefined()
  })

  it('is suppressed for a user-created / imported bundle', () => {
    vi.mocked(getActiveBundle).mockReturnValue(bundleWithId('my-custom-bundle'))
    noteWorkspaceMutation(CONV)
    noteWorkspaceMutation(CONV)
    noteWorkspaceMutation(CONV)
    expect(buildVerificationGateSignal(CONV)).toBeUndefined()
  })

  it('is suppressed when no bundle is active (registry not hydrated / early boot)', () => {
    vi.mocked(getActiveBundle).mockReturnValue(undefined)
    noteWorkspaceMutation(CONV)
    noteWorkspaceMutation(CONV)
    noteWorkspaceMutation(CONV)
    expect(buildVerificationGateSignal(CONV)).toBeUndefined()
  })
})

describe('activeBundleUsesCodeVerification', () => {
  it('is true for code-dev', () => {
    vi.mocked(getActiveBundle).mockReturnValue(bundleWithId('code-dev'))
    expect(activeBundleUsesCodeVerification()).toBe(true)
  })

  it('is false for writing / general / custom bundles', () => {
    for (const id of ['writing-assistant', 'general-assistant', 'my-imported']) {
      vi.mocked(getActiveBundle).mockReturnValue(bundleWithId(id))
      expect(activeBundleUsesCodeVerification()).toBe(false)
    }
  })

  it('is false when no bundle is active — never force code verification on an unresolved work package', () => {
    vi.mocked(getActiveBundle).mockReturnValue(undefined)
    expect(activeBundleUsesCodeVerification()).toBe(false)
    expect(getActiveBundleVerificationPolicy().kind).toBe('none')
  })
})

describe('getActiveBundleVerificationPolicy — executionPolicy overrides id', () => {
  it('a user-forked coding bundle opts INTO code verification via policy', () => {
    vi.mocked(getActiveBundle).mockReturnValue(
      bundleWithPolicy('my-rust-shop', { verification: { kind: 'code' } }),
    )
    expect(getActiveBundleVerificationPolicy().kind).toBe('code')
    expect(activeBundleUsesCodeVerification()).toBe(true)
  })

  it('an explicit none policy opts code-dev OUT of host code verification', () => {
    vi.mocked(getActiveBundle).mockReturnValue(
      bundleWithPolicy('code-dev', { verification: { kind: 'none' } }),
    )
    expect(getActiveBundleVerificationPolicy().kind).toBe('none')
    expect(activeBundleUsesCodeVerification()).toBe(false)
  })

  it('self-review / delegate policies are not code verification', () => {
    vi.mocked(getActiveBundle).mockReturnValue(
      bundleWithPolicy('writing', { verification: { kind: 'self-review' } }),
    )
    expect(getActiveBundleVerificationPolicy().kind).toBe('self-review')
    expect(activeBundleUsesCodeVerification()).toBe(false)

    vi.mocked(getActiveBundle).mockReturnValue(
      bundleWithPolicy('legal', { verification: { kind: 'delegate', agentType: 'Reviewer' } }),
    )
    expect(getActiveBundleVerificationPolicy().kind).toBe('delegate')
    expect(activeBundleUsesCodeVerification()).toBe(false)
  })

  it('falls back to legacy id behaviour when no policy is declared', () => {
    vi.mocked(getActiveBundle).mockReturnValue(bundleWithId('code-dev'))
    expect(getActiveBundleVerificationPolicy().kind).toBe('code')
    vi.mocked(getActiveBundle).mockReturnValue(bundleWithId('writing-assistant'))
    expect(getActiveBundleVerificationPolicy().kind).toBe('none')
  })
})

describe('withEphemeralVerificationPendingReminder — 验证节点前移 (pre-declaration reminder)', () => {
  const baseMessages = () => [
    { role: 'user', content: 'fix the bug' },
    { role: 'assistant', content: [{ type: 'text', text: 'working on it' }] },
  ]

  const armGate = () => {
    noteWorkspaceMutation(CONV)
    noteWorkspaceMutation(CONV)
    noteWorkspaceMutation(CONV)
  }

  it('appends the reminder while the gate is armed (code policy)', () => {
    armGate()
    const msgs = baseMessages()
    const out = withEphemeralVerificationPendingReminder(msgs)
    expect(out).not.toBe(msgs)
    expect(JSON.stringify(out)).toContain(VERIFICATION_PENDING_REMINDER_MARKER)
    // Input never mutated.
    expect(JSON.stringify(msgs)).not.toContain(VERIFICATION_PENDING_REMINDER_MARKER)
  })

  it('is a no-op (same reference) when the gate is not armed', () => {
    const msgs = baseMessages()
    expect(withEphemeralVerificationPendingReminder(msgs)).toBe(msgs)
  })

  it('is a no-op after inline verification / PASS cleared the gate', () => {
    armGate()
    recordVerificationVerdict(CONV, 'PASS')
    const msgs = baseMessages()
    expect(withEphemeralVerificationPendingReminder(msgs)).toBe(msgs)
  })

  it('requires verification after the first successful code mutation by default', () => {
    noteWorkspaceMutation(CONV)
    const msgs = baseMessages()
    expect(withEphemeralVerificationPendingReminder(msgs)).not.toBe(msgs)
    expect(JSON.stringify(withEphemeralVerificationPendingReminder(msgs))).toContain(
      VERIFICATION_PENDING_REMINDER_MARKER,
    )
  })

  it('is a no-op for non-code work packages (imported bundle)', () => {
    vi.mocked(getActiveBundle).mockReturnValue(bundleWithId('my-imported'))
    armGate()
    const msgs = baseMessages()
    expect(withEphemeralVerificationPendingReminder(msgs)).toBe(msgs)
  })

  it('is a no-op when no bundle is active', () => {
    vi.mocked(getActiveBundle).mockReturnValue(undefined)
    armGate()
    const msgs = baseMessages()
    expect(withEphemeralVerificationPendingReminder(msgs)).toBe(msgs)
  })

  it('is a no-op for sub-agents', () => {
    vi.mocked(getAgentContext).mockReturnValue({
      agentId: 'agent-123',
      streamConversationId: CONV,
    } as ReturnType<typeof getAgentContext>)
    armGate()
    const msgs = baseMessages()
    expect(withEphemeralVerificationPendingReminder(msgs)).toBe(msgs)
  })

  it('is a no-op when disabled via env', () => {
    process.env.POLE_VERIFICATION_GATE = '0'
    armGate()
    const msgs = baseMessages()
    expect(withEphemeralVerificationPendingReminder(msgs)).toBe(msgs)
  })

  it('reminder text carries the mutation count and the FAIL tail when applicable', () => {
    const body = buildVerificationPendingReminderText({
      needsVerification: true,
      mutationCount: 5,
      lastVerdict: 'FAIL',
      failDetail: 'TS2304',
    })
    expect(body).toContain('5 workspace file edit(s)')
    expect(body).toContain('VERDICT: FAIL')
    const noFail = buildVerificationPendingReminderText({
      needsVerification: true,
      mutationCount: 3,
    })
    expect(noFail).not.toContain('VERDICT: FAIL')
  })
})

describe('decideIterationOutcome — row 12d (verification gate)', () => {
  it('intercepts a would-be completed when the gate signal is present', () => {
    const outcome = decideIterationOutcome({
      noToolUse: {
        interAgentInjected: false,
        stopHook: noStop,
        stopHookActiveSkipped: false,
        circuitBreakerWouldTrip: false,
        verificationGate: { directiveBody: 'VERIFY NOW' },
      },
    })
    expect(outcome.kind).toBe('continue')
    if (outcome.kind === 'continue') {
      expect(outcome.injectUserContent).toBe('VERIFY NOW')
      expect(outcome.transition).toBe('no_tool_use_continue')
    }
  })

  it('is lower priority than the all-tools-failed guard', () => {
    const outcome = decideIterationOutcome({
      noToolUse: {
        interAgentInjected: false,
        stopHook: noStop,
        stopHookActiveSkipped: false,
        circuitBreakerWouldTrip: false,
        allToolsFailedGuard: { directiveBody: 'RETRY' },
        verificationGate: { directiveBody: 'VERIFY NOW' },
      },
    })
    expect(outcome.kind).toBe('continue')
    if (outcome.kind === 'continue') {
      expect(outcome.injectUserContent).toBe('RETRY')
    }
  })

  it('still terminates completed when no gate signal is present', () => {
    const outcome = decideIterationOutcome({
      noToolUse: {
        interAgentInjected: false,
        stopHook: noStop,
        stopHookActiveSkipped: false,
        circuitBreakerWouldTrip: false,
      },
    })
    expect(outcome.kind).toBe('terminate')
    if (outcome.kind === 'terminate') {
      expect(outcome.reason).toBe('completed')
    }
  })

  it('terminates non-complete when the bounded verification continuation was ignored', () => {
    const outcome = decideIterationOutcome({
      noToolUse: {
        interAgentInjected: false,
        stopHook: noStop,
        stopHookActiveSkipped: false,
        circuitBreakerWouldTrip: false,
        verificationGateBlocked: { detail: 'verification still pending' },
      },
    })
    expect(outcome).toMatchObject({
      kind: 'terminate',
      reason: 'verification_required',
      errorDetail: 'verification still pending',
    })
  })
})
