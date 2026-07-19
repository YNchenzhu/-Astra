/**
 * Process-lifetime state for the Anthropic fast-mode beta header.
 *
 * Extracted from `client.ts` when `streamAnthropic` moved into
 * `./anthropic.ts`. Previously this was a free-floating pair of module-level
 * `let` / `Map` with no encapsulation — any file that happened to import
 * `client.ts` could (in theory) mutate it. Centralising it here makes the
 * ownership explicit and gives tests a deterministic reset hook.
 *
 * Semantics (see §12.4 in the protocol notes):
 *   - If the Anthropic API rejects the fast-mode beta header once, we stop
 *     sending it for the rest of the process lifetime.
 *   - Each conversation has its own short cooldown after a long `Retry-After`
 *     (fast-mode backoff); `shouldSendFastModeBeta` re-enables automatically
 *     once the cooldown window expires.
 *   - `POLE_FAST_MODE_DISABLED=1` is an environment kill-switch that suppresses
 *     the beta header globally without touching the latched flag.
 */

import type { StreamTextParams } from '../client'
import {
  FAST_MODE_COOLDOWN_MIN_MS,
  FAST_MODE_SHORT_RETRY_AFTER_SEC,
} from '../withRetry'

let globallyDisabled = false
const cooldownUntilByConversation = new Map<string, number>()

function normalizedConversationId(raw: string | undefined): string | undefined {
  const t = raw?.trim()
  return t || undefined
}

/**
 * Should the Anthropic stream call include the fast-mode beta header?
 *
 * Returns false if:
 *   - the caller did not request fast mode, or
 *   - the process-lifetime latch has tripped, or
 *   - the env kill-switch is set, or
 *   - the per-conversation cooldown is still active.
 */
export function shouldSendFastModeBeta(
  params: StreamTextParams,
  conversationId: string | undefined,
): boolean {
  if (!params.anthropicFastMode) return false
  if (globallyDisabled || process.env.POLE_FAST_MODE_DISABLED === '1') return false
  const cid = normalizedConversationId(conversationId)
  if (!cid) return true
  const until = cooldownUntilByConversation.get(cid) ?? 0
  return Date.now() >= until
}

/**
 * Record a long `Retry-After` while fast mode was requested so subsequent
 * calls for this conversation skip the beta until the cooldown passes.
 * No-op for short `Retry-After` values and for requests that did not ask
 * for fast mode.
 */
export function applyLongRetryAfterCooldown(
  conversationId: string | undefined,
  retryAfterMs: number | undefined,
  requestedFast: boolean,
): void {
  if (
    !requestedFast ||
    retryAfterMs == null ||
    retryAfterMs < FAST_MODE_SHORT_RETRY_AFTER_SEC * 1000
  ) {
    return
  }
  const cid = normalizedConversationId(conversationId)
  if (!cid) return
  const cool = Math.max(FAST_MODE_COOLDOWN_MIN_MS, retryAfterMs)
  cooldownUntilByConversation.set(cid, Date.now() + cool)
}

/** Latch the process-lifetime disable (called on explicit API rejection). */
export function disableFastModeGlobally(): void {
  globallyDisabled = true
}

/** Test-only reset. Do not call from production code paths. */
export function __resetAnthropicFastModeStateForTests(): void {
  globallyDisabled = false
  cooldownUntilByConversation.clear()
}
