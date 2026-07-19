/**
 * AgentDetailsDrawer —— 选中一个 agent 后从面板右侧滑入的详情视图
 * (Phase 3 Sprint 3.1c)。
 *
 * 为什么要独立抽屉而不是行内展开:
 *   - 行本身已经有 8 个字段 + 3 个指标 + 控制按钮,塞更多细节会挤爆
 *   - 详情含大进度条(token / timeout)和父子链路 —— 横向空间比纵向好
 *   - 跳转父/子 agent 的 UX 在抽屉里更直观(点击一下切换目标)
 *
 * 展示的字段超集包含:
 *   身份: agentId / agentType / displayName / name / teamName
 *   关系: parentAgentId / streamConversationId
 *   运行: status / startTime / endedAt / elapsedMs + 进度条
 *   模型: model / maxTokens / background / coordinatorPhase (若内置暴露)
 *   预算: tokenCount vs maxTokenBudget 大进度条 + 超预算标志
 *   超时: elapsedMs vs timeoutMs 大进度条 + 剩余时间
 *   邮箱: pendingMessageCount (不展开内容,仅计数)
 *
 * 写操作:
 *   - 终止按钮(仅 running 状态)
 *   - 跳转到父 agent(若有 parentAgentId 且父在列表中)
 */

import React, { useCallback, useEffect, useMemo } from 'react'
import {
  X,
  StopCircle,
  Loader2,
  ArrowUp,
  ArrowDown,
  Bot,
  Users,
  Clock,
  Coins,
  MessageSquare,
  Hash,
  AlertTriangle,
  CheckCircle2,
  Package,
} from 'lucide-react'
import { useBundleList } from '../../stores/bundleStore'
import './AgentDetailsDrawer.css'

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
  /** P1-1: spawn-time permission mode snapshot (upstream §3.1). */
  permissionMode?: string
}

/** P1-1: human-readable label for the spawn-time permission mode. */
const PERMISSION_MODE_LABEL: Record<string, string> = {
  default: '默认 — 标准审批流',
  plan: 'Plan — 只读规划/设计阶段',
  bypassPermissions: 'Bypass — 跳过权限询问',
  acceptEdits: 'Auto-Edits — 自动批准文件编辑',
  dontAsk: 'DontAsk — 拒绝所有未预批准操作',
}

const STATUS_LABEL: Record<ActiveAgentRow['status'], string> = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  killed: '已终止',
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${ms} ms`
  const s = Math.round(ms / 100) / 10
  if (s < 60) return `${s.toFixed(1)}s`
  const mins = Math.floor(s / 60)
  const secs = Math.floor(s % 60)
  if (mins < 60) return `${mins}m ${secs.toString().padStart(2, '0')}s`
  const hours = Math.floor(mins / 60)
  const remMins = mins % 60
  return `${hours}h ${remMins.toString().padStart(2, '0')}m`
}

function formatTokens(n: number): string {
  if (n < 1000) return n.toString()
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

function formatTimestamp(ts: number): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString()
}

export interface AgentDetailsDrawerProps {
  /** 当前选中的 row;null 时抽屉不渲染。 */
  row: ActiveAgentRow | null
  /** 所有 rows,用于解析父/子关系。 */
  allRows: ActiveAgentRow[]
  /** 是否正在为此 row 发终止请求。 */
  aborting: boolean
  onClose: () => void
  onSelect: (agentId: string) => void
  onAbort: (agentId: string, label: string) => void
}

export const AgentDetailsDrawer: React.FC<AgentDetailsDrawerProps> = ({
  row,
  allRows,
  aborting,
  onClose,
  onSelect,
  onAbort,
}) => {
  const bundles = useBundleList()

  // 父子关系解析(从 allRows 中定位 —— 有就链接可跳,无就只显示 id)
  const parent = useMemo<ActiveAgentRow | null>(() => {
    if (!row?.parentAgentId || row.parentAgentId === 'main') return null
    return allRows.find((r) => r.agentId === row.parentAgentId) ?? null
  }, [row, allRows])

  const children = useMemo<ActiveAgentRow[]>(() => {
    if (!row) return []
    return allRows
      .filter((r) => r.parentAgentId === row.agentId)
      .sort((a, b) => b.startTime - a.startTime)
  }, [row, allRows])

  // agent displayName 反查(从 bundles 里查)
  const displayName = useMemo(() => {
    if (!row) return undefined
    for (const b of bundles) {
      for (const a of b.agents) {
        if (a.agentType === row.agentType) return a.displayName
      }
    }
    return undefined
  }, [row, bundles])

  // 来自哪个 bundle
  const sourceBundle = useMemo(() => {
    if (!row) return null
    for (const b of bundles) {
      if (b.agents.some((a) => a.agentType === row.agentType)) return b
    }
    return null
  }, [row, bundles])

  // Esc 关闭抽屉(不穿透关面板,由父组件的 Esc 监听处理优先级)
  useEffect(() => {
    if (!row) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey, true) // capture-phase
    return () => document.removeEventListener('keydown', onKey, true)
  }, [row, onClose])

  const handleAbort = useCallback(() => {
    if (!row) return
    const label = displayName || row.name || row.agentType
    onAbort(row.agentId, label)
  }, [row, displayName, onAbort])

  if (!row) return null

  const tokenPct =
    row.maxTokenBudget > 0 ? Math.min(100, (row.tokenCount / row.maxTokenBudget) * 100) : 0
  const timeRemaining = row.timeoutMs - row.elapsedMs
  const timeoutPct =
    row.timeoutMs > 0 ? Math.min(100, (row.elapsedMs / row.timeoutMs) * 100) : 0
  const label = displayName || row.name || row.agentType

  return (
    <div
      className="agent-details-drawer"
      role="complementary"
      aria-label={`${label} 详情`}
    >
      <header className="agent-details-drawer-header">
        <div className="agent-details-drawer-title">
          <Bot size={14} className="agent-details-drawer-title-icon" />
          <span className="agent-details-drawer-name" title={label}>
            {label}
          </span>
          <span className={`agent-details-drawer-status-badge status-${row.status}`}>
            <span className={`agent-details-drawer-status-dot status-${row.status}`} />
            {STATUS_LABEL[row.status]}
          </span>
        </div>
        <button
          type="button"
          className="agent-details-drawer-close"
          onClick={onClose}
          title="关闭 (Esc)"
          aria-label="关闭"
        >
          <X size={14} />
        </button>
      </header>

      <div className="agent-details-drawer-body">
        {/* ── 进度条:Token + 超时 ────────────────────────── */}
        <section className="agent-details-section">
          <div className="agent-details-section-label">Token 用量</div>
          <div className="agent-details-bar-row">
            <div className="agent-details-bar">
              <div
                className={`agent-details-bar-fill ${
                  row.tokenBudgetExceeded
                    ? 'color-red'
                    : tokenPct > 80
                      ? 'color-yellow'
                      : 'color-blue'
                }`}
                style={{ width: `${tokenPct}%` }}
              />
            </div>
            <div className="agent-details-bar-label">
              <Coins size={10} /> {formatTokens(row.tokenCount)} /{' '}
              {formatTokens(row.maxTokenBudget)}
            </div>
          </div>
          {row.tokenBudgetExceeded ? (
            <div className="agent-details-banner agent-details-banner-err">
              <AlertTriangle size={11} />
              <span>已超出预算,运行被自动终止</span>
            </div>
          ) : null}
        </section>

        <section className="agent-details-section">
          <div className="agent-details-section-label">超时进度</div>
          <div className="agent-details-bar-row">
            <div className="agent-details-bar">
              <div
                className={`agent-details-bar-fill ${
                  timeoutPct > 90 ? 'color-red' : timeoutPct > 70 ? 'color-yellow' : 'color-blue'
                }`}
                style={{ width: `${timeoutPct}%` }}
              />
            </div>
            <div className="agent-details-bar-label">
              <Clock size={10} /> {formatDuration(row.elapsedMs)} /{' '}
              {formatDuration(row.timeoutMs)}
            </div>
          </div>
          {row.status === 'running' ? (
            <div className="agent-details-section-hint">
              剩余 {formatDuration(Math.max(0, timeRemaining))} 后自动中止
            </div>
          ) : null}
        </section>

        {/* ── 身份信息 ─────────────────────────────────── */}
        <section className="agent-details-section">
          <div className="agent-details-section-label">身份信息</div>
          <DetailRow label="Agent ID" value={row.agentId} mono copyable />
          <DetailRow label="Agent Type" value={row.agentType} mono />
          {displayName ? <DetailRow label="显示名称" value={displayName} /> : null}
          {row.name ? <DetailRow label="运行名" value={row.name} /> : null}
          {sourceBundle ? (
            <DetailRow
              label="所属工作包"
              value={
                <span className="agent-details-value-flex">
                  <Package size={10} />
                  {sourceBundle.meta.name}
                </span>
              }
            />
          ) : (
            <DetailRow
              label="所属工作包"
              value={<span className="agent-details-dim">未知(可能是临时定义)</span>}
            />
          )}
        </section>

        {/* ── 团队 + 关系 ─────────────────────────────── */}
        <section className="agent-details-section">
          <div className="agent-details-section-label">关系</div>
          {row.teamName ? (
            <DetailRow
              label="团队"
              value={
                <span className="agent-details-value-flex">
                  <Users size={10} />
                  {row.teamName}
                </span>
              }
            />
          ) : (
            <DetailRow label="团队" value={<span className="agent-details-dim">无</span>} />
          )}

          <div className="agent-details-field">
            <span className="agent-details-field-label">父智能体</span>
            <div className="agent-details-field-value">
              {!row.parentAgentId || row.parentAgentId === 'main' ? (
                <span className="agent-details-dim">主聊天(顶层)</span>
              ) : parent ? (
                <button
                  type="button"
                  className="agent-details-link"
                  onClick={() => onSelect(parent.agentId)}
                  title="跳转到父智能体"
                >
                  <ArrowUp size={10} />
                  <span>{parent.name ?? parent.agentType}</span>
                  <span className="agent-details-link-id mono">{parent.agentId}</span>
                </button>
              ) : (
                <span className="agent-details-dim mono">
                  {row.parentAgentId}(已不在列表中)
                </span>
              )}
            </div>
          </div>

          {children.length > 0 ? (
            <div className="agent-details-field">
              <span className="agent-details-field-label">
                子智能体(当前列表中共 {children.length})
              </span>
              <div className="agent-details-field-value agent-details-children-list">
                {children.map((child) => (
                  <button
                    key={child.agentId}
                    type="button"
                    className="agent-details-link"
                    onClick={() => onSelect(child.agentId)}
                    title="跳转到此子智能体"
                  >
                    <ArrowDown size={10} />
                    <span>{child.name ?? child.agentType}</span>
                    <span className={`agent-details-link-status status-${child.status}`}>
                      {STATUS_LABEL[child.status]}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </section>

        {/* ── 运行时元数据 ──────────────────────────────── */}
        <section className="agent-details-section">
          <div className="agent-details-section-label">运行时</div>
          <DetailRow
            label="启动时间"
            value={<span className="mono">{formatTimestamp(row.startTime)}</span>}
          />
          {row.endedAt ? (
            <DetailRow
              label="结束时间"
              value={<span className="mono">{formatTimestamp(row.endedAt)}</span>}
            />
          ) : null}
          <DetailRow label="模型" value={row.model ? <span className="mono">{row.model}</span> : <span className="agent-details-dim">继承默认</span>} />
          <DetailRow
            label="后台运行"
            value={row.background ? '是' : <span className="agent-details-dim">否</span>}
          />
          <DetailRow
            label="权限模式"
            value={
              row.permissionMode ? (
                <span className="mono" title={PERMISSION_MODE_LABEL[row.permissionMode] ?? row.permissionMode}>
                  {PERMISSION_MODE_LABEL[row.permissionMode] ?? row.permissionMode}
                </span>
              ) : (
                <span className="agent-details-dim">未记录</span>
              )
            }
          />
          {row.streamConversationId ? (
            <DetailRow
              label="流式会话"
              value={<span className="mono">{row.streamConversationId}</span>}
              copyable
            />
          ) : null}
          <div className="agent-details-field">
            <span className="agent-details-field-label">待处理消息</span>
            <div className="agent-details-field-value">
              <span className="agent-details-value-flex">
                <MessageSquare size={10} /> {row.pendingMessageCount} 条
              </span>
              {row.pendingMessageCount > 0 ? (
                <div className="agent-details-section-hint">
                  (为保护隐私,这里不展开消息内容)
                </div>
              ) : null}
            </div>
          </div>
        </section>

        {/* ── 描述(可能较长,放最后) ─────────────────── */}
        {row.description ? (
          <section className="agent-details-section">
            <div className="agent-details-section-label">任务描述</div>
            <div className="agent-details-description">{row.description}</div>
          </section>
        ) : null}
      </div>

      {row.status === 'running' ? (
        <footer className="agent-details-drawer-footer">
          <button
            type="button"
            className="agent-details-abort-btn"
            disabled={aborting}
            onClick={handleAbort}
          >
            {aborting ? <Loader2 size={12} className="is-spinning" /> : <StopCircle size={12} />}
            <span>{aborting ? '终止中…' : '终止此智能体'}</span>
          </button>
        </footer>
      ) : (
        <footer className="agent-details-drawer-footer agent-details-drawer-footer-dim">
          <span>
            <CheckCircle2 size={11} /> 已结束的记录仅作查看
          </span>
        </footer>
      )}
    </div>
  )
}

// ─── Helper row ──────────────────────────────────────────────

const DetailRow: React.FC<{
  label: string
  value: React.ReactNode
  mono?: boolean
  copyable?: boolean
}> = ({ label, value, mono, copyable }) => {
  const handleCopy = useCallback(() => {
    if (typeof value !== 'string') return
    try {
      navigator.clipboard.writeText(value)
    } catch {
      /* ignore */
    }
  }, [value])

  return (
    <div className="agent-details-field">
      <span className="agent-details-field-label">{label}</span>
      <div className="agent-details-field-value">
        <span
          className={`${mono ? 'mono' : ''} ${copyable ? 'agent-details-field-copyable' : ''}`}
          onClick={copyable ? handleCopy : undefined}
          title={copyable ? '点击复制' : undefined}
        >
          {value}
          {copyable ? <Hash size={8} className="agent-details-field-copy-icon" /> : null}
        </span>
      </div>
    </div>
  )
}
