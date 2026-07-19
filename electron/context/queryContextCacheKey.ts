/**
 * AC-6.5 / upstream §16.4 — stable key for “shared prompt prefix” parity (fork inherits parent system).
 * Provider prompt-cache bytes are upstream; this string is for app-side correlation and tests.
 */

import { createHash } from 'node:crypto'

function fingerprint(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 24)
}

export type QueryContextCacheKeyInput = {
  model: string
  /**
   * The system text that fork children inherit from the parent (`parentSystemPrompt`), or full main system.
   */
  sharedSystemPrefix: string
  /** Tool surface revision when included in cache-key parity (optional). */
  toolsetRevision?: number
}

/**
 * Builds a deterministic cache-key string. Fork runs should pass the **parent** system string
 * so the key matches the main chat when model + inherited system align.
 */
export function buildQueryContextCacheKey(input: QueryContextCacheKeyInput): string {
  const model = input.model.trim() || 'unknown-model'
  const sysFp = fingerprint(input.sharedSystemPrefix)
  const rev =
    typeof input.toolsetRevision === 'number' && Number.isFinite(input.toolsetRevision)
      ? String(Math.floor(input.toolsetRevision))
      : 'na'
  return `pole:qctx:v1:${model}:${sysFp}:tools=${rev}`
}
