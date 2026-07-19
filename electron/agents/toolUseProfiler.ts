/**
 * Opt-in headless timing for main-thread tool_use runs (`POLE_TOOL_USE_PROFILER=1`).
 */

import { getAgentContext } from './agentContext'

const phaseStartMs = new Map<string, number>()

function shouldProfileHeadlessMain(): boolean {
  return process.env.POLE_TOOL_USE_PROFILER === '1' && getAgentContext()?.agentId === 'main'
}

export function markToolUseProfilerPhase(
  phase: 'start' | 'pre_execute' | 'end',
  toolUseId: string,
  toolName: string,
  extra?: Record<string, unknown>,
): void {
  if (!shouldProfileHeadlessMain()) return
  const now = Date.now()
  if (phase === 'start') {
    phaseStartMs.set(toolUseId, now)
    console.log(`[tool-use-profiler] start ${toolName} id=${toolUseId}`)
    return
  }
  const t0 = phaseStartMs.get(toolUseId) ?? now
  const dt = now - t0
  if (phase === 'pre_execute') {
    console.log(`[tool-use-profiler] pre_execute ${toolName} id=${toolUseId} +${dt}ms`)
    return
  }
  phaseStartMs.delete(toolUseId)
  console.log(`[tool-use-profiler] end ${toolName} id=${toolUseId} +${dt}ms`, extra ?? {})
}
