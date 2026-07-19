/**
 * upstream–style hook stdin / HTTP body payload (common fields + event-specific).
 * @see https://code.claude.com/docs/en/hooks#common-input-fields
 */

import { getAgentContext } from '../../agents/agentContext'
import { getPermissionMode, type PermissionMode } from '../../ai/interactionState'
import { getConversationFilePathForHooks } from '../../conversation/service'
import { getWorkspacePath } from '../workspaceState'
import type { HookEvent } from './types'

const TOOL_CENTRIC_EVENTS = new Set<HookEvent>([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionDenied',
  'PreSkillUse',
  'PostSkillUse',
])

function toClaudeCodePermissionMode(mode: PermissionMode): string {
  if (mode === 'bubble') return 'default'
  return mode
}

function resolveTranscriptPath(cwd: string): string {
  const cid = getAgentContext()?.streamConversationId?.trim() ?? ''
  const ws =
    getWorkspacePath()?.trim() ||
    (cwd && cwd !== process.cwd() ? cwd : '') ||
    process.cwd()
  if (!cid || !ws) return ''
  return getConversationFilePathForHooks(cid, ws)
}

export function buildClaudeCodeHookStdinPayload(params: {
  event: HookEvent
  toolName: string
  toolInput: Record<string, unknown>
  cwd: string
  extraEnv?: Record<string, string>
}): Record<string, unknown> {
  const { event, toolName, toolInput, cwd, extraEnv } = params
  const ctx = getAgentContext()

  const base: Record<string, unknown> = {
    session_id: ctx?.streamConversationId ?? '',
    transcript_path: resolveTranscriptPath(cwd),
    cwd,
    hook_event_name: event,
    permission_mode: toClaudeCodePermissionMode(getPermissionMode()),
  }

  if (ctx?.agentId && ctx.agentId !== 'main') {
    base.agent_id = ctx.agentId
    if (ctx.sessionAgentType) base.agent_type = ctx.sessionAgentType
  }

  if (TOOL_CENTRIC_EVENTS.has(event)) {
    const out: Record<string, unknown> = {
      ...base,
      tool_name: toolName,
      tool_input: toolInput,
    }
    if (event === 'PostToolUse' || event === 'PostToolUseFailure') {
      const rawOut = extraEnv?.CLAUDE_TOOL_OUTPUT
      if (rawOut) {
        try {
          out.tool_response = JSON.parse(rawOut) as unknown
        } catch {
          out.tool_response = rawOut
        }
      }
      const succ = extraEnv?.CLAUDE_TOOL_SUCCESS
      if (succ !== undefined) out.tool_success = succ === 'true'
    }
    return out
  }

  return { ...base, ...toolInput }
}
