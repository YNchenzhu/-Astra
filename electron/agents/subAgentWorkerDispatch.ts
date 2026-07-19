/**
 * Worker-path dispatch for sub-agents.
 *
 * Extracted verbatim from `runSubAgent` (subAgentRunner.ts). Decides whether
 * a sub-agent should run through the worker_threads path and, when it does,
 * owns the worker run's lifecycle bookkeeping. Returns a discriminated
 * outcome so the caller can early-return on a handled run or fall through to
 * the in-process path otherwise.
 */

import type { ProviderConfig } from '../ai/client'
import type { AgentId } from '../tools/ids'
import type {
  AgentDefinitionUnion,
  SubAgentResult,
  SubAgentEvent,
} from './types'
import { getAgentContext } from './agentContext'
import { unregisterActiveAgent } from './activeAgentRegistry'
import { getMultiAgentOrchestrator } from './multiAgentOrchestratorSingleton'
import { isSessionMemoryInternalAgentType } from './sessionMemorySandboxInvariant'
import { appendSubAgentSidechain } from './subAgentSidechainTranscript'
import { finalizeSubAgentLifecycle } from './subAgentLifecycleCleanup'
import { resolveAgentTools } from './subAgentToolResolver'
import { runSubAgentInWorker, subAgentWorkerAvailable } from './subAgentWorkerClient'
import { READONLY_AGENT_TYPES } from './subAgentReadonlyBudget'

export type WorkerDispatchOutcome =
  | { handled: true; result: SubAgentResult }
  | { handled: false }

export async function maybeRunInWorker(args: {
  config: ProviderConfig
  model: string
  agentDef: AgentDefinitionUnion
  prompt: string
  systemPrompt: string
  parentMessages: Array<Record<string, unknown>> | undefined
  effectiveLoopSignal: AbortSignal
  onEvent: (event: SubAgentEvent) => void
  subAgentMaxIterations: number | undefined
  effectiveDiffPermissionMode: 'default' | 'bypassPermissions'
  parentContext: ReturnType<typeof getAgentContext>
  sessionMemoryWritableTargetPath: string | undefined
  isForkRun: boolean
  agentId: AgentId
  startTime: number
  streamConversationId: string | undefined
  mcpLeaseReleaseNames: string[] | undefined
  shouldRegisterForPending: boolean
  registeredOrchestratorEdgeForPending: boolean
  stayRunningForSendMessage: boolean
  /** Worktree workspace root for `isolation: 'worktree'` agents (see runSubAgent). */
  workspaceOverride?: string
}): Promise<WorkerDispatchOutcome> {
  const {
    config,
    model,
    agentDef,
    prompt,
    systemPrompt,
    parentMessages,
    effectiveLoopSignal,
    onEvent,
    subAgentMaxIterations,
    effectiveDiffPermissionMode,
    parentContext,
    sessionMemoryWritableTargetPath,
    isForkRun,
    agentId,
    startTime,
    streamConversationId,
    mcpLeaseReleaseNames,
    shouldRegisterForPending,
    registeredOrchestratorEdgeForPending,
    stayRunningForSendMessage,
    workspaceOverride,
  } = args

  // ── Worker path: delegate to subAgentWorker when enabled ──
  // Uses process env POLE_AGENT_WORKER=1 or readonly agent types.
  // Falls back to in-process path when worker is unavailable or disabled.
  //
  // SA-3 fix 4(a) — SANDBOX INVARIANT: session-memory-internal must NEVER
  // run through the worker_threads path, regardless of env / config. Its
  // single-file sandbox (`gateSessionMemoryInternalAgentToolUse`) only runs
  // in the main process; a worker's LOCAL tool execution would bypass it
  // entirely. The worker has its own defensive refusal (fix 4(b) in
  // subAgentWorker.ts), but the route decision is the primary gate.
  //
  // Worktree isolation: an agent with `isolation: 'worktree'` and an allocated
  // worktree path MUST run on the worker path — only there does the child get
  // its OWN module-level workspace path (set from the init payload below). The
  // in-process path shares the single global workspace path and cannot isolate.
  const wantsWorktreeIsolation =
    agentDef.isolation === 'worktree' && !!workspaceOverride
  const useWorker =
    !isSessionMemoryInternalAgentType(agentDef.agentType) &&
    (process.env.POLE_AGENT_WORKER === '1' ||
      READONLY_AGENT_TYPES.has(agentDef.agentType) ||
      wantsWorktreeIsolation)

  if (!(useWorker && subAgentWorkerAvailable() && !stayRunningForSendMessage)) {
    return { handled: false }
  }

  // SA-3 fix 2 — `workerOwnedLifecycle` (formerly `workerSucceeded`) is
  // true whenever the worker run terminates THIS call (success OR a
  // partial-execution failure we refuse to retry); only then does this
  // block do the lifecycle bookkeeping. `workerToolActivitySeen` flips
  // on the first tool_start / RPC tool_call observed by the client.
  let workerOwnedLifecycle = false
  let workerToolActivitySeen = false
  try {
    const workerResult = await runSubAgentInWorker({
      config,
      model,
      agentDef: {
        agentType: agentDef.agentType,
        maxTurns: agentDef.maxTurns,
        tools: resolveAgentTools(agentDef).map((t) => t.name),
        disallowedTools: agentDef.disallowedTools,
        mcpServers: agentDef.mcpServers?.map((r) => (typeof r === 'string' ? r : r.name)),
      },
      prompt,
      systemPrompt: systemPrompt,
      parentMessages,
      // P0 (audit 6a): forward `effectiveLoopSignal` rather than the raw
      // parent `signal`. `bridgeAc` fires for token / tool-count / wall-
      // clock budget exhaustion AND for `TeamDelete`-style aborts that
      // reach the agent through the `activeAgentRegistry` (whose stored
      // controller IS `bridgeAc`). The previous wiring only listened to
      // `signal`, so worker-path agents (Verification / Plan / Explore
      // and anyone running under `POLE_AGENT_WORKER=1`) silently kept
      // running after a team was disbanded or a budget was exceeded.
      signal: effectiveLoopSignal,
      onEvent: onEvent as unknown as (e: import('./subAgentWorkerClient').SubAgentEvent) => void,
      // SA-3 fix 2 — record tool activity so the catch below can tell a
      // pure startup/init failure (fallback is safe) from a mid-run
      // failure after tools may have executed (fallback would duplicate
      // side effects, especially writes).
      onToolActivity: () => {
        workerToolActivitySeen = true
      },
      // P1-5: hand the registry-assigned agentId to the worker so its
      // SubAgentResult carries the right id, matching the in-process
      // path and any IPC events that have already gone out under it.
      agentId: agentId as unknown as string,
      // P1-4: forward the resolved iteration cap (fork or maxTurns) so
      // the worker enforces the same budget as in-process.
      ...(typeof subAgentMaxIterations === 'number'
        ? { maxIterationsOverride: subAgentMaxIterations }
        : {}),
      // Phase 1B matrix item 4 of 5: pipe the same permission ctx the
      // in-process path applies (see `runAgenticToolUseBody.ts` around
      // L1100). `effectiveDiffPermissionMode` already folds in
      // `effectivePermissionModeOverride` (the sub-agent definition's
      // permission mode) and the path-sandbox carve-out. Without these,
      // the worker pool silently downgraded every sub-agent's RPC ctx
      // to `default`/`ask` with no rules.
      permissionMode: effectiveDiffPermissionMode,
      ...(parentContext?.permissionDefaultMode
        ? { permissionDefaultMode: parentContext.permissionDefaultMode }
        : {}),
      ...(parentContext?.permissionRules
        ? { permissionRules: parentContext.permissionRules }
        : {}),
      // P0 audit fix: forward the child's gate-relevant ALS fields
      // (sessionAgentType + sessionMemoryWritableTargetPath) so the
      // host-side RPC handler can install them via
      // `runWithSubAgentRpcGateAsync` for the duration of every tool
      // execute. Without this, worker-path `session-memory-internal`
      // sub-agents bypass `gateSessionMemoryInternalAgentToolUse`
      // because the host RPC runs in the parent's ALS scope (where
      // `sessionAgentType` is the parent's, not the child's).
      sessionAgentType: agentDef.agentType,
      ...(sessionMemoryWritableTargetPath
        ? { sessionMemoryWritableTargetPath }
        : {}),
      // P1-2 (audit Bug-7 fix) — forward the agent's declared default
      // priority into the worker. Without this, worker-path sub-agents
      // (READONLY_AGENT_TYPES + POLE_AGENT_WORKER) silently lose their
      // `BACKGROUND` / `LOW` tagging — `executeFallbackBatchWithWiring`
      // inside the worker reads `getAgentContext()?.priority`, which
      // returns undefined unless the worker sets up ALS with this value.
      //
      // P1-2 (audit Bug-7 follow-up B7-E) — fork sub-agents inherit
      // their parent's priority when agentDef.defaultPriority is unset.
      // A fork is a stage-2 execution of the same conversation, so it
      // should compete with its parent on equal footing rather than
      // dropping to NORMAL fallback. Built-in non-fork agents declare
      // their own defaultPriority (e.g. session-memory-internal =
      // BACKGROUND) and that wins.
      ...((): { priority?: number } => {
        if (typeof agentDef.defaultPriority === 'number') {
          return { priority: agentDef.defaultPriority }
        }
        if (isForkRun && typeof parentContext?.priority === 'number') {
          return { priority: parentContext.priority }
        }
        return {}
      })(),
      // P1-2 (audit Bug-7 follow-up B7-B) — forward the parentAgentId
      // so the worker's ALS-scoped AgentContext carries lineage that
      // `globalToolCallHistory.registerAgentLineage` reads inside the
      // fallback path. agentId is already on the params above (L984
      // P1-5) and the worker client now propagates it into the
      // SessionInit payload alongside this parentAgentId.
      ...(parentContext?.agentId
        ? { parentAgentId: parentContext.agentId as unknown as string }
        : {}),
      // Worktree isolation: the worker's module-level workspace path is set
      // from this override (falls back to the global path when unset).
      ...(workspaceOverride ? { workspaceOverride } : {}),
    })
    workerOwnedLifecycle = true
    return { handled: true, result: workerResult }
  } catch (workerErr) {
    const workerErrMsg =
      workerErr instanceof Error ? workerErr.message : String(workerErr)
    if (workerToolActivitySeen) {
      // SA-3 fix 2 — the worker already started executing tools before
      // it failed. Re-running the whole sub-agent in-process would
      // repeat those tool calls (double side effects for writes / shell
      // commands), so return the failure instead of retrying.
      workerOwnedLifecycle = true
      const errMsg =
        `Sub-agent worker failed after it had already executed tool calls: ${workerErrMsg}. ` +
        `In-process fallback was skipped to avoid duplicating tool side effects; no automatic retry.`
      const failResult: SubAgentResult = {
        success: false,
        agentId,
        agentType: agentDef.agentType,
        output: errMsg,
        totalTokens: 0,
        totalDurationMs: Date.now() - startTime,
        totalToolUses: 0,
        error: errMsg,
      }
      appendSubAgentSidechain(agentId, {
        kind: 'error',
        summary: errMsg.slice(0, 300),
      })
      onEvent({ type: 'subagent_error', agentId, error: errMsg })
      onEvent({ type: 'subagent_complete', agentId, result: failResult })
      return { handled: true, result: failResult }
    }
    // Pure startup / init failure (no tool ever started) — the legacy
    // in-process fallback below is still side-effect-safe.
    console.warn(
      '[subAgentRunner] worker path failed before any tool execution, falling back in-process:',
      workerErr,
    )
  } finally {
    // P0-1: worker path bypasses the in-process try/finally below; do its
    // bookkeeping here whenever the worker actually owned the lifecycle
    // (success, abort, partial-execution failure, or any other terminal).
    // On fall-through (caught above with no tool activity) we leave
    // bookkeeping to the in-process path.
    if (workerOwnedLifecycle) {
      await finalizeSubAgentLifecycle(agentId, {
        streamConversationId,
        mcpLeaseReleaseNames,
      })
      if (shouldRegisterForPending) {
        // SA-3 fix 3 — drop the lineage edge we added (and only ours;
        // caller-owned edges are torn down by their owners).
        if (registeredOrchestratorEdgeForPending) {
          try {
            getMultiAgentOrchestrator().unregister(String(agentId))
          } catch {
            /* idempotent best-effort teardown */
          }
        }
        unregisterActiveAgent(agentId)
      }
    }
  }

  return { handled: false }
}
