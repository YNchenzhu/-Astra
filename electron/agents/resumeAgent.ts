/**
 * Agent resume — restart a stopped/completed agent with a new message.
 *
 * Simplified from upstream's resumeAgent.ts for Electron:
 * - In-memory resume (no disk transcript persistence)
 * - Reuses the existing activeAgents tracking from agentTool.ts
 * - Reconstructs the agent's context and launches a new runSubAgent call
 */

import {
  getActiveAgent,
  scheduleActiveAgentTimeout,
  clearActiveAgentTimeout,
} from './activeAgentRegistry'
import {
  trackAgentInOrchestrator,
  unspawnAndUntrackAgent,
} from './agentLifecycle'
import { resolveAgentDefinitionForResume } from './agentDefinitionsMerge'
import { runSubAgent } from './subAgentRunner'
import { getAllAgentDefinitions } from '../tools/registry'
import type { ActiveAgent, SubAgentEvent, SubAgentResult } from './types'
import type { ProviderConfig } from '../ai/client'
import type { BrowserWindow } from 'electron'

let mainWindowRef: BrowserWindow | null = null

export function setResumeMainWindow(win: BrowserWindow): void {
  mainWindowRef = win
}

function emitEventForAgent(agent: ActiveAgent, event: SubAgentEvent): void {
  if (!mainWindowRef) return
  const raw = agent.streamConversationId
  const cid =
    raw != null && String(raw).trim() ? String(raw).trim() : undefined
  const payload =
    cid !== undefined ? { ...event, conversationId: cid } : event
  mainWindowRef.webContents.send('ai:stream-event', payload)
}

/**
 * Resume a stopped agent with a new prompt message.
 * The agent runs in the background and the caller gets the agentId back immediately.
 *
 * @returns agentId if resume was initiated, null if agent not found or not resumable
 */
export async function resumeAgentBackground(
  idOrName: string,
  newPrompt: string,
  config: ProviderConfig,
  model: string,
  parentAgentId?: string,
): Promise<string | null> {
  const agent = getActiveAgent(idOrName)
  if (!agent) return null

  // Only resume stopped agents
  if (agent.status === 'running') return null

  // Reset agent state
  agent.status = 'running'
  agent.parentAgentId = parentAgentId
  agent.result = undefined
  agent.notified = false
  agent.abortController = new AbortController()
  agent.startTime = Date.now()
  agent.tokenCount = 0
  agent.tokenBudgetExceeded = false
  agent.pendingMessages = []
  clearActiveAgentTimeout(agent)
  scheduleActiveAgentTimeout(agent)

  const agentId = agent.agentId

  // BUG FIX — historically `resumeAgent` re-armed the ActiveAgent but did NOT
  // add it back into the MultiAgentOrchestrator tree. As a result, resumed
  // sub-agents were orphans: `interruptTree(parentAgentId)` would NOT cascade
  // to them and they kept running until wall-clock timeout. Re-register the
  // orchestrator edge here using the agent's freshly-reset `abortController`.
  // Registry entry already exists (we just rehydrated it above), so we only
  // touch the orchestrator side.
  const orchTrack = trackAgentInOrchestrator({
    agentId,
    agentType: agent.agentType,
    abortController: agent.abortController,
    ...(parentAgentId ? { parentAgentId } : {}),
    ...(agent.streamConversationId
      ? { conversationId: String(agent.streamConversationId) }
      : {}),
  })
  if (!orchTrack.ok) {
    console.warn('[resumeAgent] orchestrator.register failed:', orchTrack.error)
  }

  const resolvedDef =
    resolveAgentDefinitionForResume(agent.agentType, getAllAgentDefinitions()) ?? agent.agentDef

  // S5: when resuming a team member, re-enter the mailbox-wait loop so
  // subsequent SendMessage targeting the same NAME/agentId reaches the
  // resumed run instead of seeing it terminate again after one turn.
  // Mirrors the gating in `agentTool.ts` (stayRunningForSendMessage =
  // Boolean(teamName)) — non-team resumes keep the legacy "exit after
  // one turn" behaviour.
  const stayRunningForSendMessage = Boolean((agent.teamName ?? '').trim())

  runSubAgent({
    agentIdOverride: agentId,
    description: agent.description || `Resume ${agent.agentType}`,
    name: agent.name,
    teamName: agent.teamName,
    config,
    model,
    agentDef: resolvedDef,
    prompt: newPrompt,
    signal: agent.abortController.signal,
    onEvent: (e) => emitEventForAgent(agent, e),
    permissionModeOverride: agent.agentDef.permissionMode,
    stayRunningForSendMessage,
  }).then(result => {
    clearActiveAgentTimeout(agent)
    agent.status = result.success ? 'completed' : 'failed'
    agent.endedAt = Date.now()
    agent.result = result
    agent.resolve(result)

    emitEventForAgent(agent, {
      type: 'subagent_notification',
      agentId,
      agentType: agent.agentType,
      description: agent.description,
      status: result.success ? 'completed' : 'failed',
      result,
    })

    // BUG-S2 fix: align with agentTool.ts foreground/background success
    // path (5s) so resumed agents don't hold concurrency slots 12x longer
    // than fresh ones. Terminal history is persisted by
    // `unregisterActiveAgent` (inside the facade) regardless.
    setTimeout(() => unspawnAndUntrackAgent(agentId), 5000)
  }).catch((err) => {
    clearActiveAgentTimeout(agent)
    const failResult: SubAgentResult = {
      success: false,
      agentId,
      agentType: agent.agentType,
      output: '',
      totalTokens: 0,
      totalDurationMs: Date.now() - agent.startTime,
      totalToolUses: 0,
    }
    agent.status = 'failed'
    agent.endedAt = Date.now()
    agent.result = failResult
    agent.resolve(failResult)

    emitEventForAgent(agent, {
      type: 'subagent_notification',
      agentId,
      agentType: agent.agentType,
      description: agent.description,
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    })

    // BUG-S2 fix: same 5s grace as success path.
    setTimeout(() => unspawnAndUntrackAgent(agentId), 5000)
  })

  return agentId
}
