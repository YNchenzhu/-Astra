import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { X, Settings, Square, Plus, Search, History, Download, Eraser, Brain } from 'lucide-react'
import { useLayoutStore } from '../../stores/useLayoutStore'
import { useChatStore, countBackgroundActiveStreams } from '../../stores/useChatStore'
import { useSettingsStore } from '../../stores/useSettingsStore'
import {
  getContextState,
  getPlanningStatus,
  onContextDisplayUpdated,
  respondTeamPermissionRequest,
  type ContextState,
} from '../../services/electronAPI'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'
import { useFileStore } from '../../stores/useFileStore'
import { normalizePath, toRelativePath } from '../../services/pathUtils'
import { ChatMessageList, type ChatMessageListHandle } from './chatPanel/ChatMessageList'
import { ChatInput } from './ChatInput'
import { PermissionPrompt } from './PermissionPrompt'
import { TeamPlanApprovalCard } from './TeamPlanApprovalCard'
import { PlanApprovalCard } from './PlanApprovalCard'
import { ensurePlanTabStream } from '../../services/planTab'
import { ensureAutoResumeBackgroundTaskController } from '../../stores/chat/autoResumeBackgroundTasks'
import { AskUserQuestionBlock } from './AskUserQuestionDialog'
import { HistorySearchDialog } from './HistorySearchDialog'
import { ConversationList } from './ConversationList'
import { ReasoningTimeline } from './ReasoningTimeline'
import { TodoPanel } from './TodoPanel'
import { SessionMemoryIndicator } from './SessionMemoryIndicator'
import { OrchestrationTimeline } from './OrchestrationTimeline'
import { TerminationRecoveryBanner } from './TerminationRecoveryBanner'
import { RetrievalCitation } from './RetrievalCitation'
import { PreflightDenialToast } from './PreflightDenialToast'
import { CompactionToast } from './CompactionToast'
import './CompactionToast.css'
import { ArtifactDrawer } from './ArtifactDrawer'
import { formatAsMarkdown, downloadMarkdown } from '../../services/conversationAPI'
import { ensureSubAgentGlobalStream } from '../../stores/useChatStore'
import type { SessionSnapshot } from '../../types'
import { StreamingModeBar } from './chatPanel/StreamingModeBar'
import { FileChangeList } from './chatPanel/FileChangeList'
import { ContextMeter } from './chatPanel/ContextMeter'
import { useT } from '../../i18n'
import './ChatInput.css'
import './ChatPanel.css'

export const ChatPanel: React.FC = () => {
  const t = useT()
  // Per-field selectors: a whole-store destructure subscribes to every state change
  // and re-renders ChatPanel on every streaming delta. Splitting to single-field
  // selectors isolates re-renders to the exact fields this component consumes.
  // Actions are stable references and contribute zero re-renders.
  const aiChatWidth = useLayoutStore((s) => s.aiChatWidth)
  const aiChatHeight = useLayoutStore((s) => s.aiChatHeight)
  const setAIChatWidth = useLayoutStore((s) => s.setAIChatWidth)
  const setAIChatHeight = useLayoutStore((s) => s.setAIChatHeight)
  // Ref mirror of aiChatHeight so the window-resize listener doesn't churn
  // on every drag → aiChatHeight change.
  const aiChatHeightRef = useRef(aiChatHeight)
  aiChatHeightRef.current = aiChatHeight

  // ChatPanel no longer subscribes to the whole `messages` array — that lives
  // in <ChatMessageList> so streaming deltas re-render only the transcript
  // subtree, not the panel chrome. We keep just the length for the empty
  // state + header button enablement (changes when a message is added/removed,
  // not on every token). Dialogs that need the full array read a getState()
  // snapshot at render time.
  const messagesLength = useChatStore((s) => s.messages.length)
  const isTyping = useChatStore((s) => s.isTyping)
  const enableTools = useChatStore((s) => s.enableTools)
  const pendingPermissionRequest = useChatStore((s) => s.pendingPermissionRequest)
  const pendingAskUserQuestion = useChatStore((s) => s.pendingAskUserQuestion)
  // P0-2 follow-up: a teammate worker is awaiting our plan approval.
  // Subscribed alongside the existing pending-* slots so the inline
  // card surfaces in the same `chat-inline-prompts` stack.
  const pendingTeamPlanApproval = useChatStore((s) => s.pendingTeamPlanApproval)
  // the IDE `create_plan`-style main-chat plan-approval (tri-state). Same
  // stack as the team variant; only one can be active per conversation
  // at a time in practice (an in-flight ExitPlanMode blocks the loop).
  const pendingPlanApproval = useChatStore((s) => s.pendingPlanApproval)
  const currentConversationId = useChatStore((s) => s.currentConversationId)
  const currentConversationTitle = useChatStore((s) => s.currentConversationTitle)
  const permissionMode = useChatStore((s) => s.permissionMode)
  const diffPermissionMode = useChatStore((s) => s.diffPermissionMode)
  const recalledMemories = useChatStore((s) => s.recalledMemories)
  // Layer-E — last recoverable `task_terminated` reason for the recovery banner.
  const latestTerminationReason = useChatStore((s) => s.latestTerminationReason)
  const setInputText = useChatStore((s) => s.setInputText)
  const cancelMessage = useChatStore((s) => s.cancelMessage)
  const respondToPermissionRequest = useChatStore((s) => s.respondToPermissionRequest)
  const startNewConversation = useChatStore((s) => s.startNewConversation)
  const clearConversationContext = useChatStore((s) => s.clearConversationContext)
  const loadConversationById = useChatStore((s) => s.loadConversationById)
  const deleteConversationById = useChatStore((s) => s.deleteConversationById)
  const renameConversation = useChatStore((s) => s.renameConversation)

  const setShowSettings = useSettingsStore((s) => s.setShowSettings)
  const promptSuggestionEnabled = useSettingsStore((s) => s.promptSuggestionEnabled)
  const spinnerTipsEnabled = useSettingsStore((s) => s.spinnerTipsEnabled)
  const prefersReducedMotion = useSettingsStore((s) => s.prefersReducedMotion)
  const showThinkingSummaries = useSettingsStore((s) => s.showThinkingSummaries)
  // 长会话兜底（plan Phase 3.B）：会话内 thinking 块总数超过这个阈值时，所有
  // 非 streaming 的历史块强制折叠。0 = 关闭机制。
  const thinkingAutoCollapseThreshold = useSettingsStore(
    (s) => s.thinkingAutoCollapseThreshold ?? 8,
  )

  const rootPath = useWorkspaceStore((s) => s.rootPath)
  const backgroundStreamCount = useChatStore((s) => countBackgroundActiveStreams(s))
  const isResizing = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(0)
  const isVerticalResizing = useRef(false)
  const startY = useRef(0)
  const startHeight = useRef(0)
  const [resizing, setResizing] = useState(false)
  const [verticalResizing, setVerticalResizing] = useState(false)

  const panelRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<ChatMessageListHandle>(null)
  const [showHistorySearch, setShowHistorySearch] = useState(false)
  const [showConversationList, setShowConversationList] = useState(false)
  const [showReasoningTimeline, setShowReasoningTimeline] = useState(false)
  const [contextState, setContextState] = useState<ContextState | null>(null)
  const [showContextBreakdown, setShowContextBreakdown] = useState(false)
  /**
   * Phase G + audit P0 — host-side notes from slash commands
   * (`/context`, `/compact`, `/memory`). The ChatInput dispatches a
   * `pole:slash-command-note` CustomEvent and `pole:open-diagnostics`
   * to open the context drawer; we own the subscriptions here so the
   * commands have visible feedback.
   */
  const [slashCommandNotes, setSlashCommandNotes] = useState<
    Array<{ id: number; text: string }>
  >([])
  const [sessionState, setSessionState] = useState<{ tasks: number; files: number; errors: number } | null>(null)
  const [planningState, setPlanningState] = useState<null | {
    planFilePath: string
    total: number
    pending: number
    inProgress: number
    completed: number
  }>(null)
  const [tipIndex, setTipIndex] = useState(0)

  const suggestions = useMemo(() => t.chat.suggestions, [t])
  const spinnerTips = useMemo(() => t.chat.spinnerTips, [t])

  // Install the once-per-process plan tab stream (plan:active / plan:updated
  // → open / live-refresh the plan markdown tab). Mirrors ensureTaskListV2Stream.
  useEffect(() => {
    ensurePlanTabStream()
    // Background-task completion → auto-resume the idle conversation (guarded:
    // agent mode + idle + empty input + no pending user gate + rolling cap).
    ensureAutoResumeBackgroundTaskController()
  }, [])

  useEffect(() => {
    const fetchCtx = () => {
      void getContextState(currentConversationId || undefined)
        .then(setContextState)
        .catch((err: unknown) => {
          // The header pill (token usage / compact level) silently keeps its
          // last value when this fetch fails. The IPC push channel
          // (`onContextDisplayUpdated`) and the next interval tick will both
          // re-attempt, so we don't surface a UI error — but we DO log so a
          // persistent failure is visible to anyone with devtools open
          // instead of being swallowed entirely.
          console.warn('[ChatPanel] getContextState (interval) failed:', err)
        })
    }
    fetchCtx()
    // IPC push from main (`updateConversationContextDisplay`) is primary; interval is a safety net.
    const intervalMs = isTyping ? 4000 : 25000
    const interval = setInterval(fetchCtx, intervalMs)
    return () => clearInterval(interval)
  }, [currentConversationId, isTyping])

  useEffect(() => {
    const unsub = onContextDisplayUpdated((payload) => {
      const cur = currentConversationId?.trim() ?? ''
      if (payload.conversationId != null && payload.conversationId !== cur) return
      void getContextState(cur || undefined)
        .then(setContextState)
        .catch((err: unknown) => {
          console.warn('[ChatPanel] getContextState (push refresh) failed:', err)
        })
    })
    return unsub
  }, [currentConversationId])

  useEffect(() => {
    const fetchPlanStatus = () => {
      void getPlanningStatus()
        .then(setPlanningState)
        .catch((err: unknown) => {
          console.warn('[ChatPanel] getPlanningStatus failed:', err)
        })
    }
    fetchPlanStatus()
    const interval = setInterval(fetchPlanStatus, 3000)
    return () => clearInterval(interval)
  }, [])

  // Phase G + audit P0 — listen for slash-command host events.
  // ChatInput dispatches both, but nobody was listening before this
  // patch so the user could not see `/context` / `/memory` output.
  useEffect(() => {
    const seqRef = { current: 0 }
    const onNote = (e: Event) => {
      const detail = (e as CustomEvent<{ text?: string }>).detail
      const text = detail?.text
      if (typeof text !== 'string' || !text.trim()) return
      const id = ++seqRef.current
      setSlashCommandNotes((prev) => {
        const next = [...prev, { id, text }]
        return next.length > 5 ? next.slice(next.length - 5) : next
      })
      // Auto-evict after 12s so the panel doesn't accumulate stale
      // status lines across a long session.
      window.setTimeout(() => {
        setSlashCommandNotes((prev) => prev.filter((n) => n.id !== id))
      }, 12_000)
    }
    const onOpenDiagnostics = () => setShowContextBreakdown(true)
    window.addEventListener('pole:slash-command-note', onNote)
    window.addEventListener('pole:open-diagnostics', onOpenDiagnostics)
    return () => {
      window.removeEventListener('pole:slash-command-note', onNote)
      window.removeEventListener('pole:open-diagnostics', onOpenDiagnostics)
    }
  }, [])

  const refreshSessionHeader = useCallback(async () => {
    if (!window.electronAPI) return
    try {
      const s = window.electronAPI.session
      let session: SessionSnapshot | null = null
      if (rootPath?.trim() && currentConversationId?.trim()) {
        session = await s.getScoped(rootPath.trim(), currentConversationId.trim())
      } else if (rootPath?.trim()) {
        session = await s.getScoped(rootPath.trim())
      } else {
        session = await s.getCurrent()
      }
      const tasks = session?.tasks?.length ?? 0
      const files = session?.files?.length ?? 0
      const errors = session?.errors?.length ?? 0
      if (tasks > 0 || files > 0 || errors > 0) {
        setSessionState({ tasks, files, errors })
      } else {
        setSessionState(null)
      }
    } catch {
      setSessionState(null)
    }
  }, [rootPath, currentConversationId])

  // Poll session state periodically (getCurrent has no ALS in renderer — use scoped fetch)
  useEffect(() => {
    if (!window.electronAPI) return
    void refreshSessionHeader()
    const interval = setInterval(() => void refreshSessionHeader(), 30000)
    return () => clearInterval(interval)
  }, [refreshSessionHeader])

  useEffect(() => {
    ensureSubAgentGlobalStream()
  }, [])

  // Reset fixed height on window resize so the panel always fills the parent.
  // Uses a ref for aiChatHeight to avoid add/remove listener churn during drag.
  useEffect(() => {
    const onResize = () => {
      if (aiChatHeightRef.current !== null) setAIChatHeight(null)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [setAIChatHeight])

  useEffect(() => {
    if (!isTyping || !spinnerTipsEnabled || spinnerTips.length === 0) return
    const timer = window.setInterval(() => {
      setTipIndex((idx) => (idx + 1) % spinnerTips.length)
    }, 3500)
    return () => window.clearInterval(timer)
  }, [isTyping, spinnerTips.length, spinnerTipsEnabled])

  /** 使用 Pointer Capture，避免卡顿/失焦时漏掉 mouseup 导致拖拽状态悬挂、全局点击失效 */
  const onChatWidthResizePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      e.preventDefault()
      const el = e.currentTarget
      el.setPointerCapture(e.pointerId)
      isResizing.current = true
      startX.current = e.clientX
      startWidth.current = aiChatWidth
      setResizing(true)

      const onMove = (ev: PointerEvent) => {
        if (!isResizing.current) return
        const delta = startX.current - ev.clientX
        setAIChatWidth(startWidth.current + delta)
      }
      const end = (ev: PointerEvent) => {
        try {
          el.releasePointerCapture(ev.pointerId)
        } catch {
          /* already released */
        }
        el.removeEventListener('pointermove', onMove)
        el.removeEventListener('pointerup', end)
        el.removeEventListener('pointercancel', end)
        el.removeEventListener('lostpointercapture', onLostCapture)
        isResizing.current = false
        setResizing(false)
      }
      const onLostCapture = () => {
        el.removeEventListener('pointermove', onMove)
        el.removeEventListener('pointerup', end)
        el.removeEventListener('pointercancel', end)
        el.removeEventListener('lostpointercapture', onLostCapture)
        isResizing.current = false
        setResizing(false)
      }
      el.addEventListener('pointermove', onMove)
      el.addEventListener('pointerup', end)
      el.addEventListener('pointercancel', end)
      el.addEventListener('lostpointercapture', onLostCapture)
    },
    [aiChatWidth, setAIChatWidth],
  )

  const onChatHeightResizePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      e.preventDefault()
      const el = e.currentTarget
      el.setPointerCapture(e.pointerId)
      isVerticalResizing.current = true
      startY.current = e.clientY
      const panelHeight = panelRef.current?.getBoundingClientRect().height || 420
      startHeight.current = aiChatHeight ?? panelHeight
      setVerticalResizing(true)

      const onMove = (ev: PointerEvent) => {
        if (!isVerticalResizing.current) return
        const delta = startY.current - ev.clientY
        setAIChatHeight(startHeight.current + delta)
      }
      const end = (ev: PointerEvent) => {
        try {
          el.releasePointerCapture(ev.pointerId)
        } catch {
          /* already released */
        }
        el.removeEventListener('pointermove', onMove)
        el.removeEventListener('pointerup', end)
        el.removeEventListener('pointercancel', end)
        el.removeEventListener('lostpointercapture', onLostCapture)
        isVerticalResizing.current = false
        setVerticalResizing(false)
      }
      const onLostCapture = () => {
        el.removeEventListener('pointermove', onMove)
        el.removeEventListener('pointerup', end)
        el.removeEventListener('pointercancel', end)
        el.removeEventListener('lostpointercapture', onLostCapture)
        isVerticalResizing.current = false
        setVerticalResizing(false)
      }
      el.addEventListener('pointermove', onMove)
      el.addEventListener('pointerup', end)
      el.addEventListener('pointercancel', end)
      el.addEventListener('lostpointercapture', onLostCapture)
    },
    [aiChatHeight, setAIChatHeight],
  )

  const handleNewChat = async () => {
    await startNewConversation()
  }

  const handleClearContext = async () => {
    if (rootPath?.trim() && currentConversationId?.trim()) {
      await clearConversationContext({
        workspacePath: rootPath.trim(),
        conversationId: currentConversationId.trim(),
      })
    } else {
      await clearConversationContext()
    }
    void getContextState(currentConversationId || undefined)
      .then(setContextState)
      .catch((err: unknown) => {
        console.warn('[ChatPanel] getContextState (post-clear refresh) failed:', err)
      })
    await refreshSessionHeader()
  }

  const handleCancel = () => {
    cancelMessage()
  }

  const handleExportMarkdown = () => {
    const messages = useChatStore.getState().messages
    if (messages.length === 0) return
    const md = formatAsMarkdown({
      title: currentConversationTitle,
      // Skip compact-boundary rows — they're UI-only dividers, not real
      // turns. Exporting them as empty assistant entries would clutter
      // the markdown with blank sections.
      messages: messages
        .filter((m) => m.kind !== 'compact_boundary')
        .map((m) => ({
          role: m.role,
          content: m.content,
          timestamp: m.timestamp,
          toolUses: m.toolUses?.map((tu) => ({ name: tu.name, status: tu.status })),
        })),
    })
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const filename = `${currentConversationTitle.replace(/[^a-zA-Z0-9\u4e00-\u9fff]+/g, '-').slice(0, 30)}-${timestamp}.md`
    downloadMarkdown(md, filename)
  }

  const handleAllowPermission = async (requestId: string) => {
    const pendingRequest = useChatStore.getState().pendingPermissionRequest
    const teamDel = pendingRequest?.teamDelegated
    const dp = pendingRequest?.diffPreview
    if (teamDel) {
      const ok = await respondTeamPermissionRequest({
        teamRequestId: teamDel.teamRequestId,
        behavior: 'allow',
        updatedInput: dp
          ? {
              filePath: dp.filePath,
              file_path: dp.filePath,
              content: dp.modifiedContent,
            }
          : undefined,
      })
      if (ok) useChatStore.setState({ pendingPermissionRequest: null })
      return
    }
    if (dp) {
      await respondToPermissionRequest({
        requestId,
        behavior: 'allow',
        updatedInput: {
          filePath: dp.filePath,
          file_path: dp.filePath,
          content: dp.modifiedContent,
        },
      })
    } else {
      await respondToPermissionRequest({ requestId, behavior: 'allow' })
    }
  }

  const handleDenyPermission = async (requestId: string) => {
    const teamDel = useChatStore.getState().pendingPermissionRequest?.teamDelegated
    if (teamDel && teamDel.teamRequestId === requestId) {
      const ok = await respondTeamPermissionRequest({
        teamRequestId: teamDel.teamRequestId,
        behavior: 'deny',
      })
      if (ok) useChatStore.setState({ pendingPermissionRequest: null })
      return
    }
    await respondToPermissionRequest({ requestId, behavior: 'deny' })
  }

  const jumpToMessage = useCallback((messageId: string) => {
    listRef.current?.jumpToMessage(messageId)
  }, [])
  const showInlinePermissionPrompt = Boolean(
    pendingPermissionRequest && !pendingPermissionRequest.diffPreview,
  )
  const showInlineAskUserQuestion = Boolean(pendingAskUserQuestion)
  const showInlineTeamPlanApproval = Boolean(pendingTeamPlanApproval)
  const showInlinePlanApproval = Boolean(pendingPlanApproval)
  const showInlinePrompts =
    showInlinePermissionPrompt ||
    showInlineAskUserQuestion ||
    showInlineTeamPlanApproval ||
    showInlinePlanApproval

  const openCurrentPlan = useCallback(async () => {
    if (!planningState?.planFilePath) return
    const fileResult = await window.electronAPI.fs.readFile(planningState.planFilePath)
    if (!fileResult.success || typeof fileResult.content !== 'string') return
    const root = useWorkspaceStore.getState().rootPath
    const relativePath = toRelativePath(planningState.planFilePath, root)
    const fileState = useFileStore.getState()
    const existing = fileState.tabs.find((t) => normalizePath(t.path) === normalizePath(relativePath))
    if (existing) {
      fileState.setActiveTab(existing.id)
      return
    }
    fileState.openFile({
      id: `plan-${Date.now()}`,
      name: relativePath.split('/').pop() || relativePath,
      path: relativePath,
      language: 'markdown',
      content: fileResult.content,
      isModified: false,
    })
  }, [planningState?.planFilePath])

  return (
    <div ref={panelRef} className="chat-panel" style={{ width: aiChatWidth }}>
      <div
        className={`chat-resize-handle ${resizing ? 'active' : ''}`}
        onPointerDown={onChatWidthResizePointerDown}
      />
      <div
        className={`chat-resize-handle-y ${verticalResizing ? 'active' : ''}`}
        onPointerDown={onChatHeightResizePointerDown}
      />
      <PreflightDenialToast />
      <CompactionToast />
      <div className="chat-panel-header">
        <span className="chat-panel-title">{currentConversationTitle}</span>
        {backgroundStreamCount > 0 && (
          <span
            className="chat-panel-bg-streams-badge"
            title={t.chat.backgroundStreamsTitle(backgroundStreamCount)}
          >
            <span className="chat-panel-bg-streams-dot" />
            {t.chat.backgroundRunning(backgroundStreamCount)}
          </span>
        )}
        <div className="chat-panel-header-actions" style={{ marginLeft: 'auto' }}>
          <OrchestrationTimeline />
          <ArtifactDrawer />
          <SessionMemoryIndicator />
        {contextState && (
          <ContextMeter
            contextState={contextState}
            showContextBreakdown={showContextBreakdown}
            setShowContextBreakdown={setShowContextBreakdown}
            currentConversationId={currentConversationId}
          />
        )}
          {sessionState && (sessionState.tasks > 0 || sessionState.files > 0 || sessionState.errors > 0) && (
            <span
              className="chat-session-indicator"
              title={t.chat.sessionIndicatorTitle(sessionState.tasks, sessionState.files, sessionState.errors)}
            >
              {t.chat.sessionIndicator(sessionState.tasks + sessionState.files)}
            </span>
          )}
          {planningState && planningState.total > 0 && (
            <button
              className="chat-plan-indicator"
              title={t.chat.planIndicatorTitle(planningState.completed, planningState.total, planningState.planFilePath)}
              onClick={openCurrentPlan}
            >
              {t.chat.planIndicator(planningState.completed, planningState.total)}
            </button>
          )}
          <button
            className="chat-panel-action"
            data-reasoning-timeline-toggle
            onClick={() => setShowReasoningTimeline((v) => !v)}
            title={t.chat.reasoningTimelineTitle}
            disabled={messagesLength === 0}
          >
            <Brain size={14} />
          </button>
          <button
            className="chat-panel-action"
            data-conversation-list-toggle
            onClick={() => setShowConversationList(!showConversationList)}
            title={t.chat.conversationHistory}
          >
            <History size={14} />
          </button>
          <button
            className="chat-panel-action"
            onClick={handleExportMarkdown}
            disabled={messagesLength === 0}
            title={t.chat.exportMarkdown}
          >
            <Download size={14} />
          </button>
          <button
            className="chat-panel-action"
            type="button"
            onClick={() => void handleClearContext()}
            title={t.chat.clearContextTitle}
          >
            <Eraser size={14} />
          </button>
          <button
            className="chat-panel-action"
            onClick={handleNewChat}
            title={t.chat.newConversation}
          >
            <Plus size={14} />
          </button>
          <button
            className="chat-panel-action"
            onClick={handleCancel}
            disabled={!isTyping}
            title={t.chat.stopGenerating}
          >
            <Square size={14} />
          </button>
          <button
            className="chat-panel-action"
            onClick={() => setShowHistorySearch(true)}
            title={t.chat.searchHistory}
          >
            <Search size={14} />
          </button>
          <button
            className="chat-panel-action"
            onClick={() => setShowSettings(true)}
            title={t.chat.settings}
          >
            <Settings size={14} />
          </button>
          <button
            className="chat-panel-close"
            onClick={useLayoutStore.getState().toggleAIChat}
          >
            <X size={16} />
          </button>
        </div>
        {showReasoningTimeline && (
          <ReasoningTimeline
            onJumpToMessage={(id) => jumpToMessage(id)}
            onClose={() => setShowReasoningTimeline(false)}
          />
        )}
        {showConversationList && (
          <ConversationList
            currentId={currentConversationId}
            onSelect={(convId) => {
              loadConversationById(convId)
              setShowConversationList(false)
            }}
            onRename={(convId, newTitle) => {
              renameConversation(convId, newTitle)
            }}
            onDelete={async (convId) => {
              await deleteConversationById(convId)
            }}
            onBatchDelete={async (ids) => {
              for (const id of ids) {
                await deleteConversationById(id)
              }
            }}
            onClose={() => setShowConversationList(false)}
          />
        )}
      </div>
      {/* BundleContextBar 已移除:bundle 信息由顶部 WorkspaceTabBar 承担,
          ChatPanel 只关心对话本身,不再重复显示工作包名称。 */}
      {/* Phase G — host-side slash-command feedback (e.g. /context renders
          the formatted analysis here; /memory confirms a write).
          Lives outside the scroll area so notes don't move the
          transcript view when they appear/expire. */}
      {slashCommandNotes.length > 0 && (
        <div className="chat-slash-command-notes" role="status" aria-live="polite">
          {slashCommandNotes.map((note) => (
            <pre key={note.id} className="chat-slash-command-note">
              {note.text}
            </pre>
          ))}
        </div>
      )}
      {/* 放在滚动区外：避免输出中工具栏/提示高度变化顶动 scrollTop，造成「已滚到底却往上窜」 */}
      {isTyping && (
        <div className="chat-streaming-chrome">
          <StreamingModeBar
            permissionMode={permissionMode}
            diffPermissionMode={diffPermissionMode}
          />
          {spinnerTipsEnabled && (
            <div className="chat-spinner-tip chat-spinner-tip--streaming">{spinnerTips[tipIndex] ?? ''}</div>
          )}
        </div>
      )}
      <ChatMessageList
        ref={listRef}
        showThinkingSummaries={showThinkingSummaries}
        recalledMemories={recalledMemories}
        thinkingAutoCollapseThreshold={thinkingAutoCollapseThreshold}
        prefersReducedMotion={prefersReducedMotion}
        enableTools={enableTools}
        promptSuggestionEnabled={promptSuggestionEnabled}
        suggestions={suggestions}
        onSuggestionClick={setInputText}
      />
      {/* Layer-E recovery affordance — only while the loop is idle so a
          just-finished/aborted turn can be resumed. The banner self-filters
          to recoverable reasons (returns null otherwise). */}
      {!isTyping && latestTerminationReason && (
        <TerminationRecoveryBanner reason={latestTerminationReason} />
      )}
      {/* P1-6 — auto-recalled workspace/attachment context citation. */}
      <RetrievalCitation />
      <TodoPanel />
      <FileChangeList />
      {showInlinePrompts && (
        <div className="chat-inline-prompts">
          {showInlinePermissionPrompt && pendingPermissionRequest && (
            <PermissionPrompt
              request={pendingPermissionRequest}
              onAllow={handleAllowPermission}
              onDeny={handleDenyPermission}
            />
          )}
          {showInlineTeamPlanApproval && pendingTeamPlanApproval && (
            <TeamPlanApprovalCard request={pendingTeamPlanApproval} />
          )}
          {showInlinePlanApproval && pendingPlanApproval && (
            <PlanApprovalCard request={pendingPlanApproval} />
          )}
          {pendingAskUserQuestion && (
            <AskUserQuestionBlock
              requestId={pendingAskUserQuestion.requestId}
              questions={pendingAskUserQuestion.questions}
              status="pending"
              previewFormat={pendingAskUserQuestion.previewFormat}
            />
          )}
        </div>
      )}
      <ChatInput />
      <HistorySearchDialog
        open={showHistorySearch}
        onClose={() => setShowHistorySearch(false)}
        onSelectMessage={jumpToMessage}
        onLoadConversation={(convId) => loadConversationById(convId)}
        workspacePath={rootPath || undefined}
      />
    </div>
  )
}
