import { describe, expect, it } from 'vitest'
import {
  MAX_VERBATIM_BLOCK_CHARS,
  MAX_VERBATIM_TURN_CHARS,
  VERBATIM_HEAD_KEEP,
  VERBATIM_TAIL_KEEP,
  extractVerbatimUserMessages,
  formatVerbatimUserTurnsBlock,
} from './compact'

describe('Phase D — user message preservation through compaction', () => {
  it('extractVerbatimUserMessages keeps each plain-text user turn in submission order', () => {
    const msgs = [
      { role: 'user', content: 'First user turn' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'Second user turn' },
      { role: 'assistant', content: [{ type: 'text', text: 'response' }] },
      { role: 'user', content: [{ type: 'text', text: 'Third user turn' }] },
    ]
    expect(extractVerbatimUserMessages(msgs)).toEqual([
      'First user turn',
      'Second user turn',
      'Third user turn',
    ])
  })

  it('skips tool-result-only user messages (not real user intent)', () => {
    const msgs = [
      { role: 'user', content: 'Real ask' },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'tool output' }],
      },
      { role: 'user', content: 'Another ask' },
    ]
    expect(extractVerbatimUserMessages(msgs)).toEqual(['Real ask', 'Another ask'])
  })

  it('skips system-converted user messages (compact summaries / reminders)', () => {
    const msgs = [
      { role: 'user', content: 'Real ask' },
      {
        role: 'user',
        content: 'system reminder body',
        _convertedFromSystem: true,
      },
    ]
    expect(extractVerbatimUserMessages(msgs)).toEqual(['Real ask'])
  })

  // ── F1 (2026-07 会话审计) — mid-turn user input must survive compaction ──
  it('INCLUDES kernel_user_input deliveries (real user speech inside the host envelope)', () => {
    const msgs = [
      { role: 'user', content: 'Original ask' },
      {
        role: 'user',
        content:
          '<system-reminder>\n[User message (mid-turn)]\n改成先修登录 bug\n</system-reminder>',
        _convertedFromSystem: true,
        _sideChannelKind: 'kernel_user_input',
      },
      {
        // A generic host reminder stays excluded — only REAL user speech
        // gets the special case.
        role: 'user',
        content: '<system-reminder>\n[Stale todo reminder]\nnudge\n</system-reminder>',
        _convertedFromSystem: true,
        _sideChannelKind: 'stale_todo_nudge',
      },
    ]
    expect(extractVerbatimUserMessages(msgs)).toEqual(['Original ask', '改成先修登录 bug'])
  })

  it('kernel_user_input extraction works from the body marker alone (disk resume)', () => {
    const msgs = [
      {
        role: 'user',
        content:
          '<system-reminder>\n[User message (mid-turn)]\nswitch to the login bug first\n</system-reminder>',
      },
    ]
    expect(extractVerbatimUserMessages(msgs)).toEqual(['switch to the login bug first'])
  })

  it('formatVerbatimUserTurnsBlock returns empty for empty input', () => {
    expect(formatVerbatimUserTurnsBlock([])).toBe('')
  })

  it('formatVerbatimUserTurnsBlock numbers each turn and quotes its body verbatim', () => {
    const block = formatVerbatimUserTurnsBlock(['First', 'Second with backticks ``stuff``'])
    expect(block).toContain('## Preserved user turns')
    expect(block).toContain('### User turn 1')
    expect(block).toContain('### User turn 2')
    expect(block).toContain('First')
    expect(block).toContain('Second with backticks ``stuff``')
  })

  // ── 2026-07 复审 P0 fix — honest loss manifest ──────────────────────
  // The block must never overstate its own completeness: the header
  // carries a manifest of kept / truncated / omitted counts, and the
  // old "every user message … verbatim" absolute claim is gone.

  it('loss manifest: full re-injection reports all turns kept in full', () => {
    const block = formatVerbatimUserTurnsBlock(['short one', 'short two'])
    expect(block).toContain('Manifest: 2 user turn(s) total; 2 re-injected in full (verbatim).')
    expect(block).not.toContain('truncated to head+tail excerpts')
    expect(block).not.toContain('omitted entirely')
    // The absolute completeness claim must not come back.
    expect(block).not.toMatch(/every user message/i)
  })

  it('loss manifest: oversized turn is counted as truncated', () => {
    const huge = 'x'.repeat(MAX_VERBATIM_TURN_CHARS * 3)
    const block = formatVerbatimUserTurnsBlock([huge, 'tiny'])
    expect(block).toContain('2 user turn(s) total')
    expect(block).toContain('1 re-injected in full (verbatim)')
    expect(block).toContain('1 truncated to head+tail excerpts')
  })

  it('loss manifest: middle-omission names the omitted turn range', () => {
    const turns = Array.from({ length: 20 }, (_, i) =>
      `Turn ${i}: ${'y'.repeat(MAX_VERBATIM_TURN_CHARS - 50)}`,
    )
    const block = formatVerbatimUserTurnsBlock(turns)
    const omitted = 20 - VERBATIM_HEAD_KEEP - VERBATIM_TAIL_KEEP
    expect(block).toContain(
      `${omitted} omitted entirely (turns ${VERBATIM_HEAD_KEEP + 1}–${20 - VERBATIM_TAIL_KEEP})`,
    )
    // Reader guidance: absence is unknown, not never-said.
    expect(block).toContain('never as "the user did not say it"')
  })

  it('truncates a single oversized turn to MAX_VERBATIM_TURN_CHARS budget', () => {
    const huge = 'x'.repeat(MAX_VERBATIM_TURN_CHARS * 3)
    const block = formatVerbatimUserTurnsBlock([huge])
    expect(block).toContain('chars elided')
    // Block stays under the per-turn cap + markdown/header overhead (the
    // header grew in the 2026-07 loss-manifest fix: honesty preamble +
    // manifest line ≈ 700 chars).
    expect(block.length).toBeLessThan(MAX_VERBATIM_TURN_CHARS + 1_000)
  })

  it('collapses the middle when many turns would blow the block budget', () => {
    const turns = Array.from({ length: 20 }, (_, i) =>
      `Turn ${i}: ${'y'.repeat(MAX_VERBATIM_TURN_CHARS - 50)}`,
    )
    const block = formatVerbatimUserTurnsBlock(turns)
    expect(block.length).toBeLessThan(MAX_VERBATIM_BLOCK_CHARS + 2_000)
    expect(block).toMatch(/omitted \d+ middle user turns?/u)
    // First N + last N markers visible.
    for (let i = 0; i < VERBATIM_HEAD_KEEP; i++) {
      expect(block).toContain(`User turn ${i + 1}`)
    }
    for (let i = 0; i < VERBATIM_TAIL_KEEP; i++) {
      expect(block).toContain(`User turn ${turns.length - i}`)
    }
  })

  it('handles mixed-block content arrays without dropping real user text', () => {
    const msgs = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'noise' },
          { type: 'text', text: 'follow-up question' },
        ],
      },
    ]
    expect(extractVerbatimUserMessages(msgs)).toEqual(['follow-up question'])
  })
})
