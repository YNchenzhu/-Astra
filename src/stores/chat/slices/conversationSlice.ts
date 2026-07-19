/**
 * Conversation-lifecycle slice.
 *
 * Owns every action that moves the renderer between stored conversations:
 * save, load, new, delete, list, hydrate-on-workspace-switch, rename,
 * rewind, and the unified "clear context" reset.
 *
 * The heavy attachment staging / dehydration for saves lives in
 * `../../services/attachmentPersistence`; buffered persistence of
 * background tabs (on `message_stop` / `error`) lives in
 * `../conversationPersistence`. Both are imported so this slice stays
 * focused on "orchestrate across those pieces + apply store state".
 */
import type { StateCreator } from 'zustand'
import {
  cancelStream,
  cancelAllMainStreams,
  resetContext,
} from '../../../services/electronAPI'
import {
  saveConversation,
  loadConversation,
  listConversations,
  deleteConversation as deleteConvAPI,
  renameConversation as persistRenameConversation,
  resetThinkingClearLatch,
} from '../../../services/conversationAPI'
import {
  preStageBlockImages,
  dehydrateMessages,
  hydrateMessages,
} from '../../../services/attachmentPersistence'
import { getActiveBundleId } from '../../bundleStore'
import { useSettingsStore } from '../../useSettingsStore'
import { useWorkspaceStore } from '../../useWorkspaceStore'
import { reportUserActionError } from '../../../utils/reportUserActionError'
import {
  stripStreamingUiFlags,
  applyPersistedTitleFromMeta,
  healPoisonedToolUseBlocks,
} from '../conversationPersistence'
import {
  pendingAssistantByConversation,
  flushCurrentSessionToBuffers,
} from '../sessionSlice'
import { flushTurnQueueFor } from './sendSlice'
import { chatStoreApi } from '../storeApiRef'
import type { ChatMessage } from '../../../types'
import type { ChatSessionSlice, ChatState } from '../types'

export type ConversationSlice = Pick<ChatState,
  | 'saveCurrentConversation'
  | 'loadConversationById'
  | 'startNewConversation'
  | 'deleteConversationById'
  | 'loadRecentConversation'
  | 'hydrateAfterWorkspaceChange'
  | 'getConversationList'
  | 'clearConversationContext'
  | 'renameConversation'
  | 'rewindToMessage'
  | 'regenerateFromMessage'
  | 'editUserMessage'
>

function emptyRecallState(): Pick<
  ChatState,
  'recalledMemories' | 'recalledWorkspaceHits' | 'recalledAttachmentHits'
> {
  return {
    recalledMemories: [],
    recalledWorkspaceHits: [],
    recalledAttachmentHits: [],
  }
}

export const createConversationSlice: StateCreator<
  ChatState, [], [], ConversationSlice
> = (set, get) => ({
  saveCurrentConversation: async () => {
    const { messages, currentConversationId, todos, currentCompactSummary } = get()
    if (!currentConversationId || messages.length === 0) return

    const workspaceState = useWorkspaceStore.getState()
    const settings = useSettingsStore.getState()

    // Local strip of streaming-UI flags (same as before). When the user
    // has opted into `compactThinkingOnSave`, the strip pass also
    // truncates long historical thinking blocks — see
    // `conversationPersistence.ts#compactThinkingInMessages` for the
    // exact contract and trade-offs.
    const cleanLocal = stripStreamingUiFlags(messages, {
      compactThinking: settings.compactThinkingOnSave,
    })

    try {
      // …then stage heavy image/pdf base64 payloads into the main-process
      // attachment cache, finally dehydrate them into sha256 sentinels so the
      // conversation JSON stays small. `hydrateMessages` in loadConversationById
      // fills them back in on reload.
      const staged = await preStageBlockImages(cleanLocal)
      const toSave = dehydrateMessages(staged)
      const meta = await saveConversation({
        id: currentConversationId,
        messages: toSave,
        workspacePath: workspaceState.rootPath || '',
        model: settings.model,
        providerId: settings.providerId,
        todos: todos.length > 0 ? todos : undefined,
        compactSummary: currentCompactSummary || undefined,
        bundleId: getActiveBundleId(),
      })
      const api = chatStoreApi()
      applyPersistedTitleFromMeta(api.getState, api.setState, currentConversationId, meta)
    } catch (err) {
      console.error('[ChatStore] Failed to save conversation:', err)
    }
  },

  loadConversationById: async (convId: string) => {
    const workspaceState = useWorkspaceStore.getState()
    const { currentConversationId, messages } = get()

    if (currentConversationId === convId) {
      return
    }

    flushCurrentSessionToBuffers(set, get)

    // Keep background conversation streams running while switching tabs.
    // Users may run multiple sessions in parallel.

    if (currentConversationId && messages.length > 0) {
      await get().saveCurrentConversation()
    }

    try {
      const data = await loadConversation(
        convId,
        workspaceState.rootPath || '',
        getActiveBundleId(),
      )
      const title = data?.meta?.title || '新对话'
      const buf = get().sessionBuffers[convId]
      if (buf && buf.messages.length > 0) {
        set({
          messages: buf.messages,
          currentConversationId: convId,
          currentConversationTitle: title,
          todos: buf.todos,
          isTyping: buf.isTyping,
          pendingPermissionRequest: buf.pendingPermissionRequest,
          pendingAskUserQuestion: buf.pendingAskUserQuestion,
          currentCompactSummary:
            typeof data?.compactSummary === 'string' ? data.compactSummary : null,
          // Bug C fix — hydrate orchestration mirror from the resumed buffer
          // so Timeline / Toast / Drawer / etc. show this conversation's state
          // instead of leaking the previous tab's top-level values.
          orchestrationPhase: buf.orchestrationPhase ?? null,
          orchestrationIteration: buf.orchestrationIteration ?? 0,
          orchestrationInnerIteration: buf.orchestrationInnerIteration ?? 0,
          orchestrationPaused: buf.orchestrationPaused ?? false,
          permissionDenials: buf.permissionDenials ?? [],
          artifactManifests: buf.artifactManifests ?? [],
          checkpointList: buf.checkpointList ?? [],
          hitlPaused: buf.hitlPaused ?? null,
          // Audit R2 (2026-07) — kernelDiagnostics was missing from the Bug C
          // hydrate list: switching back to a conversation dropped its queued
          // diagnostic toasts (and leaked the previous tab's).
          kernelDiagnostics: buf.kernelDiagnostics ?? [],
          ...emptyRecallState(),
        })
        flushTurnQueueFor(convId)
        return
      }

      if (!data) {
        set({
          messages: [],
          currentConversationId: null,
          currentConversationTitle: '新对话',
          todos: [],
          isTyping: false,
          pendingPermissionRequest: null,
          pendingAskUserQuestion: null,
          // P1-40: clear cross-conversation recall residue.
          ...emptyRecallState(),
          // Bug C fix — reset orchestration mirror when no conversation is loaded.
          orchestrationPhase: null,
          orchestrationIteration: 0,
          orchestrationInnerIteration: 0,
          orchestrationPaused: false,
          permissionDenials: [],
          artifactManifests: [],
          checkpointList: [],
          hitlPaused: null,
          kernelDiagnostics: [],
        })
        return
      }

      const rawMessages = Array.isArray(data.messages) ? data.messages : []
      // Rehydrate any dehydrated attachment base64 payloads from the sha256
      // cache — saveCurrentConversation stored them as sentinels, so the
      // JSON stayed small. Cache misses leave behind graceful error-stubs
      // but still let the conversation open.
      const hydrated = await hydrateMessages(rawMessages as ChatMessage[])
      // Heal historical tool_use blocks that were persisted in the broken
      // `status='error' + error=''` shape — those blocks otherwise poison
      // every future turn's context through `contextBuilder.ts`' catch-all
      // (the user-reported `[Tool ended with status: error]` loop on
      // AskUserQuestion / etc.).
      const loadedMessages = healPoisonedToolUseBlocks(hydrated)
      // Drop fully-closed (completed/failed/cancelled) persisted todo lists
      // on load — they're session-local "AI is doing X" markers, not
      // conversation history (the underlying TodoWrite tool_use cards
      // stay in `messages`). Without this, a finished checklist sticks
      // above the input forever after re-opening the conversation.
      const persistedTodos = Array.isArray(data.todos) ? data.todos : []
      const loadedTodos = persistedTodos.some(
        (t) => t.status === 'pending' || t.status === 'in_progress',
      )
        ? persistedTodos
        : []
      const slice: ChatSessionSlice = {
        messages: loadedMessages,
        todos: loadedTodos,
        isTyping: false,
        pendingPermissionRequest: null,
        pendingAskUserQuestion: null,
        pendingTeamPlanApproval: null,
        pendingPlanApproval: null,
        // Bug C fix — orchestration mirror starts blank for a fresh load
        // (this conversation hasn't run a kernel turn yet in this session).
        orchestrationPhase: null,
        orchestrationIteration: 0,
        orchestrationInnerIteration: 0,
        orchestrationPaused: false,
        permissionDenials: [],
        artifactManifests: [],
        checkpointList: [],
        hitlPaused: null,
      }
      set((st) => ({
        messages: loadedMessages,
        currentConversationId: convId,
        currentConversationTitle: title,
        todos: loadedTodos,
        isTyping: false,
        pendingPermissionRequest: null,
        pendingAskUserQuestion: null,
        currentCompactSummary:
          typeof data.compactSummary === 'string' ? data.compactSummary : null,
        // P1-40: when switching conversations, the previously-displayed
        // recalled-memory chips belong to the OLD chat. Reset so the new
        // conversation starts blank — fresh recall events repopulate as
        // they arrive on its own stream.
        ...emptyRecallState(),
        sessionBuffers: { ...st.sessionBuffers, [convId]: slice },
        // Bug C fix — reset top-level orchestration mirror to match the freshly
        // loaded (and orchestration-empty) slice.
        orchestrationPhase: null,
        orchestrationIteration: 0,
        orchestrationInnerIteration: 0,
        orchestrationPaused: false,
        permissionDenials: [],
        artifactManifests: [],
        checkpointList: [],
        hitlPaused: null,
        kernelDiagnostics: [],
      }))
      // If user had typed-ahead while this conversation was streaming in the
      // background, release the parked turns now that we're back on the tab.
      flushTurnQueueFor(convId)
    } catch (err) {
      console.error('[ChatStore] Failed to load conversation:', err)
      set({
        messages: [],
        currentConversationId: null,
        currentConversationTitle: '新对话',
        todos: [],
        isTyping: false,
        pendingPermissionRequest: null,
        pendingAskUserQuestion: null,
        // P1-40: same reset on error path.
        ...emptyRecallState(),
        // Bug C fix — orchestration mirror reset on error path too.
        orchestrationPhase: null,
        orchestrationIteration: 0,
        orchestrationInnerIteration: 0,
        orchestrationPaused: false,
        permissionDenials: [],
        artifactManifests: [],
        checkpointList: [],
        hitlPaused: null,
        kernelDiagnostics: [],
      })
    }
  },

  startNewConversation: async () => {
    const { currentConversationId, messages } = get()
    const convIdForReset = currentConversationId?.trim() || ''

    // Park the active slice for the old id (partial stream / permissions).
    flushCurrentSessionToBuffers(set, get)

    // Do not cancel existing conversation streams when creating a new chat.
    // Parallel sessions are expected to continue in the background.

    if (currentConversationId && messages.length > 0) {
      await get().saveCurrentConversation()
    }

    // §10.4 latch refresh — 老会话即将被切走，复位它的 thinking-clear latch 让
    // 用户下次回到该会话续聊时（或 fork 出新 turn）重新评估 1h idle 条件。
    // Fire-and-forget；旧版本 main 没注册 IPC 就静默降级。
    if (convIdForReset) {
      void resetThinkingClearLatch(convIdForReset)
    }

    try {
      await resetContext(convIdForReset ? { conversationId: convIdForReset } : undefined)
    } catch {
      /* ignore — same as clearConversationContext */
    }

    set({
      messages: [],
      currentConversationId: null,
      currentConversationTitle: '新对话',
      isTyping: false,
      inputText: '',
      pendingPermissionRequest: null,
      pendingAskUserQuestion: null,
      todos: [],
      currentCompactSummary: null,
      ...emptyRecallState(),
    })
  },

  deleteConversationById: async (convId: string) => {
    const workspaceState = useWorkspaceStore.getState()
    const root = workspaceState.rootPath || ''
    // 先尝试磁盘删除(best-effort):IPC 层面失败(例如 preload bridge
    // 断联)会抛,让上层 reportUserActionError 接住;磁盘上没有对应文件
    // (新建会话还没 message_stop 持久化)不是错误,走下面的内存清理。
    try {
      await deleteConvAPI(convId, root, getActiveBundleId())
    } catch (err) {
      console.error('[ChatStore] delete IPC failed, continuing in-memory cleanup:', err)
    }
    const api =
      typeof window !== 'undefined' && window.electronAPI ? window.electronAPI : null
    if (root.trim() && api?.session?.end) {
      try {
        await api.session.end({ workspacePath: root.trim(), conversationId: convId })
      } catch {
        /* ignore */
      }
    }
    await cancelStream(convId)
    pendingAssistantByConversation.delete(convId)
    set((s) => {
      const nextBuffers = { ...s.sessionBuffers }
      delete nextBuffers[convId]
      if (s.currentConversationId !== convId) {
        return { sessionBuffers: nextBuffers }
      }
      return {
        sessionBuffers: nextBuffers,
        messages: [],
        currentConversationId: null,
        currentConversationTitle: '新对话',
        isTyping: false,
        todos: [],
        pendingPermissionRequest: null,
        pendingAskUserQuestion: null,
        ...emptyRecallState(),
      }
    })
  },

  loadRecentConversation: async () => {
    const workspaceState = useWorkspaceStore.getState()
    if (!workspaceState.rootPath) return

    try {
      const list = await listConversations(workspaceState.rootPath, getActiveBundleId())
      if (list && list.length > 0) {
        const mostRecent = list[0] // Already sorted by updatedAt desc
        await get().loadConversationById(mostRecent.id)
        set({
          inputText: '',
          referencedFiles: [],
          pendingAttachments: [],
          ...emptyRecallState(),
          autoApproveRemainingDiffs: false,
        })
      } else {
        set({
          messages: [],
          currentConversationId: null,
          currentConversationTitle: '新对话',
          todos: [],
          isTyping: false,
          inputText: '',
          pendingPermissionRequest: null,
          pendingAskUserQuestion: null,
          referencedFiles: [],
          pendingAttachments: [],
          ...emptyRecallState(),
          autoApproveRemainingDiffs: false,
        })
      }
    } catch (err) {
      console.error('[ChatStore] Failed to load recent conversation:', err)
    }
  },

  hydrateAfterWorkspaceChange: async () => {
    try { pendingAssistantByConversation?.clear() } catch { /* defensive */ }
    await cancelAllMainStreams()

    const root = useWorkspaceStore.getState().rootPath
    if (!root) {
      set({
        messages: [],
        sessionBuffers: {},
        currentConversationId: null,
        currentConversationTitle: '新对话',
        todos: [],
        inputText: '',
        referencedFiles: [],
        pendingAttachments: [],
        ...emptyRecallState(),
        autoApproveRemainingDiffs: false,
        isTyping: false,
        pendingPermissionRequest: null,
        pendingAskUserQuestion: null,
      })
      await get().clearConversationContext({ endAllSessions: true })
      return
    }

    // Drop previous workspace UI immediately — avoids showing old messages until list/load finishes.
    set({
      sessionBuffers: {},
      messages: [],
      currentConversationId: null,
      currentConversationTitle: '新对话',
      todos: [],
      isTyping: false,
      pendingPermissionRequest: null,
      pendingAskUserQuestion: null,
      inputText: '',
      referencedFiles: [],
      pendingAttachments: [],
      ...emptyRecallState(),
      autoApproveRemainingDiffs: false,
    })

    try {
      const list = await listConversations(root, getActiveBundleId())
      if (list && list.length > 0) {
        await get().loadConversationById(list[0].id)
        set({
          inputText: '',
          referencedFiles: [],
          pendingAttachments: [],
          ...emptyRecallState(),
          autoApproveRemainingDiffs: false,
        })
      } else {
        set({
          messages: [],
          sessionBuffers: {},
          currentConversationId: null,
          currentConversationTitle: '新对话',
          todos: [],
          inputText: '',
          referencedFiles: [],
          pendingAttachments: [],
          ...emptyRecallState(),
          autoApproveRemainingDiffs: false,
        })
      }
    } catch (err) {
      console.error('[ChatStore] hydrateAfterWorkspaceChange failed:', err)
      set({
        messages: [],
        sessionBuffers: {},
        currentConversationId: null,
        currentConversationTitle: '新对话',
        todos: [],
        inputText: '',
        referencedFiles: [],
        pendingAttachments: [],
        ...emptyRecallState(),
        autoApproveRemainingDiffs: false,
      })
    }

    await get().clearConversationContext({ endAllSessions: true })
  },

  getConversationList: async () => {
    const workspaceState = useWorkspaceStore.getState()
    if (!workspaceState.rootPath) return []
    try {
      return await listConversations(workspaceState.rootPath, getActiveBundleId())
    } catch (error) {
      // Old code returned `[]` on any failure with no trace, so an
      // unavailable `electronAPI.conversation.list` looked like "no
      // conversations yet". Log silently and fall back — UI already copes
      // with an empty list, we just want the reason discoverable in DevTools.
      reportUserActionError('加载会话列表', error, { silent: true })
      return []
    }
  },

  clearConversationContext: async (opts) => {
    const api =
      typeof window !== 'undefined' && window.electronAPI ? window.electronAPI : null
    // Track whether anything reported failure — previously both sub-steps
    // were silently swallowed, so the user saw "clear" succeed visually
    // while main-process state was unchanged. Bundle both into one alert.
    let clearError: unknown = null
    // §10.4 latch refresh — 收集要复位 latch 的会话 id（取自 explicit opts 或
     // 当前会话），在 resetContext 之前异步 fire-and-forget。本调用静默降级（旧
     // 版本 main 没注册 IPC 就跳过），不会阻塞清空流程。
    const cidForLatchReset =
      opts && 'conversationId' in opts && typeof opts.conversationId === 'string'
        ? opts.conversationId.trim()
        : get().currentConversationId?.trim() || ''
    if (cidForLatchReset) {
      void resetThinkingClearLatch(cidForLatchReset)
    }
    try {
      if (opts && 'endAllSessions' in opts && opts.endAllSessions) {
        await resetContext()
      } else if (
        opts &&
        'workspacePath' in opts &&
        typeof opts.conversationId === 'string' &&
        opts.conversationId.trim()
      ) {
        await resetContext({ conversationId: opts.conversationId.trim() })
      } else {
        const id = get().currentConversationId?.trim()
        await resetContext(id ? { conversationId: id } : undefined)
      }
    } catch (error) {
      clearError = error
    }
    try {
      if (opts && 'endAllSessions' in opts && opts.endAllSessions) {
        await api?.session?.end?.()
      } else if (
        opts &&
        'workspacePath' in opts &&
        typeof opts.workspacePath === 'string' &&
        opts.workspacePath.trim() &&
        typeof opts.conversationId === 'string' &&
        opts.conversationId.trim()
      ) {
        await api?.session?.end?.({
          workspacePath: opts.workspacePath.trim(),
          conversationId: opts.conversationId.trim(),
        })
      }
    } catch (error) {
      // If resetContext already failed, the primary cause is that one —
      // don't stack a second alert. Otherwise the session:end miss is the
      // thing the user needs to know about.
      if (clearError == null) clearError = error
    }
    set({ ...emptyRecallState(), pendingAttachments: [] })
    if (clearError != null) {
      reportUserActionError('清空会话上下文', clearError)
    }
  },

  renameConversation: async (convId: string, newTitle: string) => {
    const workspaceState = useWorkspaceStore.getState()
    const root = workspaceState.rootPath || ''
    await persistRenameConversation(convId, root, newTitle, getActiveBundleId())
    if (get().currentConversationId === convId) {
      set({ currentConversationTitle: newTitle.trim() || get().currentConversationTitle })
    }
  },

  rewindToMessage: async (messageId: string) => {
    const { messages } = get()
    const idx = messages.findIndex((m) => m.id === messageId)
    if (idx < 0) return
    const cid = get().currentConversationId
    if (cid) {
      await cancelStream(cid)
    }
    set({
      messages: messages.slice(0, idx),
      isTyping: false,
      pendingPermissionRequest: null,
      pendingAskUserQuestion: null,
    })
    const { currentConversationId } = get()
    if (currentConversationId) {
      void get().saveCurrentConversation()
    }
  },

  regenerateFromMessage: async (assistantMessageId: string) => {
    const { messages } = get()
    const idx = messages.findIndex((m) => m.id === assistantMessageId)
    if (idx < 0) return
    // Walk back to the user turn that produced this reply (the assistant
    // row may be preceded by other assistant rows, e.g. sub-agent slots).
    let userIdx = idx
    while (userIdx >= 0 && messages[userIdx].role !== 'user') userIdx -= 1
    if (userIdx < 0) return
    await resendFromUserMessage(get, set, userIdx, messages[userIdx].content)
  },

  editUserMessage: async (messageId: string, newContent: string) => {
    const trimmed = newContent.trim()
    if (!trimmed) return
    const { messages } = get()
    const idx = messages.findIndex((m) => m.id === messageId)
    if (idx < 0 || messages[idx].role !== 'user') return
    await resendFromUserMessage(get, set, idx, trimmed)
  },
})

/**
 * Shared tail of `regenerateFromMessage` / `editUserMessage`: cancel any
 * in-flight stream, truncate history so the target user turn is removed,
 * restore that turn's input state (text / referenced files / attachments),
 * and resend. No branching — the discarded tail is gone, matching the
 * `rewindToMessage` contract.
 */
async function resendFromUserMessage(
  get: () => ChatState,
  set: (partial: Partial<ChatState>) => void,
  userIdx: number,
  content: string,
): Promise<void> {
  const { messages } = get()
  const userMsg = messages[userIdx]
  const cid = get().currentConversationId
  if (cid) {
    await cancelStream(cid)
    // The stream router clears this on its own cancel event, but that can
    // land after our `sendMessage()` below — which would then queue the
    // turn instead of sending it. Drop the marker explicitly.
    pendingAssistantByConversation.delete(cid)
  }
  set({
    messages: messages.slice(0, userIdx),
    isTyping: false,
    pendingPermissionRequest: null,
    pendingAskUserQuestion: null,
    inputText: content,
    referencedFiles: userMsg.referencedFiles ? [...userMsg.referencedFiles] : [],
    pendingAttachments: userMsg.attachments ? [...userMsg.attachments] : [],
  })
  await get().sendMessage()
}
