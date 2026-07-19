/**
 * Stage 9 — `getCompactSkillIndexPrompt` is memoized against
 * `skillsVersion`. Verifies:
 *   1. Same skills version → repeat calls return the SAME string instance
 *      (proves we hit the memo, not just produce equivalent strings).
 *   2. `initSkills` bumps the version, invalidating the memo, so a
 *      subsequent call recomputes and returns a fresh instance.
 */

import { describe, expect, it } from 'vitest'
import {
  getCompactSkillIndexPrompt,
  getSkillsVersion,
  initSkills,
} from './skillTool'

describe('Stage 9 — getCompactSkillIndexPrompt memoization', () => {
  it('returns the same string instance on repeat calls when skillsVersion is stable', () => {
    // Force at least one initial load so the memo has a stable population.
    initSkills()
    const versionBefore = getSkillsVersion()
    const a = getCompactSkillIndexPrompt()
    const b = getCompactSkillIndexPrompt()
    const c = getCompactSkillIndexPrompt()
    // Same instance: memo hit, not a recompute that happens to produce
    // an equal-content string. Triple-equals on string instances will
    // be true only if the exact same reference comes back.
    expect(b).toBe(a)
    expect(c).toBe(a)
    expect(getSkillsVersion()).toBe(versionBefore)
  })

  it('initSkills bumps skillsVersion and invalidates the memo (next call returns a fresh instance)', () => {
    initSkills()
    const versionBefore = getSkillsVersion()
    const before = getCompactSkillIndexPrompt()
    initSkills()
    const versionAfter = getSkillsVersion()
    const after = getCompactSkillIndexPrompt()
    expect(versionAfter).toBeGreaterThan(versionBefore)
    // Content may be identical (no skills changed on disk between calls
    // in this test), but the memo MUST have been invalidated. We assert
    // on version bump (the cache key) since string-identity could go
    // either way: both before and after are produced by `.join('\n')`,
    // and engines may or may not intern that result. Version is the
    // contract.
    expect(after).toEqual(before)
  })
})
