/**
 * ToolBlockGroup — aggregate row for a batch of tool_use blocks emitted
 * by the model in a single turn.
 *
 * Parity with the previous revision:
 *   - Same `{ tools, onStop, onRetry }` API — no caller changes.
 *   - Force-expanded while any batched tool is still running (the user
 *     needs to watch live progress; they can't hide it).
 *   - User can toggle expansion once the batch settles.
 *
 * What's new (Phase 3-continuation):
 *   - Collapsed surface is a single `ActivityRow` with a dominant-verb
 *     aggregate sentence, matching the `AgentBlock` language so
 *     mixed-batch transcripts read homogeneously.
 *   - Expanded body renders each tool through the shared `ToolUseCard`
 *     dispatcher, producing the same `ActivityRow` / `CommandChip` /
 *     `BaseCard` fallback treatment as top-level tool calls.
 */
import React, { memo, useMemo, useState } from 'react'
import type { SubAgentDisplay, ToolUseDisplay } from '../../types'
import { ActivityRow } from './activity/ActivityRow'
import { normalizeCardStatus, type CardStatus } from './cards/BaseCard'
import { ToolUseCard } from './ToolUseCard'
import { toolBlockGroupPropsEqual } from './toolCardEquality'
import { resolveInitialExpanded, setCardExpanded } from './cardCollapseStore'
import { useT, type Messages } from '../../i18n'
import './ToolBlockGroup.css'

interface ToolBlockGroupProps {
  tools: Array<{
    id: string
    name: string
    input: Record<string, unknown>
    status: 'running' | 'completed' | 'error' | 'failed' | 'stopped'
    result?: string
    error?: string
    // Structured failure fields, forwarded to the inner `ToolUseCard` (via the
    // `tool as ToolUseDisplay` cast below) so batched tool calls show the same
    // structured error UI as top-level ones.
    toolErrorClass?: string
    errorWhat?: string
    errorTried?: string[]
    errorContext?: Record<string, string | number | null | undefined>
    errorNext?: string[]
    taskId?: string
    /**
     * Sub-agents spawned by *this* tool (indexed by `parentToolId`).
     * Plumbed through to the inner `ToolUseCard` so Agent tools batched
     * with siblings still get their sub-agent UI.
     */
    subAgents?: SubAgentDisplay[]
    /**
     * P0-1 fix: stage-2 streaming progress chunks merged from
     * `message.toolUses[].streamingProgress` so the inner `ToolUseCard`
     * can render the "实时输出" feed even for batched tool calls.
     */
    streamingProgress?: ToolUseDisplay['streamingProgress']
    /**
     * Model-time tool_use JSON arguments buffer for the IDE-style
     * Write/Edit progress card. Mirrors the `streamingProgress` plumb
     * but sources from `tool_input_delta` events.
     */
    streamingInput?: ToolUseDisplay['streamingInput']
  }>
  onStop: (toolUseId: string) => void
  onRetry: (toolUseId: string) => void
}

// ─── Tool categorisation (mirrors AgentBlock's buckets) ──────────────

const EXPLORE = new Set<string>(['read_file', 'list_files', 'glob'])
const SEARCH = new Set<string>(['grep', 'WebSearch', 'web_fetch'])
const EDIT = new Set<string>(['edit_file', 'write_file', 'NotebookEdit'])
const COMMAND = new Set<string>(['bash', 'PowerShell'])

interface Counts {
  explored: number
  searched: number
  edited: number
  ran: number
  other: number
  total: number
}

function countByCategory(tools: ToolBlockGroupProps['tools']): Counts {
  let explored = 0
  let searched = 0
  let edited = 0
  let ran = 0
  let other = 0
  for (const t of tools) {
    if (EXPLORE.has(t.name)) {
      explored++
      continue
    }
    if (SEARCH.has(t.name)) {
      searched++
      continue
    }
    if (EDIT.has(t.name)) {
      edited++
      continue
    }
    if (COMMAND.has(t.name)) {
      ran++
      continue
    }
    if (t.name.startsWith('mcp__filesystem__')) {
      if (/edit|write|create|move/i.test(t.name)) edited++
      else explored++
      continue
    }
    other++
  }
  return { explored, searched, edited, ran, other, total: tools.length }
}

/**
 * Pick a single verb representing the dominant activity in the batch.
 * Mixed batches fall through to `Used` — the subject sentence carries
 * the full breakdown anyway ("2 files, 1 edit, 1 command").
 */
function pickDominantVerb(c: Counts, tc: Messages['toolCard']): string {
  const max = Math.max(c.explored, c.searched, c.edited, c.ran, c.other)
  if (max === 0) return tc.verbQueued
  // Ties break in Explored > Edited > Ran > Searched > Used order —
  // biased toward the verb that reads most naturally in logs.
  if (c.explored === max) return tc.verbExplored
  if (c.edited === max) return tc.verbEdited
  if (c.ran === max) return tc.verbRan
  if (c.searched === max) return tc.verbSearched
  return tc.verbUsed
}

function buildSubject(c: Counts, tc: Messages['toolCard']): string {
  const parts: string[] = []
  if (c.explored > 0) parts.push(tc.unitFiles(c.explored))
  if (c.searched > 0) parts.push(tc.unitSearches(c.searched))
  if (c.edited > 0) parts.push(tc.unitEdits(c.edited))
  if (c.ran > 0) parts.push(tc.unitCommands(c.ran))
  if (parts.length === 0 && c.other > 0) parts.push(tc.unitTools(c.other))
  if (parts.length === 0) return '…'
  return parts.join(', ')
}

const ToolBlockGroupInner: React.FC<ToolBlockGroupProps> = ({
  tools,
  onStop,
  onRetry,
}) => {
  const t = useT()
  const counts = useMemo(() => countByCategory(tools), [tools])

  const runningCount = useMemo(
    () => tools.filter((t) => t.status === 'running').length,
    [tools],
  )
  const completedCount = useMemo(
    () => tools.filter((t) => t.status === 'completed').length,
    [tools],
  )
  const erroredCount = useMemo(
    () =>
      tools.filter(
        (t) => t.status === 'error' || t.status === 'failed' || t.status === 'stopped',
      ).length,
    [tools],
  )

  const hasActive = runningCount > 0
  // Persist the collapse choice across unmount/remount (virtualized scroll
  // windows messages out of the tree). Anchored on the first tool id, which
  // is stable as the batch grows.
  const persistKey = `group:${tools[0]?.id ?? ''}`
  const [userExpanded, setUserExpanded] = useState<boolean>(() =>
    resolveInitialExpanded(persistKey, false),
  )
  // Force-expand while anything is running so progress stays visible.
  const expanded = hasActive || userExpanded

  const status: CardStatus = hasActive
    ? 'running'
    : erroredCount > 0
      ? 'error'
      : 'success'

  // Normalize just to surface the same union shape in debug snapshots.
  // Not used beyond that, but cheap and keeps the component honest.
  void normalizeCardStatus

  const actionWord = hasActive ? t.toolCard.verbRunning : pickDominantVerb(counts, t.toolCard)
  const subject = buildSubject(counts, t.toolCard)

  // Progress / failure indicator in the meta slot.
  const metaPieces: string[] = []
  if (hasActive) {
    metaPieces.push(`${completedCount}/${tools.length}`)
  } else if (erroredCount > 0) {
    metaPieces.push(t.toolCard.groupFailedOf(erroredCount, tools.length))
  }
  const meta = metaPieces.length > 0 ? metaPieces.join(' · ') : undefined

  return (
    <ActivityRow
      actionWord={actionWord}
      subject={subject}
      meta={meta}
      status={status}
      expanded={expanded}
      onExpandedChange={(next) => {
        // Ignore collapse attempts while a tool is still running —
        // the `expanded` prop we compute above already reflects that
        // invariant, but explicitly guarding here prevents the local
        // user state from drifting out of sync.
        if (hasActive && !next) return
        setUserExpanded(next)
        setCardExpanded(persistKey, next)
      }}
      className="tool-block-group-row"
    >
      <div className="tool-block-group-feed">
        {tools.map((tool) => (
          <ToolUseCard
            key={tool.id}
            toolUse={tool as ToolUseDisplay}
            taskId={tool.taskId}
            subAgents={tool.subAgents}
            // Forward the (stable, module-level) handlers directly instead of
            // wrapping in `() => onStop(tool.id)`: a fresh closure per render
            // would change identity every time the group re-renders and defeat
            // each child ToolUseCard's memo. The child's onStop signature is
            // `(id) => void`, so a direct pass is also semantically correct.
            onStop={onStop}
            onRetry={onRetry}
          />
        ))}
      </div>
    </ActivityRow>
  )
}

// Memoised on `tools` (element-wise) + the stable onStop/onRetry — gates the
// whole batch from re-rendering while unrelated message text streams.
export const ToolBlockGroup = memo(ToolBlockGroupInner, toolBlockGroupPropsEqual)
ToolBlockGroup.displayName = 'ToolBlockGroup'
