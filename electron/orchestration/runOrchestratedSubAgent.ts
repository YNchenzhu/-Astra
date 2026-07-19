/**
 * 阶段 2 — run a main-process sub-agent through a lightweight orchestration
 * kernel instead of a bare `runAgenticLoop` call.
 *
 * ## Why this exists
 *
 * In the legacy path a sub-agent registers into the {@link MultiAgentOrchestrator}
 * tree as an `abortControllerToKernelShim` — a `CancellableKernelLike` whose
 * `pause()` / `resume()` are no-ops. So `MultiAgentOrchestrator.pauseTree` /
 * `resumeTree` cascades are silently dropped for children, and a sub-agent gets
 * none of the kernel's checkpoint / persist / cooperative-pause machinery.
 *
 * This adapter constructs a real (in-memory-checkpoint) {@link OrchestrationKernel}
 * for the sub-agent and drives the loop through `kernel.runDriveMainChat`, then
 * UPGRADES the orchestrator edge: it re-registers the same `agentId` with the
 * real kernel (overwriting the shim in place). After this:
 *
 *   - `pauseTree(parent)` / `resumeTree(parent)` actually pause/resume the child
 *     at its next iteration boundary (the kernel's `PauseGate` is awaited inside
 *     `driveInnerLoop`).
 *   - `interruptTree(parent)` cascades through `kernel.interrupt()`.
 *   - the child gets per-iteration checkpoint snapshots.
 *   - the child's tools route through the kernel's PolicyEngine-backed
 *     ToolRuntimePort (process-wide `getPolicyEngine()`), so cross-agent quota /
 *     repeat-failure history is enforced through the same engine the main chat
 *     uses (wired by `buildOrchestrationPortsForLegacyMainChat`).
 *
 * ## Scope
 *
 * Main-process sub-agents only. The worker path (`subAgentWorkerDispatch`) keeps
 * the abort-shim because a `worker_threads` child cannot hold a main-process
 * kernel object. The legacy shim teardown (`unspawnAndUntrackAgent` /
 * `getMultiAgentOrchestrator().unregister(agentId)`) still owns removal: because
 * we re-register under the SAME `agentId`, the existing teardown drops the real
 * kernel edge with no special-casing.
 *
 * Main-process sub-agents always use this Kernel Host. Worker-thread agents
 * use the serialisable Remote Host protocol instead of a Kernel object.
 */

import type { AgenticLoopCallbacks, AgenticLoopParams } from '../ai/agenticLoopTypes'
import type { AgenticLoopResult } from '../ai/loopEvents'
import type { KernelInterruptReason } from './kernel'
import { createKernelForLegacyMainChat } from './kernel'
import { getMultiAgentOrchestrator } from '../agents/multiAgentOrchestratorSingleton'

export interface RunOrchestratedSubAgentOptions {
  /** Orchestrator key for this sub-agent (same id used by the early shim edge). */
  agentId: string
  /** Agent type for orchestrator telemetry / lineage. */
  agentType: string
  /** Parent agent id — makes the child a node under the parent in the tree. */
  parentAgentId?: string
  /** Conversation id for kernel scoping (defaults to a derived `subagent:<id>`). */
  conversationId?: string
  /** Worktree path, when the sub-agent runs isolated. */
  worktreePath?: string
  /**
   * Outcome capture — fires once per outer turn with the typed
   * {@link AgenticLoopResult}. The runner reads `terminationResult.reason` from
   * here to drive its retry policy (model_error → retry), exactly as it did with
   * `runAgenticLoop(..., { onTerminate })`.
   */
  onTerminate?: (result: AgenticLoopResult) => void
  /**
   * Fires once when the kernel's SOFT interrupt signal aborts — i.e. someone
   * called `kernel.interrupt()` directly or through
   * `MultiAgentOrchestrator.interruptTree(parent)`.
   *
   * Why this exists: on the legacy shim path, `interruptTree` aborted the
   * runner's own `bridgeAc`, so every piece of runner bookkeeping keyed off
   * `effectiveLoopSignal` (result `aborted` flag, idle-mailbox wait, retry
   * breaks, iteration-boundary hook) observed the interrupt. On the kernel
   * path the interrupt lives on the kernel's own controller and is merged
   * into streamText/tools only — the runner's signal never fired. Callers
   * should use this hook to abort their own controller and restore parity.
   */
  onKernelInterrupt?: (reason: KernelInterruptReason | undefined) => void
}

/**
 * Drop-in replacement for `runAgenticLoop(params, callbacks, { onTerminate })`
 * that routes a main-process sub-agent through an orchestration kernel.
 *
 * Mirrors `runAgenticLoop`'s contract: resolves when the loop terminates,
 * surfacing the same callbacks. Errors thrown by the kernel propagate to the
 * caller (the runner's try/catch owns them, same as before).
 */
export async function runOrchestratedSubAgent(
  agenticParams: AgenticLoopParams,
  callbacks: AgenticLoopCallbacks,
  options: RunOrchestratedSubAgentOptions,
): Promise<void> {
  const conversationId =
    options.conversationId?.trim() || `subagent:${options.agentId}`

  // The kernel's CallModel phase rebuilds the loop's `messages` from its own
  // transcript (`runCallModelPhase` → `messagesForLoop`), so seed the transcript
  // with the sub-agent's `messages`. Continuation runs pass `messages: []` +
  // `initialApiMessages` (which flows through untouched), so an empty seed is
  // correct there too.
  const seedMessages = agenticParams.messages ?? []

  const kernel = createKernelForLegacyMainChat(
    // noop emitStream — a sub-agent has no renderer phase-event channel of its
    // own; its user-visible output flows through `callbacks`.
    () => {},
    undefined,
    seedMessages,
    {
      streamConversationId: conversationId,
      ...(agenticParams.permissionRules
        ? { permissionRules: agenticParams.permissionRules }
        : {}),
      ...(agenticParams.permissionDefaultMode
        ? { permissionDefaultMode: agenticParams.permissionDefaultMode }
        : {}),
    },
  )

  // Bridge kernel interrupts back to the caller (see option docs). `once` —
  // AbortSignal can only fire once; the kernel's soft controller aborts
  // exclusively via `interrupt()`, so this IS the interrupt notification.
  if (options.onKernelInterrupt) {
    const notify = options.onKernelInterrupt
    kernel.getAbortSignal().addEventListener(
      'abort',
      () => notify(kernel.getInterruptReason()),
      { once: true },
    )
  }

  // Upgrade the orchestrator edge to the REAL kernel for the duration of the
  // run, so `pauseTree`/`resumeTree`/`interruptTree` reach this child. We must
  // not break the two ownership invariants the runner relies on:
  //   - a runner-owned shim edge is torn down by the runner's
  //     `unregister(agentId)` (gated on `registeredOrchestratorEdgeForPending`);
  //   - a caller-owned edge (e.g. teamAutoLauncher's) keeps its own meta +
  //     teardown.
  // So we SNAPSHOT any pre-existing edge, upgrade in place, and on exit either
  // restore the snapshot (pre-existing owner keeps its edge + teardown) or
  // remove our own edge (no pre-existing owner → we created it → we drop it,
  // preventing a leak when the runner's teardown is gated off).
  const orchestrator = getMultiAgentOrchestrator()
  const preExisting = orchestrator.get(options.agentId)
  let upgraded = false
  try {
    orchestrator.register(options.agentId, kernel, {
      agentType: options.agentType,
      affinity: 'main_process',
      ...(options.parentAgentId ? { parentKernelId: options.parentAgentId } : {}),
      conversationId,
      ...(options.worktreePath ? { worktreePath: options.worktreePath } : {}),
    })
    upgraded = true
  } catch (e) {
    // Bookkeeping must never sink the run — fall back to running the kernel
    // un-upgraded (the existing edge stays; pause/resume won't cascade through
    // it, but the loop still executes correctly).
    console.warn('[runOrchestratedSubAgent] orchestrator upgrade-register failed:', e)
  }

  try {
    await kernel.runDriveMainChat({
      agenticParams,
      agenticCallbacks: callbacks,
      rendererMessages: seedMessages,
      ...(options.onTerminate ? { onTerminate: options.onTerminate } : {}),
    })
  } finally {
    // Restore the pre-existing owner's edge (faithful meta) OR drop the edge we
    // created — but only if our upgrade is still the live entry (guard against a
    // concurrent re-spawn having replaced it).
    if (upgraded) {
      try {
        const current = orchestrator.get(options.agentId)
        if (current?.kernel === kernel) {
          if (preExisting) {
            const m = preExisting.meta
            orchestrator.register(options.agentId, preExisting.kernel, {
              agentType: m.agentType,
              affinity: m.affinity,
              ...(m.parentKernelId ? { parentKernelId: m.parentKernelId } : {}),
              ...(m.conversationId ? { conversationId: m.conversationId } : {}),
              ...(m.worktreePath ? { worktreePath: m.worktreePath } : {}),
            })
          } else {
            orchestrator.unregister(options.agentId)
          }
        }
      } catch (e) {
        console.warn('[runOrchestratedSubAgent] orchestrator edge restore/cleanup failed:', e)
      }
    }
    // Cancel the kernel's pending grace-promotion timer.
    try {
      kernel.dispose()
    } catch (e) {
      console.warn('[runOrchestratedSubAgent] kernel.dispose() threw:', e)
    }
  }
}
