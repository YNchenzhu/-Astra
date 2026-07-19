/**
 * Audit SA-6 (P1) — per-iteration model-call budget unit tests.
 *
 * The integration contract (a continuously failing `callModel` stub never
 * exceeds the budget and terminates as `model_error`) is covered in
 * `../stream.budget.test.ts`; this file pins the pure pieces: env
 * resolution and counter semantics.
 */

import { describe, expect, it } from 'vitest'
import {
  createModelCallBudget,
  DEFAULT_MAX_MODEL_CALL_ATTEMPTS_PER_ITERATION,
  resolveMaxModelCallAttemptsPerIteration,
} from './modelCallBudget'

describe('resolveMaxModelCallAttemptsPerIteration', () => {
  it('defaults to 10 when the env var is unset', () => {
    expect(resolveMaxModelCallAttemptsPerIteration(undefined)).toBe(
      DEFAULT_MAX_MODEL_CALL_ATTEMPTS_PER_ITERATION,
    )
    expect(DEFAULT_MAX_MODEL_CALL_ATTEMPTS_PER_ITERATION).toBe(10)
  })

  it('accepts a valid integer override', () => {
    expect(resolveMaxModelCallAttemptsPerIteration('5')).toBe(5)
    expect(resolveMaxModelCallAttemptsPerIteration(' 3 ')).toBe(3)
    expect(resolveMaxModelCallAttemptsPerIteration('1')).toBe(1)
  })

  it('falls back to the default on parse failures and invalid values', () => {
    for (const bad of ['', '   ', 'abc', 'NaN', '0', '-2', 'Infinity']) {
      expect(
        resolveMaxModelCallAttemptsPerIteration(bad),
        `env value: ${JSON.stringify(bad)}`,
      ).toBe(DEFAULT_MAX_MODEL_CALL_ATTEMPTS_PER_ITERATION)
    }
  })
})

describe('createModelCallBudget', () => {
  it('allows exactly maxAttempts consumes, then refuses and marks exhausted', () => {
    const budget = createModelCallBudget(3)
    expect(budget.tryConsume('initial')).toBe(true)
    expect(budget.tryConsume('overload_fallback')).toBe(true)
    expect(budget.tryConsume('max_output_recovery')).toBe(true)
    expect(budget.exhausted).toBe(false)

    expect(budget.tryConsume('max_output_recovery')).toBe(false)
    expect(budget.exhausted).toBe(true)
    expect(budget.used).toBe(3)

    // Refusal is sticky — no label sneaks past once exhausted.
    expect(budget.tryConsume('initial')).toBe(false)
    expect(budget.used).toBe(3)
  })

  it('tracks the per-entry breakdown and renders it for error details', () => {
    const budget = createModelCallBudget(10)
    budget.tryConsume('initial')
    budget.tryConsume('max_output_recovery')
    budget.tryConsume('max_output_recovery')
    budget.tryConsume('reactive_compact')
    expect(budget.breakdown).toEqual({
      initial: 1,
      max_output_recovery: 2,
      reactive_compact: 1,
    })
    expect(budget.describeBreakdown()).toBe(
      'initial=1, max_output_recovery=2, reactive_compact=1',
    )
  })

  it('describes an untouched budget as "none"', () => {
    expect(createModelCallBudget(10).describeBreakdown()).toBe('none')
  })

  it('caps the multiplicative worst case across simulated recovery layers', () => {
    // Simulates the stream-phase consult pattern: several stacked layers,
    // each individually bounded, each consulting the shared budget before
    // launching a "model call". The total can never exceed the budget no
    // matter how the layers multiply.
    const budget = createModelCallBudget(10)
    let calls = 0
    const callModelStub = () => {
      calls++
    }
    const tryCall = (label: string): boolean => {
      if (!budget.tryConsume(label)) return false
      callModelStub()
      return true
    }

    tryCall('initial')
    for (let overload = 0; overload < 3; overload++) tryCall('overload_fallback')
    for (let cycle = 0; cycle < 3; cycle++) {
      if (!tryCall('max_output_recovery')) break
      for (let overload = 0; overload < 3; overload++) tryCall('overload_fallback')
    }
    tryCall('drain_recovery')
    tryCall('reactive_compact')
    tryCall('image_strip_retry')

    expect(calls).toBeLessThanOrEqual(10)
    expect(budget.used).toBe(10)
    expect(budget.exhausted).toBe(true)
  })
})
