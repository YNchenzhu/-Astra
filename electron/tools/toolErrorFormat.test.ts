import { describe, it, expect } from 'vitest'
import {
  formatToolError,
  formatUnexpectedToolError,
  buildToolFailure,
} from './toolErrorFormat'

describe('formatToolError', () => {
  it('emits just the headline when no other fields are supplied', () => {
    const out = formatToolError({ what: 'read_file: something broke' })
    expect(out).toBe('read_file: something broke')
  })

  it('joins tried candidates with the `Tried: a | b | c` separator', () => {
    const out = formatToolError({
      what: 'Path not found: foo',
      tried: ['/a/foo', '/b/foo', '/c/foo'],
    })
    expect(out).toBe(
      'Path not found: foo\nTried: /a/foo  |  /b/foo  |  /c/foo',
    )
  })

  it('collapses a single-line `next` inline and expands multiple into a bullet list', () => {
    const single = formatToolError({ what: 'X', next: 'do Y' })
    expect(single).toBe('X\nNext: do Y')

    const multi = formatToolError({
      what: 'X',
      next: ['do Y', 'or Z'],
    })
    expect(multi).toBe('X\nNext:\n  - do Y\n  - or Z')
  })

  it('ignores empty / nullish context entries but keeps real ones', () => {
    const out = formatToolError({
      what: 'X',
      context: { workspace: '/ws', platform: 'win32', unused: null, missing: undefined, empty: '' },
    })
    expect(out).toContain('workspace=/ws')
    expect(out).toContain('platform=win32')
    expect(out).not.toContain('unused=')
    expect(out).not.toContain('missing=')
    expect(out).not.toContain('empty=')
  })

  it('omits the Tried section when the array is empty', () => {
    const out = formatToolError({ what: 'X', tried: [] })
    expect(out).toBe('X')
  })

  it('survives `next: [""]` (pure-whitespace entries are filtered)', () => {
    const out = formatToolError({ what: 'X', next: ['', '   '] })
    expect(out).toBe('X')
  })

  it('preserves the exact order: what → tried → context → next', () => {
    const out = formatToolError({
      what: 'head',
      tried: ['/a'],
      context: { cwd: '/b' },
      next: 'fix it',
    })
    const lines = out.split('\n')
    expect(lines[0]).toBe('head')
    expect(lines[1]).toMatch(/^Tried:/)
    expect(lines[2]).toMatch(/^Context:/)
    expect(lines[3]).toMatch(/^Next:/)
  })
})

describe('formatUnexpectedToolError', () => {
  it('wraps an Error instance and includes its message', () => {
    const out = formatUnexpectedToolError('read_file', new Error('boom'))
    expect(out).toContain('read_file hit an unexpected error: boom')
    expect(out).toContain('Next:')
  })

  it('stringifies non-Error throwables (string, object) safely', () => {
    expect(formatUnexpectedToolError('x', 'string-error')).toContain('string-error')
    expect(formatUnexpectedToolError('x', { a: 1 })).toContain('[object Object]')
  })

  it('honours a caller-supplied `next` directive', () => {
    const out = formatUnexpectedToolError('x', new Error('e'), 'clear the cache and retry')
    expect(out).toContain('Next: clear the cache and retry')
  })
})

describe('buildToolFailure', () => {
  it('returns the formatted string identical to `formatToolError(input)`', () => {
    const input = {
      what: 'Path not found: src/foo.ts',
      tried: ['/ws/src/foo.ts', '/cwd/src/foo.ts'],
      context: { workspace: '/ws' },
      next: ['Use glob to discover the file', 'Or check the path'],
    }
    expect(buildToolFailure(input).error).toBe(formatToolError(input))
  })

  it('exposes `what` / `tried` / `context` / `next` as separate fields for the UI', () => {
    const out = buildToolFailure({
      what: 'Path not found: src/foo.ts',
      tried: ['/ws/src/foo.ts'],
      context: { workspace: '/ws', platform: 'win32' },
      next: ['Use glob', 'Use list_files'],
    })
    expect(out.errorWhat).toBe('Path not found: src/foo.ts')
    expect(out.errorTried).toEqual(['/ws/src/foo.ts'])
    expect(out.errorContext).toEqual({ workspace: '/ws', platform: 'win32' })
    expect(out.errorNext).toEqual(['Use glob', 'Use list_files'])
  })

  it('normalises a single-string `next` into a one-element array', () => {
    const out = buildToolFailure({ what: 'X', next: 'do Y' })
    expect(out.errorNext).toEqual(['do Y'])
  })

  it('omits empty `tried` / `next` arrays so the renderer can use truthy checks', () => {
    const out = buildToolFailure({ what: 'X', tried: [], next: ['', '   '] })
    expect(out.errorTried).toBeUndefined()
    expect(out.errorNext).toBeUndefined()
  })

  it('strips empty / null / undefined context entries (matches formatter semantics)', () => {
    const out = buildToolFailure({
      what: 'X',
      context: { ws: '/w', missing: undefined, empty: '', nada: null, n: 5 },
    })
    expect(out.errorContext).toEqual({ ws: '/w', n: 5 })
  })

  it('omits the structured `errorContext` field entirely when no entries survive filtering', () => {
    const out = buildToolFailure({ what: 'X', context: { a: '', b: undefined } })
    expect(out.errorContext).toBeUndefined()
  })

  it('preserves headline whitespace handling consistent with formatToolError', () => {
    const out = buildToolFailure({ what: '   X   ' })
    expect(out.errorWhat).toBe('X')
    expect(out.error).toBe('X')
  })

  it('is spread-safe onto a ToolResult shape', () => {
    // This is the canonical caller pattern. Type-safety is covered by tsc;
    // runtime contract is that the spread populates the documented fields.
    const result = { success: false as const, ...buildToolFailure({ what: 'X', next: 'Y' }) }
    expect(result.success).toBe(false)
    expect(result.error).toBe('X\nNext: Y')
    expect(result.errorWhat).toBe('X')
    expect(result.errorNext).toEqual(['Y'])
  })

  it('accepts an explicit class via the second argument and surfaces it as toolErrorClass', () => {
    const out = buildToolFailure({ what: 'no such file' }, 'not_found')
    expect(out.toolErrorClass).toBe('not_found')
  })

  it('omits toolErrorClass when no class is supplied (legacy callers continue to work)', () => {
    const out = buildToolFailure({ what: 'X' })
    expect(out.toolErrorClass).toBeUndefined()
  })

  it('class is independent of the formatted error string', () => {
    // Audit B3: the class is metadata for the post-execution classifier;
    // it must NOT leak into the model-visible `error` text — the model
    // already gets the structured What/Tried/Next which is enough.
    const withClass = buildToolFailure({ what: 'no such file' }, 'not_found')
    const withoutClass = buildToolFailure({ what: 'no such file' })
    expect(withClass.error).toBe(withoutClass.error)
  })

  it('preserves the class through a ToolResult spread', () => {
    const result = {
      success: false as const,
      ...buildToolFailure({ what: 'X' }, 'permission_denied'),
    }
    expect(result.toolErrorClass).toBe('permission_denied')
  })
})
