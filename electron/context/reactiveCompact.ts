/**
 * One-shot compaction after API context-length errors (reactive compact).
 */

import { clampToolResultsInMessages } from '../ai/toolResultBudget'
import { collectActiveTaskRelevanceTerms } from './activeTaskRelevance'
import { autoCompact, microCompact, type CompactOptions } from './compact'
import { drainContextCollapseForReactiveCompact } from './contextCollapseDrain'
import { getAgentContext } from '../agents/agentContext'
import { signalMicroCompactForPromptCache } from './cachedMicrocompactPromptCache'

/**
 * Aggressively shrink history so a follow-up model call may succeed.
 * Order: clamp tool bodies → collapse drain (§14 stub) → micro-compact (keep 2 recent tool iterations) → LLM summary when possible.
 */
export async function reactiveCompactAfterApiError(
  apiMessages: Array<Record<string, unknown>>,
  systemPrompt: string,
  options: CompactOptions,
): Promise<{ messages: Array<Record<string, unknown>>; wasCompacted: boolean }> {
  const budgeted = clampToolResultsInMessages(apiMessages, {
    relevanceTerms: collectActiveTaskRelevanceTerms(),
  })
  const afterDrain = drainContextCollapseForReactiveCompact(budgeted, {
    conversationKey: options.collapseConversationKey,
  })
  const micro = microCompact(afterDrain, 2, options.protectedToolUseIds)
  try {
    const result = await autoCompact({
      ...options,
      messages: micro,
      systemPrompt,
      llmQuerySource: options.llmQuerySource ?? 'compact',
    })
    return { messages: result.messages, wasCompacted: true }
  } catch {
    signalMicroCompactForPromptCache(getAgentContext()?.streamConversationId)
    return { messages: micro, wasCompacted: true }
  }
}
