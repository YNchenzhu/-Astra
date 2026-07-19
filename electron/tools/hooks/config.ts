/**
 * Hooks configuration.
 *
 * Manages the runtime hook configurations, providing a singleton that can be
 * updated when settings change. Reads from the frontend-passed HookConfig array.
 */

import type { HookEvent, HookExecutionKind } from './types'

/**
 * Internal hook configuration (extends the simple frontend HookConfig
 * with runtime execution metadata).
 */
export interface InternalHook {
  id: string
  event: HookEvent
  command: string
  enabled: boolean
  /** Match pattern: tool name, pipe-separated list, regex, or * for all */
  matcher?: string
  /** Run in background without blocking the main loop */
  async?: boolean
  /** Wait for completion but notify model on exit code 2 */
  asyncRewake?: boolean
  /** upstream §9.2 — surfaced as CLAUDE_HOOK_EXECUTION_KIND (default command). */
  executionKind?: HookExecutionKind
}

// In-memory store, updated via setHooksConfig()
let hooks: InternalHook[] = []
let disableAllHooks = false
let envVars: Record<string, string> = {}

/**
 * Check if a matchQuery value matches a matcher pattern.
 *
 * Pattern rules:
 * - Empty or '*' matches everything
 * - Exact string: case-sensitive match
 * - Pipe-separated ("Write|Edit"): matches any item
 * - Regex (contains ^ or $ or .*): regex.test(matchQuery)
 */
export function matchesPattern(matchQuery: string, matcher?: string): boolean {
  if (!matcher || matcher === '*' || matcher.trim() === '') return true

  // Pipe-separated list
  if (matcher.includes('|')) {
    return matcher.split('|').some((m) => m.trim() === matchQuery)
  }

  // Regex pattern detection (simple heuristic: contains ^, $, or .*)
  if (/[\^$]|\.\*/.test(matcher)) {
    try {
      return new RegExp(matcher).test(matchQuery)
    } catch {
      // Invalid regex, fall back to exact match
    }
  }

  // Exact match
  return matcher === matchQuery
}

/**
 * Update the entire hooks configuration.
 * Called when settings change (via IPC from frontend).
 */
export function setHooksConfig(
  newHooks: Array<{
    id: string
    event: string
    command: string
    enabled: boolean
    matcher?: string
    async?: boolean
    asyncRewake?: boolean
    executionKind?: HookExecutionKind
  }>,
  disableAll: boolean = false,
  newEnvVars?: Array<{ id: string; key: string; value: string; enabled: boolean }>,
): void {
  hooks = newHooks
    .filter((h) => h.command.trim() !== '')
    .map((h) => ({
      id: h.id,
      event: h.event as HookEvent,
      command: h.command.trim(),
      enabled: h.enabled,
      matcher: h.matcher,
      async: h.async,
      asyncRewake: h.asyncRewake,
      executionKind: h.executionKind,
    }))
  disableAllHooks = disableAll

  // Build env vars map from enabled entries
  envVars = {}
  if (newEnvVars) {
    for (const e of newEnvVars) {
      if (e.enabled && e.key) {
        envVars[e.key] = e.value
      }
    }
  }
}

/**
 * Get the configured environment variables for hook processes.
 */
export function getEnvVars(): Record<string, string> {
  return { ...envVars }
}

/**
 * Get hooks for a specific event, filtered by matchQuery.
 * Returns only enabled hooks that match the query pattern.
 */
export function getHooksForEvent(event: HookEvent, matchQuery?: string): InternalHook[] {
  if (disableAllHooks) return []
  return hooks.filter((h) => {
    if (h.event !== event || !h.enabled) return false
    return matchesPattern(matchQuery || '', h.matcher)
  })
}

/**
 * Check if any hooks are configured for an event.
 */
export function hasHooksForEvent(event: HookEvent, matchQuery?: string): boolean {
  return !disableAllHooks && hooks.some((h) => {
    if (h.event !== event || !h.enabled) return false
    return matchesPattern(matchQuery || '', h.matcher)
  })
}

/**
 * Check if hooks are globally disabled.
 */
export function isHooksDisabled(): boolean {
  return disableAllHooks
}

/**
 * Reset all hooks (e.g., on session start).
 */
export function resetHooks(): void {
  hooks = []
  disableAllHooks = false
  envVars = {}
}
