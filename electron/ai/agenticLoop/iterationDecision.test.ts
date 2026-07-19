/**
 * P1 — Unit tests for `decideIterationOutcome`.
 *
 * Each row in the priority table at the top of `iterationDecision.ts`
 * gets a dedicated test here. Plus a handful of boundary cases that
 * lock in invariants the legacy `if/else` chain implicitly preserved
 * but never had a name for:
 *   - circuit-breaker BEATS preventStop / blockingError / interAgent;
 *   - forceStop BEATS circuit-breaker (a forced stop should not be
 *     reclassified as a runaway hook);
 *   - blank `injectUserContent` falls through (preventStop with empty
 *     content does NOT continue);
 *   - empty signal envelope baselines to `continue` (the legacy
 *     "tool_use produced — proceed" default).
 */

import { describe, expect, it } from 'vitest'
import { decideIterationOutcome, type IterationDecisionSignals } from './iterationDecision'
import type { StopFamilyHookOutcome } from '../../tools/hooks/engine'

// ─────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────

const neutral: StopFamilyHookOutcome = { kind: 'neutral' }
const forceStop: StopFamilyHookOutcome = {
  kind: 'forceStop',
  errorDetail: 'admin abort',
  hookName: 'admin-hook',
}
const blockingError: StopFamilyHookOutcome = {
  kind: 'blockingError',
  errorMessage: 'lint failed',
  hookName: 'lint-hook',
}
const preventStop: StopFamilyHookOutcome = {
  kind: 'preventStop',
  appendUserContent: 'please continue',
  hookName: 'continue-hook',
}

function ntuBase(
  stopHook: StopFamilyHookOutcome = neutral,
  overrides: Partial<NonNullable<IterationDecisionSignals['noToolUse']>> = {},
): NonNullable<IterationDecisionSignals['noToolUse']> {
  return {
    interAgentInjected: false,
    stopHook,
    stopHookActiveSkipped: false,
    circuitBreakerWouldTrip: false,
    ...overrides,
  }
}

// ─────────────────────────────────────────────────────────────────────
// Priority table — one test per row
// ─────────────────────────────────────────────────────────────────────

describe('decideIterationOutcome — priority table (16 rows)', () => {
  it('row 1: preStreamAbort → terminate aborted_streaming', () => {
    const out = decideIterationOutcome({
      preStreamAbort: { reason: 'aborted_streaming' },
    })
    expect(out).toEqual({
      kind: 'terminate',
      reason: 'aborted_streaming',
      writeStrategy: 'caller_writes_termination',
    })
  })

  it('row 2: boundaryHookStop → terminate iteration_boundary_stopped', () => {
    const out = decideIterationOutcome({ boundaryHookStop: true })
    expect(out.kind).toBe('terminate')
    if (out.kind === 'terminate') {
      expect(out.reason).toBe('iteration_boundary_stopped')
    }
  })

  it('row 3: preModelTerminated → terminate phase_wrote_termination', () => {
    const out = decideIterationOutcome({ preModelTerminated: true })
    expect(out.kind).toBe('terminate')
    if (out.kind === 'terminate') {
      expect(out.writeStrategy).toBe('phase_wrote_termination')
    }
  })

  it('row 4: blockingLimitHard → terminate blocking_limit', () => {
    const out = decideIterationOutcome({ blockingLimitHard: true })
    expect(out.kind).toBe('terminate')
    if (out.kind === 'terminate') {
      expect(out.reason).toBe('blocking_limit')
      expect(out.errorDetail).toMatch(/blocking threshold/i)
    }
  })

  it('row 5: phaseWroteTermination → terminate phase_wrote_termination', () => {
    const out = decideIterationOutcome({ phaseWroteTermination: true })
    expect(out.kind).toBe('terminate')
    if (out.kind === 'terminate') {
      expect(out.writeStrategy).toBe('phase_wrote_termination')
    }
  })

  it('row 6: postStreamAbort → terminate aborted_streaming', () => {
    const out = decideIterationOutcome({
      postStreamAbort: { reason: 'aborted_streaming' },
    })
    expect(out.kind).toBe('terminate')
    if (out.kind === 'terminate') {
      expect(out.reason).toBe('aborted_streaming')
    }
  })

  it('row 7: noToolUse.stopHook=forceStop → terminate stop_hook_prevented', () => {
    const out = decideIterationOutcome({ noToolUse: ntuBase(forceStop) })
    expect(out.kind).toBe('terminate')
    if (out.kind === 'terminate') {
      expect(out.reason).toBe('stop_hook_prevented')
      expect(out.errorDetail).toBe('admin abort')
      expect(out.hookName).toBe('admin-hook')
    }
  })

  it('row 8: noToolUse.circuitBreakerWouldTrip → terminate stop_hook_circuit_breaker', () => {
    const out = decideIterationOutcome({
      noToolUse: ntuBase(blockingError, {
        circuitBreakerWouldTrip: true,
        circuitBreakerHookName: 'lint-hook',
      }),
    })
    expect(out.kind).toBe('terminate')
    if (out.kind === 'terminate') {
      expect(out.reason).toBe('stop_hook_circuit_breaker')
      expect(out.hookName).toBe('lint-hook')
    }
  })

  it('row 9: noToolUse.interAgentInjected → continue no_tool_use_continue (no inject)', () => {
    const out = decideIterationOutcome({
      noToolUse: ntuBase(neutral, { interAgentInjected: true }),
    })
    expect(out).toEqual({
      kind: 'continue',
      transition: 'no_tool_use_continue',
      sourceRow: '9',
    })
  })

  it('row 10: noToolUse.stopHook=blockingError → continue stop_hook_continue + inject error message', () => {
    const out = decideIterationOutcome({ noToolUse: ntuBase(blockingError) })
    expect(out.kind).toBe('continue')
    if (out.kind === 'continue') {
      expect(out.transition).toBe('stop_hook_continue')
      expect(out.injectUserContent).toBe('lint failed')
    }
  })

  it('row 11: noToolUse.stopHook=preventStop → continue stop_hook_continue + inject appendUserContent', () => {
    const out = decideIterationOutcome({ noToolUse: ntuBase(preventStop) })
    expect(out.kind).toBe('continue')
    if (out.kind === 'continue') {
      expect(out.transition).toBe('stop_hook_continue')
      expect(out.injectUserContent).toBe('please continue')
    }
  })

  it('row 12: tokenBudgetReminder → continue no_tool_use_continue + inject reminder', () => {
    const out = decideIterationOutcome({
      noToolUse: ntuBase(neutral, { tokenBudgetReminder: 'keep going' }),
    })
    expect(out).toEqual({
      kind: 'continue',
      transition: 'no_tool_use_continue',
      sourceRow: '12',
      injectUserContent: 'keep going',
    })
  })

  it('row 12a: activeTodoPanelGuard → continue no_tool_use_continue + inject directive (genericConvertedSystem)', () => {
    const out = decideIterationOutcome({
      noToolUse: ntuBase(neutral, {
        activeTodoPanelGuard: {
          itemCount: 2,
          directiveBody:
            '[Active TodoWrite items — turn cannot end yet]\n\nfinish task X and Y',
        },
      }),
    })
    expect(out.kind).toBe('continue')
    if (out.kind === 'continue') {
      expect(out.transition).toBe('no_tool_use_continue')
      expect(out.injectUserContent).toMatch(/Active TodoWrite items/)
      expect(out.injectSideChannelKind).toBe('generic_converted_system')
    }
  })

  it('row 12a: blank directiveBody falls through to row 13 completed (does not continue with empty)', () => {
    const out = decideIterationOutcome({
      noToolUse: ntuBase(neutral, {
        activeTodoPanelGuard: { itemCount: 1, directiveBody: '   ' },
      }),
    })
    expect(out.kind).toBe('terminate')
    if (out.kind === 'terminate') {
      expect(out.reason).toBe('completed')
    }
  })

  it('row 12a2: planStepGuard → continue no_tool_use_continue + inject directive (genericConvertedSystem)', () => {
    const out = decideIterationOutcome({
      noToolUse: ntuBase(neutral, {
        planStepGuard: {
          openCount: 3,
          directiveBody: '[Active plan — step driver] turn cannot end yet\n\nCurrent step: do X',
        },
      }),
    })
    expect(out.kind).toBe('continue')
    if (out.kind === 'continue') {
      expect(out.transition).toBe('no_tool_use_continue')
      expect(out.injectUserContent).toMatch(/Active plan/)
      expect(out.injectSideChannelKind).toBe('generic_converted_system')
    }
  })

  it('row 12a2: activeTodoPanelGuard (12a) beats planStepGuard (12a2)', () => {
    const out = decideIterationOutcome({
      noToolUse: ntuBase(neutral, {
        activeTodoPanelGuard: { itemCount: 1, directiveBody: 'TODO directive' },
        planStepGuard: { openCount: 2, directiveBody: 'PLAN directive' },
      }),
    })
    expect(out.kind).toBe('continue')
    if (out.kind === 'continue') {
      expect(out.injectUserContent).toBe('TODO directive')
    }
  })

  it('row 12a2: planStepGuard beats declaredIntentGuard (12a2 > 12b)', () => {
    const out = decideIterationOutcome({
      noToolUse: ntuBase(neutral, {
        planStepGuard: { openCount: 2, directiveBody: 'PLAN directive' },
        declaredIntentGuard: { directiveBody: 'INTENT directive' },
      }),
    })
    expect(out.kind).toBe('continue')
    if (out.kind === 'continue') {
      expect(out.injectUserContent).toBe('PLAN directive')
    }
  })

  it('row 12a2: blank planStepGuard directiveBody falls through to completed', () => {
    const out = decideIterationOutcome({
      noToolUse: ntuBase(neutral, {
        planStepGuard: { openCount: 1, directiveBody: '   ' },
      }),
    })
    expect(out.kind).toBe('terminate')
    if (out.kind === 'terminate') {
      expect(out.reason).toBe('completed')
    }
  })

  it('row 12a3: planlessImplementationGuard → continue + inject directive', () => {
    const out = decideIterationOutcome({
      noToolUse: ntuBase(neutral, {
        planlessImplementationGuard: { directiveBody: 'PLANLESS directive' },
      }),
    })
    expect(out.kind).toBe('continue')
    if (out.kind === 'continue') {
      expect(out.injectUserContent).toBe('PLANLESS directive')
      expect(out.injectSideChannelKind).toBe('generic_converted_system')
    }
  })

  it('row 12a3: planStepGuard (12a2) beats planlessImplementationGuard (12a3)', () => {
    const out = decideIterationOutcome({
      noToolUse: ntuBase(neutral, {
        planStepGuard: { openCount: 1, directiveBody: 'PLAN directive' },
        planlessImplementationGuard: { directiveBody: 'PLANLESS directive' },
      }),
    })
    expect(out.kind).toBe('continue')
    if (out.kind === 'continue') {
      expect(out.injectUserContent).toBe('PLAN directive')
    }
  })

  it('row 12a3: planlessImplementationGuard beats declaredIntentGuard (12a3 > 12b)', () => {
    const out = decideIterationOutcome({
      noToolUse: ntuBase(neutral, {
        planlessImplementationGuard: { directiveBody: 'PLANLESS directive' },
        declaredIntentGuard: { directiveBody: 'INTENT directive' },
      }),
    })
    expect(out.kind).toBe('continue')
    if (out.kind === 'continue') {
      expect(out.injectUserContent).toBe('PLANLESS directive')
    }
  })

  it('row 13: noToolUse with no continuation signals → terminate completed', () => {
    const out = decideIterationOutcome({ noToolUse: ntuBase() })
    expect(out.kind).toBe('terminate')
    if (out.kind === 'terminate') {
      expect(out.reason).toBe('completed')
    }
  })

  it('row 14: postToolAbort.iterationExhausted → terminate aborted_tools (SA-2 fix 3: cancel wins over max_turns)', () => {
    const out = decideIterationOutcome({
      postToolAbort: { iterationExhausted: true },
    })
    expect(out.kind).toBe('terminate')
    if (out.kind === 'terminate') {
      expect(out.reason).toBe('aborted_tools')
    }
  })

  it('row 15: postToolAbort (no iterationExhausted) → terminate aborted_tools', () => {
    const out = decideIterationOutcome({
      postToolAbort: { iterationExhausted: false },
    })
    expect(out.kind).toBe('terminate')
    if (out.kind === 'terminate') {
      expect(out.reason).toBe('aborted_tools')
    }
  })

  it('row 16: pendingHookStop → terminate hook_stopped (with hookName + detail)', () => {
    const out = decideIterationOutcome({
      pendingHookStop: { reason: 'PostToolUse hook said stop', hookName: 'guardrail' },
    })
    expect(out.kind).toBe('terminate')
    if (out.kind === 'terminate') {
      expect(out.reason).toBe('hook_stopped')
      expect(out.hookName).toBe('guardrail')
      expect(out.errorDetail).toBe('PostToolUse hook said stop')
    }
  })

  it('row 17 (default): empty signals → continue tool_use baseline', () => {
    const out = decideIterationOutcome({})
    expect(out).toEqual({ kind: 'continue', transition: 'tool_use', sourceRow: '17' })
  })
})

// ─────────────────────────────────────────────────────────────────────
// Boundary cases — invariants implicit in the legacy if/else chain
// ─────────────────────────────────────────────────────────────────────

describe('decideIterationOutcome — boundary invariants', () => {
  it('preStreamAbort beats every later signal (top-of-priority wins)', () => {
    const out = decideIterationOutcome({
      preStreamAbort: { reason: 'aborted_streaming' },
      blockingLimitHard: true,
      phaseWroteTermination: true,
      noToolUse: ntuBase(forceStop),
      postToolAbort: { iterationExhausted: true },
      pendingHookStop: { reason: 'ignored' },
    })
    expect(out.kind).toBe('terminate')
    if (out.kind === 'terminate') {
      expect(out.reason).toBe('aborted_streaming')
    }
  })

  it('forceStop beats circuitBreaker (forced stop is intentional, not runaway)', () => {
    const out = decideIterationOutcome({
      noToolUse: ntuBase(forceStop, {
        circuitBreakerWouldTrip: true,
        circuitBreakerHookName: 'lint-hook',
      }),
    })
    expect(out.kind).toBe('terminate')
    if (out.kind === 'terminate') {
      expect(out.reason).toBe('stop_hook_prevented')
    }
  })

  it('circuitBreaker beats interAgentInjected (safety > drainage)', () => {
    const out = decideIterationOutcome({
      noToolUse: ntuBase(preventStop, {
        interAgentInjected: true,
        circuitBreakerWouldTrip: true,
      }),
    })
    expect(out.kind).toBe('terminate')
    if (out.kind === 'terminate') {
      expect(out.reason).toBe('stop_hook_circuit_breaker')
    }
  })

  it('circuitBreaker beats tokenBudgetReminder (safety > nudge)', () => {
    const out = decideIterationOutcome({
      noToolUse: ntuBase(neutral, {
        tokenBudgetReminder: 'keep going',
        circuitBreakerWouldTrip: true,
      }),
    })
    expect(out.kind).toBe('terminate')
    if (out.kind === 'terminate') {
      expect(out.reason).toBe('stop_hook_circuit_breaker')
    }
  })

  it('blank preventStop content falls through to tokenBudget (does not continue with empty)', () => {
    const blankPreventStop: StopFamilyHookOutcome = {
      kind: 'preventStop',
      appendUserContent: '   ',
      hookName: 'noisy',
    }
    const out = decideIterationOutcome({
      noToolUse: ntuBase(blankPreventStop, {
        tokenBudgetReminder: 'budget reminder',
      }),
    })
    expect(out.kind).toBe('continue')
    if (out.kind === 'continue') {
      expect(out.transition).toBe('no_tool_use_continue')
      expect(out.injectUserContent).toBe('budget reminder')
    }
  })

  it('blank tokenBudgetReminder is the same as absent (falls through to completed)', () => {
    const out = decideIterationOutcome({
      noToolUse: ntuBase(neutral, { tokenBudgetReminder: '   ' }),
    })
    expect(out.kind).toBe('terminate')
    if (out.kind === 'terminate') {
      expect(out.reason).toBe('completed')
    }
  })

  it('forceStop with blank errorDetail still terminates with default detail string', () => {
    const blankForceStop: StopFamilyHookOutcome = {
      kind: 'forceStop',
      errorDetail: '   ',
    }
    const out = decideIterationOutcome({ noToolUse: ntuBase(blankForceStop) })
    expect(out.kind).toBe('terminate')
    if (out.kind === 'terminate') {
      expect(out.reason).toBe('stop_hook_prevented')
      expect(out.errorDetail).toMatch(/terminal stop/)
    }
  })

  // ── Row 12a (active-todo guard) priority invariants ───────────────
  // The guard is intentionally LOWER priority than every other no-tool
  // row. These tests pin that ordering so a future refactor can't
  // accidentally promote the guard above a safety net.

  const guardSignal = {
    itemCount: 1,
    directiveBody: '[Active TodoWrite items — turn cannot end yet]\n\nfinish X',
  }

  it('forceStop beats activeTodoPanelGuard (explicit hard override wins)', () => {
    const out = decideIterationOutcome({
      noToolUse: ntuBase(forceStop, { activeTodoPanelGuard: guardSignal }),
    })
    expect(out.kind).toBe('terminate')
    if (out.kind === 'terminate') {
      expect(out.reason).toBe('stop_hook_prevented')
    }
  })

  it('circuitBreaker beats activeTodoPanelGuard (safety net wins over guard)', () => {
    const out = decideIterationOutcome({
      noToolUse: ntuBase(blockingError, {
        circuitBreakerWouldTrip: true,
        activeTodoPanelGuard: guardSignal,
      }),
    })
    expect(out.kind).toBe('terminate')
    if (out.kind === 'terminate') {
      expect(out.reason).toBe('stop_hook_circuit_breaker')
    }
  })

  it('iteration_stalled beats activeTodoPanelGuard (safety net wins over guard)', () => {
    const out = decideIterationOutcome({
      noToolUse: ntuBase(neutral, {
        stallTripped: { message: 'no progress', consecutiveCount: 5 },
        activeTodoPanelGuard: guardSignal,
      }),
    })
    expect(out.kind).toBe('terminate')
    if (out.kind === 'terminate') {
      expect(out.reason).toBe('iteration_stalled')
    }
  })

  it('interAgentInjected beats activeTodoPanelGuard (drainage runs before guard)', () => {
    const out = decideIterationOutcome({
      noToolUse: ntuBase(neutral, {
        interAgentInjected: true,
        activeTodoPanelGuard: guardSignal,
      }),
    })
    expect(out).toEqual({
      kind: 'continue',
      transition: 'no_tool_use_continue',
      sourceRow: '9',
    })
  })

  it('blockingError continuation beats activeTodoPanelGuard (hook context wins)', () => {
    const out = decideIterationOutcome({
      noToolUse: ntuBase(blockingError, { activeTodoPanelGuard: guardSignal }),
    })
    expect(out.kind).toBe('continue')
    if (out.kind === 'continue') {
      expect(out.transition).toBe('stop_hook_continue')
      expect(out.injectUserContent).toBe('lint failed')
      expect(out.injectSideChannelKind).toBeUndefined()
    }
  })

  it('preventStop continuation beats activeTodoPanelGuard (hook context wins)', () => {
    const out = decideIterationOutcome({
      noToolUse: ntuBase(preventStop, { activeTodoPanelGuard: guardSignal }),
    })
    expect(out.kind).toBe('continue')
    if (out.kind === 'continue') {
      expect(out.transition).toBe('stop_hook_continue')
      expect(out.injectUserContent).toBe('please continue')
      expect(out.injectSideChannelKind).toBeUndefined()
    }
  })

  it('tokenBudgetReminder beats activeTodoPanelGuard (budget message wins)', () => {
    const out = decideIterationOutcome({
      noToolUse: ntuBase(neutral, {
        tokenBudgetReminder: 'keep going',
        activeTodoPanelGuard: guardSignal,
      }),
    })
    expect(out).toEqual({
      kind: 'continue',
      transition: 'no_tool_use_continue',
      sourceRow: '12',
      injectUserContent: 'keep going',
    })
  })

  it('postToolAbort (post-tool gate) is NOT reached when noToolUse is present + guard fires (no-tool branch sealed)', () => {
    const out = decideIterationOutcome({
      noToolUse: ntuBase(neutral, { activeTodoPanelGuard: guardSignal }),
      postToolAbort: { iterationExhausted: true },
    })
    expect(out.kind).toBe('continue')
    if (out.kind === 'continue') {
      expect(out.transition).toBe('no_tool_use_continue')
      expect(out.injectSideChannelKind).toBe('generic_converted_system')
    }
  })
})

// ─────────────────────────────────────────────────────────────────────
// Row 12b: declaredIntentGuard (2026-06 P2 fix — Symptom 2 core)
// ─────────────────────────────────────────────────────────────────────

const intentGuardSignal = {
  directiveBody:
    '[Declared intent without action — host check]\n\n' +
    'Your last reply announced an action you were about to take...',
}

// Re-define guardSignal here (also used in boundary invariants block above)
const todoGuardSignal = {
  itemCount: 2,
  directiveBody: '[Active TodoWrite items — turn cannot end yet]\n\nfinish task X and Y',
}

describe('decideIterationOutcome — row 12b declaredIntentGuard (Symptom 2)', () => {
  it('row 12b: declaredIntentGuard → continue no_tool_use_continue + inject directive', () => {
    const out = decideIterationOutcome({
      noToolUse: ntuBase(neutral, { declaredIntentGuard: intentGuardSignal }),
    })
    expect(out.kind).toBe('continue')
    if (out.kind === 'continue') {
      expect(out.transition).toBe('no_tool_use_continue')
      expect(out.injectUserContent).toMatch(/Declared intent without action/)
      expect(out.injectSideChannelKind).toBe('generic_converted_system')
    }
  })

  it('row 12b: blank directiveBody falls through to row 13 completed', () => {
    const out = decideIterationOutcome({
      noToolUse: ntuBase(neutral, {
        declaredIntentGuard: { directiveBody: '   ' },
      }),
    })
    expect(out.kind).toBe('terminate')
    if (out.kind === 'terminate') {
      expect(out.reason).toBe('completed')
    }
  })

  it('declaredIntentGuard priority: activeTodoPanelGuard beats it (row 12a > 12b)', () => {
    const out = decideIterationOutcome({
      noToolUse: ntuBase(neutral, {
        activeTodoPanelGuard: todoGuardSignal,
        declaredIntentGuard: intentGuardSignal,
      }),
    })
    expect(out.kind).toBe('continue')
    if (out.kind === 'continue') {
      expect(out.transition).toBe('no_tool_use_continue')
      expect(out.injectUserContent).toMatch(/Active TodoWrite items/)
    }
  })

  it('declaredIntentGuard priority: stallTripped beats it (row 8b safety > 12b)', () => {
    const out = decideIterationOutcome({
      noToolUse: ntuBase(neutral, {
        stallTripped: { message: 'no progress', consecutiveCount: 5 },
        declaredIntentGuard: intentGuardSignal,
      }),
    })
    expect(out.kind).toBe('terminate')
    if (out.kind === 'terminate') {
      expect(out.reason).toBe('iteration_stalled')
    }
  })

  it('declaredIntentGuard priority: circuitBreaker beats it (row 8 safety > 12b)', () => {
    const out = decideIterationOutcome({
      noToolUse: ntuBase(blockingError, {
        circuitBreakerWouldTrip: true,
        declaredIntentGuard: intentGuardSignal,
      }),
    })
    expect(out.kind).toBe('terminate')
    if (out.kind === 'terminate') {
      expect(out.reason).toBe('stop_hook_circuit_breaker')
    }
  })

  it('declaredIntentGuard priority: tokenBudgetReminder beats it (row 12 > 12b)', () => {
    const out = decideIterationOutcome({
      noToolUse: ntuBase(neutral, {
        tokenBudgetReminder: 'keep going',
        declaredIntentGuard: intentGuardSignal,
      }),
    })
    expect(out).toEqual({
      kind: 'continue',
      transition: 'no_tool_use_continue',
      sourceRow: '12',
      injectUserContent: 'keep going',
    })
  })

  it('declaredIntentGuard is LOWEST priority continuation — only above row 13 completed', () => {
    // When declaredIntentGuard is the ONLY signal, it fires
    const out = decideIterationOutcome({
      noToolUse: ntuBase(neutral, { declaredIntentGuard: intentGuardSignal }),
    })
    expect(out.kind).toBe('continue')
    // But any higher signal overrides it (verified in tests above)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Row 12c: allToolsFailedGuard (2026-06 Gap A fix — silent-stop audit)
// ─────────────────────────────────────────────────────────────────────

const allFailedSignal = {
  directiveBody:
    '[All tool calls failed — host check]\n\n' +
    'Every tool call in your previous step returned an error...',
}

describe('decideIterationOutcome — row 12c allToolsFailedGuard (Gap A)', () => {
  it('row 12c: allToolsFailedGuard → continue no_tool_use_continue + inject directive', () => {
    const out = decideIterationOutcome({
      noToolUse: ntuBase(neutral, { allToolsFailedGuard: allFailedSignal }),
    })
    expect(out.kind).toBe('continue')
    if (out.kind === 'continue') {
      expect(out.transition).toBe('no_tool_use_continue')
      expect(out.injectUserContent).toMatch(/All tool calls failed/)
      expect(out.injectSideChannelKind).toBe('generic_converted_system')
    }
  })

  it('row 12c: blank directiveBody falls through to row 13 completed', () => {
    const out = decideIterationOutcome({
      noToolUse: ntuBase(neutral, { allToolsFailedGuard: { directiveBody: '  ' } }),
    })
    expect(out.kind).toBe('terminate')
    if (out.kind === 'terminate') expect(out.reason).toBe('completed')
  })

  it('priority: declaredIntentGuard beats allToolsFailedGuard (row 12b > 12c)', () => {
    const out = decideIterationOutcome({
      noToolUse: ntuBase(neutral, {
        declaredIntentGuard: intentGuardSignal,
        allToolsFailedGuard: allFailedSignal,
      }),
    })
    expect(out.kind).toBe('continue')
    if (out.kind === 'continue') {
      expect(out.injectUserContent).toMatch(/Declared intent without action/)
    }
  })

  it('priority: activeTodoPanelGuard beats allToolsFailedGuard (row 12a > 12c)', () => {
    const out = decideIterationOutcome({
      noToolUse: ntuBase(neutral, {
        activeTodoPanelGuard: todoGuardSignal,
        allToolsFailedGuard: allFailedSignal,
      }),
    })
    expect(out.kind).toBe('continue')
    if (out.kind === 'continue') {
      expect(out.injectUserContent).toMatch(/Active TodoWrite items/)
    }
  })

  it('priority: stallTripped (safety net) beats allToolsFailedGuard (row 8b > 12c)', () => {
    const out = decideIterationOutcome({
      noToolUse: ntuBase(neutral, {
        stallTripped: { message: 'no progress', consecutiveCount: 5 },
        allToolsFailedGuard: allFailedSignal,
      }),
    })
    expect(out.kind).toBe('terminate')
    if (out.kind === 'terminate') expect(out.reason).toBe('iteration_stalled')
  })

  it('priority: tokenBudgetReminder beats allToolsFailedGuard (row 12 > 12c)', () => {
    const out = decideIterationOutcome({
      noToolUse: ntuBase(neutral, {
        tokenBudgetReminder: 'keep going',
        allToolsFailedGuard: allFailedSignal,
      }),
    })
    expect(out).toEqual({
      kind: 'continue',
      transition: 'no_tool_use_continue',
      sourceRow: '12',
      injectUserContent: 'keep going',
    })
  })
})

// ─────────────────────────────────────────────────────────────────────
// Row 12e — thinkingOnlySilentTurnGuard (Gap B)
// ─────────────────────────────────────────────────────────────────────

const thinkingOnlySignal = {
  directiveBody:
    '[Thinking-only turn, no visible reply — host check]\n\n' +
    'Your last turn produced only internal reasoning...',
}

describe('decideIterationOutcome — row 12e thinkingOnlySilentTurnGuard (Gap B)', () => {
  it('row 12e: thinkingOnlySilentTurnGuard → continue no_tool_use_continue + inject directive', () => {
    const out = decideIterationOutcome({
      noToolUse: ntuBase(neutral, { thinkingOnlySilentTurnGuard: thinkingOnlySignal }),
    })
    expect(out.kind).toBe('continue')
    if (out.kind === 'continue') {
      expect(out.transition).toBe('no_tool_use_continue')
      expect(out.injectUserContent).toMatch(/Thinking-only turn/)
      expect(out.injectSideChannelKind).toBe('generic_converted_system')
    }
  })

  it('row 12e: blank directiveBody falls through to row 13 completed', () => {
    const out = decideIterationOutcome({
      noToolUse: ntuBase(neutral, { thinkingOnlySilentTurnGuard: { directiveBody: '  ' } }),
    })
    expect(out.kind).toBe('terminate')
    if (out.kind === 'terminate') expect(out.reason).toBe('completed')
  })

  it('priority: allToolsFailedGuard beats thinkingOnlySilentTurnGuard (row 12c > 12e)', () => {
    const out = decideIterationOutcome({
      noToolUse: ntuBase(neutral, {
        allToolsFailedGuard: allFailedSignal,
        thinkingOnlySilentTurnGuard: thinkingOnlySignal,
      }),
    })
    expect(out.kind).toBe('continue')
    if (out.kind === 'continue') {
      expect(out.injectUserContent).toMatch(/All tool calls failed/)
    }
  })

  it('priority: declaredIntentGuard beats thinkingOnlySilentTurnGuard (row 12b > 12e)', () => {
    const out = decideIterationOutcome({
      noToolUse: ntuBase(neutral, {
        declaredIntentGuard: intentGuardSignal,
        thinkingOnlySilentTurnGuard: thinkingOnlySignal,
      }),
    })
    expect(out.kind).toBe('continue')
    if (out.kind === 'continue') {
      expect(out.injectUserContent).toMatch(/Declared intent without action/)
    }
  })

  it('priority: stallTripped (safety net) beats thinkingOnlySilentTurnGuard (row 8b > 12e)', () => {
    const out = decideIterationOutcome({
      noToolUse: ntuBase(neutral, {
        stallTripped: { message: 'no progress', consecutiveCount: 5 },
        thinkingOnlySilentTurnGuard: thinkingOnlySignal,
      }),
    })
    expect(out.kind).toBe('terminate')
    if (out.kind === 'terminate') expect(out.reason).toBe('iteration_stalled')
  })

  it('is the LOWEST-priority continuation — only above row 13 completed', () => {
    // Absent the guard, the same envelope is a plain completion.
    const out = decideIterationOutcome({ noToolUse: ntuBase(neutral) })
    expect(out.kind).toBe('terminate')
    if (out.kind === 'terminate') expect(out.reason).toBe('completed')
  })
})

// ─────────────────────────────────────────────────────────────────────
// Row 12f — completionEvidenceGate (2026-07 evidence handshake)
// ─────────────────────────────────────────────────────────────────────

const evidenceGateSignal = {
  directiveBody:
    '[Completion evidence required — host check]\n\n' +
    'This turn used tools, but your final reply did not submit completion evidence...',
}

describe('decideIterationOutcome — row 12f completionEvidenceGate', () => {
  it('row 12f: completionEvidenceGate → continue no_tool_use_continue + inject directive', () => {
    const out = decideIterationOutcome({
      noToolUse: ntuBase(neutral, { completionEvidenceGate: evidenceGateSignal }),
    })
    expect(out.kind).toBe('continue')
    if (out.kind === 'continue') {
      expect(out.transition).toBe('no_tool_use_continue')
      expect(out.injectUserContent).toMatch(/Completion evidence required/)
      expect(out.injectSideChannelKind).toBe('generic_converted_system')
    }
  })

  it('row 12f: blank directiveBody falls through to row 13 completed', () => {
    const out = decideIterationOutcome({
      noToolUse: ntuBase(neutral, { completionEvidenceGate: { directiveBody: '  ' } }),
    })
    expect(out.kind).toBe('terminate')
    if (out.kind === 'terminate') expect(out.reason).toBe('completed')
  })

  it('priority: thinkingOnlySilentTurnGuard beats completionEvidenceGate (row 12e > 12f)', () => {
    const out = decideIterationOutcome({
      noToolUse: ntuBase(neutral, {
        thinkingOnlySilentTurnGuard: thinkingOnlySignal,
        completionEvidenceGate: evidenceGateSignal,
      }),
    })
    expect(out.kind).toBe('continue')
    if (out.kind === 'continue') {
      expect(out.injectUserContent).toMatch(/Thinking-only turn/)
    }
  })

  it('priority: declaredIntentGuard beats completionEvidenceGate (row 12b > 12f)', () => {
    const out = decideIterationOutcome({
      noToolUse: ntuBase(neutral, {
        declaredIntentGuard: intentGuardSignal,
        completionEvidenceGate: evidenceGateSignal,
      }),
    })
    expect(out.kind).toBe('continue')
    if (out.kind === 'continue') {
      expect(out.injectUserContent).toMatch(/Declared intent without action/)
    }
  })

  it('priority: stallTripped (safety net) beats completionEvidenceGate (row 8b > 12f)', () => {
    const out = decideIterationOutcome({
      noToolUse: ntuBase(neutral, {
        stallTripped: { message: 'no progress', consecutiveCount: 5 },
        completionEvidenceGate: evidenceGateSignal,
      }),
    })
    expect(out.kind).toBe('terminate')
    if (out.kind === 'terminate') expect(out.reason).toBe('iteration_stalled')
  })

  it('priority: circuit breaker beats completionEvidenceGate (row 8 > 12f)', () => {
    const out = decideIterationOutcome({
      noToolUse: ntuBase(neutral, {
        circuitBreakerWouldTrip: true,
        completionEvidenceGate: evidenceGateSignal,
      }),
    })
    expect(out.kind).toBe('terminate')
    if (out.kind === 'terminate') expect(out.reason).toBe('stop_hook_circuit_breaker')
  })

  it('is the LOWEST-priority continuation — only above row 13 completed', () => {
    const out = decideIterationOutcome({ noToolUse: ntuBase(neutral) })
    expect(out.kind).toBe('terminate')
    if (out.kind === 'terminate') expect(out.reason).toBe('completed')
  })
})
