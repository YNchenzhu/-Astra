import { describe, expect, it } from 'vitest'
import { formatDeterministicToolLedgerForInjection } from './toolUseSummary'

describe('formatDeterministicToolLedgerForInjection', () => {
  it('emits a host-generated system-reminder ledger with tool ids, status, input, and result preview', () => {
    const out = formatDeterministicToolLedgerForInjection({
      toolUseBlocks: [
        {
          id: 'toolu_read_1',
          name: 'read_file',
          input: { filePath: 'src/app.ts' },
        },
        {
          id: 'toolu_edit_1',
          name: 'edit_file',
          input: { filePath: 'src/app.ts', oldString: 'a', newString: 'b' },
        },
      ],
      toolResults: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_read_1',
          content: 'read result body',
        },
        {
          type: 'tool_result',
          tool_use_id: 'toolu_edit_1',
          content: 'edit applied',
        },
      ],
    })

    expect(out).toMatch(/^<system-reminder>/u)
    expect(out).toMatch(/<\/system-reminder>$/u)
    expect(out).toContain('[Previous tool batch ledger — host-generated]')
    expect(out).toContain('Do NOT repeat successful actions')
    expect(out).toContain('read_file id=toolu_read_1 -> success')
    expect(out).toContain('input={"filePath":"src/app.ts"}')
    expect(out).toContain('result=read result body')
    expect(out).toContain('edit_file id=toolu_edit_1 -> success')
    expect(out).toContain('result=edit applied')
  })

  it('aligns results by tool_use_id instead of positional order', () => {
    const out = formatDeterministicToolLedgerForInjection({
      toolUseBlocks: [
        { id: 'a', name: 'A', input: { x: 1 } },
        { id: 'b', name: 'B', input: { y: 2 } },
      ],
      toolResults: [
        { type: 'tool_result', tool_use_id: 'b', content: 'result B' },
        { type: 'tool_result', tool_use_id: 'a', content: 'result A' },
      ],
    })

    expect(out.indexOf('A id=a')).toBeLessThan(out.indexOf('B id=b'))
    expect(out).toMatch(/A id=a -> success;.*result=result A/u)
    expect(out).toMatch(/B id=b -> success;.*result=result B/u)
  })

  it('marks error and missing results explicitly', () => {
    const out = formatDeterministicToolLedgerForInjection({
      toolUseBlocks: [
        { id: 'bad', name: 'Bash', input: { command: 'npm test' } },
        { id: 'missing', name: 'Read', input: { filePath: 'x' } },
      ],
      toolResults: [
        {
          type: 'tool_result',
          tool_use_id: 'bad',
          is_error: true,
          content: 'exit code 1',
        },
      ],
    })

    expect(out).toContain('Bash id=bad -> error')
    expect(out).toContain('result=exit code 1')
    expect(out).toContain('Read id=missing -> missing')
    expect(out).toContain('result=(no result captured)')
  })

  it('prints a path-to-readId map so multi-file edits do not borrow the last global-looking id', () => {
    const out = formatDeterministicToolLedgerForInjection({
      toolUseBlocks: [
        { id: 'read-a', name: 'read_file', input: { filePath: 'src/a.ts' } },
        { id: 'read-b', name: 'read_file', input: { filePath: 'src/b.ts' } },
      ],
      toolResults: [
        { type: 'tool_result', tool_use_id: 'read-a', content: 'A' },
        { type: 'tool_result', tool_use_id: 'read-b', content: 'B' },
      ],
      readReceiptHints: [
        { filePath: 'C:/repo/src/b.ts', readId: 'read-bbbbbbbbbbbbbbbb' },
        { filePath: 'C:/repo/src/a.ts', readId: 'read-aaaaaaaaaaaaaaaa' },
      ],
    })

    expect(out).toContain('[Current path-bound readIds — host-generated]')
    expect(out).toContain('readIds are NOT global')
    expect(out).toContain('path="C:/repo/src/b.ts" -> baseReadId="read-bbbbbbbbbbbbbbbb"')
    expect(out).toContain('path="C:/repo/src/a.ts" -> baseReadId="read-aaaaaaaaaaaaaaaa"')
    expect(out).toContain('If the target path is absent, call read_file first')
  })

  it('returns an empty string for empty batches', () => {
    expect(
      formatDeterministicToolLedgerForInjection({
        toolUseBlocks: [],
        toolResults: [],
      }),
    ).toBe('')
  })
})
