/**
 * Bounded-time multi-source retrieval for the main chat send path.
 *
 * Motivation — upstream P0: the previous sequential retrieval (a
 * `buildMainChatApiMessagesForSendWithRetrieval` helper that has since been
 * removed; see the eulogy in `./apiMessageBuilder.ts`) waited up to 5+
 * seconds when the user had a large workspace vector index plus a cloud
 * embedding endpoint. Time to first token on a warm cache was fine, but
 * cold starts or a slow proxy would strand the user staring at an empty
 * assistant bubble. This module is the race-based replacement: three
 * retrieval sources run in parallel, whatever has settled inside
 * {@link RETRIEVAL_BUDGET_MS} is returned; whatever is still in flight is
 * abandoned (but its UI citations are still harvested by
 * {@link fireRetrievalUiCaptureAsync} on the trailing edge).
 *
 * Sources:
 *   1. **Lexical workspace retrieval** — {@link retrieveSemanticContext}
 *      (ripgrep under the hood). Always cheap (<300 ms warm).
 *   2. **Workspace vector retrieval** — `window.electronAPI.workspaceIndex.query`.
 *      Skipped when the IPC is unavailable or no index is built.
 *   3. **Attachment RAG** — {@link retrieveAttachmentChunks} over the
 *      sha256-keyed vector store; degrades gracefully when no embedding
 *      model is configured.
 *
 * Splitting this out of `storeCompose.ts` is part of the chat-store
 * deduplication work — the composer module should own the Zustand surface,
 * not inlined retrieval pipelines. See {@link ./sessionSlice} and
 * {@link ./conversationPersistence} for the parallel extractions of the
 * buffer-slice and persistence helpers.
 */

import type { ChatMessage, RetrievedChunkDisplay } from '../../types'
import {
  retrieveAttachmentChunks,
  ragHitsToSnippets,
} from '../../services/rag'
import { retrieveSemanticContext } from '../../services/semanticContext'
import { useWorkspaceStore } from '../useWorkspaceStore'

/** Hard cap on how long the racing retrieval fan-out is allowed to block. */
export const RETRIEVAL_BUDGET_MS = 800

/**
 * Uniform shape emitted into the leading user-context block by every
 * retrieval source. Kept structurally compatible with {@link ./../../services/semanticContext}
 * `RetrievedSnippet` so callers can splice both into the same array.
 */
export interface SnippetPayload {
  filePath: string
  relativePath: string
  lines: string
  matchCount: number
}

/**
 * Run all three retrieval sources in parallel; return whatever landed
 * inside {@link RETRIEVAL_BUDGET_MS}. Never throws — each source's
 * failure is logged and its slot returns no snippets.
 *
 * @param allMessages — conversation history so the RAG layer can collect
 * attachment shas from ALL prior turns (not just the current turn).
 * @param referencedFiles — `@file` mentions from the composer, passed
 * into the lexical retriever to prioritise user-pinned paths.
 */
export async function retrieveWithBudget(
  allMessages: ChatMessage[],
  referencedFiles: string[],
): Promise<SnippetPayload[]> {
  const workspacePath = useWorkspaceStore.getState().rootPath
  const lastUser = [...allMessages].reverse().find((m) => m.role === 'user')
  const query = typeof lastUser?.content === 'string' ? lastUser.content : ''
  if (!query.trim()) return []

  const snippets: SnippetPayload[] = []
  const tasks: Array<Promise<void>> = []

  // Current-turn self-skip for attachment RAG: the last user message's own
  // file attachments are already inlined as preamble by
  // `renderFileAttachmentText` (see `contextBuilder.ts`). Re-surfacing chunks
  // from the same sha256 would show the model the same paragraphs twice —
  // one long inline preamble + a "retrieved_snippets" rehash — burning
  // prompt budget and nudging the response toward repetitive rewording.
  // Attachments from earlier turns still go through normally; their text is
  // no longer inline (older user rows carry only a reference).
  const currentTurnShas: Set<string> = new Set()
  if (lastUser?.attachments) {
    for (const a of lastUser.attachments) {
      if (a.type === 'file' && a.sha256) currentTurnShas.add(a.sha256)
    }
  }

  // 1) Lexical workspace retrieval (ripgrep — cheap, usually <300ms).
  if (workspacePath) {
    tasks.push(
      (async () => {
        try {
          const r = await retrieveSemanticContext(workspacePath, query, referencedFiles)
          snippets.push(...r.snippets)
        } catch (err) {
          console.warn('[ChatStore] lexical retrieval failed:', err)
        }
      })(),
    )
  }

  // 2) Workspace semantic (vector) retrieval.
  if (workspacePath) {
    tasks.push(
      (async () => {
        try {
          const wapi = window.electronAPI?.workspaceIndex
          if (!wapi) return
          const hits = await wapi.query({ root: workspacePath, query, topK: 6 })
          for (const h of hits) {
            snippets.push({
              filePath: h.filePath,
              relativePath: h.filePath,
              lines: `# L${h.startLine}-L${h.endLine} (semantic score ${h.score.toFixed(3)})\n${h.text}`,
              matchCount: 1,
            })
          }
        } catch (err) {
          console.warn('[ChatStore] workspace vector retrieval failed:', err)
        }
      })(),
    )
  }

  // 3) Attachment RAG. `excludeShas` is the current-turn self-skip computed
  //    above — keep it wired or the inline preamble + RAG snippet will
  //    double-book the same PDF paragraphs in the prompt.
  tasks.push(
    (async () => {
      try {
        const hits = await retrieveAttachmentChunks(query, allMessages, {
          topK: 6,
          excludeShas: currentTurnShas,
        })
        snippets.push(...ragHitsToSnippets(hits))
      } catch (err) {
        console.warn('[ChatStore] RAG retrieval failed:', err)
      }
    })(),
  )

  // Race against a tight budget — whatever has landed by the cutoff wins.
  await Promise.race([
    Promise.allSettled(tasks),
    new Promise<void>((resolve) => setTimeout(resolve, RETRIEVAL_BUDGET_MS)),
  ])
  return snippets
}

/**
 * Trailing UI-only retrieval: captures attachment RAG hits onto the user
 * message as `retrievedChunks` so the "相关片段" pill strip can render them.
 * Fires AFTER send so it never blocks time-to-first-token; unbounded in
 * duration because it's a best-effort UI enrichment.
 *
 * @param userMessageId — the id of the just-sent user row that the hits
 * should decorate.
 * @param applyHits — callback that mutates the chat store's `messages`
 * array to attach the `retrievedChunks` to the correct row. Injected
 * (rather than imported) so this module stays decoupled from Zustand.
 */
export async function fireRetrievalUiCaptureAsync(
  userMessageId: string,
  allMessages: ChatMessage[],
  applyHits: (userMessageId: string, chunks: RetrievedChunkDisplay[]) => void,
): Promise<void> {
  const lastUser = [...allMessages].reverse().find((m) => m.role === 'user')
  const query = typeof lastUser?.content === 'string' ? lastUser.content : ''
  if (!query.trim()) return
  try {
    // Intentionally no `excludeShas` here: this path populates the "相关片段"
    // UI pill strip, not the LLM prompt. The user just uploaded this PDF and
    // expects to see which chunks of it were retrieved — self-skipping the
    // current turn would leave the pill strip blank for the most common
    // "ask about the thing I just dropped in" case. Double-injection into
    // the prompt is prevented in `retrieveWithBudget` above instead.
    const hits = await retrieveAttachmentChunks(query, allMessages, { topK: 6 })
    if (hits.length === 0) return
    const retrievedChunks: RetrievedChunkDisplay[] = hits.map((h, i) => {
      const nsMatch = /^att-[^-]+-([0-9a-f]+)$/.exec(h.namespace)
      return {
        id: `${h.namespace}#${i}`,
        attachmentName: (h.meta?.attachmentName as string) || 'attachment',
        attachmentKind: h.meta?.attachmentKind as RetrievedChunkDisplay['attachmentKind'],
        headingPath: (h.meta?.headingPath as string) || undefined,
        text: h.text,
        score: h.score,
        attachmentSha: nsMatch ? nsMatch[1] : undefined,
        rank: i + 1,
      }
    })
    applyHits(userMessageId, retrievedChunks)
  } catch (err) {
    console.warn('[ChatStore] RAG UI capture failed:', err)
  }
}
