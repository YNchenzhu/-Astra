/**
 * Tool → activity / command display mapping tests.
 *
 * Goal: lock in the contract that EVERY built-in mutation tool routes to
 * the unified `ActivityRow` (kind: 'activity') chrome — except `bash` /
 * `PowerShell`, which by design keep the `CommandChip` (kind: 'command')
 * for user-auditable shell execution. Anything else returning `null` is
 * a regression that would re-introduce the legacy `BaseCard` fallback
 * for that tool.
 */

import { describe, it, expect } from 'vitest'
import { getToolDisplay } from './toolToAction'

describe('multi_edit_file display (P5 unification: parity with edit_file)', () => {
  it('routes to ActivityRow with "Edited" verb (same as edit_file)', () => {
    const edit = getToolDisplay('edit_file', {
      filePath: '/proj/src/a.ts',
      oldString: 'foo',
      newString: 'bar',
    })
    const multi = getToolDisplay('multi_edit_file', {
      filePath: '/proj/src/a.ts',
      edits: [
        { oldString: 'foo', newString: 'bar' },
        { oldString: 'baz', newString: 'qux' },
      ],
    })
    expect(edit?.kind).toBe('activity')
    expect(multi?.kind).toBe('activity')
    if (edit?.kind === 'activity' && multi?.kind === 'activity') {
      expect(multi.actionWord).toBe(edit.actionWord) // both "Edited"
      expect(multi.subject).toBe(edit.subject)
    }
  })

  it('meta surfaces both diff approximation and batch size', () => {
    const r = getToolDisplay('multi_edit_file', {
      filePath: '/a.ts',
      edits: [
        { oldString: 'a', newString: 'a\nA' }, // +1
        { oldString: 'b', newString: 'b\nB\nB2' }, // +2
        { oldString: 'c\nC', newString: 'c' }, // -1
      ],
    })
    expect(r?.kind).toBe('activity')
    if (r?.kind === 'activity') {
      // 3 entries; aggregate delta is +3 added, -1 removed
      expect(r.meta).toContain('+3')
      expect(r.meta).toContain('-1')
      expect(r.meta).toContain('3 edits')
    }
  })

  it('singular "1 edit" label when only one entry', () => {
    const r = getToolDisplay('multi_edit_file', {
      filePath: '/x',
      edits: [{ oldString: 'a', newString: 'b' }],
    })
    expect(r?.kind).toBe('activity')
    if (r?.kind === 'activity') {
      expect(r.meta).toContain('1 edit')
      expect(r.meta).not.toContain('1 edits')
    }
  })

  it('handles snake_case alias inside edits[i]', () => {
    const r = getToolDisplay('multi_edit_file', {
      file_path: '/snake.ts',
      edits: [{ old_string: 'foo\nfoo', new_string: 'bar' }],
    })
    expect(r?.kind).toBe('activity')
    if (r?.kind === 'activity') {
      expect(r.subject).toContain('snake.ts')
      // 2 lines → 1 line = -1
      expect(r.meta).toContain('-1')
    }
  })

  it('meta is undefined when batch is missing or empty (no fabricated values)', () => {
    const r = getToolDisplay('multi_edit_file', { filePath: '/x' })
    expect(r?.kind).toBe('activity')
    if (r?.kind === 'activity') {
      // No edits → no diff label, no count label, meta should not appear
      expect(r.meta).toBeUndefined()
    }
  })
})

describe('P5 unification: every registered built-in tool resolves to a display', () => {
  // Snapshot of every tool name our registry knows about (gathered from
  // electron/tools/*.ts and electron/skills/skillDiscovery.ts). If any
  // future tool registration is added without a renderer mapping, this
  // test surfaces it before the legacy BaseCard fallback ships.
  const REGISTERED_TOOLS: Array<{ name: string; expected: 'activity' | 'command' }> = [
    // file ops
    { name: 'read_file', expected: 'activity' },
    { name: 'write_file', expected: 'activity' },
    { name: 'edit_file', expected: 'activity' },
    { name: 'multi_edit_file', expected: 'activity' },
    { name: 'list_files', expected: 'activity' },
    { name: 'glob', expected: 'activity' },
    { name: 'grep', expected: 'activity' },
    { name: 'web_fetch', expected: 'activity' },
    { name: 'WebSearch', expected: 'activity' },
    // shell — the ONLY tools that intentionally keep the chip/terminal chrome
    { name: 'bash', expected: 'command' },
    { name: 'PowerShell', expected: 'command' },
    // misc built-ins
    { name: 'TodoWrite', expected: 'activity' },
    { name: 'NotebookEdit', expected: 'activity' },
    { name: 'LSP', expected: 'activity' },
    { name: 'Skill', expected: 'activity' },
    { name: 'DiscoverSkills', expected: 'activity' },
    { name: 'MemdirScan', expected: 'activity' },
    { name: 'EnterPlanMode', expected: 'activity' },
    { name: 'ExitPlanMode', expected: 'activity' },
    { name: 'EnterWorktree', expected: 'activity' },
    { name: 'ExitWorktree', expected: 'activity' },
    { name: 'AskUserQuestion', expected: 'activity' },
    { name: 'MagicDocs', expected: 'activity' },
    { name: 'ToolSearch', expected: 'activity' },
    { name: 'KillAgentTasks', expected: 'activity' },
    { name: 'KillAllTasks', expected: 'activity' },
    // newly unified in P5
    { name: 'Config', expected: 'activity' },
    { name: 'AwaySummary', expected: 'activity' },
    { name: 'PromptSuggestion', expected: 'activity' },
    { name: 'ReadDiagnostics', expected: 'activity' },
    { name: 'RemoteTrigger', expected: 'activity' },
    { name: 'SendUserMessage', expected: 'activity' },
    { name: 'SpawnTeammate', expected: 'activity' },
    { name: 'SwarmMultiplexer', expected: 'activity' },
    { name: 'REPL', expected: 'activity' },
    // Task* family
    { name: 'TaskCreate', expected: 'activity' },
    { name: 'TaskList', expected: 'activity' },
    { name: 'TaskGet', expected: 'activity' },
    { name: 'TaskUpdate', expected: 'activity' },
    { name: 'TaskStop', expected: 'activity' },
    { name: 'TaskOutput', expected: 'activity' },
    // Team* family — newly added prefix dispatcher
    { name: 'TeamCreate', expected: 'activity' },
    { name: 'TeamDelete', expected: 'activity' },
    { name: 'TeamStatus', expected: 'activity' },
    { name: 'TeamMemorySync', expected: 'activity' },
    // Cron* family — newly added prefix dispatcher
    { name: 'CronCreate', expected: 'activity' },
    { name: 'CronDelete', expected: 'activity' },
    { name: 'CronList', expected: 'activity' },
  ]

  // `bash` / `PowerShell` only keep the CommandChip chrome when the
  // call actually carries a `command` — see `mapBash` / `mapPowerShell`
  // for the empty-command fallback. The fixture supplies one so this
  // test asserts the happy-path mapping rather than malformed-tool-call
  // recovery (covered separately below).
  const inputFor = (name: string): Record<string, unknown> =>
    name === 'bash' || name === 'PowerShell' ? { command: 'echo hi' } : {}

  for (const { name, expected } of REGISTERED_TOOLS) {
    it(`${name} resolves to kind: '${expected}'`, () => {
      const r = getToolDisplay(name, inputFor(name))
      expect(r, `tool ${name} returned null — would fall back to BaseCard`).not.toBeNull()
      expect(r!.kind).toBe(expected)
    })
  }
})

describe('bash / PowerShell empty-command fallback', () => {
  // When the model emits a malformed shell tool call without a `command`,
  // we must NOT render an empty CommandChip — the chip collapses to a
  // bare border + glyphs and the sub-agent feed shows phantom thin lines.
  // The mapper falls back to ActivityRow with a "(missing command)" hint.
  it('bash with no command falls back to ActivityRow', () => {
    const r = getToolDisplay('bash', {})
    expect(r?.kind).toBe('activity')
    if (r?.kind === 'activity') {
      expect(r.actionWord).toBe('Bash')
      expect(r.subject).toBe('(missing command)')
    }
  })

  it('PowerShell with no command falls back to ActivityRow', () => {
    const r = getToolDisplay('PowerShell', {})
    expect(r?.kind).toBe('activity')
    if (r?.kind === 'activity') {
      expect(r.actionWord).toBe('PowerShell')
      expect(r.subject).toBe('(missing command)')
    }
  })

  it('bash with whitespace-only command also falls back', () => {
    const r = getToolDisplay('bash', { command: '   \n  ' })
    expect(r?.kind).toBe('activity')
  })
})

describe('Team* prefix dispatcher', () => {
  it('TeamCreate carries team_name as subject', () => {
    const r = getToolDisplay('TeamCreate', { team_name: 'alpha-squad', template: 'parallel' })
    expect(r?.kind).toBe('activity')
    if (r?.kind === 'activity') {
      expect(r.actionWord).toBe('Created team')
      expect(r.subject).toBe('alpha-squad')
      expect(r.meta).toBe('parallel')
    }
  })

  it('TeamDelete with no team_name falls back to "all teams"', () => {
    const r = getToolDisplay('TeamDelete', {})
    expect(r?.kind).toBe('activity')
    if (r?.kind === 'activity') {
      expect(r.subject).toBe('all teams')
    }
  })

  it('TeamMemorySync needs no subject', () => {
    const r = getToolDisplay('TeamMemorySync', {})
    expect(r?.kind).toBe('activity')
    if (r?.kind === 'activity') {
      expect(r.actionWord).toBe('Synced team memory')
      expect(r.subject).toBeUndefined()
    }
  })
})

describe('Cron* prefix dispatcher', () => {
  it('CronCreate surfaces the cron expression', () => {
    const r = getToolDisplay('CronCreate', { cron: '0 9 * * 1-5', prompt: 'morning standup' })
    expect(r?.kind).toBe('activity')
    if (r?.kind === 'activity') {
      expect(r.actionWord).toBe('Scheduled cron')
      expect(r.subject).toContain('0 9 * * 1-5')
      expect(r.meta).toBe('morning standup')
    }
  })

  it('CronDelete uses id as subject', () => {
    const r = getToolDisplay('CronDelete', { id: 'cron_abc123' })
    expect(r?.kind).toBe('activity')
    if (r?.kind === 'activity') {
      expect(r.subject).toBe('cron_abc123')
    }
  })

  it('CronList is parameterless', () => {
    const r = getToolDisplay('CronList', {})
    expect(r?.kind).toBe('activity')
    if (r?.kind === 'activity') {
      expect(r.actionWord).toBe('Listed crons')
      expect(r.subject).toBeUndefined()
    }
  })
})

describe('Config: read vs write display split', () => {
  it('Config with `value` reads as "Set config"', () => {
    const r = getToolDisplay('Config', { setting: 'model', value: 'claude-sonnet-4' })
    expect(r?.kind).toBe('activity')
    if (r?.kind === 'activity') {
      expect(r.actionWord).toBe('Set config')
      expect(r.subject).toBe('model')
      expect(r.meta).toContain('claude-sonnet-4')
    }
  })

  it('Config without `value` reads as "Read config"', () => {
    const r = getToolDisplay('Config', { setting: 'model' })
    expect(r?.kind).toBe('activity')
    if (r?.kind === 'activity') {
      expect(r.actionWord).toBe('Read config')
      expect(r.meta).toBeUndefined()
    }
  })
})

describe('SendUserMessage (BriefTool): preview collapses whitespace', () => {
  it('multi-line markdown collapses to single-line preview', () => {
    const r = getToolDisplay('SendUserMessage', {
      message: '## Hello\n\nLook at this:\n\n```\ncode\n```',
      attachments: ['/tmp/a.png', '/tmp/b.log'],
    })
    expect(r?.kind).toBe('activity')
    if (r?.kind === 'activity') {
      expect(r.subject).toBeTruthy()
      // Whitespace collapse: no embedded newlines in the subject
      expect((r.subject as string).includes('\n')).toBe(false)
      expect(r.meta).toBe('2 attachments')
    }
  })

  it('singular "1 attachment" label', () => {
    const r = getToolDisplay('SendUserMessage', { message: 'x', attachments: ['/a'] })
    expect(r?.kind).toBe('activity')
    if (r?.kind === 'activity') {
      expect(r.meta).toBe('1 attachment')
    }
  })
})

describe('unknown / out-of-family names still return null (BaseCard fallback intentional)', () => {
  it('truly unknown built-in name returns null', () => {
    expect(getToolDisplay('SomeFutureUnknownTool', {})).toBeNull()
  })

  it('MCP tools with malformed names return null (strict parse)', () => {
    expect(getToolDisplay('mcp__broken', {})).toBeNull()
  })
})
