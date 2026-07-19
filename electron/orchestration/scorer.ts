/**
 * ScorerPort — pluggable "pick the best candidate" strategy for best-of-N.
 *
 * The orchestration layer historically only had *defensive* signals
 * (RepetitionGuard / IterationStallGuard detect degeneration and halt). It had
 * no *comparative* judgement: "given N finished attempts at the same task,
 * which one is best?" That is the missing strategic-control primitive — the
 * thing a commander does after a staff runs several plans in parallel.
 *
 * This module defines the port plus a deterministic default heuristic so
 * best-of-N works out of the box without a model call. A model-backed judge
 * (reusing the long-session `judgeRubric`) can be layered on top via
 * {@link composeScorers} — heuristic first for a cheap pre-rank, LLM judge to
 * break ties on the survivors.
 */

/** Verdict shape produced by the Verification sub-agent / verification gate. */
export type VerificationVerdict = 'PASS' | 'FAIL' | 'PARTIAL'

/**
 * Everything a scorer can look at for one finished attempt. All fields besides
 * `attemptIndex` are optional so a heuristic still works when an attempt ran in
 * an environment with no tests / no verification.
 */
export interface AttemptArtifact {
  attemptIndex: number
  /** Absolute path of the worktree the attempt ran in. */
  worktreePath?: string
  /** Commit SHA the attempt produced (undefined when nothing was committed). */
  commitSha?: string
  /** `git diff --shortstat` parsed for the attempt's branch vs its base. */
  diff?: { filesChanged: number; insertions: number; deletions: number }
  /** Final assistant text / summary the attempt produced. */
  finalText?: string
  /** Independent verification result, when the attempt ran one. */
  verification?: { verdict: VerificationVerdict; detail?: string }
  /** Parsed test outcome, when known. */
  tests?: { passed: number; failed: number }
  /** Set when the attempt failed to run or threw — hard-excludes it from winning. */
  error?: string
  /** Wall-clock duration of the attempt, used only as a final tie-break. */
  durationMs?: number
}

export interface ScoredAttempt {
  attempt: AttemptArtifact
  /** Higher is better. `-Infinity` means hard-excluded (never a winner). */
  score: number
  /** Human-readable contributions, for telemetry + the comparison UI. */
  reasons: string[]
}

export interface ScorerPort {
  /** Score every attempt and return them sorted best-first. */
  score(attempts: AttemptArtifact[]): Promise<ScoredAttempt[]>
}

/** Tunable weights for {@link createHeuristicScorer}. Documented defaults below. */
export interface HeuristicWeights {
  /** Reward for a PASS verdict. */
  pass: number
  /** Reward for a PARTIAL verdict. */
  partial: number
  /** Penalty (added, so make it negative) for a FAIL verdict. */
  fail: number
  /** Penalty for an attempt that produced no diff at all (did nothing). */
  emptyDiff: number
  /** Per passing test. */
  perTestPassed: number
  /** Per failing test (negative). */
  perTestFailed: number
  /** Per changed line (negative; tiny — only a tie-break toward smaller diffs). */
  perChangedLine: number
  /** Per millisecond of duration (negative; tiniest — final tie-break toward faster). */
  perMs: number
}

export const DEFAULT_HEURISTIC_WEIGHTS: HeuristicWeights = {
  pass: 100,
  partial: 30,
  fail: -100,
  emptyDiff: -50,
  perTestPassed: 2,
  perTestFailed: -10,
  perChangedLine: -0.01,
  perMs: -0.00001,
}

/**
 * Deterministic, no-model scorer. Ordering of concerns (highest signal first):
 *   1. Errored attempts are hard-excluded (`-Infinity`).
 *   2. Verification verdict dominates (PASS ≫ PARTIAL ≫ FAIL).
 *   3. Test pass/fail counts.
 *   4. An empty diff is penalised (an attempt that changed nothing rarely
 *      "solved" a change request).
 *   5. Tie-breaks: prefer smaller diffs, then faster runs.
 */
export function createHeuristicScorer(
  weights: Partial<HeuristicWeights> = {},
): ScorerPort {
  const w: HeuristicWeights = { ...DEFAULT_HEURISTIC_WEIGHTS, ...weights }

  const scoreOne = (a: AttemptArtifact): ScoredAttempt => {
    const reasons: string[] = []
    if (a.error) {
      return {
        attempt: a,
        score: Number.NEGATIVE_INFINITY,
        reasons: [`excluded: attempt errored (${a.error})`],
      }
    }
    let score = 0
    if (a.verification) {
      const v = a.verification.verdict
      const delta = v === 'PASS' ? w.pass : v === 'PARTIAL' ? w.partial : w.fail
      score += delta
      reasons.push(`verification ${v}: ${delta >= 0 ? '+' : ''}${delta}`)
    }
    if (a.tests) {
      const t = a.tests.passed * w.perTestPassed + a.tests.failed * w.perTestFailed
      score += t
      reasons.push(`tests ${a.tests.passed}✓/${a.tests.failed}✗: ${t >= 0 ? '+' : ''}${t}`)
    }
    const changed =
      a.diff ? a.diff.insertions + a.diff.deletions : 0
    const filesChanged = a.diff?.filesChanged ?? 0
    if (a.diff && filesChanged === 0) {
      score += w.emptyDiff
      reasons.push(`empty diff: ${w.emptyDiff}`)
    } else if (changed > 0) {
      const sizePenalty = changed * w.perChangedLine
      score += sizePenalty
      reasons.push(`diff size ${changed} lines: ${sizePenalty.toFixed(2)}`)
    }
    if (typeof a.durationMs === 'number' && a.durationMs > 0) {
      const timePenalty = a.durationMs * w.perMs
      score += timePenalty
      reasons.push(`duration ${a.durationMs}ms: ${timePenalty.toFixed(4)}`)
    }
    return { attempt: a, score, reasons }
  }

  return {
    async score(attempts) {
      return attempts
        .map(scoreOne)
        .sort((x, y) => y.score - x.score)
    },
  }
}

/**
 * Compose a cheap pre-ranker with a refiner. The `base` scorer runs first; the
 * top `refineTopK` survivors (excluding hard-excluded ones) are passed to
 * `refine` (e.g. an LLM judge), whose scores are ADDED to the base scores so
 * the refiner breaks ties without throwing away the base signal. Survivors are
 * re-sorted; non-refined attempts keep their base score and rank below.
 */
export function composeScorers(
  base: ScorerPort,
  refine: ScorerPort,
  options?: { refineTopK?: number },
): ScorerPort {
  const topK = Math.max(1, options?.refineTopK ?? 3)
  return {
    async score(attempts) {
      const ranked = await base.score(attempts)
      const eligible = ranked.filter((r) => Number.isFinite(r.score)).slice(0, topK)
      if (eligible.length <= 1) return ranked
      const refined = await refine.score(eligible.map((r) => r.attempt))
      const refineByIndex = new Map<number, ScoredAttempt>()
      for (const r of refined) refineByIndex.set(r.attempt.attemptIndex, r)
      const merged = ranked.map((r) => {
        const extra = refineByIndex.get(r.attempt.attemptIndex)
        if (!extra || !Number.isFinite(r.score)) return r
        return {
          attempt: r.attempt,
          score: r.score + extra.score,
          reasons: [...r.reasons, ...extra.reasons.map((x) => `judge: ${x}`)],
        }
      })
      return merged.sort((x, y) => y.score - x.score)
    },
  }
}

/** Pick the best scored attempt, or null when none is eligible (all errored / empty). */
export function pickWinner(ranked: ScoredAttempt[]): ScoredAttempt | null {
  const best = ranked.find((r) => Number.isFinite(r.score))
  return best ?? null
}
