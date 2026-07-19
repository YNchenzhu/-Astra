/**
 * Settings disk persistence helpers.
 *
 * Extracted from `useSettingsStore.ts`. Owns:
 *   - serialized write queue (prevents races between concurrent `persist` calls)
 *   - retry-with-backoff on IPC failure
 *   - lightweight schema sanity check on the outgoing snapshot
 *
 * To keep this module free of any store-shape dependency (and thus avoid a
 * circular import), it accepts an already-built `Record<string, unknown>`
 * snapshot. The store is responsible for assembling that snapshot from its
 * own state; that mapping is store-specific and stays in the store file.
 */

import { saveSettings } from '../../services/electronAPI'

/** Serialized chain: every call awaits the previous one before writing. */
let persistQueue: Promise<void> = Promise.resolve()

/**
 * Fire-and-forget persist call. The returned promise is already attached to
 * the internal chain; callers do not need to await it, and errors are logged
 * via the chain handler rather than being re-thrown.
 */
export function enqueuePersist(snapshot: Record<string, unknown>): void {
  persistQueue = persistQueue.then(
    () => doPersistWithRetry(snapshot),
    (err) => {
      // Previous chain failure — still attempt this write.
      console.warn('Settings persist chain was broken, recovering:', err)
      return doPersistWithRetry(snapshot)
    },
  )
  persistQueue.catch((err) => {
    console.error('Settings persist chain failed:', err)
  })
}

async function doPersistWithRetry(snapshot: Record<string, unknown>): Promise<void> {
  const validation = validateSettingsSnapshot(snapshot)
  if (!validation.ok) {
    console.error('[Settings] Schema validation failed before persist:', validation.errors)
    // Still attempt to write — but log for debugging. Corrupted data is
    // better than silent loss.
  }

  const maxRetries = 3
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await saveSettings(snapshot)
      return
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      console.warn(`Settings persist attempt ${attempt}/${maxRetries} failed:`, lastError.message)
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 100 * attempt))
      }
    }
  }

  console.error('Failed to persist settings after all retries:', lastError)
}

/**
 * Lightweight schema validation for the settings snapshot before disk write.
 * Catches obviously corrupted data (wrong types, out-of-range values) that
 * would cause runtime errors on the next load.
 *
 * Exported for unit tests; the persist path calls it automatically.
 */
export function validateSettingsSnapshot(
  data: Record<string, unknown>,
): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = []

  const validProviders = new Set([
    'anthropic',
    'openai',
    'openai2',
    'gemini',
    'bedrock',
    'vertex',
    'foundry',
    'compatible',
    'dashscope',
    'minimax',
    'zhipu',
    'kimi',
    'deepseek',
  ])
  if (typeof data.providerId === 'string' && !validProviders.has(data.providerId)) {
    errors.push(`Invalid providerId: "${data.providerId}"`)
  }

  const validThemes = new Set(['dark', 'light', 'milk', 'cursor', 'system'])
  if (typeof data.theme === 'string' && !validThemes.has(data.theme)) {
    errors.push(`Invalid theme: "${data.theme}"`)
  }

  const numericChecks: Array<[string, number, number]> = [
    ['maxTokens', 1, 1_000_000],
    ['thinkingBudgetTokens', 0, 64_000],
  ]
  for (const [key, min, max] of numericChecks) {
    const v = data[key]
    if (typeof v === 'number' && (v < min || v > max || !Number.isFinite(v))) {
      errors.push(`${key} out of range: ${v} (expected ${min}–${max})`)
    }
  }

  const arrayFields = ['apiConfigs', 'permissionRules', 'hooks', 'envVars']
  for (const field of arrayFields) {
    const v = data[field]
    if (v !== undefined && v !== null && !Array.isArray(v)) {
      errors.push(`${field} should be an array, got ${typeof v}`)
    }
  }

  const validExternalDiskModes = new Set(['skip_if_dirty', 'always_reload'])
  if (
    typeof data.externalDiskChangeRefreshMode === 'string' &&
    !validExternalDiskModes.has(data.externalDiskChangeRefreshMode)
  ) {
    errors.push(`Invalid externalDiskChangeRefreshMode: "${data.externalDiskChangeRefreshMode}"`)
  }

  if (data.sandbox !== undefined && data.sandbox !== null) {
    if (typeof data.sandbox !== 'object' || Array.isArray(data.sandbox)) {
      errors.push('sandbox should be an object')
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors }
}
