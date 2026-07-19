/**
 * RunningAgentsPanel —— 运行中的智能体面板（Phase 3 Sprint 3.1a）
 *
 * 展示主进程 ActiveAgentRegistry 当前的所有 agent(主聊天 + 子智能体 +
 * 异步智能体),让用户能:
 *   - 一眼看到并发/排队情况
 *   - 看到每个 agent 的运行耗时、Token 用量、待处理消息数
 *   - 终止失控 / 长时间未结束的 agent
 *
 * 面板形态:全屏 modal overlay(和工作台同款),按 ActivityBar 里的
 * "运行中的智能体" 图标打开。
 *
 * 刷新策略:面板可见时每 1.5s 轮询一次 `agents:list-active`;
 * 不可见时完全不轮询。选择轮询而非广播是因为 ActiveAgent 的几乎每
 * 一个字段(elapsedMs / tokenCount / pendingMessageCount)都是"活数
 * 据",需要连续更新,用广播会爆量。
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  X,
  Activity,
  Bot,
  Users,
  StopCircle,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  Clock,
  Coins,
  MessageSquare,
  Search,
  ChevronRight,
} from 'lucide-react'
import { useLayoutStore } from '../../stores/useLayoutStore'
import { useBundleList } from '../../stores/bundleStore'
import { AgentDetailsDrawer } from './AgentDetailsDrawer'
import { SimpleVirtualList } from '../common/SimpleVirtualList'
import { AgentFleetView } from './AgentFleetView'
import { LayoutList, LayoutGrid } from 'lucide-react'
import './RunningAgentsPanel.css'

interface ActiveAgentRow {
  agentId: string
  agentType: string
  description: string
  name?: string
  teamName?: string
  status: 'running' | 'completed' | 'failed' | 'killed'
  startTime: number
  endedAt?: number
  elapsedMs: number
  tokenCount: number
  maxTokenBudget: number
  tokenBudgetExceeded: boolean
  timeoutMs: number
  pendingMessageCount: number
  parentAgentId?: string
  streamConversationId?: string
  background: boolean
  model?: string
  /**
   * P1-1: spawn-time permission mode snapshot. `'plan'` ⇒ read-only
   * teammate (or plan-approval-gated), `'bypassPermissions'` /
   * `'acceptEdits'` ⇒ elevated auto-mutation, `'default'` ⇒ standard
   * approval flow. `undefined` for legacy/resumed records — no badge.
   */
  permissionMode?: string
  /** Sprint 3.4: 来自磁盘历史(上次运行时的) */
  fromDisk?: boolean
}

/**
 * P1-1: which permission-mode values get a colored badge in the panel.
 * `default` is the silent baseline — rendering a badge for every row would
 * just add noise. Only show modes that are *meaningfully different* from
 * the default approval flow.
 */
const PERMISSION_MODE_BADGE: Record<
  string,
  { label: string; title: string; tone: 'plan' | 'bypass' | 'accept' | 'deny' }
> = {
  plan: {
    label: 'Plan',
    title: '只读 Plan 模式 — 需用户审批后才能变更文件',
    tone: 'plan',
  },
  bypassPermissions: {
    label: 'Bypass',
    title: '已绕过权限询问 — 工具调用直接放行',
    tone: 'bypass',
  },
  acceptEdits: {
    label: 'Auto-Edits',
    title: '自动批准文件编辑;非编辑工具仍走确认',
    tone: 'accept',
  },
  dontAsk: {
    label: 'DontAsk',
    title: '严格模式 — 未预批准的工具调用一律拒绝',
    tone: 'deny',
  },
}

const POLL_INTERVAL_MS = 1500

const STATUS_LABEL: Record<ActiveAgentRow['status'], string> = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  killed: '已终止',
}

const STATUS_ICON: Record<ActiveAgentRow['status'], React.ElementType> = {
  running: Loader2,
  completed: CheckCircle2,
  failed: AlertTriangle,
  killed: StopCircle,
}

// BUG-U2 fix: defensive fallback for any future / unexpected status string
// arriving from the IPC bridge. Prevents `STATUS_ICON[unknown]` →
// `undefined` → React render crash.
const FALLBACK_STATUS_ICON: React.ElementType = Activity

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const s = Math.round(ms / 100) / 10 // 保留 1 位小数
  if (s < 60) return `${s.toFixed(1)}s`
  const mins = Math.floor(s / 60)
  const secs = Math.floor(s % 60)
  return `${mins}m ${secs.toString().padStart(2, '0')}s`
}

function formatTokens(n: number): string {
  if (n < 1000) return n.toString()
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

export const RunningAgentsPanel: React.FC = () => {
  const visible = useLayoutStore((s) => s.runningAgentsPanelVisible)
  const setVisible = useLayoutStore((s) => s.setRunningAgentsPanelVisible)
  const bundles = useBundleList()

  // 把 bundles 里所有 agent 的 agentType → displayName 建成一张表
  // 供面板给冷冰冰的 agentType 补个人话名。
  const agentDisplayNames = useMemo(() => {
    const map = new Map<string, string>()
    for (const b of bundles) {
      for (const a of b.agents) {
        if (a.displayName && !map.has(a.agentType)) {
          map.set(a.agentType, a.displayName)
        }
      }
    }
    return map
  }, [bundles])

  const [rows, setRows] = useState<ActiveAgentRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [aborting, setAborting] = useState<Set<string>>(new Set())
  // Sprint 3.1b: 状态过滤 / 搜索 / 父节点折叠
  const [statusFilter, setStatusFilter] = useState<
    'all' | 'running' | 'completed' | 'failed' | 'killed'
  >('all')
  const [query, setQuery] = useState('')
  const [collapsedParents, setCollapsedParents] = useState<Set<string>>(new Set())
  // Sprint 3.1c: 选中哪个 agent 查看详情(null = 没打开抽屉)
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  // 新方向 A: 列表 / 大屏 视图模式
  const [viewMode, setViewMode] = useState<'list' | 'fleet'>('list')

  const toggleParent = useCallback((parentId: string) => {
    setCollapsedParents((prev) => {
      const next = new Set(prev)
      if (next.has(parentId)) next.delete(parentId)
      else next.add(parentId)
      return next
    })
  }, [])

  const fetchSnapshot = useCallback(async () => {
    const bridge =
      typeof window !== 'undefined'
        ? (window as unknown as { electronAPI?: Window['electronAPI'] }).electronAPI
            ?.agents
        : undefined
    if (!bridge?.listActive) {
      setError('当前环境未提供「运行中的智能体」接口。')
      return
    }
    try {
      const res = await bridge.listActive()
      // 按启动时间降序:最近的在最上面
      const sorted = res.agents.slice().sort((a, b) => b.startTime - a.startTime)
      setRows(sorted)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  // 打开面板 → 立刻取一次 + 定时轮询。关闭面板 → 清定时器。
  useEffect(() => {
    if (!visible) return
    setLoading(true)
    void fetchSnapshot().finally(() => setLoading(false))
    const handle = window.setInterval(() => {
      void fetchSnapshot()
    }, POLL_INTERVAL_MS)
    return () => {
      window.clearInterval(handle)
    }
  }, [visible, fetchSnapshot])

  // Esc 关闭面板 —— 但如果抽屉开着,优先由抽屉的 capture-phase
  // keydown 监听拦截并仅关抽屉,不穿透到这里。这里保留非 capture,
  // 让抽屉先消费。
  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // 若抽屉打开,AgentDetailsDrawer 的 capture 监听已经 stopPropagation + close 了;
        // 这里收不到事件。没抽屉时,走正常关面板流程。
        e.preventDefault()
        setVisible(false)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [visible, setVisible])

  // 面板关闭时顺便清抽屉选中,避免下次打开还"记着"上次选的 agent
  useEffect(() => {
    if (!visible) setSelectedAgentId(null)
  }, [visible])

  const handleAbort = useCallback(
    async (agentId: string, label: string) => {
      const ok = window.confirm(
        `确定要终止「${label}」吗？\n\n终止后该 agent 的本次运行将立即停止,未完成的任务不会被恢复。`,
      )
      if (!ok) return
      setAborting((prev) => {
        const next = new Set(prev)
        next.add(agentId)
        return next
      })
      try {
        const bridge =
          typeof window !== 'undefined'
            ? (window as unknown as { electronAPI?: Window['electronAPI'] }).electronAPI
                ?.agents
            : undefined
        if (!bridge?.abortActive) {
          window.alert('当前环境未提供终止接口。')
          return
        }
        const res = await bridge.abortActive({ agentId })
        if (!res.ok) {
          window.alert(`终止失败:${res.error}`)
        }
        // 立即刷一次快照,让用户看到状态变成"已终止"
        await fetchSnapshot()
      } catch (err) {
        window.alert(`终止失败:${err instanceof Error ? err.message : String(err)}`)
      } finally {
        setAborting((prev) => {
          const next = new Set(prev)
          next.delete(agentId)
          return next
        })
      }
    },
    [fetchSnapshot],
  )

  // Sprint 3.1b: 状态计数(总表,不受搜索影响;只受 filter 影响的是展示)
  const statusCounts = useMemo(() => {
    const c = { all: rows.length, running: 0, completed: 0, failed: 0, killed: 0 }
    for (const r of rows) c[r.status] = (c[r.status] ?? 0) + 1
    return c
  }, [rows])

  // Sprint 3.1b: 树构建 + 过滤
  //
  // 思路: 先按 status+query 过滤出候选集,再按 parentAgentId 构树。
  // 边界:若一个子 agent 通过了过滤,但其父 agent 没过,子仍作为"顶层
  // 孤儿"显示(保证用户看得到相关数据)。反之父过了子没过,父独立
  // 显示且无展开箭头。
  type TreeNode = { row: ActiveAgentRow; depth: number; hasChildren: boolean }
  const treeEntries: TreeNode[] = useMemo(() => {
    const q = query.trim().toLowerCase()
    const rowById = new Map(rows.map((r) => [r.agentId, r]))

    const matches = (r: ActiveAgentRow): boolean => {
      if (statusFilter !== 'all' && r.status !== statusFilter) return false
      if (!q) return true
      const hay = [r.agentId, r.agentType, r.name, r.teamName, r.description, r.model]
        .filter((s): s is string => typeof s === 'string')
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    }

    const filtered = rows.filter(matches)
    const filteredIds = new Set(filtered.map((r) => r.agentId))

    const isTopLevel = (r: ActiveAgentRow): boolean => {
      // 'main' / undefined / 指向一个已过滤掉的父 → 当作顶层(孤儿)
      if (!r.parentAgentId || r.parentAgentId === 'main') return true
      if (!rowById.has(r.parentAgentId)) return true
      if (!filteredIds.has(r.parentAgentId)) return true
      return false
    }

    const byParent = new Map<string, ActiveAgentRow[]>()
    for (const r of filtered) {
      const pid = r.parentAgentId ?? '__root__'
      const arr = byParent.get(pid) ?? []
      arr.push(r)
      byParent.set(pid, arr)
    }

    // 按 startTime 降序(新到旧)。对每个 parent bucket 都排。
    for (const arr of byParent.values()) {
      arr.sort((a, b) => b.startTime - a.startTime)
    }

    const out: TreeNode[] = []
    const visit = (r: ActiveAgentRow, depth: number): void => {
      const children = byParent.get(r.agentId) ?? []
      out.push({ row: r, depth, hasChildren: children.length > 0 })
      if (collapsedParents.has(r.agentId)) return
      for (const child of children) {
        visit(child, depth + 1)
      }
    }

    const topLevel = filtered.filter(isTopLevel)
    topLevel.sort((a, b) => b.startTime - a.startTime)
    for (const r of topLevel) visit(r, 0)

    return out
  }, [rows, statusFilter, query, collapsedParents])

  if (!visible) return null

  const runningCount = rows.filter((r) => r.status === 'running').length

  return (
    <div
      className="running-agents-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="运行中的智能体"
    >
      <div
        className="running-agents-backdrop"
        onClick={() => setVisible(false)}
        aria-hidden="true"
      />
      <div className="running-agents-surface" onClick={(e) => e.stopPropagation()}>
        <header className="running-agents-header">
          <div className="running-agents-header-title">
            <Activity size={15} className="running-agents-header-icon" />
            <span className="running-agents-title">运行中的智能体</span>
            <span className="running-agents-subtitle">
              {loading && rows.length === 0
                ? '加载中…'
                : `${runningCount} 运行中 · ${rows.length - runningCount} 历史记录`}
            </span>
          </div>
          <div className="running-agents-header-actions">
            <button
              type="button"
              className="running-agents-icon-btn"
              onClick={() => void fetchSnapshot()}
              title="立即刷新"
            >
              <RefreshCw size={13} />
            </button>
            <button
              type="button"
              className="running-agents-icon-btn"
              onClick={() => setVisible(false)}
              title="关闭 (Esc)"
              aria-label="关闭"
            >
              <X size={15} />
            </button>
          </div>
        </header>

        {error ? (
          <div className="running-agents-error" role="alert">
            <AlertTriangle size={12} />
            <span>{error}</span>
          </div>
        ) : null}

        {/* Sprint 3.1b: 搜索 + 状态过滤条 */}
        <div className="running-agents-toolbar">
          <div className="running-agents-search">
            <Search size={12} className="running-agents-search-icon" />
            <input
              type="text"
              placeholder="按名称 / 类型 / 团队 / 描述 / ID 搜索…"
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && query) {
                  e.preventDefault()
                  e.stopPropagation()
                  setQuery('')
                }
              }}
            />
            {query ? (
              <button
                type="button"
                className="running-agents-search-clear"
                onClick={() => setQuery('')}
                title="清除搜索"
              >
                <X size={10} />
              </button>
            ) : null}
          </div>
          <div className="running-agents-status-tabs" role="tablist">
            {(['all', 'running', 'completed', 'failed', 'killed'] as const).map((s) => {
              const n = statusCounts[s]
              if (s !== 'all' && n === 0) return null
              const label =
                s === 'all' ? '全部' : s === 'running' ? '运行中' : STATUS_LABEL[s]
              return (
                <button
                  key={s}
                  type="button"
                  role="tab"
                  aria-selected={statusFilter === s}
                  className={`running-agents-status-tab ${statusFilter === s ? 'is-active' : ''} status-${s}`}
                  onClick={() => setStatusFilter(s)}
                >
                  <span>{label}</span>
                  <span className="running-agents-status-tab-count">{n}</span>
                </button>
              )
            })}
          </div>

          {/* 新方向 A: 列表 / 大屏 视图切换 */}
          <div className="running-agents-view-toggle" role="tablist" aria-label="视图模式">
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === 'list'}
              className={`running-agents-view-toggle-btn ${viewMode === 'list' ? 'is-active' : ''}`}
              onClick={() => setViewMode('list')}
              title="列表视图"
            >
              <LayoutList size={12} />
              <span>列表</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === 'fleet'}
              className={`running-agents-view-toggle-btn ${viewMode === 'fleet' ? 'is-active' : ''}`}
              onClick={() => setViewMode('fleet')}
              title="大屏视图 —— 只展示运行中的 agent,按工作包分组"
            >
              <LayoutGrid size={12} />
              <span>大屏</span>
            </button>
          </div>
        </div>

        <div className="running-agents-body">
          {viewMode === 'fleet' ? (
            <AgentFleetView
              rows={rows}
              bundles={bundles}
              aborting={aborting}
              onAbort={handleAbort}
              onSelect={(agentId) => {
                // 点卡片切回列表视图并聚焦该 agent
                setViewMode('list')
                setSelectedAgentId(agentId)
              }}
            />
          ) : rows.length === 0 && !loading ? (
            <div className="running-agents-empty">
              <Bot size={28} strokeWidth={1.3} />
              <p>当前没有运行中的智能体。</p>
              <p className="running-agents-empty-hint">
                主聊天或子智能体开始跑任务后,相关条目会自动出现在这里。
              </p>
            </div>
          ) : treeEntries.length === 0 ? (
            <div className="running-agents-empty">
              <Search size={24} strokeWidth={1.3} />
              <p>没有符合当前过滤条件的智能体。</p>
              <p className="running-agents-empty-hint">
                试试清除搜索或切换状态标签。
              </p>
            </div>
          ) : (
            <SimpleVirtualList
              className="running-agents-list"
              items={treeEntries}
              getKey={(entry) => entry.row.agentId}
              estimateHeight={110}
              itemGap={8}
              renderItem={(entry) => (
                <AgentRow
                  row={entry.row}
                  displayName={agentDisplayNames.get(entry.row.agentType)}
                  aborting={aborting.has(entry.row.agentId)}
                  onAbort={handleAbort}
                  depth={entry.depth}
                  hasChildren={entry.hasChildren}
                  collapsed={collapsedParents.has(entry.row.agentId)}
                  onToggleCollapse={() => toggleParent(entry.row.agentId)}
                  isSelected={selectedAgentId === entry.row.agentId}
                  onSelect={() =>
                    setSelectedAgentId((cur) =>
                      cur === entry.row.agentId ? null : entry.row.agentId,
                    )
                  }
                />
              )}
            />
          )}
        </div>

        <footer className="running-agents-footer">
          <span>
            <Clock size={10} /> 自动每 {POLL_INTERVAL_MS / 1000}s 刷新
          </span>
          <span className="running-agents-footer-tip">
            历史记录持久化到磁盘,默认保留最近 5000 条(跨重启)。
          </span>
        </footer>

        {/* Sprint 3.1c: 详情抽屉。selectedAgentId 在 rows 中找最新
            快照 —— 这样即便在抽屉打开期间轮询更新,进度条和 token
            计数也会跟着最新数据走。 */}
        <AgentDetailsDrawer
          row={
            selectedAgentId
              ? (rows.find((r) => r.agentId === selectedAgentId) ?? null)
              : null
          }
          allRows={rows}
          aborting={selectedAgentId ? aborting.has(selectedAgentId) : false}
          onClose={() => setSelectedAgentId(null)}
          onSelect={(agentId) => setSelectedAgentId(agentId)}
          onAbort={handleAbort}
        />
      </div>
    </div>
  )
}

// ─── 单条 agent 行 ────────────────────────────────────────────────

// Sprint 7: memo 化 —— 大量 row 时避免父组件每次 re-render 都遍历
// 重建所有子组件。props 都是浅值 / 稳定回调,浅比较即可命中。
const AgentRow: React.FC<{
  row: ActiveAgentRow
  displayName?: string
  aborting: boolean
  onAbort: (agentId: string, label: string) => void
  /** Sprint 3.1b: 树形渲染参数 */
  depth: number
  hasChildren: boolean
  collapsed: boolean
  onToggleCollapse: () => void
  /** Sprint 3.1c: 选中联动 */
  isSelected: boolean
  onSelect: () => void
}> = React.memo(function AgentRow({
  row,
  displayName,
  aborting,
  onAbort,
  depth,
  hasChildren,
  collapsed,
  onToggleCollapse,
  isSelected,
  onSelect,
}) {
  const StatusIcon = STATUS_ICON[row.status] ?? FALLBACK_STATUS_ICON
  const label = displayName || row.name || row.agentType
  const tokenPct =
    row.maxTokenBudget > 0 ? Math.min(100, (row.tokenCount / row.maxTokenBudget) * 100) : 0
  const timeoutRatio =
    row.timeoutMs > 0 ? Math.min(100, (row.elapsedMs / row.timeoutMs) * 100) : 0

  return (
    <div
      className={`running-agents-row status-${row.status} ${depth > 0 ? 'is-child' : ''} ${isSelected ? 'is-selected' : ''}`}
      style={depth > 0 ? { marginLeft: `${depth * 18}px` } : undefined}
      onClick={(e) => {
        // 行内按钮(折叠/终止)自己 stopPropagation 即可。这里只处理
        // 点击"行空白区"的选中切换。
        const target = e.target as HTMLElement
        if (target.closest('button')) return
        onSelect()
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
    >
      {/* 层级标记: 非顶层时左侧一条细细的引导线 */}
      {depth > 0 ? <span className="running-agents-row-guideline" aria-hidden="true" /> : null}
      <div className="running-agents-row-main">
        {/* Sprint 3.1b: 父 agent 折叠/展开 */}
        {hasChildren ? (
          <button
            type="button"
            className={`running-agents-row-collapse ${collapsed ? 'is-collapsed' : ''}`}
            onClick={onToggleCollapse}
            title={collapsed ? '展开子智能体' : '折叠子智能体'}
            aria-label={collapsed ? '展开子智能体' : '折叠子智能体'}
          >
            <ChevronRight size={12} />
          </button>
        ) : (
          <span className="running-agents-row-collapse-placeholder" aria-hidden="true" />
        )}
        <StatusIcon
          size={13}
          className={`running-agents-row-status-icon ${row.status === 'running' ? 'is-spinning' : ''}`}
        />
        <div className="running-agents-row-identity">
          <div className="running-agents-row-title">
            <span className="running-agents-row-name">{label}</span>
            <span className="running-agents-row-type mono">{row.agentType}</span>
            {row.background ? (
              <span className="running-agents-row-badge running-agents-row-badge-bg">
                后台
              </span>
            ) : null}
            {row.fromDisk ? (
              <span
                className="running-agents-row-badge running-agents-row-badge-history"
                title="上次运行留下的历史记录"
              >
                历史
              </span>
            ) : null}
            {row.teamName ? (
              <span className="running-agents-row-badge running-agents-row-badge-team">
                <Users size={9} />
                {row.teamName}
              </span>
            ) : null}
            {row.permissionMode && PERMISSION_MODE_BADGE[row.permissionMode] ? (
              <span
                className={`running-agents-row-badge running-agents-row-badge-perm running-agents-row-badge-perm-${PERMISSION_MODE_BADGE[row.permissionMode].tone}`}
                title={PERMISSION_MODE_BADGE[row.permissionMode].title}
              >
                {PERMISSION_MODE_BADGE[row.permissionMode].label}
              </span>
            ) : null}
          </div>
          {row.description ? (
            <div className="running-agents-row-desc" title={row.description}>
              {row.description}
            </div>
          ) : null}
        </div>

        <div className="running-agents-row-metrics">
          <Metric
            icon={<Clock size={11} />}
            label="耗时"
            value={formatDuration(row.elapsedMs)}
            progress={row.status === 'running' ? timeoutRatio : undefined}
            progressColor="blue"
          />
          <Metric
            icon={<Coins size={11} />}
            label="Tokens"
            value={`${formatTokens(row.tokenCount)} / ${formatTokens(row.maxTokenBudget)}`}
            progress={tokenPct}
            progressColor={row.tokenBudgetExceeded ? 'red' : tokenPct > 80 ? 'yellow' : 'blue'}
          />
          <Metric
            icon={<MessageSquare size={11} />}
            label="待处理"
            value={row.pendingMessageCount.toString()}
          />
        </div>

        <div className="running-agents-row-actions">
          <div className="running-agents-row-status-label">
            <span
              className={`running-agents-status-dot status-${row.status}`}
              aria-hidden="true"
            />
            <span>{STATUS_LABEL[row.status]}</span>
          </div>
          {row.status === 'running' ? (
            <button
              type="button"
              className="running-agents-abort-btn"
              disabled={aborting}
              onClick={() => onAbort(row.agentId, label)}
              title="终止此智能体"
            >
              {aborting ? <Loader2 size={11} className="is-spinning" /> : <StopCircle size={11} />}
              <span>{aborting ? '终止中…' : '终止'}</span>
            </button>
          ) : null}
        </div>
      </div>

      <div className="running-agents-row-footer">
        <span className="running-agents-row-id mono" title="agent id">
          id:{row.agentId}
        </span>
        {row.parentAgentId ? (
          <span className="running-agents-row-parent" title="父 agent id">
            父:<span className="mono">{row.parentAgentId}</span>
          </span>
        ) : null}
        {row.model ? (
          <span className="running-agents-row-model" title="模型">
            模型:<span className="mono">{row.model}</span>
          </span>
        ) : null}
        <span className="running-agents-row-spacer" />
        <span className="running-agents-row-time" title="启动时间">
          {new Date(row.startTime).toLocaleTimeString()}
        </span>
      </div>
    </div>
  )
})

const Metric: React.FC<{
  icon: React.ReactNode
  label: string
  value: string
  /** 0-100 百分比(可选);有值时在下方展示细进度条 */
  progress?: number
  progressColor?: 'blue' | 'yellow' | 'red'
}> = ({ icon, label, value, progress, progressColor = 'blue' }) => (
  <div className="running-agents-metric">
    <div className="running-agents-metric-head">
      <span className="running-agents-metric-label">
        {icon}
        {label}
      </span>
      <span className="running-agents-metric-value">{value}</span>
    </div>
    {progress !== undefined ? (
      <div className="running-agents-metric-bar">
        <div
          className={`running-agents-metric-bar-fill color-${progressColor}`}
          style={{ width: `${Math.max(0, Math.min(100, progress))}%` }}
        />
      </div>
    ) : null}
  </div>
)
