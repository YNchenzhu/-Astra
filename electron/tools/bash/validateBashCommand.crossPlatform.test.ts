/**
 * Integration tests: cross-platform heuristics are wired into
 * {@link validateBashCommand} with correct verdict aggregation. The unit
 * tests for each check live in `crossPlatformChecks.test.ts`; this file
 * proves they travel through the main validator WITHOUT being spuriously
 * upgraded to `deny` by the legacy blanket-deny rule.
 */

import { describe, it, expect } from 'vitest'
import { validateBashCommand, BashSecurityCode as BC } from './'

describe('validateBashCommand × crossPlatformChecks', () => {
  it('warns (not denies) on python3 on win32', () => {
    const a = validateBashCommand('python3 -V', { platform: 'win32' })
    expect(a.verdict).toBe('warn')
    expect(a.codes).toContain(BC.XP_PYTHON3_ON_WINDOWS)
  })

  it('does not emit python3 warning on linux', () => {
    const a = validateBashCommand('python3 -V', { platform: 'linux' })
    expect(a.verdict).toBe('allow')
    expect(a.codes).not.toContain(BC.XP_PYTHON3_ON_WINDOWS)
  })

  it('warns on multi-line python -c (does not trip the existing `bash -c` deny)', () => {
    // Note: `bash -c "..."` is DENIED by the legacy STRING_PIPE_TO_SHELL rule,
    // so we use `python -c` here — it's the representative real-world case
    // (and the one reported in the original incident).
    const a = validateBashCommand('python -c "print(1)\nprint(2)"', { platform: 'linux' })
    expect(a.verdict).toBe('warn')
    expect(a.codes).toContain(BC.XP_MULTILINE_DASH_C)
  })

  it('denies unclosed quotes regardless of platform', () => {
    const a = validateBashCommand('python3 -c "broken', { platform: 'win32' })
    expect(a.verdict).toBe('deny')
    expect(a.codes).toContain(BC.XP_UNCLOSED_QUOTE)
  })

  it('denies python3 + multiline -c on win32 (doomed combo escalation)', () => {
    // Previously this stacked two warns and let the spawn through; the child
    // then exited 9009/49 with empty stderr and the agent retried. The
    // escalation now denies pre-execution with a concrete suggested rewrite.
    const a = validateBashCommand('python3 -c "\nprint(1)\n"', { platform: 'win32' })
    expect(a.verdict).toBe('deny')
    expect(a.codes).toContain(BC.XP_PYTHON3_DASHC_MULTILINE_ON_WINDOWS)
    // The escalation replaces the individual warns — only the combo code stays.
    expect(a.codes).not.toContain(BC.XP_PYTHON3_ON_WINDOWS)
    expect(a.codes).not.toContain(BC.XP_MULTILINE_DASH_C)
  })

  it('coexists with legitimate deny codes — deny wins', () => {
    // `rm -rf /` is a deny-level DANGEROUS_COMMAND, combined here with a
    // cross-platform warn to confirm the deny dominates the verdict.
    const a = validateBashCommand('rm -rf / ; python3 -V', { platform: 'win32' })
    expect(a.verdict).toBe('deny')
    expect(a.codes).toContain(BC.DANGEROUS_COMMAND)
  })

  it('leaves clean commands untouched (no false positives)', () => {
    const a = validateBashCommand('ls -la', { platform: 'win32' })
    expect(a.verdict).toBe('allow')
    expect(a.codes).not.toContain(BC.XP_PYTHON3_ON_WINDOWS)
    expect(a.codes).not.toContain(BC.XP_MULTILINE_DASH_C)
    expect(a.codes).not.toContain(BC.XP_UNCLOSED_QUOTE)
  })
})
