/**
 * Inner-iteration primitives — canonical home for the agentic loop core.
 *
 * setupAgenticLoopForRun, runAgenticIteration, finaliseMaxIterations,
 * runAgenticLoop and supporting types live here after the Chunk 8b
 * physical migration from electron/ai/agenticLoop.ts. The companion
 * file phases/driveInnerLoop.ts (Chunk 8c) owns the drive-mode while
 * loop; the kernel only owns the outer for loop in runDriveMainChat.
 *
 * Delegates to focused phase modules under electron/ai/agenticLoop/:
 *   setup.ts     — state initialisation
 *   preModel.ts  — pre-model pipeline (skill discovery, idle clear, budget)
 *   stream.ts    — API stream pass, overload retry, output recovery, reactive compact
 *   noTools.ts   — no-tool-use termination branch
 *   toolExec.ts  — tool execution, result processing, skill follow-up, summary
 *   postModel.ts — post-tool context management (phase-aware compact + skill re-inject)
 *
 * Max-iterations cleanup is exported as `finaliseMaxIterations` below so
 * drive-mode kernels can reuse the same termination shape after their own
 * `while` exhausts. Everything else in this file is inner-loop control
 * flow: outcome dispatch, abort guards, telemetry checkpoints.
 */
import {
  consumeAgentContextPendingHookStop,
  getAgentContext,
  syncAgentContextConversation,
} from '../../agents/agentContext'
import { cleanupStaleAgents } from '../../agents/activeAgentRegistry'
import { drainMainThreadProcessCommandQueue } from '../../agents/processCommandQueue'
import { snapshotFilePathsForConversation } from '../../context/filePathMemory'
import { getToolDefinitions } from '../../tools/schema'
import { toolRegistry } from '../../tools/registry'
import { estimateToolDefinitionsTokens } from '../../context/tokenCounter'
import { updateConversationContextDisplay } from '../../context/conversationDisplayState'
import { resolveSkillModelOverride } from '../../skills/skillModelResolve'
import { filterToolDefinitionsForSkill } from '../../skills/skillSessionFilter'
import { ensureToolUseResultPairing } from '../../context/ensureToolUseResultPairing'
import { normalizeAnthropicThinkingTranscript, peekLastStreamModelForThinkingTranscript, rememberLastStreamModelForThinkingTranscript } from '../../context/anthropicThinkingTranscript'
import { readDiskSettings } from '../../settings/settingsAccess'
import { buildAnthropicThinkingForStreamRequest } from '../../ai/anthropicExtendedThinking'
import { normalizeMessagesForAPI } from '../../context/normalizeMessagesForAPI'
import { getMessagesAfterCompactBoundary } from '../../context/compactBoundary'
import { cloneApiMessagesForOrchestration } from '../../ai/agenticLoopHelpers'
import { getProviderQuirks } from '../../ai/providerQuirks'
import {
  markSessionMemoryExtractConsumed,
  recordMainThreadSessionMemorySignals,
  shouldTriggerSessionMemoryExtract,
  suppressSessionMemoryExtract,
} from '../../session/sessionMemoryTrigger'
import { snapshotAgentContextForSessionMemoryFork } from '../../session/memoryForkSnapshot'
import {
  endSessionMemoryExtract,
  tryBeginSessionMemoryExtract,
} from '../../session/sessionMemoryExtractInFlight'
import { getMemoryFeatureFlags } from '../../memory/memoryFeatureFlags'
import { getWorkspacePath } from '../../tools/workspaceState'
import { buildContextCollapseConversationKey } from '../../context/contextCollapseStore'
import { QUERY_PROFILER_LABELS } from '../../ai/queryProfiler'
import {
  createTerminalResult,
  createUserInterruptionMessage,
  runTerminationCleanup,
} from '../../ai/queryTermination'
import { bindAgentContext } from '../../agents/agentContextBind'
import { buildTranscriptDegradedPhase, createTransportAdapter, emitPhaseEvent } from '../transport'
import { fingerprintTranscript } from '../kernelTypes'

import { getIterationStallGuard } from '../iterationStallGuard'
import { initialiseLoopState } from '../../ai/agenticLoop/setup'
import { recordTransition } from '../../ai/agenticLoop/loopShared'
import { applyForwardProgressReset } from '../../ai/agenticLoop/guardBudgetLedger'
import { advanceIterationBoundary } from './loopDriverChores'
import { runPreModelPhase } from '../../ai/agenticLoop/preModel'
import { runStreamPhase } from '../../ai/agenticLoop/stream'
import { handleNoToolsBranch } from '../../ai/agenticLoop/noTools'
import { executeToolBatch } from '../../ai/agenticLoop/toolExec'
import { runPostModelPhase } from '../../ai/agenticLoop/postModel'
import { runCollectors } from '../../ai/agenticLoop/hostAttachments'
import {
  decideIterationOutcome,
  // P1 — the decision module exports a richer `IterationOutcome`
  // (terminate/continue with reason + transition). Alias on import to
  // avoid clashing with the loop-driver `IterationOutcome` exported
  // below (the simple `{ kind: 'continue' | 'terminate' }` shape that
  // `runAgenticIteration` returns to the outer driver `while`).
  type IterationOutcome as IterationDecisionOutcome,
} from '../../ai/agenticLoop/iterationDecision'
import type { AgenticLoopCallbacks, AgenticLoopParams } from '../../ai/agenticLoopTypes'
import type { AgenticLoopResult } from '../../ai/loopEvents'

export type { AgenticLoopCallbacks, AgenticLoopParams } from '../../ai/agenticLoopTypes'
export type { AgenticLoopResult, LoopEvent, LoopTransition } from '../../ai/loopEvents'

/**
 * upstream §11.2 — optional outcome-capture hook used by {@link runAgenticLoopAsync}.
 *
 * The generator API needs to surface the {@link AgenticLoopResult} as the
 * generator's `return` value, but the legacy callback API has no place for
 * one. Threading a single optional `onTerminate` hook through is the
 * lightest possible change: callback consumers ignore it (it's optional);
 * the generator driver wires it to its outcome slot.
 */
export interface AgenticLoopOptions {
  onTerminate?: (result: AgenticLoopResult) => void
}

/**
 * Setup the agentic-loop run state. Extracted so drive-mode kernels can stand up
 * the same state bag, then drive the `while` themselves while still calling
 * {@link runAgenticIteration} per turn and {@link finaliseMaxIterations} on exhaustion.
 *
 * Returns:
 *   - `state` — the wired-up `LoopState` (callbacks, syncConversation, refreshMainChatContextHeader,
 *     appendixReport all attached).
 *   - `systemPrompt` — resolved system prompt string.
 *   - `fireOnTerminate` — outcome capture hook for the generator-style API.
 *   - `finaliseTransitionHistory` — defer this into the run's outer `finally`.
 */
export function setupAgenticLoopForRun(
  params: AgenticLoopParams,
  callbacks: AgenticLoopCallbacks,
  options?: AgenticLoopOptions,
): {
  state: import('../../ai/agenticLoop/loopShared').LoopState
  systemPrompt: string
  fireOnTerminate: () => void
  finaliseTransitionHistory: () => void
} {
  const state = initialiseLoopState(params)
  // Wire callbacks & runtime helpers into the state bag.
  state.callbacks = callbacks
  state.appendixReport = (stage, detail) => state.appendAppendixAFlow?.report(stage, detail)
  // Audit P2-2 — once-per-run dedup so a transcript that consistently fails
  // to clone (e.g. carries a BigInt field) doesn't flood the renderer with
  // an event per inner-iteration `syncConversation` call. Reset to `null`
  // when the clone path returns to healthy (mode === undefined). Tracks
  // the most recent `mode` separately so a transition `'json'` ↔
  // `'frozen-shared'` re-emits even within the same run.
  let lastCloneFailureMode: 'json' | 'frozen-shared' | null = null
  state.syncConversation = () => {
    syncAgentContextConversation(state.apiMessages)
    if (!state.hostTranscript) return
    const snap = cloneApiMessagesForOrchestration(state.apiMessages, {
      onCloneError: (info) => {
        // Console line is kept as a paper trail even when the renderer
        // isn't wired (sub-agent workers, headless test rigs).
        console.warn(
          `[Agentic Loop] transcript clone degraded (mode=${info.mode}, messages=${info.messageCount}): ` +
            (info.primaryError instanceof Error
              ? info.primaryError.message
              : String(info.primaryError)),
        )
        if (info.mode === lastCloneFailureMode) return
        lastCloneFailureMode = info.mode
        // Emit typed phase event so dashboards / renderer can react.
        // Renderer wiring: `mainStreamRouter` can mark the kernel/AgentContext
        // as "transcript may have drifted" until a fresh user turn arrives.
        const onStreamEventRaw =
          (state.callbacks as { onStreamEvent?: (ev: unknown) => void })
            .onStreamEvent
        if (typeof onStreamEventRaw !== 'function') return
        try {
          // P2 §6.3 migration — strict builder.
          emitPhaseEvent(
            createTransportAdapter(onStreamEventRaw),
            buildTranscriptDegradedPhase({
              iteration: state.iteration,
              conversationId: getAgentContext()?.streamConversationId,
              transcriptCloneDegraded: {
                mode: info.mode,
                error:
                  info.primaryError instanceof Error
                    ? info.primaryError.message
                    : String(info.primaryError),
                ...(info.secondaryError !== undefined
                  ? {
                      secondaryError:
                        info.secondaryError instanceof Error
                          ? info.secondaryError.message
                          : String(info.secondaryError),
                    }
                  : {}),
                messageCount: info.messageCount,
              },
            }),
          )
        } catch (e) {
          console.warn('[Agentic Loop] transcript_clone_degraded emit threw:', e)
        }
      },
    })
    state.hostTranscript.commit(snap)
  }
  state.acceptHostTranscript = (messages) => {
    state.apiMessages = cloneApiMessagesForOrchestration(messages)
    syncAgentContextConversation(state.apiMessages)
  }
  state.refreshMainChatContextHeader = (useApiMessagesOnly?: boolean) => {
    const ctx = getAgentContext()
    if (ctx?.agentId !== 'main' || !ctx.streamConversationId?.trim()) return
    const conv = ctx.streamConversationId.trim()
    const msgs =
      useApiMessagesOnly || state.accumulatedText.length === 0
        ? state.apiMessages
        : [...state.apiMessages, { role: 'assistant', content: [{ type: 'text', text: state.accumulatedText }] }]
    updateConversationContextDisplay(conv, msgs, params.systemPrompt || '', state.toolTokensForContext,
      state.useOpenClaudeDerivedLoopThresholds ? state.loopContextManager.getThresholds() : undefined,
      state.iterationModel)
  }
  state.syncConversation()

  state.systemPromptLayers =
    params.systemPromptLayers ?? getAgentContext()?.systemPromptLayers
  const systemPrompt = params.systemPrompt || ''

  const fireOnTerminate = (): void => {
    if (!options?.onTerminate) return
    if (!state.terminationResult) return
    try {
      options.onTerminate({
        terminationResult: state.terminationResult,
        totalUsage: { ...state.totalUsage },
        transition: state.transition,
        transitionHistory: [...state.transitionHistory],
      })
    } catch (e) {
      console.warn('[Agentic Loop] onTerminate hook threw:', e)
    }
  }

  // Push the final iteration's transition onto history. Idempotent against double-push:
  // only push when we actually advanced past iteration 0 AND the last recorded value differs.
  const finaliseTransitionHistory = (): void => {
    if (state.iteration > 0) {
      const last = state.transitionHistory[state.transitionHistory.length - 1]
      if (last !== state.transition) state.transitionHistory.push(state.transition)
    }
  }

  return { state, systemPrompt, fireOnTerminate, finaliseTransitionHistory }
}

export async function runAgenticLoop(
  params: AgenticLoopParams,
  callbacks: AgenticLoopCallbacks,
  options?: AgenticLoopOptions,
): Promise<void> {
  const { state, systemPrompt, fireOnTerminate, finaliseTransitionHistory } =
    setupAgenticLoopForRun(params, callbacks, options)

  try {
    // ── Main loop ──
    // The inner-iteration body lives in `runAgenticIteration`. This driver owns
    // outcome dispatch; the per-boundary chores (increment + profiler +
    // periodic janitor) are shared with the drive-mode driver via
    // `advanceIterationBoundary` (P1-1 — the two whiles drifted once
    // before that extraction; see loopDriverChores.ts). Drive-mode kernels
    // use {@link driveInnerLoop} for a parallel implementation that adds kernel
    // pause/abort/snapshot at every iteration boundary.
    while (state.iteration < state.maxIterations) {
      advanceIterationBoundary(state)
      const outcome = await runAgenticIteration(state, params, systemPrompt)
      if (outcome.kind === 'terminate') {
        state.profiler.flush()
        return
      }
    }
    // ── Max iterations reached ──
    await finaliseMaxIterations(state, systemPrompt)
    state.profiler.flush()
  } finally {
    finaliseTransitionHistory()
    fireOnTerminate()
  }
}

// ---------------------------------------------------------------------------
// Per-iteration primitive (extracted from the legacy while body).
//
// This is the granular call point the orchestration kernel uses when in drive mode: it owns
// its own `while`, applies pause/abort/checkpoint at every iteration boundary, and dispatches
// to this function for the actual phase pipeline. Legacy `runAgenticLoop` calls it from its
// own `while` so behaviour stays byte-for-byte identical for non-drive callers.
//
// Contract:
//   - `state.iteration` and `state.profiler.setIteration(state.iteration)` are owned by the
//     caller (the driver). On entry they reflect the current iteration number.
//   - `state.transitionHistory` push, `P2_Q_iteration_open` report, and the iteration
//     profiler checkpoint live INSIDE this function (try/finally for the checkpoint).
//   - Termination paths (errors, hook_stopped, aborted, blocking_limit, max_turns) call
//     `runTerminationCleanup` and return `{ kind: 'terminate' }`; `state.terminationResult`
//     is populated so the driver can read it.
//   - `state.profiler.flush()` is the driver's responsibility (called once after the while
//     exits, exactly the way the legacy single-flush-per-run behaviour worked).
// ---------------------------------------------------------------------------

export type IterationOutcome = { kind: 'continue' } | { kind: 'terminate' }

// ---------------------------------------------------------------------------
// P1 — applyOutcome helper. Atomically writes the result of a
// `decideIterationOutcome` call back to the loop state and runs the
// matching termination cleanup. Returns the loop-driver step result
// (`{ kind: 'terminate' }` for any terminate path; `{ kind: 'continue' }`
// for continuations).
//
// Two write strategies the helper honours:
//   - `phase_wrote_termination` — a phase module (preModel / stream /
//     postModel) already populated `state.terminationResult` AND already
//     called `runTerminationCleanup`. We do NOTHING extra in this branch
//     — re-firing cleanup would invoke every registered hook twice
//     (memory extract, dream extract, telemetry sinks etc.) which is
//     observable in production even for "idempotent" hooks (every hook
//     pays its I/O cost twice). upstream parity: the legacy `iteration.ts`
//     also did NOT re-fire cleanup for stream-wrote-termination paths;
//     the audit fix here restores that invariant after the P1 refactor
//     accidentally introduced a defensive double-fire.
//   - `caller_writes_termination` (default) — the iteration body owns
//     all of: `onError` emission (when there's an `errorDetail`),
//     `onMessageEnd` emission, `createTerminalResult`, cleanup.
//
// Special-case: `max_turns` routes through `finaliseMaxIterations`
// (fires `onMaxIterationsReached` + updates conversation context
// display) instead of the generic terminate path. SA-2 fix 3: the
// decision table no longer maps post-tool aborts to `max_turns` (user
// cancellation wins, even on the last allowed iteration), so this
// branch is kept for genuine budget-exhaustion outcomes only.
// ---------------------------------------------------------------------------

async function applyOutcome(
  state: import('../../ai/agenticLoop/loopShared').LoopState,
  outcome: IterationDecisionOutcome,
  systemPrompt: string,
): Promise<IterationOutcome> {
  if (outcome.kind === 'continue') {
    // The iteration body doesn't issue `continue` outcomes through this
    // helper today (`noTools.ts` handles its own continuation side-
    // effects internally). Reserved for future kernel-driven extension
    // where the outer driver wires the apply step.
    return { kind: 'continue' }
  }

  // outcome.kind === 'terminate'

  // `max_turns` has special UI plumbing (onMaxIterationsReached badge
  // + context display refresh). Delegate to the canonical helper.
  if (outcome.reason === 'max_turns') {
    await finaliseMaxIterations(state, systemPrompt)
    return { kind: 'terminate' }
  }

  if (outcome.writeStrategy === 'phase_wrote_termination') {
    // Phase already wrote `state.terminationResult` AND already called
    // `runTerminationCleanup`. Audit fix (post-P1): the previous
    // defensive `await runTerminationCleanup(...)` here was a regression
    // vs the pre-P1 iteration body that simply returned without re-
    // firing cleanup. Re-firing causes every registered stop-hook
    // (memory extract, dream, telemetry sinks) to run twice — observable
    // overhead even for idempotent hooks. Just exit.
    //
    // P2-2 (2026-07 核心层做深) — contract assertion. The decision table's
    // rows 3/5 carry a sentinel `reason: 'model_error'` that only matters
    // when a phase VIOLATED the contract (signalled termination without
    // writing `state.terminationResult`). Pre-fix that violation was
    // silent: the driver read a null result and downstream consumers saw
    // nothing at all (no terminal event, no cleanup). Synthesise the
    // sentinel result loudly and run cleanup exactly once — the phase
    // that forgot to write the result cannot have run cleanup either.
    if (!state.terminationResult) {
      const detail =
        'phase signalled phase_wrote_termination without writing state.terminationResult ' +
        `(sentinel reason=${outcome.reason}) — phase contract violation, synthesising terminal result`
      console.error(`[Agentic Loop] ${detail}`)
      state.appendixReport('P2_Q_iteration_open', {
        iteration: state.iteration,
        phaseTerminationMissing: true,
      })
      state.terminationResult = createTerminalResult(outcome.reason, {
        turnCount: state.iteration,
        totalUsage: state.totalUsage,
        errorDetail: detail,
      })
      await runTerminationCleanup(state.terminationResult)
    }
    return { kind: 'terminate' }
  }

  // Standard caller-writes path.
  //
  // 2026-07 interruption-protocol fix — on a user abort, append an explicit
  // `[User interrupted during …]` user message to the transcript BEFORE
  // termination and sync it out. cc-haha parity (`createUserInterruptionMessage`
  // was exported since the upstream port but had no production caller): the
  // main-chat next turn is rebuilt by the renderer (which stamps its own
  // marker — see `contextBuilder.withInterruptionMarker`), but the kernel
  // drive-mode transcript blob, the ALS conversation snapshot consumed by
  // forks/tools, and sub-agent rescue paths all read `state.apiMessages` —
  // without the marker they see a truncated turn that looks deliberately
  // complete. An unpaired trailing `tool_use` is fine: restart/rescue paths
  // run `ensureToolUseResultPairing`, which backfills synthetic tool_results
  // ahead of exactly this message shape (see `openClaudeContextParity.test.ts`).
  if (
    outcome.reason === 'aborted_streaming' ||
    outcome.reason === 'aborted_tools'
  ) {
    state.apiMessages.push(createUserInterruptionMessage(outcome.reason))
    state.syncConversation()
  }
  if (outcome.errorDetail) {
    state.callbacks.onError(outcome.errorDetail)
  }
  state.callbacks.onMessageEnd(state.totalUsage)
  state.terminationResult = createTerminalResult(outcome.reason, {
    turnCount: state.iteration,
    totalUsage: state.totalUsage,
    ...(outcome.errorDetail ? { errorDetail: outcome.errorDetail } : {}),
    ...(outcome.hookName ? { hookName: outcome.hookName } : {}),
  })
  await runTerminationCleanup(state.terminationResult)
  return { kind: 'terminate' }
}

// ---------------------------------------------------------------------------
// SA-2 fix 2 — duplicate tool_use id repair.
//
// Walks every assistant message looking for duplicate `tool_use` ids within
// the same message. The first occurrence is kept verbatim; each later
// duplicate is renamed to the deterministic `${id}__dup1` / `__dup2` / …
// form. The paired `tool_result` blocks in the user messages that follow
// (up to the next assistant turn — the natural pairing window) are rewritten
// in order of appearance: the first tool_result per original id stays with
// the kept tool_use, the 2nd/3rd/… map to `__dup1`/`__dup2`/….
//
// A renamed duplicate that never had a tool_result of its own is left
// unpaired here — the caller re-runs `ensureToolUseResultPairing` to
// backfill, matching that helper's existing semantics.
//
// Mutation contract: copy-on-write. Message/content objects may be shared
// with frozen orchestration transcript clones, so repaired messages are
// replaced wholesale in the (caller-owned, mutable) `apiMessages` array
// rather than edited in place. Returns `true` when anything was repaired;
// the normal (no-duplicate) path performs zero writes.
// ---------------------------------------------------------------------------

export function repairDuplicateToolUseIds(
  apiMessages: Array<Record<string, unknown>>,
): boolean {
  let repaired = false
  for (let mi = 0; mi < apiMessages.length; mi++) {
    const msg = apiMessages[mi]
    if (msg?.role !== 'assistant' || !Array.isArray(msg.content)) continue
    const blocks = msg.content as Array<Record<string, unknown>>
    const seen = new Set<string>()
    const dupCount = new Map<string, number>()
    const renames: Array<{ bi: number; oldId: string; newId: string }> = []
    for (let bi = 0; bi < blocks.length; bi++) {
      const b = blocks[bi]
      if (b.type !== 'tool_use' || typeof b.id !== 'string') continue
      if (!seen.has(b.id)) {
        seen.add(b.id)
        continue
      }
      const n = (dupCount.get(b.id) ?? 0) + 1
      dupCount.set(b.id, n)
      renames.push({ bi, oldId: b.id, newId: `${b.id}__dup${n}` })
    }
    if (renames.length === 0) continue
    repaired = true
    console.error(
      `[DUPLICATE_TOOL_USE] message[${mi}] carried duplicate tool_use ids — auto-repaired: ` +
        renames.map((r) => `"${r.oldId}" -> "${r.newId}"`).join(', '),
    )
    const newBlocks = blocks.slice()
    for (const r of renames) {
      newBlocks[r.bi] = { ...newBlocks[r.bi], id: r.newId }
    }
    apiMessages[mi] = { ...msg, content: newBlocks }

    // Rewrite paired tool_results in the following user messages.
    const resultSeen = new Map<string, number>()
    for (let mj = mi + 1; mj < apiMessages.length; mj++) {
      const m2 = apiMessages[mj]
      if (m2?.role === 'assistant') break
      if (m2?.role !== 'user' || !Array.isArray(m2.content)) continue
      const c2 = (m2.content as Array<Record<string, unknown>>).slice()
      let changed = false
      for (let bj = 0; bj < c2.length; bj++) {
        const b2 = c2[bj]
        if (b2?.type !== 'tool_result' || typeof b2.tool_use_id !== 'string') continue
        const oid = b2.tool_use_id
        const dups = dupCount.get(oid)
        if (!dups) continue
        const idx = resultSeen.get(oid) ?? 0
        resultSeen.set(oid, idx + 1)
        if (idx === 0) continue // pairs with the kept (first) tool_use
        if (idx <= dups) {
          c2[bj] = { ...b2, tool_use_id: `${oid}__dup${idx}` }
          changed = true
        }
      }
      if (changed) apiMessages[mj] = { ...m2, content: c2 }
    }
  }
  return repaired
}

/**
 * P1 (audit) — run the `no_tools_continue` host-attachment collectors
 * (inbox / notifications / digest) on a no-tool turn that decided to
 * continue, so queued external events aren't starved until the next tool
 * batch. Preserves the silent-stop invariant by lifting the trailing
 * continuation directive (if `handleNoToolsBranch` appended one) before the
 * collectors push their side-channel messages, then re-appending it so the
 * directive stays the transcript tail.
 */
async function runNoToolsContinueCollectors(
  state: import('../../ai/agenticLoop/loopShared').LoopState,
  systemPrompt: string,
  appendedDirective: Record<string, unknown> | undefined,
): Promise<void> {
  const msgs = state.apiMessages
  const last = msgs.length > 0 ? msgs[msgs.length - 1] : undefined
  // Guarded lift by OBJECT IDENTITY: only pop when the current tail IS the
  // exact directive object `handleNoToolsBranch` just pushed. This is robust
  // against the `<system-reminder>` wrapping / clamping applied to the
  // directive's `content` — unlike the previous exact-content string match,
  // which would silently fail (no pop → collectors land AFTER the directive →
  // "directive must be the transcript tail" invariant broken) the moment the
  // returned locator string diverged from the pushed content.
  const directiveMsg =
    appendedDirective !== undefined && last === appendedDirective
      ? msgs.pop()
      : undefined
  const lengthBeforeCollectors = state.apiMessages.length
  const result = await runCollectors({ state, systemPrompt, callSite: 'no_tools_continue' })
  // Re-append the directive so it remains the transcript tail. subAgentOutputs
  // may have reassigned `state.apiMessages` to a spliced copy — push onto the
  // current reference.
  if (directiveMsg) {
    const directiveFingerprint = fingerprintTranscript([directiveMsg])
    for (let index = state.apiMessages.length - 1; index >= 0; index -= 1) {
      if (fingerprintTranscript([state.apiMessages[index]]) !== directiveFingerprint) continue
      state.apiMessages.splice(index, 1)
      break
    }
    state.apiMessages.push(directiveMsg)
  }
  // Direct-mutation collectors report `requiresConversationSync`; retain
  // the length guard as a defensive fallback around the directive shuffle.
  if (
    result.requiresConversationSync ||
    directiveMsg !== undefined ||
    state.apiMessages.length !== lengthBeforeCollectors
  ) {
    state.syncConversation()
  }
}

export async function runAgenticIteration(
  state: import('../../ai/agenticLoop/loopShared').LoopState,
  params: AgenticLoopParams,
  systemPrompt: string,
): Promise<IterationOutcome> {
  const endIterationCp = state.profiler.startCheckpoint(QUERY_PROFILER_LABELS.iteration)
  // upstream §11.2 — push the prior iteration's resolved transition onto the history before any
  // phase has the chance to overwrite it. Phase modules (stream / toolExec / noTools)
  // overwrite `state.transition` when they take a recovery path; the orchestrator captures
  // whatever the previous iteration ended on. Iteration 1 keeps the initial 'init' marker.
  state.transitionHistory.push(state.transition)
  state.appendixReport('P2_Q_iteration_open', {
    iteration: state.iteration,
    transition: state.transition,
  })

  try {
    // Kernel-owned iteration boundary control point (audit P0-self-fix F-1).
    // Moved BEFORE the `signal.aborted` check so non-drive callers
    // (sub-agent / teammate / skill-fork) get a real chance to interpret
    // their own conditions (token budget exceeded, custom cancel token,
    // task timeout) and produce the typed `iteration_boundary_stopped`
    // termination reason — even when the trigger is the same abort signal
    // the L<below> gate would also catch. Drive mode never passes a hook,
    // so the second check still owns drive-mode aborts.
    //
    // Returns `{ stop: true }` → terminate with `iteration_boundary_stopped`
    // (no `onError`; this is a graceful early exit).
    if (params.iterationBoundaryHook) {
      let boundaryDecision: { stop?: boolean } | void
      try {
        boundaryDecision = await params.iterationBoundaryHook(state.iteration)
      } catch (e) {
        console.warn('[Agentic Loop] iterationBoundaryHook threw (continuing):', e)
        boundaryDecision = undefined
      }
      if (boundaryDecision && boundaryDecision.stop) {
        // P1-28: was previously misreported as `aborted_tools`. The kernel's
        // boundary hook is a graceful pause-or-checkpoint, not a user abort.
        // P1 — decision table row 2.
        return applyOutcome(
          state,
          decideIterationOutcome({ boundaryHookStop: true }),
          systemPrompt,
        )
      }
    }
    // P1-27: bail out cleanly on already-aborted signal BEFORE any of the
    // pre-stream pipeline mutates `state.apiMessages`. Previously the
    // pre-model preprocess, kernel-inbox drain, and hard-stop directive
    // could push extra user/system messages and even trigger compact
    // AFTER abort, which both wasted compute and corrupted the transcript
    // that `syncConversation` writes back to the parent context.
    //
    // Fallback for callers without an `iterationBoundaryHook` (drive mode,
    // legacy paths). Non-drive callers can claim a more specific reason by
    // returning `{ stop: true }` from their hook above.
    // P1 — routed through the unified decision table; this is row 1.
    if (state.signal.aborted) {
      return applyOutcome(
        state,
        decideIterationOutcome({
          preStreamAbort: { reason: 'aborted_streaming' },
        }),
        systemPrompt,
      )
    }

    // P0-1 — Mid-iteration auto-checkpoint.
    //
    // Failure mode this prevents: Electron main process crash (OOM, GPU
    // process die, OS kill) mid-turn loses the entire turn's progress.
    // `iteration` / `innerIteration` / `maxOutputRecoveryCycles` /
    // `consecutiveCompactFailures` all reset on restart, so the user has to
    // re-prompt and re-pay for tokens already spent.
    //
    // With this hook, every inner-iteration entry triggers a throttled
    // `kernel.persist()` (skipped if last successful persist was < 200ms ago)
    // so a crash loses at most one inner iteration of progress. `inboxPersistence`
    // already handles inbox; `kernel.persist()` carries the remaining counters
    // and transcript. Restart path is already in place: see kernel.ts L726-735
    // "Bug A fix" which seeds counters from `prevPersistedBlob`.
    //
    // Sub-agent safety: only the main agent persists. Sub-agents either don't
    // have a kernel registered for their conversationId, or share parent's
    // conversationId but should not overwrite parent's blob. The agentId guard
    // matches `refreshMainChatContextHeader`'s 'main' check (kernel.ts L188).
    // 阶段 1 (kernel-loop deep integration) — mid-iteration persistence now
    // routes through the injected `kernelLoopPort` instead of the global
    // `getOrchestrationKernelForConversation` service-locator + `agentId==='main'`
    // string check. The kernel injects this port via `driveInnerLoop`
    // (`OrchestrationKernel.runDriveMainChat`), so the inner loop talks to it
    // through an explicit, testable contract. `persistThrottled` folds the
    // former two-step `syncMetaCounters` + throttled `persist`:
    //   - reflect the inner-loop soft-cap counters into kernel state (so the
    //     on-disk blob carries non-zero max-output-recovery / consecutive-
    //     compact counts for restart-recovery — audit §4.1), then
    //   - persist a throttled snapshot (skipped if last persist < 200ms ago).
    // Non-kernel callers (sub-agents without a kernel, legacy `runAgenticLoop`
    // callers, unit tests) leave the port unset → mid-iteration persistence is
    // skipped, exactly as the old `agentId==='main'` guard did. The port
    // self-guards and never throws.
    state.kernelLoopPort?.persistThrottled({
      maxOutputRecoveryCycles: state.maxOutputRecoveryCycles,
      consecutiveCompactFailures: state.consecutiveCompactFailures,
    })

    // Clear residue from previous iteration (defensive; the consume call
    // after executeToolBatch should have already drained it).
    consumeAgentContextPendingHookStop()

    cleanupStaleAgents()
    await drainMainThreadProcessCommandQueue()
    state.appendixReport('P2_Q_command_queue_drain', { iteration: state.iteration })

    // D3 — snapshot file paths before compaction can drop early messages
    snapshotFilePathsForConversation(
      getAgentContext()?.streamConversationId,
      state.apiMessages,
    )

    // Refresh tool definitions if needed
    if (state.enableTools && !state.hasToolDefinitionsOverride) {
      const rev = toolRegistry.getToolsetRevision()
      if (rev !== state.lastToolsetRevision) {
        state.lastToolsetRevision = rev
        state.baseToolDefinitions = getToolDefinitions(state.permissionRules)
        state.iterationToolDefs = state.baseToolDefinitions
      }
    }

    // Note: pre-Phase-B this block housed:
    //   - Host transcript inbox drain ad-hoc try/catch + push
    //   - `injectPendingInterAgentQueue` ad-hoc push
    //   - the deleted 80%-iteration wrap-up directives
    //   - the original (also iter-top) compaction_reminder
    // All four are now collectors under `runCollectors({ callSite: 'post_tool' })`
    // (see invocation after `executeToolBatch` further down). The
    // post-tool position matches upstream's `getAttachmentMessages`
    // semantics — the model perceives drained queue content as
    // "system observations attached to the prior tool batch" rather
    // than synthetic instructions appearing mid-conversation.

    // Apply inline skill filter
    state.iterationToolDefs = state.baseToolDefinitions
    state.iterationModel = state.model
    state.iterationEffort = state.effortFromParams
    if (state.activeInlineSkillSession) {
      const session = state.activeInlineSkillSession
      if (session.model?.trim()) {
        state.iterationModel = resolveSkillModelOverride(session.model.trim(), state.model, state.config.id)
      }
      if (session.allowedTools?.length) {
        state.iterationToolDefs = filterToolDefinitionsForSkill(state.baseToolDefinitions, session.allowedTools)
      }
      if (session.effort) state.iterationEffort = session.effort
    }

    // SA-2 fix 1 — compute the tool-schema token cost as soon as this
    // iteration's tool set is final, BEFORE `runPreModelPhase` reads
    // `state.toolTokensForContext` (preModel.ts) for its compact gate and
    // `state.toolsForApi` for the Anthropic count-tokens prefetch.
    // Previously this was computed only AFTER preModel, so the gate saw 0
    // on iteration 1 and the previous iteration's stale value afterwards —
    // systematically under-estimating the tool-schema overhead. Computed
    // exactly once per iteration (the post-normalize block below no longer
    // recomputes it).
    state.toolTokensForContext = state.iterationToolDefs.length > 0
      ? estimateToolDefinitionsTokens(state.iterationToolDefs) : 0
    state.toolsForApi = state.iterationToolDefs.length > 0 ? state.iterationToolDefs : undefined

    // Thinking transcript normalization
    state.apiMessages = ensureToolUseResultPairing(state.apiMessages)
    const quirksForTranscript = getProviderQuirks(state.config)
    const thinkingSuppressedByGateway = !quirksForTranscript.supportsThinkingBlocks
    const thinkingRequestActive =
      !thinkingSuppressedByGateway &&
      (buildAnthropicThinkingForStreamRequest({
        model: state.iterationModel,
        maxOutputTokens: state.streamMaxOutTokens,
        alwaysThinking: state.alwaysThinking,
        providerSupportsThinking: true,
      }) != null || state.alwaysThinking === true)
    // §10.3 三元组：把 activeConfigId 也算进 snapshot — 不同 API key（同模型同 provider）
    // 也会让旧签名失效，是 upstream-main /login 触发 stripSignatureBlocks 的同源问题。
    const activeConfigIdForSnapshot =
      typeof readDiskSettings().activeConfigId === 'string'
        ? (readDiskSettings().activeConfigId as string)
        : undefined
    state.apiMessages = normalizeAnthropicThinkingTranscript(state.apiMessages, {
      providerId: state.config.id,
      currentModel: state.iterationModel,
      currentConfigId: activeConfigIdForSnapshot,
      previousStreamSnapshot: peekLastStreamModelForThinkingTranscript(getAgentContext()?.streamConversationId),
      thinkingRequestActive,
      stripSignaturesOnModelChange: process.env.POLE_ANTHROPIC_STRIP_THINKING_SIGNATURE_ON_MODEL_CHANGE !== '0',
      forceClaudeShapedMessages: true,
      strictThinkingEcho: quirksForTranscript.thinkingRequiresHistoryEcho,
      // 2026-06 multi-turn degradation fix (root cause 4) — this call's
      // result is assigned back to `state.apiMessages` (persisted), so R1
      // distance truncation MUST NOT run here: it used to destructively
      // rewrite the historical reasoning record every iteration. R1 now
      // applies ephemerally on the wire copy in `stream.ts` (see
      // `applyEphemeralDistanceThinkingTruncation`). §10.2 / §10.3
      // (thinking removal when disabled, signature strip on model change)
      // remain persisted by design — reviewed 2026-07 (P2-3 audit): the
      // renderer's per-turn transcript rebuild restores thinking blocks
      // from ChatMessage storage, so this is not a permanent record loss;
      // see removeThinkingAndRedactedBlocksFromAssistants docstring for
      // the full argument.
      applyDistanceTruncation: false,
    })
    state.syncConversation()

    // ── Phase 1: Pre-model pipeline ──
    const endPreModelCp = state.profiler.startCheckpoint(QUERY_PROFILER_LABELS.preModel)
    const preModel = await runPreModelPhase({
      state,
      systemPrompt,
      isIterationOne: state.iteration === 1,
      hasInitialApiMessages: !!params.initialApiMessages,
    })
    endPreModelCp()
    state.apiMessages = preModel.apiMessages
    state.syncConversation()
    if (preModel.terminated) {
      // P1 — decision table row 3 (phase wrote terminationResult itself).
      return applyOutcome(
        state,
        decideIterationOutcome({ preModelTerminated: true }),
        systemPrompt,
      )
    }

    state.appendixReport('P2_Q_preprocess_pipeline', { iteration: state.iteration, phase: 'orchestrated' })
    // Phase B (granularity uplift): forward the real §6.1 pipeline phases
    // and idle-tool-clear flag from the preModel module instead of the
    // historical `phases: []` / `idleToolClearApplied: false` placeholders.
    // Consumers (e.g. dashboards) can now see exactly which steps fired
    // this iteration (`tool_result_budget`, `history_snip`, `auto_compact`,
    // …) rather than knowing only that the pipeline ran.
    const preModelCallbackAction = state.callbacks.onQueryLoopPreModel?.({
      iteration: state.iteration,
      phases: preModel.pipelinePhases,
      snippedCount: preModel.snippedCount,
      wasContextManaged: preModel.wasPreModelCompacted,
      idleToolClearApplied: preModel.idleToolClearApplied,
    })
    if (preModelCallbackAction?.appendUserContent?.trim()) {
      state.apiMessages.push({ role: 'user', content: preModelCallbackAction.appendUserContent.trim() })
      state.syncConversation()
    }
    if (preModelCallbackAction?.disableToolsForThisTurn) {
      state.iterationToolDefs = []
      // SA-2 fix 1 — keep the precomputed schema-token slots in sync with
      // the emptied tool set (no estimate call needed for zero tools).
      state.toolTokensForContext = 0
      state.toolsForApi = undefined
    }

    // Iter-top host attachments — currently only consumes
    // `pendingToolUseSummary` (haiku-generated recap of previous
    // iter's tool batch). The collector handles the 2s await race,
    // formatting via `formatToolUseSummaryForInjection`, and the
    // concat-to-last-user splice. Must run BEFORE the stream phase
    // so the model sees the summary in this iteration's request,
    // and BEFORE `executeToolBatch` (which would clobber
    // `state.pendingToolUseSummary` with a fresh haiku promise for
    // this iter's tools).
    const iterTopAttachments = await runCollectors({
      state,
      systemPrompt,
      callSite: 'iteration_top',
    })
    if (iterTopAttachments.requiresConversationSync) {
      state.syncConversation()
    }

    // Hard blocking check — read once at state init time and frozen on
    // {@link state.queryConfig} (5-piece-set §A2). Reading via the
    // config snapshot means a mid-run env flip can't toggle the
    // blocking termination semantics of the current turn, which used
    // to be possible with the inline `process.env` read.
    //
    // Main-chat-only guard: `POLE_BLOCKING_LIMIT_HARD` is a single global
    // env switch, so without this guard the hard-termination semantics
    // applied to EVERY agent — including sub-agents — which all share the
    // same `runAgenticLoop`. A sub-agent that trips the blocking threshold
    // would hard-terminate with `blocking_limit` (not retried; doesn't
    // satisfy `shouldRunFinalSummaryRescue`'s `max_iterations || aborted`
    // condition), so it returns whatever fragmentary text it had — a silent
    // failure from the parent's perspective. The main thread has its own
    // user-visible context management, so the hard cap is appropriate there;
    // sub-agents should instead fall through to the graceful auto-/micro-
    // compact degradation path below. Sub-agents always carry a
    // `parentAgentId` (set at spawn in subAgentRunner); the main thread's
    // is `undefined` (QueryConfig contract), so that's the discriminator.
    const isMainChat = !state.queryConfig.parentAgentId
    if (isMainChat && state.queryConfig.blockingLimitHard) {
      const postEval = state.loopContextManager.evaluate(state.apiMessages, systemPrompt, state.toolTokensForContext, state.iterationModel)
      if (postEval.action === 'block') {
        // P1 — decision table row 4. Override the decision's generic
        // errorDetail with the legacy user-visible Pole message so the
        // `onError` surface stays familiar; `terminationResult.errorDetail`
        // will also use this richer string.
        const outcome = decideIterationOutcome({ blockingLimitHard: true })
        if (outcome.kind === 'terminate') {
          outcome.errorDetail =
            '[Pole] Context exceeds blocking threshold (POLE_BLOCKING_LIMIT_HARD=1).'
        }
        return applyOutcome(state, outcome, systemPrompt)
      }
    }

    // Compact boundary + normalize messages
    state.apiMessages = getMessagesAfterCompactBoundary(state.apiMessages)
    if (process.env.POLE_NORMALIZE_MESSAGES_PIPELINE !== '0') {
      // 2026-05 audit (long-run semantic-tag integrity): keep
      // `_sideChannelKind`, `_convertedFromSystem`, `_compactBoundary`,
      // `_compactedAt`, `_forkBoilerplate` and the other typed flags
      // ON `state.apiMessages` after normalization, AND skip the
      // consecutive-user merge pass. Two long-running-conversation
      // failure modes are addressed:
      //
      //   1. `stripInternalMeta: true` previously magnetised the typed-
      //      kind labels off the in-memory transcript every iteration,
      //      silently breaking downstream consumers that read them
      //      from history:
      //        - `staleTodoNudge` / `staleTaskNudge` `computeTurnCounts`
      //          (these kinds had `marker: null`, so `readSideChannelKind`
      //          could not fall back to the body and the double-cadence
      //          throttle reduced to "fire every 10 assistant turns")
      //        - `smooshSystemReminderSiblings` uses `_convertedFromSystem`
      //          to decide which neighbouring user messages may fold
      //        - `findLastCompactBoundaryIndex` prefers `_compactBoundary` /
      //          `_sideChannelKind === compactSummary` as authoritative
      //          identifiers; without them only a substring fallback remained
      //
      //   2. `mergeConsecutiveUserMessages` (called from inside
      //      `filterAndTransform`) folds `user (tool_result)` and
      //      `user (side-channel reminder)` into a single turn under
      //      AND-semantics that DROPS the side-channel's typed kind
      //      flag whenever either side is a "real user". A `user
      //      (tool_result)` turn does NOT carry `_convertedFromSystem`,
      //      so it gets treated as a real user — and the freshly-injected
      //      reminder gets demoted to "generic converted system" on the
      //      next iteration's normalize. This is the same failure mode
      //      as (1) but routed through merge instead of strip.
      //
      // The streamHandler call site (`electron/ai/streamHandler.ts:865`)
      // ALREADY runs `normalizeMessagesForAPI` with `stripInternalMeta:
      // true` AND `applyConsecutiveUserMerge: true` (defaults) against
      // a fresh clone before going on the wire, so the "no `_xxx` keys
      // leak to providers" contract and Bedrock-style "no back-to-back
      // user turns" invariant are unchanged. This iteration-level pass
      // only needs to keep `state.apiMessages` in a shape downstream
      // code can iterate over (Anthropic-style pairing, tool_use_result
      // pairing, ordering), not in wire shape.
      state.apiMessages = normalizeMessagesForAPI(state.apiMessages, {
        stripInternalMeta: false,
        applyConsecutiveUserMerge: false,
        strictThinkingEcho: quirksForTranscript.thinkingRequiresHistoryEcho,
        // 2026-06 multi-turn degradation fix (Pass 6 side-effect) — this
        // call writes back into `state.apiMessages`, so it must not
        // destroy the persisted reasoning record of thinking-only turns.
        // The wire-bound call in `streamHandler.ts` keeps the default
        // removal, so providers never see dangling thinking messages.
        preserveThinkingOnlyAssistant: true,
      })
      state.syncConversation()
    }

    // Tool tokens were already computed once for this iteration before
    // `runPreModelPhase` (SA-2 fix 1). This single evaluate refreshes the
    // usage snapshot against the post-compact-boundary, post-normalize
    // transcript right before the stream phase.
    state.collapseConversationKey = buildContextCollapseConversationKey(
      getWorkspacePath()?.trim() || undefined,
      getAgentContext()?.streamConversationId,
    ) || ''
    state.loopContextManager.evaluate(state.apiMessages, systemPrompt, state.toolTokensForContext, state.iterationModel)

    // ── Repair: duplicate tool_use IDs before API call (SA-2 fix 2) ──
    // Providers reject transcripts with duplicate tool_use ids (400).
    // The previous diagnostic loop only console.error'd and proceeded to
    // the API anyway. Now we auto-repair: keep the first occurrence,
    // rewrite later duplicates (and their paired tool_results) to a
    // deterministic `${id}__dupN` form. Zero writes on the normal path.
    if (repairDuplicateToolUseIds(state.apiMessages)) {
      // A renamed duplicate may have had no tool_result of its own — re-run
      // the pairing pass so the backfill keeps the transcript API-valid.
      state.apiMessages = ensureToolUseResultPairing(state.apiMessages)
      state.syncConversation()
    }

    // ── Phase 2: Stream pass ──
    // Audit fix: reset BOTH withhold slots — `runStreamWithRetry` re-resets
    // them at the top of every retry, but clearing here in lockstep keeps
    // the two state slots in sync at iteration boundaries (defends against
    // future refactors that move the inner reset).
    state.withheldStreamError = null
    state.withheldStreamSignal = null
    const endStreamCp = state.profiler.startCheckpoint(QUERY_PROFILER_LABELS.stream)
    const streamResult = await runStreamPhase({ state, systemPrompt })
    endStreamCp()

    // Propagate stream outputs back to state
    state.accumulatedText = streamResult.accumulatedText
    state.toolUseBlocks = streamResult.toolUseBlocks
    state.thinkingBlocks = streamResult.thinkingBlocks
    state.serverToolUseBlocks = streamResult.serverToolUseBlocks
    state.codeExecutionResultBlocks = streamResult.codeExecutionResultBlocks
    state.lastStreamStopReason = streamResult.lastStreamStopReason
    state.lastStreamUsageForPole = streamResult.lastStreamUsageForPole
    state.lastStreamInputTokens = streamResult.lastStreamInputTokens
    state.iterationModel = streamResult.iterationModel
    state.streamMaxOutTokens = streamResult.streamMaxOutTokens
    state.maxOutputRecoveryCycles = streamResult.maxOutputRecoveryCycles
    state.totalUsage = streamResult.totalUsage
    state.lastStreamEndMs = streamResult.lastStreamEndMs

    // Check for early termination from stream phase (e.g. reactive compact failure).
    // P1 — decision table row 5 (stream phase wrote terminationResult itself).
    if (state.terminationResult) {
      return applyOutcome(
        state,
        decideIterationOutcome({ phaseWroteTermination: true }),
        systemPrompt,
      )
    }
    // P1-27: if the stream pass exited because the parent abort fired,
    // do NOT run any of the post-stream branches (no-tool-use stop hooks,
    // tool execution, post-tool context manage) — they would push extra
    // `<system-reminder>` blobs or trigger expensive compaction for an
    // iteration the user has already cancelled.
    // P1 — decision table row 6.
    if (state.signal.aborted) {
      return applyOutcome(
        state,
        decideIterationOutcome({
          postStreamAbort: { reason: 'aborted_streaming' },
        }),
        systemPrompt,
      )
    }
    // Session memory triggers
    if (!streamResult.contextLengthExceeded) {
      // §10.3 三元组写回：用本轮使用的 (provider, model, configId) 覆盖 snapshot
      const activeConfigIdForRemember =
        typeof readDiskSettings().activeConfigId === 'string'
          ? (readDiskSettings().activeConfigId as string)
          : undefined
      rememberLastStreamModelForThinkingTranscript(
        getAgentContext()?.streamConversationId,
        {
          provider: state.config.id,
          model: state.iterationModel,
          ...(activeConfigIdForRemember ? { configId: activeConfigIdForRemember } : {}),
        },
      )
      const memCtx = getAgentContext()
      if (
        getMemoryFeatureFlags().sessionMemoryEnabled &&
        memCtx?.agentId === 'main' &&
        memCtx.streamConversationId?.trim()
      ) {
        const cid = memCtx.streamConversationId.trim()
        recordMainThreadSessionMemorySignals(cid, {
          inputTokensThisTurn: state.lastStreamInputTokens,
          toolCallsThisTurn: state.toolUseBlocks.length,
        })
        // P0: only fire the session-memory extract when this iteration is a
        // *natural breakpoint* — i.e. the model produced no pending tool_use
        // blocks. The trigger condition itself (sessionMemoryTrigger.ts) has
        // a "≥3 tool calls accumulated" fallback that would otherwise fire
        // RIGHT NOW and start a fork sub-agent that races executeToolBatch
        // (line ~1247) for model/API capacity. The signal is preserved in
        // the conversation state via `recordMainThreadSessionMemorySignals`
        // above, so the next no-tool-use turn (or the next user-turn pause)
        // will pick it up cleanly without preempting active tool execution.
        if (state.toolUseBlocks.length === 0 && shouldTriggerSessionMemoryExtract(cid)) {
          const lastApiMsg = state.apiMessages[state.apiMessages.length - 1]
          const lastMsgId = typeof (lastApiMsg as Record<string, unknown> | undefined)?.id === 'string'
            ? (lastApiMsg as Record<string, unknown>).id as string
            : undefined
          markSessionMemoryExtractConsumed(cid, lastMsgId)
          if (process.env.POLE_SESSION_MEMORY_EXTRACT === '0') {
            // disabled
          } else if (tryBeginSessionMemoryExtract(cid)) {
            // One-turn-lag fix (2026-07): this trigger point sits BEFORE
            // `handleNoToolsBranch` pushes the final assistant reply into
            // `state.apiMessages`, so `memCtx.messages` still ends at this
            // turn's user message. Pass the already-final stream text so
            // the scribe's material includes THIS round's conclusion
            // instead of perpetually lagging one round behind.
            const snap = snapshotAgentContextForSessionMemoryFork(memCtx, {
              pendingAssistantText: state.accumulatedText,
            })
            // Audit P3: bind every `.then` / `.catch` / `.finally` handler
            // so failures, suppress-trigger writes, and the in-flight-flag
            // release all run inside this iteration's ALS scope even if the
            // outer loop has already moved on by the time the dynamic import
            // resolves. `runSessionMemoryExtractFork` already uses the
            // explicit `parentSnapshot` so the inner fork still gets the
            // right context; binding here additionally protects the
            // `suppressSessionMemoryExtract` / `endSessionMemoryExtract`
            // module-level reads that take `cid` from this closure.
            void import('../../session/sessionMemoryExtract')
              .then(bindAgentContext(({ runSessionMemoryExtractFork }) =>
                runSessionMemoryExtractFork({ conversationId: cid, parentSnapshot: snap }),
              ))
              .catch(bindAgentContext((e) => {
                console.warn('[SessionMemory] extract failed, suppressing future triggers:', e)
                suppressSessionMemoryExtract(cid)
              }))
              .finally(bindAgentContext(() => endSessionMemoryExtract(cid)))
          }
        }
      }
    }

    // ── Phase 3: No-tool-use branch ──
    if (state.toolUseBlocks.length === 0) {
      const endNoToolsCp = state.profiler.startCheckpoint(QUERY_PROFILER_LABELS.noTools)
      const decision = await handleNoToolsBranch(state, {
        accumulatedText: state.accumulatedText,
        streamingToolExecutor: streamResult.streamingToolExecutor,
        useStreamingToolExecutor: streamResult.useStreamingToolExecutor,
      })
      endNoToolsCp()
      if (decision.action === 'end' || decision.action === 'aborted') {
        if (decision.action === 'aborted') {
          // `handleNoToolsBranch` already wrote `state.terminationResult`
          // and ran cleanup itself for the abort path. Just exit.
          return { kind: 'terminate' }
        }

        // Terminal noTools end. `handleNoToolsBranch` already created
        // `state.terminationResult` (typically `completed`); we still
        // need to fire `onMessageEnd` for the renderer's `message_stop`.
        // P1 — route through applyOutcome for unified cleanup, but use
        // the `phase_wrote_termination` strategy so we don't clobber
        // any phase-specific termination fields. The onMessageEnd fire
        // is handled manually here because the phase wrote the result
        // BEFORE the iteration body got a chance to fire onMessageEnd.
        if (!state.terminationResult) {
          state.terminationResult = createTerminalResult('completed', {
            turnCount: state.iteration,
            totalUsage: state.totalUsage,
          })
        }
        state.callbacks.onMessageEnd(state.totalUsage)
        await runTerminationCleanup(state.terminationResult)
        return { kind: 'terminate' }
      }

      // decision.action === 'continue'. `handleNoToolsBranch` already
      // pushed the assistant reply AND the continuation injection (stop-hook
      // continue / token-budget reminder / declared-intent / active-todo /
      // all-tools-failed guards / inter-agent queue drain) onto
      // `state.apiMessages`. There are NO tool_use blocks to run this turn,
      // so we MUST loop to the next iteration here.
      //
      // Silent-stop audit (2026-06): falling through to Phase 4 with an
      // empty `toolUseBlocks` made `executeToolBatch` (a) push a DUPLICATE
      // assistant message built from the same accumulatedText/thinking and
      // (b) bury the freshly-injected "go" directive behind it — so the
      // next stream pass saw `[assistant, user(directive), assistant(dup)]`
      // with the directive no longer at the tail. That defeated the exact
      // guards meant to PREVENT a silent stop: the nudge never became the
      // latest message, the model didn't act on it, and the loop stalled
      // into a benign-looking `completed` on the following turn. Returning
      // `continue` here keeps the injection at the transcript tail.
      //
      // P1 (audit) — before continuing, run the inbox / notifications /
      // digest host-attachment collectors. Without this, a no-tool turn
      // that continues (stop-hook / token-budget / guard nudge) never
      // reaches the `post_tool` collectors below, so queued kernel inbox
      // items, team-inbox digests, background-task notifications, and
      // sub-agent output/status deltas are starved until the next tool
      // batch. To preserve the silent-stop invariant above, we temporarily
      // lift the trailing continuation directive (if any), let the
      // collectors push their side-channel messages, then re-append the
      // directive so it stays the transcript tail. `interAgentQueue` is
      // intentionally NOT in this call site — it's already drained inline
      // on the no-tool path (`injectPendingInterAgentQueue`).
      await runNoToolsContinueCollectors(state, systemPrompt, decision.appendedDirective)
      return { kind: 'continue' }
    }

    // ── Phase 4: Tool execution ──
    const endToolExecCp = state.profiler.startCheckpoint(QUERY_PROFILER_LABELS.toolExec, {
      toolCount: state.toolUseBlocks.length,
    })
    const toolExecResult = await executeToolBatch(state, {
      accumulatedText: state.accumulatedText,
      streamingToolExecutor: streamResult.streamingToolExecutor,
      useStreamingToolExecutor: streamResult.useStreamingToolExecutor,
    })
    endToolExecCp()
    state.apiMessages = toolExecResult.apiMessages
    state.activeInlineSkillSession = toolExecResult.activeInlineSkillSession
    state.discoveryExclude = toolExecResult.discoveryExclude
    state.pendingToolUseSummary = toolExecResult.pendingToolUseSummary

    // ── Audit Bug 5: post-tool-execution abort guard ──
    // If the user aborted during the tool batch, terminate immediately as
    // `aborted_tools` instead of marching through the rest of the iteration
    // (TodoWrite nudge, hook_stopped detection, post-tool context manage —
    // the last of which can trigger an expensive compaction that's then
    // discarded when the abort check at the bottom of the iteration fires).
    // P1 — decision table rows 14-15. SA-2 fix 3: a post-tool abort always
    // reports `aborted_tools` now — user cancellation wins over `max_turns`
    // even when the iteration budget is exhausted (`iterationExhausted` is
    // informational only).
    if (state.signal.aborted) {
      // BUG-SK5 fix: clear the inline skill session on abort so a stale
      // `activeInlineSkillSession` (with its `allowedTools` whitelist
      // and model override) does not leak into any retry / orchestrated
      // continuation that reuses this state object. Must happen before
      // either termination path below.
      state.activeInlineSkillSession = null
      return applyOutcome(
        state,
        decideIterationOutcome({
          postToolAbort: {
            iterationExhausted: state.iteration >= state.maxIterations,
          },
        }),
        systemPrompt,
      )
    }

    // Tool execution completed without aborting — apply the declarative
    // forward-progress resets. P1-2 (2026-07 核心层做深): the per-guard
    // reset rules (which budget re-arms on ANY batch vs only on a
    // success-bearing batch, and why) now live as a single policy table
    // in `guardBudgetLedger.ts` next to each guard's contract, instead of
    // a hand-written assignment sequence here. Adding a guard budget is
    // one registry row, not a four-file edit.
    applyForwardProgressReset(state, {
      batchHadSuccess: !state.lastToolBatchAllErrors,
    })
    // P1-1 — same "forward progress" signal also resets the
    // iteration-stall streak. A tool-use turn proves the model is doing
    // real work, so any prior low-text/low-delta streak no longer
    // indicates a degenerate loop.
    {
      const cidForStallReset = getAgentContext()?.streamConversationId?.trim()
      if (cidForStallReset) {
        try {
          getIterationStallGuard().resetFor(cidForStallReset)
        } catch (e) {
          console.warn('[Agentic Loop] stall guard resetFor threw:', e)
        }
      }
    }

    // upstream §11.2 — `transition` describes "why did the loop continue from
    // the iteration that just ended into the next one?". Successful tool
    // execution is the dominant signal: even when the stream phase set a
    // recovery flag (reactive_compact / strip_retry / overload_fallback)
    // earlier in the same iteration, the *reason* the next iteration
    // happens is that the model produced tool_use blocks and we executed
    // them — the recovery merely allowed the stream to succeed.
    recordTransition(state, 'tool_use')

    // hook_stopped: a PreToolUse / PostToolUse hook returned
    // `continue: false` / `preventContinuation: true` during the batch.
    // Distinct from a per-tool deny — the hook is asking the entire loop
    // to terminate. Set inside `runAgenticToolUseBody` via
    // `setAgentContextPendingHookStop`; consumed here exactly once.
    const pendingHookStop = consumeAgentContextPendingHookStop()
    if (pendingHookStop) {
      // P1 — decision table row 16.
      return applyOutcome(
        state,
        decideIterationOutcome({
          pendingHookStop: {
            reason: pendingHookStop.reason,
            ...(pendingHookStop.hookName ? { hookName: pendingHookStop.hookName } : {}),
          },
        }),
        systemPrompt,
      )
    }

    // ── Phase 5: Post-tool context management ──
    if (state.iteration > 1) {
      const endPostCompactCp = state.profiler.startCheckpoint(QUERY_PROFILER_LABELS.postCompact)
      try {
        const outcome = await runPostModelPhase({ state, systemPrompt })
        if (outcome.kind === 'terminate') {
          // Compact failed past the soft-failure cap (P0.3) → phase
          // already wrote `state.terminationResult` (`model_error`) and
          // ran `runTerminationCleanup`. P1 — route through the
          // unified decision so cleanup runs in the same place as every
          // other gate (phase_wrote_termination strategy). This is a
          // postModel/compact-phase termination, not a stream one — the
          // `phaseWroteTermination` signal is phase-agnostic by design.
          return applyOutcome(
            state,
            decideIterationOutcome({ phaseWroteTermination: true }),
            systemPrompt,
          )
        }
        if (outcome.kind === 'aborted') {
          // Routed through the unified decision (rows 14-15). SA-2
          // fix 3: always resolves to `aborted_tools` — user
          // cancellation wins over `max_turns` even on the last
          // allowed iteration (`iterationExhausted` is informational).
          return applyOutcome(
            state,
            decideIterationOutcome({
              postToolAbort: {
                iterationExhausted: state.iteration >= state.maxIterations,
              },
            }),
            systemPrompt,
          )
        }
        // outcome.kind === 'ok' — phase logged the compact (if any) and
        // already fired `onContextCompact`. Fall through to the
        // post-Phase-5 `appendixReport` + abort guard the iteration
        // body still owns.
      } finally {
        endPostCompactCp()
      }
    }

    // ── upstream parity — host attachments orchestrator (post_tool) ──
    //
    // Runs AFTER Phase 5 compact so anything injected here survives
    // into the next iteration's pre-model pipeline (which compacts
    // again, but only if needed; small `<system-reminder>` blobs
    // typically pass through). upstream's analog is the
    // `getAttachmentMessages` loop that follows tool execution in
    // `src/query.ts` ~line 1580. Each collector self-gates and
    // failures are isolated via `maybe()` so a bad collector cannot
    // crash the iteration.
    const hostAttachmentsResult = await runCollectors({
      state,
      systemPrompt,
      callSite: 'post_tool',
    })
    if (hostAttachmentsResult.requiresConversationSync) {
      state.syncConversation()
    }

    state.appendixReport('P2_Q_post_tool_context_manage', { iteration: state.iteration })
    state.refreshMainChatContextHeader(true)
    state.appendixReport('P2_Q_loop_continue', { iteration: state.iteration })

    if (state.signal.aborted) {
      // Final per-iteration abort guard. Same rows 14-15 routing as the
      // post-tool abort gate above (always `aborted_tools` — SA-2 fix 3).
      return applyOutcome(
        state,
        decideIterationOutcome({
          postToolAbort: {
            iterationExhausted: state.iteration >= state.maxIterations,
          },
        }),
        systemPrompt,
      )
    }

    // Fall-through — iteration completed normally with tool execution; loop again.
    return { kind: 'continue' }
  } finally {
    endIterationCp()
  }
}

// ---------------------------------------------------------------------------
// Max-iterations termination, extracted so drive-mode kernels can run the same
// cleanup after their own `while` exhausts without duplicating the body.
//
// P1 (2026-05): the legacy `redirectAbortToMaxTurnsIfExhausted` helper was
// folded into `decideIterationOutcome`. SA-2 fix 3 (2026-06) removed the
// redirect entirely: post-tool aborts always terminate as `aborted_tools`
// (user cancellation wins over `max_turns`), so this finaliser now only
// runs when the driver `while` genuinely exhausts `maxIterations`.
// `applyOutcome` still routes any `max_turns` decision through here for
// the special `onMaxIterationsReached` + context-display refresh path.
// ---------------------------------------------------------------------------

export async function finaliseMaxIterations(
  state: import('../../ai/agenticLoop/loopShared').LoopState,
  systemPrompt: string,
): Promise<void> {
  if (state.callbacks.onMaxIterationsReached) {
    state.callbacks.onMaxIterationsReached(state.maxIterations)
  }
  const ctx = getAgentContext()
  if (ctx?.agentId === 'main' && ctx.streamConversationId?.trim()) {
    const tt = state.baseToolDefinitions.length > 0
      ? estimateToolDefinitionsTokens(state.baseToolDefinitions) : 0
    updateConversationContextDisplay(
      ctx.streamConversationId.trim(),
      state.apiMessages,
      systemPrompt,
      tt,
      state.useOpenClaudeDerivedLoopThresholds ? state.loopContextManager.getThresholds() : undefined,
      state.model,
    )
  }
  state.callbacks.onMessageEnd(state.totalUsage)
  state.terminationResult = createTerminalResult('max_turns', {
    turnCount: state.iteration,
    totalUsage: state.totalUsage,
    maxTurnsLimit: state.maxIterations,
  })
  await runTerminationCleanup(state.terminationResult)
}
