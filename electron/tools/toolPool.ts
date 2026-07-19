import type { Tool } from './types'

/**
 * Deduplicate by name (first occurrence wins — register builtins before MCP).
 */
export function dedupeToolsByName(tools: Tool[]): Tool[] {
  const seen = new Set<string>()
  const out: Tool[] = []
  for (const t of tools) {
    if (seen.has(t.name)) continue
    seen.add(t.name)
    out.push(t)
  }
  return out
}

/**
 * Stable ordering for prompt / cache: built-in first (no mcp__ prefix), then localeCompare by name.
 */
export function sortToolsForPrompt(tools: Tool[]): Tool[] {
  return [...tools].sort((a, b) => {
    const aMcp = a.name.startsWith('mcp__') ? 1 : 0
    const bMcp = b.name.startsWith('mcp__') ? 1 : 0
    if (aMcp !== bMcp) return aMcp - bMcp
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
}

export function assembleToolPool(raw: Tool[]): Tool[] {
  return sortToolsForPrompt(dedupeToolsByName(raw))
}

export type DeferredPoolDelta = {
  changed: boolean
  previousSignature: string
  nextSignature: string
  added: string[]
  removed: string[]
}

function signatureForDeferredNames(names: string[]): string {
  return [...names].sort((a, b) => a.localeCompare(b)).join('\n')
}

/**
 * Detect changes in which deferred tool names exist (e.g. MCP connect/disconnect).
 */
export function getDeferredToolsDelta(
  previousDeferredNames: string[],
  tools: Tool[],
): DeferredPoolDelta {
  const nextDeferred = tools.filter((t) => t.shouldDefer === true && !t.alwaysLoad).map((t) => t.name)
  const prevSig = signatureForDeferredNames(previousDeferredNames)
  const nextSig = signatureForDeferredNames(nextDeferred)
  const prevSet = new Set(previousDeferredNames)
  const nextSet = new Set(nextDeferred)
  const added = nextDeferred.filter((n) => !prevSet.has(n))
  const removed = previousDeferredNames.filter((n) => !nextSet.has(n))
  return {
    changed: prevSig !== nextSig,
    previousSignature: prevSig,
    nextSignature: nextSig,
    added,
    removed,
  }
}
