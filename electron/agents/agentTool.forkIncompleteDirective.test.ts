/**
 * Layer-D regression tests for `formatSubAgentProcessDigest`.
 *
 * Symptom these guard against: parent agent dispatches a sub-agent
 * via the `Agent` tool, the sub-agent terminates WITHOUT a usable
 * deliverable (`success: false`), the parent gets a tool_result with no
 * inline directive, writes a text-only "好的，子代理失败了" turn, and the
 * noTools branch ends the loop. The user is left with an incomplete task.
 *
 * The fix embeds a `<fork-incomplete-directive>` block in the digest
 * the parent reads as a tool_result. These tests pin that contract.
 *
 * Output-aware update: the directive is now gated on `success === false`
 * ONLY. `success` is itself output-aware — a run that crossed an
 * iteration / token budget but still produced a usable report reports
 * `success: true`, so it must NOT get the "did not finish cleanly"
 * directive (that was the "success:true yet incomplete" contradiction).
 * The raw budget flags still surface as an informational `Termination:`
 * line in that case.
 */
import { describe, it, expect } from 'vitest'
import { formatSubAgentProcessDigest } from './agentTool'
import type { SubAgentResult } from './types'
import { asAgentId } from '../tools/ids'

function baseResult(overrides: Partial<SubAgentResult> = {}): SubAgentResult {
  return {
    success: true,
    agentId: asAgentId('agent-test'),
    agentType: 'fixer',
    output: 'all done',
    totalTokens: 1234,
    totalDurationMs: 4321,
    totalToolUses: 7,
    ...overrides,
  }
}

describe('formatSubAgentProcessDigest — fork-incomplete directive', () => {
  it('omits the directive when the fork completed cleanly', () => {
    const digest = formatSubAgentProcessDigest(baseResult())
    expect(digest).not.toContain('<fork-incomplete-directive>')
  })

  it('includes the directive when success=false', () => {
    const digest = formatSubAgentProcessDigest(
      baseResult({
        success: false,
        toolFailures: [{ name: 'Read', error: 'ENOENT' }],
      }),
    )
    expect(digest).toContain('<fork-incomplete-directive>')
    expect(digest).toContain('the sub-agent reported success=false')
    expect(digest).toContain('</fork-incomplete-directive>')
  })

  it('includes the directive when success=false AND max iterations was hit', () => {
    const digest = formatSubAgentProcessDigest(
      baseResult({ success: false, reachedMaxIterations: true }),
    )
    expect(digest).toContain('<fork-incomplete-directive>')
    expect(digest).toContain('hit its max-iterations cap')
  })

  it('includes the directive when success=false AND the fork was aborted', () => {
    const digest = formatSubAgentProcessDigest(
      baseResult({ success: false, aborted: true }),
    )
    expect(digest).toContain('<fork-incomplete-directive>')
    expect(digest).toContain('the sub-agent was aborted')
  })

  // Output-aware anti-contradiction: a run that hit a budget but still
  // produced a usable report (`success: true`) must NOT get the "did not
  // finish cleanly" directive — the flags are informational only.
  it('OMITS the directive when a limit was hit but success=true (report produced)', () => {
    for (const flag of [
      { reachedMaxIterations: true },
      { aborted: true },
      { truncated: true },
    ] as const) {
      const digest = formatSubAgentProcessDigest(baseResult({ success: true, ...flag }))
      expect(digest).not.toContain('<fork-incomplete-directive>')
      // …but the raw fact is still surfaced, framed as informational.
      expect(digest).toContain('treat these as informational')
    }
  })

  it('lists every applicable reason when more than one termination flag is set', () => {
    const digest = formatSubAgentProcessDigest(
      baseResult({
        success: false,
        reachedMaxIterations: true,
        aborted: true,
      }),
    )
    expect(digest).toMatch(/max-iterations cap.*was aborted/s)
  })

  it('directive prescribes the three concrete next-turn actions', () => {
    const digest = formatSubAgentProcessDigest(baseResult({ success: false }))
    // The parent must see (and not paraphrase away) all three branches.
    expect(digest).toContain('1. Re-dispatch')
    expect(digest).toContain('2. Call tools yourself')
    expect(digest).toContain('3. If neither is feasible')
  })
})
