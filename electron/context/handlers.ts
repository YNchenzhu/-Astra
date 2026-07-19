/**
 * IPC handlers for context management.
 */

import {
  getConversationContextDisplayState,
  peekContextManagerForConversation,
  reapplyDisplayManagerThresholdsFromGlobal,
  resetConversationContextDisplay,
} from './conversationDisplayState'
import { contextManager } from './manager'
import { invalidateAllSystemPromptMemoCaches } from '../ai/systemPrompt'
import { analyzeContext, formatContextAnalysis, type ContextAnalysisData } from './analyzeContext'
import {
  getPromptDiagnosticsRecords,
  type PromptDiagnosticsRecord,
} from './promptDiagnostics'
import {
  formatBaselineComparison,
  formatBaselineReport,
} from '../diagnostics/baselineReport'
import { getAgentContext } from '../agents/agentContext'
import { getToolDefinitions } from '../tools/schema'
import { resetTodos } from '../tools/TodoWriteTool'
import { isTodoV1Enabled } from '../tools/todoMode'
import { writeDiskSettingsPartial } from '../settings/settingsAccess'
import {
  clearUserContextWindowOverride,
  getRegistryContextWindows,
  getUserContextWindowOverrides,
  setRegistryContextWindows,
  setUserContextWindowOverride,
} from './modelWindowOverrides'

export function registerContextHandlers(ipcMain: Electron.IpcMain): void {
  ipcMain.handle('context:get-state', (_event, conversationId?: unknown) => {
    return getConversationContextDisplayState(
      typeof conversationId === 'string' ? conversationId : undefined,
    )
  })

  ipcMain.handle(
    'context:get-prompt-diagnostics',
    (
      _event,
      payload?: { limit?: unknown; conversationId?: unknown } | number,
    ) => {
      // Back-compat: callers used to pass a bare number; new callers send
      // `{ limit, conversationId }`.
      if (typeof payload === 'number') {
        return getPromptDiagnosticsRecords(payload)
      }
      const limit = typeof payload?.limit === 'number' ? payload.limit : 20
      const conversationId =
        typeof payload?.conversationId === 'string' && payload.conversationId.trim()
          ? payload.conversationId.trim()
          : undefined
      return getPromptDiagnosticsRecords(limit, conversationId)
    },
  )

  ipcMain.handle(
    'context:render-baseline-comparison',
    (
      _event,
      payload: {
        title?: unknown
        baselineLabel?: unknown
        currentLabel?: unknown
        baseline?: unknown
        current?: unknown
      },
    ): string => {
      const baseline = Array.isArray(payload?.baseline)
        ? (payload.baseline as PromptDiagnosticsRecord[])
        : []
      const current = Array.isArray(payload?.current)
        ? (payload.current as PromptDiagnosticsRecord[])
        : []
      return formatBaselineComparison({
        title:
          typeof payload?.title === 'string' && payload.title.trim()
            ? payload.title.trim()
            : 'Claude Code alignment — Phase H comparison',
        baselineLabel:
          typeof payload?.baselineLabel === 'string' ? payload.baselineLabel : 'before',
        currentLabel:
          typeof payload?.currentLabel === 'string' ? payload.currentLabel : 'after',
        baseline,
        current,
      })
    },
  )

  ipcMain.handle(
    'context:render-baseline-report',
    (
      _event,
      payload: {
        title?: unknown
        prompt?: unknown
        notes?: unknown
        limit?: unknown
        conversationId?: unknown
      },
    ): string => {
      const limit = typeof payload?.limit === 'number' ? payload.limit : 50
      const conversationId =
        typeof payload?.conversationId === 'string' && payload.conversationId.trim()
          ? payload.conversationId.trim()
          : undefined
      const records = getPromptDiagnosticsRecords(limit, conversationId)
      return formatBaselineReport(records, {
        title: typeof payload?.title === 'string' && payload.title.trim()
          ? payload.title.trim()
          : 'Prompt Diagnostics Report',
        prompt: typeof payload?.prompt === 'string' ? payload.prompt : '(no prompt supplied)',
        notes: typeof payload?.notes === 'string' ? payload.notes : undefined,
      })
    },
  )

  ipcMain.handle('context:get-thresholds', () => {
    return contextManager.getThresholds()
  })

  ipcMain.handle('context:set-thresholds', async (_event, thresholds) => {
    contextManager.updateThresholds(thresholds)
    reapplyDisplayManagerThresholdsFromGlobal()
    // 系统级持久化修复：updateThresholds 会对非法值回退为默认，因此这里把
    // 合法化后的结果（contextManager 当前真实阈值）写回磁盘 settings，而非
    // 直接持久化用户提交的原始 partial —— 保证「磁盘内容 = 进程生效值」。
    await writeDiskSettingsPartial({
      contextThresholds: contextManager.getThresholds(),
    })
    return { success: true }
  })

  ipcMain.handle('context:reset', (_event, payload?: { conversationId?: string }) => {
    const id =
      payload && typeof payload.conversationId === 'string' ? payload.conversationId.trim() : ''
    if (id) {
      resetConversationContextDisplay(id)
    } else {
      resetConversationContextDisplay()
    }
    // Fix A (2026-05) — cross-conversation Todo leak. The V1 TodoWrite
    // store is a process-global Map keyed 'main' for the main chat, but
    // `resetTodos('main')` was only called from `loadConversation` (i.e.
    // when SWITCHING to an existing conversation). Starting a NEW
    // conversation / `/clear` goes through `context:reset`, NOT
    // `loadConversation`, so a prior task's `pending` items survived in
    // the global store and the staleTodoNudge collector later re-injected
    // them as a `<system-reminder>` — making the model resume work the
    // user never asked for in the fresh conversation. Resetting here
    // closes that gap. Gated on V1 being enabled (V2/TaskManager owns its
    // own disk-backed state and must not be touched).
    if (isTodoV1Enabled()) {
      resetTodos('main')
    }
    invalidateAllSystemPromptMemoCaches()
    return { success: true }
  })

  ipcMain.handle(
    'context:analyze',
    (
      _event,
      input: {
        model: string
        systemPrompt: string
        messages: Array<Record<string, unknown>>
        toolDefinitions?: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>
        memoryTokens?: number
        skillTokens?: number
      },
    ): ContextAnalysisData => {
      return analyzeContext(input)
    },
  )

  ipcMain.handle(
    'context:analyze-formatted',
    (
      _event,
      input: {
        model: string
        systemPrompt: string
        messages: Array<Record<string, unknown>>
        toolDefinitions?: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>
        memoryTokens?: number
        skillTokens?: number
      },
    ): string => {
      return formatContextAnalysis(analyzeContext(input))
    },
  )

  // ── Per-model context-window registry / overrides ───────────────────
  // The renderer pushes the registry-declared map once at boot; users
  // can also override individual entries from Settings → 上下文.
  // See `electron/context/modelWindowOverrides.ts` for the lookup chain.

  ipcMain.handle(
    'context:set-registry-windows',
    (_event, payload: unknown) => {
      if (!payload || typeof payload !== 'object') {
        return { success: false, error: 'invalid payload' }
      }
      const map: Record<string, number> = {}
      for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
        if (typeof v === 'number') map[k] = v
      }
      setRegistryContextWindows(map)
      return { success: true, count: Object.keys(map).length }
    },
  )

  ipcMain.handle('context:get-registry-windows', () => {
    return getRegistryContextWindows()
  })

  ipcMain.handle('context:get-user-window-overrides', () => {
    return getUserContextWindowOverrides()
  })

  ipcMain.handle(
    'context:set-user-window-override',
    async (_event, payload: { modelId?: unknown; tokens?: unknown }) => {
      const id = typeof payload?.modelId === 'string' ? payload.modelId.trim() : ''
      const tokens = typeof payload?.tokens === 'number' ? payload.tokens : NaN
      if (!id) return { success: false, error: 'modelId required' }
      const ok = setUserContextWindowOverride(id, tokens)
      if (!ok) return { success: false, error: 'invalid tokens (must be 1..100M)' }
      // Persist the full overrides map so disk reflects in-process state.
      await writeDiskSettingsPartial({
        modelContextWindowOverrides: getUserContextWindowOverrides(),
      })
      // Display-state recompute happens on next `evaluate`; nothing else
      // to invalidate immediately because thresholds are token-absolute.
      return { success: true }
    },
  )

  ipcMain.handle(
    'context:clear-user-window-override',
    async (_event, payload: { modelId?: unknown }) => {
      const id = typeof payload?.modelId === 'string' ? payload.modelId.trim() : ''
      if (!id) return { success: false, error: 'modelId required' }
      clearUserContextWindowOverride(id)
      await writeDiskSettingsPartial({
        modelContextWindowOverrides: getUserContextWindowOverrides(),
      })
      return { success: true }
    },
  )

  ipcMain.handle(
    'context:analyze-live-formatted',
    (): string => {
      // Convenience companion to `context:analyze-live` — returns the
      // markdown rendering directly so the renderer can drop it into a
      // /context inline note without re-implementing the formatter.
      const ctx = getAgentContext()
      const toolDefs = getToolDefinitions()
      const toolDefsForAnalysis = toolDefs.map((t) => ({
        name: t.name,
        description: t.description ?? '',
        input_schema: t.input_schema as Record<string, unknown>,
      }))
      const scopedState = ctx?.streamConversationId
        ? peekContextManagerForConversation(ctx.streamConversationId)?.getState()
        : undefined
      const state = scopedState ?? contextManager.getState()
      if (!ctx) {
        return formatContextAnalysis(
          analyzeContext({
            model: 'unknown',
            systemPrompt: '',
            messages: [],
            memoryTokens: 0,
            skillTokens: 0,
            toolDefinitions: toolDefsForAnalysis,
            liveEstimatedTokens: state.estimatedTokens,
            liveLevel: state.level,
            liveCompactCount: state.compactCount,
          }),
        )
      }
      return formatContextAnalysis(
        analyzeContext({
          model: 'unknown',
          systemPrompt: '',
          messages: [],
          memoryTokens: 0,
          skillTokens: 0,
          toolDefinitions: toolDefsForAnalysis,
          liveEstimatedTokens: state.estimatedTokens,
          liveLevel: state.level,
          liveCompactCount: state.compactCount,
        }),
      )
    },
  )

  ipcMain.handle(
    'context:analyze-live',
    (): ContextAnalysisData | null => {
      const ctx = getAgentContext()
      const toolDefs = getToolDefinitions()
      const toolDefsForAnalysis = toolDefs.map((t) => ({
        name: t.name,
        description: t.description ?? '',
        input_schema: t.input_schema as Record<string, unknown>,
      }))

      // Per-conversation scope: when the active agent context carries a
      // conversation id, prefer that scope's ContextManager state over the
      // global singleton — otherwise concurrent chats would pollute each
      // other's "live" token count / level.
      const scopedState = ctx?.streamConversationId
        ? peekContextManagerForConversation(ctx.streamConversationId)?.getState()
        : undefined
      const state = scopedState ?? contextManager.getState()

      if (!ctx) {
        return analyzeContext({
          model: 'unknown',
          systemPrompt: '',
          messages: [],
          memoryTokens: 0,
          skillTokens: 0,
          toolDefinitions: toolDefsForAnalysis,
          liveEstimatedTokens: state.estimatedTokens,
          liveLevel: state.level,
          liveCompactCount: state.compactCount,
        })
      }

      return analyzeContext({
        model: ctx.model || 'unknown',
        systemPrompt: ctx.systemPrompt || '',
        messages: ctx.messages || [],
        toolDefinitions: toolDefsForAnalysis,
        liveEstimatedTokens: state.estimatedTokens,
        liveLevel: state.level,
        liveCompactCount: state.compactCount,
      })
    },
  )
}
