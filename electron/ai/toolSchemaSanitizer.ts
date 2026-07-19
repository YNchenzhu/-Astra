/**
 * Unified tool `input_schema` sanitizer.
 *
 * Before this module existed, schema cleanup was scattered across:
 *   - `providers/schemaUtils.ts#ensureArrayItemsSchema`
 *   - `transformer/claudeToGemini.ts#cleanSchemaForGemini`
 *   - `transformer/claudeToOpenAI2.ts#ensureArrayItemsSchema` (inline copy)
 *   - `transformer/claudeToOpenAI.ts` (nothing at all, a known bug)
 *
 * Consolidating them here lets every wire pick a policy by name
 * (`sanitizeToolSchemaForWire(schema, wire)`) instead of each caller
 * reimplementing a subset of the cleanup.
 *
 * Cleanup policies:
 *
 * | wire              | ensure array items | strip metadata | strip combinators | strip additionalProperties |
 * |-------------------|-------------------:|---------------:|------------------:|---------------------------:|
 * | anthropic         |                yes |             no |                no |                         no |
 * | anthropic-compat  |                yes |            yes |               yes |                        yes |
 * | openai-native     |                yes |             no |                no |                         no |
 * | openai-compat     |                yes |            yes |               yes |                        yes |
 * | openai2-native    |                yes |             no |                no |                         no |
 * | openai2-compat    |                yes |            yes |               yes |                        yes |
 * | gemini-native     |                yes |            yes |               yes |                        yes |
 * | gemini-compat     |                yes |            yes |               yes |                        yes |
 *
 * "metadata" = `$schema`, `$id`, `$ref`, `$defs`, `definitions`, `title`,
 * `examples`, `default`, `const`, `format`. Most strict subset gateways
 * (especially non-OpenAI Chinese proxies and Google-facing Gemini) choke on
 * these. Keeping them for Anthropic official + OpenAI native preserves the
 * richer validation those endpoints can leverage.
 *
 * "combinators" = `oneOf`, `anyOf`, `allOf`, `not`. Gemini's FunctionDeclaration
 * parser rejects these entirely; many Chinese Anthropic-compat gateways do too.
 *
 * "additionalProperties" — Anthropic official accepts it (and MCP bridged tools
 * rely on `additionalProperties: true` for their open-ended inputs). Gemini
 * explicitly rejects it. Chinese Anthropic-compat gateways vary but most
 * prefer it stripped.
 *
 * `ensureArrayItemsSchema` is always on — every wire reliably errors when an
 * `array` property lacks an `items` subschema, and defaulting to string items
 * is a safer fallback than a 400.
 */

import type { WireFormat } from './providerQuirks'

type JsonSchemaLike = Record<string, unknown>

// ─────────────────────────────────────────────────────────────────────────
// Policy matrix
// ─────────────────────────────────────────────────────────────────────────

interface SchemaPolicy {
  stripMetadata: boolean
  stripCombinators: boolean
  stripAdditionalProperties: boolean
  /** Gemini specifically: remove stray `items` on non-array types. */
  scrubStrayItemsOnObjects: boolean
}

const POLICIES: Record<WireFormat, SchemaPolicy> = {
  anthropic: {
    stripMetadata: false,
    stripCombinators: false,
    stripAdditionalProperties: false,
    scrubStrayItemsOnObjects: false,
  },
  'anthropic-compat': {
    stripMetadata: true,
    stripCombinators: true,
    stripAdditionalProperties: true,
    scrubStrayItemsOnObjects: true,
  },
  'openai-native': {
    stripMetadata: false,
    stripCombinators: false,
    stripAdditionalProperties: false,
    scrubStrayItemsOnObjects: false,
  },
  'openai-compat': {
    stripMetadata: true,
    stripCombinators: true,
    stripAdditionalProperties: true,
    scrubStrayItemsOnObjects: true,
  },
  'openai2-native': {
    stripMetadata: false,
    stripCombinators: false,
    stripAdditionalProperties: false,
    scrubStrayItemsOnObjects: false,
  },
  'openai2-compat': {
    stripMetadata: true,
    stripCombinators: true,
    stripAdditionalProperties: true,
    scrubStrayItemsOnObjects: true,
  },
  'gemini-native': {
    stripMetadata: true,
    stripCombinators: true,
    stripAdditionalProperties: true,
    scrubStrayItemsOnObjects: true,
  },
  'gemini-compat': {
    stripMetadata: true,
    stripCombinators: true,
    stripAdditionalProperties: true,
    scrubStrayItemsOnObjects: true,
  },
}

const METADATA_KEYS = [
  '$schema',
  '$id',
  '$ref',
  '$defs',
  'definitions',
  'examples',
  'default',
  'const',
  'format',
  'title',
] as const

const COMBINATOR_KEYS = ['oneOf', 'anyOf', 'allOf', 'not'] as const

// ─────────────────────────────────────────────────────────────────────────
// Core walker
// ─────────────────────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is JsonSchemaLike {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/**
 * Recursively sanitize a JSON schema per the policy.
 *
 * Always returns a cloned object — the caller may mutate it freely.
 */
function sanitizeNode(node: unknown, policy: SchemaPolicy): unknown {
  if (!isPlainObject(node)) return node

  const out: JsonSchemaLike = { ...node }

  if (policy.stripMetadata) {
    for (const k of METADATA_KEYS) delete out[k]
  }
  if (policy.stripCombinators) {
    for (const k of COMBINATOR_KEYS) delete out[k]
  }
  if (policy.stripAdditionalProperties) {
    delete out.additionalProperties
  }
  if (policy.scrubStrayItemsOnObjects) {
    if (out.type === 'object' && 'items' in out) {
      delete out.items
    }
  }

  // Recurse into array `items`. Default to `{ type: 'string' }` when missing.
  if (out.type === 'array') {
    if (isPlainObject(out.items)) {
      out.items = sanitizeNode(out.items, policy)
    } else if (Array.isArray(out.items)) {
      out.items = (out.items as unknown[]).map((it) => sanitizeNode(it, policy))
    } else {
      out.items = { type: 'string' }
    }
  } else if (!policy.scrubStrayItemsOnObjects && isPlainObject(out.items)) {
    // Some schemas (rare) carry `items` on non-array nodes in full-mode wires.
    out.items = sanitizeNode(out.items, policy)
  }

  // Recurse into `properties`.
  if (isPlainObject(out.properties)) {
    const nextProps: JsonSchemaLike = {}
    for (const [k, v] of Object.entries(out.properties)) {
      nextProps[k] = sanitizeNode(v, policy)
    }
    out.properties = nextProps
  }

  // Recurse into `patternProperties`.
  if (isPlainObject(out.patternProperties)) {
    const next: JsonSchemaLike = {}
    for (const [k, v] of Object.entries(out.patternProperties)) {
      next[k] = sanitizeNode(v, policy)
    }
    out.patternProperties = next
  }

  // Recurse into `additionalProperties` when it's a schema (and we keep it).
  if (!policy.stripAdditionalProperties && isPlainObject(out.additionalProperties)) {
    out.additionalProperties = sanitizeNode(out.additionalProperties, policy)
  }

  // Recurse into combinators when we keep them.
  if (!policy.stripCombinators) {
    for (const k of COMBINATOR_KEYS) {
      const v = out[k]
      if (Array.isArray(v)) {
        out[k] = (v as unknown[]).map((entry) => sanitizeNode(entry, policy))
      } else if (isPlainObject(v)) {
        out[k] = sanitizeNode(v, policy)
      }
    }
  }

  return out
}

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

/**
 * Sanitize a single tool `input_schema` for the given wire format.
 *
 * This is the canonical cleanup function for every transformer / native SDK
 * call site. If you find yourself writing a bespoke walk over a tool schema,
 * extend this function instead.
 */
export function sanitizeToolSchemaForWire(
  schema: JsonSchemaLike | undefined,
  wire: WireFormat,
): JsonSchemaLike {
  const fallback: JsonSchemaLike = { type: 'object', properties: {} }
  const policy = POLICIES[wire]
  const input = schema && isPlainObject(schema) ? schema : fallback
  const out = sanitizeNode(input, policy) as JsonSchemaLike

  // Ensure the top-level object has the mandatory shape. Every wire rejects a
  // top-level schema without `type: 'object'`.
  if (out.type == null) out.type = 'object'
  if (out.type === 'object' && !isPlainObject(out.properties)) {
    out.properties = {}
  }
  return out
}

/**
 * Truncate an overly long tool description, appending a brief notice so the
 * model / logs show the truncation was intentional.
 */
export function capToolDescription(
  description: string,
  maxChars: number | undefined,
): string {
  if (!maxChars || !Number.isFinite(maxChars) || maxChars <= 0) return description
  if (typeof description !== 'string') return description
  if (description.length <= maxChars) return description
  return `${description.slice(0, maxChars)}\n\n[Truncated by client: gateway tool description limit]`
}

/**
 * Convenience: sanitize an array of Anthropic-shape tool definitions for a
 * given wire (schema + optional description cap). Returns cloned objects.
 */
export function sanitizeToolsForWire<
  T extends { name: string; description: string; input_schema: JsonSchemaLike },
>(tools: T[], wire: WireFormat, maxToolDescriptionChars?: number): T[] {
  return tools.map((t) => ({
    ...t,
    description: capToolDescription(t.description ?? '', maxToolDescriptionChars),
    input_schema: sanitizeToolSchemaForWire(t.input_schema, wire),
  }))
}

// ─────────────────────────────────────────────────────────────────────────
// Advanced tool use — Examples + PTC sanitization (2025-11 betas)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Maximum Anthropic-documented `input_examples` entries per tool.
 *
 * @see https://www.anthropic.com/engineering/advanced-tool-use
 */
export const ANTHROPIC_MAX_TOOL_EXAMPLES = 20

/**
 * Render a Tool Use Examples array into a compact markdown block for
 * injection into a tool description on wires that don't accept the native
 * `input_examples` field.
 *
 * We keep this formatter stable across wires so the model sees the same
 * shape regardless of provider: numbered list of JSON snippets under a
 * `### Usage examples` heading. Each value is JSON-stringified with 2-space
 * indent so keys stay aligned and arrays render readably.
 *
 * Invalid / non-object entries are skipped silently (the caller should have
 * validated them already, but we stay robust).
 */
export function renderExamplesAsDescriptionAppendix(
  examples: ReadonlyArray<Record<string, unknown>> | undefined,
): string {
  if (!examples || examples.length === 0) return ''
  const lines: string[] = []
  lines.push('### Usage examples')
  lines.push('')
  lines.push(
    'Each example below is a valid invocation of this tool. Match parameter ' +
      'conventions (formats, ID patterns, field combinations) shown here.',
  )
  lines.push('')
  const capped = examples.slice(0, ANTHROPIC_MAX_TOOL_EXAMPLES)
  capped.forEach((ex, idx) => {
    let pretty: string
    try {
      pretty = JSON.stringify(ex, null, 2)
    } catch {
      // Circular or non-JSON-safe → emit a terse fallback.
      pretty = '{ /* (non-serializable example — skipped) */ }'
    }
    lines.push(`Example ${idx + 1}:`)
    lines.push('```json')
    lines.push(pretty)
    lines.push('```')
    lines.push('')
  })
  return lines.join('\n').trimEnd()
}

/**
 * Append an examples block to a tool description, separating it from the
 * existing body with a blank line. No-op when `examples` is empty.
 */
export function appendExamplesToDescription(
  description: string,
  examples: ReadonlyArray<Record<string, unknown>> | undefined,
): string {
  const block = renderExamplesAsDescriptionAppendix(examples)
  if (!block) return description
  const base = (description ?? '').trimEnd()
  if (!base) return block
  return `${base}\n\n${block}`
}

/** How to materialize Tool Use Examples onto the wire for a given wire. */
export type ToolExamplesWirePolicy =
  /** Emit `input_examples` field natively; omit description fallback. */
  | 'native'
  /** Strip `input_examples`; fold examples into description. */
  | 'description-fallback'
  /** Strip `input_examples`; do not inject into description either. */
  | 'drop'

/**
 * Resolve wire-level policy for examples.
 *
 * We always prefer description-fallback over drop because the fallback is a
 * prompt-level improvement that benefits every provider. Callers may still
 * pass `'drop'` explicitly when they want to strip examples entirely (e.g.
 * for token-budget-constrained gateways).
 */
export function defaultExamplesPolicyForWire(
  wire: WireFormat,
  nativeAllowed: boolean,
): ToolExamplesWirePolicy {
  if (nativeAllowed && wire === 'anthropic') return 'native'
  return 'description-fallback'
}

/** PTC artifacts that must be stripped when the wire doesn't support PTC. */
const PTC_TOOL_KEYS = ['allowed_callers'] as const

/**
 * Post-process a wire tool definition after {@link sanitizeToolsForWire}: fold
 * examples into description / drop `input_examples` and `allowed_callers`
 * according to the resolved policies.
 */
export function applyAdvancedToolUsePolicies<
  T extends {
    name: string
    description: string
    input_schema: JsonSchemaLike
    input_examples?: Array<Record<string, unknown>>
    allowed_callers?: string[]
  },
>(
  tool: T,
  opts: {
    examples: ToolExamplesWirePolicy
    ptcEnabled: boolean
  },
): T {
  const out: T = { ...tool }

  // Examples.
  if (opts.examples === 'native') {
    if (Array.isArray(out.input_examples) && out.input_examples.length > 0) {
      // Cap to the documented 20.
      if (out.input_examples.length > ANTHROPIC_MAX_TOOL_EXAMPLES) {
        out.input_examples = out.input_examples.slice(0, ANTHROPIC_MAX_TOOL_EXAMPLES)
      }
    } else if (out.input_examples !== undefined) {
      delete out.input_examples
    }
  } else {
    const examples = out.input_examples
    if (opts.examples === 'description-fallback') {
      out.description = appendExamplesToDescription(out.description, examples)
    }
    if (out.input_examples !== undefined) delete out.input_examples
  }

  // PTC — strip `allowed_callers` on non-PTC wires.
  if (!opts.ptcEnabled) {
    for (const k of PTC_TOOL_KEYS) {
      if (k in out) delete (out as Record<string, unknown>)[k]
    }
  } else if (Array.isArray(out.allowed_callers) && out.allowed_callers.length === 0) {
    delete out.allowed_callers
  }

  return out
}

/**
 * True when the tool array contains at least one tool with non-empty
 * `input_examples`. Used by the request builder to decide whether to attach
 * `anthropic-beta: tool-examples-2025-10-29`.
 */
export function toolsContainInputExamples<
  T extends { input_examples?: Array<Record<string, unknown>> },
>(tools: ReadonlyArray<T>): boolean {
  for (const t of tools) {
    if (Array.isArray(t.input_examples) && t.input_examples.length > 0) return true
  }
  return false
}

/**
 * True when the tool array contains at least one tool with a non-empty
 * `allowed_callers` array including a PTC caller. Used by the request
 * builder to decide whether to prepend the `code_execution_20260120`
 * server-tool entry (and apply PTC shape guards).
 */
export function toolsRequirePtcServerTool<T extends { allowed_callers?: string[] }>(
  tools: ReadonlyArray<T>,
): boolean {
  for (const t of tools) {
    if (!Array.isArray(t.allowed_callers)) continue
    if (t.allowed_callers.some((c) => c === 'code_execution_20260120')) return true
  }
  return false
}

/**
 * Full transform: run the JSON-schema sanitizer, apply the wire description
 * cap, then fold examples / drop PTC fields per `opts`. Single entry point
 * for provider wire builders.
 */
export function prepareToolsForWire<
  T extends {
    name: string
    description: string
    input_schema: JsonSchemaLike
    input_examples?: Array<Record<string, unknown>>
    allowed_callers?: string[]
  },
>(
  tools: ReadonlyArray<T>,
  wire: WireFormat,
  opts: {
    maxToolDescriptionChars?: number
    examples: ToolExamplesWirePolicy
    ptcEnabled: boolean
  },
): T[] {
  const sanitized = sanitizeToolsForWire(
    tools as T[],
    wire,
    opts.maxToolDescriptionChars,
  )
  return sanitized.map((t) =>
    applyAdvancedToolUsePolicies(t, {
      examples: opts.examples,
      ptcEnabled: opts.ptcEnabled,
    }),
  )
}
