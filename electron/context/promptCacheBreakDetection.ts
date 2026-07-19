/**
 * upstream §17.5 — Prompt Cache Break Detection.
 *
 * Tracks factors that affect the prompt-cache key so that when any factor changes
 * between requests we can log the cache-break event and optionally notify the system.
 *
 * Factors tracked:
 * - System prompt content (hash)
 * - Tool schemas (hash)
 * - Beta headers
 * - Model identifier
 * - Fast mode flag
 * - Thinking config
 */

import { createHash } from 'node:crypto'

export interface CacheKeyFactors {
  systemPromptHash: string
  toolSchemaHash: string
  model: string
  fastMode: boolean
  thinkingEnabled: boolean
  /**
   * Effective `thinking.budget_tokens` for the request (post-adaptive
   * throttle). Anthropic invalidates the message-level cache when this
   * value changes between requests, so it is a real cache-key factor —
   * P2-2 audit fix (2026-07). `undefined` = provider-side default.
   */
  thinkingBudgetTokens?: number
  betaHeaders?: string[]
}

export interface CacheBreakEvent {
  timestamp: number
  changedFactors: string[]
  previous: CacheKeyFactors
  current: CacheKeyFactors
}

function quickHash(data: string): string {
  return createHash('sha256').update(data).digest('hex').slice(0, 16)
}

export function buildCacheKeyFactors(input: {
  systemPrompt: string
  toolSchemas: Array<Record<string, unknown>>
  model: string
  fastMode?: boolean
  thinkingEnabled?: boolean
  thinkingBudgetTokens?: number
  betaHeaders?: string[]
}): CacheKeyFactors {
  return {
    systemPromptHash: quickHash(input.systemPrompt),
    toolSchemaHash: quickHash(JSON.stringify(input.toolSchemas)),
    model: input.model,
    fastMode: input.fastMode ?? false,
    thinkingEnabled: input.thinkingEnabled ?? false,
    ...(input.thinkingBudgetTokens !== undefined
      ? { thinkingBudgetTokens: input.thinkingBudgetTokens }
      : {}),
    betaHeaders: input.betaHeaders?.slice().sort(),
  }
}

function arraysEqual(a: string[] | undefined, b: string[] | undefined): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  return a.every((v, i) => v === b[i])
}

export function detectCacheBreak(
  previous: CacheKeyFactors | null,
  current: CacheKeyFactors,
): CacheBreakEvent | null {
  if (!previous) return null

  const changed: string[] = []

  if (previous.systemPromptHash !== current.systemPromptHash) {
    changed.push('systemPrompt')
  }
  if (previous.toolSchemaHash !== current.toolSchemaHash) {
    changed.push('toolSchemas')
  }
  if (previous.model !== current.model) {
    changed.push('model')
  }
  if (previous.fastMode !== current.fastMode) {
    changed.push('fastMode')
  }
  if (previous.thinkingEnabled !== current.thinkingEnabled) {
    changed.push('thinkingEnabled')
  }
  if (previous.thinkingBudgetTokens !== current.thinkingBudgetTokens) {
    changed.push('thinkingBudgetTokens')
  }
  if (!arraysEqual(previous.betaHeaders, current.betaHeaders)) {
    changed.push('betaHeaders')
  }

  if (changed.length === 0) return null

  return {
    timestamp: Date.now(),
    changedFactors: changed,
    previous,
    current,
  }
}

/**
 * Per-conversation/scope tracker that remembers last cache key factors and reports breaks.
 *
 * A single chat can run multiple model streams with deliberately different
 * prompt-cache surfaces: main chat, session-memory-internal, tool summaries,
 * sub-agents, etc. They must not share one detector slot, otherwise the
 * smaller internal agent prompt is compared against the main chat prompt and
 * produces noisy `systemPrompt/toolSchemas` breaks on every alternation.
 */
export class PromptCacheBreakDetector {
  private lastFactors: CacheKeyFactors | null = null
  private breakHistory: CacheBreakEvent[] = []

  /**
   * Check current factors against previous. Returns break event if cache key changed, null otherwise.
   */
  check(current: CacheKeyFactors): CacheBreakEvent | null {
    const event = detectCacheBreak(this.lastFactors, current)
    this.lastFactors = current
    if (event) {
      this.breakHistory.push(event)
      console.warn(
        `[PromptCacheBreak] Detected cache break: ${event.changedFactors.join(', ')}`,
      )
    }
    return event
  }

  getBreakHistory(): readonly CacheBreakEvent[] {
    return this.breakHistory
  }

  getBreakCount(): number {
    return this.breakHistory.length
  }

  reset(): void {
    this.lastFactors = null
    this.breakHistory = []
  }
}

const perConversation = new Map<string, PromptCacheBreakDetector>()

function detectorKey(conversationId: string, scope?: string): string {
  const id = conversationId.trim()
  const s = scope?.trim()
  return s ? `${id}\0${s}` : id
}

export function getConversationCacheBreakDetector(
  conversationId: string,
  scope?: string,
): PromptCacheBreakDetector {
  const id = detectorKey(conversationId, scope)
  let d = perConversation.get(id)
  if (!d) {
    d = new PromptCacheBreakDetector()
    perConversation.set(id, d)
  }
  return d
}

export function resetConversationCacheBreakDetector(conversationId: string, scope?: string): void {
  if (scope?.trim()) {
    perConversation.delete(detectorKey(conversationId, scope))
    return
  }
  const id = conversationId.trim()
  for (const key of Array.from(perConversation.keys())) {
    if (key === id || key.startsWith(`${id}\0`)) {
      perConversation.delete(key)
    }
  }
}

export function resetAllCacheBreakDetectorsForTests(): void {
  perConversation.clear()
}
