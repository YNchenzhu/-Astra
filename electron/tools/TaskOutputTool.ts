import { taskRuntimeStore } from './TaskRuntimeStore'
import { taskOutputInputZod } from './toolInputZod'
import { buildTool } from './buildTool'

const DEFAULT_WAIT_TIMEOUT_MS = 5_000
/**
 * Hard ceiling on a SINGLE TaskOutput `wait_for_status` call: 120s.
 *
 * Why a hard cap (was 30 min): a single synchronous TaskOutput call that
 * blocks for minutes freezes the agent on the "Task output" step — the exact
 * UX bug we hit, where a background task wasn't done and the agent never
 * moved on. Capping the block at 120s guarantees the call returns promptly;
 * for anything longer the agent is told to continue and the completion is
 * delivered out-of-band:
 *   - sub-agents → synthetic `<system-reminder>` context block on the next turn,
 *   - Bash / other runtime tasks → `<task_notifications>` XML drained at the
 *     next tool-round boundary (see `taskRuntimeNotifications` collector),
 *   - the idle conversation is auto-resumed when a background task finishes
 *     (see `autoResumeBackgroundTasks`).
 * So no functionality is lost by the lower cap — only the "frozen for minutes"
 * failure mode is removed. Longer waits just become "return at 120s →
 * continue → get notified on completion".
 *
 * The wait is event-driven (subscribed to `taskRuntimeStore` chunk
 * callbacks), not polled, so it still wakes the moment the task moves.
 */
const MAX_WAIT_TIMEOUT_MS = 120_000

/**
 * Contract audit (2026-07) — runtime rate-limit on polling RUNNING background
 * sub-agents. The "don't poll auto-delivering sub-agents" contract used to be
 * prompt-text only (tool description + empty-buffer guidance), which a model
 * under pressure routinely ignores, burning tokens and pulling mid-flight
 * noise into the parent's context. This makes it a hard(ish) constraint:
 *
 *   A repeat TaskOutput read of the SAME running sub-agent within the
 *   cooldown window, when NO new output has arrived since the previous read,
 *   short-circuits with a compact auto-defer notice instead of re-rendering
 *   the buffer (and instead of entering a blocking wait).
 *
 * Deliberately narrow so legitimate uses stay intact:
 *   - only `kind === 'agent'` (Bash & other runtime tasks have no
 *     auto-delivery channel — polling them can be the right move),
 *   - only non-terminal records (completed/failed readbacks always pass),
 *   - only when the buffer did not grow since the last read (new output =
 *     fresh information = the read is useful),
 *   - first read is always allowed (the map is populated on the way out).
 */
const AGENT_POLL_COOLDOWN_MS = 30_000
const recentAgentPolls = new Map<string, { at: number; totalAvailable: number }>()

function pruneRecentAgentPolls(now: number): void {
  if (recentAgentPolls.size < 200) return
  for (const [key, v] of recentAgentPolls) {
    if (now - v.at > AGENT_POLL_COOLDOWN_MS) recentAgentPolls.delete(key)
  }
}

export const taskOutputTool = buildTool({
  name: 'TaskOutput',
  zInputSchema: taskOutputInputZod,
  description:
    'Read output buffered for a runtime task (Bash, Agent, or other). ' +
    'For background sub-agents, you normally do NOT need this tool: the runtime pushes new sub-agent output (delta + terminal status notice) into your context on the next user turn as a `<system-reminder>` block, and emits `<task_notifications>` XML at tool-round boundaries. Don\'t peek, don\'t race — calling TaskOutput on a sub-agent that is auto-delivering only burns tokens and pulls mid-flight tool noise into your context. ' +
    'Use TaskOutput when (1) the user **explicitly** asks to see a sub-agent\'s in-flight transcript; (2) the task is **not** a sub-agent (e.g. Bash) and you need its stdout/stderr now; or (3) you need to re-read a completed task\'s buffer with offset/limit pagination. ' +
    'task_id is the parent tool invocation id (the tool_use id / ToolUseCard id). For Agent results use `taskOutputTaskId` from the spawn JSON; `agentId` is also accepted and resolves to the same runtime record. Supports offset/limit pagination and text/json formats. ' +
    'When you genuinely need to wait (case 2 above), pass `wait_for_status` ("completed" | "failed" | "any_terminal" | "has_output") with a short `wait_timeout_ms` — the wait is event-driven, not a busy poll. Do NOT default to `wait_for_status: "any_terminal"` for background sub-agents; that turns the parent into a polling machine and bypasses the auto-delivery channel that already covers the same case. ' +
    'Runtime enforcement: repeat reads of a RUNNING sub-agent within 30s that have no new output are auto-deferred (rate-limited) — the call returns a short notice instead of the buffer, so polling in a loop gains nothing. ' +
    'Note: OpenClaude coordinator docs refer to SyntheticOutput for delegated output; this product uses TaskOutput only (the legacy name SyntheticOutput is accepted as a routing alias). This is not OpenClaude SDK StructuredOutput (arbitrary JSON schema).',
  inputSchema: [
    {
      name: 'task_id',
      type: 'string',
      description:
        'Runtime task key: parent tool_use id, or sub-agent agentId (aliased to that tool call). Prefer taskOutputTaskId from Agent tool JSON when shown.',
      required: true,
    },
    { name: 'offset', type: 'number', description: 'Starting offset in output stream (default: 0)' },
    { name: 'limit', type: 'number', description: 'Maximum chunks to return (default: 200, max: 1000)' },
    { name: 'format', type: 'string', description: 'Output format', enum: ['text', 'json'] },
    {
      name: 'wait_for_status',
      type: 'string',
      description:
        'Optional: block this call until the task reaches a status (or new output arrives). ' +
        'Prefer leaving this UNSET for background sub-agents — completion is already auto-delivered on the next user turn (synthetic-context-block) and at tool-round boundaries (`<task_notifications>` XML). Use it for non-sub-agent runtime tasks (Bash, etc.) or when the user explicitly asked for a progress check on a specific sub-agent. ' +
        '"completed" = wait for success terminal; "failed" = wait for failure or stopped; ' +
        '"any_terminal" = wait for any non-running state; "has_output" = wake as soon as new chunks arrive past `offset`.',
      enum: ['completed', 'failed', 'any_terminal', 'has_output'],
    },
    {
      name: 'wait_timeout_ms',
      type: 'number',
      description: `Max ms to wait when wait_for_status is set (default ${DEFAULT_WAIT_TIMEOUT_MS}, max ${MAX_WAIT_TIMEOUT_MS}). Ignored if wait_for_status is unset.`,
    },
  ],
  isReadOnly: true,
  isConcurrencySafe: true,
  // TaskOutput's whole purpose is reading back **already buffered** task
  // streams (sub-agent transcripts, long-running shells). The default
  // `DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000` budget would spill the JSON-
  // wrapped sub-agent payload (which sits at ~85-95k after the Agent tool
  // raised its own cap to 100k) into a 2k preview, defeating the readback
  // contract. Pagination via `offset`/`limit` remains the caller's lever
  // for bounded reads; this cap is just the "don't drop everything"
  // ceiling. Aligned with the Read tool's large-content posture rather
  // than the per-tool 50k baseline.
  maxResultChars: 500_000,
  async call({ task_id, offset, limit, format, wait_for_status, wait_timeout_ms }) {
    const taskId = String(task_id ?? '').trim()
    const offsetNum = Number(offset ?? 0)
    const limitNum = Number(limit ?? 200)
    const formatStr = String(format ?? 'text')
    const waitForStatusRaw = wait_for_status as string | undefined
    const waitTimeoutMsRaw = wait_timeout_ms

    if (!taskId) {
      return { success: false, error: 'task_id is required' }
    }

    if (!Number.isFinite(offsetNum) || offsetNum < 0) {
      return { success: false, error: 'offset must be a non-negative number' }
    }

    if (!Number.isFinite(limitNum) || limitNum <= 0) {
      return { success: false, error: 'limit must be a positive number' }
    }

    if (formatStr !== 'text' && formatStr !== 'json') {
      return { success: false, error: 'format must be one of: text, json' }
    }

    const validWaits = new Set(['completed', 'failed', 'any_terminal', 'has_output'])
    const waitForStatus =
      typeof waitForStatusRaw === 'string' && validWaits.has(waitForStatusRaw)
        ? (waitForStatusRaw as 'completed' | 'failed' | 'any_terminal' | 'has_output')
        : undefined
    if (waitForStatusRaw && !waitForStatus) {
      return {
        success: false,
        error: `wait_for_status must be one of: completed, failed, any_terminal, has_output`,
      }
    }

    let waitTimeoutMs = DEFAULT_WAIT_TIMEOUT_MS
    if (typeof waitTimeoutMsRaw === 'number' && Number.isFinite(waitTimeoutMsRaw)) {
      waitTimeoutMs = Math.min(MAX_WAIT_TIMEOUT_MS, Math.max(50, waitTimeoutMsRaw))
    }

    // Contract audit (2026-07) — auto-defer repeat polls of a RUNNING
    // background sub-agent when nothing new arrived since the previous read.
    // Checked BEFORE the wait so a `wait_for_status` re-poll can't turn into
    // another blocking hold either. See `AGENT_POLL_COOLDOWN_MS` above.
    const preRecord = taskRuntimeStore.get(taskId)
    if (
      preRecord &&
      preRecord.kind === 'agent' &&
      (preRecord.status === 'running' || preRecord.status === 'pending')
    ) {
      const now = Date.now()
      const availableNow = preRecord.droppedBefore + preRecord.chunks.length
      const prev = recentAgentPolls.get(preRecord.taskId)
      if (
        prev &&
        now - prev.at < AGENT_POLL_COOLDOWN_MS &&
        availableNow <= prev.totalAvailable
      ) {
        const secsAgo = Math.max(1, Math.round((now - prev.at) / 1000))
        const secsLeft = Math.max(
          1,
          Math.ceil((AGENT_POLL_COOLDOWN_MS - (now - prev.at)) / 1000),
        )
        return {
          success: true,
          output:
            `Task ${preRecord.taskId} (agent)\n` +
            `Status: ${preRecord.status} (active)\n` +
            `[auto-deferred] You already read this running background sub-agent ${secsAgo}s ago and NO new output has arrived since. ` +
            `Repeat polling is rate-limited (cooldown ${Math.round(AGENT_POLL_COOLDOWN_MS / 1000)}s; ~${secsLeft}s remaining). ` +
            'Do other useful work now — the runtime auto-delivers sub-agent completion (delta + terminal status) as a `<system-reminder>` block on the next turn and via `<task_notifications>` at tool-round boundaries. ' +
            'This read returns fresh data automatically once new output exists or the task ends.',
        }
      }
      pruneRecentAgentPolls(now)
    }

    let waitObserved = false
    if (waitForStatus) {
      // C8 — actively block until the task either reaches the requested
      // status or `wait_timeout_ms` elapses. Without this the parent agent's
      // only choice is to busy-poll across LLM round trips, which costs
      // tokens AND amplifies the "(no output)" misread because the parent
      // sees a stale snapshot every iteration.
      waitObserved = await taskRuntimeStore.waitForChange(taskId, {
        sinceOffset: offsetNum,
        waitForStatus,
        timeoutMs: waitTimeoutMs,
      })
    }

    const slice = taskRuntimeStore.getSlice(taskId, offsetNum, limitNum)
    if (!slice) {
      return { success: false, error: `Task not found: ${taskId}` }
    }

    const { record, items, nextOffset, hasMore } = slice
    const isTerminal =
      record.status === 'completed' ||
      record.status === 'failed' ||
      record.status === 'stopped'

    // Record what this read actually saw so the next poll's "no new output"
    // check compares against post-wait availability. Terminal records are
    // exempt from the rate limit → drop any stale entry.
    if (record.kind === 'agent') {
      if (isTerminal) {
        recentAgentPolls.delete(record.taskId)
      } else {
        recentAgentPolls.set(record.taskId, {
          at: Date.now(),
          totalAvailable: record.droppedBefore + record.chunks.length,
        })
      }
    }

    // A3 — concrete, non-ambiguous text for the empty-buffer case so the
    // LLM cannot conflate "still booting / mid-thought" with "produced
    // nothing". Three distinct outcomes:
    //   - status running, items empty → "(still running, no output yet…)"
    //   - terminal, items empty       → "(task ended with no streamed output)"
    //   - terminal failure with error → include the error verbatim
    const renderedItems = items
      .map((chunk) => {
        if (chunk.stream === 'meta') return `[meta] ${chunk.text}`
        return `[${chunk.stream}] ${chunk.text}`
      })
      .join('')

    let bodyText: string
    if (renderedItems) {
      bodyText = renderedItems
    } else if (record.status === 'running' || record.status === 'pending') {
      // Branch on kind: sub-agents auto-deliver via the synthetic context
      // block on the next user turn, so the empty-buffer guidance is "stop
      // peeking" rather than "poll harder". Bash / other runtime tasks have
      // no auto-delivery channel — for those, pointing the caller at
      // `wait_for_status` is still the right answer.
      bodyText =
        record.kind === 'agent'
          ? '(still running, no output yet — the sub-agent has been dispatched and is currently booting / thinking. The runtime will auto-deliver new output (delta + terminal status notice) on the next user turn as a `<system-reminder>` block, so you do NOT need to poll this transcript yourself. Read it again only if the user explicitly asks. Do NOT interpret this as "no output produced" or restart the sub-agent.)'
          : '(still running, no output yet — the task is dispatched and working in the BACKGROUND. Do NOT block here and do NOT keep re-polling TaskOutput: go do other useful work now (other steps, edits, reads). The runtime automatically delivers a `<task_notifications>` block at the next tool-round boundary when this task finishes, so you will be told without polling — but ONLY if you keep working (the notification rides on your next tool batch). Only set a SHORT `wait_timeout_ms` if you genuinely have nothing else to do and must wait. Do NOT interpret this as "no output produced".)'
    } else if (record.status === 'failed' && record.error) {
      bodyText = `(task ended with no streamed output)\nError: ${record.error}`
    } else {
      bodyText = '(task ended with no streamed output)'
    }

    // The freeze the user hit: agent calls TaskOutput with `wait_for_status`,
    // the background task isn't done, the wait times out, and the agent
    // re-blocks instead of moving on. When an explicit wait elapsed with the
    // task STILL running, steer the model to proceed — completion is
    // auto-delivered via the `post_tool` `<task_notifications>` drain as long
    // as the agent keeps acting.
    if (waitForStatus && !waitObserved && !isTerminal) {
      bodyText +=
        `\n\n[still running after waiting ${waitTimeoutMs}ms] Do NOT keep waiting or re-polling here — continue with other work now. ` +
        'The runtime surfaces a `<task_notifications>` block when this task reaches a terminal state, so you will be told without blocking this tool again.'
    }

    const payload = {
      taskId: record.taskId,
      kind: record.kind,
      status: record.status,
      offset: offsetNum,
      next_offset: nextOffset,
      has_more: hasMore,
      dropped_before: record.droppedBefore,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      exitCode: record.exitCode,
      error: record.error,
      items,
      output: bodyText,
      // Surface what `wait_for_status` actually observed so the parent can
      // distinguish "I waited 5s and still nothing changed" from "the task
      // moved while I was waiting".
      waitObserved: waitForStatus ? waitObserved : undefined,
      waitForStatus,
      waitTimeoutMs: waitForStatus ? waitTimeoutMs : undefined,
    }

    if (formatStr === 'json') {
      return { success: true, output: JSON.stringify(payload) }
    }

    const lines = [
      `Task ${payload.taskId} (${payload.kind})`,
      `Status: ${payload.status}${isTerminal ? '' : ' (active)'}`,
      `Offset: ${payload.offset} -> ${payload.next_offset}${payload.has_more ? ' (has more)' : ''}`,
      payload.dropped_before > 0 ? `Dropped before: ${payload.dropped_before}` : '',
      waitForStatus
        ? `Wait: wait_for_status=${waitForStatus}, timeout=${waitTimeoutMs}ms, observed=${waitObserved ? 'yes' : 'no'}`
        : '',
      record.status === 'failed' && record.error ? `Error: ${record.error}` : '',
      bodyText,
    ].filter(Boolean)

    return { success: true, output: lines.join('\n') }
  },
})
