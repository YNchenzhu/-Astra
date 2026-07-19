/**
 * Tool Runtime State — global visibility into every tool invocation across all agents.
 *
 * Why this exists:
 *   - The legacy MultiAgentOrchestrator only tracked Agent (kernel) lifecycles.
 *   - Tool Orchestration requires the orchestrator to see *inside* each agent:
 *     what tool is currently running, how long has it been running, what
 *     resources it holds, and whether it can be preempted.
 *   - This module exposes a process-wide singleton that `runAgenticToolUse`
 *   reports into, so the scheduler and policy engine can make global decisions.
 */

import type { AgentId } from '../../tools/ids'
import {
  recordToolInvocationForRateLimit,
  clearToolRateLimitRingForTests,
} from './rateLimitRing'

/** Unified tool state exposed to the orchestrator layer. */
export type ToolExecutionStatus =
  | 'queued'
  | 'preparing'      // permission checks, validation
  | 'running'
  | 'paused'         // preempted by scheduler
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'blocked'        // policy / quota / dependency

export interface ToolResourceUsage {
  /** Estimated tokens consumed so far (input + output). */
  tokensUsed?: number
  /** Wall-clock ms since the tool entered 'running'. */
  durationMs?: number
  /** Disk bytes written (approximate, for file-mutation tools). */
  diskWriteBytes?: number
  /** Network bytes transferred (for WebFetch/WebSearch). */
  networkBytes?: number
  /** Number of shell child processes spawned. */
  shellChildCount?: number
}

export interface ToolRuntimeEntry {
  /** Unique tool_use id from the model. */
  toolUseId: string
  /** Monotonic reuse generation for provider IDs recycled after terminal state. */
  generation: number
  /** Canonical tool name. */
  toolName: string
  /** Which agent (kernel) owns this invocation. */
  agentId: AgentId
  /** Parent agent, if any. */
  parentAgentId?: AgentId
  /** Conversation id for renderer routing. */
  conversationId?: string
  /** Current lifecycle state. */
  status: ToolExecutionStatus
  /** When the entry was created. */
  createdAt: number
  /** When the tool entered 'running'. */
  startedAt?: number
  /** When the tool reached a terminal state. */
  endedAt?: number
  /** Serialized input (for dedup / cache keys). */
  inputHash: string
  /** Mutable resource counters. */
  resources: ToolResourceUsage
  /**
   * Scheduler-assigned priority. Higher = more important.
   * Inherited from agent priority, but can be overridden per-tool.
   */
  priority: number
  /**
   * When true, the scheduler may pause this tool to free resources
   * for a higher-priority tool. Only safe for idempotent / read-only tools.
   */
  preemptible: boolean
  /** Worktree path if the tool is sandboxed. */
  worktreePath?: string
  /** If blocked, the reason code. */
  blockReason?: 'quota' | 'dependency' | 'policy' | 'backpressure' | 'concurrency' | 'scheduler_hold'
  /** Error message when status is 'failed' or 'aborted'. */
  errorMessage?: string
  /**
   * P2 audit fix — canonical "is this a read-only tool" answer captured at
   * registration time from `toolRegistry.get(name)?.isReadOnly`.
   *
   * Previously `quota.snapshot()` re-derived read/write classification from
   * a hardcoded name allowlist (`isReadOnlyTool(name)` in `quota.ts`) which
   * could disagree with the registry truth that `admit()` callers
   * supplied. The mismatch silently bucketed registry-only read-only tools
   * into the mutation quota slot (or vice versa), causing concurrency
   * decisions to misfire.
   *
   * Optional because legacy / test callers that register entries directly
   * may not have a registry lookup available — `snapshot()` falls back to
   * the name heuristic for those.
   */
  isReadOnly?: boolean
  /**
   * P1 — per-tool AbortController used for preemption (audit §5.2 wire-up).
   *
   * Created automatically in {@link registerToolInvocation}. Fired by
   * {@link preemptTool} when a higher-priority newcomer takes this tool's
   * resource slot. The orchestration adapter merges this signal with the
   * caller's batch signal in `DefaultToolRuntimePort.executeToolBatch`, so
   * the tool's in-flight async work observes the preempt and unwinds
   * cooperatively (same way it unwinds on a user interrupt).
   *
   * Optional so legacy test fixtures that hand-build entries without going
   * through `registerToolInvocation` keep type-checking; production paths
   * always have it populated.
   */
  preemptController?: AbortController
  /**
   * Audit A-6 wire-up — effective input as seen by the tool's `call()`
   * AFTER any middleware substitution. Set by `runAgenticToolUse` once
   * the `applyToolMiddleware` chain has resolved `effectiveInput`. Read
   * by `DefaultToolRuntimePort.executeToolBatch` when calling
   * `history.record(...)` so cross-agent repeat-failure fingerprints
   * reflect the actual executed input, not the pre-substitution one.
   *
   * Undefined when no middleware substituted (the common case);
   * `history.record` then falls back to the original `input` captured at
   * batch entry. This means consumers can `entry.effectiveInput ?? input`
   * everywhere for the canonical executed input.
   */
  effectiveInput?: Record<string, unknown>
}

/** Snapshot returned to telemetry / UI consumers. */
export interface ToolRuntimeSnapshot {
  tools: ToolRuntimeEntry[]
  summary: {
    totalQueued: number
    totalRunning: number
    totalPaused: number
    totalBlocked: number
    totalCompleted: number
    totalFailed: number
  }
}

/** In-memory registry keyed by toolUseId. */
const registry = new Map<string, ToolRuntimeEntry>()

const ACTIVE_TOOL_STATUSES = new Set<ToolExecutionStatus>([
  'queued',
  'preparing',
  'running',
  'paused',
  'blocked',
])

export class DuplicateActiveToolUseIdError extends Error {
  readonly code = 'duplicate_active_tool_use_id'
  readonly toolUseId: string
  constructor(toolUseId: string) {
    super(`duplicate_active_tool_use_id: ${toolUseId}`)
    this.name = 'DuplicateActiveToolUseIdError'
    this.toolUseId = toolUseId
  }
}

/** Simple stable hash for tool input (not crypto-secure, just for dedup keys). */
function hashToolInput(name: string, input: Record<string, unknown>): string {
  try {
    return `${name}::${JSON.stringify(input)}`
  } catch {
    return `${name}::${Date.now()}`
  }
}

/**
 * Register a new tool invocation before any work begins.
 * Called from `runAgenticToolUse` immediately after the tool_use is accepted.
 */
export function registerToolInvocation(params: {
  toolUseId: string
  toolName: string
  agentId: AgentId
  parentAgentId?: AgentId
  conversationId?: string
  input: Record<string, unknown>
  priority?: number
  preemptible?: boolean
  worktreePath?: string
  /**
   * P2 audit fix: canonical read-only flag for this tool, taken from
   * `toolRegistry.get(name)?.isReadOnly` at the call site. When omitted,
   * `quota.snapshot()` falls back to a name-based heuristic — keep the
   * field optional so legacy / test callers don't need to thread the
   * registry lookup.
   */
  isReadOnly?: boolean
}): ToolRuntimeEntry {
  const previous = registry.get(params.toolUseId)
  if (previous && ACTIVE_TOOL_STATUSES.has(previous.status)) {
    throw new DuplicateActiveToolUseIdError(params.toolUseId)
  }
  // Destructive-audit fix (2026-06, T1): gateways reuse tool_use ids across
  // turns (and two concurrent conversations can collide on short ids like
  // `call_0`). If the reused id's previous entry reached a terminal state,
  // its 120s cleanup timer is still pending — without cancelling it, the
  // timer fires mid-flight and deletes THIS entry, losing the preempt
  // controller / quota visibility / sweep bookkeeping for a live tool.
  const staleTimer = cleanupTimers.get(params.toolUseId)
  if (staleTimer) {
    clearTimeout(staleTimer)
    cleanupTimers.delete(params.toolUseId)
  }
  const entry: ToolRuntimeEntry = {
    toolUseId: params.toolUseId,
    generation: (previous?.generation ?? 0) + 1,
    toolName: params.toolName,
    agentId: params.agentId,
    parentAgentId: params.parentAgentId,
    conversationId: params.conversationId,
    status: 'queued',
    createdAt: Date.now(),
    inputHash: hashToolInput(params.toolName, params.input),
    resources: {},
    priority: params.priority ?? 0,
    preemptible: params.preemptible ?? false,
    worktreePath: params.worktreePath,
    ...(typeof params.isReadOnly === 'boolean' ? { isReadOnly: params.isReadOnly } : {}),
    // P1 — per-tool preempt controller (audit §5.2 wire-up).
    preemptController: new AbortController(),
  }
  registry.set(params.toolUseId, entry)
  return entry
}

/**
 * P1 (audit §5.2) — preempt a running tool: abort its per-tool signal so its
 * in-flight async work cancels, then mark it aborted in the registry so the
 * resource slot frees up for the higher-priority newcomer.
 *
 * Returns `true` if the tool was found AND was in a non-terminal state (so a
 * meaningful preempt fired); `false` if the tool is unknown or already
 * terminal (idempotent). The two-step (abort signal + mark aborted) matters
 * for accounting correctness: marking-only without the abort would leave the
 * real shell child / network request running, breaking quota's invariant
 * that "active" entries reflect actual resource usage.
 */
export function preemptTool(toolUseId: string, reason: string): boolean {
  const e = registry.get(toolUseId)
  if (!e) return false
  if (e.status !== 'queued' && e.status !== 'preparing' && e.status !== 'running' && e.status !== 'paused' && e.status !== 'blocked') {
    return false
  }
  if (e.preemptController && !e.preemptController.signal.aborted) {
    try {
      e.preemptController.abort(reason)
    } catch {
      /* ignore — already aborted */
    }
  }
  markToolAborted(toolUseId, reason)
  return true
}

/**
 * P1 (audit §5.2) — observable signal for a specific tool's preempt lane.
 * Used by `DefaultToolRuntimePort.executeToolBatch` to merge per-tool
 * preempt signals with the caller's batch / kernel signal before forwarding
 * to `runAgenticToolUseBatch.resolveToolSignal`.
 */
export function getToolPreemptSignal(toolUseId: string): AbortSignal | undefined {
  return registry.get(toolUseId)?.preemptController?.signal
}

/**
 * Audit A-6 wire-up — record the input the tool actually saw AFTER
 * middleware substitution. Called by `runAgenticToolUse` once the
 * `applyToolMiddleware` chain has resolved its effective input. Reads of
 * the original `input` (e.g. `quota.snapshot()`) keep working; only
 * `history.record` consumes the substituted view to keep cross-agent
 * fingerprints aligned with what was really executed.
 *
 * No-op when the entry is unknown (the registry entry could have been
 * cleaned up by the 120s timer between registration and result).
 */
export function recordToolEffectiveInput(
  toolUseId: string,
  effectiveInput: Record<string, unknown>,
): void {
  const e = registry.get(toolUseId)
  if (!e) return
  e.effectiveInput = effectiveInput
}

/**
 * Audit A-6 wire-up — read the substituted (effective) input. Returns
 * `undefined` when no middleware substituted (or no entry). Callers can
 * `getToolEffectiveInput(id) ?? originalInput` for the canonical
 * executed-input view.
 */
export function getToolEffectiveInput(
  toolUseId: string,
): Record<string, unknown> | undefined {
  return registry.get(toolUseId)?.effectiveInput
}

/** Transition a tool from queued → preparing. */
export function markToolPreparing(toolUseId: string): void {
  const e = registry.get(toolUseId)
  if (!e) return
  e.status = 'preparing'
}

/** Transition a tool from preparing → running. */
export function markToolRunning(toolUseId: string): void {
  const e = registry.get(toolUseId)
  if (!e) return
  e.status = 'running'
  e.startedAt = Date.now()
  recordToolInvocationForRateLimit(e.toolName, e.startedAt)
}

/** Transition a tool to paused (preempted). */
export function markToolPaused(toolUseId: string): void {
  const e = registry.get(toolUseId)
  if (!e) return
  e.status = 'paused'
}

/** Resume a previously paused tool. Destructive-audit fix (2026-06, T2):
 *  only `'paused'` entries flip back — without the guard, a stray resume
 *  call resurrected terminal (completed/failed/aborted) entries into
 *  `'running'`, corrupting quota's active-slot view until the 120s reaper. */
export function markToolResumed(toolUseId: string): void {
  const e = registry.get(toolUseId)
  if (!e) return
  if (e.status !== 'paused') return
  e.status = 'running'
}

/** Mark blocked with a reason. */
export function markToolBlocked(
  toolUseId: string,
  reason: NonNullable<ToolRuntimeEntry['blockReason']>,
): void {
  const e = registry.get(toolUseId)
  if (!e) return
  e.status = 'blocked'
  e.blockReason = reason
}

/** Unblock a tool (e.g. dependency satisfied or quota released). */
export function markToolUnblocked(toolUseId: string): void {
  const e = registry.get(toolUseId)
  if (!e) return
  if (e.status === 'blocked') {
    e.status = 'queued'
    e.blockReason = undefined
  }
}

/** Terminal: completed successfully. */
export function markToolCompleted(toolUseId: string, tokenUsage?: { input: number; output: number }): void {
  const e = registry.get(toolUseId)
  if (!e) return
  e.status = 'completed'
  e.endedAt = Date.now()
  if (tokenUsage) {
    e.resources.tokensUsed = (tokenUsage.input ?? 0) + (tokenUsage.output ?? 0)
  }
  if (e.startedAt) {
    e.resources.durationMs = e.endedAt - e.startedAt
  }
  scheduleCleanup(toolUseId)
}

/** Terminal: failed. */
export function markToolFailed(toolUseId: string, errorMessage: string): void {
  const e = registry.get(toolUseId)
  if (!e) return
  e.status = 'failed'
  e.endedAt = Date.now()
  e.errorMessage = errorMessage
  if (e.startedAt) {
    e.resources.durationMs = e.endedAt - e.startedAt
  }
  scheduleCleanup(toolUseId)
}

/** Terminal: aborted (signal, user stop, scheduler kill). */
export function markToolAborted(toolUseId: string, reason?: string): void {
  const e = registry.get(toolUseId)
  if (!e) return
  e.status = 'aborted'
  e.endedAt = Date.now()
  e.errorMessage = reason
  if (e.startedAt) {
    e.resources.durationMs = e.endedAt - e.startedAt
  }
  scheduleCleanup(toolUseId)
}

/** Increment resource counters while the tool is running. */
export function recordToolResourceDelta(
  toolUseId: string,
  delta: Partial<ToolResourceUsage>,
): void {
  const e = registry.get(toolUseId)
  if (!e) return
  if (delta.tokensUsed !== undefined) {
    e.resources.tokensUsed = (e.resources.tokensUsed ?? 0) + delta.tokensUsed
  }
  if (delta.diskWriteBytes !== undefined) {
    e.resources.diskWriteBytes = (e.resources.diskWriteBytes ?? 0) + delta.diskWriteBytes
  }
  if (delta.networkBytes !== undefined) {
    e.resources.networkBytes = (e.resources.networkBytes ?? 0) + delta.networkBytes
  }
  if (delta.shellChildCount !== undefined) {
    e.resources.shellChildCount = (e.resources.shellChildCount ?? 0) + delta.shellChildCount
  }
}

/** Lookup by id. */
export function getToolEntry(toolUseId: string): ToolRuntimeEntry | undefined {
  return registry.get(toolUseId)
}

/** All entries. */
export function getAllToolEntries(): ToolRuntimeEntry[] {
  return Array.from(registry.values())
}

/** Filter by agent. */
export function getToolsByAgent(agentId: AgentId): ToolRuntimeEntry[] {
  return getAllToolEntries().filter((t) => t.agentId === agentId)
}

/** Filter by status. */
export function getToolsByStatus(status: ToolExecutionStatus): ToolRuntimeEntry[] {
  return getAllToolEntries().filter((t) => t.status === status)
}

/** Running + paused + blocked + queued for a given agent. */
export function getActiveToolsForAgent(agentId: AgentId): ToolRuntimeEntry[] {
  return getAllToolEntries().filter(
    (t) => t.agentId === agentId && ['queued', 'preparing', 'running', 'paused', 'blocked'].includes(t.status),
  )
}

/** Snapshot for telemetry / UI. */
export function getToolRuntimeSnapshot(): ToolRuntimeSnapshot {
  const tools = getAllToolEntries()
  return {
    tools,
    summary: {
      totalQueued: tools.filter((t) => t.status === 'queued').length,
      totalRunning: tools.filter((t) => t.status === 'running').length,
      totalPaused: tools.filter((t) => t.status === 'paused').length,
      totalBlocked: tools.filter((t) => t.status === 'blocked').length,
      totalCompleted: tools.filter((t) => t.status === 'completed').length,
      totalFailed: tools.filter((t) => t.status === 'failed').length,
    },
  }
}

/** Has any running tool for this agent? */
export function agentHasRunningTools(agentId: AgentId): boolean {
  for (const t of registry.values()) {
    if (t.agentId === agentId && t.status === 'running') return true
  }
  return false
}

/**
 * Global count of currently-running tools across all agents. Cheap O(n)
 * scan (no snapshot allocation) — used by the scheduler-drive cross-agent
 * hold gate as the "is the system contended?" soft-threshold signal so a
 * lower-priority agent only holds when capacity is actually scarce.
 */
export function getRunningToolCount(): number {
  let n = 0
  for (const t of registry.values()) {
    if (t.status === 'running') n++
  }
  return n
}

/**
 * P2-6 (2026-06) — fire a tool entry's per-tool cancel lane before flipping
 * its registry status. Mirrors the two-step inside {@link preemptTool}: a
 * status flip alone leaves the real shell child / network request running,
 * breaking quota's invariant that "active" entries reflect actual resource
 * usage. Shared by {@link abortAllToolsForAgent} and {@link abortToolsInTree}
 * so tree-level interrupts cancel in-flight async work instead of relying
 * solely on the kernel/caller signal reaching every executor.
 */
function fireToolCancelSignal(e: ToolRuntimeEntry, reason?: string): void {
  if (e.preemptController && !e.preemptController.signal.aborted) {
    try {
      e.preemptController.abort(reason ?? 'aborted')
    } catch {
      /* ignore — already aborted */
    }
  }
}

/** Cascading abort: mark every running/queued tool for an agent as aborted. */
export function abortAllToolsForAgent(agentId: AgentId, reason?: string): number {
  let count = 0
  for (const t of registry.values()) {
    if (t.agentId === agentId && ['queued', 'preparing', 'running', 'paused', 'blocked'].includes(t.status)) {
      fireToolCancelSignal(t, reason)
      markToolAborted(t.toolUseId, reason)
      count++
    }
  }
  return count
}

/**
 * Audit §3.2 wire-up — mark every currently-running tool for a conversation
 * as paused. Called by `OrchestrationKernel.pause()` so the registry's
 * `'paused'` status reflects the cooperative pause that the kernel's
 * pause-gate enforces at iteration boundaries.
 *
 * In-flight async work is NOT cancelled (cooperative pause semantics) —
 * the status flip is for renderer / telemetry / future scheduler decisions
 * that want to deprioritise tools owned by a paused conversation. Only
 * tools currently in `'running'` are flipped; `'queued'` / `'preparing'`
 * stay where they are because they're not yet consuming resources.
 *
 * Returns the count of tools transitioned for telemetry.
 */
export function markRunningToolsPausedForConversation(conversationId: string): number {
  const id = conversationId.trim()
  if (!id) return 0
  let count = 0
  for (const t of registry.values()) {
    if (t.conversationId === id && t.status === 'running') {
      markToolPaused(t.toolUseId)
      count++
    }
  }
  return count
}

/**
 * Audit §3.2 wire-up — flip paused tools for a conversation back to running.
 * Mirror of {@link markRunningToolsPausedForConversation}; called by
 * `OrchestrationKernel.resume()`. Only tools in `'paused'` are flipped so
 * tools that completed / failed / aborted while the kernel was paused
 * don't get accidentally resurrected.
 *
 * Returns the count of tools transitioned.
 */
export function markPausedToolsResumedForConversation(conversationId: string): number {
  const id = conversationId.trim()
  if (!id) return 0
  let count = 0
  for (const t of registry.values()) {
    if (t.conversationId === id && t.status === 'paused') {
      markToolResumed(t.toolUseId)
      count++
    }
  }
  return count
}

/**
 * Parent-tree abort: mark every tool under a parent agent (transitively).
 *
 * P0 fix (audit §4.5): the previous implementation only matched
 * `t.parentAgentId === parentAgentId`, which is one level deep — for an agent
 * tree like `main → coordinator → explore → grep_tool`, calling with
 * `parentAgentId = 'main'` only aborted `coordinator`'s direct tools and the
 * `explore` agent's tools were leaked. Now we build a transitive closure of
 * descendant agents from the `agentId → parentAgentId` edges visible in the
 * tool registry and abort every tool whose owning agent is in that closure.
 */
export function abortToolsInTree(parentAgentId: AgentId, reason?: string): number {
  // Build agentId → parentAgentId map from current registry entries.
  // Note: this only sees agents that have at least one tool entry; pure
  // "passthrough" agents that never recorded a tool would not appear and
  // thus their descendants would not be visible. In practice every agent
  // we care about cancelling has registered at least one tool by the time
  // a tree-abort fires (interrupt cascades happen after model output).
  const parentOf = new Map<AgentId, AgentId>()
  for (const t of registry.values()) {
    if (t.parentAgentId && !parentOf.has(t.agentId)) {
      parentOf.set(t.agentId, t.parentAgentId)
    }
  }

  // Transitive closure: every agent whose ancestor chain reaches `parentAgentId`.
  const tree = new Set<AgentId>([parentAgentId])
  let changed = true
  while (changed) {
    changed = false
    for (const [child, parent] of parentOf) {
      if (tree.has(parent) && !tree.has(child)) {
        tree.add(child)
        changed = true
      }
    }
  }

  let count = 0
  for (const t of registry.values()) {
    if (
      tree.has(t.agentId) &&
      ['queued', 'preparing', 'running', 'paused', 'blocked'].includes(t.status)
    ) {
      // P2-6 — cancel the in-flight async work via the per-tool lane, not
      // just the registry status (see fireToolCancelSignal rationale).
      fireToolCancelSignal(t, reason)
      markToolAborted(t.toolUseId, reason)
      count++
    }
  }
  return count
}

/**
 * Delay before terminal entries are reaped. Exported so the {@link ToolScheduler} can align its
 * own DAG-node retention with the same window — keeping `PolicyEngine.countRecentCalls`,
 * `abortToolsInTree`, and scheduler `getReadyNodes()` agreeing on which tools are "still around".
 */
export const TOOL_RUNTIME_CLEANUP_DELAY_MS = 120_000
const cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>()

function scheduleCleanup(toolUseId: string): void {
  const existing = cleanupTimers.get(toolUseId)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => {
    registry.delete(toolUseId)
    cleanupTimers.delete(toolUseId)
  }, TOOL_RUNTIME_CLEANUP_DELAY_MS)
  cleanupTimers.set(toolUseId, timer)
}

/** Test helper — wipe everything. */
export function clearToolRuntimeStateForTests(): void {
  for (const t of cleanupTimers.values()) clearTimeout(t)
  cleanupTimers.clear()
  registry.clear()
  clearToolRateLimitRingForTests()
}
