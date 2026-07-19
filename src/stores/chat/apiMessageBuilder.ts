import type { ChatMessage } from '../../types'
import { useFileStore } from '../useFileStore'
import { useWorkspaceStore } from '../useWorkspaceStore'
import { useDiagnosticStore } from '../useDiagnosticStore'
import {
  normalizePath,
  toRelativePath,
  isAbsolutePath,
  joinWorkspaceRelative,
} from '../../services/pathUtils'
import {
  buildContext,
  buildMessagesWithContext,
  type AgentApiMessage,
} from '../../services/contextBuilder'
import type { RetrievedSnippet } from '../../services/semanticContext'

const MAX_CTX_DIAG = 24
const MAX_PER_FILE_CTX = 8

/**
 * Shared between the main send path and `/summary` session-memory extract
 * (upstream §3.5).
 *
 * Builds the API message payload by joining the current messages with:
 *   - active editor tab + content
 *   - list of open tabs (display form)
 *   - `@referencedFiles` as a path-only hint (`# referenced_paths`); the
 *     model is expected to call `read_file` itself when it actually needs
 *     the bytes. Pre-attaching the parsed body just made well-behaved
 *     agents read twice (once for free in the prompt, once via tool to
 *     "verify") and forced binary-doc decoding into the send path.
 *   - a bounded diagnostics summary for the contextual files
 *   - the persisted compact summary (if any) so we don't re-summarize
 *   - optional retrieval snippets (populated by `retrieveWithBudget` in
 *     `./retrievalBudget.ts` for the main send path; omitted for `/summary`
 *     which ships pristine history to the memory-extract worker).
 */
export function buildMainChatApiMessagesForSend(
  messages: ChatMessage[],
  referencedFiles: string[],
  compactSummary?: string,
  retrievedSnippets: RetrievedSnippet[] = [],
): AgentApiMessage[] {
  // Strip UI-only system artifacts before any conversion to API messages.
  // `compact_boundary` entries are dim horizontal dividers the renderer
  // inserts on `onContextCompact`; they must never reach the model.
  messages = messages.filter((m) => m.kind !== 'compact_boundary')
  const fileState = useFileStore.getState()
  const workspaceState = useWorkspaceStore.getState()
  const activeTab = fileState.tabs.find((t) => t.id === fileState.activeTabId)

  const referencedContexts = referencedFiles.map((p) => ({
    path: p,
    content: null as string | null,
  }))

  const rootPath = workspaceState.rootPath
  const diagnosticState = useDiagnosticStore.getState()
  const contextPaths: string[] = []
  if (activeTab?.path) {
    contextPaths.push(
      isAbsolutePath(activeTab.path)
        ? activeTab.path
        : joinWorkspaceRelative(rootPath, activeTab.path),
    )
  }
  for (const r of referencedFiles) {
    const abs = isAbsolutePath(r) ? r : joinWorkspaceRelative(rootPath, r)
    if (!contextPaths.some((p) => normalizePath(p) === normalizePath(abs))) {
      contextPaths.push(abs)
    }
  }

  const editorBlocks: string[] = []
  let ctxDiagCount = 0
  for (const fp of contextPaths) {
    if (ctxDiagCount >= MAX_CTX_DIAG) break
    const items = diagnosticState.findDiagnosticsForPath(fp)
    if (items.length === 0) continue
    const take = Math.min(items.length, MAX_PER_FILE_CTX, MAX_CTX_DIAG - ctxDiagCount)
    const rel = rootPath ? toRelativePath(fp, rootPath) : fp
    const lines = items
      .slice(0, take)
      .map(
        (d) => `- (${d.severity}) L${d.line}:${d.column} ${d.message.replace(/\s+/g, ' ').trim()}`,
      )
    editorBlocks.push(`### ${rel}\n${lines.join('\n')}`)
    ctxDiagCount += take
  }
  const editorDiagnosticsSummary = editorBlocks.length > 0 ? editorBlocks.join('\n\n') : null

  const openFilesForContext = fileState.tabs.map((t) => {
    const p = t.path
    if (!rootPath || isAbsolutePath(p)) return p
    const abs = joinWorkspaceRelative(rootPath, p).replace(/\\/g, '/')
    const relNorm = p.replace(/\\/g, '/')
    return relNorm !== abs ? `${relNorm} → ${abs}` : abs
  })

  const context = buildContext(
    activeTab?.path || null,
    activeTab?.content || null,
    openFilesForContext,
    workspaceState.rootPath,
    referencedContexts,
    retrievedSnippets,
    editorDiagnosticsSummary,
  )

  return buildMessagesWithContext(messages, context, undefined, compactSummary)
}

// NOTE: an async `buildMainChatApiMessagesForSendWithRetrieval` sibling used
// to live here — a sequential fan-out over lexical / workspace-vector /
// attachment-RAG that was kept around "for /summary backward compat". In
// practice `/summary` calls the sync `buildMainChatApiMessagesForSend` above
// and nothing else imported the async variant, so it was dead code that
// duplicated the production pipeline in `./retrievalBudget.ts`. Worse, its
// tests guarded an `excludeShas` contract that the live race-based
// `retrieveWithBudget` had silently dropped. The function and its re-export
// chain (storeCompose → useChatStore) have been removed; the corresponding
// test moved to `./retrievalBudget.excludeCurrentTurn.test.ts` where it now
// exercises the actual send path.
