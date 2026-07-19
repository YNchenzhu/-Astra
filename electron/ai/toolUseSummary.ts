/**
 * upstream report Phase 2 Step 22 — Async tool use summary generation.
 *
 * After tool execution completes, generates a concise summary of tool results
 * using a lightweight model call (non-blocking, fire-and-forget for next turn).
 * The summary is injected as `pendingToolUseSummary` in the next iteration's state.
 */

import type { ProviderConfig } from './client'
import { streamText } from './client'
import { SIDE_QUERY_ALWAYS_THINKING } from './sideQueryThinkingPolicy'
import { withQueryOverrideForLlmCall } from '../agents/queryExecutionContext'
import { SIDE_CHANNEL_KIND, wrapSideChannelBody } from '../constants/sideChannelKinds'

/**
 * 2026-05 audit — upstream-main parity
 * (`src/services/toolUseSummary/toolUseSummaryGenerator.ts:15-24`).
 *
 * The previous astra wording told the haiku to write "Key data
 * points that affect the next step", which then surfaced inside the
 * `<system-reminder>[Previous tool execution summary]` block that the
 * `pendingToolUseSummary` collector injects into the next iteration's
 * model input. Reading "Next: verify bar.ts compiles" in a host-
 * provided recap is one of the four root causes of long-run
 * "narrate-only end_turn" regressions: the main agent reads it as
 * "the next step is already planned by the host, I only need to
 * narrate it" rather than "this is past-tense reporting".
 *
 * upstream uses the summary purely as a mobile UI label — git-commit-
 * subject style, past tense, no future-tense hand-off framing. We
 * adopt the same wording.
 *
 * 2026-06 long-run hallucination fix: generation + injection is now
 * OPT-IN (`POLE_TOOL_USE_SUMMARY=1`, see `toolExec.ts`). Even in the
 * past-tense form, one host-authored completion claim per tool batch
 * accumulated over long runs and primed the model to emit its own
 * premature completion text before invoking tools. The deterministic
 * ledger below covers the factual recall need; the haiku label adds
 * style, not facts.
 *
 * Note: the body shape the model sees is still
 *   `<system-reminder>[Previous tool execution summary (ToolA, ToolB)]\nLabel\n</system-reminder>`
 * — only the LABEL text changes (was 1-3 sentence with "next step"
 * hint, now a single short past-tense subject line).
 */
const TOOL_SUMMARY_SYSTEM_PROMPT = `Write a short summary label describing what these tool calls accomplished. Think git-commit-subject, not sentence — a single line, around 30 characters where possible.

Keep the verb in past tense and the most distinctive noun. Drop articles, connectors, and long location context first. Never describe the next step, planned work, or anything the agent intends to do — this label is a past-tense fact, not a forecast.

Examples:
- Searched in auth/
- Fixed NPE in UserService
- Created signup endpoint
- Read config.json
- Ran failing tests`

export interface ToolUseSummaryOptions {
  config: ProviderConfig
  model: string
  toolUseBlocks: Array<{
    name: string
    input: Record<string, unknown>
  }>
  toolResults: Array<Record<string, unknown>>
  signal: AbortSignal
  /** Max tokens for the summary LLM call. Default: 256. */
  maxTokens?: number
  /** Timeout in ms for the summary call. Default: 10000. */
  timeoutMs?: number
}

export interface ToolUseSummaryResult {
  summary: string
  generatedAt: number
  toolNames: string[]
}

export interface DeterministicToolLedgerOptions {
  toolUseBlocks: Array<{
    id?: string
    name: string
    input: Record<string, unknown>
  }>
  toolResults: Array<Record<string, unknown>>
  /** Most-recent registered readId for each path in the current agent scope. */
  readReceiptHints?: ReadonlyArray<{
    filePath: string
    readId: string
  }>
}

function truncateForLedger(value: unknown, maxChars: number): string {
  let text: string
  if (typeof value === 'string') {
    text = value
  } else {
    try {
      text = JSON.stringify(value)
    } catch {
      text = String(value)
    }
  }
  text = text.replace(/\s+/g, ' ').trim()
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 20))}… [truncated]`
}

/**
 * Failure detection mirrors `toolExec.ts`'s `isErrorMarker` semantics:
 * `is_error: true` OR content starting with "Error:". The prefix fallback is
 * load-bearing — historically several failure paths produced blocks without
 * the flag, and the ledger then reported `-> success` for a failed tool in
 * the SAME user message as the `Error:` tool_result. The model trusted the
 * later, host-authoritative ledger ("Do NOT repeat successful actions") and
 * ignored the error's recovery hints.
 */
function toolResultLooksFailed(result: Record<string, unknown>): boolean {
  if (result.is_error === true) return true
  const c = result.content
  return typeof c === 'string' && c.trimStart().startsWith('Error:')
}

function resultStatus(result: Record<string, unknown> | undefined): 'success' | 'error' | 'missing' {
  if (!result) return 'missing'
  if (toolResultLooksFailed(result)) return 'error'
  return 'success'
}

/**
 * Synchronous, deterministic ledger of the just-finished tool batch.
 *
 * This complements the async LLM-generated tool summary:
 * - The ledger is available immediately in the very next model iteration.
 * - It never calls an LLM, so it cannot add startup latency or fail due to
 *   provider/API issues.
 * - It is factual only: tool name, id, status, compact input/result preview.
 *
 * Why it exists: in a single user turn, the agentic loop may do
 * "think -> tool -> result -> think -> next tool" many times. The raw
 * `tool_result` blocks are the ground truth, but non-Anthropic providers
 * and long/multi-tool result batches often need a small explicit bridge that
 * says "these actions just happened; don't repeat successful ones".
 */
export function formatDeterministicToolLedgerForInjection(
  options: DeterministicToolLedgerOptions,
): string {
  const { toolUseBlocks, toolResults } = options
  if (toolUseBlocks.length === 0) return ''

  const resultsById = new Map<string, Record<string, unknown>>()
  for (const r of toolResults) {
    const id = (r as { tool_use_id?: unknown }).tool_use_id
    if (typeof id === 'string' && id.length > 0) resultsById.set(id, r)
  }

  const lines: string[] = [
    '[Previous tool batch ledger — host-generated]',
    'These tool calls finished immediately before this model step. Use this ledger together with the raw tool_result blocks above as the factual record of what was already done. Do NOT repeat successful actions unless the next step genuinely requires it.',
    '',
  ]

  for (let i = 0; i < toolUseBlocks.length; i++) {
    const tu = toolUseBlocks[i]
    const id = typeof tu.id === 'string' ? tu.id : ''
    const result = (id ? resultsById.get(id) : undefined) ?? toolResults[i]
    const status = resultStatus(result)
    const inputPreview = truncateForLedger(tu.input, 220)
    const resultPreview = result
      ? truncateForLedger((result as { content?: unknown }).content ?? result, 320)
      : '(no result captured)'
    const idSuffix = id ? ` id=${id}` : ''
    lines.push(
      `- ${tu.name}${idSuffix} -> ${status}; input=${inputPreview}; result=${resultPreview}`,
    )
  }

  const readReceiptHints = options.readReceiptHints ?? []
  if (readReceiptHints.length > 0) {
    lines.push(
      '',
      '[Current path-bound readIds — host-generated]',
      'readIds are NOT global. For edit_file / multi_edit_file, use only the readId listed beside the SAME target path. If the target path is absent, call read_file first; never borrow another file\'s readId.',
    )
    for (const hint of readReceiptHints) {
      lines.push(`- path=${JSON.stringify(hint.filePath)} -> baseReadId=${JSON.stringify(hint.readId)}`)
    }
  }

  return wrapSideChannelBody(SIDE_CHANNEL_KIND.toolBatchLedger, lines.join('\n'))
}

function formatToolExecutionForSummary(
  toolUseBlocks: Array<{ name: string; input: Record<string, unknown> }>,
  toolResults: Array<Record<string, unknown>>,
): string {
  const parts: string[] = []
  for (let i = 0; i < toolUseBlocks.length; i++) {
    const tu = toolUseBlocks[i]
    const tr = toolResults[i]
    const inputStr = JSON.stringify(tu.input).slice(0, 500)
    const resultContent =
      tr && typeof tr.content === 'string'
        ? tr.content.slice(0, 800)
        : tr
          ? JSON.stringify(tr).slice(0, 800)
          : '(no result)'
    const isError = tr ? toolResultLooksFailed(tr) : false
    parts.push(
      `Tool: ${tu.name}\nInput: ${inputStr}\nResult${isError ? ' (ERROR)' : ''}: ${resultContent}`,
    )
  }
  return parts.join('\n\n---\n\n')
}

/**
 * Generate a lightweight summary of tool execution results.
 * Returns null if summary generation fails or times out.
 * Designed to be called asynchronously (non-blocking).
 */
export async function generateToolUseSummary(
  options: ToolUseSummaryOptions,
): Promise<ToolUseSummaryResult | null> {
  const {
    config,
    model,
    toolUseBlocks,
    toolResults,
    signal,
    maxTokens = 256,
    timeoutMs = 10_000,
  } = options

  if (toolUseBlocks.length === 0) return null

  // Merge caller's abort with the local 10s timeout into a single signal.
  // Abort reasons are passed through so downstream consumers can discriminate
  // timeout vs user-cancel. We MUST detach the parent listener in `finally`
  // to avoid leaking listeners onto long-lived caller signals (background
  // summaries share the agent lifetime signal).
  const timeoutController = new AbortController()
  const onParentAbort = () => {
    if (!timeoutController.signal.aborted) {
      try { timeoutController.abort(signal.reason) } catch { /* ignore */ }
    }
  }
  const timeout = setTimeout(() => {
    if (!timeoutController.signal.aborted) {
      try { timeoutController.abort() } catch { /* ignore */ }
    }
  }, timeoutMs)

  if (signal.aborted) {
    onParentAbort()
  } else {
    signal.addEventListener('abort', onParentAbort, { once: true })
  }
  const effectiveSignal = timeoutController.signal

  const formatted = formatToolExecutionForSummary(toolUseBlocks, toolResults)

  let summary = ''
  try {
    await withQueryOverrideForLlmCall('tool_summary', async () => {
      await streamText(
        config,
        {
          model,
          messages: [
            {
              role: 'user',
              content: `Summarize these tool execution results concisely:\n\n${formatted}`,
            },
          ],
          systemPrompt: TOOL_SUMMARY_SYSTEM_PROMPT,
          maxTokens,
          alwaysThinking: SIDE_QUERY_ALWAYS_THINKING,
        },
        {
          onTextDelta: (text) => {
            summary += text
          },
          onMessageEnd: () => {},
          onError: () => {},
        },
        effectiveSignal,
      )
    })
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', onParentAbort)
  }

  if (!summary.trim()) return null

  return {
    summary: summary.trim(),
    generatedAt: Date.now(),
    toolNames: toolUseBlocks.map((t) => t.name),
  }
}

/**
 * Fire-and-forget wrapper: starts summary generation in the background.
 * The promise resolves to a ToolUseSummaryResult that can be consumed in the next iteration.
 */
export function startToolUseSummaryInBackground(
  options: ToolUseSummaryOptions,
): Promise<ToolUseSummaryResult | null> {
  return generateToolUseSummary(options).catch((err) => {
    console.warn('[ToolUseSummary] Background summary failed:', err)
    return null
  })
}

/**
 * Provider families that have been trained to recognize `<system-reminder>`
 * envelopes (Anthropic family + cursor-ui-clone forks that mimic the same
 * system prompt). For other providers (OpenAI / Gemini / Zhipu / Kimi / …)
 * the envelope can trigger sycophantic self-correction ("you're right, I
 * should…"); use a neutral plain-text marker instead.
 */
/**
 * P1-18 — Always wrap the summary with `<system-reminder>`.
 *
 * Previously: only Anthropic-family providers got the system-reminder
 * envelope; others got `[Side-channel context — not a user instruction]`,
 * a marker the standing system prompt never defines. Models on those
 * providers read it as a real user statement, then acted on
 * `[Previous tool execution summary (Read, Edit)] Read failed because X`
 * as if the user just told them to investigate X.
 *
 * The standing system prompt teaches the model that `<system-reminder>`
 * is side-channel information, regardless of provider. Standardising on
 * the envelope removes the cross-provider semantic gap; the few providers
 * that historically didn't recognise the tag still tolerate plain text
 * inside it.
 *
 * `providerId` is kept on the signature for API stability (callers still
 * pass `state.config.id`); it is no longer read.
 */
export function formatToolUseSummaryForInjection(
  result: ToolUseSummaryResult,
  _providerId?: string,
): string {
  const toolList = result.toolNames.join(', ')
  const inner = `[Previous tool execution summary (${toolList})]\n${result.summary}`
  return wrapSideChannelBody(SIDE_CHANNEL_KIND.toolUseSummary, inner)
}
