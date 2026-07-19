/**
 * IPC handlers for conversation persistence.
 *
 * All handlers accept an optional trailing `bundleId` argument (plan
 * §4.5.4) — the active personal-workspace Bundle. When callers don't
 * provide it (or pass undefined), the service falls back to the
 * legacy 'code-dev' partition so existing on-disk data stays
 * discoverable without migration.
 */

import type { SaveConversationParams } from './types'
import * as service from './service'
import {
  cancelPendingInteractionsForConversation,
  clearPermissionModesForConversation,
} from '../ai/interactionState'
import { cleanupAnthropicBetaHeaderLatchForConversation } from '../ai/anthropicBetaHeaderLatch'
import {
  cleanupAnthropicThinkingApiContextForConversation,
  resetThinkingClearLatchOnly,
} from '../ai/anthropicThinkingApiContext'
import { clearSessionRecallBudgetForConversation } from '../memory/service'
import { deleteOrchestrationArtifactsForConversation } from '../orchestration/activeKernelRegistry'

/** Normalize bundleId from wire: accept string, undefined, or null. */
function normalizeBundleId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const t = raw.trim()
  return t.length > 0 ? t : undefined
}

export function registerConversationHandlers(ipcMain: Electron.IpcMain): void {
  ipcMain.handle(
    'conversation:save',
    (_event, params: SaveConversationParams) => {
      return service.saveConversation(params)
    },
  )

  ipcMain.handle(
    'conversation:load',
    (_event, convId: string, workspacePath: string, bundleId?: string) => {
      return service.loadConversation(convId, workspacePath, normalizeBundleId(bundleId))
    },
  )

  ipcMain.handle(
    'conversation:list',
    (_event, workspacePath: string, bundleId?: string) => {
      return service.listConversations(workspacePath, normalizeBundleId(bundleId))
    },
  )

  ipcMain.handle(
    'conversation:delete',
    async (_event, convId: string, workspacePath: string, bundleId?: string) => {
      // 先按指定的 bundle 分区尝试删除。若该分区里没有文件(常见于修复前
      // 把会话写到了 code-dev 兜底分区),再跨分区兜底一次 —— 让"旧数据
      // 删不掉"的边角不至于让用户看上去删除按钮失灵。
      const primary = service.deleteConversation(
        convId,
        workspacePath,
        normalizeBundleId(bundleId),
      )
      // Release per-conversation in-memory state so the various Maps/Sets
      // tracking permission overrides, latched beta tokens, and pending
      // permission/ask UI requests don't grow once per conversation
      // lifetime. Idempotent — safe to call even when the conversation
      // had no in-flight state.
      try {
        cancelPendingInteractionsForConversation(convId)
        clearPermissionModesForConversation(convId)
        cleanupAnthropicBetaHeaderLatchForConversation(convId)
        cleanupAnthropicThinkingApiContextForConversation(convId)
        clearSessionRecallBudgetForConversation(convId)
      } catch (err) {
        console.warn('[conversation:delete] post-delete cleanup failed:', err)
      }
      // Audit §3.2 wire-up — drop on-disk orchestration artifacts
      // (`<userData>/kernel-state/<id>.json` and
      // `<userData>/orchestration-inbox/<id>.json`). These files were
      // accumulating one per ever-existing conversation because the
      // `KernelPersistenceAdapter.delete` and `deleteInboxFromDisk` helpers
      // were defined but never called from production. Awaited so a slow
      // disk doesn't lose the cleanup to a renderer reload, but a failure
      // never blocks the user-visible conversation delete — the function
      // itself swallows its own errors.
      try {
        await deleteOrchestrationArtifactsForConversation(convId)
      } catch (err) {
        console.warn(
          '[conversation:delete] orchestration artifact cleanup failed:',
          err,
        )
      }
      return { success: primary }
    },
  )

  ipcMain.handle(
    'conversation:rename',
    (_event, convId: string, workspacePath: string, newTitle: string, bundleId?: string) => {
      return {
        success: service.renameConversation(
          convId,
          workspacePath,
          newTitle,
          normalizeBundleId(bundleId),
        ),
      }
    },
  )

  ipcMain.handle(
    'conversation:search',
    (_event, query: string, workspacePath?: string, bundleId?: string) => {
      return service.searchConversations(query, workspacePath, normalizeBundleId(bundleId))
    },
  )

  ipcMain.handle(
    'conversation:autoTitle',
    (_event, convId: string, workspacePath: string, bundleId?: string) => {
      return service.autoTitle(convId, workspacePath, normalizeBundleId(bundleId))
    },
  )

  ipcMain.handle(
    'conversation:set-order',
    (_event, workspacePath: string, orderedIds: string[], bundleId?: string) => {
      if (typeof workspacePath !== 'string' || !Array.isArray(orderedIds)) {
        return { success: false as const }
      }
      service.setConversationOrder(
        workspacePath,
        orderedIds.filter((id) => typeof id === 'string'),
        normalizeBundleId(bundleId),
      )
      return { success: true as const }
    },
  )

  // §10.4 latch refresh — renderer 在用户主动 /clear（startNewConversation /
  // clearConversationContext）后调用此 IPC，复位 thinking-clear latch 让下一次
  // agentic 请求重新评估 1h idle 条件。配套 main 进程内部的 autoCompact 成功
  // 路径也会直接调用 resetThinkingClearLatchOnly（无需 IPC）。
  //
  // 故意做成静默成功 — 旧版本 renderer 没有这个调用、新版本 renderer 拿
  // 不到响应都不应该让聊天流挂掉；最坏情况下 latch 多保留一段时间，下一次
  // 1h idle 评估时自然滚动。
  ipcMain.handle(
    'conversation:reset-thinking-clear-latch',
    (_event, conversationId: string) => {
      try {
        resetThinkingClearLatchOnly(
          typeof conversationId === 'string' ? conversationId : undefined,
        )
        return { success: true as const }
      } catch (err) {
        console.warn(
          '[conversation:reset-thinking-clear-latch] failed:',
          err,
        )
        return { success: false as const }
      }
    },
  )
}
