import { describe, expect, it } from 'vitest'
import {
  createMessage,
  createTextMessage,
  createToolUseMessage,
  createToolResultMessage,
  extractTextContent,
  extractToolUses,
  extractToolResults,
  type Message,
} from './messages'

describe('createMessage / createTextMessage', () => {
  it('creates a message with id, timestamp and content', () => {
    const m = createTextMessage('user', 'hello')
    expect(m.role).toBe('user')
    expect(m.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(typeof m.id).toBe('string')
    expect(m.id.startsWith('msg_')).toBe(true)
    expect(typeof m.timestamp).toBe('number')
  })

  it('generates unique ids across calls', () => {
    const ids = new Set(Array.from({ length: 50 }, () => createTextMessage('user', 'x').id))
    expect(ids.size).toBe(50)
  })
})

describe('createToolUseMessage', () => {
  it('produces a tool_use content block with an id', () => {
    const c = createToolUseMessage('Read', { path: 'a' })
    expect(c.type).toBe('tool_use')
    expect(c.name).toBe('Read')
    expect(c.input).toEqual({ path: 'a' })
    expect(c.id?.startsWith('tool_')).toBe(true)
  })
})

describe('createToolResultMessage', () => {
  it('defaults is_error to false', () => {
    const c = createToolResultMessage('tid', 'out')
    expect(c).toMatchObject({ type: 'tool_result', tool_use_id: 'tid', content: 'out', is_error: false })
  })

  it('honors is_error true', () => {
    expect(createToolResultMessage('tid', 'boom', true).is_error).toBe(true)
  })
})

describe('extractTextContent', () => {
  it('joins multiple text blocks with newline', () => {
    const m = createMessage('assistant', [
      { type: 'text', text: 'a' },
      { type: 'tool_use', name: 'X' },
      { type: 'text', text: 'b' },
    ])
    expect(extractTextContent(m)).toBe('a\nb')
  })

  it('returns empty string when no text blocks', () => {
    const m = createMessage('assistant', [{ type: 'tool_use', name: 'X' }])
    expect(extractTextContent(m)).toBe('')
  })

  it('treats text block with undefined text as empty', () => {
    const m: Message = { id: 'm', role: 'assistant', content: [{ type: 'text' }], timestamp: 0 }
    expect(extractTextContent(m)).toBe('')
  })
})

describe('extractToolUses / extractToolResults', () => {
  it('filters by type', () => {
    const m = createMessage('assistant', [
      { type: 'text', text: 'a' },
      { type: 'tool_use', name: 'X' },
      { type: 'tool_result', tool_use_id: 't', content: 'r' },
    ])
    expect(extractToolUses(m)).toHaveLength(1)
    expect(extractToolResults(m)).toHaveLength(1)
  })
})
