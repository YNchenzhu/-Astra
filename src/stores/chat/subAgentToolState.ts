import type { ToolUseDisplay } from '../../types'

const UNCLOSED_TOOL_MESSAGE =
  'Sub-agent finished before this tool emitted a result. Treat this tool as not completed.'

export function closeRunningSubAgentToolUses(
  toolUses: ToolUseDisplay[],
  message = UNCLOSED_TOOL_MESSAGE,
): ToolUseDisplay[] {
  return toolUses.map((toolUse) =>
    toolUse.status === 'running'
      ? {
          ...toolUse,
          status: 'stopped',
          error: toolUse.error || message,
        }
      : toolUse,
  )
}
