/**
 * Tests for `jsonSchemaToZod` — verifies the conversion covers the JSON
 * Schema subset MCP servers actually emit, and that unrecognised constructs
 * fall back to `z.unknown()` instead of throwing.
 */

import { describe, it, expect } from 'vitest'
import { jsonSchemaToZod } from './jsonSchemaToZod'

describe('jsonSchemaToZod — primitive types', () => {
  it('converts string type', () => {
    const s = jsonSchemaToZod({ type: 'string' })
    expect(s.safeParse('hello').success).toBe(true)
    expect(s.safeParse(42).success).toBe(false)
  })

  it('converts integer type with .int() constraint', () => {
    const s = jsonSchemaToZod({ type: 'integer' })
    expect(s.safeParse(42).success).toBe(true)
    expect(s.safeParse(42.5).success).toBe(false)
    expect(s.safeParse('42').success).toBe(false)
  })

  it('converts boolean type', () => {
    const s = jsonSchemaToZod({ type: 'boolean' })
    expect(s.safeParse(true).success).toBe(true)
    expect(s.safeParse('true').success).toBe(false)
  })
})

describe('jsonSchemaToZod — array', () => {
  it('converts typed array', () => {
    const s = jsonSchemaToZod({ type: 'array', items: { type: 'string' } })
    expect(s.safeParse(['a', 'b']).success).toBe(true)
    expect(s.safeParse([1, 2]).success).toBe(false)
  })

  it('converts array without items as array of unknown', () => {
    const s = jsonSchemaToZod({ type: 'array' })
    expect(s.safeParse(['a', 1, true]).success).toBe(true)
  })
})

describe('jsonSchemaToZod — object', () => {
  it('respects required vs optional', () => {
    const s = jsonSchemaToZod({
      type: 'object',
      properties: {
        path: { type: 'string' },
        offset: { type: 'integer' },
      },
      required: ['path'],
    })
    expect(s.safeParse({ path: '/x' }).success).toBe(true)
    expect(s.safeParse({ path: '/x', offset: 10 }).success).toBe(true)
    expect(s.safeParse({}).success).toBe(false) // path missing
    expect(s.safeParse({ path: 1 }).success).toBe(false) // wrong type
  })

  it('allows additional properties by default (lenient — server decides)', () => {
    const s = jsonSchemaToZod({
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
    })
    expect(s.safeParse({ a: 'x', extra: 1 }).success).toBe(true)
  })

  it('PRESERVES additional properties in parsed output (no silent strip)', () => {
    // Critical for MCP bridge: zod v4 defaults to strip mode which would
    // throw away fields the server actually needs. We force `.loose()` so
    // unknown keys flow through unchanged.
    const s = jsonSchemaToZod({
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
    })
    const r = s.safeParse({ a: 'x', extra: 1, deep: { nested: true } })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data).toEqual({ a: 'x', extra: 1, deep: { nested: true } })
    }
  })

  it('rejects additional properties when additionalProperties: false', () => {
    const s = jsonSchemaToZod({
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
      additionalProperties: false,
    })
    expect(s.safeParse({ a: 'x', extra: 1 }).success).toBe(false)
  })

  it('open-ended object (no properties) accepts any record', () => {
    const s = jsonSchemaToZod({ type: 'object' })
    expect(s.safeParse({}).success).toBe(true)
    expect(s.safeParse({ a: 1, b: 'x' }).success).toBe(true)
  })
})

describe('jsonSchemaToZod — enum and const', () => {
  it('converts enum of strings to union of literals', () => {
    const s = jsonSchemaToZod({ enum: ['a', 'b', 'c'] })
    expect(s.safeParse('a').success).toBe(true)
    expect(s.safeParse('d').success).toBe(false)
  })

  it('converts const to literal', () => {
    const s = jsonSchemaToZod({ const: 'fixed' })
    expect(s.safeParse('fixed').success).toBe(true)
    expect(s.safeParse('other').success).toBe(false)
  })
})

describe('jsonSchemaToZod — oneOf / anyOf', () => {
  it('converts oneOf to union', () => {
    const s = jsonSchemaToZod({
      oneOf: [{ type: 'string' }, { type: 'number' }],
    })
    expect(s.safeParse('x').success).toBe(true)
    expect(s.safeParse(42).success).toBe(true)
    expect(s.safeParse(true).success).toBe(false)
  })

  it('converts anyOf to union', () => {
    const s = jsonSchemaToZod({
      anyOf: [{ type: 'string' }, { type: 'boolean' }],
    })
    expect(s.safeParse('x').success).toBe(true)
    expect(s.safeParse(true).success).toBe(true)
    expect(s.safeParse(42).success).toBe(false)
  })
})

describe('jsonSchemaToZod — multi-type and nullable', () => {
  it('converts type: [string, null] to union', () => {
    const s = jsonSchemaToZod({ type: ['string', 'null'] })
    expect(s.safeParse('x').success).toBe(true)
    expect(s.safeParse(null).success).toBe(true)
    expect(s.safeParse(42).success).toBe(false)
  })

  // P1-3 (audit): nullable shorthand
  it('converts type: "string" + nullable: true to nullable string', () => {
    const s = jsonSchemaToZod({ type: 'string', nullable: true })
    expect(s.safeParse('x').success).toBe(true)
    expect(s.safeParse(null).success).toBe(true)
    expect(s.safeParse(42).success).toBe(false)
  })

  it('converts nullable on nested integer in object', () => {
    const s = jsonSchemaToZod({
      type: 'object',
      properties: {
        limit: { type: 'integer', nullable: true },
      },
      required: ['limit'],
    })
    expect(s.safeParse({ limit: 5 }).success).toBe(true)
    expect(s.safeParse({ limit: null }).success).toBe(true)
    expect(s.safeParse({ limit: 'x' }).success).toBe(false)
  })

  it('nullable on enum still rejects out-of-list non-null values', () => {
    const s = jsonSchemaToZod({ enum: ['a', 'b'], nullable: true })
    expect(s.safeParse('a').success).toBe(true)
    expect(s.safeParse(null).success).toBe(true)
    expect(s.safeParse('c').success).toBe(false)
  })
})

describe('jsonSchemaToZod — fallback (loose mode)', () => {
  it('falls back to unknown for $ref', () => {
    const s = jsonSchemaToZod({ $ref: '#/definitions/Foo' })
    expect(s.safeParse({ anything: true }).success).toBe(true)
    expect(s.safeParse('also fine').success).toBe(true)
  })

  it('falls back to unknown for allOf', () => {
    const s = jsonSchemaToZod({ allOf: [{ type: 'string' }] })
    expect(s.safeParse('anything').success).toBe(true)
    expect(s.safeParse(42).success).toBe(true)
  })

  it('falls back to unknown for null/non-object input', () => {
    expect(jsonSchemaToZod(null).safeParse('x').success).toBe(true)
    expect(jsonSchemaToZod(undefined).safeParse(42).success).toBe(true)
    expect(jsonSchemaToZod('not a schema').safeParse({}).success).toBe(true)
  })

  it('never throws on malformed input', () => {
    // Should not throw — just produce a permissive schema.
    expect(() => jsonSchemaToZod({ type: 'unknown_type' })).not.toThrow()
    expect(() => jsonSchemaToZod({ properties: 'not an object' })).not.toThrow()
    expect(() => jsonSchemaToZod({ type: 'array', items: 'invalid' })).not.toThrow()
  })
})

describe('jsonSchemaToZod — nested object (real-world MCP shape)', () => {
  it('converts a filesystem-mcp `read_file` schema correctly', () => {
    const schema = {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute file path' },
        encoding: {
          type: 'string',
          enum: ['utf-8', 'base64'],
          description: 'Encoding of the returned content',
        },
      },
      required: ['path'],
      additionalProperties: false,
    }
    const s = jsonSchemaToZod(schema)
    expect(s.safeParse({ path: '/x' }).success).toBe(true)
    expect(s.safeParse({ path: '/x', encoding: 'utf-8' }).success).toBe(true)
    expect(s.safeParse({ path: '/x', encoding: 'gbk' }).success).toBe(false)
    expect(s.safeParse({}).success).toBe(false)
    expect(s.safeParse({ path: '/x', bogus: 1 }).success).toBe(false)
  })

  it('handles deeply nested array of objects (edit-style schema)', () => {
    const schema = {
      type: 'object',
      properties: {
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              oldText: { type: 'string' },
              newText: { type: 'string' },
            },
            required: ['oldText', 'newText'],
          },
        },
      },
      required: ['edits'],
    }
    const s = jsonSchemaToZod(schema)
    expect(s.safeParse({ edits: [{ oldText: 'a', newText: 'b' }] }).success).toBe(true)
    expect(s.safeParse({ edits: [{ oldText: 'a' }] }).success).toBe(false) // newText missing
    expect(s.safeParse({ edits: 'not an array' }).success).toBe(false)
  })
})
