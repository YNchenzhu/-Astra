import React, { useMemo, useState, useCallback, useRef, useEffect } from 'react'
import { VariableSizeList, type ListChildComponentProps } from 'react-window'
import {
  AlertCircle,
  AlertTriangle,
  Info,
  Lightbulb,
  X,
  Copy,
  Check,
  ExternalLink,
} from 'lucide-react'
import {
  useDiagnosticStore,
  type Diagnostic,
  type DiagnosticSeverity,
} from '../../stores/useDiagnosticStore'
import { useFileStore } from '../../stores/useFileStore'
import type { TabInfo } from '../../types'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'
import {
  isSamePath,
  joinWorkspaceRelative,
  toRelativePath,
} from '../../services/pathUtils'
import {
  flattenProblemRows,
  rowHeightByIndex,
  PROBLEM_ROW_HEIGHTS,
  type ProblemRow,
} from './problemsPanelRows'
import { useT } from '../../i18n'
import { readTabContent } from '../../services/openBehavior'
import './ProblemsPanel.css'

/* ------------------------------------------------------------------ constants */

const severityIcons: Record<DiagnosticSeverity, React.ReactNode> = {
  error: <AlertCircle size={13} />,
  warning: <AlertTriangle size={13} />,
  information: <Info size={13} />,
  hint: <Lightbulb size={13} />,
}

const severityColors: Record<DiagnosticSeverity, string> = {
  error: 'var(--text-error)',
  warning: 'var(--text-warning)',
  information: 'var(--text-info)',
  hint: 'var(--text-muted)',
}

const SEVERITY_ORDER: Record<DiagnosticSeverity, number> = {
  error: 0,
  warning: 1,
  information: 2,
  hint: 3,
}

const LSP_TAG_UNNECESSARY = 1
const LSP_TAG_DEPRECATED = 2

type FilterMode = 'all' | 'currentFile'

type QuickFixAction = {
  title: string
  kind?: string
  edit?: Record<string, unknown>
  command?: { command: string; arguments?: unknown[] }
  data?: unknown
  isPreferred?: boolean
  raw: Record<string, unknown>
}

interface QuickFixState {
  key: string
  file: string
  anchor: { top: number; left: number; height: number } | null
  loading: boolean
  error?: string
  actions: QuickFixAction[]
}

/* ----------------------------------------------------------------- utilities */

function findTabByAbsolute(
  tabs: TabInfo[],
  absolutePath: string,
  rootPath: string | null,
): TabInfo | undefined {
  const targetAbs = absolutePath
  const targetRel = rootPath ? toRelativePath(absolutePath, rootPath) : absolutePath
  return tabs.find((t) => {
    if (isSamePath(t.path, targetRel)) return true
    if (isSamePath(t.path, targetAbs)) return true
    const tabAbs = rootPath ? joinWorkspaceRelative(rootPath, t.path) : t.path
    return isSamePath(tabAbs, targetAbs)
  })
}

function sortDiagnostics(list: Diagnostic[]): Diagnostic[] {
  return [...list].sort((a, b) => {
    const sa = SEVERITY_ORDER[a.severity] ?? 9
    const sb = SEVERITY_ORDER[b.severity] ?? 9
    if (sa !== sb) return sa - sb
    if (a.line !== b.line) return a.line - b.line
    if (a.column !== b.column) return a.column - b.column
    const srcA = a.source ?? ''
    const srcB = b.source ?? ''
    if (srcA !== srcB) return srcA < srcB ? -1 : 1
    const codeA = a.code === undefined ? '' : String(a.code)
    const codeB = b.code === undefined ? '' : String(b.code)
    if (codeA !== codeB) return codeA < codeB ? -1 : 1
    return 0
  })
}

function formatSourceCodeLabel(d: Diagnostic): string {
  const source = d.source && d.source.trim() ? d.source.trim() : null
  const code = d.code === undefined || d.code === null ? null : String(d.code)
  if (source && code) return `${source}(${code})`
  if (source) return source
  if (code) return code
  return ''
}

function hasTag(d: Diagnostic, tag: number): boolean {
  return Array.isArray(d.tags) && d.tags.includes(tag)
}

function normalizeCodeAction(raw: Record<string, unknown>): QuickFixAction | null {
  if (!raw || typeof raw !== 'object') return null
  const title = typeof raw.title === 'string' ? raw.title : undefined
  if (!title) return null

  if (typeof raw.command === 'string') {
    return {
      title,
      command: { command: raw.command, arguments: raw.arguments as unknown[] | undefined },
      raw,
    }
  }

  const out: QuickFixAction = { title, raw }
  if (typeof raw.kind === 'string') out.kind = raw.kind
  if (raw.edit && typeof raw.edit === 'object') out.edit = raw.edit as Record<string, unknown>
  if (raw.command && typeof raw.command === 'object') {
    const c = raw.command as { command?: string; arguments?: unknown[] }
    if (typeof c.command === 'string') {
      out.command = { command: c.command, arguments: c.arguments }
    }
  }
  if (raw.data !== undefined) out.data = raw.data
  if (typeof raw.isPreferred === 'boolean') out.isPreferred = raw.isPreferred
  return out
}

/* ---------------------------------------------------------------- row context */

interface RowContext {
  rows: ProblemRow[]
  rootPath: string | null
  expandedFiles: Set<string>
  copiedFile: string | null
  onToggleFileExpand: (file: string) => void
  onCopyFile: (file: string) => Promise<void>
  onDiagnosticClick: (file: string, line: number, column: number) => void | Promise<void>
  onRelatedClick: (file: string, line: number, column: number) => void | Promise<void>
  onOpenQuickFix: (
    diag: Diagnostic,
    anchorRect: { top: number; left: number; height: number },
  ) => void
}

const VirtualRow: React.FC<ListChildComponentProps<RowContext>> = ({ index, style, data }) => {
  const t = useT()
  const row = data.rows[index]
  if (!row) return null

  if (row.kind === 'file-header') {
    const { file, diagCount } = row
    const expanded = data.expandedFiles.has(file)
    return (
      <div style={style}>
        <div
          className="problems-file-header"
          onClick={() => data.onToggleFileExpand(file)}
        >
          <span className={`problems-expand-icon ${expanded ? 'expanded' : ''}`}>
            {expanded ? '▼' : '▶'}
          </span>
          <span className="problems-file-name">
            {toRelativePath(file, data.rootPath)}
          </span>
          <span className="problems-file-count">{diagCount}</span>
          <button
            className={`problems-copy-btn${data.copiedFile === file ? ' copied' : ''}`}
            onClick={(e) => {
              e.stopPropagation()
              void data.onCopyFile(file)
            }}
            title={t.problems.copyFileProblems}
          >
            {data.copiedFile === file ? <Check size={12} /> : <Copy size={12} />}
          </button>
        </div>
      </div>
    )
  }

  if (row.kind === 'diagnostic') {
    const d = row.diag
    const sourceLabel = formatSourceCodeLabel(d)
    const unnecessary = hasTag(d, LSP_TAG_UNNECESSARY)
    const deprecated = hasTag(d, LSP_TAG_DEPRECATED)
    return (
      <div style={style}>
        <div
          className={`problems-item${
            unnecessary ? ' problems-item-unnecessary' : ''
          }${deprecated ? ' problems-item-deprecated' : ''}`}
          onClick={() => void data.onDiagnosticClick(d.file, d.line, d.column)}
        >
          <span
            className="problems-item-icon"
            style={{ color: severityColors[d.severity] }}
          >
            {severityIcons[d.severity]}
          </span>
          <span className="problems-item-message" title={d.message}>
            {d.message}
          </span>
          {sourceLabel && (
            <span
              className="problems-item-source"
              title={
                d.codeDescriptionHref
                  ? t.problems.ruleDocSuffix(sourceLabel)
                  : sourceLabel
              }
            >
              {d.codeDescriptionHref ? (
                <a
                  href={d.codeDescriptionHref}
                  target="_blank"
                  rel="noreferrer noopener"
                  onClick={(e) => e.stopPropagation()}
                  className="problems-item-rule-link"
                >
                  {sourceLabel}
                  <ExternalLink size={9} />
                </a>
              ) : (
                <span>{sourceLabel}</span>
              )}
            </span>
          )}
          <button
            type="button"
            className="problems-item-qf problems-quickfix-btn"
            title={t.problems.quickFixBtnTitle}
            onClick={(e) => {
              e.stopPropagation()
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
              data.onOpenQuickFix(d, {
                top: rect.top,
                left: rect.left,
                height: rect.height,
              })
            }}
          >
            <Lightbulb size={12} />
          </button>
          <span className="problems-item-location">
            [{d.line}, {d.column}]
          </span>
        </div>
      </div>
    )
  }

  // row.kind === 'related'
  const { rel, parentDiag } = row
  return (
    <div style={style}>
      <button
        type="button"
        className="problems-related-row problems-related-row-virtual"
        onClick={(e) => {
          e.stopPropagation()
          void data.onRelatedClick(rel.file, rel.line, rel.column)
        }}
        title={`${parentDiag.message} → ${rel.file}`}
      >
        <span className="problems-related-label">{t.problems.related}</span>
        <span className="problems-related-text">
          {toRelativePath(rel.file, data.rootPath)} [{rel.line}, {rel.column}]: {rel.message}
        </span>
      </button>
    </div>
  )
}

/* ------------------------------------------------------------------ component */

export const ProblemsPanel: React.FC = () => {
  const t = useT()
  const diagnostics = useDiagnosticStore((s) => s.diagnostics)
  const clearAllDiagnostics = useDiagnosticStore((s) => s.clearAllDiagnostics)
  const activeTabId = useFileStore((s) => s.activeTabId)
  const tabs = useFileStore((s) => s.tabs)
  const rootPath = useWorkspaceStore((s) => s.rootPath)
  const [filterMode, setFilterMode] = useState<FilterMode>('all')
  const [severityFilter, setSeverityFilter] = useState<DiagnosticSeverity | 'all'>('all')
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set())
  const [copiedFile, setCopiedFile] = useState<string | null>(null)
  const [quickFix, setQuickFix] = useState<QuickFixState | null>(null)
  const [quickFixApplying, setQuickFixApplying] = useState(false)
  const [quickFixBanner, setQuickFixBanner] =
    useState<{ kind: 'info' | 'error'; text: string } | null>(null)
  const quickFixReqIdRef = useRef(0)

  /** Bounds measured for the virtualized list — set via ResizeObserver. */
  const [listSize, setListSize] = useState<{ width: number; height: number }>({
    width: 0,
    height: 0,
  })
  const listContainerRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<VariableSizeList<RowContext> | null>(null)

  const activeFilePath = tabs.find((t) => t.id === activeTabId)?.path || ''

  const filteredDiagnostics = useMemo(() => {
    let result = diagnostics
    if (filterMode === 'currentFile' && activeFilePath) {
      const activeAbs = joinWorkspaceRelative(rootPath, activeFilePath)
      result = result.filter((d) => isSamePath(d.file, activeAbs))
    }
    if (severityFilter !== 'all') {
      result = result.filter((d) => d.severity === severityFilter)
    }
    return result
  }, [diagnostics, filterMode, activeFilePath, rootPath, severityFilter])

  /** [file, sortedDiagnostics[]] tuples, already sorted by relative path. */
  const fileEntries = useMemo(() => {
    const buckets = new Map<string, Diagnostic[]>()
    for (const d of filteredDiagnostics) {
      const list = buckets.get(d.file) ?? []
      list.push(d)
      buckets.set(d.file, list)
    }
    const entries = Array.from(buckets.entries()).map(
      ([file, diags]) => [file, sortDiagnostics(diags)] as const,
    )
    entries.sort(([a], [b]) => {
      const ra = toRelativePath(a, rootPath).toLowerCase()
      const rb = toRelativePath(b, rootPath).toLowerCase()
      if (ra !== rb) return ra < rb ? -1 : 1
      return 0
    })
    return entries
  }, [filteredDiagnostics, rootPath])

  /** Flat row stream consumed by react-window. */
  const rows = useMemo(
    () => flattenProblemRows(fileEntries, { expandedFiles }),
    [fileEntries, expandedFiles],
  )

  /** Reset the VariableSizeList internal measurement cache when heights change. */
  useEffect(() => {
    listRef.current?.resetAfterIndex(0, true)
  }, [rows])

  /** Track container size for react-window's explicit width/height props. */
  useEffect(() => {
    const el = listContainerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        setListSize((prev) =>
          prev.width === Math.round(width) && prev.height === Math.round(height)
            ? prev
            : { width: Math.round(width), height: Math.round(height) },
        )
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const errorCount = diagnostics.filter((d) => d.severity === 'error').length
  const warningCount = diagnostics.filter((d) => d.severity === 'warning').length
  const infoCount = diagnostics.filter((d) => d.severity === 'information').length

  const handleFileClick = useCallback(
    async (file: string, line: number, column: number) => {
      const fileStore = useFileStore.getState() as unknown as Record<string, unknown>
      const relPath = rootPath ? toRelativePath(file, rootPath) : file
      const existingTab = findTabByAbsolute(tabs, file, rootPath)

      if (existingTab) {
        ;(fileStore.setActiveTab as (id: string) => void)(existingTab.id)
      } else {
        const fileName = file.split(/[\\/]/).pop() || file
        const ext = fileName.split('.').pop()?.toLowerCase() || ''
        const langMap: Record<string, string> = {
          ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
          json: 'json', md: 'markdown', css: 'css', html: 'html',
          py: 'python', rs: 'rust', go: 'go', java: 'java',
          sh: 'shell', yml: 'yaml', yaml: 'yaml',
        }
        let content = ''
        try {
          // 统一打开行为表:图片/文档预览类不做 UTF-8 全文读取。
          content = await readTabContent(file, fileName)
        } catch {
          /* ignore */
        }
        ;(fileStore.openFile as (tab: {
          id: string
          name: string
          path: string
          language: string
          content: string
          isModified: boolean
        }) => void)({
          id: `diag-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          name: fileName,
          path: relPath,
          language: langMap[ext] || 'plaintext',
          content,
          isModified: false,
        })
      }

      const jumpFn = fileStore.requestJump
      if (typeof jumpFn === 'function') {
        ;(jumpFn as (line: number, column: number) => void)(line, column)
      } else if (typeof fileStore.setCursorPosition === 'function') {
        ;(fileStore.setCursorPosition as (line: number, column: number) => void)(line, column)
      }
      setExpandedFiles((prev) => (prev.has(file) ? prev : new Set(prev).add(file)))
    },
    [tabs, rootPath],
  )

  const toggleFileExpand = useCallback((file: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev)
      if (next.has(file)) next.delete(file)
      else next.add(file)
      return next
    })
  }, [])

  const handleCopyFile = useCallback(
    async (file: string) => {
      const entry = fileEntries.find(([f]) => f === file)
      if (!entry) return
      const [, diags] = entry
      const severityLabels: Record<DiagnosticSeverity, string> = {
        error: t.problems.severityError,
        warning: t.problems.severityWarning,
        information: t.problems.severityInfo,
        hint: t.problems.severityHint,
      }
      const displayPath = toRelativePath(file, rootPath)
      const lines: string[] = [t.problems.copyFileHeader(displayPath), '']
      for (const d of diags) {
        const src = formatSourceCodeLabel(d)
        const suffix = src ? ` [${src}]` : ''
        lines.push(
          t.problems.copyProblemLine(severityLabels[d.severity], d.line, d.column, d.message, suffix),
        )
        if (d.relatedInformation?.length) {
          for (const r of d.relatedInformation) {
            const rp = toRelativePath(r.file, rootPath)
            lines.push(t.problems.copyRelatedLine(rp, r.line, r.column, r.message))
          }
        }
      }
      const text = lines.join('\n')
      try {
        await navigator.clipboard.writeText(text)
        setCopiedFile(file)
        setTimeout(() => setCopiedFile(null), 2000)
      } catch {
        /* fallback ignored */
      }
    },
    [fileEntries, rootPath, t],
  )

  const closeQuickFix = useCallback(() => {
    setQuickFix(null)
    setQuickFixBanner(null)
  }, [])

  const openQuickFix = useCallback(
    async (diag: Diagnostic, anchorRect: { top: number; left: number; height: number }) => {
      const api = window.electronAPI?.lsp?.getCodeActions
      const key = `${diag.file}:${diag.line}:${diag.column}:${diag.endLine}:${diag.endColumn}:${diag.code ?? ''}`
      quickFixReqIdRef.current += 1
      const myId = quickFixReqIdRef.current
      setQuickFixBanner(null)
      setQuickFix({
        key,
        file: diag.file,
        anchor: anchorRect,
        loading: true,
        actions: [],
      })
      if (!api) {
        setQuickFix({
          key,
          file: diag.file,
          anchor: anchorRect,
          loading: false,
          error: t.problems.lspUnavailable,
          actions: [],
        })
        return
      }
      try {
        const response = await api({
          filePath: diag.file,
          range: {
            start: { line: diag.line - 1, character: diag.column - 1 },
            end: { line: diag.endLine - 1, character: diag.endColumn - 1 },
          },
          context: {
            diagnostics: [
              {
                range: {
                  start: { line: diag.line - 1, character: diag.column - 1 },
                  end: { line: diag.endLine - 1, character: diag.endColumn - 1 },
                },
                severity:
                  diag.severity === 'error'
                    ? 1
                    : diag.severity === 'warning'
                    ? 2
                    : diag.severity === 'information'
                    ? 3
                    : 4,
                code: diag.code,
                source: diag.source,
                message: diag.message,
              },
            ],
          },
        })
        if (quickFixReqIdRef.current !== myId) return
        if (!response.success) {
          setQuickFix({
            key,
            file: diag.file,
            anchor: anchorRect,
            loading: false,
            error: response.error ?? t.problems.getFixesFailed,
            actions: [],
          })
          return
        }
        const actions = response.actions
          .map((a) => normalizeCodeAction(a))
          .filter((a): a is QuickFixAction => a !== null)
        setQuickFix({
          key,
          file: diag.file,
          anchor: anchorRect,
          loading: false,
          actions,
        })
      } catch (err) {
        if (quickFixReqIdRef.current !== myId) return
        setQuickFix({
          key,
          file: diag.file,
          anchor: anchorRect,
          loading: false,
          error: (err as Error).message,
          actions: [],
        })
      }
    },
    [t],
  )

  const runQuickFix = useCallback(
    async (action: QuickFixAction) => {
      if (!quickFix) return
      const lspApi = window.electronAPI?.lsp
      if (!lspApi) return
      setQuickFixApplying(true)
      setQuickFixBanner(null)
      try {
        let edit = action.edit
        let command = action.command
        if (!edit && lspApi.resolveCodeAction) {
          const resolved = await lspApi.resolveCodeAction({
            filePath: quickFix.file,
            action: action.raw,
          })
          if (resolved.success && resolved.action) {
            const r = resolved.action as Record<string, unknown>
            if (r.edit && typeof r.edit === 'object') edit = r.edit as Record<string, unknown>
            if (r.command && typeof r.command === 'object') {
              const c = r.command as { command?: string; arguments?: unknown[] }
              if (typeof c.command === 'string') {
                command = { command: c.command, arguments: c.arguments }
              }
            }
          }
        }

        if (edit && lspApi.applyWorkspaceEdit) {
          const r = await lspApi.applyWorkspaceEdit({ edit })
          if (!r.success) throw new Error(r.error ?? 'applyWorkspaceEdit failed')
          const applied = r.result
          if (applied && applied.failedPaths.length > 0) {
            setQuickFixBanner({
              kind: 'error',
              text: t.problems.applyPartFailed(applied.failedPaths
                .map((f) => f.reason)
                .join('; ')),
            })
          } else if (applied?.skippedFileOps?.length) {
            const reasons = applied.skippedFileOps
              .map((op) => `${op.kind}${op.reason ? ': ' + op.reason : ''}`)
              .join('; ')
            setQuickFixBanner({
              kind: 'info',
              text: t.problems.skippedOps(applied.skippedFileOps.length, reasons),
            })
          } else if (
            applied &&
            (applied.filesCreated.length > 0 ||
              applied.filesRenamed.length > 0 ||
              applied.filesDeleted.length > 0)
          ) {
            const parts: string[] = []
            if (applied.filesCreated.length > 0) parts.push(t.problems.created(applied.filesCreated.length))
            if (applied.filesRenamed.length > 0) parts.push(t.problems.renamed(applied.filesRenamed.length))
            if (applied.filesDeleted.length > 0) parts.push(t.problems.deleted(applied.filesDeleted.length))
            setQuickFixBanner({
              kind: 'info',
              text: t.problems.fileOpsDone(parts.join('、')),
            })
          }
        }

        if (command && lspApi.executeCommand) {
          const r = await lspApi.executeCommand({
            filePath: quickFix.file,
            command,
          })
          if (!r.success) throw new Error(r.error ?? 'executeCommand failed')
        }

        if (!edit && !command) {
          setQuickFixBanner({
            kind: 'error',
            text: t.problems.missingEditCommand,
          })
          return
        }

        setQuickFix(null)
      } catch (err) {
        setQuickFixBanner({
          kind: 'error',
          text: t.problems.applyFailed((err as Error).message),
        })
      } finally {
        setQuickFixApplying(false)
      }
    },
    [quickFix, t],
  )

  // Dismiss Quick Fix popover on outside click / escape.
  useEffect(() => {
    if (!quickFix) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeQuickFix()
    }
    const onClickOutside = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (!t) return
      if (!t.closest('.problems-quickfix-popover') && !t.closest('.problems-quickfix-btn')) {
        closeQuickFix()
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onClickOutside)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onClickOutside)
    }
  }, [quickFix, closeQuickFix])

  const rowContext = useMemo<RowContext>(
    () => ({
      rows,
      rootPath,
      expandedFiles,
      copiedFile,
      onToggleFileExpand: toggleFileExpand,
      onCopyFile: handleCopyFile,
      onDiagnosticClick: handleFileClick,
      onRelatedClick: handleFileClick,
      onOpenQuickFix: openQuickFix,
    }),
    [
      rows,
      rootPath,
      expandedFiles,
      copiedFile,
      toggleFileExpand,
      handleCopyFile,
      handleFileClick,
      openQuickFix,
    ],
  )

  const rowHeight = useMemo(() => rowHeightByIndex(rows), [rows])

  /* ------------------------------------------------------------------- render */

  if (diagnostics.length === 0) {
    return (
      <div className="problems-panel">
        <div className="problems-toolbar">
          <div className="problems-toolbar-left">
            <span className="problems-filter-label">
              {t.problems.show}
              <button
                className={`problems-filter-btn ${filterMode === 'all' ? 'active' : ''}`}
                onClick={() => setFilterMode('all')}
              >
                {t.problems.allFiles}
              </button>
              <button
                className={`problems-filter-btn ${filterMode === 'currentFile' ? 'active' : ''}`}
                onClick={() => setFilterMode('currentFile')}
              >
                {t.problems.currentFile}
              </button>
            </span>
          </div>
        </div>
        <div className="problems-empty">
          <span>{t.problems.noProblems}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="problems-panel">
      <div className="problems-toolbar">
        <div className="problems-toolbar-left">
          <span className="problems-filter-label">
            {t.problems.show}
            <button
              className={`problems-filter-btn ${filterMode === 'all' ? 'active' : ''}`}
              onClick={() => setFilterMode('all')}
            >
              {t.problems.allFiles}
            </button>
            <button
              className={`problems-filter-btn ${filterMode === 'currentFile' ? 'active' : ''}`}
              onClick={() => setFilterMode('currentFile')}
            >
              {t.problems.currentFile}
            </button>
          </span>
        </div>
        <div className="problems-toolbar-right">
          <div className="problems-counts">
            <span className="problems-count count-error" title={t.problems.errorsTitle(errorCount)}>
              <AlertCircle size={12} /> {errorCount}
            </span>
            <span className="problems-count count-warning" title={t.problems.warningsTitle(warningCount)}>
              <AlertTriangle size={12} /> {warningCount}
            </span>
            <span className="problems-count count-information" title={t.problems.infoTitle(infoCount)}>
              <Info size={12} /> {infoCount}
            </span>
          </div>
          <button
            className="problems-clear-btn"
            onClick={clearAllDiagnostics}
            title={t.problems.clearAll}
          >
            <X size={13} />
          </button>
        </div>
      </div>

      <div className="problems-severity-filter">
        {(['all', 'error', 'warning', 'information', 'hint'] as const).map((sev) => (
          <button
            key={sev}
            className={`problems-severity-btn ${severityFilter === sev ? 'active' : ''}`}
            onClick={() => setSeverityFilter(sev)}
            title={t.problems.filterTitle(sev === 'all' ? t.problems.all : sev)}
          >
            {severityIcons[sev === 'all' ? 'error' : sev]}
            <span>
              {sev === 'all'
                ? t.problems.allCount(filteredDiagnostics.length)
                : `${filteredDiagnostics.filter((d) => d.severity === sev).length}`}
            </span>
          </button>
        ))}
      </div>

      <div className="problems-list problems-list-virtual" ref={listContainerRef}>
        {listSize.height > 0 && rows.length > 0 && (
          <VariableSizeList<RowContext>
            ref={listRef}
            height={listSize.height}
            width={listSize.width || '100%'}
            itemCount={rows.length}
            itemSize={rowHeight}
            itemData={rowContext}
            /* Extra rows rendered above/below the viewport to smooth out
             * fast scrolling. 10 is a conservative default for row-heights
             * in the 22-28px range. */
            overscanCount={10}
            /* Stable item key keeps scroll position + DOM cache warm across
             * incremental patches from the Hub. */
            itemKey={(index) => {
              const row = rows[index]
              if (!row) return index
              if (row.kind === 'file-header') return `h:${row.file}`
              if (row.kind === 'diagnostic') {
                return `d:${row.diag.file}:${row.diag.line}:${row.diag.column}:${row.diag.code ?? ''}:${row.indexInFile}`
              }
              return `r:${row.parentDiag.file}:${row.parentDiag.line}:${row.parentDiag.column}:${row.indexInDiag}`
            }}
          >
            {VirtualRow}
          </VariableSizeList>
        )}
        {rows.length === 0 && (
          <div className="problems-empty">
            <span>{t.problems.noMatch}</span>
          </div>
        )}
      </div>

      {quickFix && quickFix.anchor && (
        <div
          className="problems-quickfix-popover"
          style={{
            top: Math.min(
              quickFix.anchor.top + quickFix.anchor.height + 4,
              window.innerHeight - 260,
            ),
            left: Math.min(quickFix.anchor.left, window.innerWidth - 340),
          }}
          role="dialog"
          aria-label="Quick Fix"
        >
          <div className="problems-quickfix-header">
            <Lightbulb size={12} />
            <span>{t.problems.quickFix}</span>
            <button
              type="button"
              className="problems-quickfix-close"
              onClick={closeQuickFix}
              title={t.problems.close}
            >
              <X size={11} />
            </button>
          </div>
          {quickFixBanner && (
            <div className={`problems-quickfix-banner problems-quickfix-banner-${quickFixBanner.kind}`}>
              {quickFixBanner.text}
            </div>
          )}
          {quickFix.loading ? (
            <div className="problems-quickfix-status">{t.problems.requestingLsp}</div>
          ) : quickFix.error ? (
            <div className="problems-quickfix-status problems-quickfix-status-error">
              {quickFix.error}
            </div>
          ) : quickFix.actions.length === 0 ? (
            <div className="problems-quickfix-status">{t.problems.noFixes}</div>
          ) : (
            <ul className="problems-quickfix-list">
              {quickFix.actions.map((action, idx) => (
                <li key={idx}>
                  <button
                    type="button"
                    className={`problems-quickfix-action${action.isPreferred ? ' preferred' : ''}`}
                    disabled={quickFixApplying}
                    onClick={() => void runQuickFix(action)}
                    title={action.kind ? `${action.title} (${action.kind})` : action.title}
                  >
                    <span className="problems-quickfix-action-title">
                      {action.title}
                    </span>
                    {action.kind && (
                      <span className="problems-quickfix-action-kind">{action.kind}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

/** Expose the per-row height map for ad-hoc consumers. */
export { PROBLEM_ROW_HEIGHTS }
