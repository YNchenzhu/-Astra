/**
 * Per-model context-window override store (main-process side).
 *
 * Two layers, both case-insensitive on `modelId`:
 * 1. {@link userOverrides} — written from Settings UI; persisted under
 *    `modelContextWindowOverrides` in disk settings; survives restarts.
 * 2. {@link registryWindows} — pushed once at app boot from
 *    `src/data/providerRegistry.ts::buildRegistryContextWindowMap`. Kept
 *    separate so a user override always wins, and a registry refresh
 *    (e.g. dev hot-reload of the renderer) doesn't clobber user choices.
 *
 * Lookup priority — see {@link getOverrideContextWindowTokens}. Consumed
 * by {@link getModelContextWindowTokens} in
 * `openClaudeParityConstants.ts` BEFORE its regex fallback, so adding a
 * new model with `contextWindow` in the registry is enough to fix the
 * chat-header `% 模型窗口` gauge.
 */

const userOverrides = new Map<string, number>()
const registryWindows = new Map<string, number>()

function normalizeId(modelId: string): string {
  return modelId.trim().toLowerCase()
}

function isValidWindow(tokens: unknown): tokens is number {
  return (
    typeof tokens === 'number' &&
    Number.isFinite(tokens) &&
    tokens > 0 &&
    // Reasonable upper bound: 100M. Anything beyond is almost certainly
    // a unit mistake (chars vs tokens). Reject silently.
    tokens <= 100_000_000
  )
}

/**
 * Lookup priority: user override > registry-declared > undefined.
 * Returns `undefined` when the model is unknown so callers fall through
 * to env / regex / default chain in {@link getModelContextWindowTokens}.
 */
export function getOverrideContextWindowTokens(modelId: string): number | undefined {
  const key = normalizeId(modelId)
  if (!key) return undefined
  const u = userOverrides.get(key)
  if (u !== undefined) return u
  return registryWindows.get(key)
}

/**
 * Replace the registry-declared map wholesale. Called once from
 * `context:set-registry-windows` IPC at renderer boot.
 *
 * Ignores invalid entries instead of throwing, since this comes from
 * untrusted IPC payload — a single bad number shouldn't disable the
 * whole feature.
 */
export function setRegistryContextWindows(map: Record<string, number>): void {
  registryWindows.clear()
  for (const [id, tokens] of Object.entries(map)) {
    if (!id) continue
    if (!isValidWindow(tokens)) continue
    registryWindows.set(normalizeId(id), tokens)
  }
}

/**
 * Bulk-load user overrides from disk settings on app boot. Called from
 * `appBootstrap` after `loadSettings()`.
 */
export function setUserContextWindowOverridesBulk(map: Record<string, number>): void {
  userOverrides.clear()
  for (const [id, tokens] of Object.entries(map)) {
    if (!id) continue
    if (!isValidWindow(tokens)) continue
    userOverrides.set(normalizeId(id), tokens)
  }
}

/** Set or replace a single user override. Returns `true` when accepted. */
export function setUserContextWindowOverride(modelId: string, tokens: number): boolean {
  const key = normalizeId(modelId)
  if (!key) return false
  if (!isValidWindow(tokens)) return false
  userOverrides.set(key, tokens)
  return true
}

/** Remove a single user override. No-op if not present. */
export function clearUserContextWindowOverride(modelId: string): void {
  const key = normalizeId(modelId)
  if (!key) return
  userOverrides.delete(key)
}

/** Snapshot for the Settings UI table — ordered alphabetically. */
export function getUserContextWindowOverrides(): Record<string, number> {
  const out: Record<string, number> = {}
  const keys = Array.from(userOverrides.keys()).sort()
  for (const k of keys) {
    out[k] = userOverrides.get(k)!
  }
  return out
}

/** Same shape but for registry — used by the Settings UI to show defaults. */
export function getRegistryContextWindows(): Record<string, number> {
  const out: Record<string, number> = {}
  const keys = Array.from(registryWindows.keys()).sort()
  for (const k of keys) {
    out[k] = registryWindows.get(k)!
  }
  return out
}

/** Test-only — drop both maps. */
export function __resetModelWindowOverridesForTest(): void {
  userOverrides.clear()
  registryWindows.clear()
}
