/**
 * upstream-style tool error buckets + stable telemetry hints (OTel-friendly labels).
 */

export type ToolErrorClass =
  | 'permission_denied'
  | 'validation'
  | 'filesystem'
  | 'network'
  | 'timeout'
  | 'not_found'
  | 'rate_limit'
  /** MCP transport / server-side error (distinct from raw `network` so the model knows to call `check_mcp_server_auth` etc.). */
  | 'mcp'
  /** Bash/shell exit non-zero with empty stderr — usually "tests failed", "grep no match", wrong cwd. */
  | 'shell'
  /** Sibling tool in the same parallel batch failed; this one was aborted, not actually broken. */
  | 'parallel_abort'
  | 'unknown'

export type ClassifiedToolError = {
  class: ToolErrorClass
  /** Stable snake_case reason for metrics exporters */
  telemetryHint: string
}

function lower(s: string): string {
  return s.toLowerCase()
}

/**
 * Classify a tool failure message or thrown error for logging and optional UI.
 */
export function classifyToolError(
  err: unknown,
  ctx?: { toolName?: string },
): ClassifiedToolError {
  const msg =
    typeof err === 'string'
      ? err
      : err instanceof Error
        ? err.message
        : String(err ?? 'unknown')
  const t = lower(msg)
  const tool = (ctx?.toolName && lower(ctx.toolName)) || ''

  if (/permission denied|permission cancelled|blocked by|hook\)/i.test(msg)) {
    return { class: 'permission_denied', telemetryHint: 'permission_denied' }
  }
  // `parallel_abort` first: its phrase ("aborted because another tool in the
  // same parallel batch failed") would otherwise trip the generic
  // `not_found`/`validation` regexes since "aborted" + "failed" appear in it.
  if (/aborted.*parallel|parallel.*aborted/i.test(t)) {
    return { class: 'parallel_abort', telemetryHint: 'parallel_abort' }
  }
  if (/not found|enoent|unknown tool/i.test(t)) {
    return { class: 'not_found', telemetryHint: tool.includes('mcp') ? 'mcp_not_found' : 'not_found' }
  }
  if (/timeout|timed out|etimedout/i.test(t)) {
    return { class: 'timeout', telemetryHint: 'timeout' }
  }
  // MCP-specific transport / server errors (check before generic `network` so
  // the model gets `mcp` rather than the broader `network` bucket — they
  // dispatch to different recovery paths: re-auth vs. retry).
  if (tool.startsWith('mcp__') || /\bmcp[\s_-]?(server|transport|client)\b/i.test(t)) {
    return { class: 'mcp', telemetryHint: 'mcp' }
  }
  if (/econnrefused|enotfound|network|fetch failed|socket|dns/i.test(t)) {
    return { class: 'network', telemetryHint: 'network' }
  }
  if (/rate limit|429|too many requests/i.test(t)) {
    return { class: 'rate_limit', telemetryHint: 'rate_limit' }
  }
  // `shell`: bash/PowerShell exited non-zero with empty stderr. Common case
  // is "tests failed", "grep matched nothing", or wrong cwd — NOT a tool
  // bug, so we surface it as `shell` rather than `unknown` to let the model
  // read the stdout payload before retrying with different flags.
  if (/command exited with code \d+/i.test(t) && /no stderr|stderr empty/i.test(t)) {
    return { class: 'shell', telemetryHint: 'shell_nonzero_no_stderr' }
  }
  if (/invalid|validation|zod|must be|required|refusing/i.test(t)) {
    return { class: 'validation', telemetryHint: 'validation' }
  }
  if (/eacces|eperm|outside the workspace|path .* resolves/i.test(t)) {
    return { class: 'filesystem', telemetryHint: 'filesystem' }
  }
  if (/eisdir|not a file|is a directory/i.test(t)) {
    return { class: 'filesystem', telemetryHint: 'filesystem_type' }
  }

  return { class: 'unknown', telemetryHint: 'unknown' }
}

/** Map error class → OpenTelemetry-style `decision.source` string (report §5.2 analogue). */
export function toolErrorClassToOtelSource(c: ToolErrorClass): string {
  return `tool_error.${c}`
}
