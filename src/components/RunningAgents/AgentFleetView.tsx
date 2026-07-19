/**
 * AgentFleetView —— "大屏"视图(新方向 A)。
 *
 * Running Agents 面板的第二种视觉形态,强调:
 *   - **全局仪表盘**(顶部 5 个统计卡):总 running / 累计 tokens /
 *     累计工具调用 / 活跃 bundles / 活跃 teams
 *   - **卡片网格**:每个运行中的 agent 一张紧凑卡,突出实时指标
 *     (token 速率 / 超时进度 / 当前进展)
 *   - **按 bundle 分组**:同一 bundle 的 agent 视觉上靠近,一眼看
 *     "这个 bundle 贡献了多少活跃"
 *
 * 与"列表"视图互补:
 *   - 列表:行式、适合"逐个查看 + 终止"
 *   - 大屏:卡片式、适合"一眼看全局并发情况"
 *
 * 只展示 `status === 'running'` 的 agent(大屏视图的核心是"正在跑
 * 什么";已终止的用列表查看更合适)。
 */

import React, { useMemo } from 'react'
import {
  Activity,
  Bot,
  Coins,
  Wrench,
  Package,
  Users,
  StopCircle,
  Loader2,
  Clock,
} from 'lucide-react'
import type { Bundle } from '../../../electron/agents/bundles/types'
import './AgentFleetView.css'

export interface FleetAgentRow {
  agentId: string
  agentType: string
  description: string
  name?: string
  teamName?: string
  status: 'running' | 'completed' | 'failed' | 'killed'
  startTime: number
  elapsedMs: number
  tokenCount: number
  maxTokenBudget: number
  tokenBudgetExceeded: boolean
  timeoutMs: number
  pendingMessageCount: number
  parentAgentId?: string
  background: boolean
  model?: string
  fromDisk?: boolean
}

export interface AgentFleetViewProps {
  rows: FleetAgentRow[]
  bundles: Bundle[]
  aborting: Set<string>
  onAbort: (agentId: string, label: string) => void
  /** 点击卡片切回列表视图并选中该 agent 的详情。 */
  onSelect: (agentId: string) => void
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const s = Math.round(ms / 100) / 10
  if (s < 60) return `${s.toFixed(1)}s`
  const mins = Math.floor(s / 60)
  const secs = Math.floor(s % 60)
  return `${mins}m ${secs.toString().padStart(2, '0')}s`
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

/** 对每个 agentType 回查其 bundle 归属 —— 用于按 bundle 分组 */
function buildAgentBundleMap(bundles: Bundle[]): Map<string, Bundle> {
  const map = new Map<string, Bundle>()
  for (const b of bundles) {
    for (const a of b.agents) {
      if (!map.has(a.agentType)) map.set(a.agentType, b)
    }
  }
  return map
}

export const AgentFleetView: React.FC<AgentFleetViewProps> = ({
  rows,
  bundles,
  aborting,
  onAbort,
  onSelect,
}) => {
  const running = useMemo(() => rows.filter((r) => r.status === 'running'), [rows])
  const bundleByAgent = useMemo(() => buildAgentBundleMap(bundles), [bundles])

  // 按 bundle 分组:activeBundle.id -> agents[]。未知 bundle 归"未归类"。
  const groups = useMemo(() => {
    const map = new Map<
      string,
      { bundle: Bundle | null; agents: FleetAgentRow[] }
    >()
    for (const r of running) {
      const b = bundleByAgent.get(r.agentType) ?? null
      const key = b?.meta.id ?? '__unbound__'
      const entry = map.get(key) ?? { bundle: b, agents: [] }
      entry.agents.push(r)
      map.set(key, entry)
    }
    return [...map.values()].sort((a, b) =>
      // 知名 bundle 排前,数量多的排前
      b.agents.length - a.agents.length,
    )
  }, [running, bundleByAgent])

  // 全局指标
  const totals = useMemo(() => {
    let totalTokens = 0
    const totalToolUses = 0 // pending messages 非真 tool uses;无 tool use 快照字段,用 pending 做近似
    let pendingMsgs = 0
    const activeBundleIds = new Set<string>()
    const activeTeams = new Set<string>()
    for (const r of running) {
      totalTokens += r.tokenCount
      pendingMsgs += r.pendingMessageCount
      if (r.teamName) activeTeams.add(r.teamName)
      const b = bundleByAgent.get(r.agentType)
      if (b) activeBundleIds.add(b.meta.id)
    }
    // "tool uses" 我们没有实时计数字段,用 pending messages 代替作为
    // "进行中的工作量"近似
    void totalToolUses
    return {
      runningCount: running.length,
      totalTokens,
      pendingMsgs,
      bundleCount: activeBundleIds.size,
      teamCount: activeTeams.size,
    }
  }, [running, bundleByAgent])

  return (
    <div className="agent-fleet-view">
      {/* ── 顶部全局指标仪表盘 ───────────────────────── */}
      <div className="agent-fleet-dashboard">
        <MetricCard
          icon={<Activity size={14} />}
          label="运行中"
          value={totals.runningCount.toString()}
          accent={totals.runningCount > 0 ? 'green' : 'dim'}
          pulse={totals.runningCount > 0}
        />
        <MetricCard
          icon={<Coins size={14} />}
          label="累计 Tokens"
          value={formatTokens(totals.totalTokens)}
          accent="blue"
        />
        <MetricCard
          icon={<Wrench size={14} />}
          label="待处理消息"
          value={totals.pendingMsgs.toString()}
          accent={totals.pendingMsgs > 0 ? 'yellow' : 'dim'}
        />
        <MetricCard
          icon={<Package size={14} />}
          label="活跃工作包"
          value={totals.bundleCount.toString()}
          accent="mauve"
        />
        <MetricCard
          icon={<Users size={14} />}
          label="活跃团队"
          value={totals.teamCount.toString()}
          accent="mauve"
        />
      </div>

      {/* ── 卡片网格(按 bundle 分组) ───────────────── */}
      {running.length === 0 ? (
        <div className="agent-fleet-empty">
          <Bot size={40} strokeWidth={1.2} />
          <p>当前没有运行中的智能体。</p>
          <p className="agent-fleet-empty-hint">
            要查看历史记录,请切换到"列表"视图。
          </p>
        </div>
      ) : (
        <div className="agent-fleet-groups">
          {groups.map((group) => (
            <FleetGroup
              key={group.bundle?.meta.id ?? '__unbound__'}
              group={group}
              aborting={aborting}
              onAbort={onAbort}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Group 和 Card 子组件 ─────────────────────────────

const FleetGroup: React.FC<{
  group: { bundle: Bundle | null; agents: FleetAgentRow[] }
  aborting: Set<string>
  onAbort: (id: string, label: string) => void
  onSelect: (id: string) => void
}> = ({ group, aborting, onAbort, onSelect }) => {
  const bundleName = group.bundle?.meta.name ?? '未归属于已加载的工作包'
  return (
    <section className="agent-fleet-group">
      <div className="agent-fleet-group-header">
        <Package size={11} />
        <span className="agent-fleet-group-name">{bundleName}</span>
        <span className="agent-fleet-group-count">{group.agents.length}</span>
      </div>
      <div className="agent-fleet-cards">
        {group.agents.map((a) => (
          <FleetCard
            key={a.agentId}
            row={a}
            aborting={aborting.has(a.agentId)}
            onAbort={onAbort}
            onSelect={onSelect}
          />
        ))}
      </div>
    </section>
  )
}

const FleetCard: React.FC<{
  row: FleetAgentRow
  aborting: boolean
  onAbort: (id: string, label: string) => void
  onSelect: (id: string) => void
}> = React.memo(function FleetCard({ row, aborting, onAbort, onSelect }) {
  const tokenPct =
    row.maxTokenBudget > 0
      ? Math.min(100, (row.tokenCount / row.maxTokenBudget) * 100)
      : 0
  const timeoutPct =
    row.timeoutMs > 0 ? Math.min(100, (row.elapsedMs / row.timeoutMs) * 100) : 0
  const label = row.name || row.agentType

  return (
    <article
      className="agent-fleet-card"
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button')) return
        onSelect(row.agentId)
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect(row.agentId)
        }
      }}
      title="点击查看详情"
    >
      <div className="agent-fleet-card-head">
        <span className="agent-fleet-card-status-dot" />
        <span className="agent-fleet-card-title" title={label}>
          {label}
        </span>
        {row.background ? (
          <span className="agent-fleet-card-badge">后台</span>
        ) : null}
      </div>

      {row.description ? (
        <div className="agent-fleet-card-desc" title={row.description}>
          {row.description}
        </div>
      ) : null}

      <div className="agent-fleet-card-bars">
        <div className="agent-fleet-bar-row">
          <span className="agent-fleet-bar-label">
            <Coins size={9} />
            {formatTokens(row.tokenCount)}
          </span>
          <div className="agent-fleet-bar">
            <div
              className={`agent-fleet-bar-fill ${
                row.tokenBudgetExceeded
                  ? 'color-red'
                  : tokenPct > 80
                    ? 'color-yellow'
                    : 'color-blue'
              }`}
              style={{ width: `${tokenPct}%` }}
            />
          </div>
        </div>
        <div className="agent-fleet-bar-row">
          <span className="agent-fleet-bar-label">
            <Clock size={9} />
            {formatDuration(row.elapsedMs)}
          </span>
          <div className="agent-fleet-bar">
            <div
              className={`agent-fleet-bar-fill ${
                timeoutPct > 90
                  ? 'color-red'
                  : timeoutPct > 70
                    ? 'color-yellow'
                    : 'color-green'
              }`}
              style={{ width: `${timeoutPct}%` }}
            />
          </div>
        </div>
      </div>

      <div className="agent-fleet-card-footer">
        <span className="agent-fleet-card-agent-type mono">{row.agentType}</span>
        {row.teamName ? (
          <span className="agent-fleet-card-team">
            <Users size={9} />
            {row.teamName}
          </span>
        ) : null}
        <button
          type="button"
          className="agent-fleet-card-abort"
          disabled={aborting}
          onClick={(e) => {
            e.stopPropagation()
            onAbort(row.agentId, label)
          }}
          title="终止"
        >
          {aborting ? <Loader2 size={10} className="is-spinning" /> : <StopCircle size={10} />}
        </button>
      </div>
    </article>
  )
})

// ─── 顶部指标卡 ────────────────────────────────────────

const MetricCard: React.FC<{
  icon: React.ReactNode
  label: string
  value: string
  accent: 'green' | 'blue' | 'yellow' | 'red' | 'mauve' | 'dim'
  pulse?: boolean
}> = ({ icon, label, value, accent, pulse }) => (
  <div className={`agent-fleet-metric accent-${accent} ${pulse ? 'is-pulsing' : ''}`}>
    <div className="agent-fleet-metric-icon">{icon}</div>
    <div className="agent-fleet-metric-body">
      <div className="agent-fleet-metric-label">{label}</div>
      <div className="agent-fleet-metric-value">{value}</div>
    </div>
  </div>
)
