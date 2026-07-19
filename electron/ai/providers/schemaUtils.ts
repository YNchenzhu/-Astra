/**
 * Shared JSON-schema utilities used across provider-specific tool conversions.
 *
 * Extracted from `client.ts` when we split out the Gemini provider — it's used
 * by Anthropic, OpenAI and Gemini alike, so it needs to live above the
 * per-provider files.
 */

/**
 * Ensure all array properties have `items` defined. Several providers
 * (Gemini, OpenAI strict tools, some Anthropic-compatible gateways) reject
 * tool schemas where an array property is missing its element schema. We
 * defensively default to `{ type: 'string' }` and recurse into nested
 * objects/arrays so deeply-nested tool schemas stay well-formed.
 */
export function ensureArrayItemsSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') {
    return schema
  }

  if (schema.type === 'array' && schema.items && typeof schema.items === 'object') {
    return {
      ...schema,
      items: ensureArrayItemsSchema(schema.items as Record<string, unknown>),
    }
  }

  if (!schema.properties || typeof schema.properties !== 'object') {
    return schema
  }

  const properties = { ...schema.properties } as Record<string, Record<string, unknown>>
  for (const [key, prop] of Object.entries(properties)) {
    if (!prop || typeof prop !== 'object') continue

    if (prop.type === 'array' && !prop.items) {
      properties[key] = {
        ...prop,
        items: { type: 'string' },
      }
    } else if (prop.type === 'array' && prop.items) {
      properties[key] = {
        ...prop,
        items: ensureArrayItemsSchema(prop.items as Record<string, unknown>),
      }
    } else if (prop.type === 'object' && prop.properties) {
      properties[key] = ensureArrayItemsSchema(prop as Record<string, unknown>)
    }
  }

  return { ...schema, properties }
}
