/**
 * Self-audit fix B3 (2026-05) — cover the centralized budget out
 * file the implementation audit (#4 / S4) added.
 *
 * The original code consolidated 5 sprinkled magic numbers into one
 * module; without these tests an accidental rename or zero-default
 * would silently expand or shrink the per-turn skill injection budget
 * (and `POLE_SKILL_DISCOVERY_FOLLOWUP` would default to the wrong side).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CHARS_PER_TOKEN,
  DEFAULT_CHAR_BUDGET,
  DISCOVERY_INJECTION_MIN_SCORE,
  DISCOVERY_PROMPT_PREVIEW_CHARS,
  DISCOVERY_TOP_K,
  INVOKED_SKILL_CONTENT_MAX_CHARS,
  MAX_LISTING_DESC_CHARS,
  PRELOADED_SKILL_BODY_MAX_CHARS,
  SKILL_BUDGET_CONTEXT_PERCENT,
  getSkillCharBudget,
  isSkillDiscoveryFollowUpEnabled,
} from './discoveryBudget'

describe('discoveryBudget constants', () => {
  it('SKILL_BUDGET_CONTEXT_PERCENT is 1% (cc-haha parity)', () => {
    expect(SKILL_BUDGET_CONTEXT_PERCENT).toBeCloseTo(0.01)
  })

  it('CHARS_PER_TOKEN matches the global heuristic of 4', () => {
    expect(CHARS_PER_TOKEN).toBe(4)
  })

  it('default fallback budget is 8000 (1% of 200k × 4)', () => {
    expect(DEFAULT_CHAR_BUDGET).toBe(8_000)
  })

  it('per-entry / per-skill caps are positive and reasonable', () => {
    expect(MAX_LISTING_DESC_CHARS).toBeGreaterThan(0)
    expect(DISCOVERY_PROMPT_PREVIEW_CHARS).toBeGreaterThan(0)
    expect(DISCOVERY_TOP_K).toBeGreaterThan(0)
    expect(DISCOVERY_INJECTION_MIN_SCORE).toBeGreaterThanOrEqual(0)
    expect(PRELOADED_SKILL_BODY_MAX_CHARS).toBeGreaterThan(0)
    expect(INVOKED_SKILL_CONTENT_MAX_CHARS).toBeGreaterThan(0)
  })
})

describe('getSkillCharBudget()', () => {
  let prevEnv: string | undefined

  beforeEach(() => {
    prevEnv = process.env.POLE_SKILL_CHAR_BUDGET
    delete process.env.POLE_SKILL_CHAR_BUDGET
  })

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.POLE_SKILL_CHAR_BUDGET
    else process.env.POLE_SKILL_CHAR_BUDGET = prevEnv
  })

  it('falls back to DEFAULT_CHAR_BUDGET when no input and no env', () => {
    expect(getSkillCharBudget()).toBe(DEFAULT_CHAR_BUDGET)
  })

  it('scales by SKILL_BUDGET_CONTEXT_PERCENT when a context window is provided', () => {
    expect(getSkillCharBudget(200_000)).toBe(
      Math.floor(200_000 * CHARS_PER_TOKEN * SKILL_BUDGET_CONTEXT_PERCENT),
    )
    expect(getSkillCharBudget(1_000_000)).toBe(40_000)
  })

  it('treats non-positive context window as fallback', () => {
    expect(getSkillCharBudget(0)).toBe(DEFAULT_CHAR_BUDGET)
    expect(getSkillCharBudget(-100)).toBe(DEFAULT_CHAR_BUDGET)
  })

  it('honors POLE_SKILL_CHAR_BUDGET env override over context window', () => {
    process.env.POLE_SKILL_CHAR_BUDGET = '1234'
    expect(getSkillCharBudget(200_000)).toBe(1234)
  })

  it('ignores malformed / non-positive env override', () => {
    process.env.POLE_SKILL_CHAR_BUDGET = 'banana'
    expect(getSkillCharBudget(200_000)).toBe(8_000)
    process.env.POLE_SKILL_CHAR_BUDGET = '0'
    expect(getSkillCharBudget()).toBe(DEFAULT_CHAR_BUDGET)
    process.env.POLE_SKILL_CHAR_BUDGET = '-100'
    expect(getSkillCharBudget()).toBe(DEFAULT_CHAR_BUDGET)
  })
})

describe('isSkillDiscoveryFollowUpEnabled()', () => {
  let prevEnv: string | undefined

  beforeEach(() => {
    prevEnv = process.env.POLE_SKILL_DISCOVERY_FOLLOWUP
    delete process.env.POLE_SKILL_DISCOVERY_FOLLOWUP
  })

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.POLE_SKILL_DISCOVERY_FOLLOWUP
    else process.env.POLE_SKILL_DISCOVERY_FOLLOWUP = prevEnv
  })

  it('defaults to ON (preserves pre-audit behaviour)', () => {
    expect(isSkillDiscoveryFollowUpEnabled()).toBe(true)
  })

  it('treats empty string as default (ON) — matches dotenv hygiene', () => {
    process.env.POLE_SKILL_DISCOVERY_FOLLOWUP = ''
    expect(isSkillDiscoveryFollowUpEnabled()).toBe(true)
  })

  it('disables for documented opt-out values', () => {
    for (const v of ['0', 'false', 'off', 'no', 'FALSE', 'Off', 'NO']) {
      process.env.POLE_SKILL_DISCOVERY_FOLLOWUP = v
      expect(isSkillDiscoveryFollowUpEnabled()).toBe(false)
    }
  })

  it('treats any other value as enabled (opt-out is explicit)', () => {
    for (const v of ['1', 'true', 'yes', 'on', 'maybe']) {
      process.env.POLE_SKILL_DISCOVERY_FOLLOWUP = v
      expect(isSkillDiscoveryFollowUpEnabled()).toBe(true)
    }
  })
})
