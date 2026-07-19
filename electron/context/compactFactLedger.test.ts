/**
 * Compact fact ledger (GAP 2, 2026-06 long-run hallucination audit).
 *
 * Pins the deterministic counting + rendering contract:
 *   - tool_use/tool_result pairing by id, status from is_error /
 *     "Error:" prefix / missing result
 *   - mutating tools list distinct targets per status, capped
 *   - empty window → '' (caller omits the block)
 *   - rendered block never contains the compact retry marker `\n\n---\n`
 */

import { describe, expect, it } from 'vitest'
import {
  HOST_VERIFIED_TOOL_FACTS_OPEN_TAG,
  MAX_TARGETS_PER_STATUS,
  buildCompactToolFactLedger,
  tallyToolExecutions,
} from './compactFactLedger'

type Msg = Record<string, unknown>

const assistantToolUse = (
  id: string,
  name: string,
  input: Record<string, unknown> = {},
): Msg => ({
  role: 'assistant',
  content: [{ type: 'tool_use', id, name, input }],
})

const userToolResult = (
  id: string,
  content: string,
  isError = false,
): Msg => ({
  role: 'user',
  content: [
    { type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) },
  ],
})

describe('tallyToolExecutions', () => {
  it('counts success / error / missing per tool', () => {
    const messages: Msg[] = [
      assistantToolUse('t1', 'edit_file', { file_path: 'a.ts' }),
      userToolResult('t1', 'ok'),
      assistantToolUse('t2', 'edit_file', { file_path: 'b.ts' }),
      userToolResult('t2', 'Error: old_string not found', false),
      assistantToolUse('t3', 'edit_file', { file_path: 'c.ts' }),
      // t3 has no result → missing
      assistantToolUse('t4', 'read_file', { path: 'a.ts' }),
      userToolResult('t4', 'file body'),
    ]
    const tallies = tallyToolExecutions(messages)
    expect(tallies.get('edit_file')).toMatchObject({ success: 1, error: 1, missing: 1 })
    expect(tallies.get('read_file')).toMatchObject({ success: 1, error: 0, missing: 0 })
  })

  it('treats is_error: true as error even when content was cleared to a placeholder', () => {
    const messages: Msg[] = [
      assistantToolUse('t1', 'write_file', { file_path: 'x.ts' }),
      userToolResult('t1', '[Old tool result content cleared]', true),
    ]
    expect(tallyToolExecutions(messages).get('write_file')).toMatchObject({
      success: 0,
      error: 1,
    })
  })

  it('collects distinct, capped targets only for mutating tools', () => {
    const messages: Msg[] = []
    for (let i = 0; i < MAX_TARGETS_PER_STATUS + 5; i++) {
      messages.push(assistantToolUse(`e${i}`, 'edit_file', { file_path: `f${i}.ts` }))
      messages.push(userToolResult(`e${i}`, 'ok'))
    }
    // Duplicate target — must dedupe.
    messages.push(assistantToolUse('dup', 'edit_file', { file_path: 'f0.ts' }))
    messages.push(userToolResult('dup', 'ok'))
    // Read-only tool — no targets collected.
    messages.push(assistantToolUse('r1', 'read_file', { path: 'f0.ts' }))
    messages.push(userToolResult('r1', 'body'))

    const tallies = tallyToolExecutions(messages)
    const edit = tallies.get('edit_file')!
    expect(edit.targets.success.length).toBe(MAX_TARGETS_PER_STATUS)
    expect(new Set(edit.targets.success).size).toBe(MAX_TARGETS_PER_STATUS)
    expect(tallies.get('read_file')!.targets.success).toEqual([])
  })
})

describe('buildCompactToolFactLedger', () => {
  it('returns empty string when the window has no tool calls', () => {
    expect(
      buildCompactToolFactLedger([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ]),
    ).toBe('')
  })

  it('renders totals, mutating section with targets, and read-only section', () => {
    const ledger = buildCompactToolFactLedger([
      assistantToolUse('t1', 'edit_file', { file_path: 'src/a.ts' }),
      userToolResult('t1', 'ok'),
      assistantToolUse('t2', 'Bash', { command: 'npm test' }),
      userToolResult('t2', 'Error: 1 test failed', false),
      assistantToolUse('t3', 'grep', { pattern: 'foo' }),
      userToolResult('t3', 'matches'),
    ])
    expect(ledger.startsWith(HOST_VERIFIED_TOOL_FACTS_OPEN_TAG)).toBe(true)
    expect(ledger).toContain('Totals: 3 tool call(s) — 2 success, 1 error, 0 missing result.')
    expect(ledger).toContain('Mutating successes: 1.')
    expect(ledger).toContain('- edit_file: 1 success')
    expect(ledger).toContain('success targets: src/a.ts')
    expect(ledger).toContain('- Bash: 1 error')
    expect(ledger).toContain('error targets: npm test')
    expect(ledger).toContain('- grep: 1 success')
    expect(ledger).toContain('claimed but NOT verified by tool results')
  })

  it('flags an all-prose window (tool_use present but zero mutating calls)', () => {
    const ledger = buildCompactToolFactLedger([
      assistantToolUse('t1', 'read_file', { path: 'a.ts' }),
      userToolResult('t1', 'body'),
    ])
    expect(ledger).toContain('Mutating calls: NONE')
    expect(ledger).toContain('any completion claim about edits/writes/runs in this window is unverified')
  })

  it('never contains the compact retry marker sequence', () => {
    const ledger = buildCompactToolFactLedger([
      assistantToolUse('t1', 'edit_file', { file_path: 'a.ts' }),
      userToolResult('t1', 'ok'),
    ])
    expect(ledger.includes('\n\n---\n')).toBe(false)
  })
})
