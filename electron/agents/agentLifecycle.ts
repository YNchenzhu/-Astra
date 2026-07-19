/**
 * Single entry point for "track / untrack an agent" so the two registries
 * stay in sync:
 *
 *   - `activeAgentRegistry` — in-process handle / mailbox / token-budget /
 *     timeout tracking (see `activeAgentRegistry.ts`).
 *   - `MultiAgentOrchestrator` — parent→child tree, worktree affinity,
 *     concurrency limit, `interruptTree` / `pauseTree` / `resumeTree`
 *     cascade (see `orchestration/multiAgent.ts`).
 *
 * Why this exists — historically every spawn path duplicated the
 * `registerActiveAgent` + `orchestrator.register` pair (and the reverse on
 * teardown). The asymmetry already bit us once in `teamAutoLauncher.ts`
 * (team members were invisible to `enforceConcurrencyLimit` so 5-member
 * templates sailed past `maxConcurrentChildren=4`), and bit
 * `resumeAgent.ts` for resumed agents (orphaned from the orchestrator tree,
 * so `interruptTree(parent)` doesn't cascade to them). Routing through
 * this facade keeps both writes atomic w.r.t. caller-visible state.
 *
 * Two entry points, mutually exclusive:
 *   - {@link spawnAndTrackAgent} — caller owns a fully-constructed
 *     {@link ActiveAgent} and wants BOTH registries written atomically.
 *     This is the dominant path (used by `agentTool.ts` foreground +
 *     background spawn, and by `resumeAgent.ts`).
 *   - {@link trackAgentInOrchestrator} — caller does NOT yet have an
 *     ActiveAgent (e.g. `teamAutoLauncher.ts` delegates ActiveAgent
 *     construction to `runSubAgent`'s ephemeral-register branch via
 *     `agentIdOverride`). Only the orchestrator edge is added here;
 *     caller is responsible for registry teardown of their own entry.
 *
 * Teardown via {@link unspawnAndUntrackAgent} is identical for both
 * spawn paths — it drops both sides idempotently.
 *
 * SA-3 fix 3 (2026-06): the previously out-of-scope fork / skill / REPL /
 * disk-recovery spawns that hit `subAgentRunner`'s ephemeral-register
 * branch now ALSO add an orchestrator lineage edge via
 * {@link trackAgentInOrchestrator} (parent = the spawning AgentContext's
 * `agentId`, when present), so `interruptTree(parent)` cascades into them.
 * The runner owns that edge's teardown; callers that pre-register their
 * own edge (teamAutoLauncher) are detected and left untouched.
 */

import type { ActiveAgent } from './types'
import type { AgentId } from '../tools/ids'
import { asAgentId } from '../tools/ids'
import {
  registerActiveAgent,
  unregisterActiveAgent,
} from './activeAgentRegistry'
import {
  abortControllerToKernelShim,
  getMultiAgentOrchestrator,
  getUnifiedOrchestrator,
} from './multiAgentOrchestratorSingleton'
import { getToolScheduler } from '../orchestration/toolRuntime/scheduler'

/** Optional knobs that affect MultiAgentOrchestrator only. */
export interface AgentTrackingOptions {
  /** Worktree path the agent runs in (when isolation requested). */
  worktreePath?: string
}

export type SpawnAndTrackResult = { ok: true } | { ok: false; error: string }

/**
 * Track an agent in BOTH registries (the dominant spawn path).
 *
 * Invariant: after this returns `ok: true`, the agent is in BOTH the
 * `activeAgentRegistry` AND the `MultiAgentOrchestrator` tree. After
 * `ok: false`, neither registry holds a partial entry — if orchestrator
 * registration throws (theoretically impossible since it's an in-memory
 * `Map.set`, but defensive), the facade rolls back the registry entry so
 * callers never observe a half-tracked agent.
 *
 * Fields fed to the orchestrator are derived from `agent` directly:
 *   - `agentType`           → `meta.agentType`
 *   - `parentAgentId`       → `meta.parentKernelId`
 *   - `streamConversationId`→ `meta.conversationId`
 *   - `abortController`     → wrapped via `abortControllerToKernelShim`
 *   - `worktreePath`        → from `options` (registry has no worktree field)
 */
export function spawnAndTrackAgent(
  agent: ActiveAgent,
  options: AgentTrackingOptions = {},
): SpawnAndTrackResult {
  const reg = registerActiveAgent(agent)
  if (!reg.ok) return reg

  const orchRes = trackAgentInOrchestrator({
    agentId: agent.agentId,
    agentType: agent.agentType,
    abortController: agent.abortController,
    ...(agent.parentAgentId ? { parentAgentId: agent.parentAgentId } : {}),
    ...(agent.streamConversationId
      ? { conversationId: String(agent.streamConversationId) }
      : {}),
    ...(options.worktreePath ? { worktreePath: options.worktreePath } : {}),
  })

  if (!orchRes.ok) {
    // Roll back the registry entry so we never have a registered
    // ActiveAgent without an orchestrator edge — that's the exact bug
    // mode that broke `teamAutoLauncher`'s concurrency cap before.
    try {
      unregisterActiveAgent(agent.agentId)
    } catch {
      /* ignore — best-effort rollback */
    }
    return orchRes
  }
  return { ok: true }
}

export interface TrackInOrchestratorParams {
  /** Agent / kernel id (stringified for the orchestrator key). */
  agentId: AgentId | string
  agentType: string
  /** Wrapped via shim so `interruptTree` reaches `abortController.abort()`. */
  abortController: AbortController
  /** When present, the agent becomes a child of `parentAgentId` in the tree. */
  parentAgentId?: AgentId | string
  /** Routes the agent under a conversation for telemetry / scope. */
  conversationId?: string
  /** Worktree isolation path, when applicable. */
  worktreePath?: string
}

/**
 * Track an agent's orchestrator edge ONLY — used when the
 * `activeAgentRegistry` entry is owned elsewhere (today: `teamAutoLauncher`
 * delegates ActiveAgent construction to `runSubAgent`'s ephemeral-register
 * branch via `agentIdOverride`).
 *
 * Caller MUST still call {@link unspawnAndUntrackAgent} on teardown to drop
 * both the registry entry (their own) and the orchestrator edge added here.
 *
 * Throws are caught and returned as `{ ok: false, error }` so callers can
 * decide whether to abort the spawn or just log+proceed (the legacy
 * `teamAutoLauncher` policy was log+proceed — see `registeredWithOrchestrator`
 * flag still in that file).
 */
export function trackAgentInOrchestrator(
  params: TrackInOrchestratorParams,
): SpawnAndTrackResult {
  const orchestrator = getMultiAgentOrchestrator()
  const kernelId = String(params.agentId)
  try {
    orchestrator.register(
      kernelId,
      abortControllerToKernelShim(params.abortController),
      {
        agentType: params.agentType,
        affinity: 'main_process',
        ...(params.parentAgentId
          ? { parentKernelId: String(params.parentAgentId) }
          : {}),
        ...(params.conversationId
          ? { conversationId: params.conversationId }
          : {}),
        ...(params.worktreePath ? { worktreePath: params.worktreePath } : {}),
      },
    )
    return { ok: true }
  } catch (err) {
    return {
      ok: false,
      error: `Failed to register agent in orchestrator: ${
        err instanceof Error ? err.message : String(err)
      }`,
    }
  }
}

/**
 * Reverse of {@link spawnAndTrackAgent} / {@link trackAgentInOrchestrator}:
 * drop both the registry entry and the orchestrator edge. Idempotent —
 * safe to call when either side is already gone (each step is
 * independently try/catch-wrapped).
 *
 * Orchestrator is dropped first so a re-spawn of the same id (rare but
 * possible during resume) doesn't see a stale parent→child edge briefly.
 *
 * Uses `getUnifiedOrchestrator().unregisterAgent(kernelId)` (not
 * `multiAgentOrchestrator.unregister` directly) because the unified path
 * also aborts any tools still in flight under this kernel — mirroring the
 * existing `agentTool.ts:734 / 888` cleanup that this facade replaces.
 */
export function unspawnAndUntrackAgent(agentId: AgentId | string): void {
  try {
    getUnifiedOrchestrator().unregisterAgent(String(agentId))
  } catch (err) {
    console.warn('[agentLifecycle] orchestrator.unregister failed:', err)
  }
  // Cancel any tools this agent has queued/ready/scheduled in the process-wide
  // ToolScheduler. Symmetric to `abortAllToolsForAgent` (which is already
  // invoked via `getUnifiedOrchestrator().unregisterAgent` → `unregisterAgent`
  // → `abortAllToolsForAgent` in `orchestrator.ts:114`), but operates on the
  // scheduler's DAG instead of the runtime-state registry. Without this,
  // unregistered agents leak `'ready'`/`'scheduled'` nodes for the full
  // 120s cleanup window.
  try {
    getToolScheduler().cancelAgent(asAgentId(String(agentId)))
  } catch (err) {
    console.warn('[agentLifecycle] scheduler.cancelAgent failed:', err)
  }
  try {
    unregisterActiveAgent(agentId as AgentId)
  } catch (err) {
    console.warn('[agentLifecycle] activeAgentRegistry.unregister failed:', err)
  }
}
