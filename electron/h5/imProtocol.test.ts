import { describe, it, expect } from 'vitest'
import {
  buildImContentBlocks,
  formatAskQuestionText,
  isLoopbackAddress,
  parseAskAnswers,
  translateStreamEventToServerMessages,
  type ImAskQuestionItem,
  type ImAttachmentRef,
} from './imProtocol'

describe('isLoopbackAddress', () => {
  it('recognizes IPv4 / IPv6 / mapped loopback', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('localhost')).toBe(true)
  })

  it('rejects LAN / remote / empty addresses', () => {
    expect(isLoopbackAddress('192.168.1.20')).toBe(false)
    expect(isLoopbackAddress('10.0.0.5')).toBe(false)
    expect(isLoopbackAddress(undefined)).toBe(false)
    expect(isLoopbackAddress('')).toBe(false)
  })
})

describe('ask_user_question (M2)', () => {
  const questions: ImAskQuestionItem[] = [
    {
      header: '部署目标',
      question: '部署到哪个环境？',
      options: [{ label: '生产' }, { label: '预发' }],
    },
  ]

  it('translates ask_user_question into a text prompt + message_complete', () => {
    const out = translateStreamEventToServerMessages({
      type: 'ask_user_question',
      requestId: 'ask-1',
      questions,
    })
    expect(out).toHaveLength(2)
    expect(out[0].type).toBe('content_delta')
    expect(String(out[0].text)).toContain('部署目标')
    expect(String(out[0].text)).toContain('1. 生产')
    expect(out[1]).toEqual({ type: 'message_complete' })
  })

  it('emits nothing when there are no questions', () => {
    expect(translateStreamEventToServerMessages({ type: 'ask_user_question', questions: [] })).toEqual([])
  })

  it('formatAskQuestionText numbers options', () => {
    const text = formatAskQuestionText(questions)
    expect(text).toContain('1. 生产')
    expect(text).toContain('2. 预发')
  })

  it('parseAskAnswers resolves a numeric reply to the option label', () => {
    expect(parseAskAnswers(questions, '1')).toEqual({ 部署目标: '生产' })
    expect(parseAskAnswers(questions, '2')).toEqual({ 部署目标: '预发' })
  })

  it('parseAskAnswers keeps free text when no option index matches', () => {
    expect(parseAskAnswers(questions, '都不要')).toEqual({ 部署目标: '都不要' })
  })

  it('parseAskAnswers maps one line per question for multi-question asks', () => {
    const multi: ImAskQuestionItem[] = [
      { header: 'A', options: [{ label: 'a1' }, { label: 'a2' }] },
      { header: 'B', options: [{ label: 'b1' }, { label: 'b2' }] },
    ]
    expect(parseAskAnswers(multi, '2\n1')).toEqual({ A: 'a2', B: 'b1' })
  })
})

describe('translateStreamEventToServerMessages', () => {
  it('maps text_delta → content_delta (dropping empty text)', () => {
    expect(translateStreamEventToServerMessages({ type: 'text_delta', text: 'hi' })).toEqual([
      { type: 'content_delta', text: 'hi' },
    ])
    expect(translateStreamEventToServerMessages({ type: 'text_delta', text: '' })).toEqual([])
  })

  it('maps tool_start → typing status + content_start + tool_use_complete', () => {
    const out = translateStreamEventToServerMessages({
      type: 'tool_start',
      toolUse: { name: 'Bash' },
    })
    expect(out).toEqual([
      { type: 'status', state: 'tool_executing', verb: 'Bash' },
      { type: 'content_start', blockType: 'tool_use', toolName: 'Bash' },
      { type: 'tool_use_complete', toolName: 'Bash' },
    ])
  })

  it('falls back to top-level toolName when toolUse is absent', () => {
    const out = translateStreamEventToServerMessages({ type: 'tool_start', toolName: 'Read' })
    expect(out[1]).toEqual({ type: 'content_start', blockType: 'tool_use', toolName: 'Read' })
  })

  it('maps tool_result → thinking status + tool_result (keeps typing alive)', () => {
    expect(translateStreamEventToServerMessages({ type: 'tool_result' })).toEqual([
      { type: 'status', state: 'thinking' },
      { type: 'tool_result' },
    ])
  })

  it('maps permission_request preserving requestId / toolName / input', () => {
    const out = translateStreamEventToServerMessages({
      type: 'permission_request',
      requestId: 'perm-1',
      toolName: 'Write',
      input: { path: 'a.txt' },
    })
    expect(out).toEqual([
      { type: 'permission_request', requestId: 'perm-1', toolName: 'Write', input: { path: 'a.txt' } },
    ])
  })

  it('maps both message_stop and task_terminated → message_complete (stops typing)', () => {
    expect(translateStreamEventToServerMessages({ type: 'message_stop' })).toEqual([
      { type: 'message_complete' },
    ])
    expect(translateStreamEventToServerMessages({ type: 'task_terminated' })).toEqual([
      { type: 'message_complete' },
    ])
  })

  it('maps error with a fallback message', () => {
    expect(translateStreamEventToServerMessages({ type: 'error', error: 'boom' })).toEqual([
      { type: 'error', message: 'boom' },
    ])
    expect(translateStreamEventToServerMessages({ type: 'error' })).toEqual([
      { type: 'error', message: 'unknown error' },
    ])
  })

  it('ignores unrelated event types (e.g. thinking_delta)', () => {
    expect(translateStreamEventToServerMessages({ type: 'thinking_delta', text: 'x' })).toEqual([])
  })
})

describe('buildImContentBlocks', () => {
  it('returns the plain string when there are no attachments', () => {
    expect(buildImContentBlocks('hello', [])).toBe('hello')
  })

  it('builds an image block from a base64 image attachment', () => {
    const atts: ImAttachmentRef[] = [
      { type: 'image', name: 'p.png', data: 'BASE64', mimeType: 'image/png' },
    ]
    const out = buildImContentBlocks('look', atts)
    expect(Array.isArray(out)).toBe(true)
    expect(out).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BASE64' } },
    ])
  })

  it('defaults image media_type and skips images without data', () => {
    const out = buildImContentBlocks('', [
      { type: 'image', data: 'B64' },
      { type: 'image', name: 'no-data.png' },
    ]) as Array<Record<string, unknown>>
    // No leading text block (empty text), one image block with default mime.
    expect(out).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'B64' } },
    ])
  })

  it('surfaces file attachments as a read-me hint appended to the text', () => {
    const out = buildImContentBlocks('check this', [
      { type: 'file', name: 'report.pdf', path: '/tmp/report.pdf' },
    ]) as Array<Record<string, unknown>>
    expect(out).toHaveLength(1)
    const block = out[0] as { type: string; text: string }
    expect(block.type).toBe('text')
    expect(block.text).toContain('check this')
    expect(block.text).toContain('# attached files')
    expect(block.text).toContain('/tmp/report.pdf')
  })

  it('combines text + file hint + image blocks', () => {
    const out = buildImContentBlocks('hi', [
      { type: 'file', name: 'a.txt', path: '/x/a.txt' },
      { type: 'image', data: 'IMG', mimeType: 'image/jpeg' },
    ]) as Array<Record<string, unknown>>
    expect(out).toHaveLength(2)
    expect((out[0] as { text: string }).text).toContain('/x/a.txt')
    expect(out[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: 'IMG' },
    })
  })
})
