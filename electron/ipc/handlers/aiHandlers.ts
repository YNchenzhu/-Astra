/**
 * AI chat + runtime-control IPC handlers.
 *
 * Channels:
 *   - `ai:send-message`                    start a streamed conversation
 *   - `ai:cancel`                          abort one (or all) streams
 *   - `ai:stop-task` / `ai:retry-task`     renderer tool-card controls
 *   - `hooks:fire-status-line` / `hooks:fire-file-suggestion`
 *   - `ai:respond-permission-request`      per-request allow/deny reply
 *   - `ai:team-permission-reply`           team-leader delegate reply
 *   - `ai:permission-relay-reply`          oobus stdin relay line reply
 *   - `ai:set-diff-permission-mode`        hot-swap diff审核/auto模式
 *   - `ai:respond-ask-user-question`       AskUserQuestion tool reply
 */
import type { IpcMain } from 'electron'
import { validatedHandle } from '../validatedHandle'
import {
  aiCancelArgs,
  aiCancelTeammateArgs,
  aiEnqueueMidTurnInputArgs,
  aiPermissionRelayReplyArgs,
  aiRespondAskUserQuestionArgs,
  aiRespondPermissionRequestArgs,
  aiRespondPlanApprovalArgs,
  aiRespondTeamPlanApprovalArgs,
  aiRetryTaskArgs,
  aiRunTeammateArgs,
  aiSendMessageArgs,
  aiSetDiffPermissionModeArgs,
  aiStopTaskArgs,
  aiTeamPermissionReplyArgs,
  hooksFirePayloadArgs,
} from '../schemas'
import { loadSettings } from '../../settings/settingsStore'
import { getMainWindow } from '../../window/mainWindow'
import { handleSendMessage, cancelStream } from '../../ai/streamHandler'
import { interruptOrchestrationKernelForConversation } from '../../orchestration/activeKernelRegistry'
import { enqueueMidTurnUserInput } from '../../orchestration/inbox'
import {
  cancelTeammateRun,
  runTeammateInMain,
  setTeammateMainWindow,
} from '../../agents/teammateRunner'
import { PROVIDER_ENTRY_BY_ID, type ProviderId } from '../../../src/data/providerRegistry'
import type { ProviderConfig } from '../../ai/client'
import { setWorkspacePath } from '../../tools/workspaceState'
import { acceptWorkspacePathFromRenderer } from '../../security/workspaceAccept'
import { prepareToolUseRetry, stopToolUseById } from '../../ai/mainProcessToolControl'
import {
  fireFileSuggestionHooks,
  fireStatusLineHooks,
} from '../../tools/hooks/runtimeHookBridges'
import {
  respondAskUserQuestion,
  respondPermissionRequest,
  setDiffPermissionMode as setDiffPermissionModeState,
} from '../../ai/interactionState'
import { resolveTeamLeaderPermissionResponse } from '../../agents/teamPermissionLeaderBridge'
import { resolveTeamLeaderPlanApprovalResponse } from '../../agents/teamPlanApprovalLeaderBridge'
import { resolveMainChatPlanApprovalResponse } from '../../agents/mainChatPlanApprovalBridge'
import { applyPermissionRelayReply } from '../../ai/permissionRelayBridge'

export function registerAiHandlers(_ipcMain: IpcMain): void {
  validatedHandle('ai:send-message', aiSendMessageArgs, async (_event, [params]) => {
    const mainWindow = getMainWindow()
    if (!mainWindow) {
      throw new Error('No window available')
    }

    // Establish workspace path so built-in tools (Grep/Read/etc.) use it
    // instead of process.cwd().
    //
    // Audit fix A2 (2026-05) — route the renderer-supplied path through the
    // trust boundary. Strict mode rejects unknown paths; legacy mode (default)
    // auto-trusts + logs an audit line. The check is memoized so the
    // per-message overhead is a Map lookup, not a JSON file read.
    if (params.workspacePath) {
      const outcome = acceptWorkspacePathFromRenderer(params.workspacePath, {
        source: 'ai:send-message',
      })
      if (!outcome.ok) {
        throw new Error(outcome.reason)
      }
      if (outcome.effective) {
        setWorkspacePath(outcome.effective)
      }
    }

    const settings = loadSettings()

    const paramsRecord = params as Record<string, unknown>
    const merged = {
      ...paramsRecord,
      providerId: paramsRecord.providerId || settings.providerId || 'anthropic',
      apiKey: paramsRecord.apiKey || settings.apiKey || '',
      baseUrl: paramsRecord.baseUrl || settings.baseUrl || '',
      anthropicThinkingCapability:
        paramsRecord.anthropicThinkingCapability ||
        settings.anthropicThinkingCapability ||
        'auto',
      awsRegion: paramsRecord.awsRegion || settings.awsRegion || '',
      projectId: paramsRecord.projectId || settings.projectId || '',
      outputStyle: paramsRecord.outputStyle || settings.outputStyle || 'default',
      language: paramsRecord.language ?? settings.language ?? '',
      injectLspPassiveDiagnostics:
        paramsRecord.injectLspPassiveDiagnostics ?? settings.injectLspPassiveDiagnostics ?? true,
      fastMode:
        typeof paramsRecord.fastMode === 'boolean'
          ? paramsRecord.fastMode
          : Boolean(settings.fastMode),
      effortLevel: paramsRecord.effortLevel || settings.effortLevel || undefined,
      autoTaskRouting:
        typeof paramsRecord.autoTaskRouting === 'boolean'
          ? paramsRecord.autoTaskRouting
          : Boolean(settings.autoTaskRouting),
    }
    await handleSendMessage(mainWindow, merged as Parameters<typeof handleSendMessage>[1])
  })

  validatedHandle('hooks:fire-status-line', hooksFirePayloadArgs, (_event, [payload]) => {
    fireStatusLineHooks(payload ?? {})
    return { ok: true as const }
  })

  validatedHandle('hooks:fire-file-suggestion', hooksFirePayloadArgs, (_event, [payload]) => {
    fireFileSuggestionHooks(payload ?? {})
    return { ok: true as const }
  })

  validatedHandle('ai:cancel', aiCancelArgs, (_event, [conversationId]) => {
    // P1-4 — route Stop through the kernel FIRST so it emits an `interrupt`
    // phase event (reason 'user'), giving the renderer a visible cause
    // (P0-3 toast + OrchestrationTimeline) and unifying the chat Stop path
    // with RunningAgents' `abortActive`. No-op when no kernel is registered
    // (legacy `runAgenticLoop` path / already-ended turn).
    //
    // We deliberately do NOT rely on the kernel's soft→hard 30s grace here:
    // `cancelStream` immediately aborts the streamHandler AbortController,
    // which `callModel` merges into BOTH the soft AND hard tool signals, so
    // the first Stop stays effectively immediate for `interruptBehavior:
    // 'block'` tools too. The kernel interrupt is purely for observability +
    // path unification; the grace timer is cleared on turn teardown
    // (`unregisterOrchestrationKernelForConversation` → `dispose()`).
    if (typeof conversationId === 'string' && conversationId.trim()) {
      interruptOrchestrationKernelForConversation(conversationId.trim(), 'user')
    }
    cancelStream(conversationId)
  })

  /** Renderer tool card「停止」→ {@link stopToolUseById}（此前 preload 已 invoke 但未注册，导致无效） */
  validatedHandle('ai:stop-task', aiStopTaskArgs, async (_event, [taskId]) => {
    return stopToolUseById(taskId.trim())
  })

  // M2 (2026-07 会话审计监控) — REAL user text typed while a main stream
  // is in flight. Routed to the kernel inbox with the user-input source
  // stamp so the mid-turn drain delivers it under the instruction-level
  // `kernel_user_input` side-channel kind (N2 fix). Returns the enqueue
  // result verbatim; the renderer falls back to its local replay queue on
  // `ok: false` (e.g. no kernel registered — never drop input).
  validatedHandle(
    'ai:enqueue-mid-turn-input',
    aiEnqueueMidTurnInputArgs,
    (_event, [params]) => {
      return enqueueMidTurnUserInput(params.conversationId.trim(), params.text)
    },
  )

  validatedHandle('ai:retry-task', aiRetryTaskArgs, async (_event, [taskId]) => {
    return prepareToolUseRetry(taskId.trim())
  })

  // BUG-I4 fix: route all five permission/answer surfaces through
  // `validatedHandle` so the main process rejects malformed payloads at
  // the IPC boundary rather than letting unchecked objects flow into
  // `respondPermissionRequest` / `resolveTeamLeaderPermissionResponse` /
  // `applyPermissionRelayReply` / `setDiffPermissionModeState` /
  // `respondAskUserQuestion`. Domain logic stays untouched.
  validatedHandle(
    'ai:respond-permission-request',
    aiRespondPermissionRequestArgs,
    (_event, [params]) => {
      return respondPermissionRequest(params)
    },
  )

  validatedHandle(
    'ai:team-permission-reply',
    aiTeamPermissionReplyArgs,
    (_event, [params]) => {
      return resolveTeamLeaderPermissionResponse({
        teamRequestId: params.teamRequestId,
        behavior: params.behavior,
        updatedInput: params.updatedInput,
        reason: params.behavior === 'deny' ? 'denied' : undefined,
      })
    },
  )

  // P0-2 follow-up: leader-side approval card (or any automation) resolves
  // a pending teammate `team_plan_approval_request` by calling this. The
  // resolver is shared between the TeamFile mailbox path and the
  // renderer-spawned chat-leader path; one IPC closes both.
  validatedHandle(
    'ai:respond-team-plan-approval',
    aiRespondTeamPlanApprovalArgs,
    (_event, [params]) => {
      const resolved = resolveTeamLeaderPlanApprovalResponse({
        teamRequestId: params.requestId,
        approved: params.approve,
        ...(params.detail ? { detail: params.detail } : {}),
        reason: 'lead_decision',
      })
      return { resolved }
    },
  )

  // the IDE `create_plan`-style main-chat plan approval. Tri-state outcome —
  // `cancelled` aborts the turn (the tool itself fires cancelStream after
  // the resolver unblocks); `rejected` keeps the model in plan mode;
  // `accepted` proceeds with implementation.
  validatedHandle(
    'ai:respond-plan-approval',
    aiRespondPlanApprovalArgs,
    (_event, [params]) => {
      const resolved = resolveMainChatPlanApprovalResponse({
        requestId: params.requestId,
        outcome: params.outcome,
        ...(params.detail ? { detail: params.detail } : {}),
        reason: 'user_decision',
      })
      return { resolved }
    },
  )

  validatedHandle(
    'ai:permission-relay-reply',
    aiPermissionRelayReplyArgs,
    (_event, [line]) => ({
      applied: applyPermissionRelayReply(line),
    }),
  )

  /**
   * 热切换 diff 权限模式(变更审核 ↔ 自动写入)。
   *
   * 用户在聊天输入框点那个开关时,即使 AI 正在跑任务,也能立即影响下一个
   * 工具调用 —— 不用停掉任务重开。`runAgenticToolUse` 的每一次 tool-use
   * 都会从 `interactionState` 读最新值。
   */
  validatedHandle(
    'ai:set-diff-permission-mode',
    aiSetDiffPermissionModeArgs,
    (_event, [mode, conversationId]) => {
      // P1-30: scope to a conversation when the renderer provides one.
      const cid = conversationId?.trim() ? conversationId.trim() : undefined
      setDiffPermissionModeState(mode, cid)
      return { ok: true as const, mode }
    },
  )

  validatedHandle(
    'ai:respond-ask-user-question',
    aiRespondAskUserQuestionArgs,
    (_event, [params]) => {
      return respondAskUserQuestion(params)
    },
  )

  // ── Teammate runner (in-process sub-agent) ─────────────────────────────
  // Replaces the renderer-side `runAgent.ts` shim. The teammate now uses
  // the same agentic loop the main chat does, so compaction / strip-retry /
  // prompt cache / fallback model parity is automatic. See
  // `electron/agents/teammateRunner.ts` for the full rationale.

  validatedHandle('ai:run-teammate', aiRunTeammateArgs, async (_event, [params]) => {
    const mainWindow = getMainWindow()
    if (!mainWindow) {
      throw new Error('No window available')
    }
    setTeammateMainWindow(mainWindow)

    // Resolve provider config: caller may pass apiKey/baseUrl/etc; otherwise
    // we fall back to disk settings — same precedence as `ai:send-message`.
    const settings = loadSettings()
    // Coerce zod-passthrough fields explicitly — `validatedHandle`'s inferred
    // tuple types preserve `passthrough()` keys as `unknown`, so even after
    // `||` short-circuiting TS still sees `{}` on the result. Coercing once
    // here keeps the builder-call below cleanly typed against `ProviderConfig`.
    const pickStr = (...vals: unknown[]): string | undefined => {
      for (const v of vals) {
        if (typeof v === 'string' && v.length > 0) return v
      }
      return undefined
    }
    const providerId = (pickStr(params.providerId, settings.providerId) ?? 'anthropic') as ProviderId
    const entry = PROVIDER_ENTRY_BY_ID[providerId]
    const config: ProviderConfig = {
      id: providerId,
      name: entry?.name || providerId,
      apiKey: pickStr(params.apiKey, settings.apiKey) ?? '',
      baseUrl: pickStr(params.baseUrl, settings.baseUrl),
      awsRegion: pickStr(params.awsRegion, settings.awsRegion),
      projectId: pickStr(params.projectId, settings.projectId),
    }

    const history = Array.isArray(params.history)
      ? (params.history as Array<{
          role: 'user' | 'assistant'
          content: string | Array<Record<string, unknown>>
        }>)
      : undefined

    // P0-2 follow-up: forward optional plan-mode delegation flags. Both
    // are validated again inside `runTeammateInMain` (it throws when
    // `planModeRequired` is set without a `leaderConversationId`).
    const planModeRequiredParam =
      typeof params.planModeRequired === 'boolean' ? params.planModeRequired : undefined
    const leaderConversationIdParam =
      typeof params.leaderConversationId === 'string' && params.leaderConversationId.trim()
        ? params.leaderConversationId.trim()
        : undefined

    // Team Active Loop (PR-2): forward team identity so the runner can
    // emit idle_notification envelopes at turn-end. Schema already
    // trims to optional non-empty strings — we still defensively strip
    // here because z.passthrough() can let blank strings sneak in.
    const teamNameParam =
      typeof params.teamName === 'string' && params.teamName.trim()
        ? params.teamName.trim()
        : undefined
    const leadAgentIdParam =
      typeof params.leadAgentId === 'string' && params.leadAgentId.trim()
        ? params.leadAgentId.trim()
        : undefined
    const teammateNameParam =
      typeof params.teammateName === 'string' && params.teammateName.trim()
        ? params.teammateName.trim()
        : undefined
    const teammateAgentTypeParam =
      typeof params.teammateAgentType === 'string' && params.teammateAgentType.trim()
        ? params.teammateAgentType.trim()
        : undefined

    const { runId, done } = runTeammateInMain({
      runId: params.runId,
      taskId: params.taskId,
      prompt: params.prompt,
      config,
      model: params.model,
      systemPrompt: params.systemPrompt,
      maxIterations: params.maxIterations,
      maxTokens: params.maxTokens,
      agentId: params.agentId,
      parentSessionId: params.parentSessionId,
      history,
      ...(planModeRequiredParam !== undefined ? { planModeRequired: planModeRequiredParam } : {}),
      ...(leaderConversationIdParam ? { leaderConversationId: leaderConversationIdParam } : {}),
      ...(teamNameParam ? { teamName: teamNameParam } : {}),
      ...(leadAgentIdParam ? { leadAgentId: leadAgentIdParam } : {}),
      ...(teammateNameParam ? { teammateName: teammateNameParam } : {}),
      ...(teammateAgentTypeParam ? { teammateAgentType: teammateAgentTypeParam } : {}),
    })

    // Don't block the IPC return on completion — the renderer subscribes to
    // `ai:teammate-stream-event` for the `done` signal. We swallow the
    // unhandled rejection here (already surfaced via the stream `error`
    // event); leaving it un-awaited would log a UnhandledPromiseRejection.
    void done.catch((err) => {
      console.warn('[teammateRunner] run rejected:', err)
    })

    return { runId }
  })

  validatedHandle('ai:cancel-teammate', aiCancelTeammateArgs, async (_event, [runId]) => {
    const cancelled = cancelTeammateRun(runId.trim())
    return { cancelled }
  })
}
