import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../services/electronAPI', () => ({
  cancelStream: vi.fn().mockResolvedValue(undefined),
  cancelAllMainStreams: vi.fn().mockResolvedValue(undefined),
  resetContext: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../services/conversationAPI', () => ({
  saveConversation: vi.fn().mockResolvedValue(null),
  loadConversation: vi.fn().mockResolvedValue(null),
  listConversations: vi.fn().mockResolvedValue([]),
  deleteConversation: vi.fn().mockResolvedValue(true),
  renameConversation: vi.fn().mockResolvedValue({ success: true }),
  resetThinkingClearLatch: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../useSettingsStore', async () => {
  const m = await import('./mainStreamRouter.testMocks')
  return m.settingsStoreMock()
})
vi.mock('../useFileStore', async () => {
  const m = await import('./mainStreamRouter.testMocks')
  return m.fileStoreMock()
})
vi.mock('../useWorkspaceStore', async () => {
  const m = await import('./mainStreamRouter.testMocks')
  return m.workspaceStoreMock('/workspace-a')
})
vi.mock('../useBuddyStore', async () => {
  const m = await import('./mainStreamRouter.testMocks')
  return m.buddyStoreMock()
})

import { loadConversation, listConversations } from '../../services/conversationAPI'
import type { ChatMessage } from '../../types'
import { useChatStore } from './storeCompose'
import { resetChatStoreState } from './mainStreamRouter.testHelpers'

const recalledMemory = {
  filename: 'memory.md',
  content: 'old memory',
}

const recalledWorkspaceHit = {
  filePath: 'old-workspace.ts',
  startLine: 1,
  endLine: 2,
  score: 0.9,
  text: 'old workspace hit',
}

const recalledAttachmentHit = {
  namespace: 'old-attachment',
  score: 0.8,
  text: 'old attachment hit',
}

const bufferedMessage: ChatMessage = {
  id: 'buffered-assistant',
  role: 'assistant',
  content: 'buffered',
  timestamp: 1,
}

function seedRecallResidue(): void {
  useChatStore.setState({
    currentConversationId: 'old-conv',
    messages: [],
    recalledMemories: [recalledMemory],
    recalledWorkspaceHits: [recalledWorkspaceHit],
    recalledAttachmentHits: [recalledAttachmentHit],
  })
}

function expectRecallCleared(): void {
  const state = useChatStore.getState()
  expect(state.recalledMemories).toEqual([])
  expect(state.recalledWorkspaceHits).toEqual([])
  expect(state.recalledAttachmentHits).toEqual([])
}

beforeEach(() => {
  resetChatStoreState()
  vi.mocked(loadConversation).mockResolvedValue(null)
  vi.mocked(listConversations).mockResolvedValue([])
})

describe('conversation lifecycle recall reset', () => {
  it('clears retrieval citation residue when starting a new conversation', async () => {
    seedRecallResidue()

    await useChatStore.getState().startNewConversation()

    expectRecallCleared()
  })

  it('clears retrieval citation residue during workspace hydration', async () => {
    seedRecallResidue()

    await useChatStore.getState().hydrateAfterWorkspaceChange()

    expectRecallCleared()
  })

  it('clears retrieval citation residue when switching to a buffered conversation', async () => {
    seedRecallResidue()
    vi.mocked(loadConversation).mockResolvedValue({
      meta: {
        id: 'buffered-conv',
        title: 'Buffered',
        workspacePath: '/workspace-a',
        createdAt: 1,
        updatedAt: 1,
        messageCount: 1,
      },
      messages: [],
    })
    useChatStore.setState((state) => ({
      sessionBuffers: {
        ...state.sessionBuffers,
        'buffered-conv': {
          messages: [bufferedMessage],
          todos: [],
          isTyping: false,
          pendingPermissionRequest: null,
          pendingAskUserQuestion: null,
          pendingTeamPlanApproval: null,
          pendingPlanApproval: null,
        },
      },
    }))

    await useChatStore.getState().loadConversationById('buffered-conv')

    expectRecallCleared()
  })
})
