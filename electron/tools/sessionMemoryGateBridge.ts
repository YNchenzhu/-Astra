/**
 * Belt-and-suspenders for session-memory-internal gates that key off
 * `sessionAgentType`. Three data sources, in priority order:
 *
 *   1. {@link getAgentContext} (`AgentContext` ALS) — set by the in-process
 *      sub-agent path via `runWithAgentContextAsync(childContextBase, …)`.
 *   2. {@link getWorkerAgentGateSnapshot} — set inside the **utility**
 *      process tool worker, since that process has its own ALS that the
 *      main-process `AgentContext` does not cross.
 *   3. {@link getSubAgentRpcGateSnapshot} — set inside the host-side
 *      `subAgentWorkerClient` RPC handler when a `worker_threads` sub-agent
 *      delegates a tool call back to the main process. Without this, the
 *      gate would see the **parent** agent's `sessionAgentType` instead of
 *      the child sub-agent that actually issued the tool call, silently
 *      bypassing the sandbox for worker-path `session-memory-internal`
 *      scribes (P0 audit fix).
 */

import { getAgentContext } from '../agents/agentContext'
import { getSubAgentRpcGateSnapshot } from '../agents/subAgentRpcGateContext'
import { getWorkerAgentGateSnapshot } from './workerProcess/workerAgentGateContext'

export function getSessionAgentTypeForMemoryGates(): string | undefined {
  return (
    getAgentContext()?.sessionAgentType ??
    getWorkerAgentGateSnapshot()?.sessionAgentType ??
    getSubAgentRpcGateSnapshot()?.sessionAgentType
  )
}

/**
 * Returns the single absolute path the `session-memory-internal` scribe is
 * allowed to mutate this run, or `undefined` when no run is active. The host
 * pre-flight gate {@link gateSessionMemoryInternalAgentToolUse} uses this to
 * forbid the scribe from creating siblings like `<conv>-new.md` or
 * `_test.md`. Returns `undefined` for legacy / test callers that never set
 * the field, in which case the gate falls back to the original
 * "any .md under the session-memory tree" rule.
 */
export function getSessionMemoryWritableTargetPathForGates(): string | undefined {
  return (
    getAgentContext()?.sessionMemoryWritableTargetPath ??
    getWorkerAgentGateSnapshot()?.sessionMemoryWritableTargetPath ??
    getSubAgentRpcGateSnapshot()?.sessionMemoryWritableTargetPath
  )
}
