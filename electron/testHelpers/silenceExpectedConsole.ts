/**
 * Test-only helper to silence expected `console.warn` / `console.error`
 * output from production code paths that a test deliberately exercises.
 *
 * Each call wires up vitest `beforeEach`/`afterEach` so the spy is set up
 * before every test in the suite and restored after, preventing the spy
 * from leaking into other suites. Original sink behavior is fully restored.
 *
 * Usage (top of a `.test.ts` file, after the imports):
 *
 *   import { silenceExpectedConsoleWarn } from '../testHelpers/silenceExpectedConsole'
 *   silenceExpectedConsoleWarn()
 *
 *   describe('my suite', () => { … })
 *
 * Why a helper rather than 6× inline duplications:
 *   - Single ownership: when stderr noise shows up in a NEW suite the fix
 *     is one line, not a copy of an 8-line block.
 *   - One place to keep the comment explaining "these warnings are
 *     expected from production code paths the test intentionally hits".
 *
 * What this does NOT silence:
 *   - `console.error` (unless explicitly opted in via {@link silenceExpectedConsoleError})
 *   - `console.log` / `console.info` — usually informational, not stderr.
 *   - Any spy a test installs ON TOP of this one (vitest stacks spies; an
 *     inner `vi.spyOn(console, 'warn').mockImplementation(...)` from a
 *     specific test still wins inside that test).
 */

import { afterEach, beforeEach, vi } from 'vitest'

type SpyHandle = ReturnType<typeof vi.spyOn> | null

/** Silence `console.warn` for every test in the calling file. */
export function silenceExpectedConsoleWarn(): void {
  let spy: SpyHandle = null
  beforeEach(() => {
    spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    spy?.mockRestore()
    spy = null
  })
}

/** Silence `console.error` — use only when the test exercises a production failure path. */
export function silenceExpectedConsoleError(): void {
  let spy: SpyHandle = null
  beforeEach(() => {
    spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    spy?.mockRestore()
    spy = null
  })
}

/** Convenience wrapper — silence both. */
export function silenceExpectedConsoleWarnAndError(): void {
  silenceExpectedConsoleWarn()
  silenceExpectedConsoleError()
}
