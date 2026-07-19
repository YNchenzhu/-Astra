import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  filterSlashCommands,
  listSlashCommands,
  parseSlashCommandInput,
  type SlashCommandHandlerContext,
} from './slashCommands'

function buildCtxStub(): SlashCommandHandlerContext {
  return {
    ports: {
      openDiagnosticsView: vi.fn(),
      clearConversation: vi.fn().mockResolvedValue(undefined),
      triggerCompact: vi.fn().mockResolvedValue(undefined),
      writeUserMemory: vi.fn().mockResolvedValue({ filename: 'auto-memo.md' }),
      renderContextReport: vi.fn().mockResolvedValue('## Context Report\nrows here'),
      appendInlineNote: vi.fn(),
    },
  }
}

describe('slashCommands registry', () => {
  it('lists the five Claude Code-aligned commands by id', () => {
    const ids = listSlashCommands().map((c) => c.id)
    expect(ids).toEqual(['context', 'clear', 'compact', 'memory', 'diagnostics'])
  })

  it('parseSlashCommandInput returns null for non-slash input', () => {
    expect(parseSlashCommandInput('hello world')).toBeNull()
  })

  it('parseSlashCommandInput surfaces unknown commands with command=null', () => {
    const parsed = parseSlashCommandInput('/unknown')
    expect(parsed?.command).toBeNull()
  })

  it('parseSlashCommandInput splits id and args around the first space', () => {
    const parsed = parseSlashCommandInput('/memory always use ESM imports')
    expect(parsed?.command?.id).toBe('memory')
    expect(parsed?.args).toBe('always use ESM imports')
  })

  it('filterSlashCommands narrows by id prefix', () => {
    const filtered = filterSlashCommands('co').map((c) => c.id)
    expect(filtered).toContain('context')
    expect(filtered).toContain('compact')
    expect(filtered).not.toContain('memory')
  })

  it('filterSlashCommands ignores description-only matches so SkillPopup keeps the `/skill` path', () => {
    // Description contains 诊断 but the id doesn't start with that
    // token, so we must NOT preempt the skill popup.
    expect(filterSlashCommands('诊断')).toEqual([])
    expect(filterSlashCommands('zzz')).toEqual([])
  })

  it('filterSlashCommands accepts an empty query to surface the full list on bare /', () => {
    const ids = filterSlashCommands('').map((c) => c.id)
    expect(ids).toEqual(['context', 'clear', 'compact', 'memory', 'diagnostics'])
  })
})

describe('slashCommand handlers', () => {
  let ctx: SlashCommandHandlerContext
  beforeEach(() => {
    ctx = buildCtxStub()
  })

  it('/context renders the live context report and inlines it', async () => {
    const cmd = listSlashCommands().find((c) => c.id === 'context')!
    const result = await cmd.run('', ctx)
    expect(ctx.ports.renderContextReport).toHaveBeenCalledTimes(1)
    expect(ctx.ports.appendInlineNote).toHaveBeenCalled()
    expect(result.kind).toBe('inline')
  })

  it('/clear delegates to the store action and stays silent', async () => {
    const cmd = listSlashCommands().find((c) => c.id === 'clear')!
    const result = await cmd.run('', ctx)
    expect(ctx.ports.clearConversation).toHaveBeenCalledTimes(1)
    expect(result.kind).toBe('silent')
  })

  it('/compact triggers compaction and emits an inline note', async () => {
    const cmd = listSlashCommands().find((c) => c.id === 'compact')!
    await cmd.run('', ctx)
    expect(ctx.ports.triggerCompact).toHaveBeenCalledTimes(1)
    expect(ctx.ports.appendInlineNote).toHaveBeenCalled()
  })

  it('/memory writes a memory and surfaces the filename when present', async () => {
    const cmd = listSlashCommands().find((c) => c.id === 'memory')!
    await cmd.run('always run npm run typecheck', ctx)
    expect(ctx.ports.writeUserMemory).toHaveBeenCalledWith('always run npm run typecheck')
    const note = (ctx.ports.appendInlineNote as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(String(note)).toMatch(/Memory written/u)
  })

  it('/memory reports a usage hint when called without body', async () => {
    const cmd = listSlashCommands().find((c) => c.id === 'memory')!
    await cmd.run('  ', ctx)
    expect(ctx.ports.writeUserMemory).not.toHaveBeenCalled()
    const note = (ctx.ports.appendInlineNote as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(String(note)).toMatch(/Usage:/u)
  })

  it('/diagnostics opens the diagnostics view', async () => {
    const cmd = listSlashCommands().find((c) => c.id === 'diagnostics')!
    const result = await cmd.run('', ctx)
    expect(ctx.ports.openDiagnosticsView).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ kind: 'openDialog', dialogId: 'diagnostics' })
  })
})
