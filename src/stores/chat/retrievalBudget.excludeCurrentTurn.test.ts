/**
 * Regression guard for `retrieveWithBudget`:
 *
 * The last user message's own file-attachment shas MUST be forwarded as
 * `excludeShas` when we hit the attachment-RAG source. Otherwise the live
 * send path shows the model the same paragraphs twice — once inline via
 * `renderFileAttachmentText`, once again as "retrieved_snippets" — which
 * burns prompt budget and nudges the model toward repetitive rewording.
 *
 * Historically this was guarded by tests on a now-deleted sibling function
 * (`buildMainChatApiMessagesForSendWithRetrieval`) which was dead code —
 * the tests stayed green but the live path (this module) had silently
 * dropped `excludeShas` during the race-based retrieval refactor. The
 * assertions below are deliberately narrow to `retrieveWithBudget` so
 * they fail if the self-skip is dropped again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '../../types'

const mocks = vi.hoisted(() => ({
  retrieveAttachmentChunks: vi.fn<
    (
      query: string,
      messages: ChatMessage[],
      opts?: { topK?: number; excludeShas?: ReadonlySet<string> },
    ) => Promise<Array<{ text: string; score: number; namespace: string }>>
  >(),
  ragHitsToSnippets: vi.fn(),
}))

vi.mock('../../services/rag', () => ({
  retrieveAttachmentChunks: mocks.retrieveAttachmentChunks,
  ragHitsToSnippets: mocks.ragHitsToSnippets,
}))

vi.mock('../../services/semanticContext', () => ({
  retrieveSemanticContext: vi.fn().mockResolvedValue({ snippets: [] }),
}))

vi.mock('../useWorkspaceStore', () => ({
  useWorkspaceStore: {
    getState: () => ({ rootPath: null }),
  },
}))

// Lazy import so the mocks are already registered.
import { retrieveWithBudget } from './retrievalBudget'

beforeEach(() => {
  mocks.retrieveAttachmentChunks.mockReset().mockResolvedValue([])
  mocks.ragHitsToSnippets.mockReset().mockReturnValue([])

  // Minimal electronAPI stub: workspaceIndex absent → vector source skipped.
  ;(globalThis as unknown as { window: unknown }).window = {
    electronAPI: undefined,
  }
})

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window
})

function userMsgWithShas(text: string, shas: string[]): ChatMessage {
  return {
    id: `u-${Math.random()}`,
    role: 'user',
    content: text,
    timestamp: Date.now(),
    attachments: shas.map((sha) => ({
      type: 'file' as const,
      name: `${sha}.pdf`,
      path: `/tmp/${sha}.pdf`,
      size: 1_000,
      kind: 'pdf',
      mimeType: 'application/pdf',
      sha256: sha,
      status: 'ready' as const,
    })),
  }
}

describe('retrieveWithBudget → RAG excludeShas', () => {
  it('passes the last user message attachment shas as excludeShas', async () => {
    const messages: ChatMessage[] = [
      userMsgWithShas('old question', ['older-sha']),
      { id: 'a1', role: 'assistant', content: 'ok', timestamp: 1 },
      userMsgWithShas('analyze this', ['current-sha-1', 'current-sha-2']),
    ]
    await retrieveWithBudget(messages, [])

    expect(mocks.retrieveAttachmentChunks).toHaveBeenCalledTimes(1)
    const [, , opts] = mocks.retrieveAttachmentChunks.mock.calls[0]
    expect(opts?.excludeShas).toBeInstanceOf(Set)
    const excluded = Array.from(opts!.excludeShas!).sort()
    expect(excluded).toEqual(['current-sha-1', 'current-sha-2'])
    expect(opts?.topK).toBe(6)
  })

  it('excludes nothing when the last user message has no attachments', async () => {
    const messages: ChatMessage[] = [
      userMsgWithShas('turn with attach', ['archived-sha']),
      { id: 'a1', role: 'assistant', content: 'ok', timestamp: 1 },
      {
        id: 'u2',
        role: 'user',
        content: 'just text, no attachments',
        timestamp: 2,
      },
    ]
    await retrieveWithBudget(messages, [])
    const [, , opts] = mocks.retrieveAttachmentChunks.mock.calls[0]
    expect(opts?.excludeShas).toBeInstanceOf(Set)
    expect(Array.from(opts!.excludeShas!)).toEqual([])
  })

  it('ignores attachments with no sha256 in the exclude set (defensive)', async () => {
    const bad: ChatMessage = {
      id: 'u-bad',
      role: 'user',
      content: 'in flight',
      timestamp: 3,
      attachments: [
        {
          type: 'file' as const,
          name: 'processing.pdf',
          path: 'pending:/tmp/x',
          size: 100,
          status: 'processing' as const,
        },
      ],
    }
    await retrieveWithBudget([bad], [])
    const [, , opts] = mocks.retrieveAttachmentChunks.mock.calls[0]
    expect(Array.from(opts!.excludeShas!)).toEqual([])
  })
})
