/**
 * P3.3 — tool invocation statistics for auditing and future optimization hints.
 */

type ToolStat = { ok: number; fail: number; lastError?: string }

const byTool = new Map<string, ToolStat>()

/** Optional metadata when the call does not go through registry.execute (e.g. direct write, user deny). */
export type RecordToolInvocationMeta = {
  errorSnippet?: string
  /** Stored on lastError as [type]… for auditing / hints. */
  errorType?: string
}

function foldMeta(meta?: string | RecordToolInvocationMeta): string | undefined {
  if (meta === undefined) return undefined
  if (typeof meta === 'string') return meta
  const { errorSnippet, errorType } = meta
  if (errorType && errorSnippet) return `[${errorType}] ${errorSnippet}`.slice(0, 500)
  if (errorType) return `[${errorType}]`.slice(0, 500)
  return errorSnippet?.slice(0, 500)
}

export function recordToolInvocation(
  toolName: string,
  success: boolean,
  errorSnippetOrMeta?: string | RecordToolInvocationMeta,
): void {
  const cur = byTool.get(toolName) ?? { ok: 0, fail: 0 }
  const folded = foldMeta(errorSnippetOrMeta)
  if (success) {
    cur.ok += 1
  } else {
    cur.fail += 1
    if (folded) {
      cur.lastError = folded
    }
  }
  byTool.set(toolName, cur)
}

export function getToolAnalyticsSnapshot(): Record<string, ToolStat> {
  return Object.fromEntries(byTool.entries())
}

export function suggestToolOptimizationHints(): string[] {
  const hints: string[] = []
  for (const [name, s] of byTool.entries()) {
    const total = s.ok + s.fail
    if (total >= 5 && s.fail / total > 0.4) {
      hints.push(`High failure rate for "${name}" (${s.fail}/${total}). Review schema or add examples.`)
    }
  }
  return hints
}

export function resetToolAnalytics(): void {
  byTool.clear()
}
