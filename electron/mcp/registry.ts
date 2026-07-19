/**
 * Bridge MCP server tools into the unified Tool Registry.
 *
 * MCP tools are prefixed as "mcp__{serverName}__{toolName}" to avoid
 * name collisions with built-in tools. When the agentic loop calls
 * an MCP tool, the bridge routes it to the correct MCP server.
 */

import type { Tool, ToolParameter } from '../tools/types'
import { isMcpServerToolIdWorkspaceMutating } from '../tools/builtinToolAliases'
import { jsonSchemaToZod } from './jsonSchemaToZod'
import type { MCPClientManager } from './client'
import { sanitizeUntrustedText, summarizeFindings } from '../security/sanitizeUntrustedText'

/**
 * Tool row from `MCPClientManager.getAllTools()` / `listTools` (looser than SDK `Tool` —
 * `inputSchema` may be missing or an untyped object).
 */
type McpListedTool = {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

/**
 * Recursively convert a single JSON Schema property to a {@link ToolParameter},
 * preserving nested `items` (for arrays) and `properties` (for objects) so the
 * LLM receives the full structure — without this, the model sees `edits` as
 * bare `{ type: "array" }` and has no way to know the element shape, which
 * causes `-32602` (path/edits undefined) when it sends empty `{}`.
 */
/**
 * Recursively strip invisible-Unicode prompt-injection payloads from every
 * `description` field inside a JSON Schema subtree. MCP servers ship their
 * input schemas verbatim into the model's tool definitions; an attacker
 * server can embed hidden instructions in any `description` (top-level or
 * nested under `items` / `properties`). Mutates the value to avoid an
 * extra deep-clone allocation — input was already deep-cloned by the
 * MCP client wrapper before reaching us.
 */
function sanitizeSchemaDescriptions(node: unknown): void {
  if (!node || typeof node !== 'object') return
  const obj = node as Record<string, unknown>
  if (typeof obj.description === 'string') {
    const r = sanitizeUntrustedText(obj.description)
    if (r.totalStripped > 0) obj.description = r.cleaned
  }
  // `properties` is `{ name: SubSchema }`. Recurse into every value.
  const props = obj.properties
  if (props && typeof props === 'object' && !Array.isArray(props)) {
    for (const k of Object.keys(props as Record<string, unknown>)) {
      sanitizeSchemaDescriptions((props as Record<string, unknown>)[k])
    }
  }
  // `items` is a single SubSchema (we don't bother with array-of-schemas).
  if (obj.items && typeof obj.items === 'object' && !Array.isArray(obj.items)) {
    sanitizeSchemaDescriptions(obj.items)
  }
}

function jsonSchemaPropToToolParameter(
  name: string,
  prop: Record<string, unknown>,
  required: Set<string>,
): ToolParameter {
  const rawType = prop.type as string | undefined
  const rawDescription = (prop.description as string) || ''
  const cleanedDescription = sanitizeUntrustedText(rawDescription).cleaned
  const param: ToolParameter = {
    name,
    type: (rawType === 'integer' ? 'number' : rawType) as ToolParameter['type'],
    description: cleanedDescription,
    required: required.has(name),
    enum: prop.enum as string[] | undefined,
  }

  if ('default' in prop && prop.default !== undefined) {
    param.default = prop.default
  }

  // Preserve `items` for array parameters so the LLM knows the element shape.
  const items = prop.items
  if (items && typeof items === 'object' && !Array.isArray(items)) {
    sanitizeSchemaDescriptions(items)
    param.items = items as Record<string, unknown>
  }

  // Preserve `properties` for object parameters (recursive).
  const props = prop.properties
  if (props && typeof props === 'object' && !Array.isArray(props)) {
    for (const k of Object.keys(props as Record<string, unknown>)) {
      sanitizeSchemaDescriptions((props as Record<string, unknown>)[k])
    }
    param.properties = props as Record<string, unknown>
  }

  return param
}

function mcpToolToParameters(schema: McpListedTool['inputSchema']): ToolParameter[] {
  if (!schema || typeof schema !== 'object') return []
  const s = schema as { properties?: Record<string, unknown>; required?: string[] }
  if (!s.properties || typeof s.properties !== 'object') return []

  const params: ToolParameter[] = []
  const required = new Set(s.required || [])

  for (const [name, prop] of Object.entries(s.properties)) {
    if (!prop || typeof prop !== 'object') continue
    params.push(jsonSchemaPropToToolParameter(name, prop as Record<string, unknown>, required))
  }

  return params
}

/** upstream MCPTool — inline result budget before spill (报告 §8.2). */
export const OPENCLAUDE_MCP_TOOL_MAX_RESULT_CHARS = 100_000

function mcpSchemaIsOpenEnded(schema: McpListedTool['inputSchema']): boolean {
  if (!schema || typeof schema !== 'object') return true
  const s = schema as { properties?: unknown }
  if (!s.properties || typeof s.properties !== 'object') return true
  return Object.keys(s.properties as object).length === 0
}

/**
 * Encode a server name for use inside an `mcp__{server}__{tool}` registry
 * key. The registry round-trip uses `indexOf('__')` (see
 * `getMcpBridgedToolSuffix`) — so any `__` in the raw server name would
 * make the parse ambiguous (server `a__b` + tool `c` ↔ server `a` + tool
 * `b__c`). Replace any `__` runs with a single `_` at encode time; the
 * original server name is still tracked in {@link mcpTool}'s closure for
 * runtime `callTool` (audit Bug A17).
 */
export function encodeMcpServerNameForRegistry(serverName: string): string {
  return serverName.replace(/__+/g, '_')
}

/**
 * Flatten a normalized MCP response into a single text string the tool
 * result expects. Non-text blocks (image / resource / reference / etc.)
 * get summarized rather than silently dropped — previously they produced
 * the misleading "Tool completed successfully." message with no useful
 * information (audit Bug A3).
 */
function flattenMcpContentBlocks(
  blocks: Array<{ type: string; text?: string; data?: unknown }> | undefined,
): string {
  if (!blocks || blocks.length === 0) return ''
  const parts: string[] = []
  for (const b of blocks) {
    // Widen the block shape once so optional sibling fields
    // (`mimeType`, `uri`, etc.) that MCP servers add beyond the normalized
    // surface can be read safely — they're declared as `Record<string,
    // unknown>` at the wire level.
    const raw = b as Record<string, unknown>
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text)
    } else if (b.type === 'image') {
      // Don't dump base64 into the transcript; summarise.
      const d = raw.data
      const mime = typeof raw.mimeType === 'string' ? raw.mimeType : 'image'
      const sizeHint =
        typeof d === 'string' ? ` (${d.length} base64 chars)` : ''
      parts.push(`[MCP image block: ${mime}${sizeHint}]`)
    } else if (b.type === 'resource' || b.type === 'resource_link') {
      const uri = typeof raw.uri === 'string' ? raw.uri : ''
      parts.push(`[MCP resource block${uri ? `: ${uri}` : ''}]`)
    } else {
      // Unknown block type — surface the data shape so the model at
      // least knows something was returned.
      const preview = b.text
        ? b.text.slice(0, 200)
        : b.data !== undefined
          ? JSON.stringify(b.data).slice(0, 200)
          : ''
      parts.push(`[MCP ${b.type} block${preview ? `: ${preview}` : ''}]`)
    }
  }
  return parts.join('\n')
}

/**
 * Returns true when the string contains any of the invisible-Unicode
 * categories that have NO legitimate use in a tool-identifier context:
 * Tag chars, Bidi overrides/isolates, zero-width, BOM. Used to gate
 * MCP tool **names** — names with these chars are almost certainly a
 * prompt-injection attempt (or a buggy server) and we reject rather
 * than try to clean, because cleaning would create a mismatch between
 * what the model sees and what the server expects on call-back.
 */
function mcpIdentifierHasHiddenUnicode(s: string): boolean {
  return sanitizeUntrustedText(s).totalStripped > 0
}

function mcpToolToTool(serverName: string, mcpTool: McpListedTool, clientManager: MCPClientManager): Tool | null {
  // Reject tool names with invisible Unicode — see `mcpIdentifierHasHiddenUnicode`.
  if (mcpIdentifierHasHiddenUnicode(mcpTool.name)) {
    console.warn(
      `[mcp] Rejecting tool "${serverName}/${mcpTool.name}" — name contains invisible Unicode (likely prompt-injection attempt). Tool not registered.`,
    )
    return null
  }

  const encodedServer = encodeMcpServerNameForRegistry(serverName)
  const fullName = `mcp__${encodedServer}__${mcpTool.name}`

  const mutating = isMcpServerToolIdWorkspaceMutating(mcpTool.name)
  const openEnded = mcpSchemaIsOpenEnded(mcpTool.inputSchema)
  // upstream alignment extra-2: auto-derive `zInputSchema` from the
  // server-advertised JSON Schema so the agentic loop's
  // `validateToolZodInput` gate catches typo'd / wrong-type inputs before
  // the call is forwarded. Open-ended schemas (no properties) skip this —
  // anything goes for those tools by definition. See `jsonSchemaToZod` for
  // the supported subset and the loose `z.unknown()` fallback policy.
  const zInputSchema = openEnded ? undefined : jsonSchemaToZod(mcpTool.inputSchema)

  // Defense-in-depth: MCP servers ship their tool description verbatim into
  // the model's tool catalog. A malicious server can embed hidden Tag /
  // Bidi / ZW chars in the description and the model will obey them. Strip
  // before composition. Tool NAMES are already constrained to ASCII via
  // `encodeMcpServerNameForRegistry` (which only handles `__` runs) but
  // could still carry exotic chars from `mcpTool.name` — sanitize there too
  // and log; if anything is stripped the tool name changes, which would
  // break execution, so we surface the warning loudly and use the cleaned
  // form on both definition AND dispatch (cleaned name is what the model
  // is told, so call-back via `tool_use.name` will use the cleaned form
  // and `clientManager.callTool` receives the cleaned `mcpTool.name` which
  // matches what the server advertises — no mismatch because we only
  // strip chars the server should not have shipped to begin with).
  const sanitizedDescription = sanitizeUntrustedText(mcpTool.description || '')
  if (sanitizedDescription.findings.length > 0) {
    console.warn(
      `[mcp] Stripped ${sanitizedDescription.totalStripped} invisible Unicode char(s) from "${serverName}/${mcpTool.name}" tool description: ${summarizeFindings(sanitizedDescription.findings)}`,
    )
  }
  return {
    name: fullName,
    description: `[MCP:${serverName}] ${sanitizedDescription.cleaned}`,
    inputSchema: openEnded ? [] : mcpToolToParameters(mcpTool.inputSchema),
    zInputSchema,
    openEndedJsonSchema: openEnded,
    isMcpBridge: true,
    maxResultChars: OPENCLAUDE_MCP_TOOL_MAX_RESULT_CHARS,
    isReadOnly: !mutating,
    isConcurrencySafe: !mutating,
    // MCP bridge tools are outbound calls to an external server process, so
    // they consume the shared network resource lane by default. Replaces the
    // fragile `name.startsWith('mcp__')` heuristic that used to live in
    // `quota.ts`. A genuinely local-compute MCP tool can be special-cased to
    // `networkBound: false` in the future if a server advertises that hint.
    networkBound: true,
    execute: async (input, ctx) => {
      try {
        // Always use the original server name for the actual MCP call
        // — the encoding above is only for the registry key.
        //
        // BUG-M4 fix: race the call against a wall-clock timeout so a
        // hung MCP server does not pin an agent forever. Override via
        // `POLE_MCP_TOOL_TIMEOUT_MS` (default 120s — enough headroom for
        // long-running search / fetch tools, short enough to detect
        // truly stuck servers).
        //
        // P1-4 (audit): also race against `ctx.abortSignal` so a
        // user-initiated stop / session abort / kill-all collapses the
        // pending MCP call immediately instead of waiting the full
        // `timeoutMs`. Previously the merged abort signal could fire
        // upstream but the MCP `callPromise` kept hanging until the
        // wall-clock timer expired (or the server replied), wasting up
        // to 120s on each canceled tool call.
        const timeoutMs = Math.max(
          5_000,
          Number(process.env.POLE_MCP_TOOL_TIMEOUT_MS ?? 120_000),
        )
        const callPromise = clientManager.callTool(serverName, mcpTool.name, input)
        let timer: ReturnType<typeof setTimeout> | undefined
        const timeoutPromise = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(
              new Error(
                `MCP tool ${mcpTool.name} on ${serverName} timed out after ${timeoutMs}ms`,
              ),
            )
          }, timeoutMs)
        })
        // Abort race — only constructed when ctx.abortSignal is present
        // (legacy direct registry callers without ctx still get the
        // wall-clock-only behaviour).
        let abortListener: (() => void) | undefined
        const abortPromise = ctx?.abortSignal
          ? new Promise<never>((_resolve, reject) => {
              const signal = ctx.abortSignal
              if (signal.aborted) {
                reject(new Error(`MCP tool ${mcpTool.name} aborted before dispatch`))
                return
              }
              abortListener = () => {
                reject(new Error(`MCP tool ${mcpTool.name} aborted on signal`))
              }
              signal.addEventListener('abort', abortListener, { once: true })
            })
          : null
        let result
        try {
          const racers: Array<Promise<unknown>> = [callPromise, timeoutPromise]
          if (abortPromise) racers.push(abortPromise)
          result = (await Promise.race(racers)) as Awaited<typeof callPromise>
        } finally {
          if (timer) clearTimeout(timer)
          if (abortListener && ctx?.abortSignal) {
            try { ctx.abortSignal.removeEventListener('abort', abortListener) } catch { /* noop */ }
          }
        }

        const flattenedRaw = flattenMcpContentBlocks(result.content)

        // Defense-in-depth: a third-party MCP server is untrusted code that
        // can return ANY text into the agent's tool_result stream — the
        // canonical attack surface for "indirect prompt injection". Strip
        // the high-risk invisible Unicode subset (Tag chars, Bidi
        // override/isolate, zero-width, BOM, Mongolian Vowel Separator)
        // before the model reads it. Legitimate MCP output (code, docs,
        // search results, even emoji ❤️ via VS-16) is unaffected because
        // those code-points are not in our strip list. See
        // `electron/security/sanitizeUntrustedText.ts` for threat model.
        const sanitized = sanitizeUntrustedText(flattenedRaw)
        if (sanitized.findings.length > 0) {
          console.warn(
            `[mcp] Stripped ${sanitized.totalStripped} invisible Unicode char(s) from "${serverName}/${mcpTool.name}" tool_result: ${summarizeFindings(sanitized.findings)}`,
          )
        }
        const flattened = sanitized.cleaned

        // BUG-M6 fix: surface the upstream `isError` flag so the agent
        // can react to MCP-side failure conditions instead of treating
        // them as silent successes.
        if (result.isError) {
          return { success: false, error: flattened || 'MCP tool returned an error' }
        }

        return { success: true, output: flattened || 'Tool completed successfully.' }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { success: false, error: `MCP error: ${message}` }
      }
    },
  }
}

/** Per-server tool name list, populated by syncMCPTools for removeServerTools. */
const _toolsByServer = new Map<string, string[]>()

/**
 * Sync all MCP server tools into the tool registry.
 * Removes stale MCP tools and adds new ones.
 */
export function syncMCPTools(
  clientManager: MCPClientManager,
  registerFn: (tool: Tool) => void,
  unregisterFn: (name: string) => boolean
): number {
  void unregisterFn
  const allMCPTools = clientManager.getAllTools()
  let addedCount = 0

  // Collect current MCP tool names
  const currentNames = new Set<string>()

  for (const { serverName, tool } of allMCPTools) {
    // Build the bridged Tool first — it returns null when the source
    // tool name carries invisible Unicode (rejected as a likely
    // prompt-injection attempt). Skip the entry entirely in that case
    // so neither registration nor name-tracking sees it.
    const bridged = mcpToolToTool(serverName, tool, clientManager)
    if (!bridged) continue

    // BUG-M1 fix: registration uses `mcp__<encoded>__<tool>` (see
    // `mcpToolToTool`), so tracking MUST mirror the same encoded form.
    // Previously we tracked the raw `mcp__<serverName>__<tool>` name,
    // which diverged whenever `serverName` contained `__`. The mismatch
    // caused (a) `removeServerTools` to look up under one key while the
    // registry stored under another (zombie tools left behind), and
    // (b) `currentNames` membership checks to silently miss entries.
    const encodedServer = encodeMcpServerNameForRegistry(serverName)
    const fullName = `mcp__${encodedServer}__${tool.name}`
    currentNames.add(fullName)

    registerFn(bridged)
    addedCount++

    // MCP-01: track tool names per server for removeServerTools.
    // The map is keyed by raw serverName (operator surface) but values
    // hold the *encoded* tool name so unregisterFn finds the registered
    // entry.
    if (!_toolsByServer.has(serverName)) {
      _toolsByServer.set(serverName, [])
    }
    _toolsByServer.get(serverName)!.push(fullName)
  }

  // Note: We don't unregister tools that aren't in the current set,
  // because the caller handles that. The registry is the source of truth.

  return addedCount
}

/**
 * Remove all MCP tools for a specific server from the registry.
 */
/**
 * Remove all MCP tools for a specific server from the registry.
 *
 * Uses the per-server tool name list populated by {@link syncMCPTools}
 * to find and unregister all tools previously registered for the server.
 */
export function removeServerTools(
  serverName: string,
  unregisterFn: (name: string) => boolean
): void {
  const names = _toolsByServer.get(serverName) || []
  for (const name of names) {
    unregisterFn(name)
  }
  _toolsByServer.delete(serverName)
}

/**
 * Build the prefix used for MCP tool names.
 */
export function mcpToolPrefix(serverName: string): string {
  return `mcp__${serverName}__`
}
