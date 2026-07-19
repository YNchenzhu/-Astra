import { app } from 'electron'
import type { ProviderConfig } from './client'
import { streamText } from './client'
import type { CompactDetail } from './agenticLoopTypes'
import type { ToolResultEventPayload } from './runAgenticToolUse'
import { getProviderQuirks } from './providerQuirks'
import {
  PLAN_MODE_BEHAVIOR_BLOCK,
  USER_MESSAGE_CONTEXT_DISCLAIMER,
  type SystemPromptLayers,
} from './systemPrompt'
import { buildMainSystemPromptLayersFromOrchestration } from './orchestrationContext'
import { SystemPromptBuilder } from './systemPromptBuilder'
import { runOrchestratedMainChat } from '../orchestration/runOrchestratedSession'
import { resetCoordinatorPhasesForNewTask } from '../orchestration/store'
import { getOrchestrationKernelForConversation } from '../orchestration/activeKernelRegistry'
import { getResourceQuotaManager } from '../orchestration/toolRuntime/quota'
import {
  createAppendixAFlowReporter,
  isAppendixAFlowTelemetryEnabled,
} from '../orchestration/appendixAFlow'
import { classifyAppendixAPhase1Route } from './appendixAPhase1Route'
import {
  consumePassiveLspDiagnosticsForPrompt,
  parseLspPassiveInjectMode,
} from '../lsp/formatDiagnosticsForPrompt'
import { ensureLspWorkspaceSynced } from '../lsp/manager'
import { buildBuddyEventFromStream, buildBuddySystemPrompt, getBuddyState } from '../buddy/service'
import { readDiskSettings } from '../settings/settingsAccess'
import type { PermissionRulePayload } from './permissionRuleMatch'
import { mergeOpenClaudeStylePermissionRules } from './permissionRuleSources'
import { resolvePrimaryChatTools } from './resolvePrimaryChatTools'
import { toolsToApiDefinitions } from '../agents/subAgentToolResolver'
import { shellExecutionToolInModelListing } from '../tools/schema'
import {
  runWithAgentContextAsync,
  type AgentContext,
} from '../agents/agentContext'
import {
  getCoordinatorSystemPromptForBuiltinAgent,
  getCoordinatorUserContext,
} from '../agents/coordinatorMode'
import { listMcpServerNamesFromToolRegistry } from '../agents/mcpNamesFromRegistry'
import { ensureScratchpadDir } from '../agents/scratchpadDir'
import { setMainWindow } from '../agents/agentTool'
import {
  setPermissionMode,
  setDiffPermissionMode,
} from './interactionState'
import { setActiveWorkspace, getMemorySystemPromptSection } from '../memory/service'
import { getAllSkills, getCompactSkillIndexPrompt, getSkillsVersion } from '../skills/skillTool'
import { parseSkillEffort } from '../skills/skillEffort'
import { buildPreloadedSkillsPromptAppend } from '../agents/subAgentSkillPreload'
import {
  collectPendingReminders,
  formatRemindersForUserMeta,
} from './systemReminderInjector'
import { captureAutoMemorySignal } from '../memory/autoMemoryWriteLoop'
import { autoExtractFromConversation } from '../memory/autoExtract'
import { isAutoMemoryGloballyDisabled } from '../memory/memoryFeatureFlags'
import {
  startRetrievalPrefetch,
  type RetrievalPrefetch,
} from '../memory/retrievalPrefetch'
import {
  startSession as startSessionService,
  getSessionSummaryForScope,
  completeSessionScope,
} from '../session/service'
import { toolRegistry } from '../tools/registry'
import { buildQueryContextCacheKey } from '../context/queryContextCacheKey'
import { resolveMainChatThinkingBudgetTokens } from './mainSessionThinkingBudget'
import { resetReadFailCountersForConversation } from './toolReadFile'
import { getWorkspacePath, setWorkspacePath } from '../tools/workspaceState'
import { acceptWorkspacePathFromRenderer } from '../security/workspaceAccept'
import { runUserPromptSubmitHooks } from '../tools/hooks/engine'
import {
  cancelSessionIdleHooksSchedule,
  scheduleSessionIdleHooks,
} from '../tools/hooks/runtimeHookBridges'
import { setHooksConfig } from '../tools/hooks/config'
import { generateQueryChainId } from '../agents/queryTracking'
import { injectPendingSubAgentOutputsForMainTurn } from '../agents/mainSubAgentContextInjection'
import { getActiveBundle } from '../agents/bundles/bundleRegistryQueries'
import { analyzeTaskRouting, formatTaskRoutingSystemBlock } from './taskRoutingPlanner'
import { activeBundleUsesCodeVerification } from './agenticLoop/verificationGate'
import { userMessageContentToPlainText } from '../utils/userMessageText'
import { getTodayLocalISODate } from '../utils/dateLocal'
import { createQueryLoopChannel } from './queryLoopAsyncGenerator'
import { asAgentId } from '../tools/ids'
import {
  normalizeMessagesForAPI,
  prependUserContext,
} from '../context/normalizeMessagesForAPI'
import { anchorCurrentUserQuery } from '../context/anchorUserQuery'

import type {
  SendMessageParams,
  StreamEvent,
  ApiChatMessage,
} from './streamHandlerTypes'
import {
  toApiChatMessages,
} from './streamHandlerTypes'
import {
  ensureGlobalStreamEventSender,
  lastQueryLoopBridge,
  registerActiveMainStream,
  unregisterActiveMainStream,
  emitStreamEventToRenderer,
  setLastQueryLoopBridge,
  queryLoopChannelsByConversation,
} from './streamHandlerRegistry'
import { cleanupAnthropicBetaHeaderLatchForConversation } from './anthropicBetaHeaderLatch'
import { cleanupAnthropicThinkingApiContextForConversation } from './anthropicThinkingApiContext'
import { createStreamReasoningCallbacks } from './streamReasoningCallbacks'

export type {
  SendMessageParams,
  ApiMessageContent,
  ApiChatMessage,
  StreamEventType,
  StreamEvent,
} from './streamHandlerTypes'
export { normalizeMessageContentForApi, toApiChatMessages } from './streamHandlerTypes'
export { getHandleSendMessageQueryLoopIterable, cancelStream } from './streamHandlerRegistry'

export async function handleSendMessage(
  mainWindow: Electron.BrowserWindow,
  params: SendMessageParams
): Promise<void> {
  const streamConversationId =
    typeof params.conversationId === 'string' && params.conversationId.trim()
      ? params.conversationId.trim()
      : 'default'
  const workspacePathForStream = params.workspacePath
  const streamId = `main-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const abortController = new AbortController()
  const abortSignal = abortController.signal

  // Reset the consecutive-read-failure gate at every user-turn boundary.
  // Without this, a hallucinated-path streak in the previous turn would
  // falsely block the first read in this turn.
  //
  // Self-audit fix (2026-05): A-7 split the single integer counter into a
  // per-scope Map keyed by `${conversationId}::${agentId}`. This call site
  // runs BEFORE `runWithAgentContextAsync` sets up the ALS context, so
  // the legacy `resetReadFailCounter()` would have cleared the fallback
  // `'default::main'` slot — not the real loop's `'${streamConversationId}::main'`
  // slot. Use the conversation-id-aware variant so all per-agent
  // counters tagged with this conversation are cleared at the boundary.
  resetReadFailCountersForConversation(streamConversationId)

  registerActiveMainStream({ streamId, conversationId: streamConversationId, abortController })
  ensureGlobalStreamEventSender(mainWindow)
  let queryLoopChannel: ReturnType<typeof createQueryLoopChannel> | null = null

  try {
    const emitStream = (ev: StreamEvent) => {
      const routed: StreamEvent =
        typeof ev.conversationId === 'string' && ev.conversationId.trim()
          ? ev
          : { ...ev, conversationId: streamConversationId }
      emitStreamEventToRenderer(routed)
      queryLoopChannel?.push(routed)
    }
    // Audit P0-2c (2026-05): forward buddy mood reactions sourced from stream
    // event types to the renderer. `mainStreamRouter.ts` already handles the
    // `buddy_event` case; previously no main-process emitter existed so the
    // sprite never moved in response to model activity. Returns silently when
    // buddy is disabled or muted (`buildBuddyEventFromStream` checks both).
    const emitBuddyReaction = (source: string, payload?: Record<string, unknown>): void => {
      try {
        const buddyEvent = buildBuddyEventFromStream(source, payload)
        if (buddyEvent) {
          emitStream(buddyEvent as unknown as StreamEvent)
        }
      } catch (err) {
        console.warn('[streamHandler] emitBuddyReaction failed:', err)
      }
    }
    const {
      messages,
      model,
      maxTokens = 8192,
      workspacePath,
      providerId = 'anthropic',
      apiKey = '',
      baseUrl,
      anthropicThinkingCapability,
      awsRegion,
      projectId,
      outputStyle = 'default',
      language = '',
      enableTools = true,
      permissionMode,
      chatInteractionMode = 'agent',
      diffPermissionMode = 'default',
      permissionDefaultMode = 'ask',
      permissionRules,
      agentType: sessionAgentTypeRaw,
      alwaysThinking: alwaysThinkingParam,
      thinkingBudgetTokens: thinkingBudgetTokensParam,
      fastMode: fastModeParam,
      effortLevel: effortLevelParam,
      autoTaskRouting: autoTaskRoutingParam,
      autoMemoryEnabled: autoMemoryEnabledParam,
      autoMemoryDirectory: autoMemoryDirectoryParam,
    } = params

    const apiMessages = toApiChatMessages(messages)
    const effectiveEnableTools = enableTools
    const allowWorkspaceContext = true

    // Bundle-level hooks 优先于 settings.hooks —— 同一 event 下 bundle hook
    // 先触发,便于 "每切一个 bundle,主智能体多一层行业专属的 hook"。
    //
    // 安全加固:之前只在 hooks / disableAllHooks / envVars 任一非 undefined 时
    // 才刷新,这会在某些边缘路径(比如没传 envVars 的调用方)导致"上一次
    // bundle 的 primaryAgentHooks 残留"。现在**无条件**每 turn 都 setHooksConfig,
    // 让内存态始终和本次 payload 一致。代价只是多一次 O(N) 的写,N 很小。
    const mergedHooks =
      Array.isArray(params.primaryAgentHooks) && params.primaryAgentHooks.length > 0
        ? [...params.primaryAgentHooks, ...(params.hooks ?? [])]
        : (params.hooks ?? [])
    setHooksConfig(mergedHooks, params.disableAllHooks ?? false, params.envVars)

    const sessionAgentType =
      typeof sessionAgentTypeRaw === 'string' ? sessionAgentTypeRaw.trim() : ''

    // 阶段 1.3 — When a new user turn opens a Coordinator session, reset the phase-satisfied
    // gate bits so each task runs its own research → synthesis → implementation chain. The task
    // id is bound to the user-turn index: different turn → fresh task, same turn re-run → no-op.
    if (sessionAgentType === 'Coordinator' && streamConversationId) {
      const userTurnIndex = messages.length
      const taskId = `${streamConversationId}-t${userTurnIndex}`
      try {
        resetCoordinatorPhasesForNewTask(streamConversationId, taskId)
      } catch (e) {
        console.warn('[StreamHandler] resetCoordinatorPhasesForNewTask failed:', e)
      }
    }

    // 基础规则先按通道融合,然后根据 primaryAgentIsReadOnly 追加写工具的 deny
    // 规则。前缀 `workbench-readonly-` 便于日后识别 / 调试。rule 的 pattern
    // 直接写工具名称 —— runAgenticToolUse 的规则引擎会做精确匹配。
    let permissionRulesEffective = mergeOpenClaudeStylePermissionRules(permissionRules)
    if (params.primaryAgentIsReadOnly === true) {
      const readOnlyDeny: PermissionRulePayload[] = [
        { id: 'workbench-readonly-write', pattern: 'Write', mode: 'deny' },
        { id: 'workbench-readonly-edit', pattern: 'Edit', mode: 'deny' },
        { id: 'workbench-readonly-multi-edit', pattern: 'MultiEdit', mode: 'deny' },
        { id: 'workbench-readonly-notebook', pattern: 'NotebookEdit', mode: 'deny' },
        // 磁盘写工具的 legacy alias 同样拦截,防绕过
        { id: 'workbench-readonly-write-alias', pattern: 'write_file', mode: 'deny' },
        { id: 'workbench-readonly-edit-alias', pattern: 'edit_file', mode: 'deny' },
        { id: 'workbench-readonly-multi-edit-alias', pattern: 'multi_edit_file', mode: 'deny' },
        // Bash 可以 pipe/重定向写文件,真只读必须禁
        { id: 'workbench-readonly-bash', pattern: 'Bash', mode: 'deny' },
        { id: 'workbench-readonly-powershell', pattern: 'PowerShell', mode: 'deny' },
      ]
      permissionRulesEffective = [...readOnlyDeny, ...permissionRulesEffective]
    }

    // Bundle-level permission overlay: industry-specific bundles can declare
    // a global default mode and additional rules that apply to ALL agents.
    // Agent-level rules come first (higher priority), then bundle rules.
    let effectivePermissionDefaultMode = permissionDefaultMode
    try {
      const caps = getActiveBundle()?.capabilities
      if (caps?.permissionDefaultMode && effectivePermissionDefaultMode === 'ask') {
        // Only override when the caller left the default 'ask' value;
        // explicit per-agent overrides still win.
        effectivePermissionDefaultMode = caps.permissionDefaultMode
      }
      if (caps?.permissionRules && caps.permissionRules.length > 0) {
        permissionRulesEffective = [
          ...permissionRulesEffective,
          ...caps.permissionRules,
        ]
      }
    } catch {
      /* ignore bundle read failures */
    }

    if (allowWorkspaceContext) {
      ensureLspWorkspaceSynced(workspacePath, app.getPath('userData'), {
        bypassOpenclaudeNotStarted: true,
      })
    }

    if (workspacePath) {
      // Audit fix A2 (2026-05) — gate the renderer-supplied path through the
      // trust boundary. Fires on every message, so the boundary check
      // memoizes its decision per path to keep the hot path zero-IO.
      const outcome = acceptWorkspacePathFromRenderer(workspacePath, {
        source: 'streamHandler',
      })
      if (!outcome.ok) {
        throw new Error(outcome.reason)
      }
      if (outcome.effective) {
        setActiveWorkspace(outcome.effective)
        setWorkspacePath(outcome.effective)
      }
    }
    const lastUserMessage =
      messages.length > 0
        ? userMessageContentToPlainText(messages[messages.length - 1].content)
        : ''

    // Phase E — auto-memory write loop. Inspect the latest user turn
    // for corrections / explicit preferences / positive confirmations
    // and capture them to per-user memory. The write is gated by the
    // POLE_AUTO_MEMORY_CAPTURE env flag (default off); detection runs
    // unconditionally so the renderer can later surface "we noticed a
    // preference, save it?" prompts. We only fire when the current
    // turn is genuinely a USER turn (last message has role 'user' and
    // is not a tool_result).
    try {
      const last = messages[messages.length - 1]
      const isUserTurn =
        last?.role === 'user' &&
        (typeof last.content === 'string' ||
          !(Array.isArray(last.content) &&
            (last.content as Array<Record<string, unknown>>).every(
              (b) => b?.type === 'tool_result',
            )))
      if (isUserTurn && streamConversationId && lastUserMessage.trim()) {
        const prevAssistant = (() => {
          for (let i = messages.length - 2; i >= 0; i--) {
            if (messages[i].role === 'assistant') {
              return userMessageContentToPlainText(messages[i].content).slice(-400)
            }
          }
          return ''
        })()
        captureAutoMemorySignal({
          conversationId: streamConversationId,
          previousAssistantText: prevAssistant,
          currentUserText: lastUserMessage,
        })
      }
    } catch (e) {
      console.warn('[StreamHandler] auto-memory capture failed:', e)
    }

    const memoryEnabled =
      autoMemoryEnabledParam !== false && !isAutoMemoryGloballyDisabled()

    // --- Non-blocking retrieval prefetch (unified) ---
    // One `dispatchEmbed([query])` is fanned out to three parallel branches:
    //   - memory hybrid recall  (bm25 + vector + freshness + structured → RRF → rerank → LLM selector)
    //   - workspace code top-K  (semantic search across the indexed workspace)
    //   - attachment RAG top-K  (over sha256-keyed attachment namespaces)
    //
    // Each branch settles independently; whatever's ready by the first API
    // call is consumed inline, the rest emit `*_recall` events mid/post-stream
    // so the renderer can surface citations without ever blocking first-token.
    // The `using`-style dispose at the end cascades abort to every in-flight
    // branch when the stream ends or the user hits Escape.
    // Audit P1-2 (2026-05): the `attachments` parameter for the main-process
    // prefetch was always sourced from `params.retrievalAttachments`, which
    // had no caller in the codebase. Attachment semantic RAG already runs in
    // the renderer (`retrieveWithBudget`) and feeds the API message body via
    // `contextBuilder.ts`. We omit `attachments` here so the prefetch handle
    // skips the attachment branch entirely instead of returning a settled-
    // empty placeholder every turn.
    const retrievalPrefetch: RetrievalPrefetch = startRetrievalPrefetch({
      query: lastUserMessage,
      workspacePath: allowWorkspaceContext ? workspacePath : null,
      abortSignal,
      apiMessages,
      memoryEnabled: memoryEnabled && allowWorkspaceContext,
      // Pass the conversation id so the per-conversation recall byte budget
      // (V-5 fix) is keyed correctly. Without this, every parallel chat
      // shared the same global counter and a busy chat could starve a quiet
      // one.
      conversationId: streamConversationId,
    })

    // Memory prefetch race (feature audit — "memory recall guaranteed in
    // system prompt"). Three cases:
    //   1. Branch already settled   → consume synchronously (fast path)
    //   2. Branch in-flight, short  → wait up to `MEMORY_PREFETCH_WAIT_MS`
    //                                 so the first API call includes recall
    //   3. Branch in-flight, long   → give up quietly, memory_recall event
    //                                 will surface mid-stream as before
    //
    // Bounded wait is tunable via env; default tuned for snappy UX
    // (embeddings on warm cache usually return in < 300ms).
    const MEMORY_PREFETCH_WAIT_MS = Number(
      process.env.POLE_MEMORY_PREFETCH_WAIT_MS ?? '800',
    )
    let memoryContext = ''
    let recalledMemoriesForReminder: Array<{ name: string; ageDays: number }> = []
    const extractRecallSnapshot = (
      raw: unknown,
    ): Array<{ name: string; ageDays: number }> => {
      if (!raw || typeof raw !== 'object') return []
      const list = (raw as { recalledMemories?: unknown }).recalledMemories
      if (!Array.isArray(list)) return []
      const out: Array<{ name: string; ageDays: number }> = []
      for (const item of list) {
        if (!item || typeof item !== 'object') continue
        const name = (item as { name?: unknown }).name
        const ageDays = (item as { ageDays?: unknown }).ageDays
        if (typeof name === 'string' && name.length > 0) {
          out.push({
            name,
            ageDays: typeof ageDays === 'number' && Number.isFinite(ageDays) ? ageDays : 0,
          })
        }
      }
      return out
    }
    if (retrievalPrefetch.memory) {
      if (retrievalPrefetch.memory.settledAt !== null) {
        try {
          const r = await retrievalPrefetch.memory.promise
          memoryContext = r?.text ?? ''
          recalledMemoriesForReminder = extractRecallSnapshot(r)
        } catch {
          memoryContext = ''
        }
      } else if (MEMORY_PREFETCH_WAIT_MS > 0) {
        // Bounded race: resolve whichever fires first.
        const timeoutPromise = new Promise<null>((resolve) => {
          setTimeout(() => resolve(null), MEMORY_PREFETCH_WAIT_MS)
        })
        try {
          const r = await Promise.race([
            retrievalPrefetch.memory.promise,
            timeoutPromise,
          ])
          memoryContext = r?.text ?? ''
          recalledMemoriesForReminder = extractRecallSnapshot(r)
        } catch {
          memoryContext = ''
        }
      }
    }

    const isFirstConversationTurn = !messages
      .slice(0, -1)
      .some((m) => m.role === 'assistant')

    // P0: keep capabilities text and recalled facts as SEPARATE fields all
    // the way through to render time — concatenating them caused both
    // streams to land inside one `<project-memory>` tag, and the model
    // would occasionally cite tutorial sentences ("You have access to a
    // persistent memory system…") as if they were durable user-recorded
    // facts. They render now as two sibling tags `<memory-capabilities>` +
    // `<project-memory>`. See orchestrationContext.ts type comments.
    // Stage 11: capabilities are tutorial text, not recalled facts. Inject
    // them only on the first model turn so ongoing chats do not pay this
    // static explanation cost on every simple follow-up.
    const memoryCapabilitiesForOrchestration =
      isFirstConversationTurn && workspacePath && memoryEnabled && allowWorkspaceContext
        ? getMemorySystemPromptSection(true)
        : ''
    const memoryContextForOrchestration = memoryContext.trim()

    cancelSessionIdleHooksSchedule()

    // Start or continue session tracking (per workspace + chat id)
    if (workspacePath && allowWorkspaceContext) {
      startSessionService(workspacePath, streamConversationId)
    }
    const sessionContext = allowWorkspaceContext
      ? getSessionSummaryForScope(workspacePath, streamConversationId)
      : ''

    const lspInjectMode = allowWorkspaceContext
      ? parseLspPassiveInjectMode(params.injectLspPassiveDiagnostics)
      : 'off'
    const shellForPassive =
      effectiveEnableTools && shellExecutionToolInModelListing(permissionRulesEffective)
    // method C: legacy upstream §9.3 shell-gate is now opt-in. When the
    // setting is unset (default), passive diagnostics drain regardless of
    // whether shell is in the tool listing — covering plan mode, file-only
    // permission profiles, and any agent persona without shell access.
    const requireShellToolForPassive =
      readDiskSettings().lspPassiveDiagnosticsRequireShellTool === true
    const lspPassiveBlock = consumePassiveLspDiagnosticsForPrompt(lspInjectMode, {
      shellExecutionToolInListing:
        lspInjectMode === 'off' ? false : shellForPassive,
      requireShellTool: requireShellToolForPassive,
    })

    // 工作包 primary-agent overlay:三段增强内容拼进最终 systemPrompt。
    //   1. criticalReminder 最顶,最高优先级,模型首轮先读到
    //   2. skills 预加载正文放在最底,类比 subAgentRunner 的处理
    //   3. initialPrompt 再追加一小段"会话启动上下文"
    // 这些都跟 bundle 来的 `params.systemPrompt` 一起组成一段完整的自定义
    // 系统提示,由 `buildMainSystemPromptLayersFromOrchestration` 的 custom
    // 分支覆盖默认 星构Astra prompt。
    let customSystem: string | undefined = undefined
    const customSystemParts: string[] = []
    const criticalReminder = params.primaryAgentCriticalReminder?.trim()
    if (criticalReminder) {
      customSystemParts.push(`<critical-reminder>\n${criticalReminder}\n</critical-reminder>`)
    }
    if (typeof params.systemPrompt === 'string' && params.systemPrompt.trim()) {
      customSystemParts.push(params.systemPrompt.trim())
    }
    // Skill preload: agent-level list takes precedence; when empty, fall
    // back to the active bundle's enabledSkills so industry-specific bundles
    // (legal, medical, finance) can inject domain knowledge without every
    // agent re-declaring the same skill ids.
    let effectiveSkills = params.primaryAgentSkills ?? []
    if (effectiveSkills.length === 0) {
      try {
        const bundleSkills = getActiveBundle()?.capabilities?.enabledSkills
        if (Array.isArray(bundleSkills) && bundleSkills.length > 0) {
          effectiveSkills = bundleSkills
        }
      } catch {
        /* ignore bundle read failures */
      }
    }
    if (effectiveSkills.length > 0) {
      try {
        const skillsBlock = buildPreloadedSkillsPromptAppend(effectiveSkills)
        if (skillsBlock) customSystemParts.push(skillsBlock.trim())
      } catch (e) {
        console.warn('[StreamHandler] 主智能体 skill 预加载失败:', e)
      }
    }

    // Bundle roster + team templates —— 把当前激活 Bundle 的**非 primary 成员**
    // 和**预设团队模板**列出来,让主 AI 知道自己有哪些队友 / 哪些工作流可用。
    // 对 Coordinator 类主智能体尤其关键,普通主智能体也受益:它们原本只能
    // 通过 Agent 工具的 description 间接发现成员,现在 system prompt 里直接
    // 曝光这份花名册,首轮响应就能主动派活。
    //
    // 注意:团队模板只是"纸面清单",真正创建 team 需要主 AI 调用 TeamCreate
    // 工具,并提供活的 leadAgentId;我们有意不在激活时自动 TeamCreate
    // (那会生成孤立的 TeamFile,容易脏)。
    try {
      const activeBundle = getActiveBundle()
      const workerLines: string[] = []
      const teamLines: string[] = []
      if (activeBundle && Array.isArray(activeBundle.agents)) {
        for (const ag of activeBundle.agents) {
          if (ag.isPrimary === true) continue // 自己不是 worker
          const label = (ag.displayName ?? ag.agentType).trim()
          const kind = ag.agentType.trim()
          const hint = [ag.whenToUse, ag.capability, ag.tagline]
            .map((s) => (typeof s === 'string' ? s.trim() : ''))
            .filter((s) => s.length > 0)[0]
          workerLines.push(
            `- **${label}** (subagent_type: \`${kind}\`)${hint ? ` — ${hint}` : ''}`,
          )
        }
      }
      if (activeBundle && Array.isArray(activeBundle.teams)) {
        for (const tm of activeBundle.teams) {
          if (!tm.id) continue
          const members = (tm.members ?? [])
            .map((m) => m.agentType)
            .filter(Boolean)
            .join(' → ')
          teamLines.push(
            `- **${tm.name || tm.id}** (id: \`${tm.id}\`, coordination: \`${tm.coordination}\`)${tm.description ? ` — ${tm.description}` : ''}${members ? `\n  成员:${members}` : ''}`,
          )
        }
      }
      if (workerLines.length > 0 || teamLines.length > 0) {
        const sections: string[] = ['## Bundle team context']
        if (workerLines.length > 0) {
          sections.push(
            `\n### Sub-agents available for delegation\nWhen a task matches their specialty, spawn via the \`Agent\` tool with the \`subagent_type\` below:\n\n${workerLines.join('\n')}`,
          )
        }
        if (teamLines.length > 0) {
          sections.push(
            `\n### Team templates\nPre-defined coordination workflows in this bundle. When a user task maps to one, invoke \`TeamCreate\` with the listed members:\n\n${teamLines.join('\n')}`,
          )
        }

        // Auto-suggest (feature-flagged): score each template against the
        // latest user message and highlight the best match with a concrete
        // `TeamCreate({ template })` call. This complements the markdown
        // listing above — the listing is the catalogue, the suggestion is
        // the point-of-sale recommendation. Still advisory: the main AI
        // keeps full veto power. Wrapped in try/catch so matcher bugs can
        // never break the main send path.
        if (
          activeBundle &&
          allowWorkspaceContext &&
          Array.isArray(activeBundle.teams) &&
          activeBundle.teams.length > 0 &&
          typeof lastUserMessage === 'string' &&
          lastUserMessage.trim().length > 0
        ) {
          try {
            const { isTeamAutoSuggestEnabled, matchTeamTrigger, formatSuggestionHint } =
              await import('../agents/teamTriggerMatcher')
            if (isTeamAutoSuggestEnabled()) {
              const matches = matchTeamTrigger(lastUserMessage, activeBundle.teams)
              const hint = formatSuggestionHint(lastUserMessage, matches)
              if (hint) sections.push(`\n${hint}`)
            }
          } catch (e) {
            console.warn('[StreamHandler] team auto-suggest failed:', e)
          }
        }

        customSystemParts.push(sections.join('\n'))
      }
    } catch (e) {
      console.warn('[StreamHandler] failed to compose bundle team context:', e)
    }

    // Bundle-level initialContext: injected for ALL agents in the bundle,
    // before the per-agent initialPrompt. This gives industry-specific
    // background ("You are in a legal-compliance workspace.") to every
    // main-chat turn regardless of which primary agent is selected.
    try {
      const bundleInitial = getActiveBundle()?.initialContext?.trim()
      if (bundleInitial) {
        customSystemParts.push(`## Workspace context\n\n${bundleInitial}`)
      }
    } catch {
      /* ignore bundle read failures */
    }

    const initialPrompt = params.primaryAgentInitialPrompt?.trim()
    if (initialPrompt) {
      customSystemParts.push(`## Session kickoff\n\n${initialPrompt}`)
    }
    if (customSystemParts.length > 0) {
      customSystem = customSystemParts.join('\n\n')
    }

    const userRules =
      typeof params.userRulesPrompt === 'string' && params.userRulesPrompt.trim()
        ? params.userRulesPrompt
        : undefined

    // 主智能体声明了 omitClaudeMd 时,memoryContext 清空 —— 主对话就不会
    // 被注入 CLAUDE.md / AGENTS.md 的项目记忆;相当于给"售前 / 写作"这类
    // 跟代码无关的主智能体一个干净的启动上下文。Capabilities text gets the
    // same treatment so the "you have a memory system" tutorial doesn't
    // leak into a non-coding bundle either.
    const effectiveMemoryContext = params.primaryAgentOmitClaudeMd
      ? ''
      : memoryContextForOrchestration
    const effectiveMemoryCapabilities = params.primaryAgentOmitClaudeMd
      ? ''
      : memoryCapabilitiesForOrchestration

    // Audit P0-2a (2026-05): introduce the companion / buddy in the user-meta
    // layer so the model knows the buddy exists BEFORE the `buddyStateChange`
    // host-attachment collector emits any delta updates. Returns '' when buddy
    // is disabled or muted; section is then a no-op.
    let buddyPromptBody = ''
    try {
      buddyPromptBody = buildBuddySystemPrompt(getBuddyState())
    } catch (err) {
      console.warn('[streamHandler] buddy prompt body assembly failed:', err)
    }

    let systemPromptLayers: SystemPromptLayers = buildMainSystemPromptLayersFromOrchestration({
      workspacePath,
      cwd: workspacePath || process.cwd(),
      platform: process.platform,
      outputStyle,
      language,
      memoryContext: effectiveMemoryContext,
      memoryCapabilities: effectiveMemoryCapabilities,
      sessionContext: sessionContext ?? '',
      passiveLspDiagnostics: lspPassiveBlock,
      customSystemPrompt: customSystem,
      userRulesPrompt: userRules,
      // Main chat exposes edit_file on the tool surface — inject the hard edit
      // contract (EDIT_FILE_CONTRACT_BLOCK) so the model knows old_string must
      // be a verbatim substring of the latest read, and read_file is mandatory
      // before edit_file. Without this flag the contract block is dead code and
      // models fall back to "close enough" old_string construction, which is
      // the single biggest source of "old_string was not found" / hallucinated
      // path errors in practice.
      includeEditFileContract: enableTools,
      ...(buddyPromptBody ? { buddyPromptBody } : {}),
    })

    // Stage 3 — single-pass assembly via `SystemPromptBuilder`. Each
    // injection (auto-task-routing hint, Coordinator suffix, UserPromptSubmit
    // hook output, plan-mode behavior block) is added as a declarative
    // `SystemPromptSection`; the Builder owns layer storage, separator
    // policy, id-dedup, and marker-based idempotency. The final
    // `.build()` derives the merged string from layers so the two views
    // (merged string for compat-gateway escape hatch, layered for the
    // default block-mode wire) cannot drift.
    const promptBuilder = new SystemPromptBuilder(systemPromptLayers)

    if (autoTaskRoutingParam) {
      // Wire the real `taskRoutingPlanner` supervisor hint (previously this
      // was a hand-written static coding-flavoured blurb that ignored the
      // user's actual message and leaked "verify build/tests" language into
      // every work package). The planner classifies THIS turn's text and
      // emits a routing policy hint. The coding-specific delivery gate is
      // gated on the active work package so writing / legal / general
      // bundles get a domain-neutral "verify before done" instead of a
      // build/test instruction. Volatile layer: it depends on the latest
      // user message, so it must stay out of the cached system prefix.
      const routingPlan = analyzeTaskRouting(lastUserMessage, {
        sessionAgentType: sessionAgentType || 'general-purpose',
        enableTools: effectiveEnableTools,
      })
      const routingBlock = formatTaskRoutingSystemBlock(
        routingPlan,
        sessionAgentType || 'general-purpose',
        activeBundleUsesCodeVerification(),
      )
      if (routingBlock.trim().length > 0) {
        promptBuilder.add({
          id: 'auto-task-routing',
          text: routingBlock,
          layer: 'volatile',
          // Idempotency: a forked / parent prompt that already carries the
          // hint header won't get a duplicate copy.
          marker: '# System task routing (supervisor hint)',
        })
      }
    }

    if (sessionAgentType === 'Coordinator') {
      const mcpTuples = listMcpServerNamesFromToolRegistry().map((name) => ({ name }))
      // Auto-resolved + auto-created when env override is unset.
      const scratchpad = ensureScratchpadDir(workspacePath)
      const coordExtra = getCoordinatorUserContext(
        mcpTuples,
        scratchpad,
      )
      let coordSuffix = `---\n\n${getCoordinatorSystemPromptForBuiltinAgent()}`
      if (coordExtra.workerToolsContext) {
        coordSuffix = `${coordSuffix}\n\n${coordExtra.workerToolsContext}`
      }
      // (Coordinator 模式不再需要单独拼 roster/teams —— 现在统一在 customSystemParts
      //  组装阶段就把它们注入到主系统提示,覆盖所有主智能体类型。)
      promptBuilder.add({
        id: 'coordinator-suffix',
        text: coordSuffix,
        layer: 'volatile',
      })
    }

    const hookCwdForPrompt = workspacePath || getWorkspacePath() || process.cwd()
    try {
      const { response: ups } = await runUserPromptSubmitHooks(lastUserMessage, hookCwdForPrompt, {
        messageCount: messages.length,
      })
      const inj = ups?.additionalContext?.trim()
      if (inj) {
        promptBuilder.add({
          id: 'user-prompt-submit-hook',
          text: inj,
          layer: 'volatile',
          separator: '\n\n---\n\n',
        })
      }
    } catch (e) {
      console.warn('[StreamHandler] UserPromptSubmit hooks failed:', e)
    }

    // P1-2 (upstream §3.5 Plan Mode V2): when this turn starts in plan mode,
    // append the parallel-Explore + interview-phase behavior guidance.
    //
    // We use the *requested* `permissionMode` from the params (the value
    // the renderer / caller asked for at turn start) rather than reading
    // back through `getPermissionMode()`. The latter would also hit the
    // killswitch translation, which can downgrade `plan` → other modes
    // and silently swallow the block. Per-turn requests are the source
    // of truth here. The Builder uses the marker `# Plan mode is active`
    // so a parent prompt that already carries the block (e.g. forked
    // sub-agent) won't get a duplicate.
    if (permissionMode === 'plan') {
      promptBuilder.add({
        id: 'plan-mode-behavior',
        text: PLAN_MODE_BEHAVIOR_BLOCK,
        layer: 'volatile',
        marker: '# Plan mode is active',
      })
    }

    const built = promptBuilder.build()
    const systemPrompt = built.merged
    systemPromptLayers = built.layers

    const config: ProviderConfig = {
      id: providerId,
      name: providerId,
      apiKey,
      baseUrl: baseUrl || undefined,
      anthropicThinkingCapability,
      awsRegion,
      projectId,
    }

    setMainWindow(mainWindow)

    if (process.env.ASTRA_QUERY_LOOP_ASYNC_ITERABLE === '1') {
      queryLoopChannel = createQueryLoopChannel()
      queryLoopChannelsByConversation.set(streamConversationId, queryLoopChannel)
      setLastQueryLoopBridge(queryLoopChannel)
    } else {
      queryLoopChannelsByConversation.delete(streamConversationId)
      setLastQueryLoopBridge(null)
    }

    if (permissionMode) {
      // P1-30: scope to this conversation so parallel chats don't clobber
      // each other's mode.
      setPermissionMode(permissionMode, streamConversationId)
    }
    // 将本 turn 的 diff 权限同步到本会话(热状态)。这样后续的 `runAgenticToolUse`
    // 每个工具调用都从本会话覆盖读,用户对话中途从"变更审核"切到"自动写入"能即时生效,
    // 同时不会污染其它并行对话。
    setDiffPermissionMode(diffPermissionMode, streamConversationId)

    const queryContextCacheKey = buildQueryContextCacheKey({
      model: model || '',
      sharedSystemPrefix: systemPrompt,
      toolsetRevision: toolRegistry.getToolsetRevision(),
    })

    const alwaysThinking = alwaysThinkingParam === true
    const thinkingBudgetTokens = resolveMainChatThinkingBudgetTokens({
      maxTokens,
      alwaysThinking,
      explicitOverride: thinkingBudgetTokensParam,
    })

    const agentCtx: AgentContext = {
      config,
      model: model || '',
      systemPrompt,
      systemPromptLayers,
      messages: apiMessages.map((m) => ({ role: m.role, content: m.content })),
      signal: abortSignal,
      agentId: asAgentId('main'),
      queryChainId: generateQueryChainId(),
      querySource: 'repl_main_thread',
      ...(streamConversationId ? { streamConversationId } : {}),
      queryContextCacheKey,
      ...(sessionAgentType ? { sessionAgentType } : {}),
      ...(alwaysThinking ? { alwaysThinking: true } : {}),
      ...(thinkingBudgetTokens !== undefined ? { thinkingBudgetTokens } : {}),
      // Write permission fields into AgentContext so sub-agents can inherit via ALS
      diffPermissionMode,
      permissionDefaultMode,
      permissionRules: permissionRulesEffective,
    }

    await runWithAgentContextAsync(agentCtx, async () => {
      console.log('[StreamHandler] Starting message:', {
        provider: providerId,
        model,
        enableTools,
        effectiveEnableTools,
        permissionMode,
        messageCount: messages.length,
      })

      emitStream( {
        type: 'message_start',
      } satisfies StreamEvent)
      emitBuddyReaction('message_start')

      const appendixAFlow = isAppendixAFlowTelemetryEnabled()
        ? createAppendixAFlowReporter(
            (ev) => emitStream(ev as StreamEvent),
            streamConversationId,
          )
        : undefined
      appendixAFlow?.report('P1_send_message_entry', {
        enableTools,
        effectiveEnableTools,
        messageCount: messages.length,
      })
      if (appendixAFlow) {
        const route = classifyAppendixAPhase1Route(
          messages as Array<{ role: string; content: unknown }>,
        )
        appendixAFlow.report(
          route === 'slash_like' ? 'P1_route_slash_like' : 'P1_route_text_prompt',
          { messageCount: messages.length },
        )
      }

      /** Phase 2 Step 15: normalizeMessagesForAPI — 12-pass 消息规范化管线。 */
      const normalizedApiMessages = normalizeMessagesForAPI(
        apiMessages.map((m) => ({ ...m })),
        {
          stripInternalMeta: true,
          applyAnthropicInvariants: true,
          strictThinkingEcho: getProviderQuirks(config).thinkingRequiresHistoryEcho,
        },
      )

      /** Phase 2 Step 16: prependUserContext — upstream-style `<system-reminder>`
       *  user-meta message at messages[0] carrying reference-grade volatile
       *  context that should NOT be read as fresh user instructions.
       *
       *  Composition (post user-meta migration):
       *    - `# Today's date` — small, daily-rotating, kept out of system cache
       *    - {@link SystemPromptLayers.userMessageContext} — `# Project Memory` +
       *      `# LSP diagnostics` (when present), moved here from the system
       *      `userContext` layer. The model treats these as reference, not
       *      instruction, thanks to the trailing
       *      {@link USER_MESSAGE_CONTEXT_DISCLAIMER}.
       *
       *  Why moved (vs. previous "memory in system field" design):
       *    - directive-tone CLAUDE.md entries ("用户明确要求…") get read as a
       *      fresh user correction every turn, triggering "你说得对，我…"
       *      sycophancy loops even though the actual work is progressing.
       *    - LSP diagnostics get read as "fix everything you see" instead of
       *      "may be relevant" when the user's question is unrelated.
       *  Pairing with the disclaimer pushes the model toward "reference-only"
       *  reading. Mirrors upstream (leaked upstream) `prependUserContext`.
       */
      const todayLine = `# Today's date\nToday's date is ${getTodayLocalISODate()}.`
      const refContext = systemPromptLayers.userMessageContext.trim()
      const firstTurnSkillIndex = isFirstConversationTurn
        ? getCompactSkillIndexPrompt().trim()
        : ''

      // Phase C — incremental system-reminder injection. On continuing
      // turns we ask the injector for deltas (skill list changes, stale
      // memory warnings) and fold them into the user-meta block. The
      // injector returns [] on first observation, so this is a no-op
      // when `isFirstConversationTurn === true`.
      const pendingReminders = streamConversationId
        ? collectPendingReminders(streamConversationId, {
            skillsVersion: getSkillsVersion(),
            skillNames: getAllSkills()
              .filter((s) => !s.disableModelInvocation)
              .map((s) => s.name),
            recalledMemories: recalledMemoriesForReminder,
          })
        : []
      const incrementalReminders = formatRemindersForUserMeta(pendingReminders)

      // P0: workspace + attachment retrieval hits are injected into the
      // user-meta context block (alongside memory + LSP) so the main agent
      // actually sees them this turn. Previously they were only emitted as
      // post-stream UI events (`workspace_recall` / `attachment_recall`)
      // visible to the renderer but not to the model — meaning the user saw
      // "workspace recalled 5 snippets" while the assistant's reply
      // confidently said "I don't have access to that file". Sub-agents
      // already inject these via `<retrieved-workspace-context>` (see
      // `subAgentRunner.ts:620`); this brings the main chat to parity.
      // We only consume already-settled branches (no extra wait beyond what
      // the memory race already burned) — non-settled branches still land as
      // UI events post-stream.
      const retrievedBlocksParts: string[] = []
      if (
        retrievalPrefetch.workspace &&
        retrievalPrefetch.workspace.settledAt !== null
      ) {
        try {
          const r = await retrievalPrefetch.workspace.promise
          if (r && r.hits.length > 0) {
            const wsLines = [
              '<retrieved-workspace-context>',
              'These code snippets were selected by semantic similarity to your task. They are CONTEXT, not the only files you should read.',
              ...r.hits.map((h) => {
                const loc = `${h.filePath}:${h.startLine}-${h.endLine}`
                return `\n--- ${loc} (score ${h.score.toFixed(3)}) ---\n${h.text}`
              }),
              '</retrieved-workspace-context>',
            ]
            retrievedBlocksParts.push(wsLines.join('\n'))
          }
        } catch {
          /* best-effort — UI event will still surface citations post-stream */
        }
      }
      if (
        retrievalPrefetch.attachments &&
        retrievalPrefetch.attachments.settledAt !== null
      ) {
        try {
          const r = await retrievalPrefetch.attachments.promise
          if (r && r.hits.length > 0) {
            const atLines = [
              '<retrieved-attachments>',
              'Snippets from attachments the user shared earlier in this conversation, ranked by relevance to the current task.',
              ...r.hits.map((h) => {
                const label = h.namespace ?? 'attachment'
                return `\n--- ${label} (score ${h.score.toFixed(3)}) ---\n${h.text}`
              }),
              '</retrieved-attachments>',
            ]
            retrievedBlocksParts.push(atLines.join('\n'))
          }
        } catch {
          /* best-effort */
        }
      }
      const retrievedBlocks = retrievedBlocksParts.join('\n\n')
      const refParts = [
        refContext,
        // upstream-style progressive disclosure: publish the available
        // skill catalogue as a one-time system-reminder user-meta payload at
        // session start, not as a repeated per-turn system prompt block.
        firstTurnSkillIndex,
        retrievedBlocks,
        // Phase C — incremental delta reminders (skill changes, stale
        // memory). Appended after retrieved context but before the
        // disclaimer so the model groups them with reference material.
        incrementalReminders,
      ].filter((part) => part.trim().length > 0)
      const refWithRetrieval = refParts.join('\n\n')

      // Audit fix R4-M2 (2026-05): the disclaimer used to be skipped
      // whenever `refWithRetrieval` was empty, but the model still
      // received `todayLine` (and could receive incremental reminders
      // injected by later passes). Without the disclaimer the
      // "user's actual current turn is whichever ordinary user
      // message comes LAST" framing never lands, so an injected
      // system-reminder feels indistinguishable from a fresh user
      // instruction. Inject the disclaimer whenever ANY user-meta
      // payload travels — `todayLine` alone is enough to qualify.
      const userContextForPrepend = refWithRetrieval
        ? `${todayLine}\n\n${refWithRetrieval}\n\n${USER_MESSAGE_CONTEXT_DISCLAIMER}`
        : `${todayLine}\n\n${USER_MESSAGE_CONTEXT_DISCLAIMER}`
      const messagesWithUserContext = prependUserContext(normalizedApiMessages, userContextForPrepend) as ApiChatMessage[]

      /** Sub-agents spawned from main chat stream assistant text into `ActiveAgent.latestTextOutput`; pull deltas into this turn so the model sees partial Explore output before the Agent tool returns. */
      const messagesWithSubAgentOutputs = injectPendingSubAgentOutputsForMainTurn(
        messagesWithUserContext,
      ) as ApiChatMessage[]

      /** `<user-query>` anchor — wrap the current turn's ordinary user text
       *  in a structural tag so the model locates the live instruction by
       *  tag instead of the positional "LAST user message" heuristic. Runs
       *  LAST in the message pipeline (after normalize / user-meta prepend /
       *  sub-agent splice) so the anchor always lands on the final wire
       *  shape. Idempotent + wire-only; see `context/anchorUserQuery.ts`. */
      const messagesForModel = anchorCurrentUserQuery(
        messagesWithSubAgentOutputs,
      ) as ApiChatMessage[]

      let effectiveTemperature: number | undefined
      let effectiveTopP: number | undefined
      try {
        const bundle = getActiveBundle()
        if (bundle) {
          const primary = bundle.agents.find((a) => a.isPrimary) ?? bundle.agents[0]
          effectiveTemperature = primary?.temperature ?? bundle.capabilities?.temperature
          effectiveTopP = primary?.topP ?? bundle.capabilities?.topP
        }
      } catch {
        /* ignore bundle read failures */
      }

      if (effectiveEnableTools) {
        const effortForLoop = parseSkillEffort(effortLevelParam)

        // Bundle 主智能体可以收紧主对话可用工具:tools 白名单 / disallowedTools
        // 黑名单 / mcpServers 白名单。任意一项非默认即计算过滤后的 API 工具列表,
        // 作为 `toolDefinitionsOverride` 传给 agenticLoop —— 和子智能体通过
        // `resolveAgentTools` 收紧工具表的策略对称,但跳过 subagent 专属的限制
        // (INTERACTIVE 剥离 / globalSubagentDeny / async_agent profile)。
        //
        // 此外,Bundle 级 capabilities (enabledTools / disallowedTools /
        // enabledMcpServers) 也会叠加在 agent 级约束之上,保证无论选哪个
        // primary agent,都不会突破 Bundle 声明的行业边界。
        let primaryChatToolOverride: ReturnType<typeof toolsToApiDefinitions> | undefined =
          undefined
        let mergedTools = params.primaryAgentTools
        let mergedDisallowed = params.primaryAgentDisallowedTools
        let mergedMcpServers = params.primaryAgentMcpServers
        try {
          const caps = getActiveBundle()?.capabilities
          if (caps) {
            // enabledTools at bundle level: intersect with agent-level allowlist
            if (Array.isArray(caps.enabledTools) && caps.enabledTools.length > 0) {
              if (mergedTools && !(mergedTools.length === 1 && mergedTools[0] === '*')) {
                const bundleSet = new Set(caps.enabledTools.map((n) => n.trim()))
                mergedTools = mergedTools.filter((n) => bundleSet.has(n.trim()))
              } else {
                mergedTools = caps.enabledTools
              }
            }
            // disallowedTools at bundle level: union with agent-level denylist
            if (Array.isArray(caps.disallowedTools) && caps.disallowedTools.length > 0) {
              mergedDisallowed = [...(mergedDisallowed ?? []), ...caps.disallowedTools]
            }
            // enabledMcpServers at bundle level: intersect with agent-level list
            if (Array.isArray(caps.enabledMcpServers) && caps.enabledMcpServers.length > 0) {
              const bundleMcpSet = new Set(caps.enabledMcpServers.map((n) => n.trim()))
              if (mergedMcpServers && mergedMcpServers.length > 0) {
                mergedMcpServers = mergedMcpServers.filter((n) =>
                  bundleMcpSet.has(typeof n === 'string' ? n.trim() : (n as { name: string }).name.trim()),
                )
              } else {
                mergedMcpServers = caps.enabledMcpServers
              }
            }
          }
        } catch {
          /* ignore bundle read failures */
        }
        const filtered = resolvePrimaryChatTools({
          tools: mergedTools,
          disallowedTools: mergedDisallowed,
          mcpServers: mergedMcpServers,
        })
        const baseToolSet =
          filtered ??
          toolRegistry.getAll().filter((tool) => tool.isEnabled?.() !== false)
        if (filtered !== null) {
          primaryChatToolOverride = toolsToApiDefinitions(baseToolSet)
        }

        const agenticParams = {
          config,
          model: model || '',
          messages: messagesForModel,
          systemPrompt,
          systemPromptLayers,
          maxTokens,
          enableTools: effectiveEnableTools,
          diffPermissionMode,
          permissionDefaultMode,
          permissionRules: permissionRulesEffective,
          chatMode: chatInteractionMode,
          signal: abortSignal,
          alwaysThinking,
          ...(effortForLoop ? { effort: effortForLoop } : {}),
          ...(fastModeParam === true ? { fastMode: true } : {}),
          ...(appendixAFlow ? { appendixAFlow } : {}),
          ...(primaryChatToolOverride
            ? { toolDefinitionsOverride: primaryChatToolOverride }
            : {}),
          ...(effectiveTemperature !== undefined ? { temperature: effectiveTemperature } : {}),
          ...(effectiveTopP !== undefined ? { topP: effectiveTopP } : {}),
        }
        const agenticCallbacks = {
          onTextDelta: (text: string) => {
            emitStream( {
              type: 'text_delta',
              text,
            } satisfies StreamEvent)
          },
          onThinkingDelta: (text: string) => {
            emitStream( {
              type: 'thinking_delta',
              text,
            } satisfies StreamEvent)
          },
          onThinkingBlock: (block: { thinking: string; signature?: string; thinkingTimeMs?: number; thinkingTokens?: number }) => {
            // Forward the completed thinking-block payload + signature so the
            // renderer can overwrite the currently-streaming `ChatBlock`
            // thinking.text with the canonical text and stash the signature.
            // Next turn's `chatMessageToAgentApiRows` re-emits this so
            // DeepSeek / Anthropic native don't 400 when the assistant also
            // had a `tool_use` block (see StreamEventType doc).
            emitStream({
              type: 'thinking_block_complete',
              thinkingBlock: block,
            } satisfies StreamEvent)
          },
          onRedactedThinkingBlock: (block: { data: string; startedAtMs?: number }) => {
            // Plan Phase 4 — forward the encrypted chain-of-thought blob to
            // the renderer. Stored verbatim in `ChatMessage.blocks` and
            // echoed back on the next turn by `chatMessageToAgentApiRows`
            // (Anthropic 服务端要求 trajectory 连续，不回灌会签名失败)。
            emitStream({
              type: 'redacted_thinking_block',
              redactedThinkingBlock: block,
            } satisfies StreamEvent)
          },
          onReasoningSummaryDelta: (text: string) => {
            // OpenAI Responses summary stream — surfaced as its own
            // ChatBlock kind (`reasoning_summary`), parallel to but
            // distinct from `thinking_delta` (which carries raw chain-
            // of-thought + signature semantics that summaries don't have).
            emitStream({
              type: 'reasoning_summary_delta',
              text,
            } satisfies StreamEvent)
          },
          onReasoningSummaryBlock: (block: { text: string; thinkingTimeMs?: number; thinkingTokens?: number }) => {
            emitStream({
              type: 'reasoning_summary_block_complete',
              reasoningSummaryBlock: block,
            } satisfies StreamEvent)
          },
          onToolStart: (toolUse: { id: string; name: string; input: Record<string, unknown> }) => {
            emitStream( {
              type: 'tool_start',
              toolUse,
            } satisfies StreamEvent)
          },
          onToolInputDelta: (delta: { toolUseId: string; toolName: string; partialJson: string }) => {
            emitStream({
              type: 'tool_input_delta',
              toolUseId: delta.toolUseId,
              toolName: delta.toolName,
              partialJson: delta.partialJson,
            } satisfies StreamEvent)
          },
          onToolResult: (toolResult: ToolResultEventPayload) => {
            emitStream( {
              type: 'tool_result',
              toolResult,
            } satisfies StreamEvent)
            // Audit P2-1 (2026-05): publish Skill executions as artifacts so
            // the ArtifactDrawer surfaces "what the agent invoked" alongside
            // compaction summaries. Only main-agent skill calls reach this
            // onToolResult callback (sub-agents have their own callback
            // path), so this is naturally scoped to the main turn. Wrapped
            // in try/catch — artifact publication is observability, not
            // correctness.
            if (toolResult.name === 'Skill' && toolResult.success) {
              try {
                const kernel = streamConversationId
                  ? getOrchestrationKernelForConversation(streamConversationId)
                  : undefined
                const port = kernel?.getArtifactPort()
                port?.publish({
                  kind: 'custom',
                  label: `Skill: ${toolResult.id}`,
                  producer: 'Skill',
                  producerTurn: kernel?.getState().iteration,
                  producerInnerTurn: kernel?.getState().innerIteration,
                  payload: {
                    toolUseId: toolResult.id,
                    output: toolResult.output ?? '',
                  },
                })
              } catch (err) {
                console.warn('[streamHandler] ArtifactPort publish (Skill) failed:', err)
              }
            }
          },
          onMessageEnd: (usage?: { inputTokens: number; outputTokens: number }) => {
            emitStream( {
              type: 'message_stop',
              usage,
            } satisfies StreamEvent)
            emitBuddyReaction('message_stop', usage as unknown as Record<string, unknown>)
            scheduleSessionIdleHooks(allowWorkspaceContext ? workspacePath : undefined)
            // Audit §3.2 wire-up — record token usage into the global
            // ResourceQuotaManager's sliding window so the
            // `maxTokenRatePerMinute` admission rule actually fires. Without
            // this hook the window stayed at 0 and the token-rate quota was
            // dead code. Sum input+output so the rate covers what the
            // provider actually billed for. Defensive try/catch: telemetry
            // must never break the stream-end callback.
            if (usage) {
              try {
                const total =
                  (typeof usage.inputTokens === 'number' ? usage.inputTokens : 0) +
                  (typeof usage.outputTokens === 'number' ? usage.outputTokens : 0)
                if (total > 0) {
                  getResourceQuotaManager().recordTokenUsage(total)
                }
              } catch (err) {
                console.warn('[streamHandler] quota.recordTokenUsage failed:', err)
              }
            }
          },
          onError: (error: string) => {
            emitStream( {
              type: 'error',
              error,
            } satisfies StreamEvent)
            emitBuddyReaction('error', { error })
          },
          onContextCompactStart: (detail: { level: string }) => {
            emitStream({
              type: 'context_compact_start',
              level: detail.level,
            } satisfies StreamEvent)
          },
          onContextCompact: (detail: CompactDetail) => {
            emitStream( {
              type: 'context_compact',
              text: 'Context was compacted to continue the conversation.',
              level: detail.level,
              preTokens: detail.preTokens,
              postTokens: detail.postTokens,
              reclaimedTokens: detail.reclaimedTokens,
            } satisfies StreamEvent)
            // Audit P2-1 (2026-05): publish the compact event as a `summary`
            // artifact so the renderer's ArtifactDrawer + future replay path
            // can show "compact level=X reclaimed=Y tokens" alongside the
            // turn's other rich outputs. `ArtifactPort` is in-memory or
            // file-backed depending on whether `userDataDir` was passed to
            // `runOrchestratedMainChat`; we look it up via the active
            // kernel registry (the kernel is always registered by the time
            // this callback fires). Failures swallow silently — artifacts
            // are observability, not correctness.
            try {
              const kernel = streamConversationId
                ? getOrchestrationKernelForConversation(streamConversationId)
                : undefined
              const port = kernel?.getArtifactPort()
              port?.publish({
                kind: 'summary',
                label: `compact (level ${detail.level})`,
                producer: 'compact',
                producerTurn: kernel?.getState().iteration,
                producerInnerTurn: kernel?.getState().innerIteration,
                payload: {
                  level: detail.level,
                  preTokens: detail.preTokens,
                  postTokens: detail.postTokens,
                  reclaimedTokens: detail.reclaimedTokens,
                },
              })
            } catch (err) {
              console.warn('[streamHandler] ArtifactPort publish (compact) failed:', err)
            }
          },
          onStreamingFallback: (info: { status: number; reason: string }) => {
            emitStream( {
              type: 'stream_fallback_reset',
              status: String(info.status),
              reason: info.reason,
            } satisfies StreamEvent)
          },
        }
        // ── Layer-E — `task_terminated` event wiring. ─────────────────
        // The agentic loop fires its terminal callback (`onMessageEnd` →
        // `message_stop`) *before* `runTerminationCleanup`, so a globally
        // registered cleanup runs immediately after `message_stop` for the
        // exact same loop run. We use that ordering to surface the
        // canonical {@link TerminationReason} on a separate event the
        // renderer can wire to a "继续未完成的任务" / retry affordance.
        //
        // The callback is global, but we filter to (a) the main chat
        // (`agentId === 'main'`) and (b) this exact `streamConversationId`
        // so concurrent multi-conversation streams or sub-agent
        // terminations don't cross-contaminate.
        const emitTaskTerminated = (result: import('./loopEvents').AgenticLoopResult) => {
          try {
            emitStream({
              type: 'task_terminated',
              terminationReason: result.terminationResult.reason,
              turnCount: result.terminationResult.turnCount,
              ...(result.terminationResult.errorDetail
                ? { terminationDetail: result.terminationResult.errorDetail }
                : {}),
              ...(result.terminationResult.maxTurnsLimit !== undefined
                ? { maxTurnsLimit: result.terminationResult.maxTurnsLimit }
                : {}),
            } satisfies StreamEvent)
          } catch (err) {
            // Cleanup callbacks must never throw — see runTerminationCleanup.
            console.warn('[StreamHandler] task_terminated emit failed:', err)
          }
        }
        await runOrchestratedMainChat({
          emitStream,
          rendererMessages: apiMessages,
          agenticParams,
          agenticCallbacks,
          ...(streamConversationId ? { conversationId: streamConversationId } : {}),
          chatMode: chatInteractionMode,
          userDataDir: app.getPath('userData'),
          onTerminate: emitTaskTerminated,
        })
      } else {
        await streamText(
          config,
          {
            model: model || '',
            messages: messagesForModel,
            systemPrompt,
            systemPromptLayers,
            maxTokens,
            alwaysThinking,
            ...(thinkingBudgetTokens !== undefined ? { thinkingBudgetTokens } : {}),
            ...(effectiveTemperature !== undefined ? { temperature: effectiveTemperature } : {}),
            ...(effectiveTopP !== undefined ? { topP: effectiveTopP } : {}),
          },
          {
            onTextDelta: (text) => {
              emitStream( {
                type: 'text_delta',
                text,
              } satisfies StreamEvent)
            },
            ...createStreamReasoningCallbacks(emitStream),
            onMessageEnd: (usage) => {
              emitStream( {
                type: 'message_stop',
                usage,
              } satisfies StreamEvent)
              emitBuddyReaction('message_stop', usage as unknown as Record<string, unknown>)
              scheduleSessionIdleHooks(allowWorkspaceContext ? workspacePath : undefined)
            },
            onError: (error) => {
              emitStream( {
                type: 'error',
                error,
              } satisfies StreamEvent)
              emitBuddyReaction('error', { error })
            },
          },
          abortSignal
        )
      }
    })
    completeSessionScope(workspacePathForStream, streamConversationId)

    // Consume any retrieval prefetch branches that settled mid-stream (they
    // weren't ready at send time). This mirrors the upstream mid-loop
    // collect point — each branch ran in parallel with the model, and now
    // we surface each as its own stream event so the renderer can show
    // citations / referenced code / attachment chunks independently.
    if (memoryEnabled && retrievalPrefetch.memory && retrievalPrefetch.memory.settledAt !== null) {
      try {
        const r = await retrievalPrefetch.memory.promise
        if (r && r.recalledMemories.length > 0) {
          emitStream({
            type: 'memory_recall',
            recalledMemories: r.recalledMemories,
          } satisfies StreamEvent)
        }
      } catch {
        // Best-effort — already surfaced or failed silently.
      }
    }
    if (retrievalPrefetch.workspace && retrievalPrefetch.workspace.settledAt !== null) {
      try {
        const r = await retrievalPrefetch.workspace.promise
        if (r && r.hits.length > 0) {
          emitStream({
            type: 'workspace_recall',
            workspaceRetrieval: r.hits.map((h) => ({
              filePath: h.filePath,
              startLine: h.startLine,
              endLine: h.endLine,
              score: h.score,
              namespace: h.namespace,
              text: h.text,
            })),
          } satisfies StreamEvent)
        }
      } catch {
        /* Best-effort */
      }
    }
    if (retrievalPrefetch.attachments && retrievalPrefetch.attachments.settledAt !== null) {
      try {
        const r = await retrievalPrefetch.attachments.promise
        if (r && r.hits.length > 0) {
          emitStream({
            type: 'attachment_recall',
            attachmentRetrieval: r.hits.map((h) => ({
              namespace: h.namespace,
              score: h.score,
              text: h.text,
              meta: h.meta,
            })),
          } satisfies StreamEvent)
        }
      } catch {
        /* Best-effort */
      }
    }

    // Cascade abort to anything still in flight. Mirrors `using` semantics —
    // by the time we reach this point the stream is done, so any unresolved
    // branch is guaranteed irrelevant for this turn.
    try {
      retrievalPrefetch[Symbol.dispose]()
    } catch {
      /* ignore */
    }

    if (process.env.ASTRA_AGENT_TOOL_E2E !== '1' && memoryEnabled && allowWorkspaceContext) {
      autoExtractFromConversation(
        config,
        model || '',
        apiMessages.map((m) => ({
          role: m.role,
          content: typeof m.content === 'string' ? m.content : userMessageContentToPlainText(m.content),
        })),
        {
          autoMemoryDirectory:
            typeof autoMemoryDirectoryParam === 'string' && autoMemoryDirectoryParam.trim()
              ? autoMemoryDirectoryParam.trim()
              : undefined,
          conversationId: streamConversationId ?? 'default',
        },
      ).catch((err) => {
        console.warn('[StreamHandler] Auto-extract failed:', err)
      })
    }
  } catch (error) {
    console.error('[StreamHandler] Error during message handling:', error)
    try {
      const errorEvent = {
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
        conversationId: streamConversationId,
      } satisfies StreamEvent
      emitStreamEventToRenderer(errorEvent)
      queryLoopChannelsByConversation.get(streamConversationId)?.push(errorEvent)
      // Audit P0-2c (2026-05): forward buddy reaction even in the catch path
      // so the sprite reflects mood when the turn fails before any inner
      // `onError` callback ran. `buildBuddyEventFromStream` is null-safe.
      try {
        const buddyEvent = buildBuddyEventFromStream('error', { error: errorEvent.error })
        if (buddyEvent) {
          emitStreamEventToRenderer(buddyEvent as unknown as StreamEvent)
          queryLoopChannelsByConversation.get(streamConversationId)?.push(buddyEvent as unknown as StreamEvent)
        }
      } catch {
        /* swallow: buddy is decorative, never block error reporting */
      }
    } catch (sendError) {
      console.error('[StreamHandler] Failed to send error event:', sendError)
    }
    completeSessionScope(workspacePathForStream, streamConversationId)
  } finally {
    unregisterActiveMainStream(streamId, streamConversationId)
    try {
      queryLoopChannel?.end()
    } catch {
      /* ignore */
    }
    queryLoopChannelsByConversation.delete(streamConversationId)
    if (lastQueryLoopBridge === queryLoopChannel) {
      setLastQueryLoopBridge(null)
    }
    // Beta-latch state is per-conversation; without this drop the four
    // module-level Set/Maps in anthropicBetaHeaderLatch.ts grow once per
    // conversation across the process lifetime.
    cleanupAnthropicBetaHeaderLatchForConversation(streamConversationId)
    // Sibling cleanup for the upstream-style thinking-API-context module
    // (P1/P2/P3 server-side controls). Same lifecycle, same per-conversation
    // Map/Set bounding rationale.
    cleanupAnthropicThinkingApiContextForConversation(streamConversationId)
  }
}
