/**
 * Baseline / verification-comparison report renderer.
 *
 * Reads a list of {@link PromptDiagnosticsRecord} (typically the most
 * recent N from a single conversation) and produces a markdown report
 * with per-run metrics + p50/p95 aggregates.
 *
 * Pure function — no FS / IPC / Date.now() calls. The CLI / IPC layer
 * is responsible for collecting records and writing the rendered string
 * to disk; this module owns formatting + statistics only so it can be
 * unit-tested deterministically.
 */

import type { PromptDiagnosticsRecord } from '../context/promptDiagnostics'

export interface BaselineReportOptions {
  /** Title of the report, e.g. `"Baseline 2026-05-20"`. */
  title: string
  /** Prompt text these runs share — surfaced verbatim in the report header. */
  prompt: string
  /** Optional notes the operator wants surfaced (env flags, settings, etc.). */
  notes?: string
  /** Timestamp string for the header. Defaults to ISO format of `Date.now()`. */
  generatedAt?: string
}

interface AggregateStats {
  count: number
  p50: number
  p95: number
  mean: number
  min: number
  max: number
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

function aggregate(values: number[]): AggregateStats {
  const filtered = values.filter((v) => Number.isFinite(v) && v >= 0)
  if (filtered.length === 0) {
    return { count: 0, p50: 0, p95: 0, mean: 0, min: 0, max: 0 }
  }
  const sum = filtered.reduce((acc, v) => acc + v, 0)
  return {
    count: filtered.length,
    p50: percentile(filtered, 50),
    p95: percentile(filtered, 95),
    mean: sum / filtered.length,
    min: Math.min(...filtered),
    max: Math.max(...filtered),
  }
}

function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 10_000) return `${(n / 1000).toFixed(0)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(Math.round(n))
}

function fmtMs(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—'
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}s`
  return `${Math.round(n)}ms`
}

function fmtPercent(n: number): string {
  if (!Number.isFinite(n)) return '—'
  return `${(n * 100).toFixed(0)}%`
}

function cacheHitRate(record: PromptDiagnosticsRecord): number {
  const usage = record.usage
  if (!usage || usage.totalInputWithCache <= 0) return 0
  return usage.cacheReadInputTokens / usage.totalInputWithCache
}

/**
 * Render a markdown report from the given records.
 *
 * Records are expected in REVERSE-chronological order (newest first),
 * which is what {@link getPromptDiagnosticsRecords} returns. This
 * function re-sorts them oldest-first for readability so iteration 1
 * appears at the top of the per-run table.
 */
export function formatBaselineReport(
  records: PromptDiagnosticsRecord[],
  options: BaselineReportOptions,
): string {
  const sorted = [...records].sort((a, b) => a.timing.startedAt - b.timing.startedAt)
  const generatedAt = options.generatedAt ?? new Date().toISOString()

  const lines: string[] = []
  lines.push(`# ${options.title}`)
  lines.push('')
  lines.push(`Generated: ${generatedAt}`)
  lines.push(`Runs: ${sorted.length}`)
  lines.push('')
  lines.push('## Prompt')
  lines.push('')
  lines.push('```')
  lines.push(options.prompt.trim())
  lines.push('```')
  lines.push('')
  if (options.notes?.trim()) {
    lines.push('## Notes')
    lines.push('')
    lines.push(options.notes.trim())
    lines.push('')
  }

  lines.push('## Per-run metrics')
  lines.push('')
  lines.push('| # | model | status | TTFB | total | input | output | cache R/W | hit | sys | meta | tools | diagnosis |')
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|')

  sorted.forEach((record, idx) => {
    const usage = record.usage
    const row = [
      String(idx + 1),
      record.model,
      record.status,
      fmtMs(record.timing.ttfbMs ?? NaN),
      fmtMs(record.timing.totalMs ?? NaN),
      usage ? fmtTokens(usage.inputTokens) : '—',
      usage ? fmtTokens(usage.outputTokens) : '—',
      usage
        ? `${fmtTokens(usage.cacheReadInputTokens)} / ${fmtTokens(usage.cacheCreationInputTokens)}`
        : '— / —',
      fmtPercent(cacheHitRate(record)),
      fmtTokens(record.payload.systemPromptTokens),
      fmtTokens(record.payload.userMetaTokens),
      fmtTokens(record.payload.toolSchemaTokens),
      record.diagnosis.join('; '),
    ]
    lines.push(`| ${row.join(' | ')} |`)
  })

  const ttfbStats = aggregate(sorted.map((r) => r.timing.ttfbMs ?? NaN))
  const totalStats = aggregate(sorted.map((r) => r.timing.totalMs ?? NaN))
  const inputStats = aggregate(sorted.map((r) => r.usage?.inputTokens ?? NaN))
  const outputStats = aggregate(sorted.map((r) => r.usage?.outputTokens ?? NaN))
  const cacheReadStats = aggregate(sorted.map((r) => r.usage?.cacheReadInputTokens ?? NaN))
  const cacheCreateStats = aggregate(sorted.map((r) => r.usage?.cacheCreationInputTokens ?? NaN))
  const hitRateStats = aggregate(sorted.map((r) => cacheHitRate(r)))

  lines.push('')
  lines.push('## Aggregates')
  lines.push('')
  lines.push('| metric | p50 | p95 | mean | min | max |')
  lines.push('|---|---|---|---|---|---|')
  lines.push(
    `| TTFB | ${fmtMs(ttfbStats.p50)} | ${fmtMs(ttfbStats.p95)} | ${fmtMs(ttfbStats.mean)} | ${fmtMs(ttfbStats.min)} | ${fmtMs(ttfbStats.max)} |`,
  )
  lines.push(
    `| total | ${fmtMs(totalStats.p50)} | ${fmtMs(totalStats.p95)} | ${fmtMs(totalStats.mean)} | ${fmtMs(totalStats.min)} | ${fmtMs(totalStats.max)} |`,
  )
  lines.push(
    `| input tokens | ${fmtTokens(inputStats.p50)} | ${fmtTokens(inputStats.p95)} | ${fmtTokens(inputStats.mean)} | ${fmtTokens(inputStats.min)} | ${fmtTokens(inputStats.max)} |`,
  )
  lines.push(
    `| output tokens | ${fmtTokens(outputStats.p50)} | ${fmtTokens(outputStats.p95)} | ${fmtTokens(outputStats.mean)} | ${fmtTokens(outputStats.min)} | ${fmtTokens(outputStats.max)} |`,
  )
  lines.push(
    `| cache read | ${fmtTokens(cacheReadStats.p50)} | ${fmtTokens(cacheReadStats.p95)} | ${fmtTokens(cacheReadStats.mean)} | ${fmtTokens(cacheReadStats.min)} | ${fmtTokens(cacheReadStats.max)} |`,
  )
  lines.push(
    `| cache write | ${fmtTokens(cacheCreateStats.p50)} | ${fmtTokens(cacheCreateStats.p95)} | ${fmtTokens(cacheCreateStats.mean)} | ${fmtTokens(cacheCreateStats.min)} | ${fmtTokens(cacheCreateStats.max)} |`,
  )
  lines.push(
    `| cache hit rate | ${fmtPercent(hitRateStats.p50)} | ${fmtPercent(hitRateStats.p95)} | ${fmtPercent(hitRateStats.mean)} | ${fmtPercent(hitRateStats.min)} | ${fmtPercent(hitRateStats.max)} |`,
  )

  const failures = sorted.filter((r) => r.status === 'error')
  if (failures.length > 0) {
    lines.push('')
    lines.push('## Errors')
    lines.push('')
    for (const f of failures) {
      lines.push(`- iter ${f.iteration}: ${f.error ?? '(no error message)'}`)
    }
  }

  lines.push('')
  return lines.join('\n')
}

/**
 * Compute a side-by-side comparison between a baseline run and the
 * current run for use in Phase H. Returns markdown with the deltas
 * highlighted.
 *
 * `kpis` are extracted in the same shape as {@link formatBaselineReport}
 * aggregates so the renderer is reusable. The function is pure so
 * Phase H tests can pass fixture inputs without touching disk.
 */
export interface BaselineComparisonInput {
  title: string
  baselineLabel: string
  currentLabel: string
  baseline: PromptDiagnosticsRecord[]
  current: PromptDiagnosticsRecord[]
}

export function formatBaselineComparison(input: BaselineComparisonInput): string {
  const stat = (records: PromptDiagnosticsRecord[]) => ({
    ttfb: aggregate(records.map((r) => r.timing.ttfbMs ?? NaN)),
    total: aggregate(records.map((r) => r.timing.totalMs ?? NaN)),
    input: aggregate(records.map((r) => r.usage?.inputTokens ?? NaN)),
    output: aggregate(records.map((r) => r.usage?.outputTokens ?? NaN)),
    cacheRead: aggregate(records.map((r) => r.usage?.cacheReadInputTokens ?? NaN)),
    cacheWrite: aggregate(records.map((r) => r.usage?.cacheCreationInputTokens ?? NaN)),
    hitRate: aggregate(records.map((r) => cacheHitRate(r))),
  })
  const before = stat(input.baseline)
  const after = stat(input.current)

  const fmtSignedMs = (n: number): string => {
    if (!Number.isFinite(n)) return '—'
    if (n === 0) return '0ms'
    const abs = Math.abs(n)
    const formatted = abs >= 1000 ? `${(abs / 1000).toFixed(abs >= 10_000 ? 0 : 1)}s` : `${Math.round(abs)}ms`
    return n < 0 ? `-${formatted}` : formatted
  }
  const fmtSignedTokens = (n: number): string => {
    if (!Number.isFinite(n)) return '—'
    if (n === 0) return '0'
    const abs = Math.abs(n)
    const formatted = abs >= 10_000
      ? `${(abs / 1000).toFixed(0)}k`
      : abs >= 1000
        ? `${(abs / 1000).toFixed(1)}k`
        : String(Math.round(abs))
    return n < 0 ? `-${formatted}` : formatted
  }
  const fmtSignedPercent = (n: number): string => {
    if (!Number.isFinite(n)) return '—'
    if (n === 0) return '0%'
    const pct = Math.round(n * 100)
    return pct > 0 ? `+${pct}%` : `${pct}%`
  }
  const fmtDelta = (
    a: number,
    b: number,
    fmtAbs: (n: number) => string,
    fmtDiff: (n: number) => string,
  ): string => {
    if (!Number.isFinite(a) || !Number.isFinite(b)) return '—'
    const diff = b - a
    const sign = diff > 0 ? '+' : ''
    return `${fmtAbs(b)} (${sign}${fmtDiff(diff)})`
  }

  const lines: string[] = []
  lines.push(`# ${input.title}`)
  lines.push('')
  lines.push(`| metric | ${input.baselineLabel} (p50/p95) | ${input.currentLabel} (p50/p95) |`)
  lines.push(`|---|---|---|`)
  lines.push(
    `| TTFB | ${fmtMs(before.ttfb.p50)} / ${fmtMs(before.ttfb.p95)} | ${fmtDelta(before.ttfb.p50, after.ttfb.p50, fmtMs, fmtSignedMs)} / ${fmtDelta(before.ttfb.p95, after.ttfb.p95, fmtMs, fmtSignedMs)} |`,
  )
  lines.push(
    `| total | ${fmtMs(before.total.p50)} / ${fmtMs(before.total.p95)} | ${fmtDelta(before.total.p50, after.total.p50, fmtMs, fmtSignedMs)} / ${fmtDelta(before.total.p95, after.total.p95, fmtMs, fmtSignedMs)} |`,
  )
  lines.push(
    `| input | ${fmtTokens(before.input.p50)} / ${fmtTokens(before.input.p95)} | ${fmtDelta(before.input.p50, after.input.p50, fmtTokens, fmtSignedTokens)} / ${fmtDelta(before.input.p95, after.input.p95, fmtTokens, fmtSignedTokens)} |`,
  )
  lines.push(
    `| output | ${fmtTokens(before.output.p50)} / ${fmtTokens(before.output.p95)} | ${fmtDelta(before.output.p50, after.output.p50, fmtTokens, fmtSignedTokens)} / ${fmtDelta(before.output.p95, after.output.p95, fmtTokens, fmtSignedTokens)} |`,
  )
  lines.push(
    `| cache read | ${fmtTokens(before.cacheRead.p50)} / ${fmtTokens(before.cacheRead.p95)} | ${fmtDelta(before.cacheRead.p50, after.cacheRead.p50, fmtTokens, fmtSignedTokens)} / ${fmtDelta(before.cacheRead.p95, after.cacheRead.p95, fmtTokens, fmtSignedTokens)} |`,
  )
  lines.push(
    `| cache write | ${fmtTokens(before.cacheWrite.p50)} / ${fmtTokens(before.cacheWrite.p95)} | ${fmtDelta(before.cacheWrite.p50, after.cacheWrite.p50, fmtTokens, fmtSignedTokens)} / ${fmtDelta(before.cacheWrite.p95, after.cacheWrite.p95, fmtTokens, fmtSignedTokens)} |`,
  )
  lines.push(
    `| cache hit rate | ${fmtPercent(before.hitRate.p50)} / ${fmtPercent(before.hitRate.p95)} | ${fmtDelta(before.hitRate.p50, after.hitRate.p50, fmtPercent, fmtSignedPercent)} / ${fmtDelta(before.hitRate.p95, after.hitRate.p95, fmtPercent, fmtSignedPercent)} |`,
  )
  lines.push('')
  return lines.join('\n')
}
