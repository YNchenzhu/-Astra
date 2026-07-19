/**
 * Async agent lifecycle — names aligned with ARCHITECTURE.md § Agent 编排系统.
 *
 * Phases: created → permission_resolved → mcp_initialized → tools_resolved → hooks_registered →
 * skills_loaded → running → first_model_byte → completing → completed → cleanup_done
 * Retrieval budget diagnostics may also log retrieval_budget_exceeded.
 *
 * Each phase log carries `+Nms` elapsed since `registerAsyncAgent` so the
 * spawn-to-first-byte path can be diagnosed from console output without
 * extra tooling. The start timestamp is kept in {@link spawnStartTimes}
 * and evicted on `cleanup_done` (terminal) to avoid leaks across long
 * sessions.
 */

import type { AgentId } from '../tools/ids'

export type AsyncAgentLifecyclePhase =
  | 'created'
  | 'permission_resolved'
  | 'mcp_initialized'
  | 'tools_resolved'
  | 'hooks_registered'
  | 'skills_loaded'
  | 'retrieval_budget_exceeded'
  | 'running'
  | 'first_model_byte'
  | 'completing'
  | 'completed'
  | 'cleanup_done'

/** Spawn-time anchor per agent (set in `registerAsyncAgent`). */
const spawnStartTimes = new Map<AgentId, number>()

export function logAsyncAgentPhase(
  agentId: AgentId,
  phase: AsyncAgentLifecyclePhase,
  detail?: string,
): void {
  const start = spawnStartTimes.get(agentId)
  const elapsed = start !== undefined ? Date.now() - start : null
  const elapsedTag = elapsed !== null ? ` +${elapsed}ms` : ''
  const suffix = detail ? ` — ${detail}` : ''
  console.log(`[AsyncAgent:${agentId}]${elapsedTag} ${phase}${suffix}`)
  // Evict on terminal phase so a long-lived process doesn't accumulate
  // entries across thousands of agent runs.
  if (phase === 'cleanup_done') {
    spawnStartTimes.delete(agentId)
  }
}

/**
 * ARCHITECTURE.md: `[创建] → registerAsyncAgent()` — log + hook for future id/MCP wiring.
 * Full MCP/hook phases continue in `runSubAgent`.
 *
 * Also anchors the per-phase elapsed-time clock used by {@link logAsyncAgentPhase}.
 */
export function registerAsyncAgent(agentId: AgentId, agentType: string): void {
  spawnStartTimes.set(agentId, Date.now())
  logAsyncAgentPhase(agentId, 'created', agentType)
}
