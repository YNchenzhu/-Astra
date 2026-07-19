/**
 * best-of-N controller — fan out one task into N isolated attempts, score them,
 * and integrate the winner back into the main repo.
 *
 * This is the "parallel-explore + select" strategic-control mechanism Cursor 3
 * ships as `/best-of-n`. The workspace already had every primitive in isolation
 * (git-worktree isolation in `worktreeAllocator`, parallel spawn in
 * `MultiAgentOrchestrator`, a PASS/FAIL verifier, an LLM-judge rubric) — this
 * module is the missing piece that composes them into one flow.
 *
 * Design: everything external is a port, so the controller is unit-testable
 * with fakes and never hard-depends on a model:
 *   - {@link RunAttemptFn}      runs ONE attempt inside its worktree (caller wires
 *                               this to `runSubAgent` / the agentic loop).
 *   - {@link WorktreeAllocator} allocates / releases the isolated checkouts.
 *   - {@link BestOfNGitOps}     stages + commits + cherry-picks (git-backed by default).
 *   - {@link ScorerPort}        ranks the finished attempts (heuristic by default).
 */

import { MAX_PARALLEL_AGENT_TOOL_CALLS } from '../constants/toolLimits'
import { concreteWorktreeAllocator } from './worktreeAllocator'
import type { WorktreeAllocator } from './multiAgent'
import {
  createHeuristicScorer,
  pickWinner,
  type AttemptArtifact,
  type ScoredAttempt,
  type ScorerPort,
  type VerificationVerdict,
} from './scorer'

/** Parsed `git diff --shortstat`. */
export interface DiffStat {
  filesChanged: number
  insertions: number
  deletions: number
}

/** What the controller hands a single attempt. */
export interface BestOfNAttemptContext {
  attemptIndex: number
  /** Absolute path of this attempt's isolated worktree (already created). */
  worktreePath: string
  /** Optional per-attempt strategy hint (e.g. "use a state machine", "favor minimal diff"). */
  variantHint?: string
  /** The shared task prompt. */
  task: string
  /** Aborts when the whole best-of-N is cancelled. */
  signal: AbortSignal
}

/** What an attempt reports back. The controller computes the diff itself. */
export interface BestOfNAttemptResult {
  finalText?: string
  verification?: { verdict: VerificationVerdict; detail?: string }
  tests?: { passed: number; failed: number }
  /** Set by the attempt only if IT failed; runtime throws are caught by the controller. */
  error?: string
}

export type RunAttemptFn = (
  ctx: BestOfNAttemptContext,
) => Promise<BestOfNAttemptResult>

export interface BestOfNGitOps {
  /**
   * Resolve the MAIN repo working-tree root from a path that may itself be a
   * linked worktree. (`--show-toplevel` would return the worktree's own dir, so
   * a cherry-pick would run in the wrong tree — see audit H1.) Null when not a repo.
   */
  resolveMainRepoRoot(fromPath: string): Promise<string | null>
  /**
   * Stage everything in the worktree, parse the shortstat, and commit when there
   * are changes. Returns the new commit sha (null when the tree was clean) plus
   * the diff so the scorer can see attempt size.
   */
  commitAndStat(params: {
    worktreePath: string
    message: string
  }): Promise<{ sha: string | null; diff: DiffStat }>
  /**
   * Cherry-pick the winning commit onto the main repo's current HEAD. Throws on
   * conflict (after aborting the cherry-pick) so the caller can keep the branch
   * for manual merge and tell the user.
   */
  integrate(params: {
    mainRepoRoot: string
    winningSha: string
  }): Promise<void>
}

export interface BestOfNParams {
  task: string
  /** Number of parallel attempts. Clamped to [1, {@link MAX_PARALLEL_AGENT_TOOL_CALLS}]. */
  n: number
  /** Optional per-attempt strategy hints; index i is handed to attempt i. */
  variants?: string[]
  runAttempt: RunAttemptFn
  /** Defaults to the heuristic scorer. */
  scorer?: ScorerPort
  /** Defaults to the concrete git-worktree allocator. */
  worktreeAllocator?: WorktreeAllocator
  /** Defaults to the git-backed ops below. */
  gitOps?: BestOfNGitOps
  /** Cancels every in-flight attempt. */
  signal?: AbortSignal
  /** When true (default) the winner's commit is cherry-picked into the main repo. */
  integrateWinner?: boolean
  /** When true, keep all worktrees on disk (comparison UI / debugging). Default false. */
  keepWorktrees?: boolean
  /** Routing key for telemetry (best-effort). */
  conversationId?: string
}

export interface BestOfNResult {
  /** The selected attempt, or undefined when every attempt errored / did nothing. */
  winner?: ScoredAttempt
  /** All attempts ranked best-first. */
  ranked: ScoredAttempt[]
  /** Raw artifacts (same data, pre-scoring) for the comparison UI. */
  attempts: AttemptArtifact[]
  /** True when the winner's commit was successfully cherry-picked into main. */
  integrated: boolean
  /** Operator-facing breadcrumbs (clamping, integration outcome, kept branches). */
  notes: string[]
}

function clampN(n: number): number {
  if (!Number.isFinite(n) || n < 1) return 1
  return Math.min(MAX_PARALLEL_AGENT_TOOL_CALLS, Math.floor(n))
}

/**
 * Run a task N ways in parallel, score the results, and integrate the winner.
 *
 * Failure isolation: a thrown / rejected attempt becomes an errored
 * {@link AttemptArtifact} (hard-excluded by the scorer) rather than failing the
 * whole batch. Worktree cleanup is best-effort and never throws.
 */
export async function runBestOfN(params: BestOfNParams): Promise<BestOfNResult> {
  const n = clampN(params.n)
  const scorer = params.scorer ?? createHeuristicScorer()
  const allocator = params.worktreeAllocator ?? concreteWorktreeAllocator
  const gitOps = params.gitOps ?? createGitBestOfNOps()
  const integrateWinner = params.integrateWinner ?? true
  const signal = params.signal ?? new AbortController().signal
  const notes: string[] = []
  if (n !== params.n) {
    notes.push(`n clamped from ${params.n} to ${n}`)
  }

  // ---- Fan out: allocate a worktree per attempt, run them in parallel. ----
  const allocations: Array<{ index: number; worktreePath?: string }> = []
  const attemptPromises: Array<Promise<AttemptArtifact>> = []

  for (let i = 0; i < n; i++) {
    const variantHint = params.variants?.[i]
    attemptPromises.push(
      (async (): Promise<AttemptArtifact> => {
        const started = Date.now()
        let worktreePath: string | undefined
        try {
          worktreePath = await allocator.allocate({
            ...(params.conversationId ? { parentConversationId: params.conversationId } : {}),
            childKernelId: `best-of-n-${i}-${Date.now().toString(36)}`,
            agentType: 'best-of-n',
          })
        } catch (e) {
          allocations.push({ index: i })
          return {
            attemptIndex: i,
            error: `worktree allocation failed: ${(e as Error).message}`,
            durationMs: Date.now() - started,
          }
        }
        allocations.push({ index: i, worktreePath })

        try {
          const result = await params.runAttempt({
            attemptIndex: i,
            worktreePath,
            ...(variantHint ? { variantHint } : {}),
            task: params.task,
            signal,
          })
          if (result.error) {
            return {
              attemptIndex: i,
              worktreePath,
              error: result.error,
              ...(result.finalText ? { finalText: result.finalText } : {}),
              durationMs: Date.now() - started,
            }
          }
          // Commit the attempt's changes so the branch carries them, and read the diff.
          const { sha, diff } = await gitOps.commitAndStat({
            worktreePath,
            message: `best-of-n attempt ${i}: ${params.task.slice(0, 72)}`,
          })
          return {
            attemptIndex: i,
            worktreePath,
            ...(sha ? { commitSha: sha } : {}),
            diff,
            ...(result.finalText ? { finalText: result.finalText } : {}),
            ...(result.verification ? { verification: result.verification } : {}),
            ...(result.tests ? { tests: result.tests } : {}),
            durationMs: Date.now() - started,
          }
        } catch (e) {
          return {
            attemptIndex: i,
            worktreePath,
            error: (e as Error).message,
            durationMs: Date.now() - started,
          }
        }
      })(),
    )
  }

  const settled = await Promise.all(attemptPromises)
  const attempts = settled.sort((a, b) => a.attemptIndex - b.attemptIndex)

  // ---- Score + pick winner. ----
  const ranked = await scorer.score(attempts)
  const winner = pickWinner(ranked) ?? undefined

  // ---- Integrate the winner (cherry-pick its commit into main). ----
  let integrated = false
  const winnerSha = winner?.attempt.commitSha
  const winnerPath = winner?.attempt.worktreePath
  // Audit L3: never mutate the working tree for a run the caller cancelled
  // mid-flight — keep the winner's worktree/branch for inspection instead.
  if (signal.aborted) {
    notes.push('aborted before integration; winner worktree kept for manual review')
  } else if (integrateWinner && winner && winnerSha && winnerPath) {
    const mainRepoRoot = await gitOps.resolveMainRepoRoot(winnerPath)
    if (!mainRepoRoot) {
      notes.push('winner not integrated: main repo root not resolvable')
    } else {
      try {
        await gitOps.integrate({ mainRepoRoot, winningSha: winnerSha })
        integrated = true
        notes.push(`integrated winner (attempt ${winner.attempt.attemptIndex}, ${winnerSha.slice(0, 8)})`)
      } catch (e) {
        notes.push(
          `winner integration failed (${(e as Error).message}); keeping its worktree for manual merge`,
        )
      }
    }
  } else if (integrateWinner && winner && !winnerSha) {
    notes.push(`winner (attempt ${winner.attempt.attemptIndex}) produced no commit; nothing to integrate`)
  } else if (!winner) {
    notes.push('no eligible winner (all attempts errored or produced nothing)')
  }

  // ---- Cleanup: release losers always; release winner only if integrated. ----
  if (!params.keepWorktrees) {
    for (const alloc of allocations) {
      if (!alloc.worktreePath) continue
      const isWinner = alloc.worktreePath === winnerPath
      // Keep the winner's worktree when integration failed/skipped so the user
      // can merge it by hand; everything else is safe to remove.
      if (isWinner && !integrated) continue
      try {
        await Promise.resolve(allocator.release(alloc.worktreePath))
      } catch {
        /* best-effort cleanup */
      }
    }
  }

  return {
    ...(winner ? { winner } : {}),
    ranked,
    attempts,
    integrated,
    notes,
  }
}

// ---------------------------------------------------------------------------
// Default git-backed ops (execFile, no shell interpolation).
// ---------------------------------------------------------------------------

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'

const execFileAsync = promisify(execFile)

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf-8' })
  return stdout
}

/** Parse `git diff --cached --shortstat` output into counts. */
export function parseShortstat(raw: string): DiffStat {
  // e.g. " 3 files changed, 12 insertions(+), 4 deletions(-)"
  const filesChanged = /(\d+)\s+files?\s+changed/.exec(raw)?.[1]
  const insertions = /(\d+)\s+insertions?\(\+\)/.exec(raw)?.[1]
  const deletions = /(\d+)\s+deletions?\(-\)/.exec(raw)?.[1]
  return {
    filesChanged: filesChanged ? Number(filesChanged) : 0,
    insertions: insertions ? Number(insertions) : 0,
    deletions: deletions ? Number(deletions) : 0,
  }
}

export function createGitBestOfNOps(): BestOfNGitOps {
  return {
    async resolveMainRepoRoot(fromPath) {
      try {
        // `--git-common-dir` is the SHARED git dir for all worktrees
        // (`<mainRoot>/.git`), unlike `--git-dir` (per-worktree) or
        // `--show-toplevel` (the worktree's own working dir). Its parent is the
        // main working-tree root. From a worktree git returns it absolute; from
        // the main tree it returns the relative `.git`, so resolve against cwd.
        const raw = (await git(['rev-parse', '--git-common-dir'], fromPath)).trim()
        if (!raw) return null
        const abs = path.isAbsolute(raw) ? raw : path.resolve(fromPath, raw)
        return path.dirname(abs)
      } catch {
        return null
      }
    },
    async commitAndStat({ worktreePath, message }) {
      await git(['add', '-A'], worktreePath)
      const stat = await git(['diff', '--cached', '--shortstat'], worktreePath)
      const diff = parseShortstat(stat)
      if (diff.filesChanged === 0 && diff.insertions === 0 && diff.deletions === 0) {
        return { sha: null, diff }
      }
      // Audit L6: `--no-verify` is intentional here. These are internal,
      // throwaway attempt SNAPSHOTS in isolated worktrees (not user-facing
      // commits); a repo's pre-commit hook (lint/test/format) must not block or
      // mutate a candidate snapshot. The AGENTS "never skip hooks" rule targets
      // real user commits — the eventual winner re-enters history via
      // `cherry-pick` onto the user's branch, where their hooks still apply.
      await git(['commit', '-m', message, '--no-verify'], worktreePath)
      const sha = (await git(['rev-parse', 'HEAD'], worktreePath)).trim()
      return { sha, diff }
    },
    async integrate({ mainRepoRoot, winningSha }) {
      try {
        // -x records the cherry-picked source; worktrees share the object DB so
        // `winningSha` is already reachable from the main repo.
        await git(['cherry-pick', '-x', winningSha], mainRepoRoot)
      } catch (e) {
        try {
          await git(['cherry-pick', '--abort'], mainRepoRoot)
        } catch {
          /* abort is best-effort */
        }
        throw new Error(`cherry-pick of ${winningSha.slice(0, 8)} failed: ${(e as Error).message}`)
      }
    },
  }
}
