import { describe, expect, it } from 'vitest'
import {
  buildContext,
  formatContextReminderMessage,
  summarizeEarlyMessages,
} from './contextBuilder'
import type { ChatMessage } from '../types'

function userMsg(content: string, referencedFiles?: string[]): ChatMessage {
  return { id: 'u', role: 'user', content, ...(referencedFiles ? { referencedFiles } : {}) } as ChatMessage
}
function assistantMsg(content: string): ChatMessage {
  return { id: 'a', role: 'assistant', content } as ChatMessage
}

describe('buildContext', () => {
  it('returns empty object when nothing supplied', () => {
    expect(buildContext(null, null, [], null)).toEqual({})
  })

  it('includes active_file with single Path line for absolute path / no root', () => {
    const ctx = buildContext('C:/ws/a.ts', 'line1\nline2', [], null)
    expect(ctx.active_file).toContain('Path: C:/ws/a.ts')
    expect(ctx.active_file).toContain('line1')
  })

  it('emits relative + resolved-absolute path lines when root set and path relative', () => {
    const ctx = buildContext('src/a.ts', 'x', [], 'C:/ws')
    expect(ctx.active_file).toContain('Path (editor / relative): src/a.ts')
    expect(ctx.active_file).toContain('Path (resolved absolute): C:/ws/src/a.ts')
  })

  it('truncates active file preview at 100 lines', () => {
    const content = Array.from({ length: 150 }, (_, i) => `L${i}`).join('\n')
    const ctx = buildContext('a.ts', content, [], null)
    expect(ctx.active_file).toContain('... (50 more lines)')
    expect(ctx.active_file).not.toContain('L149')
  })

  it('does not emit active_file when content is empty', () => {
    expect(buildContext('a.ts', '', [], null).active_file).toBeUndefined()
  })

  it('lists open files joined by newline', () => {
    expect(buildContext(null, null, ['a.ts', 'b.ts'], null).open_files).toBe('a.ts\nb.ts')
  })

  it('emits referenced_paths and referenced_files_detail when content present', () => {
    const ctx = buildContext(null, null, [], 'C:/ws', [
      { path: 'src/ref.ts', content: 'ref body' },
    ])
    expect(ctx.referenced_paths).toContain('src/ref.ts → C:/ws/src/ref.ts')
    expect(ctx.referenced_files_detail).toContain('--- src/ref.ts ---')
    expect(ctx.referenced_files_detail).toContain('ref body')
  })

  it('omits referenced_files_detail when no ref has content', () => {
    const ctx = buildContext(null, null, [], 'C:/ws', [{ path: 'a.ts', content: null }])
    expect(ctx.referenced_paths).toBeDefined()
    expect(ctx.referenced_files_detail).toBeUndefined()
  })

  it('renders retrieved snippets with match counts', () => {
    const ctx = buildContext(null, null, [], null, [], [
      { filePath: 'C:/ws/a.ts', relativePath: 'a.ts', lines: '1 | code', matchCount: 3 },
    ])
    expect(ctx.retrieved_snippets).toContain('### a.ts (3 matches)')
  })

  it('includes workspace and trimmed diagnostics', () => {
    const ctx = buildContext(null, null, [], 'C:/ws', [], [], '  some diag  ')
    expect(ctx.workspace).toBe('C:/ws')
    expect(ctx.editor_diagnostics).toBe('some diag')
  })
})

describe('formatContextReminderMessage', () => {
  it('returns empty string for empty section map', () => {
    expect(formatContextReminderMessage({})).toBe('')
  })

  it('drops empty/whitespace-only sections', () => {
    expect(formatContextReminderMessage({ a: '   ', b: '' })).toBe('')
  })

  it('wraps sections in <system-reminder> with # key headers', () => {
    const out = formatContextReminderMessage({ workspace: 'C:/ws', open_files: 'a.ts' })
    expect(out.startsWith('<system-reminder>')).toBe(true)
    expect(out).toContain('# workspace\nC:/ws')
    expect(out).toContain('# open_files\na.ts')
    expect(out.trimEnd().endsWith('</system-reminder>')).toBe(true)
  })
})

describe('summarizeEarlyMessages', () => {
  it('returns empty string for no messages', () => {
    expect(summarizeEarlyMessages([])).toBe('')
  })

  it('always includes the header with message count', () => {
    const out = summarizeEarlyMessages([userMsg('hi there friend')])
    expect(out).toContain('[对话历史摘要 — 前 1 条消息]')
  })

  it('captures the first user sentence as an intent', () => {
    const out = summarizeEarlyMessages([userMsg('我想修复登录页面的崩溃问题。其它先不管')])
    expect(out).toContain('用户讨论的主题')
    expect(out).toContain('我想修复登录页面的崩溃问题')
  })

  it('captures AI decision phrases', () => {
    const out = summarizeEarlyMessages([
      assistantMsg('经过分析，我决定采用基于缓存的方案来优化整体的查询性能。'),
    ])
    expect(out).toContain('AI 的计划/意图')
    expect(out).toContain('我决定采用基于缓存的方案来优化整体的查询性能')
  })

  it('collects referenced files from user messages and assistant text paths', () => {
    const out = summarizeEarlyMessages([
      userMsg('改这个', ['src/login.ts']),
      assistantMsg('我修改了 src/components/Button.tsx 这个文件'),
    ])
    expect(out).toContain('涉及的文件')
    expect(out).toContain('src/login.ts')
    expect(out).toContain('src/components/Button.tsx')
  })

  it('captures error mentions', () => {
    const out = summarizeEarlyMessages([
      assistantMsg('运行时报错 error: cannot read property foo of undefined here'),
    ])
    expect(out).toContain('遇到的问题')
  })

  it('skips short / empty user messages as intents', () => {
    const out = summarizeEarlyMessages([userMsg('ok')])
    // "ok" is <= 5 chars => no intent section, but header still present
    expect(out).toContain('[对话历史摘要')
    expect(out).not.toContain('用户讨论的主题')
  })
})
