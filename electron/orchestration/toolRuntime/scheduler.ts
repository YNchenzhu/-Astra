/**
 * Tool Scheduler — global tool scheduling with priority, preemption, and dependency DAG.
 *
 * Replaces the legacy `planToolExecution` (toolPipeline.ts) which only knew
 * about serial vs parallel grouping *within* a single agent turn.
 *
 * The ToolScheduler is process-wide: it receives tool execution requests from
 * all agents, orders them according to policy, and emits execution plans that
 * respect cross-agent resource limits and dependency constraints.
 */

import type { AgentId } from '../../tools/ids'
import { TOOL_RUNTIME_CLEANUP_DELAY_MS, getRunningToolCount } from './state'
import { MAX_PARALLEL_TOOL_CALLS } from '../../constants/toolLimits'
/** Priority levels. Higher numeric value = higher priority. */
export const ToolPriority = {
  CRITICAL: 100,   // User-facing edits, explicit user commands
  HIGH: 70,        // Coordinator dispatch, plan mode actions
  NORMAL: 50,      // Default agent tools
  LOW: 30,         // Background exploration, proactive reads
  BACKGROUND: 10,  // Telemetry, memory extraction, indexing
} as const
export type ToolPriority = (typeof ToolPriority)[keyof typeof ToolPriority]

export type ToolSchedulerMode = 'legacy' | 'shadow' | 'hold' | 'authoritative'

/**
 * Single scheduler rollout switch. The legacy flags remain readable for one
 * compatibility cycle, with DRIVE taking precedence over ACTIVE exactly as
 * the migration contract specifies.
 */
export function getToolSchedulerMode(): ToolSchedulerMode {
  const explicit = process.env.POLE_TOOL_SCHEDULER_MODE?.trim().toLowerCase()
  if (
    explicit === 'legacy' ||
    explicit === 'shadow' ||
    explicit === 'hold' ||
    explicit === 'authoritative'
  ) {
    return explicit
  }
  if (process.env.POLE_TOOL_SCHEDULER_DRIVE === '1') return 'hold'
  if (process.env.POLE_TOOL_SCHEDULER_ACTIVE === '1') return 'shadow'
  return 'legacy'
}

export function isSchedulerShadowEnabled(): boolean {
  return getToolSchedulerMode() !== 'legacy'
}

/** How a tool can be scheduled relative to siblings. */
export type SchedulingMode = 'serial' | 'parallel' | 'deferred'

export interface ToolScheduleRequest {
  toolUseId: string
  toolName: string
  agentId: AgentId
  parentAgentId?: AgentId
  input: Record<string, unknown>
  /**
   * When true, the tool is read-only and safe to run concurrently
   * with other read-only tools (even across agents, when resources allow).
   */
  readOnly: boolean
  /** Inherited or explicit priority. */
  priority?: number
  /** Scheduling hint from the agent / bundle. */
  mode?: SchedulingMode
  /** If set, this tool must wait until all listed toolUseIds complete successfully. */
  dependsOn?: string[]
  /** Estimated token cost (for budget pre-check). */
  estimatedTokenCost?: number
  /** Estimated wall-clock duration in ms (for timeout hints). */
  estimatedDurationMs?: number
}

export interface ScheduledTool {
  toolUseId: string
  toolName: string
  agentId: AgentId
  /**
   * When 'parallel', this tool may run concurrently with other parallel-safe
   * tools in the same wave. When 'serial', it must run alone.
   */
  executionMode: 'serial' | 'parallel'
  /** Absolute order within the agent's turn (preserves model intent). */
  ordinal: number
}

export interface ExecutionWave {
  /** Tools that may execute concurrently within this wave. */
  parallelTools: ScheduledTool[]
  /** Tools that must execute serially before the next wave. */
  serialTools: ScheduledTool[]
  /** Global resources reserved for this wave (for quota enforcement). */
  reservedTokens?: number
}

export interface ToolExecutionPlan {
  waves: ExecutionWave[]
  /** Tools that cannot be scheduled yet (blocked on dependencies). */
  deferred: ScheduledTool[]
}

/** A node in the dependency DAG. */
interface DependencyNode {
  request: ToolScheduleRequest
  /** Absolute order within the agent's turn (preserves model intent). */
  ordinal: number
  dependsOn: Set<string>
  dependedBy: Set<string>
  status: 'pending' | 'ready' | 'scheduled' | 'completed' | 'failed'
}

/**
 * Process-wide tool scheduler singleton.
 *
 * Design:
 *   1. Accept requests from any agent.
 *   2. Build a DAG from explicit `dependsOn` edges.
 *   3. Topologically sort ready nodes by priority, then ordinal.
 *   4. Group ready nodes into waves respecting:
 *      - max parallel chunk size (read-only vs mutation)
 *      - cross-agent resource budgets (tokens, network, disk)
 *      - preemption rules (pause low-priority running tools)
 */
class ToolScheduler {
  private nodes = new Map<string, DependencyNode>()
  private ordinalCounter = new Map<string, number>() // agentId -> next ordinal
  /**
   * Pending physical-removal timers for completed/failed nodes. We keep nodes in {@link nodes}
   * after a terminal mark so that {@link ToolRuntimeState}'s view (status + GC at
   * {@link TOOL_RUNTIME_CLEANUP_DELAY_MS}) and the scheduler's view stay aligned. Without this,
   * `PolicyEngine.countRecentCalls` could see a 'completed' runtime entry while the scheduler's
   * DAG had already forgotten it (and vice versa for `abortToolsInTree`).
   */
  private cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>()

  private scheduleNodeCleanup(toolUseId: string): void {
    const existing = this.cleanupTimers.get(toolUseId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.nodes.delete(toolUseId)
      this.cleanupTimers.delete(toolUseId)
    }, TOOL_RUNTIME_CLEANUP_DELAY_MS)
    this.cleanupTimers.set(toolUseId, timer)
  }

  /** Enqueue a batch of tools from a single agent turn. */
  enqueueBatch(requests: ToolScheduleRequest[]): void {
    // Build nodes
    for (const req of requests) {
      // Destructive-audit fix (2026-06, S1): some gateways reuse tool_use
      // ids across turns (`call_0` every turn on DeepSeek-style wires). If
      // the reused id's PREVIOUS node reached a terminal state, its 120s
      // cleanup timer is still pending — without cancelling it here, the
      // timer fires mid-flight and deletes the NEW node, so
      // `getNodeStatus` returns undefined and the blocked/unblocked DAG
      // sync in `DefaultToolRuntimePort` silently skips the tool.
      const staleTimer = this.cleanupTimers.get(req.toolUseId)
      if (staleTimer) {
        clearTimeout(staleTimer)
        this.cleanupTimers.delete(req.toolUseId)
      }
      const agentOrdinal = this.ordinalCounter.get(req.agentId) ?? 0
      this.ordinalCounter.set(req.agentId, agentOrdinal + 1)

      const node: DependencyNode = {
        request: { ...req, priority: req.priority ?? ToolPriority.NORMAL },
        ordinal: agentOrdinal,
        dependsOn: new Set(req.dependsOn ?? []),
        dependedBy: new Set(),
        status: 'pending',
      }
      this.nodes.set(req.toolUseId, node)
    }

    // Wire reverse edges for the NEW nodes only. A dependency that is already
    // terminal is resolved inline: 'completed' deps are dropped (satisfied);
    // 'failed' deps cascade-fail the new node immediately (same semantics
    // `markFailed` would have applied had the node existed at failure time).
    for (const req of requests) {
      const node = this.nodes.get(req.toolUseId)
      if (!node) continue
      for (const depId of [...node.dependsOn]) {
        const dep = this.nodes.get(depId)
        if (!dep) {
          // Destructive-audit fix (2026-06, S4): an UNKNOWN dependency can
          // never be satisfied — `markCompleted(depId)` will never reach a
          // node that doesn't exist, and late-enqueued deps don't back-wire
          // `dependedBy` edges either. Leaving the waiter 'pending' leaked
          // it in the map forever (pending nodes get no cleanup timer).
          // Treat unknown exactly like 'failed': cascade-fail now, with the
          // standard 120s retention instead of an unbounded leak.
          this.markFailed(node.request.toolUseId)
          break
        }
        if (dep.status === 'completed') {
          node.dependsOn.delete(depId)
          continue
        }
        dep.dependedBy.add(node.request.toolUseId)
        if (dep.status === 'failed') {
          this.markFailed(node.request.toolUseId)
        }
      }
    }

    // Mark ready nodes (no unresolved deps) — restricted to the new batch.
    //
    // Audit fix (2026-06): this used to iterate ALL nodes, flipping any node
    // with `dependsOn.size === 0` back to 'ready' — including 'scheduled'
    // (currently running) and terminal 'completed'/'failed' nodes that are
    // intentionally retained for TOOL_RUNTIME_CLEANUP_DELAY_MS. Every new
    // batch therefore resurrected up to 120s of finished nodes into the
    // ready pool, polluting `planNextWaves` / `getNodeStatus` and setting up
    // duplicate execution at the future scheduler cutover.
    for (const req of requests) {
      const node = this.nodes.get(req.toolUseId)
      if (node && node.status === 'pending' && node.dependsOn.size === 0) {
        node.status = 'ready'
      }
    }
  }

  /** Lease start hook: one scheduler node transitions to the running/scheduled state. */
  markRunning(toolUseId: string): void {
    const node = this.nodes.get(toolUseId)
    if (!node) return
    if (node.status === 'pending' || node.status === 'ready') node.status = 'scheduled'
  }

  /**
   * Compute the next execution plan from currently ready nodes.
   * Called by the orchestrator before each wave dispatch.
   */
  planNextWaves(options?: {
    maxParallelChunkSize?: number
    maxParallelMutationChunkSize?: number
    respectAgentBoundaries?: boolean
    /** Preview mode leaves ready nodes untouched for a later authoritative grant. */
    markScheduled?: boolean
  }): ToolExecutionPlan {
    const maxParallel = options?.maxParallelChunkSize ?? 10
    const maxParallelMutation = options?.maxParallelMutationChunkSize ?? 3
    const respectAgentBoundaries = options?.respectAgentBoundaries ?? false
    const markScheduled = options?.markScheduled ?? true

    const readyNodes = this.getReadyNodes()
    // Preserve same-agent program order; use priority to arbitrate across agents.
    readyNodes.sort((a, b) => {
      if (a.request.agentId === b.request.agentId) {
        const oa = this.getOrdinal(a.request.toolUseId)
        const ob = this.getOrdinal(b.request.toolUseId)
        if (oa !== ob) return oa - ob
      }
      const pa = a.request.priority ?? ToolPriority.NORMAL
      const pb = b.request.priority ?? ToolPriority.NORMAL
      if (pb !== pa) return pb - pa
      const oa = this.getOrdinal(a.request.toolUseId)
      const ob = this.getOrdinal(b.request.toolUseId)
      if (oa !== ob) return oa - ob
      return a.request.agentId.localeCompare(b.request.agentId)
    })

    const waves: ExecutionWave[] = []
    const deferred: ScheduledTool[] = []
    const plannedIds = new Set<string>()
    let scheduledCount = 0

    // Greedy wave packing:
    //   - Start a new wave with the highest-priority ready node.
    //   - Keep adding read-only nodes while parallel capacity remains.
    //   - Mutation tools are packed more conservatively.
    while (scheduledCount < readyNodes.length) {
      const wave: ExecutionWave = { parallelTools: [], serialTools: [] }
      let parallelSlots = maxParallel
      let mutationSlots = maxParallelMutation
      const agentsInWave = new Set<string>()

      for (const node of readyNodes) {
        if (node.status !== 'ready') continue
        if (plannedIds.has(node.request.toolUseId)) continue
        const req = node.request
        const isReadOnly = req.readOnly
        const isMutation = !isReadOnly
        const ordinal = this.getOrdinal(req.toolUseId)

        if (
          isReadOnly &&
          wave.serialTools.some(
            (tool) => tool.agentId === req.agentId && tool.ordinal < ordinal,
          )
        ) {
          continue
        }

        if (respectAgentBoundaries && agentsInWave.has(req.agentId)) {
          // If we respect boundaries, only one agent per wave
          continue
        }

        if (isMutation) {
          if (mutationSlots <= 0) continue
          mutationSlots--
          parallelSlots--
        } else {
          if (parallelSlots <= 0) continue
          parallelSlots--
        }

        const scheduled: ScheduledTool = {
          toolUseId: req.toolUseId,
          toolName: req.toolName,
          agentId: req.agentId,
          executionMode: req.mode === 'serial' ? 'serial' : isReadOnly ? 'parallel' : 'serial',
          ordinal,
        }

        if (scheduled.executionMode === 'serial') {
          wave.serialTools.push(scheduled)
        } else {
          wave.parallelTools.push(scheduled)
        }

        if (markScheduled) node.status = 'scheduled'
        plannedIds.add(node.request.toolUseId)
        agentsInWave.add(req.agentId)
        scheduledCount++
      }

      if (wave.parallelTools.length === 0 && wave.serialTools.length === 0) {
        // Nothing fit — remaining ready nodes are deferred
        for (const node of readyNodes) {
          if (node.status === 'ready' && !plannedIds.has(node.request.toolUseId)) {
            deferred.push({
              toolUseId: node.request.toolUseId,
              toolName: node.request.toolName,
              agentId: node.request.agentId,
              executionMode: 'serial',
              ordinal: this.getOrdinal(node.request.toolUseId),
            })
          }
        }
        break
      }

      waves.push(wave)
    }

    // Any pending nodes (blocked on unresolved dependencies) are deferred
    for (const node of this.nodes.values()) {
      if (node.status === 'pending') {
        deferred.push({
          toolUseId: node.request.toolUseId,
          toolName: node.request.toolName,
          agentId: node.request.agentId,
          executionMode: 'serial',
          ordinal: this.getOrdinal(node.request.toolUseId),
        })
      }
    }

    return { waves, deferred }
  }

  /** Mark a node as completed (success) so dependents can proceed. */
  markCompleted(toolUseId: string): void {
    const node = this.nodes.get(toolUseId)
    if (!node) return
    if (node.status === 'completed' || node.status === 'failed') return
    node.status = 'completed'

    for (const dependentId of node.dependedBy) {
      const dep = this.nodes.get(dependentId)
      if (!dep) continue
      dep.dependsOn.delete(toolUseId)
      if (dep.dependsOn.size === 0 && dep.status === 'pending') {
        dep.status = 'ready'
      }
    }

    this.scheduleNodeCleanup(toolUseId)
  }

  /** Mark a node as failed. Dependents are also marked failed (cascade). */
  markFailed(toolUseId: string): void {
    const node = this.nodes.get(toolUseId)
    if (!node) return
    if (node.status === 'completed' || node.status === 'failed') return
    node.status = 'failed'

    for (const dependentId of node.dependedBy) {
      this.markFailed(dependentId)
    }

    this.scheduleNodeCleanup(toolUseId)
  }

  /**
   * Cancel all pending/ready/scheduled nodes for an agent (e.g. agent
   * unregistered / interrupted).
   *
   * Deletion (not 120s retention) is intentional here — the wire-in contract
   * (`agentLifecycle.unspawnAndUntrackAgent`) requires that an unregistered
   * agent's nodes do NOT linger for the cleanup window. Terminal nodes from
   * the agent's EARLIER batches keep their retention (they are history, not
   * leaked work).
   *
   * P3 fix (2026-06): the previous single-pass implementation cascade-failed
   * same-agent dependents via `markFailed` BEFORE the loop reached them, so
   * they flipped to terminal 'failed', no longer matched the cancellable
   * status filter, and leaked in the map for the full 120s window — exactly
   * the leak this method exists to prevent. Now the same-agent transitive
   * closure is deleted in one pass; only dependents owned by OTHER agents go
   * through `markFailed` (they should stay visible to their owner's port).
   */
  cancelAgent(agentId: AgentId): number {
    // Collect the agent's directly-cancellable nodes first.
    const toDelete = new Set<string>()
    for (const node of this.nodes.values()) {
      if (
        node.request.agentId === agentId &&
        ['pending', 'ready', 'scheduled'].includes(node.status)
      ) {
        toDelete.add(node.request.toolUseId)
      }
    }
    // Cascade. Set iteration visits items added mid-iteration, so the
    // same-agent dependent closure is handled transitively.
    for (const id of toDelete) {
      const node = this.nodes.get(id)
      if (!node) continue
      node.status = 'failed'
      for (const dependentId of node.dependedBy) {
        const dep = this.nodes.get(dependentId)
        if (!dep) continue
        if (dep.request.agentId === agentId) {
          toDelete.add(dependentId)
        } else {
          this.markFailed(dependentId)
        }
      }
    }
    // Physically remove the agent's nodes now; clear any cleanup timer a
    // prior cascade may have scheduled so it doesn't fire on a deleted key.
    for (const id of toDelete) {
      const timer = this.cleanupTimers.get(id)
      if (timer) {
        clearTimeout(timer)
        this.cleanupTimers.delete(id)
      }
      this.nodes.delete(id)
    }
    return toDelete.size
  }

  /** Peek at ready nodes without mutating state. */
  private getReadyNodes(): DependencyNode[] {
    return Array.from(this.nodes.values()).filter((n) => n.status === 'ready')
  }

  /**
   * Audit §3.2 wire-up — public read of a node's DAG status. Used by
   * `DefaultToolRuntimePort` to keep `ToolRuntimeState` in sync with the
   * scheduler's view: a tool whose scheduler status is `'pending'`
   * (unresolved dependencies) is also marked `'blocked'` in the runtime
   * registry, and flips back to `'queued'` via `markToolUnblocked` when
   * the scheduler cascades `markCompleted` and the node becomes `'ready'`.
   *
   * Returns `undefined` when the toolUseId is unknown (e.g. cleaned up
   * already by the 120s reaper). Callers should treat unknown as "node
   * does not exist" and skip the transition.
   */
  getNodeStatus(toolUseId: string): DependencyNode['status'] | undefined {
    return this.nodes.get(toolUseId)?.status
  }

  /**
   * Cross-agent preemptive-holding predicate (scheduler-drive mode).
   *
   * Returns `held: true` only when BOTH conditions hold:
   *   1. SOME OTHER agent has a `ready`/`scheduled` (non-terminal,
   *      dispatchable) node whose priority is strictly higher than
   *      `selfPriority`; AND
   *   2. the system is contended — global running-tool count has reached the
   *      soft threshold (`holdThreshold`, default {@link getSchedulerHoldThreshold}).
   *      When capacity is free (running count below the threshold) we do NOT
   *      hold, so an idle system keeps full cross-agent parallelism.
   *
   * Intentionally does NOT consider the caller's own nodes (an agent never
   * holds against itself) and does NOT reorder within a batch — intra-batch
   * ordering stays with `toolPipeline.planToolExecution` (reordering reads
   * ahead of earlier writes would violate model intent / data dependencies).
   *
   * Starvation is bounded by the caller: the hold wait shares the same
   * `backpressureMaxWaitMs` deadline as quota backpressure, so a continuously
   * busy higher-priority agent can only delay (never indefinitely block) a
   * lower-priority tool. Pure read — no side effects.
   *
   * `opts` lets unit tests inject `runningCount` / `holdThreshold`
   * deterministically; production callers omit it and get the live count +
   * env-tuned threshold.
   */
  shouldHoldForHigherPriority(
    agentId: AgentId,
    selfPriority: number,
    opts?: { runningCount?: number; holdThreshold?: number },
  ): { held: boolean; reason?: string } {
    let higher: DependencyNode | undefined
    for (const node of this.nodes.values()) {
      if (node.request.agentId === agentId) continue
      if (node.status !== 'ready' && node.status !== 'scheduled') continue
      const p = node.request.priority ?? ToolPriority.NORMAL
      if (p > selfPriority) {
        higher = node
        break
      }
    }
    if (!higher) return { held: false }

    // Capacity soft-threshold: only hold under contention. An idle / lightly
    // loaded system keeps both agents running in parallel.
    const runningCount = opts?.runningCount ?? getRunningToolCount()
    const holdThreshold = opts?.holdThreshold ?? getSchedulerHoldThreshold()
    if (runningCount < holdThreshold) return { held: false }

    const p = higher.request.priority ?? ToolPriority.NORMAL
    return {
      held: true,
      reason: `higher_priority_agent:${String(higher.request.agentId)}:p${p}:running${runningCount}`,
    }
  }

  private getOrdinal(toolUseId: string): number {
    const node = this.nodes.get(toolUseId)
    if (!node) return 0
    return node.ordinal
  }

  /** Debug: dump current DAG state. */
  debugDump(): string {
    const lines: string[] = []
    for (const [id, node] of this.nodes) {
      lines.push(
        `${id} [${node.status}] ${node.request.toolName} ` +
        `deps=[${Array.from(node.dependsOn).join(',')}] ` +
        `dependents=[${Array.from(node.dependedBy).join(',')}]`,
      )
    }
    return lines.join('\n')
  }

  /** Test helper. */
  clear(): void {
    for (const t of this.cleanupTimers.values()) clearTimeout(t)
    this.cleanupTimers.clear()
    this.nodes.clear()
    this.ordinalCounter.clear()
  }
}

// Process-wide singleton
let schedulerInstance: ToolScheduler | undefined

export function getToolScheduler(): ToolScheduler {
  if (!schedulerInstance) {
    schedulerInstance = new ToolScheduler()
  }
  return schedulerInstance
}

export function resetToolSchedulerForTests(): void {
  schedulerInstance?.clear()
  schedulerInstance = undefined
}

/**
 * Scheduler-drive feature flag (default OFF).
 *
 * When `POLE_TOOL_SCHEDULER_DRIVE=1`, the tool-admission paths
 * (`DefaultToolRuntimePort.runQuotaAdmitAndPreemptPhase` + the
 * `toolExec.ts` fallback) gate each tool through
 * {@link ToolScheduler.shouldHoldForHigherPriority} before quota admission,
 * so a lower-priority agent's batch holds while a higher-priority agent has
 * dispatchable work. Off → the holding code is never reached and execution
 * is byte-for-byte the legacy path.
 *
 * Note: this flag does NOT change intra-batch planning — that stays with
 * `toolPipeline.planToolExecution` (order-preserving). The scheduler's
 * authoritative role is purely the cross-agent hold gate.
 */
export function isSchedulerDriveEnabled(): boolean {
  const mode = getToolSchedulerMode()
  return mode === 'hold' || mode === 'authoritative'
}

/**
 * Soft contention threshold for {@link ToolScheduler.shouldHoldForHigherPriority}:
 * a lower-priority tool only holds for a higher-priority agent once the global
 * running-tool count reaches this value. Conservative default = the global
 * read-only parallel ceiling ({@link MAX_PARALLEL_TOOL_CALLS}), i.e. hold only
 * near saturation; operators enabling scheduler-drive can tune it down via
 * `POLE_TOOL_SCHEDULER_HOLD_THRESHOLD` for more aggressive cross-agent holding.
 * Invalid / non-positive values fall back to the default.
 */
export function getSchedulerHoldThreshold(): number {
  const raw = process.env.POLE_TOOL_SCHEDULER_HOLD_THRESHOLD
  const n = raw ? Number.parseInt(raw, 10) : NaN
  return Number.isFinite(n) && n > 0 ? n : MAX_PARALLEL_TOOL_CALLS
}

// Re-export types for consumers
export type { ToolScheduler }
