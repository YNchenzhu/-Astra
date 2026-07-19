import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react'
import { ArrowUp, ChevronDown, Sparkles, Settings, Star, Square, Shield, ShieldCheck, Paperclip, FileText, X, Image as ImageIcon, Plus, Loader2, AlertCircle } from 'lucide-react'
import { useChatStore, CHAT_MODE_OPTIONS } from '../../stores/useChatStore'
import { useSettingsStore, MODELS_BY_PROVIDER } from '../../stores/useSettingsStore'
import { SkillPopup } from './SkillPopup'
import type { SkillItem } from './SkillPopup'
import { SlashCommandPopup } from './SlashCommandPopup'
import {
  filterSlashCommands,
  parseSlashCommandInput,
  type SlashCommandDefinition,
  type SlashCommandHandlerContext,
} from '../../data/slashCommands'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'
import { useLayoutStore } from '../../stores/useLayoutStore'
import type { Attachment } from '../../types/tool'
import { AttachmentPreview } from './AttachmentPreview'
import { pickAttachmentIcon, renderAttachmentSubtitle } from './AttachmentBody'
import { reportUserActionError } from '../../utils/reportUserActionError'
import { useConfirmDialog } from '../common/ConfirmDialog'
import './ChatInput.css'
import { extractLargestImageDataUrlFromHtml } from '../../utils/extractClipboardImageFromHtml'
import { AttachCurrentFileButton } from './chatInput/AttachCurrentFileButton'
import { addPastedImageAttachment, ingestFileAttachment } from './chatInput/ingestFileAttachment'
import { noteChatInputActivity } from '../../services/editorFocusGuard'
import { useT } from '../../i18n'
import type { ChatInteractionMode } from '../../stores/useChatStore'

const ChatInputComponent: React.FC = () => {
  // State selectors — isolate re-renders to fields that change frequently.
  // Previously this component used whole-store destructuring, which caused
  // a re-render (and IME focus loss) on every streaming delta / messages
  // update because Zustand fires for any slice change.
  const inputText = useChatStore((s) => s.inputText)
  const isTyping = useChatStore((s) => s.isTyping)
  const referencedFiles = useChatStore((s) => s.referencedFiles)
  const pendingAttachments = useChatStore((s) => s.pendingAttachments)
  const permissionMode = useChatStore((s) => s.permissionMode)
  const diffPermissionMode = useChatStore((s) => s.diffPermissionMode)
  const chatInteractionMode = useChatStore((s) => s.chatInteractionMode)

  // Action selectors — Zustand actions are stable references, so each
  // individual selector only triggers a re-render if the action identity
  // changes (which it never should in normal operation).
  const setInputText = useChatStore((s) => s.setInputText)
  const sendMessage = useChatStore((s) => s.sendMessage)
  const setEnableTools = useChatStore((s) => s.setEnableTools)
  const setPermissionMode = useChatStore((s) => s.setPermissionMode)
  const setDiffPermissionMode = useChatStore((s) => s.setDiffPermissionMode)
  const cancelMessage = useChatStore((s) => s.cancelMessage)
  const setChatInteractionMode = useChatStore((s) => s.setChatInteractionMode)
  const currentConversationId = useChatStore((s) => s.currentConversationId)
  const addAttachment = useChatStore((s) => s.addAttachment)
  const removeAttachment = useChatStore((s) => s.removeAttachment)
  const updateAttachment = useChatStore((s) => s.updateAttachment)

  // Settings store — same per-field selector treatment
  const providerId = useSettingsStore((s) => s.providerId)
  const model = useSettingsStore((s) => s.model)
  const apiConfigs = useSettingsStore((s) => s.apiConfigs)
  const activeConfigId = useSettingsStore((s) => s.activeConfigId)
  const setActiveConfig = useSettingsStore((s) => s.setActiveConfig)
  const clearActiveConfig = useSettingsStore((s) => s.clearActiveConfig)
  const setManualModel = useSettingsStore((s) => s.setManualModel)
  const setShowSettings = useSettingsStore((s) => s.setShowSettings)
  const skipDangerousModePermissionPrompt = useSettingsStore(
    (s) => s.skipDangerousModePermissionPrompt,
  )

  // Promise-based confirm dialog. Replaces the historical `window.confirm`
  // which on Windows + Chinese IME detached the textarea's IMM channel
  // and, when combined with a busy main thread after startup, left the
  // chat input "visually focused but key-swallowing" for up to ~60 s.
  // `useConfirmDialog` renders a React portal-hosted modal — no native
  // synchronous block of the renderer event loop, so queued IPC can
  // still drain and the IME stays attached across the open/close cycle.
  const { dialog: dangerousDiffConfirmDialog, askConfirm } = useConfirmDialog()
  const t = useT()

  const confirmSwitchToBypassDiffMode = useCallback(async (): Promise<boolean> => {
    if (skipDangerousModePermissionPrompt) return true
    if (diffPermissionMode === 'bypassPermissions') return true
    return askConfirm({
      title: t.chat.switchAutoWriteTitle,
      message: t.chat.switchAutoWriteMessage,
      confirmText: t.chat.switchConfirm,
      cancelText: t.chat.switchCancel,
      variant: 'danger',
    })
  }, [skipDangerousModePermissionPrompt, diffPermissionMode, askConfirm, t])
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  /**
   * Return focus to the chat textarea on the next tick. Used after any
   * action that steals focus away (native `window.alert` / `window.confirm`,
   * an `aria-modal` overlay closing, etc.). Without this the textarea stays
   * "visually focused" (caret blinking) but the underlying Chinese IME
   * (Pinyin) loses its attachment — pressing a key does nothing visible
   * until the user clicks the textarea again. Deferring to a `setTimeout(0)`
   * gives React time to commit the state update that closed the dropdown /
   * modal, so the `.focus()` call lands on the surviving node.
   */
  const focusTextareaSoon = useCallback((): void => {
    requestAnimationFrame(() => {
      try {
        textareaRef.current?.focus()
      } catch {
        /* element unmounted — no-op */
      }
    })
  }, [])

  const [showModelPicker, setShowModelPicker] = useState(false)
  const modelDropdownRef = useRef<HTMLDivElement>(null)
  const toolsDropdownWrapperRef = useRef<HTMLDivElement>(null)
  const toolsDropdownRef = useRef<HTMLDivElement>(null)
  const [showToolsMenu, setShowToolsMenu] = useState(false)
  const [toolsDropdownDirection, setToolsDropdownDirection] = useState<'down' | 'up'>('up')
  const [refFilesExpanded, setRefFilesExpanded] = useState(true)
  const [showModePicker, setShowModePicker] = useState(false)
  const modeDropdownWrapperRef = useRef<HTMLDivElement>(null)
  const inputWrapperRef = useRef<HTMLDivElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)

  const currentModels = MODELS_BY_PROVIDER[providerId] || []
  const currentModel = currentModels.find((m) => m.id === model)
  const activeConfig = apiConfigs.find((c) => c.id === activeConfigId)
  const isManualMode = !activeConfigId

  // Resize textarea asynchronously on the next animation frame so rapid
  // typing or streaming store updates don't block the renderer event loop
  // and detach the IME composition session.
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    const rafId = requestAnimationFrame(() => {
      ta.style.height = 'auto'
      ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'
    })
    return () => cancelAnimationFrame(rafId)
  }, [inputText])

  useEffect(() => {
    const handleClick = () => {
      setShowModelPicker(false)
      setShowToolsMenu(false)
      setShowModePicker(false)
    }
    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [])

  // Cross-component refocus hook. Focus-stealing actions that live OUTSIDE this
  // component — e.g. the TitleBar bundle export/import which opens a native
  // `dialog.showSaveDialog` — detach the Chinese IME from the textarea (see
  // `focusTextareaSoon`). They dispatch `pole:refocus-chat-input` when done so
  // we can re-attach focus without each caller needing the textarea ref.
  useEffect(() => {
    const onRefocus = () => focusTextareaSoon()
    window.addEventListener('pole:refocus-chat-input', onRefocus)
    return () => window.removeEventListener('pole:refocus-chat-input', onRefocus)
  }, [focusTextareaSoon])

  // Main Agent always has tool capability; no global tool-permission toggle anymore.
  useEffect(() => {
    if (permissionMode === 'bypassPermissions') {
      setPermissionMode('default')
    }
    setEnableTools(true)
  }, [permissionMode, setEnableTools, setPermissionMode])

  const computeToolsDropdownDirection = useCallback(() => {
    if (!toolsDropdownWrapperRef.current) return 'up' as const
    const rect = toolsDropdownWrapperRef.current.getBoundingClientRect()
    const dropdownHeight = 180
    return rect.top < dropdownHeight ? 'down' as const : 'up' as const
  }, [])

  const [isDragOver, setIsDragOver] = useState(false)
  const dragCounterRef = useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [previewAttachment, setPreviewAttachment] = useState<Attachment | null>(null)

  /**
   * Route every drop/paste/picker file through the main-process ingest pipeline
   * (`window.electronAPI.attachments.ingest` / `ingestBuffer`). That pipeline
   * produces sha256 (so the attachment RAG namespace + dedupe cache works),
   * parses Office / PDF / CSV / ipynb into text + page-image fallbacks, and
   * keeps the UI preview strictly equal to what the serializer sends to the
   * model. We insert a `status:'processing'` placeholder synchronously so the
   * bubble appears immediately, then patch it via `updateAttachment` once the
   * async ingest resolves (or flip it to `status:'error'` on failure).
   */
  const handleFileAsAttachment = useCallback(
    (file: File) => ingestFileAttachment(file, { addAttachment, updateAttachment }),
    [addAttachment, updateAttachment],
  )

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    // Ignore drags that carry no files (e.g., plain text selection) so the
    // overlay doesn't spuriously appear while the user drags text into the
    // textarea for replacement.
    const types = e.dataTransfer?.types
    const hasFiles = !!types && Array.from(types).includes('Files')
    if (!hasFiles) return
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current += 1
    setIsDragOver(true)
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    const types = e.dataTransfer?.types
    const hasFiles = !!types && Array.from(types).includes('Files')
    if (!hasFiles) return
    e.preventDefault()
    e.stopPropagation()
    // Show the correct "+copy" cursor instead of the default "no-drop".
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    // Use a ref counter so hops between nested children (textarea, toolbar,
    // bubble chips) don't flicker the overlay off-and-on each pointer move.
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1)
    if (dragCounterRef.current === 0) setIsDragOver(false)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current = 0
    setIsDragOver(false)

    const files = e.dataTransfer.files
    for (let i = 0; i < files.length; i++) {
      void handleFileAsAttachment(files[i])
    }
  }, [handleFileAsAttachment])

  const handlePaste = useCallback(
    async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const cd = e.clipboardData
      if (!cd) return

      // Pass 1: collect any file-kind clipboard items (images copied from
      // browser, screenshots, AND non-image files like PDFs/docx copied from
      // the file manager). Previously only "looks like image" files were
      // consumed; non-image files were silently dropped on the floor.
      const items = cd.items
      const collectedFiles: File[] = []
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        if (item.kind !== 'file') continue
        const file = item.getAsFile()
        if (!file || file.size === 0) continue
        collectedFiles.push(file)
      }
      if (collectedFiles.length > 0) {
        e.preventDefault()
        for (const f of collectedFiles) {
          void handleFileAsAttachment(f)
        }
        return
      }

      const html = cd.getData('text/html')
      if (html) {
        const fromHtml = extractLargestImageDataUrlFromHtml(html)
        if (fromHtml) {
          e.preventDefault()
          void addPastedImageAttachment(
            {
              name: 'pasted-image.png',
              base64: fromHtml.base64,
              mediaType: fromHtml.mediaType,
              size: Math.ceil((fromHtml.base64.length * 3) / 4),
            },
            addAttachment,
          )
          return
        }
      }

      const plain = cd.getData('text/plain') ?? ''
      if (plain.trim() !== '') return

      const htmlRaw = cd.getData('text/html') ?? ''
      if (htmlRaw.replace(/\s/g, '').length > 24) {
        return
      }

      const readPng = window.electronAPI?.clipboard?.readPngImage
      if (!readPng) return

      e.preventDefault()
      const r = await readPng()
      if (r.ok && r.base64) {
        void addPastedImageAttachment(
          { name: 'clipboard.png', base64: r.base64, mediaType: r.mediaType, size: r.size },
          addAttachment,
        )
      }
    },
    [addAttachment, handleFileAsAttachment],
  )

  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files) return
    for (let i = 0; i < files.length; i++) {
      void handleFileAsAttachment(files[i])
    }
    e.target.value = ''
  }, [handleFileAsAttachment])

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const [skillDismissedAt, setSkillDismissedAt] = useState<string | null>(null)
  const skillPopupState = useMemo(() => {
    const triggerMatch = inputText.match(/^([/@])([\w-]*)$/)
    if (triggerMatch) {
      return { show: true, trigger: triggerMatch[1] as '/' | '@', query: triggerMatch[2] }
    }
    return { show: false, trigger: '/' as const, query: '' }
  }, [inputText])
  // Slash-command popup wins when the leading `/...` matches a host
  // command id or its description (e.g. `/co` → context+compact). Skill
  // popup keeps showing when no host commands match — preserving the
  // legacy `/skill-name` flow.
  const slashCommandMatches = useMemo(() => {
    if (skillPopupState.trigger !== '/' || !skillPopupState.show) return []
    return filterSlashCommands(skillPopupState.query)
  }, [skillPopupState.show, skillPopupState.trigger, skillPopupState.query])
  const showSlashCommandPopup =
    skillPopupState.show &&
    skillPopupState.trigger === '/' &&
    slashCommandMatches.length > 0 &&
    skillDismissedAt !== inputText
  const showSkillPopup =
    skillPopupState.show &&
    skillDismissedAt !== inputText &&
    !showSlashCommandPopup

  const handleSkillSelect = useCallback((skill: SkillItem) => {
    const newText = `${skillPopupState.trigger}${skill.name} `
    setInputText(newText)
    textareaRef.current?.focus()
  }, [setInputText, skillPopupState.trigger])

  const handleSkillClose = useCallback(() => {
    setSkillDismissedAt(inputText)
  }, [inputText])

  // Phase G — slash command wiring.
  const clearConversationContext = useChatStore((s) => s.clearConversationContext)
  const rootPath = useWorkspaceStore((s) => s.rootPath)
  const slashCtx = useMemo<SlashCommandHandlerContext>(() => {
    return {
      workspacePath: rootPath ?? undefined,
      conversationId: currentConversationId ?? undefined,
      ports: {
        openDiagnosticsView: () => {
          // Best-effort: open the context-breakdown popover in ChatPanel
          // header. The renderer-side store doesn't expose a direct
          // toggle, so we dispatch a custom event the ChatPanel can
          // listen to (kept loose-coupled). Falls back to a console hint
          // if the chat panel hasn't subscribed yet.
          try {
            window.dispatchEvent(new CustomEvent('pole:open-diagnostics'))
          } catch (e) {
            console.warn('[ChatInput] failed to open diagnostics view:', e)
          }
        },
        clearConversation: async () => {
          await clearConversationContext()
        },
        triggerCompact: async () => {
          try {
            const api = window.electronAPI?.context
            if (api?.reset && currentConversationId) {
              await api.reset({ conversationId: currentConversationId })
            }
          } catch (e) {
            console.warn('[ChatInput] compact trigger failed:', e)
          }
        },
        writeUserMemory: async (body: string) => {
          try {
            const api = window.electronAPI?.memory
            if (!api?.create) return { error: 'memory IPC unavailable' }
            const result = await api.create({
              name: `manual-${new Date().toISOString().slice(0, 10)}`,
              description: body.slice(0, 120),
              type: 'user',
              scope: 'user',
              content: body,
            })
            const filename =
              (result as { filename?: string } | undefined)?.filename ?? undefined
            return filename ? { filename } : {}
          } catch (e) {
            return { error: e instanceof Error ? e.message : String(e) }
          }
        },
        renderContextReport: async () => {
          try {
            const api = window.electronAPI?.context
            // Prefer the formatted text channel — uses the main-process
            // `formatContextAnalysis` so the renderer doesn't have to
            // re-implement the breakdown markdown. Falls back to the
            // bare summary if the new IPC is missing (older builds).
            if (api?.analyzeLiveFormatted) {
              const md = await api.analyzeLiveFormatted()
              if (md.trim()) return md
            }
            if (api?.analyzeLive) {
              const live = await api.analyzeLive()
              if (live && typeof live === 'object') {
                const total = (live as { totalUsedTokens?: number }).totalUsedTokens ?? 0
                const pct = (live as { usagePercent?: number }).usagePercent ?? 0
                return `Context usage: ${total.toLocaleString()} tokens (${pct.toFixed(1)}% of window).`
              }
            }
          } catch (e) {
            console.warn('[ChatInput] context report failed:', e)
          }
          return 'Context report is unavailable.'
        },
        appendInlineNote: (text: string) => {
          // Surface as system event the renderer can pick up; reuse the
          // existing `tool_message` channel by writing to the chat store
          // via `setInputText` is wrong, so we just dispatch a custom
          // event that ChatPanel can render as a transient note.
          try {
            window.dispatchEvent(
              new CustomEvent('pole:slash-command-note', { detail: { text } }),
            )
          } catch (e) {
            console.warn('[ChatInput] inline note dispatch failed:', e)
          }
        },
      },
    }
  }, [rootPath, currentConversationId, clearConversationContext])

  const handleSlashCommandSelect = useCallback(
    async (command: SlashCommandDefinition) => {
      const parsed = parseSlashCommandInput(inputText)
      const args = parsed?.args ?? ''
      setInputText('')
      try {
        await command.run(args, slashCtx)
      } catch (e) {
        console.warn(`[ChatInput] /${command.id} failed:`, e)
      }
      textareaRef.current?.focus()
    },
    [inputText, setInputText, slashCtx],
  )

  const canSend = inputText.trim().length > 0 || pendingAttachments.length > 0

  // Contract audit (2026-07) — background sub-agents can outlive the main
  // turn (isTyping false), at which point NO control in the input row covers
  // them: the pause button is gated on isTyping and the stop button is gone.
  // Poll the ActiveAgentRegistry at a low rate and surface a small indicator
  // that opens the Running Agents panel (inspect / abort) whenever this
  // conversation still has running background agents after the turn ended.
  const [backgroundAgentCount, setBackgroundAgentCount] = useState(0)
  const setRunningAgentsPanelVisible = useLayoutStore((s) => s.setRunningAgentsPanelVisible)
  useEffect(() => {
    const api = window.electronAPI?.agents
    if (!api?.listActive || !currentConversationId) {
      // Deferred reset — calling setState synchronously in the effect body
      // triggers a cascading render (react-hooks/set-state-in-effect).
      const resetTimer = setTimeout(() => setBackgroundAgentCount(0), 0)
      return () => clearTimeout(resetTimer)
    }
    let cancelled = false
    const poll = async () => {
      try {
        const res = await api.listActive!()
        if (cancelled) return
        const count = res.agents.filter(
          (a) =>
            a.status === 'running' &&
            a.background === true &&
            (!a.streamConversationId || a.streamConversationId === currentConversationId),
        ).length
        setBackgroundAgentCount(count)
      } catch {
        /* registry unavailable — keep last known count; next tick retries */
      }
    }
    void poll()
    const timer = setInterval(() => void poll(), 3000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [currentConversationId])
  const showBackgroundAgentsIndicator = !isTyping && backgroundAgentCount > 0

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // SlashCommandPopup takes precedence when active.
    if (showSlashCommandPopup && ['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(e.key)) {
      if (e.key === 'Escape') {
        setSkillDismissedAt(inputText)
        e.preventDefault()
      }
      return
    }
    // Let SkillPopup handle arrow/enter/escape when visible
    if (showSkillPopup && ['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(e.key)) {
      if (e.key === 'Escape') {
        setSkillDismissedAt(inputText)
        e.preventDefault()
      }
      return
    }

    // !e.nativeEvent.isComposing: don't send while an IME composition is active
    // (e.g. pressing Enter to confirm a Chinese candidate) — that Enter belongs
    // to the IME, not to message send.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      // 与发送按钮一致：输出中只允许停止，避免第二路 send 覆盖 pendingAssistant 导致气泡错位/卡住
      if (isTyping || !canSend) return
      sendMessage().catch((error) => reportUserActionError('发送消息', error))
    }
  }

  const handleConfigSelect = (configId: string) => {
    setActiveConfig(configId)
    setShowModelPicker(false)
  }

  const handleManualModelSelect = (modelId: string) => {
    setManualModel(modelId)
    setShowModelPicker(false)
  }

  const handleClearActive = (e: React.MouseEvent) => {
    e.stopPropagation()
    clearActiveConfig()
    setShowModelPicker(false)
  }

  const handleOpenSettings = (e: React.MouseEvent) => {
    e.stopPropagation()
    setShowModelPicker(false)
    setShowSettings(true)
  }

  const displayName = activeConfig
    ? activeConfig.name
    : currentModel?.name || t.chat.selectModel

  const currentMode = CHAT_MODE_OPTIONS.find((m) => m.id === chatInteractionMode) ?? CHAT_MODE_OPTIONS[0]
  const modeHint = (id: ChatInteractionMode): string =>
    id === 'plan' ? t.chat.modeHintPlan : id === 'ask' ? t.chat.modeHintAsk : t.chat.modeHintAgent

  const handleModeSelect = (mode: (typeof CHAT_MODE_OPTIONS)[number]['id']) => {
    setChatInteractionMode(mode)
    setShowModePicker(false)
  }

  const getFileName = (filePath: string) => {
    const parts = filePath.replace(/\\/g, '/').split('/')
    return parts[parts.length - 1] || filePath
  }

  return (
    <div className="chat-input-container">
      {referencedFiles.length > 0 && (
        <div className="chat-ref-card">
          <button
            className="chat-ref-card-header"
            onClick={() => setRefFilesExpanded(!refFilesExpanded)}
          >
            <div className="chat-ref-card-header-left">
              <Paperclip size={12} />
              <span>{t.chat.referencedFiles}</span>
              <span className="chat-ref-card-count">{referencedFiles.length}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span
                className="chat-ref-card-clear"
                role="button"
                title={t.chat.clearAllRefs}
                onClick={(e) => { e.stopPropagation(); useChatStore.getState().clearReferencedFiles() }}
              >
                <X size={11} />
              </span>
              <ChevronDown
                size={12}
                className={`chat-ref-card-chevron ${refFilesExpanded ? 'expanded' : ''}`}
              />
            </div>
          </button>
          {refFilesExpanded && (
            <div className="chat-ref-card-body">
              {referencedFiles.map((file) => (
                <span key={file} className="chat-ref-tag">
                  <FileText size={11} className="chat-ref-tag-icon" />
                  <span className="chat-ref-tag-name" title={file}>{getFileName(file)}</span>
                  <button className="chat-ref-remove" onClick={() => useChatStore.getState().toggleReferencedFile(file)}>
                    <X size={10} />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <div
        className={`chat-input-wrapper ${isDragOver ? 'drag-over' : ''}`}
        ref={inputWrapperRef}
        onDragOver={handleDragOver}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {isDragOver && (
          <div className="chat-drop-overlay">
            <ImageIcon size={24} />
            <span>{t.chat.dropFilesHere}</span>
          </div>
        )}
        {showSlashCommandPopup && (
          <SlashCommandPopup
            query={skillPopupState.query}
            onSelect={handleSlashCommandSelect}
            onClose={handleSkillClose}
          />
        )}
        {showSkillPopup && (
          <SkillPopup
            query={skillPopupState.query}
            trigger={skillPopupState.trigger}
            onSelect={handleSkillSelect}
            onClose={handleSkillClose}
          />
        )}
        {/* Attachment preview area — bubbles are clickable to open the
            rich preview modal so "what the AI receives" stays verifiable.
            Non-image bubbles carry a status pip (spinning/error) plus a
            subtitle (page count, sheet count, truncated flag, etc.). */}
        {pendingAttachments.length > 0 && (
          <div className="chat-attachments-preview">
            {pendingAttachments.map((att, idx) => {
              const isFile = att.type === 'file'
              const isProcessing = isFile && att.status === 'processing'
              const isError = isFile && att.status === 'error'
              const FileKindIcon = pickAttachmentIcon(att)
              const subtitle = renderAttachmentSubtitle(att)
              const canPreview = !isProcessing
              const title = isError
                ? (att.type === 'file' && att.error) || t.chat.attachmentParseFailed
                : subtitle
                  ? `${att.name} · ${subtitle}`
                  : att.name
              // 2026-07 审计修复:key 从纯 idx 改为身份键 —— 删除中间项时
              // 纯索引 key 会让 React 错绑相邻 chip 的 DOM/状态。文件类的
              // path(placeholder 或真实路径)本身唯一;图片优先 sha256,
              // 无 sha 时用 base64 尾部切片(内容指纹,防两张同名同大小的
              // 粘贴图撞键;重复项本身已在 addAttachment 层去重)。
              const identity = isFile
                ? att.path
                : (att.sha256 ?? `${att.name}:${att.size}:${att.base64.slice(-24)}`)
              return (
                <div
                  key={identity}
                  className={`chat-attachment-item ${canPreview ? 'clickable' : ''} ${isError ? 'error' : ''}`}
                  title={title}
                  onClick={() => { if (canPreview) setPreviewAttachment(att) }}
                  role={canPreview ? 'button' : undefined}
                >
                  {att.type === 'image' ? (
                    <img
                      src={`data:${att.mediaType};base64,${att.base64}`}
                      alt={att.name}
                      className="chat-attachment-thumb"
                    />
                  ) : (
                    <div className="chat-attachment-file-icon">
                      {isProcessing ? (
                        <Loader2 size={14} className="chat-attachment-spin" />
                      ) : isError ? (
                        <AlertCircle size={14} className="chat-attachment-error-icon" />
                      ) : (
                        <FileKindIcon size={16} />
                      )}
                    </div>
                  )}
                  <div className="chat-attachment-text">
                    <span className="chat-attachment-name">{att.name}</span>
                    {subtitle && !isError && (
                      <span className="chat-attachment-sub">{subtitle}</span>
                    )}
                    {isError && (
                      <span className="chat-attachment-sub chat-attachment-sub-error">{t.chat.attachmentParseFailed}</span>
                    )}
                    {isProcessing && (
                      <span className="chat-attachment-sub">{t.chat.attachmentParsing}</span>
                    )}
                  </div>
                  <button
                    className="chat-attachment-remove"
                    title={t.chat.removeAttachment}
                    onClick={(e) => { e.stopPropagation(); removeAttachment(idx) }}
                  >
                    <X size={10} />
                  </button>
                </div>
              )
            })}
          </div>
        )}
        <div className="chat-input-main-row">
          <textarea
            ref={textareaRef}
            className="chat-input"
            placeholder={
              chatInteractionMode === 'plan'
                ? t.chat.placeholderPlan
                : chatInteractionMode === 'ask'
                  ? t.chat.placeholderAsk
                  : t.chat.placeholderAgent
            }
            value={inputText}
            onChange={(e) => {
              noteChatInputActivity()
              setInputText(e.target.value)
            }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            rows={1}
            enterKeyHint="send"
          />
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,.pdf,.docx,.doc,.xlsx,.xls,.pptx,.ppt,.csv,.tsv,.ipynb,.rtf,.log,.txt,.md,.yaml,.yml,.xml,.html,.json,.ts,.tsx,.js,.jsx,.py,.go,.rs,.java,.c,.cpp,.h,.css"
            style={{ display: 'none' }}
            onChange={handleFileInputChange}
          />
        </div>

        {/* 底部工具栏 - 参照 the IDE 设计 */}
        <div className="chat-input-toolbar" ref={toolbarRef}>
        <div className="chat-toolbar-left">
          <button
            type="button"
            className="chat-attach-btn"
            onClick={openFilePicker}
            title={t.chat.addAttachment}
          >
            <Plus size={13} />
          </button>
          <AttachCurrentFileButton />
          <div className="chat-model-selector">
            <button
              className="chat-model-btn"
              onClick={(e) => { e.stopPropagation(); setShowModelPicker(!showModelPicker) }}
            >
              {activeConfig ? <Star size={12} className="chat-config-star" /> : <Sparkles size={12} />}
              <span className="chat-model-name">{displayName}</span>
              <ChevronDown size={12} />
            </button>

            {showModelPicker && (
              <div className="chat-model-dropdown" ref={modelDropdownRef}>
                {/* Saved API Configs */}
                {apiConfigs.length > 0 && (
                  <>
                    <div className="chat-dropdown-section-label">
                      {t.chat.savedConfigs}
                    </div>
                    {apiConfigs.map((cfg) => {
                      const provider = cfg.providerId.charAt(0).toUpperCase() + cfg.providerId.slice(1)
                      const modelInfo = MODELS_BY_PROVIDER[cfg.providerId]?.find((m) => m.id === cfg.model)
                      const isActive = cfg.id === activeConfigId
                      return (
                        <button
                          key={cfg.id}
                          className={`chat-model-option chat-config-option ${isActive ? 'active' : ''}`}
                          onClick={() => handleConfigSelect(cfg.id)}
                        >
                          <div className="chat-config-option-info">
                            <span className="chat-config-option-name">{cfg.name}</span>
                            <span className="chat-config-option-detail">{provider} / {modelInfo?.name || cfg.model}</span>
                          </div>
                          {isActive && <span className="chat-model-check">&#10003;</span>}
                        </button>
                      )
                    })}
                    {activeConfigId && (
                      <button className="chat-model-option chat-clear-config" onClick={handleClearActive}>
                        {t.chat.backToManual}
                      </button>
                    )}
                    <div className="chat-dropdown-divider" />
                  </>
                )}

                {/* Models (manual mode) */}
                <div className="chat-dropdown-section-label">
                  {isManualMode ? t.chat.modelsLabel : t.chat.quickSwitchManual}
                  <button className="chat-dropdown-settings-link" onClick={handleOpenSettings}>
                    <Settings size={11} />
                    {t.chat.manage}
                  </button>
                </div>
                {currentModels.map((m) => (
                  <button
                    key={m.id}
                    className={`chat-model-option ${isManualMode && m.id === model ? 'active' : ''}`}
                    onClick={() => handleManualModelSelect(m.id)}
                  >
                    <span>{m.name}</span>
                    {isManualMode && m.id === model && <span className="chat-model-check">&#10003;</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="chat-agent-dropdown-wrapper" ref={modeDropdownWrapperRef}>
            <button
              className="chat-agent-selector-btn"
              onClick={(e) => { e.stopPropagation(); setShowModePicker(!showModePicker) }}
              title={modeHint(currentMode.id)}
            >
              <span className="chat-agent-selector-name">{currentMode.label}</span>
              <ChevronDown size={10} className={`chat-agent-chevron ${showModePicker ? 'open' : ''}`} />
            </button>
            {showModePicker && (
              <div className="chat-agent-dropdown chat-agent-dropdown--compact" onClick={(e) => e.stopPropagation()}>
                {CHAT_MODE_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    className={`chat-agent-option chat-agent-option--compact ${chatInteractionMode === opt.id ? 'active' : ''}`}
                    title={modeHint(opt.id)}
                    onClick={() => handleModeSelect(opt.id)}
                  >
                    <span className="chat-agent-option-label">{opt.label}</span>
                    {chatInteractionMode === opt.id && <span className="chat-agent-check">&#10003;</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="chat-tools-dropdown-wrapper" ref={toolsDropdownWrapperRef}>
            <button
              className="chat-tool-toggle active"
              onClick={(e) => { e.stopPropagation(); if (!showToolsMenu) setToolsDropdownDirection(computeToolsDropdownDirection()); setShowToolsMenu(!showToolsMenu) }}
              title={t.chat.diffToggleTitle}
            >
              {diffPermissionMode === 'bypassPermissions' ? <ShieldCheck size={13} className="tool-icon-auto" /> : <Shield size={13} />}
              <span>{diffPermissionMode === 'bypassPermissions' ? t.chat.autoWrite : t.chat.reviewChanges}</span>
              <ChevronDown size={10} />
            </button>
            {showToolsMenu && (
              <div className={`chat-tools-dropdown chat-tools-dropdown-${toolsDropdownDirection}`} onClick={(e) => e.stopPropagation()} ref={toolsDropdownRef}>
                <div className="chat-dropdown-section-label">{t.chat.reviewModeSection}</div>
                <button
                  className={`chat-tools-option ${diffPermissionMode === 'default' ? 'active' : ''}`}
                  onClick={() => {
                    setDiffPermissionMode('default')
                    setShowToolsMenu(false)
                    // 保持与「默认允许」分支对称:点选项 → dropdown 关闭,
                    // 焦点也显式交还给 textarea,避免某些 Electron / Windows
                    // 组合下按钮点击后 textarea 假死。
                    focusTextareaSoon()
                  }}
                >
                  <Shield size={14} />
                  <div className="chat-tools-option-text">
                    <span className="chat-tools-option-label">{t.chat.reviewEach}</span>
                    <span className="chat-tools-option-hint">{t.chat.reviewEachHint}</span>
                  </div>
                  {diffPermissionMode === 'default' && <span className="chat-tools-check">&#10003;</span>}
                </button>
                <button
                  className={`chat-tools-option ${diffPermissionMode === 'bypassPermissions' ? 'active' : ''}`}
                  onClick={() => {
                    // Close the dropdown immediately so the dialog below
                    // isn't visually stacked with the menu — the confirm
                    // is async (React portal modal, not the legacy
                    // `window.confirm`) so sequencing is clean.
                    setShowToolsMenu(false)
                    void (async () => {
                      const accepted = await confirmSwitchToBypassDiffMode()
                      if (!accepted) {
                        focusTextareaSoon()
                        return
                      }
                      setDiffPermissionMode('bypassPermissions')
                      focusTextareaSoon()
                    })()
                  }}
                >
                  <ShieldCheck size={14} />
                  <div className="chat-tools-option-text">
                    <span className="chat-tools-option-label">{t.chat.allowDefault}</span>
                    <span className="chat-tools-option-hint">{t.chat.allowDefaultHint}</span>
                  </div>
                  {diffPermissionMode === 'bypassPermissions' && <span className="chat-tools-check">&#10003;</span>}
                </button>
              </div>
            )}
          </div>
        </div>
        <div className="chat-toolbar-right">
          {showBackgroundAgentsIndicator && (
            <button
              className="chat-input-btn chat-bg-agents-btn"
              onClick={() => setRunningAgentsPanelVisible(true)}
              title={`本会话仍有 ${backgroundAgentCount} 个后台智能体在运行 — 点击查看/终止`}
            >
              <Loader2 size={14} className="chat-bg-agents-spinner" />
              <span className="chat-bg-agents-count">{backgroundAgentCount}</span>
            </button>
          )}
          {/* 单一主按钮：空闲态 = 圆形发送(↑)，生成中 = 圆形停止(实心■)。
            * 同一个组件按 isTyping 切换形态，不再并排出现暂停/停止两个按钮。 */}
          {isTyping ? (
            <button
              className="chat-input-btn chat-primary-btn is-stop"
              onClick={cancelMessage}
              title={t.chat.stopGenerating}
            >
              <Square size={11} fill="currentColor" strokeWidth={0} />
            </button>
          ) : (
            <button
              className={`chat-input-btn chat-primary-btn is-send ${canSend ? 'active' : ''}`}
              onClick={() => {
                sendMessage().catch((error) => reportUserActionError('发送消息', error))
              }}
              disabled={!canSend}
              title={t.chat.sendMessage}
            >
              <ArrowUp size={16} strokeWidth={2.4} />
            </button>
          )}
        </div>
      </div>
      </div>
      {previewAttachment && (
        <AttachmentPreview
          attachment={previewAttachment}
          onClose={() => setPreviewAttachment(null)}
        />
      )}
      {dangerousDiffConfirmDialog}
    </div>
  )
}

// Memo-wrap so that parent re-renders (e.g. ChatPanel on streaming delta)
// do NOT force ChatInput to re-render and risk detaching the IME / textarea
// focus. ChatInput only re-renders when its own Zustand selectors fire.
export const ChatInput = React.memo(ChatInputComponent)
