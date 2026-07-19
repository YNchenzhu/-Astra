import { describe, it, expect } from 'vitest'
import {
  capToolDescription,
  sanitizeToolSchemaForWire,
  sanitizeToolsForWire,
} from './toolSchemaSanitizer'

describe('sanitizeToolSchemaForWire', () => {
  describe('anthropic (full policy)', () => {
    it('keeps additionalProperties / $schema / oneOf / const / format', () => {
      const out = sanitizeToolSchemaForWire(
        {
          $schema: 'https://example/schema',
          type: 'object',
          additionalProperties: true,
          properties: {
            value: { type: 'string', const: 'x', format: 'email' },
            kind: { oneOf: [{ type: 'string' }, { type: 'number' }] },
          },
        },
        'anthropic',
      )
      expect(out.additionalProperties).toBe(true)
      expect(out.$schema).toBe('https://example/schema')
      expect((out.properties as Record<string, Record<string, unknown>>).value.format).toBe('email')
      expect((out.properties as Record<string, Record<string, unknown>>).value.const).toBe('x')
      expect((out.properties as Record<string, Record<string, unknown>>).kind.oneOf).toBeDefined()
    })

    it('still ensures array items are defined', () => {
      const out = sanitizeToolSchemaForWire(
        {
          type: 'object',
          properties: { tags: { type: 'array' } },
        },
        'anthropic',
      )
      expect((out.properties as Record<string, Record<string, unknown>>).tags.items).toEqual({ type: 'string' })
    })
  })

  describe('anthropic-compat (strict subset)', () => {
    it('strips additionalProperties / $schema / $ref / title / const / format / examples', () => {
      const out = sanitizeToolSchemaForWire(
        {
          type: 'object',
          $schema: 'http://x',
          additionalProperties: true,
          title: 't',
          properties: {
            value: {
              type: 'string',
              const: 'x',
              format: 'email',
              examples: ['a'],
              default: 'y',
              title: 'Value',
              $ref: '#/defs/x',
            },
          },
        },
        'anthropic-compat',
      )
      expect(out.additionalProperties).toBeUndefined()
      expect(out.$schema).toBeUndefined()
      expect(out.title).toBeUndefined()
      const prop = (out.properties as Record<string, Record<string, unknown>>).value
      expect(prop.const).toBeUndefined()
      expect(prop.format).toBeUndefined()
      expect(prop.examples).toBeUndefined()
      expect(prop.default).toBeUndefined()
      expect(prop.title).toBeUndefined()
      expect(prop.$ref).toBeUndefined()
    })

    it('strips oneOf / anyOf / allOf combinators', () => {
      const out = sanitizeToolSchemaForWire(
        {
          type: 'object',
          properties: {
            v: { oneOf: [{ type: 'string' }] },
            w: { anyOf: [{ type: 'number' }] },
            x: { allOf: [{ type: 'object' }] },
          },
        },
        'anthropic-compat',
      )
      const props = out.properties as Record<string, Record<string, unknown>>
      expect(props.v.oneOf).toBeUndefined()
      expect(props.w.anyOf).toBeUndefined()
      expect(props.x.allOf).toBeUndefined()
    })

    it('removes stray items on object-typed nodes', () => {
      const out = sanitizeToolSchemaForWire(
        {
          type: 'object',
          properties: {
            metadata: {
              type: 'object',
              items: { type: 'string' }, // stray
              properties: { foo: { type: 'string' } },
            },
          },
        },
        'anthropic-compat',
      )
      const meta = (out.properties as Record<string, Record<string, unknown>>).metadata
      expect(meta.items).toBeUndefined()
    })
  })

  describe('gemini-native (strict subset)', () => {
    it('defaults missing array items to {type:string}', () => {
      const out = sanitizeToolSchemaForWire(
        { type: 'object', properties: { arr: { type: 'array' } } },
        'gemini-native',
      )
      expect((out.properties as Record<string, Record<string, unknown>>).arr.items).toEqual({ type: 'string' })
    })

    it('recurses into nested properties', () => {
      const out = sanitizeToolSchemaForWire(
        {
          type: 'object',
          properties: {
            outer: {
              type: 'object',
              additionalProperties: true,
              properties: {
                inner: { type: 'string', const: 'x' },
              },
            },
          },
        },
        'gemini-native',
      )
      const outer = (out.properties as Record<string, Record<string, unknown>>).outer
      expect(outer.additionalProperties).toBeUndefined()
      const inner = (outer.properties as Record<string, Record<string, unknown>>).inner
      expect(inner.const).toBeUndefined()
    })
  })

  describe('openai-native (full policy)', () => {
    it('preserves rich schema for native OpenAI', () => {
      const out = sanitizeToolSchemaForWire(
        {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['a', 'b'], default: 'a' },
          },
        },
        'openai-native',
      )
      const mode = (out.properties as Record<string, Record<string, unknown>>).mode
      expect(mode.default).toBe('a')
      expect(mode.enum).toEqual(['a', 'b'])
    })
  })

  describe('top-level shape', () => {
    it('injects type/properties when missing', () => {
      const out = sanitizeToolSchemaForWire({}, 'anthropic-compat')
      expect(out.type).toBe('object')
      expect(out.properties).toEqual({})
    })

    it('handles undefined input', () => {
      const out = sanitizeToolSchemaForWire(undefined, 'anthropic-compat')
      expect(out).toEqual({ type: 'object', properties: {} })
    })
  })
})

describe('capToolDescription', () => {
  it('passes through when shorter than cap', () => {
    expect(capToolDescription('hi', 100)).toBe('hi')
  })

  it('truncates and appends a notice when longer than cap', () => {
    const long = 'x'.repeat(200)
    const out = capToolDescription(long, 100)
    expect(out.startsWith('x'.repeat(100))).toBe(true)
    expect(out).toContain('Truncated by client')
  })

  it('no-ops with zero / negative / undefined cap', () => {
    const long = 'x'.repeat(200)
    expect(capToolDescription(long, 0)).toBe(long)
    expect(capToolDescription(long, undefined)).toBe(long)
  })
})

describe('sanitizeToolsForWire', () => {
  it('applies schema policy + description cap consistently', () => {
    const tools = [
      {
        name: 't',
        description: 'x'.repeat(500),
        input_schema: {
          type: 'object',
          additionalProperties: true,
          properties: { a: { type: 'array' } },
        },
      },
    ]
    const out = sanitizeToolsForWire(tools, 'anthropic-compat', 100)
    expect(out[0].description.length).toBeLessThanOrEqual(200) // 100 + suffix
    expect(out[0].description).toContain('Truncated')
    expect(out[0].input_schema.additionalProperties).toBeUndefined()
    expect((out[0].input_schema.properties as Record<string, Record<string, unknown>>).a.items).toEqual({
      type: 'string',
    })
  })
})
