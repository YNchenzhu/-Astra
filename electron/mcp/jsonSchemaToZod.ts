/**
 * upstream alignment extra-2 — convert an MCP server's JSON Schema for a tool's
 * `inputSchema` into a Zod schema usable as {@link Tool.zInputSchema}.
 *
 * Why
 *   The agentic loop runs `validateToolZodInput(tool, input)` before dispatch
 *   (see `electron/ai/toolInputValidate.ts`). For built-in tools the Zod
 *   schema is hand-written in `toolInputZod.ts` so bad inputs get a friendly
 *   "expected string, received number"-style Zod error before the tool runs.
 *
 *   MCP bridged tools previously had **no** `zInputSchema`, so any input the
 *   model produced was forwarded raw to the MCP server. Bad inputs would only
 *   surface as JSON-RPC `-32602 Invalid params` (or worse, a successful call
 *   with `undefined`-bearing payload). Auto-converting the server-advertised
 *   JSON Schema fixes this: well-typed schemas catch errors at the Zod gate
 *   and produce the same error shape as built-in tools.
 *
 * Scope (intentionally narrow)
 *   Supports the JSON Schema constructs MCP servers actually emit in
 *   `list_tools` payloads:
 *     - `type: 'string' | 'number' | 'integer' | 'boolean' | 'null'`
 *     - `type: 'array'` + `items`
 *     - `type: 'object'` + `properties` + `required` (+ optional
 *       `additionalProperties: false` → `.strict()`)
 *     - `enum` (string or mixed literals)
 *     - `const`
 *     - `oneOf` / `anyOf` (rendered as `z.union`)
 *     - Multi-type `type: ['string', 'null']` (rendered as `z.union`)
 *
 *   Anything not in the above list (`$ref`, `allOf`, `if/then/else`, etc.)
 *   falls back to `z.unknown()` rather than throwing. This is by design —
 *   we want the conversion to NEVER fail and never reject inputs that the
 *   MCP server itself would have accepted. Treat it as a best-effort
 *   "first line of defense" sanity check, not strict validation.
 *
 *   `description` is carried over via `.describe()` so the agentic loop's
 *   error formatting can show a readable field name.
 */

import { z } from 'zod'
import type { ZodTypeAny } from 'zod'

/**
 * Convert an arbitrary JSON Schema fragment to a Zod schema.
 *
 * Always returns a valid Zod schema — falls back to `z.unknown()` for
 * unrecognised constructs. Idempotent and side-effect-free; safe to call
 * eagerly on `list_tools` results.
 */
export function jsonSchemaToZod(schema: unknown): ZodTypeAny {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return z.unknown()
  }

  const s = schema as Record<string, unknown>

  // P1-3 (audit): handle `nullable: true` (OpenAPI 3 + JSON Schema Draft
  // 2019-09 shorthand for `type: ['X', 'null']`). Many real MCP servers
  // emit this rather than the explicit multi-type form, and without
  // support the resulting Zod schema would reject `null` even though the
  // server itself accepts it. Recurse without the flag, then wrap.
  if (s.nullable === true) {
    const rest = { ...s }
    delete rest.nullable
    return jsonSchemaToZod(rest).nullable()
  }

  // const — exact literal match.
  if ('const' in s) {
    const c = s.const
    if (typeof c === 'string' || typeof c === 'number' || typeof c === 'boolean') {
      return applyDescribe(z.literal(c), s.description)
    }
    // null literal / object const → fall through to z.unknown().
  }

  // enum — array of literals. Convert each literal then union.
  if (Array.isArray(s.enum) && s.enum.length > 0) {
    const literals = s.enum.map((v) => {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        return z.literal(v)
      }
      return z.unknown()
    })
    if (literals.length === 1) return applyDescribe(literals[0], s.description)
    return applyDescribe(
      z.union(literals as unknown as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]),
      s.description,
    )
  }

  // oneOf / anyOf — union of branches.
  const variants = Array.isArray(s.oneOf) ? s.oneOf : Array.isArray(s.anyOf) ? s.anyOf : null
  if (variants && variants.length > 0) {
    const branches = variants.map((v) => jsonSchemaToZod(v))
    if (branches.length === 1) return applyDescribe(branches[0], s.description)
    return applyDescribe(
      z.union(branches as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]),
      s.description,
    )
  }

  // Multi-type — `type: ['string', 'null']`.
  if (Array.isArray(s.type) && s.type.length > 1) {
    const branches = s.type
      .filter((t): t is string => typeof t === 'string')
      .map((t) => jsonSchemaToZod({ ...s, type: t }))
    if (branches.length === 1) return applyDescribe(branches[0], s.description)
    if (branches.length >= 2) {
      return applyDescribe(
        z.union(branches as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]),
        s.description,
      )
    }
  }

  const type = typeof s.type === 'string' ? s.type : undefined

  switch (type) {
    case 'string':
      return applyDescribe(z.string(), s.description)
    case 'number':
      return applyDescribe(z.number(), s.description)
    case 'integer':
      return applyDescribe(z.number().int(), s.description)
    case 'boolean':
      return applyDescribe(z.boolean(), s.description)
    case 'null':
      return applyDescribe(z.null(), s.description)
    case 'array': {
      const items = s.items
      const inner = items && typeof items === 'object' && !Array.isArray(items)
        ? jsonSchemaToZod(items)
        : z.unknown()
      return applyDescribe(z.array(inner), s.description)
    }
    case 'object':
      return objectSchemaToZod(s)
    default:
      // No `type` keyword (or unknown). If `properties` is set it's still an
      // object (JSON Schema infers); otherwise we cannot narrow further.
      if (s.properties && typeof s.properties === 'object') {
        return objectSchemaToZod({ ...s, type: 'object' })
      }
      return z.unknown()
  }
}

function objectSchemaToZod(s: Record<string, unknown>): ZodTypeAny {
  const props = s.properties && typeof s.properties === 'object' && !Array.isArray(s.properties)
    ? (s.properties as Record<string, unknown>)
    : null
  if (!props) {
    // Open-ended object — accept any record. Pairs with
    // `mcpSchemaIsOpenEnded` in `registry.ts` (open-ended bridged tools
    // already skip parameter materialisation; the Zod schema mirrors that).
    return applyDescribe(z.record(z.string(), z.unknown()), s.description)
  }

  const required = new Set(
    Array.isArray(s.required) ? s.required.filter((r): r is string => typeof r === 'string') : [],
  )

  const shape: Record<string, ZodTypeAny> = {}
  for (const [name, prop] of Object.entries(props)) {
    const child = jsonSchemaToZod(prop)
    shape[name] = required.has(name) ? child : child.optional()
  }

  // Default to `.loose()` (preserve unknown keys) so the agentic loop's
  // Zod gate doesn't silently drop fields the MCP server actually needs
  // — Zod v4's default `strip` mode would do exactly that. Only flip to
  // `.strict()` when the server explicitly opts in with
  // `additionalProperties: false`.
  let obj = z.object(shape)
  obj = s.additionalProperties === false ? obj.strict() : obj.loose()
  return applyDescribe(obj, s.description)
}

function applyDescribe(schema: ZodTypeAny, description: unknown): ZodTypeAny {
  if (typeof description === 'string' && description.length > 0) {
    return schema.describe(description)
  }
  return schema
}
