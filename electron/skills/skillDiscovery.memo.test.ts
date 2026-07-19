/**
 * Self-audit fix B3 (2026-05) — pins S3 fix:
 *   - TF-IDF corpus + IDF must be recomputed at most ONCE per
 *     `skillsVersion` (upstream parity `clearCommandMemoizationCaches`)
 *   - calling `initSkills()` invalidates the memo
 *   - changing the skill name set (without a version bump) also forces
 *     a rebuild (sigKey defensive check)
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  _resetTfidfMemoForTests,
  _tfidfMemoState,
  rankSkillsForExplicitDiscover,
} from './skillDiscovery'
import { initSkills } from './skillTool'

// Bundled skills were removed (always-on skills diluted agent attention), so
// `initSkills()` with no workspace now loads zero skills and the TF-IDF memo
// never populates. Seed a temp workspace with real SKILL.md files so these
// tests exercise the memo invalidation path against a non-empty corpus.
let tmpWs = ''

function writeSkill(name: string, description: string): void {
  const dir = path.join(tmpWs, '.claude', 'skills', name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\nBody for ${name}.`,
  )
}

describe('TF-IDF memo invalidation (S3)', () => {
  beforeAll(() => {
    tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'pole-memo-'))
    writeSkill('verify', 'verify changes and report evidence')
    writeSkill('debug', 'diagnose and investigate errors or unexpected behavior')
  })

  afterAll(() => {
    if (tmpWs) fs.rmSync(tmpWs, { recursive: true, force: true })
  })

  beforeEach(() => {
    _resetTfidfMemoForTests()
    initSkills(tmpWs)
  })

  afterEach(() => {
    _resetTfidfMemoForTests()
  })

  it('first rank call populates the cache (rebuildCount goes from 0 → 1)', () => {
    const stateBefore = _tfidfMemoState()
    expect(stateBefore.cached).toBe(false)
    expect(stateBefore.rebuildCount).toBe(0)

    rankSkillsForExplicitDiscover('verify changes', 5)

    const stateAfter = _tfidfMemoState()
    expect(stateAfter.cached).toBe(true)
    expect(stateAfter.rebuildCount).toBe(1)
  })

  it('subsequent rank calls within the same skillsVersion are memo HITS (no rebuild)', () => {
    rankSkillsForExplicitDiscover('first query', 5)
    rankSkillsForExplicitDiscover('second query', 5)
    rankSkillsForExplicitDiscover('third query', 5)
    expect(_tfidfMemoState().rebuildCount).toBe(1)
  })

  it('initSkills() bumps skillsVersion and forces a rebuild on next rank', () => {
    rankSkillsForExplicitDiscover('q1', 5)
    expect(_tfidfMemoState().rebuildCount).toBe(1)

    // Force a version bump; nothing on disk changed, but the memo MUST
    // be invalidated so any external loader-side state shift is picked up.
    initSkills(tmpWs)
    rankSkillsForExplicitDiscover('q2', 5)
    expect(_tfidfMemoState().rebuildCount).toBe(2)
  })

  it('produces stable rankings across cache HITS (identical inputs → identical outputs)', () => {
    const a = rankSkillsForExplicitDiscover('verify changes', 5)
    const b = rankSkillsForExplicitDiscover('verify changes', 5)
    expect(b.map((s) => s.name)).toEqual(a.map((s) => s.name))
    // Confirm we're hitting the cache, not just getting deterministic
    // rebuild results.
    expect(_tfidfMemoState().rebuildCount).toBe(1)
  })
})
