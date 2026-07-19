import React, { useMemo, useState } from 'react'
import { DiffEditor } from '@monaco-editor/react'
import type { PermissionRequestDisplay, DiffPreview } from '../../types'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { useMonacoReady } from '../../configureMonaco'
import { useT } from '../../i18n'
import './PermissionPrompt.css'

interface PermissionPromptProps {
  request: PermissionRequestDisplay
  onAllow: (requestId: string) => Promise<void>
  onDeny: (requestId: string) => Promise<void>
}

function computeDiffStats(diffPreview: DiffPreview): { added: number; removed: number } {
  const origLines = diffPreview.originalContent.split('\n')
  const modLines = diffPreview.modifiedContent.split('\n')

  const origSet = new Set(origLines)
  const modSet = new Set(modLines)

  let added = 0
  let removed = 0
  for (const line of modLines) {
    if (!origSet.has(line)) added++
  }
  for (const line of origLines) {
    if (!modSet.has(line)) removed++
  }
  return { added, removed }
}

export const PermissionPrompt: React.FC<PermissionPromptProps> = ({
  request,
  onAllow,
  onDeny,
}) => {
  const t = useT()
  const [diffExpanded, setDiffExpanded] = useState(true)
  const monacoReady = useMonacoReady()
  const editorTheme = useSettingsStore((s) => {
    if (s.theme === 'system') {
      return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'vs-dark'
        : 'vs'
    }
    return s.theme === 'light' || s.theme === 'milk' ? 'vs' : 'vs-dark'
  })

  const inputPreview = useMemo(() => {
    try {
      const text = JSON.stringify(request.input, null, 2)
      return text.length > 2000 ? `${text.slice(0, 2000)}\n...(truncated)` : text
    } catch {
      return String(request.input)
    }
  }, [request.input])

  const diffStats = useMemo(() => {
    if (!request.diffPreview) return null
    return computeDiffStats(request.diffPreview)
  }, [request.diffPreview])

  const fileName = request.diffPreview
    ? request.diffPreview.filePath.split('/').pop()
    : null

  const isFileChange = !!request.diffPreview

  return (
    <div className="permission-prompt-card">
      <div className="permission-prompt-header">
        <span className="permission-prompt-title">
          {isFileChange ? t.permission.fileChangePreview : t.permission.permissionRequired}
        </span>
        {request.mode && <span className="permission-prompt-mode">{request.mode}</span>}
      </div>

      <div className="permission-prompt-body">
        <p className="permission-prompt-description">{request.description}</p>
        <div className="permission-prompt-meta">
          <span className="permission-prompt-tool">{t.permission.toolPrefix}: {request.toolName}</span>
          {request.isDestructive && <span className="permission-prompt-danger">{t.permission.destructive}</span>}
        </div>

        {isFileChange && (
          <div className="permission-diff-section">
            <div
              className="permission-diff-header"
              onClick={() => setDiffExpanded(!diffExpanded)}
            >
              <div className="permission-diff-header-left">
                <span className="permission-diff-file">{fileName}</span>
                {diffStats && (
                  <span className="permission-diff-stats">
                    <span className="diff-stat-added">+{diffStats.added}</span>
                    <span className="diff-stat-removed">-{diffStats.removed}</span>
                  </span>
                )}
              </div>
              <button
                type="button"
                className="permission-diff-toggle"
                aria-expanded={diffExpanded}
                onClick={(e) => {
                  e.stopPropagation()
                  setDiffExpanded(!diffExpanded)
                }}
              >
                {diffExpanded ? t.permission.collapse : t.permission.expand}
              </button>
            </div>
            {diffExpanded && (
              <div className="permission-diff-editor">
                {!monacoReady ? (
                  <div style={{ padding: 12, opacity: 0.6, fontSize: 12 }}>{t.permission.loadingDiff}</div>
                ) : (
                <DiffEditor
                  original={request.diffPreview!.originalContent}
                  modified={request.diffPreview!.modifiedContent}
                  theme={editorTheme}
                  options={{
                    readOnly: true,
                    renderSideBySide: false,
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    fontSize: 12,
                    fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Consolas', monospace",
                    lineHeight: 18,
                    automaticLayout: true,
                    scrollbar: {
                      verticalScrollbarSize: 6,
                      horizontalScrollbarSize: 6,
                    },
                    padding: { top: 4 },
                    renderOverviewRuler: true,
                    diffCodeLens: false,
                    folding: false,
                    lineNumbers: 'on',
                    contextmenu: false,
                  }}
                />
                )}
              </div>
            )}
          </div>
        )}

        {!isFileChange && (
          <pre className="permission-prompt-input">{inputPreview}</pre>
        )}
      </div>

      <div className="permission-prompt-actions">
        <button
          type="button"
          className="permission-prompt-btn deny"
          onClick={() => onDeny(request.requestId)}
        >
          {isFileChange ? t.permission.reject : t.permission.deny}
        </button>
        <button
          type="button"
          className="permission-prompt-btn allow"
          onClick={() => onAllow(request.requestId)}
        >
          {isFileChange ? t.permission.applyChanges : t.permission.allow}
        </button>
      </div>
    </div>
  )
}
