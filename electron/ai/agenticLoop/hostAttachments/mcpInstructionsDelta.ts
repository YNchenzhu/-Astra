/**
 * MCP server `instructions` field delta collector — upstream parity for
 * `mcp_instructions_delta` attachment (`src/utils/attachments.ts#getMcpInstructionsDeltaAttachment`,
 *  `src/utils/messages.ts` case `'mcp_instructions_delta'`).
 *
 * ## What it surfaces
 *
 * MCP servers publish an optional `instructions` string in their
 * `InitializeResult`. Servers use it to nudge how clients should call
 * their tools ("always pass UTF-8 input", "deprecated tool X — use Y
 * instead", etc.). When a server connects mid-conversation, or its
 * instructions change on reconnect, the model needs to see the new
 * guidance.
 *
 * upstream emits the delta as a `<system-reminder>` user message per
 * post-tool position. Our adapter reads from
 * `electron/mcp/instructionsTracker.ts` which `client.ts` populates
 * on connect / clears on disconnect.
 *
 * ## Gating
 *
 * - **On by default**. Most MCP servers don't publish non-trivial
 *   instructions, so the per-conversation diff is silent for them —
 *   the cost of leaving this on is bounded by `MAX_INSTRUCTIONS_PER_SERVER`
 *   characters per changed server. Operators who want to suppress
 *   it set `POLE_MCP_INSTRUCTIONS_DELTA=0`.
 * - `post_tool` call site.
 * - Empty delta → no-op.
 * - Requires `streamConversationId` (the diff is per-conversation;
 *   we silently skip when none).
 */

import type { Collector } from '../hostAttachments'
import { getAgentContext } from '../../../agents/agentContext'
import { diffMcpInstructionsForConversation } from '../../../mcp/instructionsTracker'
import {
  SIDE_CHANNEL_KIND,
  wrapSideChannelBody,
} from '../../../constants/sideChannelKinds'

function isMcpInstructionsDeltaEnabled(): boolean {
  const raw = process.env.POLE_MCP_INSTRUCTIONS_DELTA?.trim().toLowerCase()
  // Default-on: only an explicit `0` / `false` / `no` disables.
  if (raw === '0' || raw === 'false' || raw === 'no') return false
  return true
}

const MAX_INSTRUCTIONS_PER_SERVER = 1000
const TRUNCATED_SUFFIX = '… (truncated)'

function clampInstructions(text: string): string {
  if (text.length <= MAX_INSTRUCTIONS_PER_SERVER) return text
  const head = text.slice(0, MAX_INSTRUCTIONS_PER_SERVER - TRUNCATED_SUFFIX.length)
  return `${head}${TRUNCATED_SUFFIX}`
}

export const mcpInstructionsDeltaCollector: Collector = {
  name: 'mcp_instructions_delta',
  callSites: ['post_tool'],

  async run(ctx) {
    if (!isMcpInstructionsDeltaEnabled()) return null
    const { state } = ctx

    const convId = getAgentContext()?.streamConversationId?.trim()
    if (!convId) return null

    const delta = diffMcpInstructionsForConversation(convId)
    const total =
      delta.added.length + delta.changed.length + delta.removed.length
    if (total === 0) return null

    const sections: string[] = []
    if (delta.added.length > 0) {
      const lines = delta.added.map(
        (a) =>
          `- ${a.name}: ${clampInstructions(a.instructions)}`,
      )
      sections.push(
        `MCP servers newly available with instructions:\n${lines.join('\n')}`,
      )
    }
    if (delta.changed.length > 0) {
      const lines = delta.changed.map(
        (c) =>
          `- ${c.name}: ${clampInstructions(c.current)}`,
      )
      sections.push(
        `MCP servers with updated instructions:\n${lines.join('\n')}`,
      )
    }
    if (delta.removed.length > 0) {
      const lines = delta.removed.map((r) => `- ${r.name}`)
      sections.push(
        `MCP servers disconnected (their instructions no longer apply):\n${lines.join('\n')}`,
      )
    }
    const body = sections.join('\n\n')

    state.appendixReport('P2_Q_compaction_reminder', {
      iteration: state.iteration,
      kind: 'mcp_instructions_delta',
      added: delta.added.length,
      changed: delta.changed.length,
      removed: delta.removed.length,
    })

    return {
      kind: 'push_message',
      sideChannelKind: SIDE_CHANNEL_KIND.genericConvertedSystem,
      message: {
        role: 'user',
        content: wrapSideChannelBody(
          SIDE_CHANNEL_KIND.genericConvertedSystem,
          body,
        ),
        _convertedFromSystem: true,
        _sideChannelKind: SIDE_CHANNEL_KIND.genericConvertedSystem,
      },
    }
  },
}
