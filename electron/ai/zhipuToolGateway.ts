/**
 * Zhipu / GLM Anthropic-compatible gateway quirks.
 *
 * Some gateways reject or silently truncate the `tools` array when individual
 * tool `description` strings are very large (e.g. the built-in Agent tool).
 * Symptom: the model only "sees" a handful of tools (often ToolSearch + MCP).
 */

/** Per-tool description cap before we truncate (chars). */
export const ZHIPU_MAX_TOOL_DESCRIPTION_CHARS = 14_000

export type ToolLikeWithDescription = { description: string }

/**
 * Truncate overly long tool descriptions so the gateway keeps the full tool list.
 */
export function sanitizeToolsForZhipuGateway<T extends ToolLikeWithDescription>(tools: T[]): T[] {
  return tools.map((t) => {
    const d = t.description
    if (typeof d !== 'string' || d.length <= ZHIPU_MAX_TOOL_DESCRIPTION_CHARS) {
      return t
    }
    return {
      ...t,
      description: `${d.slice(0, ZHIPU_MAX_TOOL_DESCRIPTION_CHARS)}\n\n[Truncated by client: Zhipu/GLM gateway tool description limit]`,
    }
  })
}

/**
 * Wire up the Zhipu tool-surface appendix into whatever shape the Anthropic
 * request's `system` field currently has. Pure function so it can be unit-
 * tested without a live HTTP client — the provider path in
 * `electron/ai/providers/anthropic.ts` is the sole caller.
 *
 * Inputs:
 *   - `system`: existing system value (string / TextBlockParam[] / undefined)
 *   - `wireToolNames`: names of tools actually sent in `requestParams.tools`
 *
 * Output: the same type shape, with the appendix concatenated. When no names
 * are provided, the original system value is returned unchanged.
 */
export function applyZhipuToolSurfaceToSystem<
  T extends string | Array<{ type?: string; text?: string }> | undefined,
>(system: T, wireToolNames: string[]): T {
  const appendix = buildZhipuToolSurfaceSystemAppendix(wireToolNames)
  if (!appendix) return system
  if (typeof system === 'string') {
    return (system + appendix) as T
  }
  if (Array.isArray(system)) {
    return [...system, { type: 'text', text: appendix.trimStart() }] as T
  }
  return appendix.trimStart() as T
}

/**
 * System-prompt appendix that lists, verbatim, the tool names on the wire.
 *
 * Why this exists: GLM / Zhipu models consistently under-report their own
 * tool surface — they will claim "我没有 Edit 工具" or "请用 ToolSearch 查找"
 * even when Edit, Agent, WebSearch, and MCP bridges were sent on the very
 * same request. The behavior is stable enough that listing the tools again
 * in plain text — with an explicit directive against the hallucination —
 * consistently eliminates it.
 *
 * Rules encoded:
 *   1. The listed names ARE available this turn. Do not deny them.
 *   2. Call them by `tool_use` directly. Do not route through ToolSearch
 *      (which is only for *deferred* tools; everything here is already
 *      active).
 *   3. Tool name matching is case-sensitive — use the names exactly as
 *      shown (GLM tends to lowercase them, which silently fails).
 */
export function buildZhipuToolSurfaceSystemAppendix(toolNames: string[]): string {
  const names = [...new Set(toolNames.map((n) => String(n).trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' }),
  )
  if (names.length === 0) return ''
  return (
    '\n\n# Tool surface (Zhipu / GLM)\n' +
    'Every tool listed below is already active on THIS request — you can call ' +
    'any of them via `tool_use` directly. You do NOT need `ToolSearch` to ' +
    '"discover" them; ToolSearch is only for deferred tools (items not on ' +
    'this list). Do not claim you lack these tools, and use the names ' +
    'verbatim (case-sensitive):\n' +
    names.join(', ')
  )
}
