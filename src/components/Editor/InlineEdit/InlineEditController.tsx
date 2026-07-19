import React, { useState, useRef, useCallback, useEffect } from 'react'
import type * as monaco from 'monaco-editor'
import { Send, X, Check, XCircle, RotateCcw } from 'lucide-react'
import { InlineDiffDecorator } from '../InlineDiffDecorator'
import { useSettingsStore } from '../../../stores/useSettingsStore'
import { useWorkspaceStore } from '../../../stores/useWorkspaceStore'
import { buildUserRulesPromptFromStorage } from '../../../utils/userRulesPrompt'
import type { StreamEvent } from '../../../types'
import './InlineEditInputBar.css'

interface InlineEditControllerProps {
  editor: monaco.editor.IStandaloneCodeEditor
  onClose: () => void
}

type Phase = 'input' | 'loading' | 'review'

export const InlineEditController: React.FC<InlineEditControllerProps> = ({
  editor,
  onClose,
}) => {
  const [phase, setPhase] = useState<Phase>('input')
  const [instruction, setInstruction] = useState('')
  const [modifiedCode, setModifiedCode] = useState<string | null>(null)
  // Seed selection-dependent state from the Monaco editor on mount via lazy
  // initializers — avoids the `set-state-in-effect` cascade-render pitfall
  // and keeps selection capture consistent across re-mounts.
  const [selectedCode] = useState<string>(() => {
    const selection = editor.getSelection()
    const model = editor.getModel()
    if (selection && model && !selection.isEmpty()) {
      return model.getValueInRange(selection)
    }
    return model?.getValue() || ''
  })
  const [selectionRange] = useState<monaco.IRange | null>(() => {
    const selection = editor.getSelection()
    return selection && !selection.isEmpty() ? selection : null
  })
  const [overlayTop, setOverlayTop] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const decoratorRef = useRef<InlineDiffDecorator | null>(null)

  // Mount-only focus: autofocus the instruction input shortly after mount so
  // the initial render gets a chance to paint.
  useEffect(() => {
    const id = setTimeout(() => inputRef.current?.focus(), 50)
    return () => clearTimeout(id)
  }, [])

  // Resolve the line number where the input bar should be positioned
  const inputLineNumber = selectionRange
    ? selectionRange.startLineNumber
    : (editor.getPosition()?.lineNumber ?? 1)

  const editorLineHeight = Number(editor.getOption(66 /* EditorOption.lineHeight */)) || 20

  useEffect(() => {
    const updateOverlayTop = () => {
      const topForLine = editor.getTopForLineNumber(inputLineNumber)
      const scrollTop = editor.getScrollTop()
      setOverlayTop(Math.max(0, topForLine - scrollTop))
    }

    updateOverlayTop()

    const disposables = [
      editor.onDidScrollChange(updateOverlayTop),
      editor.onDidLayoutChange(updateOverlayTop),
      editor.onDidChangeCursorPosition(updateOverlayTop),
      editor.onDidChangeCursorSelection(updateOverlayTop),
    ]

    return () => {
      for (const disposable of disposables) disposable.dispose()
    }
  }, [editor, inputLineNumber])

  // Callbacks are ordered so each useCallback references only previously
  // declared values — this lets us list full, honest dependency arrays
  // (previously some of these hooks omitted deps and risked stale closures).

  const cleanup = useCallback(() => {
    if (decoratorRef.current) {
      decoratorRef.current.dispose()
      decoratorRef.current = null
    }
    onClose()
  }, [onClose])

  const applyToEditor = useCallback((content: string) => {
    const model = editor.getModel()
    if (!model) return

    if (selectionRange) {
      model.pushEditOperations(
        [],
        [{
          range: selectionRange,
          text: content,
        }],
        () => null,
      )
    } else {
      model.setValue(content)
    }
  }, [editor, selectionRange])

  const applyDiffPreview = useCallback((modified: string) => {
    if (decoratorRef.current) {
      decoratorRef.current.dispose()
      decoratorRef.current = null
    }

    const decorator = new InlineDiffDecorator(editor, selectedCode, modified)
    decorator.onAllResolved = () => {
      const finalContent = decorator.getCurrentContent()
      applyToEditor(finalContent)
      cleanup()
    }
    decorator.apply()
    decoratorRef.current = decorator
  }, [editor, selectedCode, applyToEditor, cleanup])

  const handleAccept = useCallback(() => {
    if (modifiedCode !== null) {
      applyToEditor(modifiedCode)
    }
    cleanup()
  }, [modifiedCode, applyToEditor, cleanup])

  const handleReject = useCallback(() => {
    if (decoratorRef.current) {
      decoratorRef.current.rejectAll()
      decoratorRef.current.dispose()
      decoratorRef.current = null
    }
    cleanup()
  }, [cleanup])

  const handleRetry = useCallback(() => {
    if (decoratorRef.current) {
      decoratorRef.current.rejectAll()
      decoratorRef.current.dispose()
      decoratorRef.current = null
    }
    setModifiedCode(null)
    setPhase('input')
    setTimeout(() => inputRef.current?.focus(), 50)
  }, [])

  const handleSubmit = useCallback(async () => {
    if (!instruction.trim()) return
    setPhase('loading')

    try {
      const model = editor.getModel()
      const filePath = model?.uri?.path || 'untitled'
      const prompt = selectionRange
        ? `Edit the selected code in ${filePath} (lines ${selectionRange.startLineNumber}-${selectionRange.endLineNumber}):\n\`\`\`\n${selectedCode}\n\`\`\`\n\nInstruction: ${instruction}\n\nReturn ONLY the replacement code, no explanations.`
        : `Edit this file: ${filePath}\n\nInstruction: ${instruction}\n\nReturn ONLY the modified code, no explanations.`

      // Lightweight AI call — extracts only the text response via the
      // existing streaming pipeline. A dedicated endpoint would be nicer.
      const result = await callInlineEditAI(prompt)

      if (result) {
        setModifiedCode(result)
        setPhase('review')
        applyDiffPreview(result)
      } else {
        setPhase('input')
      }
    } catch {
      setPhase('input')
    }
  }, [instruction, selectedCode, selectionRange, editor, applyDiffPreview])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSubmit()
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      if (phase === 'review') {
        handleReject()
      } else {
        cleanup()
      }
    }
  }, [handleSubmit, handleReject, cleanup, phase])

  // ── Render ──────────────────────────────────────────────

  if (phase === 'input') {
    return (
      <div className="inline-edit-overlay" style={{ top: `${overlayTop}px` }}>
        <div className="inline-edit-input-bar">
          <input
            ref={inputRef}
            type="text"
            placeholder="输入编辑指令..."
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <button
            className="inline-edit-submit-btn"
            onClick={handleSubmit}
            disabled={!instruction.trim()}
          >
            <Send size={12} />
            <span>Submit Edit</span>
          </button>
          <button className="inline-edit-cancel-btn" onClick={cleanup}>
            <X size={14} />
          </button>
        </div>
      </div>
    )
  }

  if (phase === 'loading') {
    return (
      <div className="inline-edit-overlay" style={{ top: `${overlayTop}px` }}>
        <div className="inline-edit-input-bar">
          <div className="inline-edit-loading">
            <div className="inline-edit-spinner" />
            <span>正在生成...</span>
          </div>
          <button className="inline-edit-cancel-btn" onClick={cleanup}>
            <X size={14} />
          </button>
        </div>
      </div>
    )
  }

  // phase === 'review'
  return (
    <div className="inline-edit-overlay" style={{ top: `${overlayTop + editorLineHeight * 2}px` }}>
      <div className="inline-edit-action-bar">
        <button className="ie-accept" onClick={handleAccept}>
          <Check size={14} />
          <span>Accept</span>
        </button>
        <button className="ie-reject" onClick={handleReject}>
          <XCircle size={14} />
          <span>Reject</span>
        </button>
        <button className="ie-retry" onClick={handleRetry}>
          <RotateCcw size={14} />
          <span>Retry</span>
        </button>
      </div>
    </div>
  )
}

/**
 * Lightweight AI call for inline edit. Uses the existing sendMessage infrastructure
 * but extracts only the text response. In a full implementation this would be a
 * dedicated streaming endpoint.
 */
async function callInlineEditAI(prompt: string): Promise<string | null> {
  try {
    const api =
      typeof window !== 'undefined' && window.electronAPI ? window.electronAPI : null
    if (!api?.ai?.sendMessage) return null

    const settings = useSettingsStore.getState()
    const rootPath = useWorkspaceStore.getState().rootPath

    return new Promise<string | null>((resolve) => {
      let result = ''
      let resolved = false

      const cleanup = api.ai.onStreamEvent((event: StreamEvent) => {
        if (event.type === 'text_delta' && event.text) {
          result += event.text
        }
        if (event.type === 'message_stop' || event.type === 'error') {
          if (!resolved) {
            resolved = true
            cleanup?.()
            resolve(result || null)
          }
        }
      })

      api.ai.sendMessage({
        messages: [{ role: 'user', content: prompt }],
        workspacePath: rootPath || undefined,
        model: settings.model,
        maxTokens: settings.maxTokens,
        providerId: settings.providerId,
        apiKey: settings.getApiKey(),
        baseUrl: settings.getBaseUrl(),
        awsRegion: settings.getAwsRegion(),
        projectId: settings.getProjectId(),
        outputStyle: settings.outputStyle,
        language: settings.language,
        enableTools: false,
        diffPermissionMode: 'bypassPermissions',
        userRulesPrompt: buildUserRulesPromptFromStorage(),
        alwaysThinking: settings.alwaysThinking,
        thinkingBudgetTokens: settings.thinkingBudgetTokens,
      }).catch(() => {
        if (!resolved) {
          resolved = true
          cleanup?.()
          resolve(null)
        }
      })

      setTimeout(() => {
        if (!resolved) {
          resolved = true
          cleanup?.()
          resolve(result || null)
        }
      }, 30000)
    })
  } catch {
    return null
  }
}
