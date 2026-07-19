import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  GitBranch,
  FilePlus,
  FileEdit,
  Minus,
  Plus,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  RotateCcw,
  History,
  MoreHorizontal,
  FileDown,
} from 'lucide-react'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'
import {
  gitAdd,
  gitCheckoutCommitPaths,
  gitCommit,
  gitCommitFiles,
  gitInit,
  gitLog,
  gitRestorePaths,
  gitStatus,
  gitUnstage,
  isGitIdentityMissingError,
  type GitCommitFile,
  type GitLogEntry,
  type GitStatusPayload,
} from '../../services/git'
import { useT, type Messages } from '../../i18n'
import './GitPanel.css'

type StatusKind = 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed' | 'conflicted' | 'other'

function mapStatus(raw: string): StatusKind {
  const s = (raw || '').toLowerCase()
  if (s.includes('conflict') || s.includes('unmerged')) return 'conflicted'
  if (s.includes('untrack')) return 'untracked'
  if (s.includes('rename')) return 'renamed'
  if (s.includes('delete')) return 'deleted'
  if (s.includes('add') || s === 'a' || s === '?') return 'added'
  if (s.includes('modif') || s === 'm') return 'modified'
  return 'other'
}

const statusIcon = (kind: StatusKind) => {
  switch (kind) {
    case 'modified':
      return <FileEdit size={14} className="git-status git-modified" />
    case 'added':
      return <FilePlus size={14} className="git-status git-added" />
    case 'deleted':
      return <Minus size={14} className="git-status git-deleted" />
    case 'untracked':
      return <Plus size={14} className="git-status git-untracked" />
    case 'renamed':
      return <FileEdit size={14} className="git-status git-modified" />
    case 'conflicted':
      return <FileEdit size={14} className="git-status git-deleted" />
    default:
      return <FileEdit size={14} className="git-status" />
  }
}

const statusLabel = (kind: StatusKind) => {
  switch (kind) {
    case 'modified':
      return 'M'
    case 'added':
      return 'A'
    case 'deleted':
      return 'D'
    case 'untracked':
      return 'U'
    case 'renamed':
      return 'R'
    case 'conflicted':
      return '!'
    default:
      return '·'
  }
}

function formatRelative(iso: string, g: Messages['git']): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  const diff = Date.now() - t
  if (diff < 60_000) return g.justNow
  if (diff < 3_600_000) return g.minutesAgo(Math.floor(diff / 60_000))
  if (diff < 86_400_000) return g.hoursAgo(Math.floor(diff / 3_600_000))
  if (diff < 30 * 86_400_000) return g.daysAgo(Math.floor(diff / 86_400_000))
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

type CommitFilesState =
  | { loading: true }
  | { loading: false; files: GitCommitFile[] }
  | { loading: false; error: string }

const HISTORY_PAGE_SIZE = 20

export const GitPanel: React.FC = () => {
  const t = useT()
  const rootPath = useWorkspaceStore((s) => s.rootPath)
  const [status, setStatus] = useState<GitStatusPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [commitMsg, setCommitMsg] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [stagedOpen, setStagedOpen] = useState(true)
  const [changesOpen, setChangesOpen] = useState(true)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyLimit, setHistoryLimit] = useState(HISTORY_PAGE_SIZE)
  const [history, setHistory] = useState<GitLogEntry[] | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [expandedCommit, setExpandedCommit] = useState<string | null>(null)
  const [commitFilesMap, setCommitFilesMap] = useState<Record<string, CommitFilesState>>({})
  const [stageMenuOpen, setStageMenuOpen] = useState(false)
  const [commitMenuFor, setCommitMenuFor] = useState<string | null>(null)

  const lastRefreshRef = useRef(0)
  const lastHistoryRefreshRef = useRef(0)
  const stageMenuRef = useRef<HTMLDivElement>(null)
  const commitMenuRef = useRef<HTMLDivElement>(null)

  // Wipe per-workspace content state when the workspace switches. Without
  // this the panel is a long-lived component and leaks A's commit message,
  // error, history, expanded commit, cached commit-files, in-flight busy
  // flag and open menus into workspace B until each piece happens to be
  // re-fetched. Section toggle preferences (stagedOpen / changesOpen /
  // historyOpen) are user UI preferences, not content, so they persist.
  useEffect(() => {
    setStatus(null)
    setError(null)
    setCommitMsg('')
    setHistory(null)
    setHistoryError(null)
    setHistoryLimit(HISTORY_PAGE_SIZE)
    setExpandedCommit(null)
    setCommitFilesMap({})
    setBusy(null)
    setStageMenuOpen(false)
    setCommitMenuFor(null)
  }, [rootPath])

  const refresh = useCallback(async () => {
    if (!rootPath) {
      setStatus(null)
      setError(null)
      return
    }
    setLoading(true)
    const now = Date.now()
    lastRefreshRef.current = now
    try {
      const r = await gitStatus(rootPath)
      if (lastRefreshRef.current !== now) return
      setStatus(r)
      setError(r.ok ? null : r.error)
    } finally {
      if (lastRefreshRef.current === now) setLoading(false)
    }
  }, [rootPath])

  const refreshHistory = useCallback(
    async (limit: number) => {
      if (!rootPath) return
      setHistoryLoading(true)
      const now = Date.now()
      lastHistoryRefreshRef.current = now
      try {
        const r = await gitLog(rootPath, limit)
        // Drop the response if the workspace switched (or another history
        // refresh started) while we were waiting. Without this guard, the
        // slow `gitLog(A)` would overwrite `history` after the user has
        // already moved to workspace B.
        if (lastHistoryRefreshRef.current !== now) return
        if (r.ok) {
          setHistory(r.entries)
          setHistoryError(null)
        } else {
          setHistoryError(r.error)
        }
      } finally {
        if (lastHistoryRefreshRef.current === now) setHistoryLoading(false)
      }
    },
    [rootPath],
  )

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.electronAPI?.fs : undefined
    if (!api?.onWorkspaceFileChanged) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsub = api.onWorkspaceFileChanged(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        void refresh()
      }, 400)
    })
    return () => {
      if (timer) clearTimeout(timer)
      unsub()
    }
  }, [refresh])

  // History is deliberately *not* refreshed on every file watcher event — the
  // commit list only changes when HEAD moves, which happens after an explicit
  // commit/reset/checkout we control. Auto-refreshing on disk churn would be
  // wasted IPC and would rebuild the list every keystroke in the editor.
  useEffect(() => {
    if (!historyOpen) return
    if (!rootPath) return
    void refreshHistory(historyLimit)
  }, [historyOpen, historyLimit, rootPath, refreshHistory])

  useEffect(() => {
    if (!stageMenuOpen) return
    const onDoc = (e: MouseEvent) => {
      if (stageMenuRef.current && !stageMenuRef.current.contains(e.target as Node)) {
        setStageMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [stageMenuOpen])

  useEffect(() => {
    if (!commitMenuFor) return
    const onDoc = (e: MouseEvent) => {
      if (commitMenuRef.current && !commitMenuRef.current.contains(e.target as Node)) {
        setCommitMenuFor(null)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [commitMenuFor])

  const handleInit = useCallback(async () => {
    if (!rootPath) return
    setBusy('init')
    try {
      const r = await gitInit(rootPath)
      if (!r.ok) setError(r.error)
      await refresh()
    } finally {
      setBusy(null)
    }
  }, [rootPath, refresh])

  const handleStageAll = useCallback(
    async (mode: 'all' | 'tracked') => {
      if (!rootPath) return
      setBusy(mode === 'all' ? 'stage-all' : 'stage-tracked')
      try {
        const r = await gitAdd(rootPath, mode)
        if (!r.ok) setError(r.error)
        await refresh()
      } finally {
        setBusy(null)
      }
    },
    [rootPath, refresh],
  )

  const handleStageOne = useCallback(
    async (p: string) => {
      if (!rootPath) return
      setBusy(`stage:${p}`)
      try {
        const r = await gitAdd(rootPath, [p])
        if (!r.ok) setError(r.error)
        await refresh()
      } finally {
        setBusy(null)
      }
    },
    [rootPath, refresh],
  )

  const handleUnstageOne = useCallback(
    async (p: string) => {
      if (!rootPath) return
      setBusy(`unstage:${p}`)
      try {
        const r = await gitUnstage(rootPath, [p])
        if (!r.ok) setError(r.error)
        await refresh()
      } finally {
        setBusy(null)
      }
    },
    [rootPath, refresh],
  )

  const handleDiscardOne = useCallback(
    async (p: string, untracked: boolean) => {
      if (!rootPath) return
      const ok = window.confirm(
        untracked
          ? t.git.discardUntrackedConfirm(p)
          : t.git.discardWorktreeConfirm(p),
      )
      if (!ok) return
      setBusy(`discard:${p}`)
      try {
        const r = await gitRestorePaths(rootPath, [p], untracked ? 'untracked' : 'worktree')
        if (!r.ok) setError(r.error)
        await refresh()
      } finally {
        setBusy(null)
      }
    },
    [rootPath, refresh, t],
  )

  const handleRestoreStagedToHead = useCallback(
    async (p: string) => {
      if (!rootPath) return
      const ok = window.confirm(
        t.git.restoreHeadConfirm(p),
      )
      if (!ok) return
      setBusy(`restore-head:${p}`)
      try {
        const r = await gitRestorePaths(rootPath, [p], 'head')
        if (!r.ok) setError(r.error)
        await refresh()
      } finally {
        setBusy(null)
      }
    },
    [rootPath, refresh, t],
  )

  const handleRestoreFromCommit = useCallback(
    async (hash: string, filePath: string) => {
      if (!rootPath) return
      const ok = window.confirm(
        t.git.restoreFromCommitConfirm(hash.slice(0, 7), filePath),
      )
      if (!ok) return
      setBusy(`restore-commit:${hash}:${filePath}`)
      try {
        const r = await gitCheckoutCommitPaths(rootPath, hash, [filePath])
        if (!r.ok) setError(r.error)
        await refresh()
      } finally {
        setBusy(null)
      }
    },
    [rootPath, refresh, t],
  )

  const handleCommit = useCallback(async () => {
    if (!rootPath) return
    const msg = commitMsg.trim()
    if (!msg) {
      setError(t.git.enterCommitMessage)
      return
    }
    setBusy('commit')
    try {
      const r = await gitCommit(rootPath, msg)
      if (!r.ok) {
        if (isGitIdentityMissingError(r.error)) {
          setError(t.git.identityMissing)
        } else {
          setError(r.error)
        }
      } else {
        setCommitMsg('')
        setError(null)
        if (historyOpen) void refreshHistory(historyLimit)
      }
      await refresh()
    } finally {
      setBusy(null)
    }
  }, [rootPath, commitMsg, refresh, historyOpen, refreshHistory, historyLimit, t])

  const toggleCommitExpand = useCallback(
    async (hash: string) => {
      const cur = expandedCommit === hash ? null : hash
      setExpandedCommit(cur)
      if (!cur || !rootPath) return
      if (commitFilesMap[hash] && !('error' in commitFilesMap[hash])) return
      setCommitFilesMap((m) => ({ ...m, [hash]: { loading: true } }))
      const r = await gitCommitFiles(rootPath, hash)
      setCommitFilesMap((m) => ({
        ...m,
        [hash]: r.ok
          ? { loading: false, files: r.files }
          : { loading: false, error: r.error },
      }))
    },
    [expandedCommit, rootPath, commitFilesMap],
  )

  const handleCopyHash = useCallback((hash: string, short: boolean) => {
    const v = short ? hash.slice(0, 7) : hash
    void navigator.clipboard.writeText(v).catch(() => {})
    setCommitMenuFor(null)
  }, [])

  const handleCopyMessage = useCallback(
    (hash: string) => {
      const entry = history?.find((e) => e.hash === hash)
      if (entry) void navigator.clipboard.writeText(entry.message).catch(() => {})
      setCommitMenuFor(null)
    },
    [history],
  )

  const loadMoreHistory = useCallback(() => {
    setHistoryLimit((n) => n + HISTORY_PAGE_SIZE)
  }, [])

  // ---------------------------------------------------------- early returns

  if (!rootPath) {
    return (
      <div className="git-panel">
        <div className="git-empty">
          <p>{t.git.noFolder}</p>
          <p className="git-empty-sub">{t.git.noFolderSub}</p>
        </div>
      </div>
    )
  }

  if (status && !status.ok) {
    return (
      <div className="git-panel">
        <div className="git-panel-header">
          <GitBranch size={14} />
          <span className="git-branch-name">{t.git.title}</span>
          <button
            type="button"
            className="sidebar-action-btn git-sync-icon"
            title={t.git.refresh}
            onClick={() => void refresh()}
          >
            <RefreshCw size={12} className={loading ? 'git-spin' : ''} />
          </button>
        </div>
        <div className="git-empty">
          <p className="git-error">{status.error}</p>
        </div>
      </div>
    )
  }

  if (status && status.ok && !status.isRepo) {
    return (
      <div className="git-panel">
        <div className="git-panel-header">
          <GitBranch size={14} />
          <span className="git-branch-name">{t.git.repoNotInit}</span>
          <button
            type="button"
            className="sidebar-action-btn git-sync-icon"
            title={t.git.refresh}
            onClick={() => void refresh()}
          >
            <RefreshCw size={12} className={loading ? 'git-spin' : ''} />
          </button>
        </div>
        <div className="git-empty">
          <p>{t.git.notRepo}</p>
          <button
            type="button"
            className="explorer-open-btn"
            disabled={busy === 'init'}
            onClick={() => void handleInit()}
          >
            {busy === 'init' ? t.git.initializing : t.git.initRepo}
          </button>
        </div>
      </div>
    )
  }

  if (!status) {
    return (
      <div className="git-panel">
        <div className="git-panel-header">
          <GitBranch size={14} />
          <span className="git-branch-name">{t.git.loading}</span>
        </div>
      </div>
    )
  }

  const staged = status.staged
  const unstaged = status.unstaged
  const branchLabel = status.detached
    ? t.git.detachedHead(status.branch.slice(0, 8))
    : status.branch || t.git.headLabel
  const trackingLine =
    !status.detached && (status.ahead > 0 || status.behind > 0 || status.tracking)
      ? t.git.tracking(status.tracking ?? '—', status.ahead, status.behind)
      : null

  const hasUntrackedInUnstaged = unstaged.some((c) => mapStatus(c.status) === 'untracked')

  return (
    <div className="git-panel">
      <div className="git-panel-header">
        <GitBranch size={14} />
        <span className="git-branch-name" title={branchLabel}>
          {branchLabel}
        </span>
        <button
          type="button"
          className="sidebar-action-btn git-sync-icon"
          title={t.git.refresh}
          onClick={() => void refresh()}
        >
          <RefreshCw size={12} className={loading ? 'git-spin' : ''} />
        </button>
      </div>
      {trackingLine ? <div className="git-tracking">{trackingLine}</div> : null}

      <div className="git-commit-box">
        <textarea
          className="git-commit-message"
          placeholder={staged.length ? t.git.commitPlaceholder : t.git.commitPlaceholderEmpty}
          value={commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
          rows={2}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault()
              if (staged.length > 0 && busy !== 'commit') void handleCommit()
            }
          }}
        />
        <button
          type="button"
          className="git-commit-btn"
          disabled={staged.length === 0 || !commitMsg.trim() || busy === 'commit'}
          onClick={() => void handleCommit()}
        >
          {busy === 'commit' ? t.git.committing : t.git.commit(staged.length)}
        </button>
        {unstaged.length > 0 ? (
          <div className="git-split-btn" ref={stageMenuRef}>
            <button
              type="button"
              className="git-secondary-btn git-split-main"
              disabled={busy === 'stage-all' || busy === 'stage-tracked'}
              onClick={() => void handleStageAll('all')}
              title={t.git.stageAllTitle}
            >
              {busy === 'stage-all'
                ? t.git.staging
                : t.git.stageAll(unstaged.length)}
            </button>
            {hasUntrackedInUnstaged ? (
              <button
                type="button"
                className="git-secondary-btn git-split-caret"
                aria-label={t.git.moreStageOptions}
                disabled={busy === 'stage-all' || busy === 'stage-tracked'}
                onClick={() => setStageMenuOpen((v) => !v)}
                title={t.git.moreStageOptions}
              >
                <ChevronDown size={12} />
              </button>
            ) : null}
            {stageMenuOpen ? (
              <div className="git-menu">
                <button
                  type="button"
                  className="git-menu-item"
                  onClick={() => {
                    setStageMenuOpen(false)
                    void handleStageAll('tracked')
                  }}
                  disabled={busy === 'stage-tracked'}
                >
                  <div className="git-menu-title">
                    {busy === 'stage-tracked' ? t.git.staging : t.git.stageTrackedOnly}
                  </div>
                  <div className="git-menu-sub">
                    {t.git.stageTrackedSub}
                  </div>
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {error ? <div className="git-error" role="alert">{error}</div> : null}
      {status.truncated ? (
        <div className="git-notice">{t.git.truncatedNotice(status.totalCount)}</div>
      ) : null}

      <div className="git-section">
        <div
          className="git-section-header git-section-toggle"
          onClick={() => setStagedOpen((v) => !v)}
        >
          {stagedOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span>{t.git.staged}</span>
          <span className="git-section-count">{staged.length}</span>
        </div>
        {stagedOpen && staged.length > 0 ? (
          <div className="git-file-list">
            {staged.map((c) => {
              const kind = mapStatus(c.status)
              return (
                <div key={`s:${c.path}`} className="git-file-item" title={c.path}>
                  {statusIcon(kind)}
                  <span className="git-file-name">{c.path}</span>
                  <button
                    type="button"
                    className="git-inline-btn"
                    title={t.git.restoreToHeadTitle}
                    disabled={busy === `restore-head:${c.path}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      void handleRestoreStagedToHead(c.path)
                    }}
                  >
                    <RotateCcw size={12} />
                  </button>
                  <button
                    type="button"
                    className="git-inline-btn"
                    title={t.git.unstageTitle}
                    disabled={busy === `unstage:${c.path}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      void handleUnstageOne(c.path)
                    }}
                  >
                    <Minus size={12} />
                  </button>
                  <span
                    className={`git-file-status git-badge-${kind === 'other' ? 'modified' : kind}`}
                  >
                    {statusLabel(kind)}
                  </span>
                </div>
              )
            })}
          </div>
        ) : null}
      </div>

      <div className="git-section">
        <div
          className="git-section-header git-section-toggle"
          onClick={() => setChangesOpen((v) => !v)}
        >
          {changesOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <span>{t.git.unstagedChanges}</span>
          <span className="git-section-count">{unstaged.length}</span>
        </div>
        {changesOpen && unstaged.length > 0 ? (
          <div className="git-file-list">
            {unstaged.map((c) => {
              const kind = mapStatus(c.status)
              return (
                <div key={`u:${c.path}`} className="git-file-item" title={c.path}>
                  {statusIcon(kind)}
                  <span className="git-file-name">{c.path}</span>
                  <button
                    type="button"
                    className="git-inline-btn"
                    title={
                      kind === 'untracked'
                        ? t.git.discardUntrackedTitle
                        : t.git.discardWorktreeTitle
                    }
                    disabled={busy === `discard:${c.path}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      void handleDiscardOne(c.path, kind === 'untracked')
                    }}
                  >
                    <span aria-hidden="true">↶</span>
                  </button>
                  <button
                    type="button"
                    className="git-inline-btn"
                    title={t.git.stage}
                    disabled={busy === `stage:${c.path}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      void handleStageOne(c.path)
                    }}
                  >
                    <Plus size={12} />
                  </button>
                  <span
                    className={`git-file-status git-badge-${kind === 'other' ? 'modified' : kind}`}
                  >
                    {statusLabel(kind)}
                  </span>
                </div>
              )
            })}
          </div>
        ) : null}
      </div>

      {staged.length === 0 && unstaged.length === 0 ? (
        <div className="git-empty">
          <p>{t.git.cleanTree}</p>
        </div>
      ) : null}

      {/* ----- 提交历史 ----- */}
      <CommitHistorySection
        open={historyOpen}
        toggleOpen={() => setHistoryOpen((v) => !v)}
        loading={historyLoading}
        error={historyError}
        history={history}
        expandedCommit={expandedCommit}
        onToggleCommit={(h) => void toggleCommitExpand(h)}
        commitFilesMap={commitFilesMap}
        onRefresh={() => void refreshHistory(historyLimit)}
        onLoadMore={loadMoreHistory}
        hasReachedLimit={history != null && history.length < historyLimit}
        commitMenuFor={commitMenuFor}
        setCommitMenuFor={setCommitMenuFor}
        commitMenuRef={commitMenuRef}
        onCopyHash={handleCopyHash}
        onCopyMessage={handleCopyMessage}
        onRestoreFile={(hash, p) => void handleRestoreFromCommit(hash, p)}
        busy={busy}
      />
    </div>
  )
}

// ---------------------------------------------------------- history section

interface HistorySectionProps {
  open: boolean
  toggleOpen: () => void
  loading: boolean
  error: string | null
  history: GitLogEntry[] | null
  expandedCommit: string | null
  onToggleCommit: (hash: string) => void
  commitFilesMap: Record<string, CommitFilesState>
  onRefresh: () => void
  onLoadMore: () => void
  /** True when the backend returned fewer entries than the current limit (i.e. end of log). */
  hasReachedLimit: boolean
  commitMenuFor: string | null
  setCommitMenuFor: (v: string | null) => void
  commitMenuRef: React.RefObject<HTMLDivElement | null>
  onCopyHash: (hash: string, short: boolean) => void
  onCopyMessage: (hash: string) => void
  onRestoreFile: (hash: string, path: string) => void
  busy: string | null
}

const CommitHistorySection: React.FC<HistorySectionProps> = ({
  open,
  toggleOpen,
  loading,
  error,
  history,
  expandedCommit,
  onToggleCommit,
  commitFilesMap,
  onRefresh,
  onLoadMore,
  hasReachedLimit,
  commitMenuFor,
  setCommitMenuFor,
  commitMenuRef,
  onCopyHash,
  onCopyMessage,
  onRestoreFile,
  busy,
}) => {
  const t = useT()
  const count = history?.length ?? 0

  const headerRow = useMemo(
    () => (
      <div className="git-section-header git-section-toggle" onClick={toggleOpen}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>{t.git.history}</span>
        {open && history != null ? <span className="git-section-count">{count}</span> : null}
        {open ? (
          <button
            type="button"
            className="sidebar-action-btn git-history-refresh"
            title={t.git.refreshHistory}
            onClick={(e) => {
              e.stopPropagation()
              onRefresh()
            }}
          >
            <RefreshCw size={11} className={loading ? 'git-spin' : ''} />
          </button>
        ) : null}
      </div>
    ),
    [open, toggleOpen, history, count, loading, onRefresh, t],
  )

  return (
    <div className="git-section">
      {headerRow}
      {!open ? null : (
        <div className="git-history">
          {loading && !history ? <div className="git-notice">{t.git.loading}</div> : null}
          {error ? <div className="git-error">{error}</div> : null}
          {history && history.length === 0 ? (
            <div className="git-empty">
              <p>{t.git.noCommits}</p>
            </div>
          ) : null}
          {history?.map((e) => {
            const isExpanded = expandedCommit === e.hash
            const fileState = commitFilesMap[e.hash]
            return (
              <div
                key={e.hash}
                className={`git-commit-row ${isExpanded ? 'is-expanded' : ''}`}
              >
                <div
                  className="git-commit-main"
                  onClick={() => onToggleCommit(e.hash)}
                  title={`${e.hash}\n${e.author || ''} · ${e.date}\n\n${e.message}`}
                >
                  {isExpanded ? (
                    <ChevronDown size={12} className="git-commit-chevron" />
                  ) : (
                    <ChevronRight size={12} className="git-commit-chevron" />
                  )}
                  <History size={12} className="git-commit-icon" />
                  <span className="git-commit-hash">{e.hash.slice(0, 7)}</span>
                  <span className="git-commit-message-line">
                    {e.message.split('\n')[0] || t.git.noMessage}
                  </span>
                  <span className="git-commit-meta">{formatRelative(e.date, t.git)}</span>
                  <button
                    type="button"
                    className="git-inline-btn git-commit-menu-btn"
                    title={t.git.moreActions}
                    onClick={(evt) => {
                      evt.stopPropagation()
                      setCommitMenuFor(commitMenuFor === e.hash ? null : e.hash)
                    }}
                  >
                    <MoreHorizontal size={12} />
                  </button>
                  {commitMenuFor === e.hash ? (
                    <div
                      ref={commitMenuRef}
                      className="git-menu git-commit-menu"
                      onClick={(evt) => evt.stopPropagation()}
                    >
                      <button
                        type="button"
                        className="git-menu-item"
                        onClick={() => onCopyHash(e.hash, true)}
                      >
                        <div className="git-menu-title">{t.git.copyShortHash(e.hash.slice(0, 7))}</div>
                      </button>
                      <button
                        type="button"
                        className="git-menu-item"
                        onClick={() => onCopyHash(e.hash, false)}
                      >
                        <div className="git-menu-title">{t.git.copyFullHash}</div>
                      </button>
                      <button
                        type="button"
                        className="git-menu-item"
                        onClick={() => onCopyMessage(e.hash)}
                      >
                        <div className="git-menu-title">{t.git.copyMessage}</div>
                      </button>
                    </div>
                  ) : null}
                </div>
                {isExpanded ? (
                  <div className="git-commit-files">
                    {!fileState || fileState.loading ? (
                      <div className="git-notice">{t.git.loading}</div>
                    ) : 'error' in fileState ? (
                      <div className="git-error">{fileState.error}</div>
                    ) : fileState.files.length === 0 ? (
                      <div className="git-notice">{t.git.commitNoFiles}</div>
                    ) : (
                      fileState.files.map((f) => {
                        const kind = mapStatus(f.status)
                        const displayPath = f.fromPath
                          ? `${f.fromPath} → ${f.path}`
                          : f.path
                        const key = `restore-commit:${e.hash}:${f.path}`
                        return (
                          <div
                            key={`${e.hash}:${f.path}`}
                            className="git-file-item git-history-file"
                            title={displayPath}
                          >
                            {statusIcon(kind)}
                            <span className="git-file-name">{displayPath}</span>
                            <button
                              type="button"
                              className="git-inline-btn"
                              title={t.git.restoreFileTitle}
                              disabled={busy === key || kind === 'deleted'}
                              onClick={(evt) => {
                                evt.stopPropagation()
                                onRestoreFile(e.hash, f.path)
                              }}
                            >
                              <FileDown size={12} />
                            </button>
                            <span
                              className={`git-file-status git-badge-${kind === 'other' ? 'modified' : kind}`}
                            >
                              {statusLabel(kind)}
                            </span>
                          </div>
                        )
                      })
                    )}
                  </div>
                ) : null}
              </div>
            )
          })}
          {history && history.length > 0 && !hasReachedLimit ? (
            <button
              type="button"
              className="git-history-load-more"
              onClick={onLoadMore}
              disabled={loading}
            >
              {loading ? t.git.loading : t.git.loadMore}
            </button>
          ) : null}
          {history && history.length > 0 && hasReachedLimit ? (
            <div className="git-notice git-history-end">{t.git.historyEnd}</div>
          ) : null}
        </div>
      )}
    </div>
  )
}
