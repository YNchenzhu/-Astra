/**
 * 2026-07 auto-compact reentry guard (cc-haha `shouldSkipRecompactionReentry`
 * parity) — regression tests.
 *
 * Failure mode pre-guard: a SUCCESSFUL LLM auto-compact that still lands at
 * or above `autoCompactTokens` (the summary itself is the bulk) re-armed the
 * auto tier on every subsequent `evaluate()`. Each pass "succeeded", so the
 * `consecutiveCompactFailures` breaker never fired — the loop paid one LLM
 * summary call per iteration for ~zero reclaim. The guard records the
 * post-compact estimate and skips the auto tier until the transcript grows
 * past it by `AUTO_COMPACT_REENTRY_GROWTH_RATIO` (new material worth
 * folding), falling through to the cheap micro tier instead.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ContextManager } from './manager'
import { autoCompact, type CompactOptions } from './compact'
import { silenceExpectedConsoleWarnAndError } from '../testHelpers/silenceExpectedConsole'

vi.mock('./compact', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./compact')>()
  return {
    ...actual,
    autoCompact: vi.fn(),
  }
})

// Session-memory compact runs before the LLM path inside the auto tier;
// force it to decline so every auto-tier pass reaches the mocked
// `autoCompact` (the path under test).
vi.mock('./sessionMemoryCompact', () => ({
  trySessionMemoryCompact: vi.fn(async () => null),
}))

silenceExpectedConsoleWarnAndError()

function emptyCompactConfig(): CompactOptions['config'] {
  return {} as unknown as CompactOptions['config']
}

/** Thresholds tuned so the auto tier fires first and micro is the fallback tier. */
function newManager(): ContextManager {
  return new ContextManager({
    warningTokens: 5,
    errorTokens: 6,
    historySnipTokens: 999_999,
    microCompactTokens: 15,
    autoCompactTokens: 20,
    blockingTokens: 999_999,
  })
}

/** ~50 estimated tokens (chars/4) — comfortably above autoCompactTokens=20. */
const BIG_MSGS = [{ role: 'user', content: 'x'.repeat(200) }]

function compactOpts(msgs: Array<Record<string, unknown>>): CompactOptions {
  return {
    config: emptyCompactConfig(),
    model: 'test',
    systemPrompt: '',
    messages: msgs,
    signal: new AbortController().signal,
  } as CompactOptions
}

beforeEach(() => {
  vi.mocked(autoCompact).mockReset()
})

describe('auto-compact reentry guard', () => {
  it('skips the auto tier after a successful compact that stays above threshold', async () => {
    const mgr = newManager()
    // Compact "succeeds" but returns the transcript unchanged — the
    // post-compact estimate stays above autoCompactTokens.
    vi.mocked(autoCompact).mockImplementation(async (opts) => ({
      messages: (opts as { messages: Array<Record<string, unknown>> }).messages,
      summary: 'mock summary',
    }) as Awaited<ReturnType<typeof autoCompact>>)

    const first = await mgr.handleContext(BIG_MSGS, '', compactOpts(BIG_MSGS))
    expect(first.wasCompacted).toBe(true)
    expect(vi.mocked(autoCompact)).toHaveBeenCalledTimes(1)

    // Same transcript again: pre-guard this re-entered the auto tier and
    // paid another LLM call. Post-guard it falls through to micro.
    const evalAfter = mgr.evaluate(BIG_MSGS, '')
    expect(evalAfter.action).toBe('micro_compact')

    await mgr.handleContext(BIG_MSGS, '', compactOpts(BIG_MSGS))
    expect(vi.mocked(autoCompact)).toHaveBeenCalledTimes(1) // no second LLM call
  })

  it('re-arms once the transcript grows past the growth-escape ratio', async () => {
    const mgr = newManager()
    vi.mocked(autoCompact).mockImplementation(async (opts) => ({
      messages: (opts as { messages: Array<Record<string, unknown>> }).messages,
      summary: 'mock summary',
    }) as Awaited<ReturnType<typeof autoCompact>>)

    await mgr.handleContext(BIG_MSGS, '', compactOpts(BIG_MSGS))
    expect(mgr.evaluate(BIG_MSGS, '').action).toBe('micro_compact')

    // 4× the original content — way past the 1.1 growth ratio: genuinely
    // new material arrived, so a fresh summary pass is worth it again.
    const grown = [{ role: 'user', content: 'x'.repeat(800) }]
    expect(mgr.evaluate(grown, '').action).toBe('auto_compact')
  })

  it('does not arm when the compact lands below the threshold', async () => {
    const mgr = newManager()
    // Compact genuinely worked — post-compact estimate is tiny.
    vi.mocked(autoCompact).mockImplementation(async () => ({
      messages: [{ role: 'user', content: 'small' }],
      summary: 'mock summary',
    }) as Awaited<ReturnType<typeof autoCompact>>)

    await mgr.handleContext(BIG_MSGS, '', compactOpts(BIG_MSGS))

    // A later big transcript must hit the auto tier again — the guard only
    // holds when the PREVIOUS compact failed to get below the threshold.
    expect(mgr.evaluate(BIG_MSGS, '').action).toBe('auto_compact')
  })
})
