/**
 * Integration test for `loadConversation` → `setTodos('main')`
 * restore wiring.
 *
 * Doesn't touch disk — uses `vi.mock` on `./storage` to inject a
 * fake conversation snapshot. Coverage:
 *   - `'v1-only'` mode: V1 store is rehydrated from transcript.
 *   - `'v2-only'` mode: V1 store untouched (TaskManager owns state).
 *   - `'coexist'` mode (default): V1 store IS rehydrated; V2 state
 *     restores via its own disk-backed path (not covered here).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ConversationData, ConversationMessage } from './types'

// `vi.mock` is hoisted above all `import`s by Vitest's transformer.
// Use `vi.hoisted` so the mock factory and the test bodies share the
// same `loadConversationFileMock` reference without the
// "Cannot access … before initialization" hoisting trap.
const { loadConversationFileMock } = vi.hoisted(() => ({
  loadConversationFileMock: vi.fn<
    (
      storagePath: string,
      convId: string,
      workspacePath: string,
      bundleId?: string,
    ) => ConversationData | null
  >(),
}))

vi.mock('./storage', async () => {
  const actual = await vi.importActual<typeof import('./storage')>('./storage')
  return {
    ...actual,
    loadConversationFile: loadConversationFileMock,
  }
})

// Imported AFTER the mock so the service binds to the mocked module.
import {
  initConversationService,
  loadConversation,
} from './service'
import { getTodos, resetTodos, setTodos } from '../tools/TodoWriteTool'

function userMsg(id: string, content: string): ConversationMessage {
  return { id, role: 'user', content, timestamp: 0 }
}

function assistantWithTodoWrite(
  id: string,
  todos: Array<{ content: string; status: string; activeForm?: string }>,
): ConversationMessage {
  return {
    id,
    role: 'assistant',
    content: 'updating todos',
    timestamp: 0,
    toolUses: [
      {
        id: `tu_${id}`,
        name: 'TodoWrite',
        input: { todos },
        status: 'completed',
      },
    ],
  }
}

function buildConversation(messages: ConversationMessage[]): ConversationData {
  return {
    meta: {
      id: 'conv-1',
      title: 'test',
      workspacePath: '/ws',
      createdAt: 0,
      updatedAt: 0,
      messageCount: messages.length,
    },
    messages,
  }
}

let testUserDataDir = ''

beforeEach(() => {
  loadConversationFileMock.mockReset()
  resetTodos('main')
  testUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-conversation-test-'))
  initConversationService(testUserDataDir)
})

afterEach(() => {
  resetTodos('main')
  delete process.env.ASTRA_TODO_V1
  delete process.env.ASTRA_TODO_MODE
  if (testUserDataDir) fs.rmSync(testUserDataDir, { recursive: true, force: true })
})

describe("loadConversation → setTodos ('v1-only' mode)", () => {
  beforeEach(() => {
    process.env.ASTRA_TODO_V1 = '1'
  })

  it('hydrates the main todo store from the most recent TodoWrite tool_use', () => {
    loadConversationFileMock.mockReturnValueOnce(
      buildConversation([
        userMsg('u1', 'do the things'),
        assistantWithTodoWrite('a1', [
          { content: 'step 1', status: 'in_progress', activeForm: 'doing step 1' },
          { content: 'step 2', status: 'pending', activeForm: 'doing step 2' },
        ]),
      ]),
    )
    loadConversation('conv-1', '/ws')
    const restored = getTodos('main')
    expect(restored).toEqual([
      { content: 'step 1', status: 'in_progress', activeForm: 'doing step 1' },
      { content: 'step 2', status: 'pending', activeForm: 'doing step 2' },
    ])
  })

  it('clears stale todos when the loaded conversation has no TodoWrite history', () => {
    setTodos('main', [
      { content: 'left over from prior conversation', status: 'in_progress', activeForm: '…' },
    ])
    loadConversationFileMock.mockReturnValueOnce(
      buildConversation([userMsg('u1', 'hi'), userMsg('u2', 'no tool here')]),
    )
    loadConversation('conv-1', '/ws')
    expect(getTodos('main')).toEqual([])
  })

  it('returns the raw conversation data unchanged regardless of restore outcome', () => {
    const conv = buildConversation([userMsg('u', 'hi')])
    loadConversationFileMock.mockReturnValueOnce(conv)
    const result = loadConversation('conv-1', '/ws')
    expect(result).toBe(conv)
  })

  it('audit A1: restoreMainTodoState:false leaves main todos untouched (H5 path)', () => {
    const live = { content: 'desktop live work', status: 'in_progress' as const, activeForm: '…' }
    setTodos('main', [live])
    loadConversationFileMock.mockReturnValueOnce(
      buildConversation([userMsg('u1', 'hi'), userMsg('u2', 'no tool')]),
    )
    // H5 rehydrate / read must NOT clobber the desktop's live main todos.
    loadConversation('conv-1', '/ws', undefined, { restoreMainTodoState: false })
    expect(getTodos('main')).toEqual([live])
  })

  it('does nothing when the loader returned null (missing file)', () => {
    const preserved = {
      content: 'should persist',
      status: 'pending' as const,
      activeForm: 'preserving',
    }
    setTodos('main', [preserved])
    loadConversationFileMock.mockReturnValueOnce(null)
    const result = loadConversation('missing', '/ws')
    expect(result).toBeNull()
    // Pre-existing state must remain — no spurious reset on null load.
    expect(getTodos('main')).toEqual([preserved])
  })
})

describe("loadConversation → setTodos ('v2-only' mode)", () => {
  beforeEach(() => {
    delete process.env.ASTRA_TODO_V1
    process.env.ASTRA_TODO_MODE = 'v2-only'
  })

  it('does NOT touch the V1 todo store in v2-only mode (TaskManager owns state)', () => {
    setTodos('main', [
      { content: 'do not overwrite', status: 'pending', activeForm: 'do not overwrite' },
    ])
    loadConversationFileMock.mockReturnValueOnce(
      buildConversation([
        assistantWithTodoWrite('a1', [
          { content: 'would have restored', status: 'pending' },
        ]),
      ]),
    )
    loadConversation('conv-1', '/ws')
    expect(getTodos('main')).toEqual([
      { content: 'do not overwrite', status: 'pending', activeForm: 'do not overwrite' },
    ])
  })
})

describe("loadConversation → setTodos ('coexist' mode — default)", () => {
  beforeEach(() => {
    delete process.env.ASTRA_TODO_V1
    delete process.env.ASTRA_TODO_MODE
  })

  it('rehydrates the V1 store from transcript even in coexist mode (V2 restores separately)', () => {
    loadConversationFileMock.mockReturnValueOnce(
      buildConversation([
        userMsg('u1', 'plan some work'),
        assistantWithTodoWrite('a1', [
          { content: 'coexist step', status: 'in_progress', activeForm: 'doing coexist step' },
        ]),
      ]),
    )
    loadConversation('conv-1', '/ws')
    expect(getTodos('main')).toEqual([
      { content: 'coexist step', status: 'in_progress', activeForm: 'doing coexist step' },
    ])
  })

  it('clears stale V1 todos when transcript has no TodoWrite history (coexist parity with v1-only)', () => {
    setTodos('main', [
      { content: 'stale leftover', status: 'in_progress', activeForm: 'stale leftover' },
    ])
    loadConversationFileMock.mockReturnValueOnce(
      buildConversation([userMsg('u1', 'no tools'), userMsg('u2', 'just chat')]),
    )
    loadConversation('conv-1', '/ws')
    expect(getTodos('main')).toEqual([])
  })
})
