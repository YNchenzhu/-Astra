/**
 * Sidechain transcript — compact timeline for a sub-agent run (report §3.1 step 8).
 * In-memory only; cleared when the run finalizes.
 */

import type { AgentId } from '../tools/ids'

export type SubAgentSidechainEntry = {
  ts: number
  kind:
    | 'start'
    | 'text'
    | 'tool_start'
    | 'tool_result'
    | 'iteration'
    | 'error'
    | 'complete'
    | 'warning'
    | 'limit'
  summary: string
}

const byAgent = new Map<string, SubAgentSidechainEntry[]>()
const MAX_ENTRIES = 400
const MAX_TEXT_SNIP = 500

export function initSubAgentSidechain(agentId: AgentId): void {
  byAgent.set(agentId, [])
}

export function appendSubAgentSidechain(
  agentId: AgentId,
  entry: Omit<SubAgentSidechainEntry, 'ts'> & { ts?: number },
): void {
  const list = byAgent.get(agentId)
  if (!list) return
  const row: SubAgentSidechainEntry = {
    ts: entry.ts ?? Date.now(),
    kind: entry.kind,
    summary:
      entry.kind === 'text' && entry.summary.length > MAX_TEXT_SNIP
        ? `${entry.summary.slice(0, MAX_TEXT_SNIP)}…`
        : entry.summary,
  }
  list.push(row)
  if (list.length > MAX_ENTRIES) {
    list.splice(0, list.length - MAX_ENTRIES)
  }
}

export function getSubAgentSidechainTranscript(agentId: AgentId): SubAgentSidechainEntry[] {
  return [...(byAgent.get(agentId) ?? [])]
}

export function clearSubAgentSidechain(agentId: AgentId): void {
  byAgent.delete(agentId)
}
