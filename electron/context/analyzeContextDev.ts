/**
 * upstream §19.4 — developer-only context sizing log.
 * Set `POLE_ANALYZE_CONTEXT_DEV=1` for compact JSON line.
 * Set `POLE_ANALYZE_CONTEXT_DEV=2` for full analysis with breakdown and suggestions.
 */

import { estimateConversationTokens } from './tokenCounter'
import { analyzeContext, formatContextAnalysis } from './analyzeContext'

export function logAnalyzeContextDevLine(input: {
  systemPrompt: string
  messages: Array<Record<string, unknown>>
  toolDefsTokens: number
  phases?: readonly string[]
  model?: string
}): void {
  const level = process.env.POLE_ANALYZE_CONTEXT_DEV
  if (!level || level === '0') return

  if (level === '2' && input.model) {
    const data = analyzeContext({
      model: input.model,
      systemPrompt: input.systemPrompt,
      messages: input.messages,
    })
    console.log('[analyzeContextDev:full]\n' + formatContextAnalysis(data))
    return
  }

  const estimatedMessagesAndSystem = estimateConversationTokens(input.messages, input.systemPrompt)
  const total = estimatedMessagesAndSystem + input.toolDefsTokens
  console.log(
    '[analyzeContextDev]',
    JSON.stringify({
      model: input.model,
      estimatedTotalTokens: total,
      estimatedMessagesAndSystem,
      toolDefsTokens: input.toolDefsTokens,
      messageCount: input.messages.length,
      phases: input.phases,
    }),
  )
}
