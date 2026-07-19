/**
 * Agentic loop — post-tool context management phase.
 *
 * Extracted from `phases/iteration.ts` (~100 lines that used to live
 * inline as "Phase 5: Post-tool context management"). Owns the
 * phase-aware compact decision, the `loopContextManager.handleContext`
 * call, post-compact skill re-injection, and routing a compact failure
 * to a `model_error` terminal.
 *
 * Why a separate module instead of staying inline (the previous header
 * said "~65 lines, not worth extracting"):
 *
 *   1. **Hook surface.** Every other phase (`preModel` / `stream` /
 *      `noTools` / `toolExec`) is a function call that the kernel /
 *      tests can wrap, stub, or replace. Post-tool context manage was
 *      the only Phase-5 step without a seam.
 *   2. **Independent testability.** Compact-failure → `model_error`
 *      terminal is now unit-testable without spinning the full agentic
 *      loop (`postModel.test.ts`).
 *   3. **driveInnerLoop parity.** Drive-mode kernels that want to
 *      bracket post-tool work with their own pause/checkpoint can
 *      wrap a single call site rather than splicing into the iteration
 *      body.
 *
 * Scope kept deliberately narrow: abort handling stays in the caller
 * because `finaliseMaxIterations` is an iteration-loop concept (the outer
 * iteration counter, which a single phase shouldn't reach into). This
 * module surfaces aborts via `{ kind: 'aborted' }` so the caller's
 * existing abort plumbing keeps owning that decision. (Post-tool aborts
 * always terminate as `aborted_tools` since SA-2 fix 3 removed the legacy
 * `redirectAbortToMaxTurnsIfExhausted` redirect — see
 * `iteration.ts:finaliseMaxIterations`.)
 */

import { app } from 'electron'
import type { LoopState } from './loopShared'
import { getAgentContext } from '../../agents/agentContext'
import { estimateToolDefinitionsTokens } from '../../context/tokenCounter'
import { buildContextCollapseConversationKey } from '../../context/contextCollapseStore'
import {
  decidePhaseAwareCompact,
  type PhaseAwareDegradationSignal,
} from '../../context/phaseAwareCompact'
import { getRepetitionGuard } from '../../orchestration/repetitionGuard'
import { getWorkspacePath } from '../../tools/workspaceState'
import { injectInvokedSkillsIntoLastUserMessage } from '../../skills/invokedSkillsRegistry'
import { resolveConversationFilePath } from '../../conversation/storage'
import { buildCompactSideAttachmentIds } from '../agenticLoopHelpers'
import { createTerminalResult, runTerminationCleanup } from '../queryTermination'

export interface PostModelInput {
  state: LoopState
  systemPrompt: string
}

/**
 * P0.3 — Compact failures we tolerate before terminating the loop.
 *
 * upstream parity: `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`
 * (`services/compact/autoCompact.ts` L70). Upstream simply stops trying
 * after 3; we go one step further and terminate the iteration, because
 * a Pole session that genuinely can't compact will OOM the next call.
 *
 * Counter is `state.consecutiveCompactFailures`. Reset to 0 on every
 * successful compact (wasCompacted: true).
 */
const MAX_CONSECUTIVE_COMPACT_FAILURES = 3

/**
 * GAP 4 (2026-06 long-run hallucination audit) — minimum consecutive
 * identical-call count before the repetition guard's state is treated
 * as a degradation signal for proactive compact. Matches the guard's
 * default `warnThreshold` (the count at which it starts prepending
 * advisories to tool results).
 */
const DEGRADATION_REPETITION_MIN_COUNT = 3

/**
 * Read the process-wide repetition guard and convert its snapshot into
 * a phase-aware degradation signal when the count is meaningful.
 * Deterministic — pure counter read, no LLM judgement. Wrapped in
 * try/catch so a guard failure can never block context management.
 */
function readDegradationSignal(): PhaseAwareDegradationSignal | undefined {
  try {
    const snap = getRepetitionGuard().snapshot()
    if (
      snap.count >= DEGRADATION_REPETITION_MIN_COUNT &&
      typeof snap.toolName === 'string' &&
      snap.toolName.length > 0
    ) {
      return {
        kind: 'tool_repetition',
        toolName: snap.toolName,
        consecutiveCount: snap.count,
      }
    }
  } catch {
    /* never block compact on guard read failure */
  }
  return undefined
}

/**
 * Outcome union — caller switches on `kind`:
 *   - `ok`        — phase ran cleanly (no compact, or compact succeeded,
 *                   or compact failed softly — see `softFailure` flag).
 *                   `state.apiMessages` may have been replaced. Continue
 *                   the iteration normally.
 *   - `terminate` — compact failed and the phase already populated
 *                   `state.terminationResult` (kind `model_error`) and
 *                   ran `runTerminationCleanup`. Caller must
 *                   `return { kind: 'terminate' }` from `runAgenticIteration`.
 *                   Only fires after `MAX_CONSECUTIVE_COMPACT_FAILURES`
 *                   consecutive failures — a single transient failure is
 *                   soft-recovered into `ok` instead (P0.3).
 *   - `aborted`   — `state.signal.aborted` fired during the phase. The
 *                   caller terminates as `aborted_tools` (user cancel wins
 *                   over `max_turns`); this phase intentionally does NOT
 *                   call any terminal helpers in this branch.
 */
export type PostModelOutcome =
  | {
      kind: 'ok'
      wasCompacted: boolean
      contextLevel?: string
      /** P0.3 — set when an exception was swallowed via the soft-failure path. */
      softFailure?: { attempt: number; detail: string }
    }
  | { kind: 'terminate' }
  | { kind: 'aborted' }

/**
 * Run the post-tool context management phase.
 *
 * Caller contract (matches what `iteration.ts` did inline):
 *   - Only invoke when `state.iteration > 1`. The first iteration skips
 *     post-tool compact (no tool results to compact against).
 *   - Wrap the call in a `state.profiler.startCheckpoint(postCompact)`
 *     try / finally if profiler buckets are required. The phase itself
 *     does not own the checkpoint so non-profiler callers don't pay the
 *     setup cost.
 *
 * Behavioural parity with the legacy inline body is byte-for-byte for
 * the happy path and the `model_error` terminal path; the abort branch
 * is surfaced as `{ kind: 'aborted' }` so the caller can pick between
 * `aborted_tools` and `max_turns` exactly the way the inline code did.
 */
export async function runPostModelPhase(
  input: PostModelInput,
): Promise<PostModelOutcome> {
  const { state, systemPrompt } = input

  try {
    const toolTokens = state.iterationToolDefs.length > 0
      ? estimateToolDefinitionsTokens(state.iterationToolDefs)
      : 0
    const phaseAwareEstimatedTokens = state.loopContextManager.estimateTotalInputTokensPeek(
      state.apiMessages,
      systemPrompt,
      toolTokens,
      false,
    )
    const degradation = readDegradationSignal()
    const phaseAwareCompact = decidePhaseAwareCompact({
      boundary: 'post_tool',
      toolUseBlocks: state.toolUseBlocks,
      messages: state.apiMessages,
      thresholds: state.loopContextManager.getThresholds(),
      estimatedTokens: phaseAwareEstimatedTokens,
      iteration: state.iteration,
      lastPhaseAwareCompactIteration: state.lastPhaseAwareCompactIteration,
      ...(degradation ? { degradation } : {}),
    })
    if (phaseAwareCompact.shouldCompact) {
      state.appendixReport('P2_Q_post_tool_context_manage', {
        iteration: state.iteration,
        phaseAwareCompact: true,
        reason: phaseAwareCompact.request.reason,
        estimatedTokens: phaseAwareCompact.estimatedTokens,
        thresholdTokens: phaseAwareCompact.thresholdTokens,
        ...(degradation
          ? {
              degradationToolName: degradation.toolName,
              degradationCount: degradation.consecutiveCount,
            }
          : {}),
      })
    }
    const wsMid = getWorkspacePath()
    const collapseKeyMid = buildContextCollapseConversationKey(
      wsMid?.trim() || undefined,
      getAgentContext()?.streamConversationId,
    )
    // Same transcript-path hint we plumb through `preModel.ts`. See
    // `resolveTranscriptPathIfPossible` there for failure modes — we
    // mirror the try/catch around `app.getPath` here too so a missing
    // app context never blocks compaction.
    let transcriptPath: string | undefined
    try {
      const cid = getAgentContext()?.streamConversationId?.trim()
      const ws = (wsMid || '').trim()
      if (cid && ws) {
        transcriptPath = resolveConversationFilePath(app.getPath('userData'), ws, cid)
      }
    } catch {
      transcriptPath = undefined
    }
    const contextResult = await state.loopContextManager.handleContext(
      state.apiMessages,
      systemPrompt,
      {
        config: state.config,
        model: state.iterationModel,
        systemPrompt,
        messages: state.apiMessages,
        signal: state.signal,
        collapseConversationKey: collapseKeyMid,
        ...(transcriptPath ? { transcriptPath } : {}),
        ...(state.activeInlineSkillSession?.skillName
          ? { activeSkillName: state.activeInlineSkillSession.skillName }
          : {}),
        ...(phaseAwareCompact.shouldCompact
          ? { proactiveCompact: phaseAwareCompact.request }
          : {}),
        ...buildCompactSideAttachmentIds(),
        permissionRules: state.permissionRules,
        onCompactStart: (d) => state.callbacks.onContextCompactStart?.({ level: d.level }),
      },
      toolTokens,
    )
    if (contextResult.wasCompacted) {
      if (phaseAwareCompact.shouldCompact) {
        state.lastPhaseAwareCompactIteration = state.iteration
      }
      state.apiMessages = contextResult.messages
      const level = state.loopContextManager.getState().level
      state.apiMessages = injectInvokedSkillsIntoLastUserMessage(
        state.apiMessages,
        getAgentContext()?.agentId,
      )
      state.syncConversation()
      state.loopContextManager.clearUsageSnapshot()
      // P0.3 — successful compact resets the failure counter. upstream
      // parity (`autoCompact.ts` L332): "Reset failure count on success".
      state.consecutiveCompactFailures = 0
      console.log(`[Agentic Loop] Context compacted at iteration ${state.iteration}, level: ${level}`)
      if (state.callbacks.onContextCompact) {
        const post = state.loopContextManager.getState().estimatedTokens
        state.callbacks.onContextCompact({
          level,
          preTokens: phaseAwareEstimatedTokens,
          postTokens: post,
          reclaimedTokens: Math.max(0, phaseAwareEstimatedTokens - post),
        })
      }
      return { kind: 'ok', wasCompacted: true, contextLevel: level }
    }
    return { kind: 'ok', wasCompacted: false }
  } catch (contextError) {
    // Audit Bug 9 (legacy behaviour): pre-P0.3 this branch ALWAYS surfaced
    // compact failures as a terminal `model_error`. That over-reacted to
    // transient I/O failures (e.g. a side-attachment file vanishing mid-
    // compact) by killing the whole session. upstream (`autoCompact.ts`
    // L334-350) just tracks consecutive failures and silently stops
    // trying after 3 — never terminating the loop.
    //
    // P0.3 splits the cases:
    //   - abort during compact → `aborted` (unchanged; caller picks
    //     between `aborted_tools` and `max_turns`).
    //   - failures 1 and 2 → soft-recover: warn, increment counter,
    //     return `ok` with `wasCompacted: false` so the loop continues
    //     into the next iteration on the un-compacted transcript.
    //   - failure 3+ → terminal `model_error` (the legacy hard-stop).
    //     We're slightly more conservative than upstream here because a
    //     Pole session that genuinely can't compact will OOM the next
    //     API call regardless of how many more attempts we make.
    if (state.signal.aborted) {
      // User-initiated abort during compact is a normal exit path, not
      // an unexpected fault. The legacy inline body logged a noisy
      // `[Agentic Loop] Context management error: AbortError` on every
      // cancel; silence the warn on the abort branch only so the model-
      // error branch retains its diagnostic.
      return { kind: 'aborted' }
    }
    state.consecutiveCompactFailures += 1
    const attempt = state.consecutiveCompactFailures
    const detail =
      contextError instanceof Error
        ? `Post-tool context management failed: ${contextError.message}`
        : `Post-tool context management failed: ${String(contextError)}`
    if (attempt < MAX_CONSECUTIVE_COMPACT_FAILURES) {
      // Soft recovery — warn, continue without compaction. The next
      // iteration's pre-model pipeline may compact successfully if the
      // transient cause clears (e.g. an attachment file becomes readable
      // again). If three consecutive failures happen in a row, the
      // counter will trip the terminal branch below.
      console.warn(
        `[Agentic Loop] Context management soft-failure (${attempt}/${MAX_CONSECUTIVE_COMPACT_FAILURES}) at iteration ${state.iteration}:`,
        contextError,
      )
      state.appendixReport('P2_Q_post_tool_context_manage', {
        iteration: state.iteration,
        compactSoftFailure: true,
        attempt,
        maxAttempts: MAX_CONSECUTIVE_COMPACT_FAILURES,
        detail,
      })
      return {
        kind: 'ok',
        wasCompacted: false,
        softFailure: { attempt, detail },
      }
    }
    console.warn(
      `[Agentic Loop] Context management error (terminal after ${attempt} consecutive failures):`,
      contextError,
    )
    state.callbacks.onError(detail)
    state.callbacks.onMessageEnd(state.totalUsage)
    state.terminationResult = createTerminalResult('model_error', {
      turnCount: state.iteration,
      totalUsage: state.totalUsage,
      errorDetail: detail,
    })
    await runTerminationCleanup(state.terminationResult)
    return { kind: 'terminate' }
  }
}
