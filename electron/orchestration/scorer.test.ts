import { describe, expect, it } from 'vitest'
import {
  createHeuristicScorer,
  composeScorers,
  pickWinner,
  type AttemptArtifact,
  type ScorerPort,
} from './scorer'

const A = (over: Partial<AttemptArtifact> & { attemptIndex: number }): AttemptArtifact => ({
  worktreePath: `/wt/${over.attemptIndex}`,
  diff: { filesChanged: 1, insertions: 5, deletions: 1 },
  ...over,
})

describe('createHeuristicScorer', () => {
  it('ranks PASS over PARTIAL over FAIL', async () => {
    const scorer = createHeuristicScorer()
    const ranked = await scorer.score([
      A({ attemptIndex: 0, verification: { verdict: 'FAIL' } }),
      A({ attemptIndex: 1, verification: { verdict: 'PASS' } }),
      A({ attemptIndex: 2, verification: { verdict: 'PARTIAL' } }),
    ])
    expect(ranked.map((r) => r.attempt.attemptIndex)).toEqual([1, 2, 0])
  })

  it('hard-excludes errored attempts (score -Infinity, never a winner)', async () => {
    const scorer = createHeuristicScorer()
    const ranked = await scorer.score([
      A({ attemptIndex: 0, error: 'boom' }),
      A({ attemptIndex: 1, verification: { verdict: 'PARTIAL' } }),
    ])
    const errored = ranked.find((r) => r.attempt.attemptIndex === 0)!
    expect(errored.score).toBe(Number.NEGATIVE_INFINITY)
    expect(pickWinner(ranked)?.attempt.attemptIndex).toBe(1)
  })

  it('penalises empty diffs and prefers PASS with smaller diff on ties', async () => {
    const scorer = createHeuristicScorer()
    const ranked = await scorer.score([
      A({ attemptIndex: 0, verification: { verdict: 'PASS' }, diff: { filesChanged: 0, insertions: 0, deletions: 0 } }),
      A({ attemptIndex: 1, verification: { verdict: 'PASS' }, diff: { filesChanged: 2, insertions: 200, deletions: 100 } }),
      A({ attemptIndex: 2, verification: { verdict: 'PASS' }, diff: { filesChanged: 1, insertions: 10, deletions: 2 } }),
    ])
    // Empty-diff PASS is penalised below the real PASSes; smaller real diff wins.
    expect(ranked[0].attempt.attemptIndex).toBe(2)
    expect(ranked[ranked.length - 1].attempt.attemptIndex).toBe(0)
  })

  it('factors test pass/fail counts', async () => {
    const scorer = createHeuristicScorer()
    const ranked = await scorer.score([
      A({ attemptIndex: 0, tests: { passed: 1, failed: 5 } }),
      A({ attemptIndex: 1, tests: { passed: 10, failed: 0 } }),
    ])
    expect(ranked[0].attempt.attemptIndex).toBe(1)
  })

  it('pickWinner returns null when every attempt is excluded', async () => {
    const scorer = createHeuristicScorer()
    const ranked = await scorer.score([
      A({ attemptIndex: 0, error: 'a' }),
      A({ attemptIndex: 1, error: 'b' }),
    ])
    expect(pickWinner(ranked)).toBeNull()
  })
})

describe('composeScorers', () => {
  it('adds judge scores to the top-K survivors and re-sorts', async () => {
    const base = createHeuristicScorer()
    // Judge boosts attempt 2 hard so it overtakes the heuristic leader.
    const judge: ScorerPort = {
      async score(attempts) {
        return attempts.map((a) => ({
          attempt: a,
          score: a.attemptIndex === 2 ? 1000 : 0,
          reasons: [`judge boost ${a.attemptIndex === 2 ? 1000 : 0}`],
        }))
      },
    }
    const composed = composeScorers(base, judge, { refineTopK: 3 })
    const ranked = await composed.score([
      A({ attemptIndex: 0, verification: { verdict: 'PASS' } }),
      A({ attemptIndex: 1, verification: { verdict: 'PASS' } }),
      A({ attemptIndex: 2, verification: { verdict: 'PARTIAL' } }),
    ])
    expect(ranked[0].attempt.attemptIndex).toBe(2)
    expect(ranked[0].reasons.some((r) => r.startsWith('judge:'))).toBe(true)
  })
})
