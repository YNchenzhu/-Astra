import { describe, expect, it } from 'vitest'
import type { PromptDiagnosticsRecord } from '../context/promptDiagnostics'
import { formatBaselineComparison, formatBaselineReport } from './baselineReport'

function fakeRecord(
  iteration: number,
  startedAt: number,
  overrides: Partial<PromptDiagnosticsRecord> = {},
): PromptDiagnosticsRecord {
  return {
    requestId: `diag-${iteration}`,
    conversationId: 'conv-x',
    providerId: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    iteration,
    status: 'success',
    payload: {
      systemPromptTokens: 5000,
      systemContextTokens: 4000,
      userContextTokens: 500,
      userMetaTokens: 500,
      toolSchemaTokens: 1200,
      messageTokens: 800,
      messageCount: 2,
      hashes: { systemPrompt: 'abcd' },
      cacheControl: { systemContext: true, messageLevel: false },
    },
    thinking: { alwaysThinking: false },
    usage: {
      inputTokens: 200,
      outputTokens: 80,
      cacheReadInputTokens: 4500,
      cacheCreationInputTokens: 0,
      totalInputWithCache: 4700,
    },
    timing: {
      startedAt,
      firstResponseAt: startedAt + 1500,
      endedAt: startedAt + 4000,
      ttfbMs: 1500,
      totalMs: 4000,
    },
    diagnosis: ['no obvious prompt-side bottleneck'],
    ...overrides,
  }
}

describe('formatBaselineReport', () => {
  it('renders header, per-run table, and aggregate block with p50/p95 metrics', () => {
    const records = [fakeRecord(1, 1000), fakeRecord(2, 2000), fakeRecord(3, 3000)]
    const report = formatBaselineReport(records, {
      title: 'Baseline Test',
      prompt: 'sample prompt body',
      generatedAt: '2026-05-20T00:00:00.000Z',
    })

    expect(report).toContain('# Baseline Test')
    expect(report).toContain('Generated: 2026-05-20T00:00:00.000Z')
    expect(report).toContain('Runs: 3')
    expect(report).toContain('sample prompt body')
    expect(report).toContain('## Per-run metrics')
    expect(report).toContain('## Aggregates')
    expect(report).toContain('| TTFB |')
    expect(report).toContain('| cache hit rate |')
    expect(report.split('\n').filter((l) => l.startsWith('| 1 |'))).toHaveLength(1)
  })

  it('sorts records oldest-first regardless of input order', () => {
    const records = [fakeRecord(3, 3000), fakeRecord(1, 1000), fakeRecord(2, 2000)]
    const report = formatBaselineReport(records, {
      title: 'Order Check',
      prompt: 'p',
      generatedAt: 'now',
    })
    const lines = report.split('\n').filter((l) => /^\| \d+ \|/.test(l))
    expect(lines[0]).toContain('| 1 |')
    expect(lines[1]).toContain('| 2 |')
    expect(lines[2]).toContain('| 3 |')
  })

  it('flags failed runs in a dedicated section', () => {
    const records = [
      fakeRecord(1, 1000),
      fakeRecord(2, 2000, { status: 'error', error: 'context overflow' }),
    ]
    const report = formatBaselineReport(records, {
      title: 'Failures',
      prompt: 'p',
      generatedAt: 'now',
    })
    expect(report).toContain('## Errors')
    expect(report).toContain('context overflow')
  })

  it('handles empty record list without throwing', () => {
    const report = formatBaselineReport([], {
      title: 'Empty',
      prompt: 'nothing yet',
      generatedAt: 'now',
    })
    expect(report).toContain('Runs: 0')
    expect(report).toContain('## Aggregates')
  })

  it('includes notes when provided', () => {
    const report = formatBaselineReport([fakeRecord(1, 1000)], {
      title: 'Notes',
      prompt: 'p',
      notes: 'effortLevel=low, alwaysThinking=false',
      generatedAt: 'now',
    })
    expect(report).toContain('## Notes')
    expect(report).toContain('effortLevel=low')
  })
})

describe('formatBaselineComparison', () => {
  it('renders side-by-side baseline vs current with deltas', () => {
    const baseline = [
      fakeRecord(1, 1000, { timing: { startedAt: 1000, ttfbMs: 10_000, totalMs: 20_000 } }),
      fakeRecord(2, 2000, { timing: { startedAt: 2000, ttfbMs: 12_000, totalMs: 22_000 } }),
    ]
    const current = [
      fakeRecord(1, 5000, { timing: { startedAt: 5000, ttfbMs: 1500, totalMs: 4000 } }),
      fakeRecord(2, 6000, { timing: { startedAt: 6000, ttfbMs: 1800, totalMs: 4500 } }),
    ]
    const md = formatBaselineComparison({
      title: 'Phase H',
      baselineLabel: 'before',
      currentLabel: 'after',
      baseline,
      current,
    })
    expect(md).toContain('# Phase H')
    expect(md).toMatch(/before \(p50\/p95\)/)
    expect(md).toMatch(/after \(p50\/p95\)/)
    // Delta string format: `(+/-Xms)`
    expect(md).toMatch(/\([+-]\d/u)
  })
})
