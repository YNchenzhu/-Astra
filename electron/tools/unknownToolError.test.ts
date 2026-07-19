import { describe, it, expect } from 'vitest'
import {
  findClosestToolName,
  formatUnknownToolError,
} from './unknownToolError'

const REGISTERED = [
  'Read',
  'Write',
  'Edit',
  'Bash',
  'glob',
  'grep',
  'WebSearch',
  'WebFetch',
  'TodoWrite',
  'NotebookEdit',
  'Agent',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
] as const

describe('findClosestToolName', () => {
  it('catches the canonical typo: globb -> glob (distance 1)', () => {
    expect(findClosestToolName('globb', REGISTERED)).toBe('glob')
  })

  it('catches single-character substitutions: grepp -> grep', () => {
    expect(findClosestToolName('grepp', REGISTERED)).toBe('grep')
  })

  it('catches case-insensitive single-edit typos: Reab -> Read', () => {
    expect(findClosestToolName('Reab', REGISTERED)).toBe('Read')
  })

  it('handles snake_case → PascalCase suggestions when distance allows: webfetch -> WebFetch', () => {
    // distance(`webfetch`, `WebFetch`) lower-cased = 0 (exact match
    // case-insensitive), so the closest match is WebFetch itself.
    expect(findClosestToolName('webfetch', REGISTERED)).toBe('WebFetch')
  })

  it('refuses to guess when the typo is too far (≤4 chars → max 1 edit)', () => {
    // `Edt` is distance 1 from `Edit`, that's still within the cap, so it
    // SHOULD match — verify the inverse case explicitly.
    expect(findClosestToolName('Edt', REGISTERED)).toBe('Edit')

    // `xyz` (distance 3 from any short candidate, distance 1 cap for ≤4
    // chars) → no suggestion.
    expect(findClosestToolName('xyz', REGISTERED)).toBeNull()
  })

  it('refuses obviously unrelated long names', () => {
    expect(
      findClosestToolName('completely_different_long_name', REGISTERED),
    ).toBeNull()
  })

  it('returns null for empty input', () => {
    expect(findClosestToolName('', REGISTERED)).toBeNull()
    expect(findClosestToolName('   ', REGISTERED)).toBeNull()
  })

  it('prefers the prefix-match candidate when distances tie', () => {
    // `glob` and `grep` are both distance 2 from `gloo`. `glob` wins
    // because attemptLower (`gloo`) shares a 3-char prefix with `glob`
    // but only a 1-char prefix with `grep`.
    const list = ['glob', 'grep']
    expect(findClosestToolName('gloo', list)).toBe('glob')
  })

  it('breaks ties deterministically (lexicographic) when no prefix match', () => {
    // `aaa` and `bbb` both distance 3 from `ccc`. With limit=1 for length
    // 3, neither would match; verify a longer attempt where both are
    // within range and neither is a prefix.
    // Use 8-char attempt where two same-distance candidates exist.
    const list = ['banana', 'banano']
    // distance(`banane`, `banana`) = 1, distance(`banane`, `banano`) = 1.
    // Neither is a prefix of `banane`. Lexicographic tiebreaker → `banana`.
    expect(findClosestToolName('banane', list)).toBe('banana')
  })

  it('ignores empty candidate strings without crashing', () => {
    expect(findClosestToolName('Read', ['', 'Read', '', 'Edit'])).toBe('Read')
  })
})

describe('formatUnknownToolError', () => {
  // Audit fix D1: helper now returns a {@link ToolFailureFields} object
  // (carrying both the formatted `error` string AND structured fields
  // for the renderer's StructuredErrorView). String assertions read
  // `.error`; the structured-field assertions exercise the new payload.

  it('produces the structured what/tried/next shape with a "Did you mean?" suggestion', () => {
    const failure = formatUnknownToolError('globb', REGISTERED)
    expect(failure.error).toContain('Unknown tool: globb')
    expect(failure.error).toContain('tool_use.name="globb"')
    expect(failure.error).toContain('Did you mean "glob"?')
    expect(failure.error).toMatch(/Available tools \(\d+\)/)
    expect(failure.error).toContain(
      'Re-emit the tool_use with the correct `name` from the list above',
    )
    // Structured payload also exposes the headline / class for the UI.
    expect(failure.errorWhat).toBe('Unknown tool: globb')
    expect(failure.toolErrorClass).toBe('not_found')
    expect(failure.errorTried).toEqual(['tool_use.name="globb"'])
    expect(failure.errorNext?.some((n) => n.includes('Did you mean "glob"?'))).toBe(true)
  })

  it('omits the suggestion line when no candidate is close enough', () => {
    const failure = formatUnknownToolError(
      'completely_invented_name_xyz',
      REGISTERED,
    )
    expect(failure.error).not.toContain('Did you mean')
    expect(failure.error).toContain('Unknown tool: completely_invented_name_xyz')
    expect(failure.error).toMatch(/Available tools/)
  })

  it('truncates long registry lists and points at ToolSearch', () => {
    const big = Array.from({ length: 60 }, (_, i) => `tool_${String(i).padStart(2, '0')}`)
    const failure = formatUnknownToolError('tool_99x', big)
    expect(failure.error).toContain('60 total')
    expect(failure.error).toContain('first 40 shown')
    expect(failure.error).toContain('call ToolSearch for the full list')
  })

  it('does NOT truncate short registry lists (no ToolSearch hint)', () => {
    const failure = formatUnknownToolError('zzz_unrelated_name', REGISTERED)
    expect(failure.error).not.toContain('call ToolSearch for the full list')
    expect(failure.error).toMatch(/Available tools \(\d+\)/)
  })

  it('keeps the attempted name verbatim in both `what` and `tried` (case preserved)', () => {
    const failure = formatUnknownToolError('GlobB', REGISTERED)
    expect(failure.error).toContain('Unknown tool: GlobB')
    expect(failure.error).toContain('tool_use.name="GlobB"')
    // suggestion still resolves case-insensitively
    expect(failure.error).toContain('Did you mean "glob"?')
  })

  it('emits deterministic available-tools order (alphabetical)', () => {
    const a = formatUnknownToolError('xx', REGISTERED)
    const b = formatUnknownToolError(
      'xx',
      [...REGISTERED].reverse() as string[],
    )
    expect(a).toEqual(b)
  })
})
