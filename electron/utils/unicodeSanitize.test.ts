import { describe, it, expect } from 'vitest'
import {
  replaceUnpairedSurrogates,
  safeSliceCodeUnits,
  safeSliceTailCodeUnits,
  sanitizeMessagesForWire,
} from './unicodeSanitize'

const HIGH = '\uD83D' // leading half of 😀 (U+1F600)
const LOW = '\uDE00' // trailing half of 😀
const EMOJI = '\uD83D\uDE00' // 😀

describe('replaceUnpairedSurrogates', () => {
  it('returns the original reference for clean input', () => {
    const s = 'plain ASCII'
    expect(replaceUnpairedSurrogates(s)).toBe(s)
    const cjk = '中文测试 — 1234'
    expect(replaceUnpairedSurrogates(cjk)).toBe(cjk)
  })

  it('preserves valid surrogate pairs (emoji)', () => {
    const s = `hello ${EMOJI} world ${EMOJI}`
    expect(replaceUnpairedSurrogates(s)).toBe(s)
  })

  it('replaces a lone high surrogate at end-of-string with U+FFFD', () => {
    const bad = `abc ${HIGH}`
    expect(replaceUnpairedSurrogates(bad)).toBe('abc \uFFFD')
  })

  it('replaces a lone high surrogate followed by a non-low char', () => {
    const bad = `${HIGH}x`
    expect(replaceUnpairedSurrogates(bad)).toBe('\uFFFDx')
  })

  it('replaces a lone low surrogate', () => {
    const bad = `${LOW}x`
    expect(replaceUnpairedSurrogates(bad)).toBe('\uFFFDx')
  })

  it('handles mixed valid and invalid surrogates', () => {
    const bad = `${EMOJI}${HIGH}${EMOJI}${LOW}`
    expect(replaceUnpairedSurrogates(bad)).toBe(`${EMOJI}\uFFFD${EMOJI}\uFFFD`)
  })

  it('is idempotent', () => {
    const bad = `${HIGH}foo${LOW}`
    const once = replaceUnpairedSurrogates(bad)
    const twice = replaceUnpairedSurrogates(once)
    expect(twice).toBe(once)
  })

  it('output round-trips through serde_json-strict regex check', () => {
    // After sanitisation, JSON.stringify must not produce any \uD8xx-\uDBxx
    // escape that is not immediately followed by \uDCxx-\uDFxx.
    const bad = `head ${HIGH} mid ${LOW} ${EMOJI} tail`
    const cleaned = replaceUnpairedSurrogates(bad)
    const json = JSON.stringify(cleaned)
    const offending = /\\u[dD][89aAbB][0-9a-fA-F]{2}(?!\\u[dD][c-fC-F][0-9a-fA-F]{2})/.exec(
      json,
    )
    expect(offending).toBeNull()
  })
})

describe('safeSliceCodeUnits', () => {
  it('returns prefix when the cut is on a safe boundary', () => {
    expect(safeSliceCodeUnits('abcdef', 3)).toBe('abc')
  })

  it('returns the whole string when n >= length', () => {
    const s = 'abc'
    expect(safeSliceCodeUnits(s, 10)).toBe(s)
  })

  it('returns empty string for n <= 0 or NaN', () => {
    expect(safeSliceCodeUnits('abc', 0)).toBe('')
    expect(safeSliceCodeUnits('abc', -1)).toBe('')
    expect(safeSliceCodeUnits('abc', Number.NaN)).toBe('')
  })

  it('backs off when the cut would land between a surrogate pair', () => {
    // 'a' + EMOJI = 'a' + HIGH + LOW. Slicing to length 2 would put 'a' + HIGH
    // in the result — a lone surrogate. We expect just 'a' instead.
    const s = `a${EMOJI}`
    expect(safeSliceCodeUnits(s, 2)).toBe('a')
  })

  it('keeps the full pair when the cut is at the END of a pair', () => {
    const s = `a${EMOJI}b`
    expect(safeSliceCodeUnits(s, 3)).toBe(`a${EMOJI}`)
  })

  it('never produces a lone surrogate', () => {
    const s = `${EMOJI}${EMOJI}${EMOJI}`
    for (let n = 0; n <= s.length + 1; n++) {
      const out = safeSliceCodeUnits(s, n)
      // No char in `out` should be an unpaired surrogate.
      expect(replaceUnpairedSurrogates(out)).toBe(out)
    }
  })
})

describe('safeSliceTailCodeUnits', () => {
  it('returns suffix on a safe boundary', () => {
    expect(safeSliceTailCodeUnits('abcdef', 3)).toBe('def')
  })

  it('drops a leading low surrogate', () => {
    // EMOJI + 'b' — taking last 2 code units would give LOW + 'b'.
    const s = `${EMOJI}b`
    expect(safeSliceTailCodeUnits(s, 2)).toBe('b')
  })

  it('returns whole string when n >= length', () => {
    expect(safeSliceTailCodeUnits('abc', 10)).toBe('abc')
  })
})

describe('sanitizeMessagesForWire', () => {
  it('returns the original reference when nothing is dirty', () => {
    const m = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hello ' + EMOJI },
          { type: 'tool_result', tool_use_id: 'tu_1', content: '中文 ok' },
        ],
      },
    ]
    expect(sanitizeMessagesForWire(m)).toBe(m)
  })

  it('walks tool_result content and replaces lone surrogates', () => {
    const m = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_1',
            content: `WebSearch desc with ${HIGH} cut`,
          },
        ],
      },
    ]
    const out = sanitizeMessagesForWire(m) as typeof m
    expect(out).not.toBe(m)
    const block = out[0].content[0] as { content: string }
    expect(block.content).toBe('WebSearch desc with \uFFFD cut')
    // Original message untouched.
    const origBlock = m[0].content[0] as { content: string }
    expect(origBlock.content).toBe(`WebSearch desc with ${HIGH} cut`)
  })

  it('walks nested text blocks inside content arrays', () => {
    const m = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: `pre ${LOW} post` },
          { type: 'tool_use', id: 'tu', name: 'WebSearch', input: { q: `q ${HIGH}` } },
        ],
      },
    ]
    const out = sanitizeMessagesForWire(m) as Array<{
      content: Array<Record<string, unknown>>
    }>
    expect((out[0].content[0] as { text: string }).text).toBe('pre \uFFFD post')
    expect(
      ((out[0].content[1] as { input: Record<string, string> }).input).q,
    ).toBe('q \uFFFD')
  })

  it('leaves non-plain-object class instances alone', () => {
    const date = new Date()
    const m = [{ role: 'user', content: 'ok', meta: date }]
    const out = sanitizeMessagesForWire(m) as typeof m
    expect(out[0].meta).toBe(date)
  })
})
