import React, { memo, useMemo } from 'react'
import { Wrench, Clock, Square, RotateCcw } from 'lucide-react'
import type { ToolUseDisplay, SubAgentDisplay } from '../../types'
import { toolUseCardPropsEqual } from './toolCardEquality'
import { useTaskOutputSlice } from '../../hooks/useTaskOutput'
import { AgentBlock } from './AgentBlock'
import { BaseCard, CardSection, normalizeCardStatus } from './cards/BaseCard'
import { ActivityRow } from './activity/ActivityRow'
import { CommandChip } from './activity/CommandChip'
import { getToolDisplay } from './activity/toolToAction'
import { WriteEditProgressView } from './activity/WriteEditProgressView'
import { useT } from '../../i18n'
import './ToolUseCard.css'

const WRITE_EDIT_TOOL_NAMES = new Set(['write_file', 'edit_file', 'multi_edit_file'])

interface ToolUseCardProps {
  toolUse: ToolUseDisplay
  taskId?: string
  /**
   * Sub-agents spawned *by* this tool_use. Rendered after the row / chip
   * so their progress stays visible even when the parent collapses.
   */
  subAgents?: SubAgentDisplay[]
  /** Compact chrome — still honoured by the legacy `BaseCard` fallback. */
  compact?: boolean
  /** Callback for the "stop" affordance on running tools. */
  onStop?: (toolUseId: string) => void | Promise<void>
  /** Callback for the "retry" affordance on errored/stopped tools. */
  onRetry?: (toolUseId: string) => void | Promise<void>
}

type EditPayload = {
  filePath: string
  oldText: string
  newText: string
}

function getEditPayload(input: Record<string, unknown>): EditPayload | null {
  const filePath =
    (typeof input.filePath === 'string' && input.filePath) ||
    (typeof input.file_path === 'string' && input.file_path) ||
    ''
  const oldText =
    (typeof input.oldString === 'string' && input.oldString) ||
    (typeof input.old_string === 'string' && input.old_string) ||
    ''
  const newText =
    (typeof input.newString === 'string' && input.newString) ||
    (typeof input.new_string === 'string' && input.new_string) ||
    ''

  if (!oldText && !newText) return null
  return { filePath, oldText, newText }
}

function buildUnifiedDiffLines(oldText: string, newText: string): string[] {
  if (oldText === newText) return ['@@ no changes @@']

  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')

  let firstDiff = 0
  while (
    firstDiff < oldLines.length &&
    firstDiff < newLines.length &&
    oldLines[firstDiff] === newLines[firstDiff]
  ) {
    firstDiff++
  }

  let oldTail = oldLines.length - 1
  let newTail = newLines.length - 1
  while (
    oldTail >= firstDiff &&
    newTail >= firstDiff &&
    oldLines[oldTail] === newLines[newTail]
  ) {
    oldTail--
    newTail--
  }

  const contextBeforeStart = Math.max(0, firstDiff - 2)
  const contextBefore = oldLines.slice(contextBeforeStart, firstDiff)
  const removed = oldLines.slice(firstDiff, oldTail + 1)
  const added = newLines.slice(firstDiff, newTail + 1)
  const contextAfter = oldLines.slice(oldTail + 1, Math.min(oldLines.length, oldTail + 3))

  const diffLines: string[] = [
    `@@ -${firstDiff + 1},${Math.max(removed.length, 1)} +${firstDiff + 1},${Math.max(added.length, 1)} @@`,
  ]

  for (const line of contextBefore) diffLines.push(` ${line}`)
  for (const line of removed) diffLines.push(`-${line}`)
  for (const line of added) diffLines.push(`+${line}`)
  for (const line of contextAfter) diffLines.push(` ${line}`)

  return diffLines
}

function buildOneLineSubtitle(input: Record<string, unknown>): string {
  const edit = getEditPayload(input)
  if (edit?.filePath) return edit.filePath

  const candidateKeys = [
    'command',
    'cmd',
    'pattern',
    'query',
    'path',
    'filePath',
    'file_path',
    'url',
  ]
  for (const key of candidateKeys) {
    const v = input[key]
    if (typeof v === 'string' && v.trim().length > 0) {
      return v.length > 80 ? v.slice(0, 80) + '…' : v
    }
  }
  for (const v of Object.values(input)) {
    if (typeof v === 'string' && v.trim().length > 0) {
      return v.length > 80 ? v.slice(0, 80) + '…' : v
    }
  }
  return ''
}


/**
 * Renders mid-execution streaming chunks emitted by a tool via
 * `ctx.emitToolProgress(...)` (upstream alignment stage 2). Only shown while
 * the tool is still running and the final `result` has not yet arrived —
 * once `result` lands, the card replaces this with the canonical output.
 *
 * `text` rendered as a monospace pre with a hard char cap (so a runaway
 * `bash` stream can't blow up React render cost). `events` rendered as a
 * compact list — each event's `data` JSON.stringified at most one row.
 */
const STREAMING_PROGRESS_VIEW_TEXT_CAP = 8_000

const StreamingProgressView: React.FC<{
  progress: NonNullable<ToolUseDisplay['streamingProgress']>
  className?: string
}> = ({ progress, className }) => {
  const t = useT()
  const text = progress.text || ''
  const events = progress.events || []
  if (!text && events.length === 0) return null

  const shownText =
    text.length > STREAMING_PROGRESS_VIEW_TEXT_CAP
      ? '…' + text.slice(text.length - STREAMING_PROGRESS_VIEW_TEXT_CAP)
      : text

  return (
    <div className={`tool-use-streaming ${className || ''}`}>
      <div className="tool-use-streaming-label">
        <span className="tool-use-streaming-dot" aria-hidden="true" />
        {t.toolCard.streamingOutput}
      </div>
      {shownText ? (
        <pre className="tool-use-streaming-text" style={{ margin: 0, background: 'transparent' }}>
          {shownText}
        </pre>
      ) : null}
      {events.length > 0 ? (
        <ul className="tool-use-streaming-events">
          {events.slice(-20).map((ev, i) => (
            <li key={i} className="tool-use-streaming-event">
              <span className="tool-use-streaming-event-type">{ev.type}</span>
              <span className="tool-use-streaming-event-data">
                {(() => {
                  try {
                    const json = JSON.stringify(ev.data)
                    return json.length > 120 ? json.slice(0, 120) + '…' : json
                  } catch {
                    return String(ev.data)
                  }
                })()}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function hasStreamingProgress(toolUse: ToolUseDisplay): boolean {
  const sp = toolUse.streamingProgress
  if (!sp) return false
  return !!(sp.text && sp.text.length > 0) || !!(sp.events && sp.events.length > 0)
}

/**
 * Renders a tool failure using its structured fields when present:
 *   - `errorWhat` becomes the headline (typographic emphasis)
 *   - `errorNext` becomes a bulleted recovery-hint list (visually
 *     distinct so the user / next-turn model can act on it)
 *   - `errorTried` is collapsed into a muted sub-line (rarely actioned)
 *   - `errorContext` shows as key=value pairs
 *   - the original flattened `error` string is hidden behind a "Show raw"
 *     toggle — it's what the model sees, but for a human reading the
 *     transcript it's redundant when the structured fields are present
 *
 * Fallback: when no structured fields are present (legacy tools that
 * still throw or emit only a string), render the `error` string verbatim
 * as before — zero visual regression for unmigrated tools.
 *
 * The `toolErrorClass` (e.g. `'permission_denied'`, `'mcp'`,
 * `'parallel_abort'`) is surfaced as a small badge so the user can tell
 * at a glance whether this was a model-input issue (retry-able by the
 * model itself), a provider outage (waiting won't help), or a sandbox
 * permission denial (needs user approval).
 */
const ERROR_CLASS_BADGE_LABEL: Record<string, string> = {
  permission_denied: 'permission',
  validation: 'validation',
  filesystem: 'filesystem',
  network: 'network',
  timeout: 'timeout',
  not_found: 'not found',
  rate_limit: 'rate limit',
  mcp: 'MCP',
  shell: 'shell',
  parallel_abort: 'aborted',
  unknown: 'error',
  // Infrastructural buckets set explicitly by the tool runtime:
  aborted: 'aborted',
  worker_crashed: 'worker crashed',
  spawn_failed: 'spawn failed',
  host_disposed: 'host disposed',
  host_killed: 'host killed',
  worker_error: 'worker error',
  post_failed: 'post failed',
  invalid_input: 'invalid input',
  cache_miss: 'cache miss',
  cache_read_error: 'cache error',
}

const StructuredErrorView: React.FC<{ toolUse: ToolUseDisplay }> = ({ toolUse }) => {
  const t = useT()
  const hasStructured = !!(
    toolUse.errorWhat ||
    (toolUse.errorNext && toolUse.errorNext.length > 0) ||
    (toolUse.errorTried && toolUse.errorTried.length > 0) ||
    (toolUse.errorContext && Object.keys(toolUse.errorContext).length > 0)
  )
  const [showRaw, setShowRaw] = React.useState(false)

  // Legacy path: no structured fields → render the flat `error` blob.
  if (!hasStructured) {
    if (!toolUse.error) return null
    return (
      <div>
        <div className="activity-details-label">{t.toolCard.errorLabel}</div>
        <pre className="is-error">{toolUse.error}</pre>
      </div>
    )
  }

  const cls = toolUse.toolErrorClass
  const badgeLabel = cls ? (ERROR_CLASS_BADGE_LABEL[cls] ?? cls) : undefined
  const tried = toolUse.errorTried
  const next = toolUse.errorNext
  const ctx = toolUse.errorContext

  return (
    <div className="tool-error-structured">
      <div className="tool-error-headline-row">
        {badgeLabel ? (
          <span className={`tool-error-class-badge tool-error-class-${cls}`}>{badgeLabel}</span>
        ) : null}
        <span className="tool-error-headline">{toolUse.errorWhat}</span>
      </div>

      {next && next.length > 0 ? (
        <div className="tool-error-next">
          <div className="tool-error-section-label">{t.toolCard.next}</div>
          <ul className="tool-error-next-list">
            {next.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {tried && tried.length > 0 ? (
        <div className="tool-error-tried">
          <span className="tool-error-section-label">{t.toolCard.tried}</span>
          <span className="tool-error-tried-value">{tried.join('  |  ')}</span>
        </div>
      ) : null}

      {ctx && Object.keys(ctx).length > 0 ? (
        <div className="tool-error-context">
          <span className="tool-error-section-label">{t.toolCard.context}</span>
          <span className="tool-error-context-value">
            {Object.entries(ctx)
              .map(([k, v]) => `${k}=${String(v)}`)
              .join(', ')}
          </span>
        </div>
      ) : null}

      {toolUse.error ? (
        <div className="tool-error-raw-toggle">
          <button
            type="button"
            className="tool-error-raw-button"
            onClick={() => setShowRaw((v) => !v)}
            aria-expanded={showRaw}
          >
            {showRaw ? t.toolCard.hideRaw : t.toolCard.showRaw}
          </button>
          {showRaw ? <pre className="tool-error-raw is-error">{toolUse.error}</pre> : null}
        </div>
      ) : null}
    </div>
  )
}

/**
 * Whether to surface `streamingProgress` in the card body. Skip once the
 * final result/error lands (the canonical output is richer); skip when the
 * task-output stream is already feeding `displayOutput` (avoid double UI
 * for bash, which has both task chunks and tool_progress chunks).
 */
function shouldShowStreaming(
  toolUse: ToolUseDisplay,
  taskOutputChunkCount: number,
): boolean {
  if (toolUse.result || toolUse.error) return false
  if (taskOutputChunkCount > 0) return false
  return hasStreamingProgress(toolUse)
}

const ToolUseCardInner: React.FC<ToolUseCardProps> = ({
  toolUse,
  taskId,
  subAgents,
  compact = false,
  onStop,
  onRetry,
}) => {
  const t = useT()
  // Per-task slice subscription: this card only re-renders when ITS task's
  // output changes, not when any other tool's bash/stream output ticks
  // (the old `useTaskOutput()` subscribed to the whole `byId` map).
  const taskOutput = useTaskOutputSlice(taskId)
  const rawStatus: ToolUseDisplay['status'] = taskOutput?.status || toolUse.status
  const cardStatus = normalizeCardStatus(rawStatus)
  const displayOutput = taskOutput?.chunks || []

  // ─── Phase 1: route first-wave tools to the new feed-style chrome ────
  // Tools not in the mapping table fall through to the legacy `BaseCard`
  // path below, so nothing disappears during incremental migration.

  const display = useMemo(
    () => getToolDisplay(toolUse.name, toolUse.input),
    [toolUse.name, toolUse.input],
  )

  // ─── Stop / Retry affordances ────────────────────────────────────────
  // Wired into every card chrome (ActivityRow / CommandChip / BaseCard).
  // Stop shows while the tool is running; Retry shows once it errored or
  // was stopped. The handlers come from the chat store via ChatMessage
  // (module-level stable identities, so the card memo still skips).
  const showStop = cardStatus === 'running' && !!onStop
  const showRetry =
    (rawStatus === 'error' || rawStatus === 'failed' || rawStatus === 'stopped') && !!onRetry
  const actionButtons =
    showStop || showRetry ? (
      <>
        {showStop ? (
          <button
            type="button"
            className="tool-card-action-btn is-stop"
            title={t.toolCard.stop}
            aria-label={t.toolCard.stop}
            onClick={(e) => {
              e.stopPropagation()
              void onStop?.(toolUse.id)
            }}
          >
            <Square size={10} />
          </button>
        ) : null}
        {showRetry ? (
          <button
            type="button"
            className="tool-card-action-btn is-retry"
            title={t.toolCard.retry}
            aria-label={t.toolCard.retry}
            onClick={(e) => {
              e.stopPropagation()
              void onRetry?.(toolUse.id)
            }}
          >
            <RotateCcw size={11} />
          </button>
        ) : null}
      </>
    ) : null

  // ─── Agent-spawner collapse ──────────────────────────────────────────
  // The `Agent` tool exists solely to spin up a sub-agent. Once the
  // sub-agent has emitted its own card (`subAgents.length > 0`) the
  // outer "Agent wrench card" wrapping an inner "Explored 6 files"
  // row is pure chrome noise — it doubles the vertical footprint and
  // duplicates the status signalling. We therefore render JUST the
  // sub-agent rows and let the parent tool silently disappear.
  //
  // Scope intentionally narrow:
  //   - Do NOT include `Task*` tools here. Those are shell-task-runtime
  //     management (TaskList / TaskGet / TaskStop / …); they never
  //     carry `subAgents` so matching them is dead code, and anyone
  //     reading the list would wrongly assume those tools spawn agents.
  //   - `SwarmMultiplexer` is the only other known spawner; add it
  //     here if/when it is wired up to emit sub-agents. Until then,
  //     matching it is also dead code, so keep the condition tight.
  //
  // IMPORTANT: this early return MUST live after all hooks (`useMemo`
  // above) — React hooks must be called in the same order on every
  // render, so we can't short-circuit ahead of them.
  if (toolUse.name === 'Agent' && subAgents && subAgents.length > 0) {
    return (
      <>
        {subAgents.map((sa) => (
          <AgentBlock key={sa.agentId} agent={sa} />
        ))}
      </>
    )
  }

  // ─── Shell / PowerShell → CommandChip ────────────────────────────────
  if (display?.kind === 'command') {
    const showStreaming = shouldShowStreaming(toolUse, displayOutput.length)
    const hasOutput =
      displayOutput.length > 0 || !!toolUse.result || !!toolUse.error || showStreaming
    return (
      <>
        <CommandChip
          shell={display.shell}
          command={display.command}
          status={cardStatus}
          autoExpand={cardStatus === 'running' && hasOutput}
          persistKey={toolUse.id}
          actions={actionButtons}
        >
          {hasOutput ? (
            <>
              {displayOutput.length > 0
                ? displayOutput.map((chunk, idx) => (
                    <div key={idx} className={`output-chunk output-${chunk.stream}`}>
                      {chunk.text}
                    </div>
                  ))
                : null}
              {displayOutput.length === 0 && toolUse.result ? (
                <pre className="tool-use-pre" style={{ margin: 0, background: 'transparent' }}>
                  {toolUse.result.length > 4000
                    ? toolUse.result.slice(0, 4000) + '\n…' + t.toolCard.truncated
                    : toolUse.result}
                </pre>
              ) : null}
              {showStreaming && toolUse.streamingProgress ? (
                <StreamingProgressView progress={toolUse.streamingProgress} />
              ) : null}
              {toolUse.error || toolUse.errorWhat ? (
                <StructuredErrorView toolUse={toolUse} />
              ) : null}
            </>
          ) : null}
        </CommandChip>
        {subAgents && subAgents.length > 0 ? (
          <div className="tool-use-sub-agents" style={{ borderTop: 'none', paddingTop: 2 }}>
            {subAgents.map((sa) => (
              <AgentBlock key={sa.agentId} agent={sa} />
            ))}
          </div>
        ) : null}
      </>
    )
  }

  // ─── File / search / web tools → ActivityRow ─────────────────────────
  if (display?.kind === 'activity') {
    const showStreaming = shouldShowStreaming(toolUse, 0)
    // Write/Edit progress card: render the model's in-progress `content`
    // / `newString` while the tool_use JSON is still streaming, then keep
    // showing the same content (sourced from the canonical `input` field)
    // after `tool_start` lands. IDE-style live writing view.
    const isWriteEditTool = WRITE_EDIT_TOOL_NAMES.has(toolUse.name)
    const hasStreamingInput = !!(
      toolUse.streamingInput && toolUse.streamingInput.partialJson
    )
    const showWriteEditProgress =
      isWriteEditTool && (hasStreamingInput || cardStatus === 'running' || !!toolUse.result)
    const hasDetails =
      !!toolUse.result || !!toolUse.error || showStreaming || showWriteEditProgress
    return (
      <>
        <ActivityRow
          actionWord={display.actionWord}
          subject={display.subject}
          meta={display.meta}
          actions={actionButtons}
          status={cardStatus}
          // Auto-expand while streaming OR while the Write/Edit progress
          // card has content to show — both windows surface live progress
          // the user shouldn't have to click to see.
          defaultExpanded={showStreaming || showWriteEditProgress}
          // Persist the user's collapse choice across unmount/remount
          // (virtualized scroll windows messages out of the tree).
          persistKey={toolUse.id}
        >
          {hasDetails ? (
            <>
              {showWriteEditProgress ? (
                <WriteEditProgressView
                  toolName={toolUse.name}
                  input={toolUse.input}
                  streamingInput={toolUse.streamingInput}
                  status={toolUse.status}
                />
              ) : null}
              {/*
               * Output panel runs INDEPENDENT of the streaming card.
               * P1-5 regression fix: previously the progress card's
               * presence shadowed this branch, hiding the tool's
               * success message ("Wrote 42 lines to foo.ts") after a
               * write finished. The two surfaces carry different
               * information — the card shows file content, this row
               * shows the tool's stdout — so they should coexist.
               * For Write/Edit tools we collapse the verbose default
               * 2KB cap to a single-line hint when the progress card
               * is already showing the content, to avoid duplicate
               * line counts dominating the card.
               */}
              {toolUse.result ? (
                <div>
                  <div className="activity-details-label">{t.toolCard.outputLabel}</div>
                  <pre>
                    {(() => {
                      const r = toolUse.result
                      // Collapse to first line when content is already
                      // visible in the progress card above. The first
                      // line of a Write/Edit tool's result is the
                      // human-readable summary ("Wrote N lines to …");
                      // remaining lines are usually a diff or content
                      // echo we don't need to repeat.
                      if (showWriteEditProgress) {
                        const firstLine = r.split(/\r?\n/, 1)[0] ?? ''
                        return firstLine.length > 200
                          ? firstLine.slice(0, 200) + '…'
                          : firstLine
                      }
                      return r.length > 2000 ? r.slice(0, 2000) + '\n…' + t.toolCard.truncated : r
                    })()}
                  </pre>
                </div>
              ) : null}
              {showStreaming && toolUse.streamingProgress ? (
                <div>
                  <div className="activity-details-label">{t.toolCard.streamingOutput}</div>
                  <StreamingProgressView progress={toolUse.streamingProgress} />
                </div>
              ) : null}
              {toolUse.error || toolUse.errorWhat ? (
                <StructuredErrorView toolUse={toolUse} />
              ) : null}
            </>
          ) : null}
        </ActivityRow>
        {subAgents && subAgents.length > 0 ? (
          <div className="tool-use-sub-agents" style={{ borderTop: 'none', paddingTop: 2 }}>
            {subAgents.map((sa) => (
              <AgentBlock key={sa.agentId} agent={sa} />
            ))}
          </div>
        ) : null}
      </>
    )
  }

  // ─── Fallback: unmigrated tools keep the legacy BaseCard look ────────
  // Reached only for tools without a `getToolDisplay` mapping: unregistered
  // / plugin tools, and MCP tools whose names don't match the
  // `mcp__<server>__<method>` pattern. All built-ins (TodoWrite, LSP,
  // NotebookEdit, Agent, …) have mappings in `activity/toolToAction.ts`.

  const inputText = ((): string => {
    const lines: string[] = []
    for (const [key, value] of Object.entries(toolUse.input)) {
      if (typeof value === 'string') {
        lines.push(`${key}: ${value.length > 200 ? value.slice(0, 200) + '…' : value}`)
      } else {
        lines.push(`${key}: ${JSON.stringify(value)}`)
      }
    }
    return lines.join('\n')
  })()

  const outputText = toolUse.result || ''
  const errorText = toolUse.error || ''

  const editPayload = getEditPayload(toolUse.input)
  const shouldShowEditDiff =
    !!editPayload &&
    editPayload.oldText.length <= 12000 &&
    editPayload.newText.length <= 12000
  const diffLines = shouldShowEditDiff
    ? buildUnifiedDiffLines(editPayload!.oldText, editPayload!.newText)
    : []
  const diffText = shouldShowEditDiff ? diffLines.join('\n') : ''

  const subtitle = buildOneLineSubtitle(toolUse.input)
  const statusLabelMap: Record<string, string> = {
    running: t.toolCard.statusRunning,
    completed: t.toolCard.statusCompleted,
    failed: t.toolCard.statusFailed,
    error: t.toolCard.statusFailed,
    stopped: t.toolCard.statusStopped,
  }
  const statusLabel = statusLabelMap[rawStatus] ?? rawStatus

  const showStreamingInBaseCard = shouldShowStreaming(toolUse, displayOutput.length)
  const bodyHasContent =
    inputText.length > 0 ||
    shouldShowEditDiff ||
    displayOutput.length > 0 ||
    (!taskOutput && outputText.length > 0) ||
    errorText.length > 0 ||
    showStreamingInBaseCard

  return (
    <BaseCard
      status={cardStatus}
      compact={compact}
      persistKey={toolUse.id}
      icon={<Wrench size={14} />}
      title={toolUse.name}
      subtitle={subtitle || undefined}
      meta={
        <span className={`tool-status-chip tool-status-chip-${cardStatus}`}>
          {cardStatus === 'running' ? (
            <Clock size={10} className="tool-status-chip-icon" />
          ) : null}
          {statusLabel}
        </span>
      }
      actions={actionButtons}
      footer={
        subAgents && subAgents.length > 0 ? (
          <>
            {subAgents.map((sa) => (
              <AgentBlock key={sa.agentId} agent={sa} />
            ))}
          </>
        ) : null
      }
    >
      {bodyHasContent ? (
        <>
          {inputText.length > 0 ? (
            <CardSection label={t.toolCard.inputLabel} copyText={inputText}>
              <pre className="tool-use-pre">{inputText}</pre>
            </CardSection>
          ) : null}

          {shouldShowEditDiff ? (
            <CardSection
              label={
                <span>
                  {t.toolCard.diffPreview}
                  {editPayload?.filePath ? ` · ${editPayload.filePath}` : ''}
                </span>
              }
              copyText={diffText}
            >
              <div className="tool-use-diff">
                {diffLines.map((line, index) => {
                  const lineClass = line.startsWith('@@')
                    ? 'meta'
                    : line.startsWith('+')
                      ? 'added'
                      : line.startsWith('-')
                        ? 'removed'
                        : 'context'
                  return (
                    <div
                      key={`${index}-${line.slice(0, 12)}`}
                      className={`tool-use-diff-line ${lineClass}`}
                    >
                      {line}
                    </div>
                  )
                })}
              </div>
            </CardSection>
          ) : null}

          {displayOutput.length > 0 ? (
            <CardSection label={t.toolCard.outputLabel}>
              <div className="tool-use-output">
                {displayOutput.map((chunk, idx) => (
                  <div key={idx} className={`output-chunk output-${chunk.stream}`}>
                    {chunk.text}
                  </div>
                ))}
              </div>
            </CardSection>
          ) : null}

          {!taskOutput && outputText ? (
            <CardSection label={t.toolCard.outputLabel} copyText={outputText}>
              <pre className="tool-use-pre">
                {outputText.length > 2000
                  ? outputText.slice(0, 2000) + '\n…' + t.toolCard.truncated
                  : outputText}
              </pre>
            </CardSection>
          ) : null}

          {showStreamingInBaseCard && toolUse.streamingProgress ? (
            <CardSection label={t.toolCard.streamingOutput}>
              <StreamingProgressView progress={toolUse.streamingProgress} />
            </CardSection>
          ) : null}

          {errorText || toolUse.errorWhat ? (
            <CardSection label={t.toolCard.errorLabel} copyText={errorText || toolUse.errorWhat || ''}>
              <StructuredErrorView toolUse={toolUse} />
            </CardSection>
          ) : null}
        </>
      ) : null}
    </BaseCard>
  )
}

// Memoised on the render-affecting fields (see `toolCardEquality`). The
// `toolUse` wrapper object is rebuilt by `ChatMessage` every render, so the
// custom comparator — not the default shallow compare — is what lets an
// unchanged tool card skip re-rendering while sibling text streams.
export const ToolUseCard = memo(ToolUseCardInner, toolUseCardPropsEqual)
ToolUseCard.displayName = 'ToolUseCard'
