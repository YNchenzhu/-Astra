/**
 * upstream report §16.5 — module-level state (collapse store, micro-compact latch, caches) must not be
 * cleared from **sub-agent / fork** compaction paths. Gate future cleanups with {@link isMainThreadAgentForCompact}.
 *
 * §17.3 — optional dedupe key so duplicate post-compact hook paths do not double-apply budget extensions.
 */

import type { AgentContext } from './agentContext'
import { addAgentContextCompactConsumedInputEstimate, getAgentContext } from './agentContext'

/** Main REPL / primary chat stream (`streamHandler` uses `agentId: 'main'`). */
export function isMainThreadAgentForCompact(ctx: AgentContext | null | undefined): boolean {
  const id = ctx?.agentId
  return id === undefined || id === null || id === '' || id === 'main'
}

export type PostCompactCleanupOptions = {
  dedupeKey?: string
  /** §3.6 — extend main-thread output budget ceiling when context shrinks materially. */
  outputBudgetCeilingExtension?: number
}

/**
 * P2-2: cap the dedupe set with FIFO eviction. Previously this was an
 * unbounded `Set`; the only escape was to `.clear()` everything once size
 * exceeded 400. That meant a long-running session with many compactions
 * lost ALL dedupe memory at once and could re-apply the same budget
 * extension twice (once before the clear, once after) for the same key.
 *
 * Map-based ordering guarantees FIFO insertion-order traversal, so we
 * evict the oldest single entry instead of clearing the whole set.
 */
const RECENT_DEDUPE_KEY_MAX = 400
const recentDedupeKeys = new Map<string, true>()

function rememberDedupeKey(key: string): void {
  if (recentDedupeKeys.has(key)) return
  recentDedupeKeys.set(key, true)
  while (recentDedupeKeys.size > RECENT_DEDUPE_KEY_MAX) {
    const oldest = recentDedupeKeys.keys().next().value
    if (oldest === undefined) break
    recentDedupeKeys.delete(oldest)
  }
}

/** Test helper — clear dedupe memory. */
export function resetPostCompactCleanupDedupeForTests(): void {
  recentDedupeKeys.clear()
}

/**
 * Hook after compaction. Two distinct concerns:
 *   1. Module-level / global cleanups (collapse store, micro-compact latch,
 *      caches) — main thread only, otherwise sub-agent compactions trash
 *      shared state belonging to the main chat.
 *   2. Per-agent compact credit (output budget ceiling extension) — applies
 *      to every agent. Each agent's ALS chain holds its own
 *      `poleCompactConsumedInputEstimate`, so writing it here is local to
 *      whichever agent triggered the compact (main, sub-agent, or async).
 *      Without this, sub-agents that compacted mid-run lost output budget
 *      headroom and silently truncated their final reply.
 */
export function postCompactCleanup(
  reason: 'micro' | 'auto' | 'reactive',
  opts?: PostCompactCleanupOptions,
): void {
  void reason
  if (opts?.dedupeKey) {
    const k = opts.dedupeKey
    if (recentDedupeKeys.has(k)) return
    rememberDedupeKey(k)
  }
  // Per-agent credit — main AND sub-agents.
  const ext = opts?.outputBudgetCeilingExtension
  if (typeof ext === 'number' && Number.isFinite(ext) && ext > 0) {
    addAgentContextCompactConsumedInputEstimate(Math.floor(ext))
  }
  // Module-level cleanups would go here, gated on main thread.
  // (Currently there are none in this file beyond the credit write above.)
  if (!isMainThreadAgentForCompact(getAgentContext())) return
}
