/**
 * Per-conversation context **display** state for the chat header (estimated tokens / level).
 * {@link updateConversationContextDisplay} is driven from the agentic loop; the renderer polls
 * `context:get-state` and subscribes to `context:display-updated` for timely updates.
 *
 * Scope design (§ "per-workspace/conversation ContextManager"):
 *
 * - `contextManager` (singleton in manager.ts) is the authoritative home for
 *   **thresholds** (user-global Settings) and serves as the last-resort state
 *   fallback when no conversation is active yet (app boot, IPC analyze-live
 *   without an agent context).
 * - `managers` below is the per-conversation display store, evicted LRU up
 *   to {@link MAX_MANAGERS}.
 * - `agenticLoop` creates a **fresh** `ContextManager` per turn (it doesn't
 *   touch either of the above), so recording of per-request usage / prefetch
 *   is naturally scoped and parallel sub-agents never collide.
 *
 * This module is the single entrypoint external code should use for
 * "give me the manager for conversation X" — the global singleton is not
 * meant to carry state across multiple conversations.
 */

import { ContextManager, contextManager, type ContextThresholds } from './manager'
import { notifyContextDisplayUpdated } from './contextDisplayNotify'

const managers = new Map<string, ContextManager>()

/** Maximum number of per-conversation display managers to keep in memory. */
const MAX_MANAGERS = 50

function evictOldest(): void {
  if (managers.size <= MAX_MANAGERS) return
  // Map iterates in insertion order; first key is the oldest
  const oldest = managers.keys().next().value
  if (oldest !== undefined) {
    managers.delete(oldest)
  }
}

function getOrCreateManager(conversationId: string): ContextManager {
  let m = managers.get(conversationId)
  if (!m) {
    m = new ContextManager(contextManager.getThresholds())
    managers.set(conversationId, m)
    evictOldest()
  } else {
    m.updateThresholds(contextManager.getThresholds())
  }
  return m
}

/**
 * Public accessor — returns the display-scope {@link ContextManager} for
 * `conversationId`, creating one seeded from global thresholds if needed.
 *
 * Prefer this over the singleton `contextManager` whenever a conversation
 * id is available so state (estimatedTokens, level, compactCount,
 * lastUsageInputTokens) stays isolated between concurrent chats /
 * sub-agent conversations. The singleton remains the correct choice only
 * for reading/writing user-global thresholds.
 */
export function getContextManagerForConversation(
  conversationId: string,
): ContextManager {
  const id = conversationId.trim()
  if (!id) return contextManager
  return getOrCreateManager(id)
}

/**
 * Non-creating variant — returns the existing manager for `conversationId`
 * or `undefined` if one hasn't been spun up yet. Used by UI IPC handlers
 * that want per-scope truth but shouldn't allocate state just to read.
 */
export function peekContextManagerForConversation(
  conversationId: string,
): ContextManager | undefined {
  const id = conversationId.trim()
  if (!id) return undefined
  return managers.get(id)
}

/**
 * Recompute token estimate + warning level for a conversation (main chat only; callers should gate).
 */
export function updateConversationContextDisplay(
  conversationId: string,
  apiMessages: Array<Record<string, unknown>>,
  systemPrompt: string,
  toolTokens: number,
  /**
   * When the agentic loop uses upstream-derived thresholds (`POLE_OPENCLAUDE_CONTEXT_THRESHOLDS=1`),
   * pass the same {@link ContextManager.getThresholds} so the header matches compaction behavior.
   */
  evaluateThresholds?: ContextThresholds,
  /** When set, fills {@link ContextState.usagePercentOfWindow} (upstream §2.3). */
  evaluateModel?: string,
): void {
  const id = conversationId.trim()
  if (!id) return
  const mgr = getOrCreateManager(id)
  if (evaluateThresholds) {
    mgr.updateThresholds(evaluateThresholds)
  } else {
    mgr.updateThresholds(contextManager.getThresholds())
  }
  mgr.evaluate(apiMessages, systemPrompt, toolTokens, evaluateModel)
  notifyContextDisplayUpdated(id)
}

export function getConversationContextDisplayState(conversationId: string | undefined): ReturnType<
  ContextManager['getState']
> {
  const id = conversationId?.trim()
  if (id && managers.has(id)) {
    return managers.get(id)!.getState()
  }
  return contextManager.getState()
}

/** True when this conversation still has its own display manager (not evicted / never updated). */
export function hasConversationContextDisplay(conversationId: string): boolean {
  const id = conversationId.trim()
  return id.length > 0 && managers.has(id)
}

export function resetConversationContextDisplay(conversationId?: string): void {
  if (conversationId?.trim()) {
    const cid = conversationId.trim()
    managers.delete(cid)
    notifyContextDisplayUpdated(cid)
    return
  }
  managers.clear()
  contextManager.reset()
  notifyContextDisplayUpdated()
}

/** After Settings changes thresholds, keep per-chat display managers in sync. */
export function reapplyDisplayManagerThresholdsFromGlobal(): void {
  const t = contextManager.getThresholds()
  for (const m of managers.values()) {
    m.updateThresholds(t)
  }
}
