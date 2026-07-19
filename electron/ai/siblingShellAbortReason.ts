/**
 * upstream report §4.3 / §4.4 — when a Bash (or PowerShell) sibling fails in a parallel
 * batch, siblings are aborted with a structured reason so {@link runAgenticToolUse} can
 * emit the same prose as upstream: "Cancelled: parallel tool call <id> errored".
 */

export const SIBLING_SHELL_FAILURE_KIND = 'astra_sibling_shell_failure' as const

export type SiblingShellFailurePayload = {
  kind: typeof SIBLING_SHELL_FAILURE_KIND
  sourceToolUseId: string
}

export function createSiblingShellFailureReason(sourceToolUseId: string): SiblingShellFailurePayload {
  return { kind: SIBLING_SHELL_FAILURE_KIND, sourceToolUseId }
}

export function isSiblingShellFailureReason(r: unknown): r is SiblingShellFailurePayload {
  return (
    Boolean(r) &&
    typeof r === 'object' &&
    (r as SiblingShellFailurePayload).kind === SIBLING_SHELL_FAILURE_KIND &&
    typeof (r as SiblingShellFailurePayload).sourceToolUseId === 'string'
  )
}

/** upstream-style sentence (without `Error:` prefix — caller adds for tool_result bodies). */
export function formatParallelToolSiblingCancelError(sourceToolUseId: string): string {
  return `Cancelled: parallel tool call ${sourceToolUseId} errored`
}

/**
 * `tool_result` string body when execution stopped because the merged {@link AbortSignal} fired.
 */
export function toolResultContentForAbortedSignal(signal: AbortSignal): string {
  const r = signal.reason
  if (isSiblingShellFailureReason(r)) {
    return `Error: ${formatParallelToolSiblingCancelError(r.sourceToolUseId)}`
  }
  return 'Error: Tool execution cancelled.'
}
