/**
 * Coverage guard for `retrieveAttachmentChunks` → `excludeShas` option.
 *
 * Rationale: when the user's current turn carries an attachment whose FULL
 * text is already being inlined via `renderFileAttachmentText`, the same sha
 * must NOT also be queried through the RAG vector store — otherwise the model
 * sees the same paragraphs twice (inline preamble + `retrieved_snippets`),
 * burning prompt budget and nudging towards repetitive responses.
 *
 * These tests mock `window.electronAPI` + `useSettingsStore` to assert that
 * `queryAttachments` is called with exactly the shas we expect to be eligible.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { retrieveAttachmentChunks } from './rag'
import type { ChatMessage } from '../types/tool'

// ─── Minimal mocks ─────────────────────────────────────────────────────

const queryAttachmentsMock = vi.fn<
  (args: {
    query: string
    attachments: Array<{ sha256: string; kind: string }>
    topK: number
  }) => Promise<{ ok: true; hits: Array<{ text: string; score: number; namespace: string }> }>
>()

beforeEach(() => {
  queryAttachmentsMock.mockReset()
  queryAttachmentsMock.mockResolvedValue({ ok: true, hits: [] })

  // Inject a minimal electronAPI so `isEmbeddingAvailable` plus the
  // `eapi.queryAttachments` branch both succeed.
  ;(globalThis as unknown as { window: unknown }).window = {
    electronAPI: {
      embedding: {
        queryAttachments: queryAttachmentsMock,
      },
    },
  }

  // Stub `useSettingsStore.getState()` so `isEmbeddingAvailable` returns true
  // without dragging in the real settings subsystem. We monkey-patch the
  // module export via vi.mock below.
})

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window
})

vi.mock('../stores/useSettingsStore', () => ({
  useSettingsStore: {
    getState: (): {
      embeddingMode: string
      embeddingModel: string | null
      embeddingProviderId: string | null
      rerankModel: string | null
      rerankProviderId: string | null
    } => ({
      embeddingMode: 'auto',
      embeddingModel: 'bge-m3',
      embeddingProviderId: 'local',
      rerankModel: null,
      rerankProviderId: null,
    }),
  },
}))

// ─── Helpers ───────────────────────────────────────────────────────────

function msgWithAttachments(
  attachmentShas: string[],
  role: 'user' | 'assistant' = 'user',
): ChatMessage {
  return {
    id: `m-${Math.random()}`,
    role,
    content: '',
    timestamp: Date.now(),
    attachments: attachmentShas.map((sha) => ({
      type: 'file' as const,
      name: `f-${sha}.pdf`,
      path: `/tmp/f-${sha}`,
      size: 1_000,
      kind: 'pdf',
      mimeType: 'application/pdf',
      sha256: sha,
      status: 'ready' as const,
    })),
  }
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe('retrieveAttachmentChunks — excludeShas regression guard', () => {
  it('queries ALL unique attachment shas when no excludeShas is given', async () => {
    const messages = [
      msgWithAttachments(['sha-a', 'sha-b']),
      msgWithAttachments(['sha-c']),
    ]
    await retrieveAttachmentChunks('what is the gist?', messages)
    expect(queryAttachmentsMock).toHaveBeenCalledTimes(1)
    const args = queryAttachmentsMock.mock.calls[0][0]
    const shas = args.attachments.map((a) => a.sha256).sort()
    expect(shas).toEqual(['sha-a', 'sha-b', 'sha-c'])
  })

  it('skips shas in excludeShas (the current turn self-skip)', async () => {
    const messages = [
      msgWithAttachments(['sha-a']), // earlier turn
      msgWithAttachments(['sha-b', 'sha-c']), // current turn — excluded
    ]
    await retrieveAttachmentChunks('question', messages, {
      excludeShas: new Set(['sha-b', 'sha-c']),
    })
    expect(queryAttachmentsMock).toHaveBeenCalledTimes(1)
    const args = queryAttachmentsMock.mock.calls[0][0]
    const shas = args.attachments.map((a) => a.sha256)
    expect(shas).toEqual(['sha-a'])
  })

  it('returns empty and skips the IPC call when every attachment is excluded', async () => {
    const messages = [msgWithAttachments(['x', 'y'])]
    const hits = await retrieveAttachmentChunks('q', messages, {
      excludeShas: new Set(['x', 'y']),
    })
    expect(hits).toEqual([])
    expect(queryAttachmentsMock).not.toHaveBeenCalled()
  })

  it('does NOT apply excludeShas to kind — same sha with different kind is still excluded', async () => {
    // Edge case: the exclude set keys by sha, not `kind:sha`. A re-attached
    // file renamed to a different kind (rare, normally the sha collides
    // anyway on ingest) would still be excluded. This test locks that in.
    const messages = [
      msgWithAttachments(['dup']),
      {
        id: 'other',
        role: 'user' as const,
        content: '',
        timestamp: 2,
        attachments: [
          {
            type: 'file' as const,
            name: 'dup.md',
            path: '/tmp/dup.md',
            size: 10,
            kind: 'markdown' as const,
            mimeType: 'text/markdown',
            sha256: 'dup',
            status: 'ready' as const,
          },
        ],
      },
    ]
    await retrieveAttachmentChunks('q', messages, { excludeShas: new Set(['dup']) })
    expect(queryAttachmentsMock).not.toHaveBeenCalled()
  })

  it('still dedupes by kind:sha in the included set (same sha + same kind only once)', async () => {
    const messages = [
      msgWithAttachments(['a']),
      msgWithAttachments(['a']), // duplicate drop — should NOT double-query
      msgWithAttachments(['b']),
    ]
    await retrieveAttachmentChunks('q', messages)
    const args = queryAttachmentsMock.mock.calls[0][0]
    expect(args.attachments.filter((a) => a.sha256 === 'a')).toHaveLength(1)
    expect(args.attachments).toHaveLength(2)
  })
})
