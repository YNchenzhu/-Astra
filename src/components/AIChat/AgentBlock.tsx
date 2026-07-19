/**
 * AgentBlock — sub-agent activity, rendered as a single "aggregated"
 * feed row (e.g. `● Explored 11 files, 14 searches  12.3s ▸`) that
 * expands into a nested feed of the tool invocations the sub-agent
 * actually ran.
 *
 * Parity with the previous revision:
 *   - Same `{ agent: SubAgentDisplay }` API — no caller changes.
 *   - Preserves structured summary rendering (做了什么 / 证据 /
 *     还缺什么 / 下一步) when the agent emits one.
 *   - Preserves nested thinking block and free-form output display.
 *
 * What's new:
 *   - Single-line collapsed surface (no more multi-row chrome).
 *   - Tool uses inside the agent are rendered via the *same*
 *     `ToolUseCard` that main-thread tools use, so the sub-agent feed
 *     matches the outer feed's visual language exactly (ActivityRow /
 *     CommandChip / BaseCard fallback).
 *   - Aggregation vocabulary counts tools by category (file reads,
 *     searches, edits, commands) and builds a natural-language subject.
 */
import React, { useEffect, useMemo, useRef } from 'react'
import type { SubAgentDisplay, TodoItem, ToolUseDisplay } from '../../types'
import { ActivityRow } from './activity/ActivityRow'
import { normalizeCardStatus } from './cards/BaseCard'
import { SubAgentTodos } from './SubAgentTodos'
import { ReasoningSummaryBlock } from './ReasoningSummaryBlock'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolUseCard } from './ToolUseCard'
import './AgentBlock.css'

interface AgentBlockProps {
  agent: SubAgentDisplay
}

const TODO_STATUSES = new Set<TodoItem['status']>(['pending', 'in_progress', 'completed'])

function normalizeTodoItems(value: unknown): TodoItem[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined

  const todos: TodoItem[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') return undefined
    const record = item as Record<string, unknown>
    const content = typeof record.content === 'string' ? record.content.trim() : ''
    const activeForm =
      typeof record.activeForm === 'string' && record.activeForm.trim()
        ? record.activeForm.trim()
        : content
    const status = record.status
    if (!content || typeof status !== 'string' || !TODO_STATUSES.has(status as TodoItem['status'])) {
      return undefined
    }
    todos.push({
      content,
      activeForm,
      status: status as TodoItem['status'],
    })
  }

  return todos
}

// eslint-disable-next-line react-refresh/only-export-components
export function parseTodoPayloadFromAgentOutput(raw: string | undefined): TodoItem[] | undefined {
  if (!raw || !raw.trim()) return undefined
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) return normalizeTodoItems(parsed)
    if (parsed && typeof parsed === 'object') {
      return normalizeTodoItems((parsed as { items?: unknown }).items)
    }
  } catch {
    // Normal prose output is expected here; only JSON todo payloads are special.
  }
  return undefined
}

// ─── Tool categorisation for the aggregate sentence ──────────────────
// Mirrors the `toolToAction` mapping but groups by verb family so the
// collapsed row can say "11 files, 14 searches" instead of listing
// every individual tool.

const EXPLORE_TOOLS = new Set<string>([
  'read_file',
  'list_files',
  'glob',
])
const SEARCH_TOOLS = new Set<string>([
  'grep',
  'WebSearch',
  'web_fetch',
])
const EDIT_TOOLS = new Set<string>([
  'edit_file',
  'write_file',
  'NotebookEdit',
])
const COMMAND_TOOLS = new Set<string>([
  'bash',
  'PowerShell',
])

interface ToolUseCounts {
  explored: number
  searched: number
  edited: number
  ran: number
  other: number
  total: number
}

function countToolUses(toolUses: ToolUseDisplay[]): ToolUseCounts {
  let explored = 0
  let searched = 0
  let edited = 0
  let ran = 0
  let other = 0

  for (const tu of toolUses) {
    const n = tu.name
    if (EXPLORE_TOOLS.has(n)) {
      explored++
      continue
    }
    if (SEARCH_TOOLS.has(n)) {
      searched++
      continue
    }
    if (EDIT_TOOLS.has(n)) {
      edited++
      continue
    }
    if (COMMAND_TOOLS.has(n)) {
      ran++
      continue
    }
    // MCP filesystem variants — classify by verb hint in the tool name.
    if (n.startsWith('mcp__filesystem__')) {
      if (/edit|write|create|move/i.test(n)) edited++
      else explored++
      continue
    }
    other++
  }

  return { explored, searched, edited, ran, other, total: toolUses.length }
}

function pluralize(n: number, singular: string, plural?: string): string {
  return `${n} ${n === 1 ? singular : (plural ?? `${singular}s`)}`
}

/**
 * Bug U-6 fix: pick the verb that best describes what the sub-agent actually did,
 * rather than the historical hard-coded `Explored`. Priority is by impact
 * (edits > commands > searches > reads) so a Debug agent that ran 5 bash
 * commands shows `Ran ... commands`, not `Explored ... commands`. When the
 * agent did nothing yet (still spawning) we keep `Explored` for layout
 * stability — it ships the existing "starting…" placeholder.
 */
function pickActionWord(counts: ToolUseCounts, running: boolean): string {
  if (counts.edited > 0 && counts.edited >= counts.ran) return 'Edited'
  if (counts.ran > 0) return 'Ran'
  if (counts.searched > 0 && counts.searched >= counts.explored) return 'Searched'
  if (counts.explored > 0) return 'Explored'
  if (counts.other > 0) return running ? 'Working on' : 'Used'
  return 'Explored'
}

function buildAggregateSubject(counts: ToolUseCounts, running: boolean): string {
  const parts: string[] = []
  if (counts.explored > 0) parts.push(pluralize(counts.explored, 'file'))
  if (counts.searched > 0) parts.push(pluralize(counts.searched, 'search', 'searches'))
  if (counts.edited > 0) parts.push(pluralize(counts.edited, 'edit'))
  if (counts.ran > 0) parts.push(pluralize(counts.ran, 'command'))
  // `other` is only surfaced when nothing else matched so typical agents
  // don't get a trailing "+ 3 tools" tail that would clutter the row.
  if (parts.length === 0 && counts.other > 0) {
    parts.push(pluralize(counts.other, 'tool'))
  }
  if (parts.length === 0) return running ? 'starting…' : '…'
  return parts.join(', ')
}

function formatDuration(ms?: number): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return undefined
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatTokens(n?: number): string | undefined {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return undefined
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k tok`
  return `${n.toLocaleString()} tok`
}

// eslint-disable-next-line react-refresh/only-export-components
export function getAgentOutputLabel(running: boolean): string {
  return running ? 'Streaming output (进行中)' : 'Output'
}

const AgentBlockInner: React.FC<AgentBlockProps> = ({ agent }) => {
  const status = normalizeCardStatus(agent.status)
  // BUG-U1 fix: derive `running` from the *normalized* CardStatus so that
  // sub-agents in `streaming` / `pending` / `in_progress` states (all of
  // which `normalizeCardStatus` collapses into `running`) still benefit
  // from the streaming UX: auto-scroll-to-bottom on new tool uses, the
  // CSS class `agent-tool-feed-streaming`, and the "starting…" placeholder
  // produced inside `buildAggregateSubject`. Comparing the raw `agent.status`
  // string was missing all of those.
  const running = status === 'running'
  const counts = useMemo(() => countToolUses(agent.toolUses), [agent.toolUses])
  const subject = useMemo(
    () => buildAggregateSubject(counts, running),
    [counts, running],
  )
  const actionWord = useMemo(() => pickActionWord(counts, running), [counts, running])

  // Ref to the nested tool feed viewport. While the sub-agent is still
  // running we clip it to a fixed height and auto-scroll to the bottom
  // on every new tool use — exactly like `ThinkingBlock` does for
  // streaming reasoning. This prevents a long-running sub-agent (e.g.
  // an Explore that touches 40+ files) from expanding the chat message
  // vertically and drifting the reply input off-screen.
  //
  // Bug U-3 fix: the auto-scroll respects the user's manual scroll position.
  // If the user scrolled up to read an earlier tool result, new tool uses
  // no longer yank the viewport back to the bottom. We track "stuck-to-
  // bottom" state via an onScroll listener and only auto-scroll when the
  // user is already within a small tolerance of the bottom.
  const toolFeedRef = useRef<HTMLDivElement | null>(null)
  const isPinnedToBottomRef = useRef(true)
  const toolCount = agent.toolUses.length

  const handleToolFeedScroll = () => {
    const el = toolFeedRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    isPinnedToBottomRef.current = distanceFromBottom < 16
  }

  useEffect(() => {
    if (!running) return
    if (!isPinnedToBottomRef.current) return
    const el = toolFeedRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [running, toolCount])

  const metaPieces = [formatDuration(agent.totalDurationMs), formatTokens(agent.totalTokens)]
    .filter((s): s is string => !!s)
  const meta = metaPieces.length > 0 ? metaPieces.join(' · ') : undefined

  const hasDescription = !!agent.description?.trim()
  const hasSummary = !!agent.structuredSummary
  const hasTools = agent.toolUses.length > 0
  const hasThinking = !!agent.thinking?.trim()
  const hasReasoningSummary = !!agent.reasoningSummary?.trim()
  const todosFromOutput = useMemo(
    () => parseTodoPayloadFromAgentOutput(agent.output),
    [agent.output],
  )
  const displayTodos =
    Array.isArray(agent.todos) && agent.todos.length > 0
      ? agent.todos
      : todosFromOutput
  const hasOutput = !!agent.output?.trim() && !todosFromOutput
  const hasTodos = Array.isArray(displayTodos) && displayTodos.length > 0
  const hasExpandable =
    hasDescription || hasSummary || hasTodos || hasTools || hasThinking || hasReasoningSummary || hasOutput

  return (
    <div
      // Wrapper exists purely as an attachment point for e2e attributes.
      // `display: contents` (set in AgentBlock.css) makes the wrapper
      // transparent to layout so this is a zero-visual-impact change.
      style={{ display: 'contents' }}
      data-testid="agent-block"
      data-e2e-agent-id={agent.agentId}
      data-e2e-agent-type={agent.agentType}
      data-e2e-action-word={actionWord}
      data-e2e-status={agent.status}
      data-e2e-tool-count={agent.toolUses.length}
      data-e2e-has-todos={hasTodos ? 'true' : 'false'}
      data-e2e-has-summary={hasSummary ? 'true' : 'false'}
      data-e2e-output-length={agent.output?.length ?? 0}
    >
    <ActivityRow
      actionWord={actionWord}
      subject={subject}
      meta={meta}
      status={status}
      className="agent-activity-row"
    >
      {hasExpandable ? (
        <div className="agent-expand-body">
          {hasDescription ? (
            <div className="agent-expand-description">
              <span className="agent-expand-description-type">{agent.agentType}</span>
              <span className="agent-expand-description-text">{agent.description}</span>
              {agent.name ? (
                <span className="agent-expand-description-name">({agent.name})</span>
              ) : null}
            </div>
          ) : null}

          {hasTodos && displayTodos ? (
            <SubAgentTodos todos={displayTodos} />
          ) : null}

          {hasSummary && agent.structuredSummary ? (
            <div className="agent-structured-summary">
              <div className="agent-structured-section">
                <div className="agent-structured-title">做了什么</div>
                {agent.structuredSummary.completedWork.map((item, idx) => (
                  <div key={`done-${idx}`} className="agent-structured-item">- {item}</div>
                ))}
              </div>
              <div className="agent-structured-section">
                <div className="agent-structured-title">证据</div>
                {agent.structuredSummary.evidence.map((item, idx) => (
                  <div key={`evidence-${idx}`} className="agent-structured-item">- {item}</div>
                ))}
              </div>
              {agent.structuredSummary.remaining.length > 0 ? (
                <div className="agent-structured-section">
                  <div className="agent-structured-title">还缺什么</div>
                  {agent.structuredSummary.remaining.map((item, idx) => (
                    <div key={`gap-${idx}`} className="agent-structured-item">- {item}</div>
                  ))}
                </div>
              ) : null}
              {agent.structuredSummary.nextStep ? (
                <div className="agent-structured-next">
                  下一步：{agent.structuredSummary.nextStep}
                </div>
              ) : null}
            </div>
          ) : null}

          {hasTools ? (
            <div
              ref={toolFeedRef}
              onScroll={handleToolFeedScroll}
              className={`agent-tool-feed${running ? ' agent-tool-feed-streaming' : ''}`}
            >
              {agent.toolUses.map((toolUse) => (
                <ToolUseCard key={toolUse.id} toolUse={toolUse} />
              ))}
            </div>
          ) : null}

          {hasThinking ? (
            <ThinkingBlock
              content={agent.thinking}
              isStreaming={!!agent.isThinking}
              showSummaryCard
              /* Authoritative wall-clock duration stamped by
                 `subagent_thinking_block_complete` (see
                 `subAgentStreamRouter.ts`). Without this the card relied
                 entirely on the in-component `durationCache`, which loses
                 its value on a React unmount that happens to land outside
                 the cache's stableKey window — visible as a 0.0s snap on
                 the next remount. With it, the post-streaming effect in
                 `ThinkingBlock` overwrites `displayMs` with the canonical
                 elapsed time and the tick value becomes a fallback. */
              thinkingTimeMs={agent.thinkingTimeMs}
              thinkingTokens={agent.thinkingTokens}
              /* Stable identity tied to the sub-agent id keeps the
                 internal tick counter across remounts (e.g. when the
                 parent message re-renders because this sub-agent just
                 auto-collapsed, which reshuffles the React tree). */
              stableKey={`sub-agent:${agent.agentId}:thinking`}
            />
          ) : null}

          {hasReasoningSummary ? (
            <ReasoningSummaryBlock
              content={agent.reasoningSummary}
              isStreaming={!!agent.isReasoningSummarising}
              thinkingTimeMs={agent.reasoningSummaryTimeMs}
              thinkingTokens={agent.reasoningSummaryTokens}
            />
          ) : null}

          {hasOutput && agent.output ? (
            <div
              className="agent-expand-output"
              data-testid="agent-output"
              data-e2e-output-phase={running ? 'streaming' : 'final'}
            >
              <div className="activity-details-label">{getAgentOutputLabel(running)}</div>
              <pre>
                {agent.output.length > 4000
                  ? agent.output.slice(0, 4000) + '\n…(truncated)'
                  : agent.output}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </ActivityRow>
    </div>
  )
}

// Memoised on the single `agent` prop. The store preserves a sub-agent's
// object reference across unrelated re-renders (e.g. the parent message's
// main-text streaming spreads `{ ...m }`, carrying `subAgents` by
// reference), so this skips re-rendering the whole nested tool feed unless
// THIS sub-agent actually changed — while still re-rendering normally when
// the sub-agent itself is streaming (its entry gets a fresh object then).
export const AgentBlock = React.memo(AgentBlockInner)
AgentBlock.displayName = 'AgentBlock'
