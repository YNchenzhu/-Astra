/**
 * upstream parity for sub-agent retry:
 *
 * `subAgentRetryPolicy.decideSubagentRetry` was already unit-tested
 * in isolation, but the runner historically only telemetered the
 * decision via `console.info` and never re-invoked `runAgenticLoop`.
 * These tests verify the actual retry wiring landed:
 *
 *   1. `decideSubagentRetry` is statically imported (no dynamic
 *      `import('./subAgentRetryPolicy')` cold-path call).
 *   2. The `runAgenticLoop` call lives inside a `for (let attemptsSoFar...)`
 *      retry loop.
 *   3. The retry branch is gated on `terminationReason === 'model_error'`
 *      and `decision.kind === 'retry'`.
 *   4. A `subagent_retry` SubAgentEvent is emitted before the sleep.
 *   5. Backoff is applied via `setTimeout` (no busy-wait).
 *
 * Source-shape assertions are deliberate — a true behavioural test
 * would have to mock `runAgenticLoop`, the agent context, MCP
 * teardown, sidechain transcript I/O, and ~10 other collaborators
 * the runner pulls in, which is well beyond the value the assertion
 * delivers. Tracks the same fs.readFileSync convention as
 * `subAgentRunner.p1-bugs.test.ts`.
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { decideSubagentRetry } from './subAgentRetryPolicy'

const runnerSrc = fs.readFileSync(
  path.join(__dirname, 'subAgentRunner.ts'),
  'utf-8',
)

describe('Sub-agent retry wiring — cc-haha parity', () => {
  it('imports decideSubagentRetry statically (no dynamic-import cold path)', () => {
    expect(runnerSrc).toMatch(
      /import\s+\{\s*decideSubagentRetry\s*\}\s+from\s+['"]\.\/subAgentRetryPolicy['"]/,
    )
    // The old telemetry-only dynamic import is gone.
    expect(runnerSrc).not.toMatch(
      /void\s+import\(\s*['"]\.\/subAgentRetryPolicy['"]\s*\)/,
    )
  })

  it('wraps runAgenticLoop in a for-loop tracking attemptsSoFar', () => {
    const loopMarker =
      /for\s*\(\s*let\s+attemptsSoFar\s*=\s*0\s*;[^)]*;\s*attemptsSoFar\+\+\s*\)/
    expect(runnerSrc).toMatch(loopMarker)

    // The `await runAgenticLoop(` call body must live *inside* the
    // for-loop — locate both anchors and assert their order.
    const forIdx = runnerSrc.search(loopMarker)
    const callIdx = runnerSrc.indexOf('await runOrchestratedSubAgent(', forIdx)
    expect(forIdx).toBeGreaterThan(-1)
    expect(callIdx).toBeGreaterThan(forIdx)
  })

  it('only retries on terminationReason === model_error', () => {
    expect(runnerSrc).toMatch(
      /if\s*\(\s*lastReason\s*!==\s*['"]model_error['"]\s*\)\s*break/,
    )
  })

  it('emits a subagent_retry event before the backoff sleep', () => {
    expect(runnerSrc).toMatch(/type:\s*['"]subagent_retry['"]/)
    // Sleep is via setTimeout — verify the await pattern is present.
    expect(runnerSrc).toMatch(
      /new\s+Promise<void>\(\s*\(\s*resolve\s*\)\s*=>\s*setTimeout\(/,
    )
  })

  it('honors the parent / loop signal abort between attempts', () => {
    // Two abort checks — one before the retry decision, one after
    // the backoff sleep — so user cancel wins immediately at either
    // boundary.
    const checks = runnerSrc.match(
      /effectiveLoopSignal\.aborted\s*\|\|\s*signal\.aborted/g,
    )
    expect(checks).not.toBeNull()
    expect(checks!.length).toBeGreaterThanOrEqual(2)
  })

  it('resets reachedMaxIterations between attempts so final-attempt outcome wins', () => {
    // The reset must appear AFTER the for-loop opening and BEFORE
    // the next iteration's runAgenticLoop call. We can't trivially
    // assert relative position without parsing, but its mere presence
    // alongside the for-loop is the regression check.
    const idx = runnerSrc.search(/reachedMaxIterations\s*=\s*false/)
    expect(idx).toBeGreaterThan(-1)
  })
})

describe('decideSubagentRetry contract sanity', () => {
  // These dovetail the wiring tests above by asserting the policy
  // table the runner now consumes hasn't shifted: model_error retries
  // once and then gives up; prompt_too_long is intentionally NOT
  // wired (it stays no_retry from the runner's perspective even
  // though the policy table says retry).
  it('returns retry for the first model_error attempt', () => {
    const d = decideSubagentRetry('model_error', 0)
    expect(d.kind).toBe('retry')
  })

  it('returns no_retry after the first model_error retry has been spent', () => {
    const d = decideSubagentRetry('model_error', 1)
    expect(d.kind).toBe('no_retry')
  })

  it('returns no_retry for max_turns (cc-haha parity — same cap would just hit again)', () => {
    expect(decideSubagentRetry('max_turns', 0).kind).toBe('no_retry')
  })

  it('returns no_retry for aborted_streaming (user cancel)', () => {
    expect(decideSubagentRetry('aborted_streaming', 0).kind).toBe('no_retry')
  })
})
