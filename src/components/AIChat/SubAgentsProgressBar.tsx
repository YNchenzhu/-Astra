/**
 * SubAgentsProgressBar —— 子智能体活动的进度总览条 (Sprint 4.2)。
 *
 * 当一条助手消息 spawn 出多个 sub-agent 时,单个 AgentBlock 卡片
 * 堆在一起很难一眼看出"整体有多少在跑 / 完成了几个 / 累计花了多少
 * 工具和 token"。这里加一条聚合的"一眼看懂"条:
 *
 *   ┌──────────────────────────────────────────────────────┐
 *   │ 🤖 5 个智能体  [======■■■□□□]  48.2k tokens · 19 工具 │
 *   │   3 运行中 · 2 完成 · 0 失败                          │
 *   └──────────────────────────────────────────────────────┘
 *
 * 堆叠条的含义:running = 亮绿脉动,completed = 稳绿,failed = 红。
 * 长度按比例分配。视觉延续 Running Agents 面板的状态色板。
 *
 * 数据源:ChatMessage 的 `subAgents: SubAgentDisplay[]`,纯展示,
 * 无副作用、无 IPC 调用。
 */

import React, { useMemo } from 'react'
import { Bot, Coins, Wrench } from 'lucide-react'
import type { SubAgentDisplay } from '../../types/tool'
import { normalizeCardStatus } from './cards/BaseCard'
import './SubAgentsProgressBar.css'

export interface SubAgentsProgressBarProps {
  subAgents: SubAgentDisplay[]
  /** 父消息是否仍在流式(用于决定 "running" 色块是否闪烁) */
  streaming?: boolean
}

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

export const SubAgentsProgressBar: React.FC<SubAgentsProgressBarProps> = ({
  subAgents,
  streaming,
}) => {
  const stats = useMemo(() => {
    let running = 0
    let completed = 0
    let failed = 0
    let totalTokens = 0
    let totalToolUses = 0
    let maxDurationMs = 0
    for (const sa of subAgents) {
      // Bug U-1 fix: route through `normalizeCardStatus` so producers using
      // `error` / `stopped` / `cancelled` / `timeout` (all surfaced by
      // `agentTool.ts` and Coordinator) are counted as failed instead of
      // silently dropped. Previously only the literal strings
      // `running` / `completed` / `failed` were recognized → users saw
      // running+completed+failed < subAgents.length whenever a sub-agent
      // ended via timeout / abort / generic error.
      const norm = normalizeCardStatus(sa.status)
      if (norm === 'running') running++
      else if (norm === 'success') completed++
      else if (norm === 'error') failed++
      totalTokens += sa.totalTokens ?? 0
      totalToolUses += sa.totalToolUses ?? sa.toolUses.length
      if (typeof sa.totalDurationMs === 'number' && sa.totalDurationMs > maxDurationMs) {
        maxDurationMs = sa.totalDurationMs
      }
    }
    return {
      total: subAgents.length,
      running,
      completed,
      failed,
      totalTokens,
      totalToolUses,
      maxDurationMs,
    }
  }, [subAgents])

  // 单个 agent 时意义不大(AgentBlock 本身已经展示 status),隐藏以免重复
  if (stats.total <= 1) return null

  const runningPct = stats.total > 0 ? (stats.running / stats.total) * 100 : 0
  const completedPct = stats.total > 0 ? (stats.completed / stats.total) * 100 : 0
  const failedPct = stats.total > 0 ? (stats.failed / stats.total) * 100 : 0

  const durationLabel =
    stats.maxDurationMs > 0
      ? stats.maxDurationMs < 1000
        ? `${stats.maxDurationMs}ms`
        : stats.maxDurationMs < 60_000
          ? `${(stats.maxDurationMs / 1000).toFixed(1)}s`
          : `${Math.floor(stats.maxDurationMs / 60_000)}m ${Math.floor((stats.maxDurationMs % 60_000) / 1000)}s`
      : null

  return (
    <div
      className={`sub-agents-progress-bar ${streaming && stats.running > 0 ? 'is-streaming' : ''}`}
      role="status"
      aria-label={`子智能体活动:${stats.running} 运行中,${stats.completed} 完成,${stats.failed} 失败`}
      data-testid="sub-agents-progress-bar"
      data-e2e-running={stats.running}
      data-e2e-completed={stats.completed}
      data-e2e-failed={stats.failed}
      data-e2e-total={stats.total}
    >
      <div className="sub-agents-progress-head">
        <Bot size={12} className="sub-agents-progress-icon" />
        <span className="sub-agents-progress-total">{stats.total} 个子智能体</span>

        <div className="sub-agents-progress-stacked">
          {stats.completed > 0 ? (
            <span
              className="sub-agents-progress-seg is-completed"
              style={{ width: `${completedPct}%` }}
              title={`已完成: ${stats.completed}`}
            />
          ) : null}
          {stats.running > 0 ? (
            <span
              className="sub-agents-progress-seg is-running"
              style={{ width: `${runningPct}%` }}
              title={`运行中: ${stats.running}`}
            />
          ) : null}
          {stats.failed > 0 ? (
            <span
              className="sub-agents-progress-seg is-failed"
              style={{ width: `${failedPct}%` }}
              title={`失败: ${stats.failed}`}
            />
          ) : null}
        </div>

        <div className="sub-agents-progress-metrics">
          {stats.totalTokens > 0 ? (
            <span className="sub-agents-progress-metric" title="累计 token 用量">
              <Coins size={10} />
              {formatTokens(stats.totalTokens)}
            </span>
          ) : null}
          {stats.totalToolUses > 0 ? (
            <span className="sub-agents-progress-metric" title="累计工具调用次数">
              <Wrench size={10} />
              {stats.totalToolUses}
            </span>
          ) : null}
          {durationLabel ? (
            <span
              className="sub-agents-progress-metric"
              title="最长一个子智能体的耗时(约等于你的等待时间)"
            >
              {durationLabel}
            </span>
          ) : null}
        </div>
      </div>

      <div className="sub-agents-progress-breakdown">
        {stats.running > 0 ? (
          <span className="sub-agents-progress-breakdown-item is-running">
            <span className="sub-agents-progress-dot is-running" />
            {stats.running} 运行中
          </span>
        ) : null}
        {stats.completed > 0 ? (
          <span className="sub-agents-progress-breakdown-item is-completed">
            <span className="sub-agents-progress-dot is-completed" />
            {stats.completed} 完成
          </span>
        ) : null}
        {stats.failed > 0 ? (
          <span className="sub-agents-progress-breakdown-item is-failed">
            <span className="sub-agents-progress-dot is-failed" />
            {stats.failed} 失败
          </span>
        ) : null}
      </div>
    </div>
  )
}
