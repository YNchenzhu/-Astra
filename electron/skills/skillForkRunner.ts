/**
 * Run a skill with `context: fork` in an isolated agentic loop (upstream-style).
 * Streams progress via the same `subagent_*` IPC events as the Agent tool for UI parity.
 */

import {
  createInMemoryAgentLoopHost,
  runHostedAgentLoop,
} from '../orchestration/hostedAgentLoop'
import type { AgenticLoopParams } from '../ai/agenticLoopTypes'
import { getResourceQuotaManager } from '../orchestration/toolRuntime/quota'
import { recordToolResourceDelta } from '../orchestration/toolRuntime/state'
import { getToolUseIdFromStopScope } from '../ai/toolExecutionScope'
import { getToolDefinitions } from '../tools/schema'
import { getAgentContext, runWithAgentContextAsync } from '../agents/agentContext'
import type { AgentContext } from '../agents/agentContext'
import { agentQuerySource } from '../agents/querySource'
import { generateQueryChainId } from '../agents/queryTracking'
import { filterToolDefinitionsForSkill } from './skillSessionFilter'
import { resolveSkillModelOverride } from './skillModelResolve'
import type { SkillEffort } from './skillEffort'
import { emitSubAgentStreamEvent } from '../agents/agentTool'
import type { SubAgentResult } from '../agents/types'
import type { AgentId } from '../tools/ids'
import { asAgentId } from '../tools/ids'
import { clearInvokedSkillsForAgent } from './invokedSkillsRegistry'

const SKILL_FORK_MAX_ITERATIONS = 90

let forkCounter = 0

function nextSkillForkAgentId(): AgentId {
  forkCounter++
  return asAgentId(`skill-fork-${Date.now()}-${forkCounter}`)
}

export interface RunSkillForkParams {
  skillDisplayName: string
  expandedPrompt: string
  allowedTools?: string[]
  model?: string
  effort?: SkillEffort
}

export async function runSkillFork(
  params: RunSkillForkParams,
): Promise<{ success: boolean; output?: string; error?: string }> {
  const ctx = getAgentContext()
  if (!ctx) {
    return {
      success: false,
      error:
        'Fork skills require an active agent session (e.g. a chat with tools enabled). Start a conversation from the assistant, or use an inline skill.',
    }
  }

  const baseDefs = getToolDefinitions()
  const filtered = filterToolDefinitionsForSkill(baseDefs, params.allowedTools)
  const model = params.model?.trim()
    ? resolveSkillModelOverride(params.model.trim(), ctx.model, ctx.config.id)
    : ctx.model

  const agentId = nextSkillForkAgentId()
  const startTime = Date.now()
  let output = ''
  let loopError: string | undefined
  let totalTokens = 0
  let totalToolUses = 0

  emitSubAgentStreamEvent({
    type: 'subagent_start',
    agentId,
    agentType: 'skill-fork',
    description: (params.skillDisplayName || 'Skill').slice(0, 200),
    runInBackground: false,
  })

  const finishResult = (success: boolean): SubAgentResult => ({
    success,
    agentId,
    agentType: 'skill-fork',
    output: output.trim() || (success ? '(No text output from the skill session.)' : ''),
    totalTokens,
    totalDurationMs: Date.now() - startTime,
    totalToolUses,
  })

  const forkCtx: AgentContext = {
    ...ctx,
    agentId,
    parentAgentId: ctx.agentId,
    messages: [{ role: 'user', content: params.expandedPrompt }],
    queryChainId: generateQueryChainId(),
    querySource: agentQuerySource('skill-fork'),
    skipPromptCacheWrite: true,
  }

  try {
    await runWithAgentContextAsync(forkCtx, async () => {
      const loopParams: AgenticLoopParams = {
          config: ctx.config,
          model,
          messages: [{ role: 'user', content: params.expandedPrompt }],
          systemPrompt: ctx.systemPrompt,
          maxTokens: 64000,
          enableTools: filtered.length > 0,
          toolDefinitionsOverride: filtered,
          maxIterationsOverride: SKILL_FORK_MAX_ITERATIONS,
          signal: ctx.signal,
          effort: params.effort,
          alwaysThinking: ctx.alwaysThinking === true,
          // Audit §3.2 wire-up — pre-iteration boundary check. Skill forks
          // are kernel-less; this hook keeps them consistent with drive
          // mode's inline abort gate so user-initiated cancellation
          // produces a typed `iteration_boundary_stopped` reason instead
          // of the more opaque `aborted_streaming` after one wasted stream.
          iterationBoundaryHook: async () => {
            if (ctx.signal.aborted) return { stop: true }
            return undefined
          },
        }
      await runHostedAgentLoop(
        createInMemoryAgentLoopHost(loopParams),
        loopParams,
        {
          onTextDelta: (text) => {
            output += text
            emitSubAgentStreamEvent({ type: 'subagent_text', agentId, text })
          },
          onThinkingDelta: (text) => {
            emitSubAgentStreamEvent({ type: 'subagent_thinking_delta', agentId, text })
          },
          onThinkingBlock: (block) => {
            emitSubAgentStreamEvent({
              type: 'subagent_thinking_block_complete',
              agentId,
              thinkingBlock: block,
            })
          },
          onReasoningSummaryDelta: (text) => {
            emitSubAgentStreamEvent({
              type: 'subagent_reasoning_summary_delta',
              agentId,
              text,
            })
          },
          onReasoningSummaryBlock: (block) => {
            emitSubAgentStreamEvent({
              type: 'subagent_reasoning_summary_block_complete',
              agentId,
              reasoningSummaryBlock: block,
            })
          },
          onToolStart: (toolUse) => {
            totalToolUses++
            emitSubAgentStreamEvent({ type: 'subagent_tool_start', agentId, toolUse })
          },
          onToolResult: (toolResult) => {
            emitSubAgentStreamEvent({ type: 'subagent_tool_result', agentId, toolResult })
          },
          onMessageEnd: (usage) => {
            if (usage) {
              totalTokens += usage.inputTokens + usage.outputTokens
              // Audit P0+ self-fix F-2 — skill-fork token usage now also
              // counts toward the global `maxTokenRatePerMinute` quota.
              // Before this hook only main-chat tokens were tracked.
              // Audit A-3 — also attribute per-tool to parent tool slot.
              try {
                const total =
                  (typeof usage.inputTokens === 'number' ? usage.inputTokens : 0) +
                  (typeof usage.outputTokens === 'number' ? usage.outputTokens : 0)
                if (total > 0) {
                  getResourceQuotaManager().recordTokenUsage(total)
                  const parentToolUseId = getToolUseIdFromStopScope()
                  if (parentToolUseId) {
                    recordToolResourceDelta(parentToolUseId, { tokensUsed: total })
                  }
                }
              } catch (e) {
                console.warn('[skillForkRunner] quota.recordTokenUsage failed:', e)
              }
            }
          },
          onError: (error) => {
            loopError = error
            emitSubAgentStreamEvent({ type: 'subagent_error', agentId, error })
          },
        },
      )
    })

    const success = !loopError
    emitSubAgentStreamEvent({
      type: 'subagent_complete',
      agentId,
      result: finishResult(success),
    })

    if (loopError) {
      return { success: false, error: loopError }
    }

    return {
      success: true,
      output:
        `Skill "${params.skillDisplayName}" (forked sub-session) completed.\n\n` +
        (output.trim() || '(No text output from the skill session.)'),
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    loopError = loopError || message
    emitSubAgentStreamEvent({ type: 'subagent_error', agentId, error: message })
    emitSubAgentStreamEvent({
      type: 'subagent_complete',
      agentId,
      result: finishResult(false),
    })
    return { success: false, error: message }
  } finally {
    // upstream parity (SkillTool.ts:285-288) — clears any invoked-skill
    // entries recorded UNDER THIS FORK's agentId by nested Skill tool
    // calls inside the forked session. Parent-scoped entries (recorded
    // in `executeSkill` with the parent agentId) intentionally survive
    // here; they're reaped by parent's compaction (`postCompactAttachments`)
    // or by `finalizeSubAgentLifecycle` if the parent is itself a sub-agent.
    // Without this finally, nested Skill calls inside long-lived fork
    // chains would leak their entries permanently (post-compact
    // reinjection never fires for the short-lived fork agentId).
    clearInvokedSkillsForAgent(agentId)
  }
}
