/**
 * Coerce agent `tools` / `disallowedTools` from YAML/JSON quirks into `string[]`.
 *
 * Frontmatter often yields inline strings (`tools: Read, Edit`) while the rest of
 * the stack assumes arrays (`.join`, `toolNamesToRegistryKeys`, etc.).
 */
export function normalizeToolsList(value: unknown): string[] | undefined {
  if (value == null) return undefined
  if (Array.isArray(value)) {
    // P0-3: preserve an explicit empty array as a configured empty list.
    // Previously we collapsed `[]` to `undefined`, which made `tools: []`
    // ("disable everything") indistinguishable from "key omitted" → full
    // tool access in resolveAgentTools.
    return value.map((v) => String(v).trim()).filter(Boolean)
  }
  if (typeof value === 'string') {
    const s = value.trim()
    if (!s) return undefined
    if (s === '*') return ['*']
    const parts = s.split(',').map((t) => t.trim()).filter(Boolean)
    return parts.length > 0 ? parts : undefined
  }
  return undefined
}
