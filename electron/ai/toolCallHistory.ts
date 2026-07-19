/**
 * Tool-call history tracker — the missing orchestration-layer guard against
 * the "AI retries the same failing command forever" failure mode.
 *
 * ──────────────────────────────── WHY ────────────────────────────────
 *
 * The agentic loop hands `tool_result` blocks back to the model verbatim.
 * When those results are semantically weak (empty stderr, identical error
 * across platforms, transient-looking network failures) the model has no
 * signal telling it "you already tried this exact call and it failed for
 * the same reason." Without a cross-turn guard, the loop can burn its
 * iteration budget on identical retries — observed in production with
 * `python3 -c "..."` on Windows producing empty-tail `Task <id> failed:`
 * errors twice in a row.
 *
 * ─────────────────────────────── HOW ────────────────────────────────
 *
 * A tracker is created ONCE per {@link runAgenticLoop} invocation and
 * threaded through the tool-batch executor. For every tool call we:
 *
 *   1. Compute a stable fingerprint from `{toolName, normalizedInput}`.
 *   2. Before executing, look up the fingerprint:
 *      - `null` → first time (or first since last success) → execute as usual.
 *      - `{level: 'hint'}` → the previous call with the exact same args
 *        failed. Execute anyway but annotate the model-visible result
 *        with a SYSTEM advisory steering it toward a different approach.
 *      - `{level: 'block'}` → 3rd+ identical failed call in a row.
 *        Short-circuit WITHOUT spawning: the tool returns an error that
 *        forces the model to pick a different tool or different args.
 *   3. After executing, record success/failure against the fingerprint.
 *
 * The fingerprint normalisation strips transient fields (`cwd`, timing,
 * explicit task ids) so that "the same logical operation" is detected
 * even when the model jitters ancillary arguments.
 */

import crypto from 'node:crypto'

export type ToolCallOutcome = {
  success: boolean
  /** Short snippet of the error message (or undefined on success). */
  errorSummary?: string
}

export type ToolCallHintLevel = 'hint' | 'block'

export type ToolCallRepeatAdvice = {
  level: ToolCallHintLevel
  /** How many back-to-back failures the fingerprint has accumulated before this call. */
  previousFailures: number
  /** The last recorded error summary, trimmed to {@link MAX_ERROR_SUMMARY} chars. */
  lastError?: string
  /** Ready-to-inject advisory the caller can prepend to the model-visible result. */
  message: string
}

export type ToolCallHistoryEntry = {
  fingerprint: string
  toolName: string
  /** Consecutive failures since the last success (0 after a successful call). */
  consecutiveFailures: number
  lastOutcome: ToolCallOutcome
  updatedAt: number
}

export interface ToolCallHistory {
  checkBeforeCall(toolName: string, input: unknown): ToolCallRepeatAdvice | null
  record(toolName: string, input: unknown, outcome: ToolCallOutcome): void
  snapshot(): ReadonlyArray<ToolCallHistoryEntry>
  /** Testing hook: wipe state. */
  reset(): void
}

const MAX_ERROR_SUMMARY = 240

/**
 * Fields that should NOT participate in the fingerprint because they're
 * either transient (wall-clock, random task ids) or vary in ways that
 * still describe the same logical operation.
 */
const TRANSIENT_FIELDS: ReadonlySet<string> = new Set([
  'taskId',
  'task_id',
  'toolUseId',
  'tool_use_id',
  'timeoutMs',
  'timeout_ms',
  'runInBackground',
  'run_in_background',
  'baseReadId',
  'base_read_id',
])

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

/**
 * Deterministically canonicalise a tool input. Object keys are sorted,
 * strings trimmed, and transient fields elided. The output is a plain
 * JS value safe to `JSON.stringify` → deterministic hash.
 */
export function canonicalizeToolInput(input: unknown): unknown {
  if (input === null || input === undefined) return null
  if (typeof input === 'string') return input.trim()
  if (typeof input === 'number' || typeof input === 'boolean') return input
  if (Array.isArray(input)) return input.map(canonicalizeToolInput)
  if (isPlainObject(input)) {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(input).sort()) {
      if (TRANSIENT_FIELDS.has(k)) continue
      const v = input[k]
      if (v === undefined) continue
      out[k] = canonicalizeToolInput(v)
    }
    return out
  }
  // Functions, symbols, etc. — stringify safely.
  return String(input)
}

export function fingerprintToolCall(toolName: string, input: unknown): string {
  const payload = {
    n: toolName.toLowerCase(),
    i: canonicalizeToolInput(input),
  }
  const json = JSON.stringify(payload)
  return crypto.createHash('sha256').update(json).digest('hex').slice(0, 16)
}

function truncateError(err: string | undefined): string | undefined {
  if (!err) return undefined
  const trimmed = err.trim()
  if (!trimmed) return undefined
  return trimmed.length > MAX_ERROR_SUMMARY
    ? `${trimmed.slice(0, MAX_ERROR_SUMMARY - 1)}…`
    : trimmed
}

function buildHintMessage(toolName: string, entry: ToolCallHistoryEntry): string {
  const last = entry.lastOutcome.errorSummary
  const tail = last ? ` Last error: ${last}` : ''
  return (
    `[System advisory] You already invoked \`${toolName}\` with these exact arguments ` +
    `${entry.consecutiveFailures} time(s) in a row and it FAILED each time.${tail} ` +
    `Do NOT retry the same call — change the approach: fix the root cause, alter the ` +
    `arguments materially, or use a different tool.`
  )
}

function buildBlockMessage(toolName: string, entry: ToolCallHistoryEntry): string {
  const last = entry.lastOutcome.errorSummary
  const tail = last ? ` Last error: ${last}` : ''
  return (
    `[System block] Refusing to execute \`${toolName}\` — this exact invocation has ` +
    `already failed ${entry.consecutiveFailures} consecutive time(s).${tail} ` +
    `The loop guard has short-circuited this call. You MUST choose a different ` +
    `tool, different arguments, or stop and report the blocker to the user.`
  )
}

export type ToolCallHistoryOptions = {
  /** Max distinct fingerprints retained (oldest evicted). */
  maxEntries?: number
  /** Consecutive-failure count that triggers a hint (default 1 → warn on the 2nd attempt). */
  hintThreshold?: number
  /** Consecutive-failure count that triggers a hard block (default 2 → block the 3rd attempt). */
  blockThreshold?: number
}

export function createToolCallHistory(opts?: ToolCallHistoryOptions): ToolCallHistory {
  const maxEntries = Math.max(4, opts?.maxEntries ?? 64)
  const hintThreshold = Math.max(1, opts?.hintThreshold ?? 1)
  const blockThreshold = Math.max(hintThreshold + 1, opts?.blockThreshold ?? 2)

  // Insertion-ordered map → cheap LRU eviction via delete+set.
  const entries = new Map<string, ToolCallHistoryEntry>()

  const touch = (fingerprint: string, entry: ToolCallHistoryEntry): void => {
    entries.delete(fingerprint)
    entries.set(fingerprint, entry)
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value
      if (oldest === undefined) break
      entries.delete(oldest)
    }
  }

  return {
    checkBeforeCall(toolName, input) {
      const fp = fingerprintToolCall(toolName, input)
      const existing = entries.get(fp)
      if (!existing) return null
      if (existing.lastOutcome.success) return null
      const fails = existing.consecutiveFailures
      if (fails >= blockThreshold) {
        return {
          level: 'block',
          previousFailures: fails,
          lastError: existing.lastOutcome.errorSummary,
          message: buildBlockMessage(toolName, existing),
        }
      }
      if (fails >= hintThreshold) {
        return {
          level: 'hint',
          previousFailures: fails,
          lastError: existing.lastOutcome.errorSummary,
          message: buildHintMessage(toolName, existing),
        }
      }
      return null
    },

    record(toolName, input, outcome) {
      const fp = fingerprintToolCall(toolName, input)
      const existing = entries.get(fp)
      const normOutcome: ToolCallOutcome = {
        success: outcome.success,
        errorSummary: outcome.success ? undefined : truncateError(outcome.errorSummary),
      }
      if (outcome.success) {
        touch(fp, {
          fingerprint: fp,
          toolName,
          consecutiveFailures: 0,
          lastOutcome: normOutcome,
          updatedAt: Date.now(),
        })
        return
      }
      const prevFails = existing && !existing.lastOutcome.success ? existing.consecutiveFailures : 0
      touch(fp, {
        fingerprint: fp,
        toolName,
        consecutiveFailures: prevFails + 1,
        lastOutcome: normOutcome,
        updatedAt: Date.now(),
      })
    },

    snapshot() {
      return Array.from(entries.values())
    },

    reset() {
      entries.clear()
    },
  }
}

/**
 * Extract the short error summary from an Anthropic-style `tool_result`
 * block. The convention from {@link mapToolUseToToolResultBlockParam} is
 * `content = "Error: <body>"` for failures and the raw output otherwise.
 */
export function extractErrorSummaryFromToolResult(
  block: Record<string, unknown>,
): string | undefined {
  const c = block.content
  if (typeof c !== 'string') return undefined
  const t = c.trimStart()
  if (!t.startsWith('Error:')) return undefined
  return t.slice('Error:'.length).trim()
}

/**
 * Decorate a model-visible tool_result block with a hint advisory. For
 * failures, the advisory is prepended inside the `Error:` prefix so the
 * model's existing failure-recognition (see `toolResultBlockIndicatesFailure`)
 * continues to work. For successes, the advisory is prepended as a separate
 * line.
 */
export function attachAdvisoryToToolResult(
  block: Record<string, unknown>,
  advisory: string,
): Record<string, unknown> {
  const c = block.content
  if (typeof c !== 'string') return block
  const t = c.trimStart()
  if (t.startsWith('Error:')) {
    return {
      ...block,
      content: `Error: ${advisory}\n---\n${t.slice('Error:'.length).trim()}`,
    }
  }
  return { ...block, content: `${advisory}\n---\n${c}` }
}

export const toolCallHistoryInternals = {
  MAX_ERROR_SUMMARY,
  TRANSIENT_FIELDS,
  truncateError,
  buildHintMessage,
  buildBlockMessage,
}
