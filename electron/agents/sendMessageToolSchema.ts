/**
 * Dynamic JSON Schema for SendMessage: constrain `to` to real recipients + optional OpenAI strict shape.
 */

import type { ToolDefinition } from '../tools/types'
import { getActiveAgents } from './activeAgentRegistry'

const SEND_MESSAGE_TOOL = 'SendMessage'

/** Max distinct `to` enum values to limit tool-definition size. */
const MAX_RECIPIENT_ENUM = 96

/**
 * Build `to` values: `*`, each running agent id/name, `team:<name>`,
 * plus `mailbox:` / `bridge:` prefixed routes for the same ids/names (OpenAI strict enum = fixed strings only).
 */
export function collectSendMessageRecipientEnum(): string[] {
  const out = new Set<string>(['*'])
  for (const [, agent] of getActiveAgents()) {
    if (agent.status !== 'running') continue
    out.add(agent.agentId)
    out.add(`mailbox:${agent.agentId}`)
    out.add(`bridge:${agent.agentId}`)
    out.add(`uds:astra:${agent.agentId}`)
    const n = agent.name?.trim()
    if (n) {
      out.add(n)
      if (n !== agent.agentId) {
        out.add(`mailbox:${n}`)
        out.add(`bridge:${n}`)
        out.add(`uds:astra:${n}`)
      }
    }
    const team = agent.teamName?.trim()
    if (team) out.add(`team:${team}`)
  }
  const list = [...out]
  if (list.length <= MAX_RECIPIENT_ENUM) return list
  list.sort()
  return list.slice(0, MAX_RECIPIENT_ENUM)
}

/**
 * Clone definitions and set SendMessage `to.enum` from the active agent registry (all providers).
 */
export function patchToolDefinitionsForSendMessageRecipients(
  definitions: ToolDefinition[],
  opts: { includeRecipientEnum?: boolean } = {},
): ToolDefinition[] {
  if (opts.includeRecipientEnum !== true) return definitions
  const enumList = collectSendMessageRecipientEnum()
  return definitions.map((d) => {
    if (d.name !== SEND_MESSAGE_TOOL) return d
    const cloned = JSON.parse(JSON.stringify(d)) as ToolDefinition
    const props = cloned.input_schema?.properties
    if (!props || typeof props !== 'object') return cloned
    const toProp = props.to as Record<string, unknown> | undefined
    if (!toProp || typeof toProp !== 'object') return cloned
    toProp.enum = enumList
    const base =
      typeof toProp.description === 'string' && toProp.description.trim()
        ? toProp.description.trim()
        : 'Agent ID, name, "*", team:<team_name>, mailbox:<id|name>, or bridge:<id|name>'
    toProp.description = `${base} (must be one of the enum values for currently running sub-agents / broadcast / team / mailbox / bridge routes).`
    return cloned
  })
}

/**
 * OpenAI structured outputs: strict function parameters for SendMessage only.
 * @see https://platform.openai.com/docs/guides/function-calling
 */
export function buildSendMessageOpenAIStrictParameters(recipientEnum: string[]): Record<string, unknown> {
  const toEnum = recipientEnum.length > 0 ? recipientEnum : ['*']
  return {
    type: 'object',
    properties: {
      to: {
        type: 'string',
        enum: toEnum,
        description:
          'Recipient: active sub-agent id/name, `*`, `team:<team_name>`, `mailbox:<id|name>` (durable TeamFile + queue if running), or `bridge:<id|name>` (in-process; same delivery as id when running).',
      },
      message: {
        type: 'string',
        description: 'Message body (or default payload when using structured fields).',
      },
      type: {
        type: 'string',
        enum: ['task', 'result', 'query', 'broadcast'],
        description: 'Envelope type; use `task` when unsure.',
      },
      payload: {
        type: 'string',
        description: 'Optional body; use empty string when unused.',
      },
      team_name: {
        type: 'string',
        description: 'Override team for mailbox persistence; use empty string when unused.',
      },
      plain: {
        type: 'boolean',
        description: 'If true, persist a plain timestamped line (no JSON envelope).',
      },
    },
    required: ['to', 'message', 'type', 'payload', 'team_name', 'plain'],
    additionalProperties: false,
  }
}

/** Read `to.enum` from an already-patched SendMessage {@link ToolDefinition}, if present. */
export function readSendMessageToEnumFromDefinition(tool: ToolDefinition): string[] | null {
  if (tool.name !== SEND_MESSAGE_TOOL) return null
  const to = tool.input_schema?.properties?.to as { enum?: unknown } | undefined
  if (!to || !Array.isArray(to.enum) || to.enum.length === 0) return null
  return to.enum.filter((x): x is string => typeof x === 'string')
}
