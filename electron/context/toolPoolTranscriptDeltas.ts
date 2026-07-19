/**
 * Transcript-anchored **tool pool** and **built-in agent listing** deltas
 * (upstream `deferred_tools_delta` / `agent_listing_delta` analogue).
 *
 * - Embeds machine-parsable `<!-- pole-dtd:v1 ... -->` / `<!-- pole-ald:v1 ... -->`
 *   lines inside a `<system-reminder>` user message so survives compaction
 *   scanning and `normalizeMessagesForAPI` (comments are plain text).
 * - Reconstructs prior announcements by replaying markers in message order.
 *
 * Disable: `POLE_TOOL_POOL_TRANSCRIPT_DELTA=0`.
 */

import type { PermissionRulePayload } from '../ai/permissionRuleMatch'
import { isToolDeniedForModelListing } from '../ai/permissionRuleMatch'
import { getBuiltInAgents } from '../agents/builtInAgents'
import { toolRegistry } from '../tools/registry'
import { orderToolsForModelListing } from '../tools/schema'
import { toolAllowedInSimpleToolset } from '../utils/simpleToolset'
import { shouldHideGlobGrepForEmbeddedSearch } from '../utils/embeddedTools'
import { isToolRuntimeDisabled } from '../tools/toolLoadFlags'
import { SIDE_CHANNEL_KIND, wrapSideChannelBody } from '../constants/sideChannelKinds'

const ENV_DISABLE = 'POLE_TOOL_POOL_TRANSCRIPT_DELTA'

const MARK_DTD =
  /<!--\s*pole-dtd:v1\s+added=([^>]*?)\s+removed=([^>]*?)\s*-->/g
const MARK_ALD = /<!--\s*pole-ald:v1\s+types=([^>]*?)\s*-->/g

function isDeltaDisabled(): boolean {
  const v = process.env[ENV_DISABLE]?.trim().toLowerCase()
  return v === '0' || v === 'false' || v === 'off'
}

function messagePlainText(msg: Record<string, unknown>): string {
  const c = msg.content
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return ''
  let out = ''
  for (const b of c as Record<string, unknown>[]) {
    if (b?.type === 'text' && typeof b.text === 'string') out += `${b.text}\n`
  }
  return out
}

function parseCsvNames(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Replay deferred-tool delta markers in transcript order (upstream semantics). */
export function replayDeferredToolNamesFromTranscript(
  messages: Array<Record<string, unknown>>,
): Set<string> {
  const announced = new Set<string>()
  for (const msg of messages) {
    if (msg.role !== 'user') continue
    const text = messagePlainText(msg)
    const re = new RegExp(MARK_DTD.source, 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      for (const n of parseCsvNames(m[1] ?? '')) announced.add(n)
      for (const n of parseCsvNames(m[2] ?? '')) announced.delete(n)
    }
  }
  return announced
}

/** Last full built-in agent type snapshot from transcript (latest `pole-ald` wins). */
export function readLastBuiltInAgentTypesFromTranscript(
  messages: Array<Record<string, unknown>>,
): Set<string> {
  let last: Set<string> | null = null
  for (const msg of messages) {
    if (msg.role !== 'user') continue
    const text = messagePlainText(msg)
    const re = new RegExp(MARK_ALD.source, 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      last = new Set(parseCsvNames(m[1] ?? ''))
    }
  }
  return last ?? new Set()
}

function agentToolInRegistry(): boolean {
  const t = toolRegistry.get('Agent')
  return Boolean(t && t.isEnabled?.() !== false)
}

/** Same deferral rule as {@link import('../tools/ToolSearchTool').isDeferredTool}. */
function isDeferredForSearchPool(tool: {
  name: string
  alwaysLoad?: boolean
  shouldDefer?: boolean
}): boolean {
  if (tool.alwaysLoad === true) return false
  if (tool.name === 'ToolSearch') return false
  if (tool.name.startsWith('mcp__')) return true
  return tool.shouldDefer === true
}

/**
 * Deferred / lazy-loaded tool names in the current registry pool, with the
 * same listing gates as {@link getToolDefinitions} except we **include**
 * not-yet-discovered deferred tools (they are still pool members).
 */
export function listDeferredToolNamesForPool(
  permissionRules?: ReadonlyArray<PermissionRulePayload>,
): string[] {
  return orderToolsForModelListing(
    toolRegistry
      .getAll()
      .filter((t) => t.isEnabled?.() !== false)
      .filter(isDeferredForSearchPool)
      .filter((t) => toolAllowedInSimpleToolset(t))
      .filter((t) => !shouldHideGlobGrepForEmbeddedSearch(t.name))
      .filter((t) => !isToolDeniedForModelListing(t.name, permissionRules))
      .filter((t) => !isToolRuntimeDisabled(t.name)),
  ).map((t) => t.name)
}

export function listBuiltInAgentTypesSorted(): string[] {
  return getBuiltInAgents()
    .map((a) => a.agentType)
    .sort((a, b) => a.localeCompare(b))
}

export type ToolPoolDelta = {
  deferredAdded: string[]
  deferredRemoved: string[]
  agentAdded: string[]
  agentRemoved: string[]
}

export function computeToolPoolTranscriptDelta(
  messages: Array<Record<string, unknown>>,
  permissionRules?: ReadonlyArray<PermissionRulePayload>,
): ToolPoolDelta | null {
  const currentDef = new Set(listDeferredToolNamesForPool(permissionRules))
  const announcedDef = replayDeferredToolNamesFromTranscript(messages)

  const deferredAdded = [...currentDef].filter((n) => !announcedDef.has(n)).sort()
  const deferredRemoved = [...announcedDef].filter((n) => !currentDef.has(n)).sort()

  let agentAdded: string[] = []
  let agentRemoved: string[] = []
  if (agentToolInRegistry()) {
    const currentAg = new Set(listBuiltInAgentTypesSorted())
    const announcedAg = readLastBuiltInAgentTypesFromTranscript(messages)
    agentAdded = [...currentAg].filter((t) => !announcedAg.has(t)).sort()
    agentRemoved = [...announcedAg].filter((t) => !currentAg.has(t)).sort()
  }

  if (
    deferredAdded.length === 0 &&
    deferredRemoved.length === 0 &&
    agentAdded.length === 0 &&
    agentRemoved.length === 0
  ) {
    return null
  }
  return { deferredAdded, deferredRemoved, agentAdded, agentRemoved }
}

function buildMarkerLines(delta: ToolPoolDelta): { dtd: string; ald: string | null } {
  const enc = (xs: string[]) => xs.join(',')
  const dtd = `<!-- pole-dtd:v1 added=${enc(delta.deferredAdded)} removed=${enc(delta.deferredRemoved)} -->`
  const ald =
    agentToolInRegistry() && (delta.agentAdded.length || delta.agentRemoved.length)
      ? `<!-- pole-ald:v1 types=${enc(listBuiltInAgentTypesSorted())} -->`
      : null
  return { dtd, ald }
}

function lastInjectedMarkersMatch(messages: Array<Record<string, unknown>>, dtd: string, ald: string | null): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.role !== 'user') continue
    const text = messagePlainText(msg)
    if (!text.includes('pole-tool-pool-delta')) continue
    if (!text.includes(dtd)) return false
    if (ald) {
      if (!text.includes(ald)) return false
    }
    return true
  }
  return false
}

/**
 * Append a single synthetic user turn when the deferred-tool or built-in-agent
 * pool changed vs transcript. No-op when disabled or no delta.
 */
export function maybeAppendToolPoolTranscriptDeltas(
  messages: Array<Record<string, unknown>>,
  permissionRules?: ReadonlyArray<PermissionRulePayload>,
): Array<Record<string, unknown>> {
  if (isDeltaDisabled()) return messages
  const delta = computeToolPoolTranscriptDelta(messages, permissionRules)
  if (!delta) return messages

  const { dtd, ald } = buildMarkerLines(delta)
  if (lastInjectedMarkersMatch(messages, dtd, ald)) return messages

  const bodyLines: string[] = [
    '[pole-tool-pool-delta] Host-side availability changed vs the last transcript snapshot (NOT user text).',
    'Deferred tools may require `ToolSearch` (e.g. `select:ToolName`) before first use.',
    'The `<!-- pole-… -->` lines below are machine-readable anchors for the host — skip them and read the plain-language lines that follow.',
    '',
    dtd,
  ]
  if (ald) bodyLines.push('', ald)
  if (delta.deferredAdded.length) {
    bodyLines.push('', `Deferred tools newly in pool: ${delta.deferredAdded.join(', ')}`)
  }
  if (delta.deferredRemoved.length) {
    bodyLines.push('', `Deferred tools removed from pool (no longer registered): ${delta.deferredRemoved.join(', ')}`)
  }
  if (delta.agentAdded.length) {
    bodyLines.push('', `Built-in agent types added: ${delta.agentAdded.join(', ')}`)
  }
  if (delta.agentRemoved.length) {
    bodyLines.push('', `Built-in agent types removed: ${delta.agentRemoved.join(', ')}`)
  }

  return [
    ...messages,
    {
      role: 'user',
      content: wrapSideChannelBody(SIDE_CHANNEL_KIND.toolPoolDelta, bodyLines.join('\n')),
      _convertedFromSystem: true,
      _type: 'tool_pool_delta',
      _sideChannelKind: SIDE_CHANNEL_KIND.toolPoolDelta,
    },
  ]
}

/** Human-readable lines for {@link generatePostCompactAttachments}'s `deferredToolDelta`. */
export function buildPostCompactToolPoolDeltaLines(
  messages: Array<Record<string, unknown>>,
  permissionRules?: ReadonlyArray<PermissionRulePayload>,
): string[] {
  if (isDeltaDisabled()) return []
  const delta = computeToolPoolTranscriptDelta(messages, permissionRules)
  if (!delta) return []
  const out: string[] = []
  if (delta.deferredAdded.length) {
    out.push(`Deferred tools in pool (added since last snapshot): ${delta.deferredAdded.join(', ')}`)
  }
  if (delta.deferredRemoved.length) {
    out.push(`Deferred tools left pool (removed): ${delta.deferredRemoved.join(', ')}`)
  }
  if (delta.agentAdded.length || delta.agentRemoved.length) {
    out.push(
      `Built-in agent types: +${delta.agentAdded.join(', ') || '(none)'} / -${delta.agentRemoved.join(', ') || '(none)'}`,
    )
  }
  return out
}
