import { describe, expect, it } from 'vitest'
import {
  appendPlanModeBehaviorBlock,
  PLAN_MODE_BEHAVIOR_BLOCK,
} from './systemPrompt'

describe('appendPlanModeBehaviorBlock (P1-2, cc-haha §3.5 Plan Mode V2)', () => {
  const base = '# System\n- existing prompt body\n'

  it('is a no-op when permission mode is not "plan"', () => {
    expect(appendPlanModeBehaviorBlock(base, 'default')).toBe(base)
    expect(appendPlanModeBehaviorBlock(base, 'acceptEdits')).toBe(base)
    expect(appendPlanModeBehaviorBlock(base, 'bypassPermissions')).toBe(base)
    expect(appendPlanModeBehaviorBlock(base, undefined)).toBe(base)
  })

  it('appends the plan-mode behavior block when mode is "plan"', () => {
    const out = appendPlanModeBehaviorBlock(base, 'plan')
    expect(out).not.toBe(base)
    expect(out).toContain('# Plan mode is active')
    expect(out).toContain('Delegate exploration in parallel')
    expect(out).toContain('AskUserQuestion')
    expect(out).toContain('ExitPlanMode')
  })

  it('preserves the original prompt body before the appended block', () => {
    const out = appendPlanModeBehaviorBlock(base, 'plan')
    expect(out.indexOf(base.trim())).toBeLessThan(out.indexOf('# Plan mode is active'))
  })

  it('is idempotent — does not double-inject the block', () => {
    const once = appendPlanModeBehaviorBlock(base, 'plan')
    const twice = appendPlanModeBehaviorBlock(once, 'plan')
    expect(twice).toBe(once)

    // Marker count stays at exactly one occurrence.
    const matches = (s: string) => (s.match(/# Plan mode is active/g) ?? []).length
    expect(matches(twice)).toBe(1)
  })

  it('leaves an already-present block intact even if mode flips later', () => {
    // Simulating: a previous turn already injected the block, this turn the
    // host re-runs the same merge and should not break anything.
    const seeded = `${base}\n\n${PLAN_MODE_BEHAVIOR_BLOCK}`
    expect(appendPlanModeBehaviorBlock(seeded, 'plan')).toBe(seeded)
  })

  it('keeps the block compact — under 1800 chars (prompt budget)', () => {
    // Soft guard so future edits stay within "small overlay" territory.
    // ~350 tokens at 5 chars/token. Bumping past this needs an explicit
    // conversation about prompt cost — Plan-mode turns are *every* turn
    // a user has the input bar set to Plan, so this multiplies fast.
    expect(PLAN_MODE_BEHAVIOR_BLOCK.length).toBeLessThan(1800)
  })

  // Audit fix R1-4 / M5 (2026-05) regression — explicit documentation
  // of the sticky-state footgun that earned this helper its
  // `@deprecated` tag. If a caller seeds the prompt with the marker
  // (e.g. inherits it from a cached pre-exit-plan-mode prompt) and
  // then this function runs with mode!='plan', the marker stays put.
  // Without this assertion the next refactor might miss that the
  // guard order is the cause and "fix" it by reordering — which would
  // break idempotency. The right answer is to use SystemPromptBuilder,
  // not to "fix" this function in place.
  it('R1-4/M5 — STICKY STATE: a seeded marker survives even when mode is not "plan"', () => {
    const seededWithMarker = `${base}\n\n${PLAN_MODE_BEHAVIOR_BLOCK}`
    // Call with mode='default' — the `permissionMode !== 'plan'` guard
    // returns the input verbatim, so the marker is NOT stripped.
    const out = appendPlanModeBehaviorBlock(seededWithMarker, 'default')
    expect(out).toBe(seededWithMarker)
    expect(out).toContain('# Plan mode is active')
    // This is by design (idempotent append cannot also be a clean
    // remove); the production path avoids this by rebuilding the
    // prompt fresh per turn via SystemPromptBuilder.
  })
})
