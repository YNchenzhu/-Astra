/**
 * Parse agent frontmatter / JSON `hooks` field into {@link AgentHookSpec}[].
 */

import { HOOK_EVENTS, type HookEvent, type HookExecutionKind } from '../tools/hooks/types'
import type { AgentHookSpec } from './types'

function isHookEvent(x: string): x is HookEvent {
  return (HOOK_EVENTS as readonly string[]).includes(x)
}

const EXEC_KINDS = new Set<HookExecutionKind>(['command', 'prompt', 'agent', 'http'])

function parseExecutionKind(raw: unknown): HookExecutionKind | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  const k = raw.trim() as HookExecutionKind
  return EXEC_KINDS.has(k) ? k : undefined
}

/**
 * `hooks` must be a JSON string: [{"event":"PreToolUse","matcher":"Read","command":"..."}]
 */
export function parseAgentHooksField(raw: unknown): AgentHookSpec[] | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  try {
    const data = JSON.parse(raw) as unknown
    if (!Array.isArray(data)) return undefined
    const out: AgentHookSpec[] = []
    for (const row of data) {
      if (!row || typeof row !== 'object') continue
      const o = row as Record<string, unknown>
      const event = o.event
      const command = o.command
      const matcher = o.matcher
      if (typeof event !== 'string' || !isHookEvent(event)) continue
      if (typeof command !== 'string' || !command.trim()) continue
      out.push({
        event,
        matcher: typeof matcher === 'string' && matcher.trim() ? matcher : '*',
        command: command.trim(),
        async: o.async === true,
        executionKind: parseExecutionKind(o.executionKind),
      })
    }
    return out.length > 0 ? out : undefined
  } catch {
    return undefined
  }
}
