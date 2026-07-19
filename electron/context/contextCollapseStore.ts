/**
 * upstream §13 — minimal in-memory collapse store + optional persistence hook.
 * Summaries are queued per conversation; {@link consumeContextCollapseSummaries} drains for reactive compact.
 */

const summariesByKey = new Map<string, string[]>()

export function buildContextCollapseConversationKey(
  workspacePath: string | undefined,
  conversationId: string | undefined,
): string | undefined {
  const cid = conversationId?.trim()
  if (!cid) return undefined
  const ws = (workspacePath ?? '').trim()
  return ws ? `${ws}::${cid}` : `::${cid}`
}

/** Append a folded-segment summary (e.g. after context-collapse API or manual hook). */
export function appendContextCollapseSummary(conversationKey: string, summary: string): void {
  const k = conversationKey.trim()
  const s = summary.trim()
  if (!k || !s) return
  const list = summariesByKey.get(k) ?? []
  list.push(s)
  summariesByKey.set(k, list)
}

/** Returns queued summaries and clears the queue (§14 drain). */
export function consumeContextCollapseSummaries(conversationKey: string): string[] {
  const k = conversationKey.trim()
  const list = summariesByKey.get(k) ?? []
  summariesByKey.delete(k)
  return list
}

/**
 * P0-3 — Non-destructive peek. Callers planning a recovery attempt that may
 * not actually consume the summaries (e.g. "is it worth trying a drain-only
 * retry?") use this to gate without mutating store state. {@link consumeContextCollapseSummaries}
 * is still the only way to drain.
 */
export function hasContextCollapseSummaries(conversationKey: string): boolean {
  const k = conversationKey.trim()
  if (!k) return false
  const list = summariesByKey.get(k)
  return !!list && list.length > 0
}

/** Test / reset helper */
export function clearContextCollapseStoreForTests(): void {
  summariesByKey.clear()
}
