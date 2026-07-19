/**
 * Worker sub-agent scheduler admission (main-process side).
 *
 * Worker-thread sub-agents run their tools in one of two ways, BOTH of which
 * historically bypassed the process-wide `ToolScheduler` / `ToolRuntimeState`:
 *   - RPC tools (`Agent` / MCP / `Skill` / `TodoWrite` / …) execute in the
 *     MAIN process via the `tool_call` RPC handler in `subAgentWorkerClient.ts`;
 *   - local tools (`bash` / file I/O / `grep` / …) execute IN-THREAD inside the
 *     worker, and now request an accounting-only admission from main via the
 *     `admit_request` / `admit_grant` / `admit_done` RPC.
 *
 * This module is the shared admission body for both paths, so a worker
 * sub-agent's tools participate in cross-agent holding (`POLE_TOOL_SCHEDULER_DRIVE`)
 * and become visible to other agents' hold + contention decisions.
 *
 * Admission does, in order: register + enqueue (cross-agent visibility) →
 * hold for higher-priority agents (bounded by `backpressureMaxWaitMs`) →
 * cross-agent resource quota admission with backpressure + preemption. It
 * returns `{ admitted }`: on `false` the tool was already marked terminal
 * (failed / aborted) and the caller MUST surface a synthetic error result
 * WITHOUT executing the tool (RPC path: error `tool_result`; local path:
 * `admit_deny` → the worker returns a synthetic error). On `true` the caller
 * executes the tool and then calls `releaseSchedulerAdmission`.
 *
 * Callers MUST gate every call on `isSchedulerDriveEnabled()` so the flag-off
 * path is byte-for-byte the legacy behaviour.
 */

import type { AgentId } from '../tools/ids'
import {
  getToolAdmissionCoordinator,
  type ToolInvocationLease,
} from '../orchestration/toolRuntime/admission'
import { preemptTool } from '../orchestration/toolRuntime/state'

export interface WorkerAdmissionParams {
  toolUseId: string
  toolName: string
  agentId: AgentId
  parentAgentId?: AgentId
  conversationId?: string
  input: Record<string, unknown>
  isReadOnly: boolean
  priority: number
  signal: AbortSignal
  logTag: string
}

export interface SchedulerAdmissionResult {
  /** True → caller executes then calls `releaseSchedulerAdmission`. */
  admitted: boolean
  /** Model-visible reason when `admitted` is false (quota / abort). */
  reason?: string
  /** Exact merged signal owned by the admission lease. */
  effectiveSignal?: AbortSignal
}

const workerAdmissionLeases = new Map<string, ToolInvocationLease>()

export function createWorkerToolUseId(
  route: 'rpc' | 'local',
  sessionId: string,
  agentId: AgentId,
  reqId: number,
): string {
  return `worker-${route}-${encodeURIComponent(sessionId)}-${encodeURIComponent(agentId)}-${reqId}`
}

/**
 * Admit a worker sub-agent tool into the process-wide scheduler:
 *   1. register + enqueue (cross-agent visibility);
 *   2. hold while a higher-priority agent has dispatchable work;
 *   3. cross-agent resource quota admission with backpressure + preemption.
 *
 * Returns `{ admitted:true }` once cleared to execute, or
 * `{ admitted:false, reason }` (already marked terminal) when the quota denies
 * after backpressure or the signal aborts. All bookkeeping is defensive.
 * The hold + quota waits share one `backpressureMaxWaitMs` deadline so the
 * combined wait can't exceed the configured budget.
 */
export async function acquireSchedulerAdmission(
  params: WorkerAdmissionParams,
): Promise<SchedulerAdmissionResult> {
  const result = await getToolAdmissionCoordinator().acquire({
    toolUseId: params.toolUseId,
    toolName: params.toolName,
    agentId: params.agentId,
    ...(params.parentAgentId ? { parentAgentId: params.parentAgentId } : {}),
    ...(params.conversationId ? { conversationId: params.conversationId } : {}),
    input: params.input,
    isReadOnly: params.isReadOnly,
    priority: params.priority,
    signal: params.signal,
    quotaMode: 'wait',
    logTag: params.logTag,
  })
  if (!result.admitted) return { admitted: false, reason: result.reason }
  try {
    await result.lease.waitUntilGranted()
    result.lease.start()
    workerAdmissionLeases.set(params.toolUseId, result.lease)
    return { admitted: true, effectiveSignal: result.lease.effectiveSignal }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    result.lease.finish(result.lease.effectiveSignal.aborted ? 'aborted' : 'failed', reason)
    return { admitted: false, reason }
  }
}

/**
 * Release LOCAL tool admissions that were granted but never reported
 * `admit_done` — i.e. the worker exited / crashed mid-tool. Marks each slot
 * failed so the 'running' accounting frees NOW instead of lingering until the
 * 120s reaper. Called once per session from the worker client's `finish()`.
 * No-op for an empty set (the normal clean-completion case).
 */
export function releaseOutstandingLocalAdmissions(
  toolUseIds: Iterable<string>,
  _logTag = 'subAgentWorker.local',
): void {
  for (const id of toolUseIds) {
    const reason = 'worker session ended before tool completed'
    const lease = workerAdmissionLeases.get(id)
    if (!lease) continue
    workerAdmissionLeases.delete(id)
    preemptTool(id, reason)
    lease.finish('aborted', reason)
  }
}

/**
 * Mark a previously-acquired worker tool terminal in both `ToolRuntimeState`
 * and the scheduler DAG so the slot frees and dependents (if any) unblock.
 * MUST be called for every `acquireSchedulerAdmission` (success or failure)
 * to avoid leaking a 'running' entry until the 120s reaper.
 */
export function releaseSchedulerAdmission(
  toolUseId: string,
  success: boolean,
  opts?: { reason?: string; logTag?: string },
): void {
  const lease = workerAdmissionLeases.get(toolUseId)
  if (!lease) return
  workerAdmissionLeases.delete(toolUseId)
  lease.finish(success ? 'completed' : 'failed', opts?.reason)
}
