import { describe, it, expect } from 'vitest'
import {
  parseToolArguments,
  parseToolArgumentsWithMeta,
  RAW_ARGUMENTS_KEY,
  LENIENT_REPAIRED_TOOL_ARGS_MARKER_KEY,
  TRUNCATED_TOOL_ARGS_MARKER_KEY,
  stripInternalToolArgMarkers,
  stringifyToolInputForOpenAi,
} from './parseToolArguments'

describe('parseToolArgumentsWithMeta — truncation detection', () => {
  it('flags truncationRepaired AND stamps the marker centrally when an unterminated string is auto-closed', () => {
    const truncated = '{"filePath":"a.ts","content":"line1\\nline2\\nstill going when cut off'
    const { value, meta } = parseToolArgumentsWithMeta(truncated)
    expect(meta.truncationRepaired).toBe(true)
    // Central stamp closes the non-stream / transformer gap (the streaming
    // clients' per-emitter check never runs on those paths).
    expect(value[TRUNCATED_TOOL_ARGS_MARKER_KEY]).toBe(true)
    expect(typeof value.content).toBe('string')
    expect(String(value.content)).toContain('line1')
  })

  it('does NOT flag truncation for well-formed JSON', () => {
    const { meta } = parseToolArgumentsWithMeta('{"filePath":"a.ts","content":"all good"}')
    expect(meta.truncationRepaired).toBe(false)
  })

  it('does NOT flag truncation for trailing-prose carve (benign, no data loss)', () => {
    const { value, meta } = parseToolArgumentsWithMeta('{"filePath":"a.ts","content":"x"}\n\nDone!')
    expect(meta.truncationRepaired).toBe(false)
    expect(value.content).toBe('x')
  })

  it('flags lenientRepaired (not truncation) and stamps the marker when jsonrepair recovers the object', () => {
    // Unquoted keys are jsonrepair-fixable and safe to recover. The lenient flag
    // + the centrally-stamped marker let write/edit schemas refuse it while
    // read-class tools still benefit (they ignore the marker and drop it).
    const { value, meta } = parseToolArgumentsWithMeta('{a: 1}')
    expect(meta.truncationRepaired).toBe(false)
    expect(meta.lenientRepaired).toBe(true)
    expect(value.a).toBe(1)
    expect(value[LENIENT_REPAIRED_TOOL_ARGS_MARKER_KEY]).toBe(true)
    expect(value[RAW_ARGUMENTS_KEY]).toBeUndefined()
  })

  it('flags lenientRepaired for an unescaped interior " (the long-Chinese-edit failure mode)', () => {
    const raw =
      '{"filePath":"a.txt","edits":[{"oldString":"深植"民族性"基因","newString":"x"}]}'
    const { value, meta } = parseToolArgumentsWithMeta(raw)
    expect(meta.lenientRepaired).toBe(true)
    expect(meta.truncationRepaired).toBe(false)
    expect(value[RAW_ARGUMENTS_KEY]).toBeUndefined()
    expect(Array.isArray(value.edits)).toBe(true)
  })

  it('still surfaces __rawArguments (no lenient flag) for truly non-JSON prose', () => {
    // jsonrepair wraps bare prose as a JSON *string*, which is not a tool-input
    // object — so we reject it and fall through to the raw-arguments surface.
    const { value, meta } = parseToolArgumentsWithMeta('not even remotely json')
    expect(meta.lenientRepaired).toBe(false)
    expect(meta.truncationRepaired).toBe(false)
    expect(value[RAW_ARGUMENTS_KEY]).toBe('not even remotely json')
  })

  it('honours DISABLE_LENIENT_JSON_REPAIR=1 escape hatch', () => {
    const prev = process.env.DISABLE_LENIENT_JSON_REPAIR
    process.env.DISABLE_LENIENT_JSON_REPAIR = '1'
    try {
      const { value, meta } = parseToolArgumentsWithMeta('{a: 1}')
      expect(meta.lenientRepaired).toBe(false)
      expect(value[RAW_ARGUMENTS_KEY]).toBe('{a: 1}')
    } finally {
      if (prev === undefined) delete process.env.DISABLE_LENIENT_JSON_REPAIR
      else process.env.DISABLE_LENIENT_JSON_REPAIR = prev
    }
  })
})

describe('parseToolArguments', () => {
  it('parses well-formed JSON string', () => {
    const out = parseToolArguments('{"a":1,"b":"x"}')
    expect(out).toEqual({ a: 1, b: 'x' })
    expect(out[RAW_ARGUMENTS_KEY]).toBeUndefined()
  })

  it('repairs jsonrepair-fixable malformed JSON (unquoted keys) instead of __rawArguments', () => {
    const out = parseToolArguments('{a: 1}') // missing quotes — jsonrepair fixes this
    expect(out.a).toBe(1)
    expect(out[LENIENT_REPAIRED_TOOL_ARGS_MARKER_KEY]).toBe(true)
    expect(out[RAW_ARGUMENTS_KEY]).toBeUndefined()
  })

  it('passes through already-parsed objects', () => {
    const out = parseToolArguments({ filePath: 'a.txt' })
    expect(out).toEqual({ filePath: 'a.txt' })
  })

  it('unwraps nested {raw_arguments} wrappers (gateway double-encoding)', () => {
    const out = parseToolArguments({ raw_arguments: '{"filePath":"x"}' })
    expect(out).toEqual({ filePath: 'x' })
  })

  it('unwraps when JSON body itself wraps raw_arguments', () => {
    const out = parseToolArguments('{"raw_arguments":"{\\"a\\":1}"}')
    expect(out).toEqual({ a: 1 })
  })

  it('handles empty / null / whitespace as empty object', () => {
    expect(parseToolArguments(null)).toEqual({})
    expect(parseToolArguments(undefined)).toEqual({})
    expect(parseToolArguments('')).toEqual({})
    expect(parseToolArguments('   ')).toEqual({})
  })

  it('non-object primitives go to __rawArguments', () => {
    const out = parseToolArguments('"just a string"')
    expect(out[RAW_ARGUMENTS_KEY]).toBe('"just a string"')
  })

  it('arrays get serialized into __rawArguments', () => {
    const out = parseToolArguments([1, 2, 3])
    expect(out[RAW_ARGUMENTS_KEY]).toBe('[1,2,3]')
  })

  // ─── Repair pass (DeepSeek / Kimi / GLM Anthropic-compat gateways) ───

  it('strips a ```json code fence wrapper emitted by some gateways', () => {
    const out = parseToolArguments('```json\n{"filePath":"a.txt","content":"hi"}\n```')
    expect(out).toEqual({ filePath: 'a.txt', content: 'hi' })
    expect(out[RAW_ARGUMENTS_KEY]).toBeUndefined()
  })

  it('strips plain ``` fence without lang tag', () => {
    const out = parseToolArguments('```\n{"filePath":"a.txt","content":"hi"}\n```')
    expect(out).toEqual({ filePath: 'a.txt', content: 'hi' })
  })

  it('drops short conversational preamble before the JSON body', () => {
    const out = parseToolArguments('Here is the JSON: {"filePath":"a.txt","content":"hi"}')
    expect(out).toEqual({ filePath: 'a.txt', content: 'hi' })
  })

  it('carves out a balanced object when the model appends trailing prose', () => {
    const out = parseToolArguments(
      '{"filePath":"a.txt","content":"hi"}\nThat should do it!',
    )
    expect(out).toEqual({ filePath: 'a.txt', content: 'hi' })
  })

  it('does not mistake braces inside string literals for scope boundaries', () => {
    const out = parseToolArguments(
      '{"filePath":"a.txt","content":"function () { return {a:1} }"}',
    )
    expect(out).toEqual({
      filePath: 'a.txt',
      content: 'function () { return {a:1} }',
    })
  })

  it('closes a stream truncated mid-string (common on max_tokens)', () => {
    // Provider cut the arguments in the middle of `content` — would previously
    // fall into __rawArguments and block the whole turn.
    const out = parseToolArguments('{"filePath":"a.txt","content":"he')
    expect(out.filePath).toBe('a.txt')
    expect(typeof out.content).toBe('string')
    expect((out.content as string).startsWith('he')).toBe(true)
    expect(out[RAW_ARGUMENTS_KEY]).toBeUndefined()
  })

  it('closes unbalanced braces when the stream was cut mid-object', () => {
    const out = parseToolArguments('{"filePath":"a.txt","content":"hi","opts":{"dry":true')
    expect(out.filePath).toBe('a.txt')
    expect(out.content).toBe('hi')
    expect(out[RAW_ARGUMENTS_KEY]).toBeUndefined()
  })

  it('still falls through to __rawArguments when repair cannot produce JSON', () => {
    // Completely malformed — repair heuristics can't save it.
    const out = parseToolArguments('not even remotely json')
    expect(out[RAW_ARGUMENTS_KEY]).toBe('not even remotely json')
  })
})

describe('stripInternalToolArgMarkers', () => {
  it('removes both refusal sentinels and leaves real fields intact', () => {
    const out = stripInternalToolArgMarkers({
      filePath: 'a.txt',
      newString: 'x',
      [LENIENT_REPAIRED_TOOL_ARGS_MARKER_KEY]: true,
      [TRUNCATED_TOOL_ARGS_MARKER_KEY]: true,
    })
    expect(out).toEqual({ filePath: 'a.txt', newString: 'x' })
  })

  it('is a no-op on non-objects', () => {
    expect(stripInternalToolArgMarkers('hi')).toBe('hi')
    expect(stripInternalToolArgMarkers(null)).toBe(null)
  })
})

describe('stringifyToolInputForOpenAi', () => {
  it('strips internal refusal markers so they never ride onto the wire (replay)', () => {
    const out = stringifyToolInputForOpenAi({
      filePath: 'a.txt',
      newString: 'x',
      [LENIENT_REPAIRED_TOOL_ARGS_MARKER_KEY]: true,
    })
    const parsed = JSON.parse(out)
    expect(parsed).toEqual({ filePath: 'a.txt', newString: 'x' })
    expect(parsed[LENIENT_REPAIRED_TOOL_ARGS_MARKER_KEY]).toBeUndefined()
  })

  it('does not mutate the caller object when stripping markers', () => {
    const input = { filePath: 'a.txt', [TRUNCATED_TOOL_ARGS_MARKER_KEY]: true }
    stringifyToolInputForOpenAi(input)
    // The original object must keep its marker (we cloned before stripping).
    expect(input[TRUNCATED_TOOL_ARGS_MARKER_KEY]).toBe(true)
  })

  it('serializes an object input once', () => {
    const out = stringifyToolInputForOpenAi({ filePath: 'a.txt', content: 'hi' })
    expect(JSON.parse(out)).toEqual({ filePath: 'a.txt', content: 'hi' })
  })

  it('does NOT double-encode an already-stringified JSON input (regression)', () => {
    // History replay through a compat proxy may deliver `block.input` as a
    // string — naive `JSON.stringify(input)` would produce
    // `"\"{ \\\"filePath\\\": ... }\""` which the model sees as a quoted
    // string instead of a parseable args object.
    const stringified = '{"filePath":"a.txt","content":"hi"}'
    const out = stringifyToolInputForOpenAi(stringified)
    expect(JSON.parse(out)).toEqual({ filePath: 'a.txt', content: 'hi' })
  })

  it('coerces null/undefined to "{}" (never literally `null`)', () => {
    expect(stringifyToolInputForOpenAi(undefined)).toBe('{}')
    expect(stringifyToolInputForOpenAi(null)).toBe('{}')
  })

  it('handles nested objects and primitive scalar values inside', () => {
    const out = stringifyToolInputForOpenAi({
      foo: { bar: 1 },
      arr: [1, 'a', null],
      flag: true,
    })
    expect(JSON.parse(out)).toEqual({
      foo: { bar: 1 },
      arr: [1, 'a', null],
      flag: true,
    })
  })

  it('survives gateway-wrapped {raw_arguments} indirection', () => {
    const out = stringifyToolInputForOpenAi('{"raw_arguments":"{\\"a\\":1}"}')
    expect(JSON.parse(out)).toEqual({ a: 1 })
  })
})
