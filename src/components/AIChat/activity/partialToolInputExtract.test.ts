/**
 * Streaming behaviour of `partialToolInputExtract` — the core
 * "the IDE typewriter" feel for Write/Edit cards relies on this
 * returning **in-progress** string values (the closing `"` hasn't
 * arrived yet) rather than `null`.
 */
import { describe, expect, it } from 'vitest'
import {
  extractStreamingString,
  getStreamingString,
  parsePartialEditInput,
  parsePartialMultiEditInput,
  parsePartialWriteInput,
} from './partialToolInputExtract'

describe('extractStreamingString', () => {
  it('returns null when buffer is empty', () => {
    expect(extractStreamingString('', ['content'])).toBeNull()
  })

  it('returns null when key is absent', () => {
    expect(extractStreamingString('{"foo":"bar"}', ['content'])).toBeNull()
  })

  it('returns in-progress value when closing quote has not arrived', () => {
    const r = extractStreamingString('{"content":"hel', ['content'])
    expect(r).toEqual({ value: 'hel', complete: false })
  })

  it('returns complete value when closing quote has arrived', () => {
    const r = extractStreamingString('{"content":"hello"', ['content'])
    expect(r).toEqual({ value: 'hello', complete: true })
  })

  it('decodes basic JSON escapes', () => {
    const r = extractStreamingString('{"content":"a\\nb', ['content'])
    expect(r?.value).toBe('a\nb')
  })

  it('drops a lone trailing backslash mid-stream', () => {
    // Buffer ends right before the escaped char arrives — common timing.
    const r = extractStreamingString('{"content":"foo\\', ['content'])
    expect(r?.value).toBe('foo')
    expect(r?.complete).toBe(false)
  })

  it('finds the key regardless of preceding-key ordering', () => {
    const r = extractStreamingString(
      '{"filePath":"foo.ts","content":"hello',
      ['content'],
    )
    expect(r).toEqual({ value: 'hello', complete: false })
  })

  it('skips a same-named string used as a value at depth > 1', () => {
    // The scanner is depth-aware: only top-level keys count.
    const r = extractStreamingString(
      '{"meta":{"content":"nested"},"content":"top',
      ['content'],
    )
    expect(r?.value).toBe('top')
  })

  it('accepts alias keys', () => {
    expect(getStreamingString('{"file_path":"x.ts"', ['filePath', 'file_path'])).toBe('x.ts')
  })

  it('returns null on a not-yet-streamed value position', () => {
    // Buffer ends right after the colon — opening `"` of the value not yet on the wire.
    const r = extractStreamingString('{"content":', ['content'])
    expect(r).toBeNull()
  })
})

describe('parsePartialWriteInput', () => {
  it('returns nulls when buffer empty', () => {
    const p = parsePartialWriteInput('')
    expect(p.filePath).toBeNull()
    expect(p.content).toBeNull()
    expect(p.contentComplete).toBe(false)
  })

  it('extracts in-flight content with file path already closed', () => {
    const p = parsePartialWriteInput('{"filePath":"a.ts","content":"line1\\nlin')
    expect(p.filePath).toBe('a.ts')
    expect(p.content).toBe('line1\nlin')
    expect(p.contentComplete).toBe(false)
  })

  it('marks content complete once closing quote arrives', () => {
    const p = parsePartialWriteInput('{"filePath":"a.ts","content":"done"')
    expect(p.contentComplete).toBe(true)
    expect(p.content).toBe('done')
  })
})

describe('parsePartialEditInput', () => {
  it('extracts oldString and growing newString independently', () => {
    const buf =
      '{"filePath":"f.ts","oldString":"const a = 1","newString":"const a ='
    const p = parsePartialEditInput(buf)
    expect(p.filePath).toBe('f.ts')
    expect(p.oldString).toBe('const a = 1')
    expect(p.oldComplete).toBe(true)
    expect(p.newString).toBe('const a =')
    expect(p.newComplete).toBe(false)
  })
})

describe('parsePartialMultiEditInput', () => {
  it('returns zeros / nulls when buffer is empty', () => {
    const p = parsePartialMultiEditInput('')
    expect(p.filePath).toBeNull()
    expect(p.edits).toEqual([])
    expect(p.streamingEditIndex).toBe(-1)
  })

  it('returns filePath but no edits when the array key has not yet streamed', () => {
    const p = parsePartialMultiEditInput('{"filePath":"a.ts","edit')
    expect(p.filePath).toBe('a.ts')
    expect(p.edits).toEqual([])
  })

  it('counts a single in-progress edit and surfaces its old / partial new', () => {
    const buf =
      '{"filePath":"a.ts","edits":[{"oldString":"foo","newString":"ba'
    const p = parsePartialMultiEditInput(buf)
    expect(p.filePath).toBe('a.ts')
    expect(p.edits).toEqual([
      {
        oldString: 'foo',
        newString: 'ba',
        oldComplete: true,
        newComplete: false,
      },
    ])
    expect(p.streamingEditIndex).toBe(0)
  })

  it('preserves completed edits while the latest edit is streaming', () => {
    const buf =
      '{"filePath":"a.ts","edits":[' +
      '{"oldString":"foo","newString":"bar"},' +
      '{"oldString":"baz","newString":"qux'
    const p = parsePartialMultiEditInput(buf)
    expect(p.edits).toEqual([
      {
        oldString: 'foo',
        newString: 'bar',
        oldComplete: true,
        newComplete: true,
      },
      {
        oldString: 'baz',
        newString: 'qux',
        oldComplete: true,
        newComplete: false,
      },
    ])
    expect(p.streamingEditIndex).toBe(1)
  })

  it('marks the latest edit complete once its closing brace streams', () => {
    const buf =
      '{"filePath":"a.ts","edits":[{"oldString":"foo","newString":"bar"}'
    const p = parsePartialMultiEditInput(buf)
    expect(p.edits[0]).toEqual({
      oldString: 'foo',
      newString: 'bar',
      oldComplete: true,
      newComplete: true,
    })
    expect(p.streamingEditIndex).toBe(-1)
  })

  it('handles snake_case aliases (old_string / new_string)', () => {
    const buf =
      '{"file_path":"a.ts","edits":[{"old_string":"x","new_string":"y'
    const p = parsePartialMultiEditInput(buf)
    expect(p.filePath).toBe('a.ts')
    expect(p.edits[0]?.oldString).toBe('x')
    expect(p.edits[0]?.newString).toBe('y')
  })

  it('ignores a stray "edits":[ literal inside a string value', () => {
    // The depth-aware scanner must NOT lock onto a `"edits":[` substring
    // that appears inside another value (in this case, a filePath that
    // happens to contain it). Without depth tracking the scanner would
    // false-match and report nonsense.
    const buf =
      '{"filePath":"weird\\"edits\\":[suffix","edits":[{"oldString":"a","newString":"b'
    const p = parsePartialMultiEditInput(buf)
    expect(p.edits).toHaveLength(1)
    expect(p.edits[0]?.oldString).toBe('a')
    expect(p.edits[0]?.newString).toBe('b')
  })

  it('stops at the closing ] once the array has ended', () => {
    const buf =
      '{"filePath":"a.ts","edits":[{"oldString":"x","newString":"y"}],"extraField":"ignored"}'
    const p = parsePartialMultiEditInput(buf)
    expect(p.edits).toHaveLength(1)
    expect(p.edits[0]?.newString).toBe('y')
    expect(p.edits[0]?.newComplete).toBe(true)
    expect(p.streamingEditIndex).toBe(-1)
  })
})
