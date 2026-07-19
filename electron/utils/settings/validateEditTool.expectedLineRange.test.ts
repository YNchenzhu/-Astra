import { describe, it, expect } from 'vitest'
import { validateEditToolPayload } from './validateEditTool'

const baseInput = {
  filePath: '/tmp/foo.py',
  oldString: 'a',
  newString: 'b',
}

describe('validateEditToolPayload — expectedLineRange shape', () => {
  it('accepts a well-formed [start, end] tuple', () => {
    const r = validateEditToolPayload({ ...baseInput, expectedLineRange: [10, 20] })
    expect(r).toEqual({ ok: true })
  })

  it('accepts the snake_case alias', () => {
    const r = validateEditToolPayload({ ...baseInput, expected_line_range: [3, 3] })
    expect(r).toEqual({ ok: true })
  })

  it('passes silently when the field is omitted (full back-compat)', () => {
    const r = validateEditToolPayload({ ...baseInput })
    expect(r).toEqual({ ok: true })
  })

  it('rejects a non-array value', () => {
    const r = validateEditToolPayload({ ...baseInput, expectedLineRange: 'not an array' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.message).toContain('2-element array')
  })

  it('rejects an array of wrong length', () => {
    const r = validateEditToolPayload({ ...baseInput, expectedLineRange: [1, 2, 3] })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.message).toContain('2-element array')
  })

  it('rejects non-integer entries (floats)', () => {
    const r = validateEditToolPayload({ ...baseInput, expectedLineRange: [1.5, 2] })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.message).toContain('integers')
  })

  it('rejects non-numeric entries (strings)', () => {
    const r = validateEditToolPayload({ ...baseInput, expectedLineRange: ['1', '2'] })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.message).toContain('integers')
  })

  it('rejects entries < 1 (line numbers are 1-based)', () => {
    const r = validateEditToolPayload({ ...baseInput, expectedLineRange: [0, 5] })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.message).toContain('>= 1')
  })

  it('rejects negative entries', () => {
    const r = validateEditToolPayload({ ...baseInput, expectedLineRange: [-3, 5] })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.message).toContain('>= 1')
  })

  it('rejects start > end', () => {
    const r = validateEditToolPayload({ ...baseInput, expectedLineRange: [10, 5] })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.message).toContain('start <= end')
    expect(r.message).toContain('[10, 5]')
  })

  it('accepts start === end (single-line edit)', () => {
    const r = validateEditToolPayload({ ...baseInput, expectedLineRange: [42, 42] })
    expect(r).toEqual({ ok: true })
  })
})
