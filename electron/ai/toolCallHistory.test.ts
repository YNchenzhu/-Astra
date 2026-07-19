import { describe, it, expect, beforeEach } from 'vitest'
import {
  canonicalizeToolInput,
  createToolCallHistory,
  extractErrorSummaryFromToolResult,
  attachAdvisoryToToolResult,
  fingerprintToolCall,
  toolCallHistoryInternals,
} from './toolCallHistory'

describe('canonicalizeToolInput', () => {
  it('sorts object keys deterministically', () => {
    const a = canonicalizeToolInput({ b: 1, a: 2, c: 3 })
    const b = canonicalizeToolInput({ c: 3, b: 1, a: 2 })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('trims string values', () => {
    expect(canonicalizeToolInput({ x: '  hi  ' })).toEqual({ x: 'hi' })
  })

  it('strips transient fields', () => {
    const c = canonicalizeToolInput({
      command: 'ls',
      cwd: '/tmp',
      timeoutMs: 5000,
      runInBackground: false,
      taskId: 'abc',
      baseReadId: 'read-old',
      base_read_id: 'read-other',
    }) as Record<string, unknown>
    expect(c).toEqual({ command: 'ls', cwd: '/tmp' })
    expect(c).not.toHaveProperty('timeoutMs')
    expect(c).not.toHaveProperty('runInBackground')
    expect(c).not.toHaveProperty('taskId')
    expect(c).not.toHaveProperty('baseReadId')
    expect(c).not.toHaveProperty('base_read_id')
  })

  it('handles arrays and nested objects', () => {
    const c = canonicalizeToolInput({ xs: [3, { b: 2, a: 1 }] })
    expect(c).toEqual({ xs: [3, { a: 1, b: 2 }] })
  })

  it('handles null / undefined / primitives', () => {
    expect(canonicalizeToolInput(null)).toBe(null)
    expect(canonicalizeToolInput(undefined)).toBe(null)
    expect(canonicalizeToolInput(42)).toBe(42)
    expect(canonicalizeToolInput(true)).toBe(true)
  })

  it('drops undefined object properties', () => {
    expect(canonicalizeToolInput({ a: 1, b: undefined })).toEqual({ a: 1 })
  })
})

describe('fingerprintToolCall', () => {
  it('gives same fingerprint regardless of key order', () => {
    const a = fingerprintToolCall('Bash', { command: 'ls', cwd: '/tmp' })
    const b = fingerprintToolCall('Bash', { cwd: '/tmp', command: 'ls' })
    expect(a).toBe(b)
  })

  it('is case-insensitive on tool name', () => {
    const a = fingerprintToolCall('Bash', { command: 'ls' })
    const b = fingerprintToolCall('bash', { command: 'ls' })
    expect(a).toBe(b)
  })

  it('changes when command changes', () => {
    const a = fingerprintToolCall('Bash', { command: 'ls' })
    const b = fingerprintToolCall('Bash', { command: 'pwd' })
    expect(a).not.toBe(b)
  })

  it('ignores transient fields when fingerprinting', () => {
    const a = fingerprintToolCall('Bash', { command: 'ls', timeoutMs: 1000 })
    const b = fingerprintToolCall('Bash', { command: 'ls', timeoutMs: 999999 })
    expect(a).toBe(b)
  })

  it('ignores edit read receipt ids when fingerprinting', () => {
    const a = fingerprintToolCall('edit_file', {
      path: '/tmp/a.ts',
      old_string: 'old',
      new_string: 'new',
      baseReadId: 'read-stale',
    })
    const b = fingerprintToolCall('edit_file', {
      path: '/tmp/a.ts',
      old_string: 'old',
      new_string: 'new',
      baseReadId: 'read-current',
    })
    expect(a).toBe(b)
  })
})

describe('createToolCallHistory — repeat detection', () => {
  let h = createToolCallHistory()
  beforeEach(() => {
    h = createToolCallHistory()
  })

  const input = { command: 'python3 -c "x"' }

  it('returns null on the first call', () => {
    expect(h.checkBeforeCall('Bash', input)).toBeNull()
  })

  it('returns null after a successful call (resets)', () => {
    h.record('Bash', input, { success: false, errorSummary: 'oops' })
    h.record('Bash', input, { success: true })
    expect(h.checkBeforeCall('Bash', input)).toBeNull()
  })

  it('returns "hint" level on 2nd identical-failed attempt', () => {
    h.record('Bash', input, { success: false, errorSummary: 'Task xxx failed (exit 9009)' })
    const advice = h.checkBeforeCall('Bash', input)
    expect(advice?.level).toBe('hint')
    expect(advice?.previousFailures).toBe(1)
    expect(advice?.lastError).toContain('9009')
    expect(advice?.message).toMatch(/System advisory/)
  })

  it('returns "block" level on 3rd identical-failed attempt', () => {
    h.record('Bash', input, { success: false, errorSummary: 'fail 1' })
    h.record('Bash', input, { success: false, errorSummary: 'fail 2' })
    const advice = h.checkBeforeCall('Bash', input)
    expect(advice?.level).toBe('block')
    expect(advice?.previousFailures).toBe(2)
    expect(advice?.message).toMatch(/System block/)
  })

  it('does not cross-contaminate between distinct tool calls', () => {
    h.record('Bash', { command: 'ls /bad' }, { success: false, errorSummary: 'e' })
    h.record('Bash', { command: 'ls /bad' }, { success: false, errorSummary: 'e' })
    // Different command — should still be null.
    expect(h.checkBeforeCall('Bash', { command: 'pwd' })).toBeNull()
  })

  it('honours custom thresholds', () => {
    const strict = createToolCallHistory({ hintThreshold: 2, blockThreshold: 3 })
    strict.record('t', { x: 1 }, { success: false, errorSummary: 'e' })
    expect(strict.checkBeforeCall('t', { x: 1 })).toBeNull() // 1 fail < 2
    strict.record('t', { x: 1 }, { success: false, errorSummary: 'e' })
    expect(strict.checkBeforeCall('t', { x: 1 })?.level).toBe('hint') // 2 fails
    strict.record('t', { x: 1 }, { success: false, errorSummary: 'e' })
    expect(strict.checkBeforeCall('t', { x: 1 })?.level).toBe('block') // 3 fails
  })

  it('truncates long error summaries in stored state', () => {
    const huge = 'x'.repeat(toolCallHistoryInternals.MAX_ERROR_SUMMARY + 200)
    h.record('Bash', input, { success: false, errorSummary: huge })
    const entry = h.snapshot()[0]
    expect(entry.lastOutcome.errorSummary!.length).toBeLessThanOrEqual(
      toolCallHistoryInternals.MAX_ERROR_SUMMARY,
    )
    expect(entry.lastOutcome.errorSummary).toMatch(/…$/)
  })

  it('evicts oldest entries beyond maxEntries', () => {
    const small = createToolCallHistory({ maxEntries: 4 })
    for (let i = 0; i < 10; i++) {
      small.record('Bash', { command: `cmd-${i}` }, { success: false, errorSummary: 'e' })
    }
    expect(small.snapshot().length).toBe(4)
  })

  it('reset() clears all tracked state', () => {
    h.record('Bash', input, { success: false, errorSummary: 'e' })
    h.reset()
    expect(h.snapshot().length).toBe(0)
    expect(h.checkBeforeCall('Bash', input)).toBeNull()
  })
})

describe('extractErrorSummaryFromToolResult', () => {
  it('extracts body after "Error:" prefix', () => {
    const s = extractErrorSummaryFromToolResult({ content: 'Error: boom' })
    expect(s).toBe('boom')
  })

  it('returns undefined for success content', () => {
    expect(extractErrorSummaryFromToolResult({ content: 'All good' })).toBeUndefined()
  })

  it('returns undefined when content is not a string', () => {
    expect(extractErrorSummaryFromToolResult({ content: 42 })).toBeUndefined()
  })
})

describe('attachAdvisoryToToolResult', () => {
  it('decorates failure results INSIDE the Error: prefix', () => {
    const out = attachAdvisoryToToolResult(
      { type: 'tool_result', tool_use_id: 't', content: 'Error: original detail' },
      '[System advisory] do not retry',
    )
    expect(out.content).toMatch(/^Error:/) // preserves prefix
    expect(out.content).toContain('[System advisory]')
    expect(out.content).toContain('original detail')
  })

  it('decorates success results as a leading block', () => {
    const out = attachAdvisoryToToolResult(
      { type: 'tool_result', tool_use_id: 't', content: 'ok' },
      '[System advisory] note',
    )
    expect(out.content).toMatch(/^\[System advisory\]/)
  })

  it('leaves non-string content unchanged', () => {
    const block = { type: 'tool_result', tool_use_id: 't', content: 42 }
    expect(attachAdvisoryToToolResult(block, 'x')).toBe(block)
  })
})
