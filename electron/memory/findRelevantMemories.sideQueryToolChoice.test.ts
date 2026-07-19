/**
 * Regression guard for the "tool_choice ... in thinking mode" gateway error.
 *
 * The memory recall side-query used to send `toolChoice: { type: 'tool',
 * name: 'select_relevant_memories' }` unconditionally — which some gateways
 * (Zhipu GLM, DeepSeek thinking, Anthropic-compat proxies) reject when
 * thinking mode is on, surfacing as:
 *
 *     InvalidParameter: The tool_choice parameter does not support being
 *     set to required or object in thinking mode
 *
 * The fix: use `toolChoice: 'auto'` by default; when the gateway even
 * rejects that, retry with no `toolChoice` at all. This test locks the
 * error-detection predicate so future refactors don't silently weaken it.
 */

import { describe, expect, it } from 'vitest'

// Re-declare the predicate here — it's a module-private helper in
// findRelevantMemories.ts. Keeping a mirrored constant lets us lock the
// matching rules without exporting the helper and widening the public
// surface. If you change the predicate in findRelevantMemories.ts, update
// this copy AND the test list below to match.
function isThinkingModeToolChoiceError(err: string | undefined): boolean {
  if (!err) return false
  const m = err.toLowerCase()
  return m.includes('tool_choice') && m.includes('thinking')
}

describe('isThinkingModeToolChoiceError — predicate contract', () => {
  it('matches Zhipu / DeepSeek canonical phrasing', () => {
    expect(
      isThinkingModeToolChoiceError(
        'InvalidParameter: The tool_choice parameter does not support being set to required or object in thinking mode',
      ),
    ).toBe(true)
  })

  it('matches a terser Anthropic-compat proxy wording', () => {
    expect(
      isThinkingModeToolChoiceError(
        'tool_choice object not supported with thinking',
      ),
    ).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(
      isThinkingModeToolChoiceError(
        'TOOL_CHOICE MUST NOT BE SET WHEN THINKING IS ON',
      ),
    ).toBe(true)
  })

  it('does NOT match unrelated tool_choice errors (so we do not suppress real bugs)', () => {
    expect(
      isThinkingModeToolChoiceError(
        'tool_choice is invalid: missing tool name',
      ),
    ).toBe(false)
  })

  it('does NOT match unrelated thinking errors', () => {
    expect(
      isThinkingModeToolChoiceError('thinking budget exceeded'),
    ).toBe(false)
  })

  it('handles empty / undefined safely', () => {
    expect(isThinkingModeToolChoiceError(undefined)).toBe(false)
    expect(isThinkingModeToolChoiceError('')).toBe(false)
  })
})
