/**
 * Tracks tool names the model has discovered via ToolSearch (or select:),
 * so deferred tools can appear in the next prompt's tool definitions.
 *
 * Anthropic `defer_loading` on wire tool definitions is not used here; the
 * host instead omits deferred tools from the schema until discovery — see
 * {@link maybeAppendToolPoolTranscriptDeltas} for transcript-anchored pool deltas.
 */

import type { Tool } from './types'

const discovered = new Set<string>()
let discoveryEpoch = 0

export function getToolDiscoveryEpoch(): number {
  return discoveryEpoch
}

export function markToolsDiscovered(names: string[]): void {
  let changed = false
  for (const n of names) {
    const trimmed = n?.trim()
    if (!trimmed) continue
    if (!discovered.has(trimmed)) changed = true
    discovered.add(trimmed)
  }
  if (changed) discoveryEpoch += 1
}

export function resetDeferredDiscovery(): void {
  discovered.clear()
  discoveryEpoch += 1
}

export function getDiscoveredDeferredToolNames(): ReadonlySet<string> {
  return discovered
}

export function isDeferredTool(tool: { name: string; shouldDefer?: boolean; alwaysLoad?: boolean }): boolean {
  if (tool.alwaysLoad) return false
  return tool.shouldDefer === true
}

export function isToolVisibleInPrompt(tool: {
  name: string
  shouldDefer?: boolean
  alwaysLoad?: boolean
}): boolean {
  if (!isDeferredTool(tool)) return true
  return discovered.has(tool.name)
}

/** Deferred tools: use `deferUntil` when set, else ToolSearch discovery. */
export function shouldExposeDeferredTool(tool: Tool): boolean {
  if (!tool.shouldDefer || tool.alwaysLoad) return true
  if (typeof tool.deferUntil === 'function') return tool.deferUntil()
  return isToolVisibleInPrompt(tool)
}
