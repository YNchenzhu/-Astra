/**
 * `sendMessage` / `cancelMessage` slice — the hot path of the chat store.
 *
 * Responsibilities:
 *   - Wait for any still-ingesting attachment to finish (or time out) before
 *     building the API payload, so the model never receives a "ghost
 *     attachment" reference for a PDF that's still being parsed.
 *   - Handle the `/summary` slash command inline (force-extract session
 *     memory from the current transcript).
 *   - Queue extra turns when an assistant is already streaming for this
 *     conversation, so the user's typed-ahead input is not silently
 *     dropped (see `./turnQueue`).
 *   - Compose the `SendAIMessageParams` payload with the active bundle's
 *     primary-agent overlay (system prompt, tools, skills, hooks, permission
 *     mode, effort, thinking budget, …).
 *   - Fire-and-forget race-based retrieval with a 800 ms budget (see
 *     `./retrievalBudget`), then install the streaming router subscriptions
 *     before dispatching the main-process send IPC.
 *   - `cancelMessage` drops any running tool/thinking/sub-agent UI state on
 *     the last assistant row, clears the per-conversation queue, and fires
 *     the cancel IPC.
 */
import type { StateCreator } from 'zustand'
import type { Attachment, ChatMessage } from '../../../types'
import { isUntrustedWorkspacePathError } from '../../../utils/workspaceTrustPrompt'
import { reportUserActionError } from '../../../utils/reportUserActionError'
import {
  sendMessage as sendAIMessage,
  cancelStream,
  enqueueMidTurnInput,
  type SendAIMessageParams,
} from '../../../services/electronAPI'
import {
  getActiveBundlePrimaryAgent,
  composeSystemPromptFromBundleAgent,
} from '../../bundleStore'
import { useSettingsStore } from '../../useSettingsStore'
import { useWorkspaceStore } from '../../useWorkspaceStore'
import { buildUserRulesPromptFromStorage } from '../../../utils/userRulesPrompt'
import { buildMainChatApiMessagesForSend } from '../apiMessageBuilder'
import { retrieveWithBudget } from '../retrievalBudget'
import { fireRetrievalUiCaptureAsync } from '../retrievalCapture'
import {
  pendingAssistantByConversation,
  patchConversationSlice,
} from '../sessionSlice'
import {
  enqueueMainChatTurn,
  clearMainChatTurnQueue,
  flushMainChatTurnQueueForConversation,
} from '../turnQueue'
import { ensureMainChatStreamRouter } from '../mainStreamRouter'
import { ensureSubAgentGlobalStream } from '../subAgentStreamRouter'
import { chatStoreApi } from '../storeApiRef'
import type { ChatState } from '../types'

export type SendSlice = Pick<ChatState, 'sendMessage' | 'cancelMessage'>

export const createSendSlice: StateCreator<
  ChatState, [], [], SendSlice
> = (set, get) => ({
  sendMessage: async () => {
    let {
      inputText,
      messages,
      enableTools,
      permissionMode,
      chatInteractionMode,
      diffPermissionMode,
      currentConversationId,
      referencedFiles: refPaths,
      pendingAttachments,
    } = get()
    if (!inputText.trim() && pendingAttachments.length === 0) return

    // Wait for still-ingesting `type:'file'` attachments to finish before
    // building the API payload. Before this gate, a fast <Enter> right after
    // dropping a 5MB PDF would race the async `window.electronAPI.attachments.
    // ingest` call — the attachment was still `status: 'processing'`, and
    // `renderFileAttachmentText` returns `null` for processing/error, so the
    // model received a message with no file payload. The UI bubble still
    // showed the attachment, so users thought it was attached. Here we poll
    // briefly, then proceed with whatever resolved — errored attachments are
    // left visible to the user but dropped from the API payload.
    const anyProcessing = pendingAttachments.some(
      (a) => a.type === 'file' && a.status === 'processing',
    )
    if (anyProcessing) {
      const WAIT_MS_MAX = 20_000
      const POLL_INTERVAL_MS = 120
      const deadline = Date.now() + WAIT_MS_MAX
      while (Date.now() < deadline) {
        const snap = get().pendingAttachments
        const stillProcessing = snap.some(
          (a) => a.type === 'file' && a.status === 'processing',
        )
        if (!stillProcessing) {
          pendingAttachments = snap
          break
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
      }
      // Refresh the local snapshot after the wait; any attachment still in
      // `processing` after the deadline is skipped from serialization below
      // (the existing `renderFileAttachmentText` null-returns for them).
      pendingAttachments = get().pendingAttachments
      // Also refresh the other store fields we already destructured — the user
      // may have typed more / switched mode during the wait and we should ship
      // the latest state, not the stale read from the top of this function.
      const fresh = get()
      inputText = fresh.inputText
      messages = fresh.messages
      enableTools = fresh.enableTools
      permissionMode = fresh.permissionMode
      chatInteractionMode = fresh.chatInteractionMode
      diffPermissionMode = fresh.diffPermissionMode
      currentConversationId = fresh.currentConversationId
      refPaths = fresh.referencedFiles
    }

    // 2026-07 审计修复(P0):解析失败 / 等待超时仍在解析的附件不再静默
    // 丢弃。此前它们在序列化层被 null 掉、模型收不到,但用户气泡照常显示
    // 文件名 —— 用户以为 AI 看到了文件。现在:
    //   - 若消息除失败附件外没有任何内容(无文本/无成功附件),拦截发送;
    //   - 否则从本次发送中剔除失败附件,并明确告知用户哪些被剔除。
    {
      const unsendable = new Set<Attachment>(
        pendingAttachments.filter(
          (a) => a.type === 'file' && (a.status === 'error' || a.status === 'processing'),
        ),
      )
      if (unsendable.size > 0) {
        const names = [...unsendable]
          .map((a) => (a.type === 'file' ? a.name : ''))
          .filter(Boolean)
          .join('、')
        const hasOtherContent =
          inputText.trim().length > 0 ||
          pendingAttachments.some(
            (a) => a.type === 'image' || (a.type === 'file' && a.status === 'ready'),
          )
        if (!hasOtherContent) {
          reportUserActionError(
            '发送消息',
            new Error(`附件未能解析(${names}),没有可发送的内容。请重试附件或输入文本。`),
          )
          return
        }
        reportUserActionError(
          '附件解析',
          new Error(`以下附件解析失败或超时,本次发送已剔除:${names}`),
        )
        pendingAttachments = pendingAttachments.filter((a) => !unsendable.has(a))
        set({ pendingAttachments })
      }
    }

    const summaryCmd = /^\s*\/summary(?:\s|$)/i.test(inputText.trim())
    if (summaryCmd && typeof window !== 'undefined' && window.electronAPI?.session?.manualMemoryExtract) {
      let convId = currentConversationId
      if (!convId) {
        convId = `conv-${Date.now()}`
        set({ currentConversationId: convId })
      }
      const apiMessages = buildMainChatApiMessagesForSend(messages, refPaths)
      set({ inputText: '', referencedFiles: [], pendingAttachments: [] })
      try {
        const result = await window.electronAPI.session.manualMemoryExtract({
          conversationId: convId,
          messages: apiMessages as unknown as Array<Record<string, unknown>>,
        })
        const reply = result.ok
          ? '已根据当前对话更新会话记忆（session memory）。'
          : `会话记忆更新失败：${result.error ?? 'unknown'}`
        const ts = Date.now()
        set((s) => ({
          messages: [
            ...s.messages,
            { id: `msg-${ts}`, role: 'user', content: '/summary', timestamp: ts },
            {
              id: `msg-${ts + 1}`,
              role: 'assistant',
              content: reply,
              timestamp: ts + 1,
            },
          ],
        }))
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        const ts = Date.now()
        set((s) => ({
          messages: [
            ...s.messages,
            { id: `msg-${ts}`, role: 'user', content: '/summary', timestamp: ts },
            {
              id: `msg-${ts + 1}`,
              role: 'assistant',
              content: `会话记忆更新失败：${msg}`,
              timestamp: ts + 1,
            },
          ],
        }))
      }
      return
    }

    const snapshotRefs = [...refPaths]
    const snapshotAttachments: Attachment[] = [...pendingAttachments]

    // Auto-generate conversation ID if none
    let convId = currentConversationId
    if (!convId) {
      convId = `conv-${Date.now()}`
      set({ currentConversationId: convId })
    }

    if (pendingAssistantByConversation.has(convId)) {
      // M2 (2026-07) — a main stream is in flight. TEXT-ONLY input is
      // delivered to the RUNNING turn via the kernel inbox: the model
      // receives it at the next post-tool boundary under the
      // instruction-level `kernel_user_input` side-channel kind (N2 fix),
      // so a mid-turn redirect steers the CURRENT work instead of waiting
      // out the whole turn as a replayed follow-up. The user's words are
      // appended to the visible transcript immediately; next turn's
      // history rebuild carries them as a plain user row (the in-loop
      // side-channel copy is superseded by the renderer sync).
      //
      // Attachment/ref-bearing sends need the full send pipeline
      // (retrieval, attachment ingest), and any enqueue failure (no
      // kernel registered, bridge missing) falls back to the local
      // replay queue — user input is NEVER dropped.
      const midTurnText = inputText.trim()
      if (
        midTurnText &&
        snapshotRefs.length === 0 &&
        snapshotAttachments.length === 0
      ) {
        const delivered = await enqueueMidTurnInput({
          conversationId: convId,
          text: midTurnText,
        })
        if (delivered.ok) {
          const midTurnMessage: ChatMessage = {
            id: `msg-${Date.now()}`,
            role: 'user',
            content: midTurnText,
            timestamp: Date.now(),
          }
          set((s) => ({
            messages: [...s.messages, midTurnMessage],
            inputText: '',
            referencedFiles: [],
            pendingAttachments: [],
          }))
          return
        }
      }
      enqueueMainChatTurn(convId, {
        inputText: inputText.trim(),
        referencedFiles: snapshotRefs,
        pendingAttachments: snapshotAttachments,
      })
      set({
        inputText: '',
        referencedFiles: [],
        pendingAttachments: [],
      })
      return
    }

    const userMessage: ChatMessage = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content: inputText.trim(),
      timestamp: Date.now(),
      ...(snapshotRefs.length > 0 ? { referencedFiles: [...snapshotRefs] } : {}),
      ...(snapshotAttachments.length > 0 ? { attachments: [...snapshotAttachments] } : {}),
    }

    const assistantId = `msg-${Date.now() + 1}`
    const assistantMessage: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
      blocks: [],
      toolUses: [],
    }

    set((s) => ({
      messages: [...s.messages, userMessage, assistantMessage],
      inputText: '',
      isTyping: true,
      referencedFiles: [],
      pendingAttachments: [],
      // Layer-E — clear any prior `task_terminated` flag so a fresh user
      // turn dismisses the recovery affordance. The next `task_terminated`
      // event (if the loop fails again) repopulates it.
      latestTerminationReason: null,
    }))

    const allMessages = [...messages, userMessage]
    // P0: Race-based retrieval with 800ms budget. Whatever settles in time gets
    // injected as context snippets; slower sources (cloud-embed cold start, etc.)
    // are abandoned so first token stays fast. Pre-refactor this wait could be
    // 0.5–5s and was strictly blocking; see `retrieveWithBudget` for the shape.
    const budgetedSnippets = await retrieveWithBudget(allMessages, snapshotRefs)
    // Path-only contract: referenced files arrive in the prompt as a
    // `# referenced_paths` hint and nothing else. The model decides whether to
    // call `read_file` for the actual bytes. Avoids double-reading (we used to
    // pre-attach the parsed body, then the agent would still tool-call to
    // verify, costing a round-trip and burning tokens for the redundant copy).
    const apiMessages = buildMainChatApiMessagesForSend(
      allMessages,
      snapshotRefs,
      get().currentCompactSummary || undefined,
      budgetedSnippets,
    )

    // Trailing fire-and-forget: populate `userMessage.retrievedChunks` for the
    // "相关片段" pill strip regardless of whether the chunks made the budget.
    void fireRetrievalUiCaptureAsync(chatStoreApi(), userMessage.id, allMessages)

    const workspaceState = useWorkspaceStore.getState()

    try {
      ensureMainChatStreamRouter()
      ensureSubAgentGlobalStream()
      pendingAssistantByConversation.set(convId, assistantId)

      const settings = useSettingsStore.getState()
      let sendEnableTools = enableTools
      let sendPermissionMode = permissionMode
      if (chatInteractionMode === 'plan') {
        sendPermissionMode = 'plan'
        sendEnableTools = true
      } else if (chatInteractionMode === 'ask') {
        sendPermissionMode = 'default'
        sendEnableTools = false
      } else {
        sendEnableTools = true
        sendPermissionMode = permissionMode
      }

      // Route the main chat through the currently active bundle's primary
      // agent — otherwise switching bundles (e.g. 代码开发 → 售前工程师)
      // has no effect on behavior because the request was hardcoded to
      // `general-purpose` and carried no systemPrompt override.
      //
      // 本段除了 `systemPrompt` + `agentType` 外,还透传主智能体配置里的
      // 关键行为字段(isReadOnly / initialPrompt / criticalReminder /
      // skills / agentHooks / permissionMode / effort / thinkingBudgetTokens /
      // omitClaudeMd),由主进程 `handleSendMessage` 消费,让工作台里配的
      // "人设+规则+技能+钩子"能真正影响主对话行为,而不是只改个头像文字。
      const primaryAgent = getActiveBundlePrimaryAgent()
      const bundleSystemPrompt = composeSystemPromptFromBundleAgent(primaryAgent)
      const resolvedAgentType = primaryAgent?.agentType?.trim() || 'general-purpose'

      // 主智能体可以覆盖 settings.hooks —— 把 bundle 级 hook 放在前面
      // 这样 matcher 相同时 bundle hooks 优先触发(后续 stop 类 hook 可以先接力)
      const bundleHooks = Array.isArray(primaryAgent?.agentHooks)
        ? (primaryAgent!.agentHooks as SendAIMessageParams['primaryAgentHooks'])
        : undefined

      // permissionMode 优先级:用户级意图(聊天输入框的 plan/ask 切换) > 主智能体
      // > settings 默认。`acceptEdits` 是 agent 特有值,chat PermissionMode 没有,
      // 在主对话侧降级成 `default`(行为最接近:"危险工具需确认,普通 edit 放行"由
      // diffPermissionMode 掌管)。
      const agentMode = primaryAgent?.permissionMode
      const agentModeMapped =
        agentMode === 'acceptEdits'
          ? 'default'
          : agentMode === 'default' || agentMode === 'plan' || agentMode === 'bypassPermissions'
            ? agentMode
            : undefined
      const resolvedPermissionMode =
        chatInteractionMode === 'plan' || chatInteractionMode === 'ask'
          ? sendPermissionMode // user intent wins
          : (agentModeMapped ?? sendPermissionMode)

      const resolvedEffort = primaryAgent?.effort ?? settings.effortLevel
      const resolvedThinkingBudget =
        typeof primaryAgent?.thinkingBudgetTokens === 'number'
          ? primaryAgent.thinkingBudgetTokens
          : settings.thinkingBudgetTokens

      const aiPayload: SendAIMessageParams = {
        messages: apiMessages,
        conversationId: convId,
        workspacePath: workspaceState.rootPath || undefined,
        agentType: resolvedAgentType,
        ...(bundleSystemPrompt ? { systemPrompt: bundleSystemPrompt } : {}),
        providerId: settings.providerId,
        model: settings.model,
        maxTokens: settings.maxTokens,
        apiKey: settings.getApiKey(),
        baseUrl: settings.getBaseUrl(),
        anthropicThinkingCapability: settings.getAnthropicThinkingCapability(),
        awsRegion: settings.getAwsRegion(),
        projectId: settings.getProjectId(),
        outputStyle: settings.outputStyle,
        language: settings.language,
        enableTools: sendEnableTools,
        permissionMode: resolvedPermissionMode,
        // Stage 3.3 — forward the renderer chat-input mode so the kernel's
        // chat-mode permission port can deny mutating tools at preflight under
        // Plan mode and disable tools entirely under Ask mode. Independent of
        // `permissionMode` (which is the lower-level policy on the legacy
        // `runAgenticToolUse` side); both layers run together.
        chatInteractionMode,
        diffPermissionMode,
        permissionDefaultMode: settings.permissionDefaultMode,
        permissionRules: settings.permissionRules,
        hooks: settings.hooks,
        disableAllHooks: settings.disableAllHooks,
        envVars: settings.envVars,
        userRulesPrompt: buildUserRulesPromptFromStorage(),
        autoTaskRouting: settings.autoTaskRouting,
        autoDetectFormat: settings.autoDetectFormat,
        autoMemoryEnabled: settings.autoMemoryEnabled,
        autoMemoryDirectory: settings.autoMemoryDirectory,
        effortLevel: resolvedEffort,
        alwaysThinking: settings.alwaysThinking,
        thinkingBudgetTokens: resolvedThinkingBudget,
        fastMode: settings.fastMode,

        // ─── 工作包主智能体 overlay ───
        ...(primaryAgent?.criticalReminder
          ? { primaryAgentCriticalReminder: primaryAgent.criticalReminder }
          : {}),
        ...(primaryAgent?.initialPrompt
          ? { primaryAgentInitialPrompt: primaryAgent.initialPrompt }
          : {}),
        ...(Array.isArray(primaryAgent?.skills) && primaryAgent.skills.length > 0
          ? { primaryAgentSkills: primaryAgent.skills }
          : {}),
        ...(primaryAgent?.isReadOnly === true ? { primaryAgentIsReadOnly: true } : {}),
        ...(primaryAgent?.omitClaudeMd === true
          ? { primaryAgentOmitClaudeMd: true }
          : {}),
        ...(bundleHooks && bundleHooks.length > 0
          ? { primaryAgentHooks: bundleHooks }
          : {}),
        // Tools / MCP overlay:只传"非默认"配置,让主进程决定是否覆盖
        // 默认全量工具。tools=['*'] 或全空一律不传。
        ...(Array.isArray(primaryAgent?.tools) &&
        primaryAgent.tools.length > 0 &&
        !(primaryAgent.tools.length === 1 && primaryAgent.tools[0] === '*')
          ? { primaryAgentTools: primaryAgent.tools }
          : {}),
        ...(Array.isArray(primaryAgent?.disallowedTools) &&
        primaryAgent.disallowedTools.length > 0
          ? { primaryAgentDisallowedTools: primaryAgent.disallowedTools }
          : {}),
        ...(Array.isArray(primaryAgent?.mcpServers) && primaryAgent.mcpServers.length > 0
          ? {
              primaryAgentMcpServers: primaryAgent.mcpServers
                .map((r) => (typeof r === 'string' ? r : r?.name))
                .filter((s): s is string => typeof s === 'string' && s.length > 0),
            }
          : {}),
        ...(primaryAgent?.memory === 'user' ||
        primaryAgent?.memory === 'project' ||
        primaryAgent?.memory === 'local'
          ? { primaryAgentMemoryScope: primaryAgent.memory }
          : {}),
      }
      await sendAIMessage(aiPayload)
    } catch (error: unknown) {
      const rawMessage = error instanceof Error ? error.message : String(error)
      // Audit fix A2-UX (2026-05) — when the workspace boundary rejects
      // mid-chat (strict mode + a path that lost its trust mid-session,
      // or a race between workspace switch + Enter), rewrite the raw
      // backend reason into actionable copy. Showing the original
      // "workspace path ... is not in the trust list (strict mode). ..."
      // is correct but blames the wire format; the user just wants to
      // know what to click next.
      const friendlyMessage = isUntrustedWorkspacePathError(error)
        ? '当前工作区未被信任。请先在侧边栏"信任此工作区"按钮或 设置 → 权限 → 工作区信任 中将其加入信任列表，然后再次发送。'
        : `Error: ${rawMessage}`
      pendingAssistantByConversation.delete(convId)
      set((st) =>
        patchConversationSlice(st, convId, (sl) => ({
          ...sl,
          messages: sl.messages.map((m) =>
            m.id === assistantId
              ? { ...m, content: friendlyMessage, isStreaming: false }
              : m,
          ),
          isTyping: false,
          pendingPermissionRequest: null,
          pendingAskUserQuestion: null,
        })),
      )
    }
  },

  cancelMessage: async () => {
    const { messages } = get()
    // Skip compact_boundary rows — they share role='assistant' but
    // carry no blocks/toolUses to stop; cancel must target the actual
    // streaming assistant that owns the running tool_use blocks.
    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.role === 'assistant' && m.kind !== 'compact_boundary')

    if (lastAssistant) {
      set((s) => ({
        messages: s.messages.map((m) => {
          if (m.id !== lastAssistant.id) return m
          // 2026-07 interruption-protocol fix — remember that THIS assistant
          // turn was cut off by the user, but only when something was
          // actually in flight (streaming text/thinking or a running tool /
          // sub-agent). `contextBuilder.chatMessageToAgentApiRows` reads the
          // flag on the NEXT send and appends a `[User interrupted…]` user
          // row, so the model stops treating the truncated reply as a
          // deliberate, complete answer (cc-haha INTERRUPT_MESSAGE parity).
          const wasInFlight =
            m.isStreaming === true ||
            (m.blocks || []).some(
              (b) =>
                (b.type === 'tool_use' && b.status === 'running') ||
                ((b.type === 'thinking' || b.type === 'reasoning_summary') &&
                  b.isStreaming === true),
            ) ||
            (m.toolUses || []).some((tu) => tu.status === 'running') ||
            (m.subAgents || []).some((sa) => sa.status === 'running')
          // Stop all running tool_use blocks and thinking blocks
          const blocks = (m.blocks || []).map((b) => {
            if (b.type === 'tool_use' && b.status === 'running') {
              // Honesty fix: a user Stop is a cancellation, not a success.
              // Marking as 'stopped' (a terminal status the ToolUseCard /
              // BaseCard already render, with a retry affordance) avoids the
              // misleading "已完成" badge on a tool the user actually aborted.
              return { ...b, status: 'stopped' as const }
            }
            if (b.type === 'thinking' && b.isStreaming) {
              // Tombstone-lite — upstream-main 的 query.ts:712 是直接对整条
              // assistant 消息打 tombstone，我们这里更克制，只把这一条
              // "半成品 thinking" 块本身清掉：
              //   - `text = ''`：下一轮 `chatMessageToAgentApiRows` 看到
              //     `!text.trim()` 就 skip（contextBuilder.ts:696），不会把
              //     这截被强行打断的内部推理作为 history 回灌给下一次请求。
              //     这正是"思考链噪声 → AI 幻觉"的典型链路——半截推理通常
              //     停在反思/假设阶段，回灌后模型会照着错误前提继续推。
              //   - `isStreaming = false`：停掉 `ThinkingBlock` 内部的 tick
              //     计时器（与上一次"253.7s 一直跑"那个 bug 同根）。
              return { ...b, text: '', isStreaming: false }
            }
            if (b.type === 'reasoning_summary' && b.isStreaming) {
              // Same tombstone-lite as thinking,with one provider-shape
              // simplification: reasoning_summary blocks are output-only by
              // API contract (see `types/tool.ts:895` 注释) — they don't
              // carry a `signature` and are never echoed back to the model
              // via `chatMessageToAgentApiRows`. So the noise risk is purely
              // UI-side (a half-rendered summary card with the spinner stuck
              // on after cancel,then surviving session reload because
              // `stripStreamingUiFlags` only knew about `thinking`).
              // Clearing `text` here doubles as a cheap dedupe — if the user
              // immediately retries,the next turn won't briefly flash the
              // pre-cancel summary text while waiting for the new stream.
              return { ...b, text: '', isStreaming: false }
            }
            return b
          })
          // Stop all running toolUses. Honesty fix: mark 'stopped' (terminal,
          // rendered by ToolUseCard with a retry affordance) rather than
          // 'completed', so a user-aborted tool isn't shown as succeeded.
          const toolUses = (m.toolUses || []).map((tu) =>
            tu.status === 'running'
              ? { ...tu, status: 'stopped' as const }
              : tu,
          )
          // Stop all running subAgents
          const subAgents = (m.subAgents || []).map((sa) =>
            sa.status === 'running'
              ? { ...sa, status: 'failed' as const }
              : sa,
          )
          return {
            // G: legacy `isThinking: false` mirror dropped — the
            // block-level `isStreaming` flag inside `blocks` is the
            // canonical "still thinking" indicator and is sealed
            // elsewhere in the cancel path.
            ...m,
            isStreaming: false,
            ...(wasInFlight ? { interruptedByUser: true } : {}),
            blocks,
            toolUses,
            subAgents,
          }
        }),
        isTyping: false,
      }))
    }

    set({
      pendingPermissionRequest: null,
      pendingAskUserQuestion: null,
      // Both plan-approval slots clear immediately on Stop click so the
      // card disappears without waiting for the main-process drain hook
      // round-trip. The bridge-side drain (registered by both
      // `mainChatPlanApprovalBridge` and `teamPlanApprovalLeaderBridge`)
      // independently resolves the parked Promise with `cancelled`/`aborted`
      // so the worker tool's await wakes up too.
      //
      // 2026-07 UI-jank audit — this set() must run BEFORE the
      // `await cancelStream(cid)` IPC below. It used to run after, which
      // contradicted the "immediately" intent above: when the main process
      // is busy with abort-path work the invoke reply is queued behind it,
      // and the permission / plan-approval cards visibly lingered after
      // the Stop click.
      pendingPlanApproval: null,
      pendingTeamPlanApproval: null,
    })

    const cid = get().currentConversationId
    if (cid) {
      clearMainChatTurnQueue(cid)
      await cancelStream(cid)
    }
  },
})

// Expose the bound turnQueue flush for in-module callers (conversation switch).
// Kept here so the per-conversation flush path uses a single
// `useChatStore`-bound call site rather than four-arg boilerplate sprinkled
// across the other slices.
export function flushTurnQueueFor(convId: string): void {
  const api = chatStoreApi()
  flushMainChatTurnQueueForConversation(
    api.getState,
    api.setState as (partial: Partial<ChatState>) => void,
    () => api.getState().sendMessage(),
    convId,
  )
}
