/**
 * Quit-path: flush every session slice that has messages (incl. background
 * tabs) so in-progress conversations are not lost when the user closes the
 * window.
 *
 * Deliberately synchronous-ish: no `preStageBlockImages` / `dehydrateMessages`
 * pass here — shutdown races with torn-down IPC, and attachment staging
 * awaits IPC round-trips that may never return once the preload is gone.
 * Foreground `saveCurrentConversation` + the streaming `message_stop` handler
 * already did that work; this is a last-ditch persist for slices that never
 * hit those paths before quit.
 */
import type { UseBoundStore, StoreApi } from 'zustand'
import { saveConversation } from '../../services/conversationAPI'
import { getActiveBundleId } from '../bundleStore'
import { useSettingsStore } from '../useSettingsStore'
import { useWorkspaceStore } from '../useWorkspaceStore'
import { stripStreamingUiFlags, applyPersistedTitleFromMeta } from './conversationPersistence'
import { readSlice } from './sessionSlice'
import type { ChatState } from './types'

export async function flushAllPersistedConversationsForQuit(
  useStore: UseBoundStore<StoreApi<ChatState>>,
): Promise<void> {
  const root = useWorkspaceStore.getState().rootPath || ''
  if (!root) return
  const s = useStore.getState()
  const settings = useSettingsStore.getState()
  const ids = new Set<string>()
  if (s.currentConversationId) ids.add(s.currentConversationId)
  for (const k of Object.keys(s.sessionBuffers)) ids.add(k)
  for (const convId of ids) {
    const sl = readSlice(s, convId)
    if (sl.messages.length === 0) continue
    try {
      const meta = await saveConversation({
        id: convId,
        messages: stripStreamingUiFlags(sl.messages, {
          compactThinking: settings.compactThinkingOnSave,
        }),
        workspacePath: root,
        model: settings.model,
        providerId: settings.providerId,
        todos: sl.todos.length > 0 ? sl.todos : undefined,
        bundleId: getActiveBundleId(),
      })
      applyPersistedTitleFromMeta(useStore.getState, useStore.setState, convId, meta)
    } catch (e) {
      console.error('[ChatStore] flushAllPersistedConversationsForQuit:', convId, e)
    }
  }
}
