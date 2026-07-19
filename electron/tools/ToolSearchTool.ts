/**
 * ToolSearchTool — search and load deferred tools.
 *
 * Mirrors upstream's ToolSearchTool: searches through "deferred" tools
 * (tools whose full schema is not loaded at startup), supports select: prefix
 * for direct selection, keyword-based scoring search, MCP tool handling,
 * and memoized description caching.
 *
 * Architecture equivalence to upstream:
 * - Deferred tools: tools marked `shouldDefer: true` or MCP tools
 * - Two query modes: `select:ToolA,ToolB` (direct) and keyword search
 * - Scoring: name parts > searchHint > description (word-boundary)
 * - Pending MCP server info when no matches found
 * - tool_reference block output format for schema loading
 */

import { toolRegistry } from './registry'
import { markToolsDiscovered, getToolDiscoveryEpoch } from './deferredDiscovery'
import type { Tool } from './types'
import { toolSearchInputZod } from './toolInputZod'
import { buildTool } from './buildTool'

// ============================================================
// Constants
// ============================================================

const TOOL_SEARCH_TOOL_NAME = 'ToolSearch'

// ============================================================
// Deferred tool detection
// ============================================================

/**
 * Check if a tool is "deferred" — its full schema is not loaded at startup
 * and requires ToolSearch to discover before use.
 *
 * A tool is deferred if:
 * - It has shouldDefer: true
 * - It is an MCP tool (name starts with mcp__)
 *
 * A tool is NEVER deferred if:
 * - It has alwaysLoad: true (opt-out from deferral)
 * - It is ToolSearch itself (needs to be available immediately)
 */
export function isDeferredTool(tool: Tool): boolean {
  // Explicit opt-out
  if (tool.alwaysLoad === true) return false

  // MCP tools are always deferred
  if (tool.name.startsWith('mcp__')) return true

  // Never defer ToolSearch itself
  if (tool.name === TOOL_SEARCH_TOOL_NAME) return false

  return tool.shouldDefer === true
}

/** Get all currently deferred tools. */
export function getDeferredTools(): Tool[] {
  return toolRegistry.getAll().filter(isDeferredTool)
}

// ============================================================
// Description cache (memoized)
// ============================================================

let cachedDeferredToolNames: string | null = null

function getDeferredToolsCacheKey(deferredTools: Tool[]): string {
  return deferredTools.map(t => t.name).sort().join(',')
}

const toolDescriptionCache = new Map<string, string>()

function getToolDescriptionCached(toolName: string): string {
  const hit = toolDescriptionCache.get(toolName)
  if (hit !== undefined) return hit
  const tool = toolRegistry.get(toolName)
  const d = tool ? tool.description : ''
  toolDescriptionCache.set(toolName, d)
  return d
}

function maybeInvalidateCache(deferredTools: Tool[]): void {
  const currentKey = getDeferredToolsCacheKey(deferredTools)
  if (cachedDeferredToolNames !== currentKey) {
    toolDescriptionCache.clear()
    cachedDeferredToolNames = currentKey
  }
}

export function clearToolSearchDescriptionCache(): void {
  toolDescriptionCache.clear()
  cachedDeferredToolNames = null
}

// ============================================================
// Tool name parsing (CamelCase + MCP)
// ============================================================

function parseToolName(name: string): {
  parts: string[]
  full: string
  isMcp: boolean
} {
  if (name.startsWith('mcp__')) {
    const withoutPrefix = name.replace(/^mcp__/, '').toLowerCase()
    const parts = withoutPrefix.split('__').flatMap(p => p.split('_'))
    return {
      parts: parts.filter(Boolean),
      full: withoutPrefix.replace(/__/g, ' ').replace(/_/g, ' '),
      isMcp: true,
    }
  }

  const parts = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)

  return { parts, full: parts.join(' '), isMcp: false }
}

// ============================================================
// Keyword search with scoring
// ============================================================

function escapeRegExpChars(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 2026-07 fix (production: "No deferred tools matched excel_read_sheet
 * excel_read_range excel_read_cell") — underscore-aware term ↔ name-parts
 * matching.
 *
 * `parseToolName` splits `excel_read_sheet` into `['excel','read','sheet']`,
 * but query terms were never normalized the same way: a snake_case FULL
 * tool name pasted as a keyword term (`excel_read_sheet`) equals no single
 * part, is no part's substring, and `parsed.full` is space-joined so the
 * underscored string never substring-matches either. Unless the literal
 * name happens to appear in the description, the term scores 0 — so a
 * model that pastes several tool names into one query (exactly what the
 * deferred-guard error nudges it toward) got "No deferred tools matched"
 * for tools that exist and are deferred.
 *
 * Returns 'exact' when the term IS a name part or its underscore/hyphen
 * sub-words are all exact name parts; 'partial' when every sub-word
 * substring-matches some part; null otherwise.
 */
function termNamePartsMatch(
  term: string,
  parts: string[],
): 'exact' | 'partial' | null {
  if (parts.includes(term)) return 'exact'
  const subWords = term.split(/[_-]+/).filter(Boolean)
  if (subWords.length > 1) {
    if (subWords.every((s) => parts.includes(s))) return 'exact'
    if (subWords.every((s) => parts.some((p) => p.includes(s)))) return 'partial'
    return null
  }
  return parts.some((p) => p.includes(term)) ? 'partial' : null
}

function compileTermPatterns(terms: string[]): Map<string, RegExp> {
  const patterns = new Map<string, RegExp>()
  for (const term of terms) {
    if (!patterns.has(term)) {
      patterns.set(term, new RegExp(`\\b${escapeRegExpChars(term)}\\b`))
    }
  }
  return patterns
}

/**
 * Case-insensitive tool lookup that also checks {@link Tool.aliases}.
 *
 * Rationale: AI models routinely call `select:web_search` (snake_case) to
 * reach a tool registered as `WebSearch` (PascalCase). Without alias
 * resolution the lookup silently fails and the model is told "no deferred
 * tools matched" — which it interprets as "tool does not exist".
 */
function findToolByName(list: Tool[], name: string): Tool | undefined {
  const lower = name.toLowerCase()
  return list.find((t) => {
    if (t.name.toLowerCase() === lower) return true
    const aliases = t.aliases
    if (Array.isArray(aliases)) {
      for (const a of aliases) {
        if (typeof a === 'string' && a.toLowerCase() === lower) return true
      }
    }
    return false
  })
}

/**
 * Keyword-based search over deferred tool names and descriptions.
 *
 * Supports:
 * - Exact name match (fast path)
 * - MCP prefix match (mcp__server)
 * - Required terms (+term) and optional terms
 * - Scoring: name parts (10) > searchHint (4) > description (2)
 */
function searchToolsWithKeywords(
  query: string,
  deferredTools: Tool[],
  maxResults: number,
): string[] {
  const queryLower = query.toLowerCase().trim()

  // Fast path: exact tool name match
  const exactMatch = deferredTools.find(t => t.name.toLowerCase() === queryLower)
  if (exactMatch) {
    return [exactMatch.name]
  }

  // MCP prefix match
  if (queryLower.startsWith('mcp__') && queryLower.length > 5) {
    const prefixMatches = deferredTools
      .filter(t => t.name.toLowerCase().startsWith(queryLower))
      .slice(0, maxResults)
      .map(t => t.name)
    if (prefixMatches.length > 0) {
      return prefixMatches
    }
  }

  // Split on whitespace AND comma/semicolon — models pasting several tool
  // names often comma-separate them ("excel_read_sheet, excel_read_range").
  const queryTerms = queryLower.split(/[\s,;]+/).filter(term => term.length > 0)

  // 2026-07 fix — per-token direct name/alias hits. A query listing several
  // FULL tool names ("excel_read_sheet excel_read_range excel_read_cell")
  // used to fall through to keyword scoring where each snake_case token
  // scored 0 (see `termNamePartsMatch`). Resolve each token against the
  // pool's names + aliases first; these hits rank ahead of keyword scores.
  const directNameHits: string[] = []
  for (const term of queryTerms) {
    const hit = findToolByName(deferredTools, term)
    if (hit && !directNameHits.includes(hit.name)) directNameHits.push(hit.name)
  }
  if (directNameHits.length >= queryTerms.length) {
    // Every token resolved to a tool — no keyword pass needed.
    return directNameHits.slice(0, maxResults)
  }

  // Partition into required (+prefixed) and optional terms
  const requiredTerms: string[] = []
  const optionalTerms: string[] = []
  for (const term of queryTerms) {
    if (term.startsWith('+') && term.length > 1) {
      requiredTerms.push(term.slice(1))
    } else {
      optionalTerms.push(term)
    }
  }

  const allScoringTerms =
    requiredTerms.length > 0 ? [...requiredTerms, ...optionalTerms] : queryTerms
  const termPatterns = compileTermPatterns(allScoringTerms)

  // Pre-filter to tools matching ALL required terms
  let candidateTools = deferredTools
  if (requiredTerms.length > 0) {
    candidateTools = deferredTools.filter(tool => {
      const parsed = parseToolName(tool.name)
      const description = getToolDescriptionCached(tool.name).toLowerCase()
      const hintNormalized = tool.searchHint?.toLowerCase() ?? ''
      return requiredTerms.every(term => {
        const pattern = termPatterns.get(term)!
        return (
          termNamePartsMatch(term, parsed.parts) !== null ||
          pattern.test(description) ||
          (hintNormalized && pattern.test(hintNormalized))
        )
      })
    })
  }

  const scored = candidateTools.map(tool => {
    const parsed = parseToolName(tool.name)
    const description = getToolDescriptionCached(tool.name).toLowerCase()
    const hintNormalized = tool.searchHint?.toLowerCase() ?? ''

    let score = 0
    for (const term of allScoringTerms) {
      const pattern = termPatterns.get(term)!

      // Exact part match (high weight for MCP server names, tool name parts).
      // Underscore-aware: a snake_case term whose sub-words are all exact
      // name parts counts as an exact match (see `termNamePartsMatch`).
      const nameMatch = termNamePartsMatch(term, parsed.parts)
      if (nameMatch === 'exact') {
        score += parsed.isMcp ? 12 : 10
      } else if (nameMatch === 'partial') {
        score += parsed.isMcp ? 6 : 5
      }

      // Full name fallback
      if (parsed.full.includes(term) && score === 0) {
        score += 3
      }

      // searchHint match — curated capability phrase, higher signal than description
      if (hintNormalized && pattern.test(hintNormalized)) {
        score += 4
      }

      // Description match — word boundary to avoid false positives
      if (pattern.test(description)) {
        score += 2
      }
    }

    return { name: tool.name, score }
  })

  // Direct name hits rank first (they are what the caller literally asked
  // for); keyword-scored results fill the remaining slots.
  const merged = [...directNameHits]
  for (const item of scored
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)) {
    if (!merged.includes(item.name)) merged.push(item.name)
  }
  return merged.slice(0, maxResults)
}

// ============================================================
// Pending MCP server detection
// ============================================================

/**
 * Get names of MCP servers that are still connecting.
 * Returns undefined if all servers are connected.
 * In this project, MCP servers are tracked in the mcp module.
 */
/** Reserved for “MCP still connecting” messaging; wire to a real status module when available. */
function getPendingMcpServerNames(): string[] | undefined {
  return undefined
}

// ============================================================
// Prompt
// ============================================================

const TOOL_SEARCH_DESCRIPTION =
  'Optional helper: search registered deferred tools by keyword or list names with short descriptions. ' +
  '**Not** a prerequisite for calling tools — Read, Edit, Agent, Bash, MCP tools, etc. are already on the wire; invoke them directly with tool_use. ' +
  'Use ToolSearch only when you want to browse or disambiguate many tools (e.g. MCP), not as a "find before use" gate.'

const TOOL_SEARCH_PROMPT = `Fetches full schema definitions for deferred tools so they can be called.

Deferred tools appear by name in the tool list. Until fetched, only the name is known — there is no parameter schema, so the tool cannot be invoked. This tool takes a query, matches it against the deferred tool list, and returns the matched tools' complete JSONSchema definitions.

Result format: each matched tool appears as one tool_reference-style JSON object (name, description, parameters).

Query modes:
- select:ToolA,ToolB — direct selection (comma-separated tool names)
- Free-text keywords — scored search over deferred tools only (+term requires that word).
`

// ============================================================
// Test helper + tool export
// ============================================================

/**
 * Whether a single tool would match a ToolSearch keyword query (word-boundary semantics).
 */
export function matchesToolSearchQuery(tool: Tool, query: string): boolean {
  const terms = query.toLowerCase().trim().split(/[\s,;]+/).filter(Boolean)
  if (terms.length === 0) return false
  const desc = tool.description.toLowerCase()
  const hint = (tool.searchHint ?? '').toLowerCase()
  const parsed = parseToolName(tool.name)
  const termPatterns = compileTermPatterns(terms)
  return terms.every((term) => {
    const pattern = termPatterns.get(term)!
    return (
      termNamePartsMatch(term, parsed.parts) !== null ||
      pattern.test(desc) ||
      (hint.length > 0 && pattern.test(hint))
    )
  })
}

function parseSelectQuery(query: string): string[] | null {
  const q = query.trim()
  const lower = q.toLowerCase()
  if (!lower.startsWith('select:')) return null
  return q
    .slice('select:'.length)
    .split(/[,;]/g)
    .map((s) => s.trim())
    .filter(Boolean)
}

function buildToolReferenceBlock(tool: Tool): string {
  const props: Record<string, { type: string; description: string; enum?: string[] }> = {}
  const required: string[] = []
  for (const p of tool.inputSchema) {
    props[p.name] = {
      type: p.type,
      description: p.description,
      ...(p.enum ? { enum: p.enum } : {}),
    }
    if (p.required) required.push(p.name)
  }
  const parameters = { type: 'object' as const, properties: props, required }
  return JSON.stringify({
    type: 'tool_reference',
    name: tool.name,
    description: tool.description.split('\n')[0],
    parameters,
  })
}

export const toolSearchTool = buildTool({
  name: TOOL_SEARCH_TOOL_NAME,
  zInputSchema: toolSearchInputZod,
  description: `${TOOL_SEARCH_DESCRIPTION}\n\n${TOOL_SEARCH_PROMPT.trim()}`,
  inputSchema: [
    {
      name: 'query',
      type: 'string',
      description:
        'select:ToolA,ToolB for direct pick, or keywords to search deferred tools (+word = required term)',
      required: true,
    },
    {
      name: 'maxResults',
      type: 'number',
      description: 'Max tools to return (default 12)',
    },
  ],
  isReadOnly: true,
  async call({ query: queryRaw, maxResults: maxResultsRaw }) {
    const query = typeof queryRaw === 'string' ? queryRaw.trim() : ''
    if (!query) {
      return { success: false, error: 'query is required' }
    }
    const maxResults = typeof maxResultsRaw === 'number' && maxResultsRaw > 0 ? maxResultsRaw : 12

    maybeInvalidateCache(getDeferredTools())
    const deferred = getDeferredTools()
    const allTools = toolRegistry.getAll()
    const activeTools = allTools.filter((t) => !deferred.some((d) => d.name === t.name))

    const direct = parseSelectQuery(query)
    let names: string[]
    /**
     * Tools the caller asked for that are registered but NOT in the deferred
     * pool (already active, no schema-loading needed). Computed for BOTH
     * `select:` direct lookup AND keyword-search — the latter was previously
     * missing and caused Zhipu/GLM to "confirm" non-existence after the
     * keyword search came back empty of non-deferred matches (production
     * hallucination #1: "I don't have web search" even when WebSearch is
     * active). We surface already-active matches as a separate section so
     * the model routes directly to them.
     */
    const alreadyActive: string[] = []
    if (direct?.length) {
      names = []
      for (const n of direct) {
        const foundDeferred = findToolByName(deferred, n)
        if (foundDeferred) {
          names.push(foundDeferred.name)
          continue
        }
        const foundActive = findToolByName(allTools, n)
        if (foundActive) alreadyActive.push(foundActive.name)
      }
    } else {
      names = searchToolsWithKeywords(query, deferred, maxResults)
      // ALSO run the same keyword scorer against the ACTIVE pool. Matches
      // here don't need their schema re-sent (already in the model's tool
      // list) but we still cite them so the model knows "yes, exactly what
      // you searched for is already available".
      const activeMatches = searchToolsWithKeywords(
        query,
        activeTools,
        maxResults,
      )
      for (const n of activeMatches) {
        if (!alreadyActive.includes(n)) alreadyActive.push(n)
      }
    }

    const pending = getPendingMcpServerNames()
    const pendingLine =
      pending && pending.length > 0
        ? `\nMCP servers still connecting: ${pending.join(', ')} — retry shortly.`
        : ''

    if (names.length === 0 && alreadyActive.length === 0) {
      return {
        success: true,
        output: `No deferred tools matched "${query}".${pendingLine}`,
      }
    }

    // Format the already-active hint consistently for both `select:` and
    // keyword-search paths. This is the critical line that tells the model
    // "stop concluding the tool doesn't exist — it's right there in your
    // tool list, just call it".
    const activeHint = (() => {
      if (alreadyActive.length === 0) return ''
      const list = alreadyActive.map((n) => `\`${n}\``).join(', ')
      return (
        `Already active in your tool list (no discovery needed — call ` +
        `${alreadyActive.length > 1 ? 'them' : 'it'} directly via tool_use): ${list}`
      )
    })()

    if (names.length === 0) {
      // No deferred matches, but one or more active tools match. Return a
      // short definitive answer so the model doesn't recurse into "maybe I
      // need to search differently".
      return {
        success: true,
        output: `${activeHint}${pendingLine}`,
      }
    }

    const epochBefore = getToolDiscoveryEpoch()
    markToolsDiscovered(names)
    // A newly-discovered deferred tool must reach the next request's wire
    // `tools` array. The agentic loop refreshes that list off the registry's
    // toolset revision, so surface the visibility change there too — otherwise
    // the model only ever sees the schema as ToolSearch *result text* and can
    // never call it (Zhipu/GLM then loops re-discovering it).
    if (getToolDiscoveryEpoch() !== epochBefore) {
      toolRegistry.bumpVisibleToolsetRevision()
    }

    const blocks = names
      .map((n) => toolRegistry.get(n))
      .filter((t): t is Tool => Boolean(t))
      .map((t) => buildToolReferenceBlock(t))

    const parts = [`Discovered ${names.length} tool(s):`, ...blocks]
    if (activeHint) {
      // Append to the same response so the model sees BOTH sets. Without
      // this, models split attention across two ToolSearch calls.
      parts.push('', activeHint)
    }
    return {
      success: true,
      output: parts.join('\n'),
    }
  },
})