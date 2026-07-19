/**
 * upstream §7.5-style inheritance for sub-agent budgets (wall-clock timeout chain).
 */

import type { AgentContext } from './agentContext'
import { getActiveAgent } from './activeAgentRegistry'

export function resolveInheritedTaskBudgetMs(parentContext: AgentContext | null): number | undefined {
  if (!parentContext) return undefined
  const fromCtx = parentContext.taskBudgetMs
  if (typeof fromCtx === 'number' && Number.isFinite(fromCtx) && fromCtx > 0) {
    return fromCtx
  }
  const pid = parentContext.agentId
  if (!pid || pid === 'main') return undefined
  const t = getActiveAgent(pid)?.agentDef?.timeout
  return typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : undefined
}
