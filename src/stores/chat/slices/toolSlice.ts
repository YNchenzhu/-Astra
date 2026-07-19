/**
 * Tool-card control + permission/ask-user reply slice.
 *
 *   - `stopToolTask` / `retryToolTask` fire the main-process IPC and flip
 *     the matching block + toolUses entry to `stopped` / `running` so the
 *     UI spinner stops lying. Sub-agent tasks also trigger a desktop
 *     notification on stop when the user has that toggle on.
 *   - `respondToPermissionRequest` / `respondToAskUserQuestion` clear the
 *     `pending…` state after the IPC resolves successfully. They're kept
 *     here (not in `inputSlice`) because stopping / retrying a tool card is
 *     the same user-affordance family as approving / denying it.
 */
import type { StateCreator } from 'zustand'
import {
  respondPermissionRequest,
  respondAskUserQuestion,
  respondTeamPlanApproval,
  respondPlanApproval,
  stopTask,
  retryTask,
} from '../../../services/electronAPI'
import { maybeDesktopNotify } from '../desktopNotify'
import { useSettingsStore } from '../../useSettingsStore'
import type { ChatState } from '../types'

export type ToolSlice = Pick<ChatState,
  | 'stopToolTask' | 'retryToolTask'
  | 'respondToPermissionRequest' | 'respondToAskUserQuestion'
  | 'respondToTeamPlanApproval' | 'respondToPlanApproval'
>

export const createToolSlice: StateCreator<
  ChatState, [], [], ToolSlice
> = (set, get) => ({
  respondToPermissionRequest: async (params) => {
    const ok = await respondPermissionRequest(params)
    if (ok) {
      set({ pendingPermissionRequest: null })
    }
    return ok
  },

  respondToAskUserQuestion: async (params) => {
    // IPC handlers run outside the agentic-loop ALS context, so durable-HITL
    // answer routing needs an explicit conversation id from the renderer.
    const convId = get().currentConversationId
    const ok = await respondAskUserQuestion(
      convId && !params.conversationId ? { ...params, conversationId: convId } : params,
    )
    if (ok) {
      set({ pendingAskUserQuestion: null })
    }
    return ok
  },

  // P0-2 follow-up: leader-side approval card → IPC → main-process
  // resolver. Like the other respond actions, we clear the slot on
  // success so a stale card never shows after an approval landed.
  // Failure here is rare (would mean the worker timed out before we
  // replied, or the env override is on) — we still clear the slot
  // because the card has nothing to do anymore.
  respondToTeamPlanApproval: async (params) => {
    const ok = await respondTeamPlanApproval(params).catch(() => false)
    set((s) =>
      s.pendingTeamPlanApproval && s.pendingTeamPlanApproval.requestId === params.requestId
        ? { pendingTeamPlanApproval: null }
        : s,
    )
    return ok
  },

  // the IDE `create_plan`-style main-chat plan-approval card → IPC →
  // main-process tri-state resolver. Same clear-on-completion semantics
  // as the other resolvers; the slot is cleared even on IPC failure
  // because the card has nothing to do after a button click.
  respondToPlanApproval: async (params) => {
    const ok = await respondPlanApproval(params).catch(() => false)
    set((s) =>
      s.pendingPlanApproval && s.pendingPlanApproval.requestId === params.requestId
        ? { pendingPlanApproval: null }
        : s,
    )
    return ok
  },

  stopToolTask: async (toolUseId) => {
    let stoppedName = ''
    // P1-6: a tool_use that still carries `streamingInput` is a the IDE
    // 3-style placeholder created from `tool_input_delta` before the
    // model finished writing its args. The main process has NOT yet
    // registered any task for it (no `tool_start` → no
    // `streamingToolExecutor.addTool`), so a `stopTask` IPC necessarily
    // fails with "task not found" and the previous early-return left
    // the placeholder's status frozen on `running` — blinking caret
    // and pulse forever even though the user clicked stop.
    //
    // Detect the placeholder case up front and collapse locally
    // without an IPC round-trip. The renderer is the source of truth
    // for placeholder state anyway (main process has nothing to stop).
    let isPlaceholder = false
    const before = get()
    outer: for (const m of before.messages) {
      const tu = m.toolUses?.find((t) => t.id === toolUseId)
      if (tu) {
        stoppedName = tu.name
        isPlaceholder = !!tu.streamingInput
        break outer
      }
      for (const b of m.blocks || []) {
        if (b.type === 'tool_use' && b.id === toolUseId) {
          stoppedName = b.name
          break outer
        }
      }
    }
    const applyStoppedToStore = (): void => {
      set((s) => ({
        messages: s.messages.map((m) => {
          const blocks = m.blocks?.map((b) =>
            b.type === 'tool_use' && b.id === toolUseId
              ? { ...b, status: 'stopped' as const }
              : b,
          )
          const toolUses = m.toolUses?.map((t) =>
            t.id === toolUseId
              ? { ...t, status: 'stopped' as const, streamingInput: undefined }
              : t,
          )
          return {
            ...m,
            blocks: blocks ?? m.blocks,
            toolUses: toolUses ?? m.toolUses,
          }
        }),
      }))
    }
    if (isPlaceholder) {
      applyStoppedToStore()
      return
    }
    const stopResult = await stopTask(toolUseId)
    if (!stopResult.success) {
      console.warn('[ChatStore] stopTask failed:', stopResult.error ?? 'unknown')
      return
    }
    applyStoppedToStore()
    if (stoppedName === 'Agent') {
      maybeDesktopNotify({
        enabled: useSettingsStore.getState().notifyOnSubagentStopped,
        title: '子任务已停止',
        body: '已手动停止 Agent 子任务',
        otherSession: false,
      })
    }
  },

  retryToolTask: async (toolUseId) => {
    const retryResult = await retryTask(toolUseId)
    if (!retryResult.success) {
      console.warn('[ChatStore] retryTask failed:', retryResult.error ?? 'unknown')
      return
    }
    set((s) => ({
      messages: s.messages.map((m) => {
        const blocks = m.blocks?.map((b) =>
          b.type === 'tool_use' && b.id === toolUseId
            ? { ...b, status: 'running' as const, error: undefined, result: undefined }
            : b,
        )
        const toolUses = m.toolUses?.map((t) =>
          t.id === toolUseId
            ? { ...t, status: 'running' as const, error: undefined, result: undefined }
            : t,
        )
        return {
          ...m,
          blocks: blocks ?? m.blocks,
          toolUses: toolUses ?? m.toolUses,
        }
      }),
    }))
  },
})
