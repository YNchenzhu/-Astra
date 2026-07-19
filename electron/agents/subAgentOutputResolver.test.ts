import { describe, it, expect } from 'vitest'
import {
  resolveSubAgentReportedOutput,
  resolveSubAgentReportedOutputDetail,
  subAgentProducedUsableReport,
  SUBAGENT_OUTPUT_FALLBACK_MAX_CHARS,
  SUBAGENT_MIN_REPORT_CHARS,
} from './subAgentOutputResolver'

describe('subAgentProducedUsableReport', () => {
  const long = 'x'.repeat(SUBAGENT_MIN_REPORT_CHARS)

  it('true when lastFinalText meets the report floor', () => {
    expect(subAgentProducedUsableReport({ lastFinalText: long })).toBe(true)
  })

  it('true when the transcript last-assistant text meets the floor', () => {
    expect(
      subAgentProducedUsableReport({
        lastFinalText: '',
        transcriptLastAssistantText: long,
      }),
    ).toBe(true)
  })

  it('false for a short "Now let me…" fragment below the floor', () => {
    expect(
      subAgentProducedUsableReport({ lastFinalText: 'Now let me read the file' }),
    ).toBe(false)
  })

  it('false when nothing was committed', () => {
    expect(subAgentProducedUsableReport({ lastFinalText: '   ' })).toBe(false)
  })
})

describe('resolveSubAgentReportedOutputDetail — fallback priority', () => {
  const baseParams = {
    lastFinalText: '',
    transcriptLastAssistantText: '',
    outputText: '',
    latestTextOutput: '',
    reachedMaxIterations: false,
  } as const

  it('prefers lastFinalText (tier 1) over all other sources', () => {
    const out = resolveSubAgentReportedOutputDetail({
      ...baseParams,
      lastFinalText: 'tier-1 final',
      transcriptLastAssistantText: 'tier-2 transcript',
      outputText: 'tier-3 stream',
      latestTextOutput: 'tier-4 store',
    })
    expect(out.body).toBe('tier-1 final')
  })

  // upstream parity: new fallback slot — when the tool-free final turn
  // didn't fire (tool-only run hit maxTurns mid-tool-call), the
  // transcript walkback's most-recent assistant text is preferred
  // over the streaming buffer.
  it('uses transcriptLastAssistantText (tier 2) when lastFinalText is empty', () => {
    const out = resolveSubAgentReportedOutputDetail({
      ...baseParams,
      transcriptLastAssistantText: 'tier-2 transcript',
      outputText: 'tier-3 stream',
      latestTextOutput: 'tier-4 store',
    })
    expect(out.body).toBe('tier-2 transcript')
  })

  it('falls through to outputText (tier 3) when both lastFinalText and transcript are empty', () => {
    const out = resolveSubAgentReportedOutputDetail({
      ...baseParams,
      outputText: 'tier-3 stream',
      latestTextOutput: 'tier-4 store',
    })
    expect(out.body).toBe('tier-3 stream')
  })

  it('falls through to latestTextOutput (tier 4) when everything else is empty', () => {
    const out = resolveSubAgentReportedOutputDetail({
      ...baseParams,
      latestTextOutput: 'tier-4 store',
    })
    expect(out.body).toBe('tier-4 store')
  })

  it('emits the maxIterations placeholder when no source has text', () => {
    const out = resolveSubAgentReportedOutputDetail({
      ...baseParams,
      reachedMaxIterations: true,
    })
    expect(out.body).toMatch(/iteration limit/i)
    expect(out.originalCharCount).toBe(0)
    expect(out.charTruncated).toBe(false)
  })

  it('emits the plain placeholder when no source has text and no abnormal exit fired', () => {
    const out = resolveSubAgentReportedOutputDetail(baseParams)
    expect(out.body).toBe('Agent completed without output.')
  })

  it('appends the iteration-limit footer to the chosen body (any tier)', () => {
    const out = resolveSubAgentReportedOutputDetail({
      ...baseParams,
      transcriptLastAssistantText: 'I started reading foo.ts but ran out of turns.',
      reachedMaxIterations: true,
    })
    expect(out.body.startsWith('I started reading foo.ts')).toBe(true)
    expect(out.body).toMatch(/Stopped at iteration limit/)
  })

  it('appends the abort footer with the supplied reason', () => {
    const out = resolveSubAgentReportedOutputDetail({
      ...baseParams,
      transcriptLastAssistantText: 'partial findings',
      aborted: true,
      abortReason: 'wall-clock budget exhausted',
    })
    expect(out.body).toContain('partial findings')
    expect(out.body).toContain('wall-clock budget exhausted')
    expect(out.body).toContain('content above may be partial')
  })

  it('reports the transcript original char count and truncates at the configured cap', () => {
    const huge = 'x'.repeat(SUBAGENT_OUTPUT_FALLBACK_MAX_CHARS + 5_000)
    const out = resolveSubAgentReportedOutputDetail({
      ...baseParams,
      transcriptLastAssistantText: huge,
    })
    expect(out.charTruncated).toBe(true)
    expect(out.originalCharCount).toBe(huge.length)
    expect(out.body).toContain('truncated to last')
  })
})

describe('resolveSubAgentReportedOutput (string wrapper)', () => {
  it('passes the transcriptLastAssistantText through to the detail resolver', () => {
    expect(
      resolveSubAgentReportedOutput({
        lastFinalText: '',
        transcriptLastAssistantText: 'walkback hit',
        outputText: 'stream junk',
        reachedMaxIterations: false,
      }),
    ).toBe('walkback hit')
  })

  it('preserves backwards-compatibility: callers that omit the new field still work', () => {
    expect(
      resolveSubAgentReportedOutput({
        lastFinalText: '',
        outputText: 'stream',
        reachedMaxIterations: false,
      }),
    ).toBe('stream')
  })
})
