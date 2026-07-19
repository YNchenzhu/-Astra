import React, { useState, useCallback, useRef, useMemo } from 'react'
import { X, Send, FileCode, Check, CheckCheck, XCircle, ChevronUp, ChevronDown, Layers } from 'lucide-react'
import { useFileStore } from '../../stores/useFileStore'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { normalizePath, toRelativePath } from '../../services/pathUtils'
import { computeDiff } from '../../services/diff'
import { buildUserRulesPromptFromStorage } from '../../utils/userRulesPrompt'
import type { FileDiff, DiffSession } from '../../services/diff'
import type { StreamEvent } from '../../types'
import './ComposerPanel.css'

interface ComposerPanelProps {
  onClose: () => void
}

type Phase = 'input' | 'loading' | 'review'

interface ComposerFile {
  path: string
  name: string
}

export const ComposerPanel: React.FC<ComposerPanelProps> = ({ onClose }) => {
  const [phase, setPhase] = useState<Phase>('input')
  const [instruction, setInstruction] = useState('')
  const [selectedFiles, setSelectedFiles] = useState<ComposerFile[]>([])
  const [session, setSession] = useState<DiffSession | null>(null)
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const rootPath = useWorkspaceStore.getState().rootPath

  const removeFile = useCallback((path: string) => {
    setSelectedFiles((prev) => prev.filter((f) => f.path !== path))
  }, [])

  const handleSubmit = useCallback(async () => {
    if (!instruction.trim()) return
    setPhase('loading')

    try {
      const result = await callComposerAI(
        instruction,
        selectedFiles,
        useWorkspaceStore.getState().rootPath,
      )
      if (result) {
        setSession(result)
        const firstFile = result.files.keys().next().value
        setActiveFilePath(firstFile ?? null)
        setPhase('review')
      } else {
        setPhase('input')
      }
    } catch {
      setPhase('input')
    }
    // `rootPath` is read via `useWorkspaceStore.getState()` inside the handler (line above)
    // rather than from the closure variable, so it's intentionally not in the deps list.
  }, [instruction, selectedFiles])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      void handleSubmit()
    }
  }, [handleSubmit])

  const sessionFiles = useMemo(() => {
    if (!session) return []
    return Array.from(session.files.values())
  }, [session])

  const activeFile = useMemo(() => {
    if (!session || !activeFilePath) return null
    return session.files.get(activeFilePath) ?? null
  }, [session, activeFilePath])

  const activeIndex = useMemo(() => {
    return sessionFiles.findIndex((f) => f.filePath === activeFilePath)
  }, [sessionFiles, activeFilePath])

  const handleAcceptAll = useCallback(async () => {
    if (!session) return
    const fileState = useFileStore.getState()
    for (const fileDiff of session.files.values()) {
      const relativePath = toRelativePath(fileDiff.filePath, rootPath)
      const api = typeof window !== 'undefined' ? window.electronAPI : undefined
      if (api?.fs?.writeFile) {
        await api.fs.writeFile(fileDiff.filePath, fileDiff.modifiedContent)
      }
      const tab = fileState.tabs.find((t) =>
        normalizePath(t.path) === normalizePath(relativePath) ||
        normalizePath(t.path) === normalizePath(fileDiff.filePath),
      )
      if (tab) {
        useFileStore.setState({
          tabs: fileState.tabs.map((t) =>
            t.id === tab.id ? { ...t, content: fileDiff.modifiedContent, isModified: false } : t,
          ),
        })
      }
    }
    onClose()
  }, [session, rootPath, onClose])

  const handleRejectAll = useCallback(() => {
    onClose()
  }, [onClose])

  const handleAcceptFile = useCallback(async () => {
    if (!activeFile) return
    const api = typeof window !== 'undefined' ? window.electronAPI : undefined
    if (api?.fs?.writeFile) {
      await api.fs.writeFile(activeFile.filePath, activeFile.modifiedContent)
    }
    if (session) {
      const newFiles = new Map(session.files)
      newFiles.delete(activeFile.filePath)
      if (newFiles.size === 0) {
        onClose()
      } else {
        setSession({ ...session, files: newFiles })
        setActiveFilePath(newFiles.keys().next().value ?? null)
      }
    }
  }, [activeFile, session, onClose])

  // ── Render ──────────────────────────────────────────────

  return (
    <div className="composer-panel">
      <div className="composer-panel-header">
        <h3><Layers size={14} /> Composer</h3>
        <button className="composer-panel-close" onClick={onClose}>
          <X size={16} />
        </button>
      </div>

      {phase === 'input' && (
        <div className="composer-main">
          <div className="composer-input-panel">
            <div className="composer-file-selector">
              {selectedFiles.map((f) => (
                <span key={f.path} className="composer-file-tag">
                  <FileCode size={10} />
                  {f.name}
                  <button className="composer-file-tag-remove" onClick={() => removeFile(f.path)}>
                    <X size={10} />
                  </button>
                </span>
              ))}
            </div>
            <div className="composer-input-row">
              <textarea
                ref={textareaRef}
                placeholder="描述你要做的修改... (Ctrl+Enter 提交)"
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                onKeyDown={handleKeyDown}
                rows={3}
              />
            </div>
            <button
              className="composer-submit-btn"
              onClick={handleSubmit}
              disabled={!instruction.trim()}
            >
              <Send size={13} />
              <span>Submit</span>
            </button>
          </div>
          <div className="composer-diff-area">
            <div className="composer-diff-empty">选择文件并输入修改指令</div>
          </div>
        </div>
      )}

      {phase === 'loading' && (
        <div className="composer-main">
          <div className="composer-diff-area">
            <div className="composer-loading">
              <div className="composer-spinner" />
              <span>AI 正在生成跨文件修改...</span>
            </div>
          </div>
        </div>
      )}

      {phase === 'review' && session && (
        <div className="composer-body">
          <div className="composer-sidebar">
            <div className="composer-sidebar-title">变更文件</div>
            {sessionFiles.map((f) => {
              const name = toRelativePath(f.filePath, rootPath).split('/').pop() || f.filePath
              return (
                <button
                  key={f.filePath}
                  className={`composer-file-item ${f.filePath === activeFilePath ? 'active' : ''}`}
                  onClick={() => setActiveFilePath(f.filePath)}
                >
                  <FileCode size={12} />
                  <span className="composer-file-item-name">{name}</span>
                  <span className="composer-file-item-stats">
                    +{f.result.stats.added} -{f.result.stats.removed}
                  </span>
                </button>
              )
            })}
          </div>

          <div className="composer-main">
            <div className="composer-diff-area">
              {activeFile ? (
                <ComposerDiffView fileDiff={activeFile} />
              ) : (
                <div className="composer-diff-empty">选择一个文件查看差异</div>
              )}
            </div>

            <div className="composer-action-bar">
              <div className="composer-action-bar-left">
                <button className="composer-action-btn accept" onClick={handleAcceptFile}>
                  <Check size={14} />
                  <span>接受此文件</span>
                </button>
                <button className="composer-action-btn accept" onClick={handleAcceptAll}>
                  <CheckCheck size={14} />
                  <span>全部接受</span>
                </button>
                <button className="composer-action-btn reject" onClick={handleRejectAll}>
                  <XCircle size={14} />
                  <span>全部拒绝</span>
                </button>
              </div>

              <div className="composer-action-bar-right">
                {sessionFiles.length > 1 && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <button
                      className="composer-action-btn"
                      style={{ padding: '3px 6px' }}
                      disabled={activeIndex <= 0}
                      onClick={() => setActiveFilePath(sessionFiles[activeIndex - 1]?.filePath ?? null)}
                    >
                      <ChevronUp size={14} />
                    </button>
                    <span className="composer-file-progress">
                      文件 {activeIndex + 1}/{sessionFiles.length}
                    </span>
                    <button
                      className="composer-action-btn"
                      style={{ padding: '3px 6px' }}
                      disabled={activeIndex >= sessionFiles.length - 1}
                      onClick={() => setActiveFilePath(sessionFiles[activeIndex + 1]?.filePath ?? null)}
                    >
                      <ChevronDown size={14} />
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// Simple diff view for Composer review
const ComposerDiffView: React.FC<{ fileDiff: FileDiff }> = ({ fileDiff }) => {
  const lines = useMemo(() => {
    return fileDiff.result.diffLines.map((dl, i) => ({
      key: i,
      op: dl.op,
      text: dl.text,
    }))
  }, [fileDiff])

  return (
    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, lineHeight: '20px' }}>
      {lines.map((line) => {
        let bg = 'transparent'
        let prefix = ' '
        let color = 'var(--text-primary)'
        if (line.op === 'add') {
          bg = 'rgba(34, 197, 94, 0.12)'
          prefix = '+'
          color = '#4ade80'
        } else if (line.op === 'delete') {
          bg = 'rgba(239, 68, 68, 0.08)'
          prefix = '−'
          color = 'rgba(248, 113, 113, 0.6)'
        }
        return (
          <div key={line.key} style={{ background: bg, padding: '0 12px', whiteSpace: 'pre' }}>
            <span style={{ color: color === 'var(--text-primary)' ? 'var(--text-muted)' : color, width: 16, display: 'inline-block' }}>{prefix}</span>
            <span style={{ color, textDecoration: line.op === 'delete' ? 'line-through' : 'none' }}>{line.text || '\u00A0'}</span>
          </div>
        )
      })}
    </div>
  )
}

async function callComposerAI(
  instruction: string,
  files: ComposerFile[],
  rootPath: string | null,
): Promise<DiffSession | null> {
  try {
    const api = typeof window !== 'undefined' ? window.electronAPI : undefined
    if (!api?.ai?.sendMessage) return null

    const settings = useSettingsStore.getState()
    const fileList = files.map((f) => f.path).join(', ')
    const prompt = files.length > 0
      ? `Modify these files: ${fileList}\n\nInstruction: ${instruction}\n\nFor each file, use edit_file or write_file tools to make the changes.`
      : `${instruction}\n\nUse edit_file or write_file tools to implement the changes.`

    return new Promise<DiffSession | null>((resolve) => {
      let resolved = false
      const fileDiffs = new Map<string, FileDiff>()

      const cleanup = api.ai.onStreamEvent((event: StreamEvent) => {
        if (
          event.type === 'file_change_applied' &&
          event.filePath &&
          event.originalContent !== undefined &&
          event.modifiedContent !== undefined
        ) {
          const result = computeDiff(event.originalContent, event.modifiedContent)
          fileDiffs.set(event.filePath, {
            filePath: event.filePath,
            originalContent: event.originalContent,
            modifiedContent: event.modifiedContent,
            result,
          })
        }

        if (event.type === 'message_stop' || event.type === 'error') {
          if (!resolved) {
            resolved = true
            cleanup?.()
            if (fileDiffs.size > 0) {
              resolve({
                id: `composer-${Date.now()}`,
                files: fileDiffs,
                mode: 'composer',
                createdAt: Date.now(),
              })
            } else {
              resolve(null)
            }
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
        enableTools: true,
        diffPermissionMode: 'bypassPermissions',
        permissionDefaultMode: settings.permissionDefaultMode,
        permissionRules: settings.permissionRules,
        userRulesPrompt: buildUserRulesPromptFromStorage(),
        autoTaskRouting: settings.autoTaskRouting,
        alwaysThinking: settings.alwaysThinking,
        thinkingBudgetTokens: settings.thinkingBudgetTokens,
        agentType: 'general-purpose',
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
          resolve(fileDiffs.size > 0 ? {
            id: `composer-${Date.now()}`,
            files: fileDiffs,
            mode: 'composer',
            createdAt: Date.now(),
          } : null)
        }
      }, 60000)
    })
  } catch {
    return null
  }
}
