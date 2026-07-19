/**
 * Tests for the transcript → in-memory todo store restore path.
 * upstream parity for `extractTodosFromTranscript` in
 * `src/utils/sessionRestore.ts`.
 */

import { describe, expect, it } from 'vitest'
import { extractTodosFromTranscript } from './extractTodos'
import type { ConversationMessage } from './types'

function userMsg(content: string, id = 'u1'): ConversationMessage {
  return { id, role: 'user', content, timestamp: 0 }
}

function assistantWithTodoWrite(
  todos: Array<Record<string, unknown>>,
  id = 'a1',
): ConversationMessage {
  return {
    id,
    role: 'assistant',
    content: 'updating todos',
    timestamp: 0,
    toolUses: [
      {
        id: 'tu1',
        name: 'TodoWrite',
        input: { todos },
        status: 'completed',
      },
    ],
  }
}

function assistantWithBlocksOnly(
  todos: Array<Record<string, unknown>>,
  id = 'a2',
): ConversationMessage {
  return {
    id,
    role: 'assistant',
    content: 'updating todos via blocks',
    timestamp: 0,
    blocks: [
      {
        type: 'tool_use',
        id: 'tu2',
        name: 'TodoWrite',
        input: { todos },
        status: 'completed',
      },
    ],
  }
}

describe('extractTodosFromTranscript', () => {
  it('returns [] for empty transcript', () => {
    expect(extractTodosFromTranscript([])).toEqual([])
  })

  it('returns [] when no TodoWrite call exists', () => {
    expect(
      extractTodosFromTranscript([
        userMsg('hi'),
        { id: 'a', role: 'assistant', content: 'hello', timestamp: 0 },
      ]),
    ).toEqual([])
  })

  it('extracts the most recent TodoWrite payload (toolUses path)', () => {
    const messages: ConversationMessage[] = [
      userMsg('first'),
      assistantWithTodoWrite([
        { content: 'old task', status: 'completed', activeForm: 'doing old' },
      ], 'a-old'),
      userMsg('next'),
      assistantWithTodoWrite([
        { content: 'new task', status: 'in_progress', activeForm: 'doing new' },
        { content: 'queued', status: 'pending', activeForm: 'queuing' },
      ], 'a-new'),
    ]
    const result = extractTodosFromTranscript(messages)
    expect(result).toEqual([
      { content: 'new task', status: 'in_progress', activeForm: 'doing new' },
      { content: 'queued', status: 'pending', activeForm: 'queuing' },
    ])
  })

  it('falls back to scanning blocks[] when toolUses is missing', () => {
    const messages: ConversationMessage[] = [
      userMsg('first'),
      assistantWithBlocksOnly([
        { content: 'blocks task', status: 'pending', activeForm: 'blocking' },
      ]),
    ]
    const result = extractTodosFromTranscript(messages)
    expect(result).toEqual([
      { content: 'blocks task', status: 'pending', activeForm: 'blocking' },
    ])
  })

  it('coerces missing activeForm to content', () => {
    const result = extractTodosFromTranscript([
      assistantWithTodoWrite([
        { content: 'do thing', status: 'pending' },
      ]),
    ])
    expect(result).toEqual([
      { content: 'do thing', status: 'pending', activeForm: 'do thing' },
    ])
  })

  it('defaults invalid status to pending', () => {
    const result = extractTodosFromTranscript([
      assistantWithTodoWrite([
        { content: 'do thing', status: 'bogus', activeForm: 'doing thing' },
      ]),
    ])
    expect(result[0]?.status).toBe('pending')
  })

  it('returns [] when the most recent payload is structurally invalid', () => {
    const messages: ConversationMessage[] = [
      assistantWithTodoWrite([
        { content: 'good', status: 'pending', activeForm: 'good' },
      ], 'a-old'),
      // newer call with bad shape — should suppress restore entirely
      // (upstream invariant: most-recent payload wins, no silent fallback)
      assistantWithTodoWrite([
        { status: 'pending' }, // no content
      ], 'a-bad'),
    ]
    expect(extractTodosFromTranscript(messages)).toEqual([])
  })
})
