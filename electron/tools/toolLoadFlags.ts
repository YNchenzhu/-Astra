/**
 * Runtime tool listing flags (upstream-style feature toggles — subset).
 * Complements per-tool {@link Tool.isEnabled} with a process-wide deny list from env.
 */

import { registryPrimaryToolName } from './builtinToolAliases'

let cachedDisabled: string[] | null = null

function parseDisabledList(raw: string | undefined): string[] {
  if (!raw?.trim()) return []
  const parts = raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
  return [...new Set(parts)]
}

/**
 * Tool names excluded from {@link getToolDefinitions} / read-only variant.
 * `ASTRA_DISABLED_TOOLS` — comma or whitespace separated (e.g. `Bash,WebFetch`).
 */
export function getRuntimeDisabledToolNames(): string[] {
  if (cachedDisabled) return cachedDisabled
  cachedDisabled = parseDisabledList(process.env.ASTRA_DISABLED_TOOLS)
  return cachedDisabled
}

/** Test / env mutation: clear memo so a new `ASTRA_DISABLED_TOOLS` is picked up. */
export function resetRuntimeDisabledToolNamesForTests(): void {
  cachedDisabled = null
}

export function isToolRuntimeDisabled(toolName: string): boolean {
  const disabled = getRuntimeDisabledToolNames()
  if (disabled.length === 0) return false
  // Audit P1#1 — compare via `registryPrimaryToolName` on BOTH sides so
  // `ASTRA_DISABLED_TOOLS=Bash,WebFetch` also disables the registry
  // names `bash` / `web_fetch` (a literal `includes` never matched and the
  // env var silently did nothing).
  const want = registryPrimaryToolName(toolName)
  return disabled.some((d) => registryPrimaryToolName(d) === want)
}

/** Session cache segment when disabled list affects model-visible tools. */
export function runtimeDisabledToolNamesFingerprint(): string {
  const n = getRuntimeDisabledToolNames()
  if (n.length === 0) return '-'
  return `dis:${[...n].sort().join(',')}`
}
