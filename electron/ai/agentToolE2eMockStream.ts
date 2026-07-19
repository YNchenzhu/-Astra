/**
 * Deterministic model stream for Playwright / CI: first **main** chat `streamText` call emits an
 * `Agent` tool_use; **sub-agent** calls emit final text; subsequent **main** calls emit a short done line.
 * Enable with `ASTRA_AGENT_TOOL_E2E=1` (see {@link streamText} in client.ts).
 */

import type { ProviderConfig, StreamCallbacks, StreamTextParams } from './client'
import { getAgentContext } from '../agents/agentContext'

const mainStreamCountByConversation = new Map<string, number>()

export function resetAgentToolE2EMockStreamState(): void {
  mainStreamCountByConversation.clear()
}

export async function runAgentToolE2EMockStream(
  _config: ProviderConfig,
  _params: StreamTextParams,
  callbacks: StreamCallbacks,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return

  const ctx = getAgentContext()
  const isMain = ctx?.agentId === 'main'
  const convKey =
    ctx?.streamConversationId && String(ctx.streamConversationId).trim()
      ? String(ctx.streamConversationId).trim()
      : 'default'

  if (!isMain) {
    callbacks.onTextDelta('## Summary\nE2E_SUBAGENT_DONE')
    callbacks.onMessageEnd({ inputTokens: 3, outputTokens: 7 })
    return
  }

  const next = (mainStreamCountByConversation.get(convKey) ?? 0) + 1
  mainStreamCountByConversation.set(convKey, next)

  if (next === 1) {
    callbacks.onToolUse?.({
      id: 'e2e-agent-tool-use',
      name: 'Agent',
      input: {
        description: 'E2E Explore',
        prompt: 'Say exactly E2E_SUBAGENT_DONE in the Summary section.',
        subagent_type: 'Explore',
      },
    })
    callbacks.onMessageEnd({ inputTokens: 1, outputTokens: 2 })
    return
  }

  callbacks.onTextDelta('E2E_MAIN_DONE')
  callbacks.onMessageEnd({ inputTokens: 2, outputTokens: 3 })
}
