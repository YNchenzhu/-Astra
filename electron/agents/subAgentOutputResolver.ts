/**
 * Sub-agent reported-output resolver.
 *
 * Extracted from `subAgentRunner.ts` so both spawn paths can share the
 * same selection algorithm:
 *
 *   1. **In-process** (`runSubAgent` in `subAgentRunner.ts`) — already
 *      called these helpers inline.
 *   2. **worker_threads** (`subAgentWorkerClient.ts:case 'done'`) —
 *      previously wrote a placeholder string
 *      `Completed: {reason} ({turnCount} turns)` instead of model
 *      output. That made parent agents (Agent tool callers,
 *      teamAutoLauncher, REPL) silently lose the sub-agent's report
 *      whenever the worker pool was active.
 *
 * Pulling the resolver out also breaks a would-be circular import
 * (`subAgentRunner` already imports from `subAgentWorkerClient` —
 * routing the client's `import` back through runner would close the
 * loop).
 *
 * The runner still re-exports both functions so external callers (the
 * `subAgentRunner.p1-bugs.test.ts` test, any downstream consumer) keep
 * working without an import-path change.
 */

import { stripLeadingSubAgentProcessNarration } from './subAgentOutputSanitize'

/**
 * Sub-agent "final" text is only captured after a tool-free assistant
 * turn; long tool-only runs need fallbacks. Hard cap protects the
 * parent agent's context window from a runaway sub-agent dumping
 * megabytes back in a single message.
 */
export const SUBAGENT_OUTPUT_FALLBACK_MAX_CHARS = 80_000

/**
 * Minimum trimmed length of committed model text for a run to count as
 * having "produced a usable report". Used by the success determination on
 * BOTH spawn paths so a sub-agent that hit its iteration / token budget but
 * still delivered a real report (directly, via graceful wind-down, or via the
 * final-summary rescue turn) is reported as `success: true` instead of being
 * failed purely for crossing a limit.
 *
 * Deliberately small (a terse but real answer like "No issues found in
 * `foo.ts`; the handler already guards null." is a valid deliverable). The
 * fragment case the guard protects against — a lone "Now let me read the …"
 * scrap before the first tool call — sits well under this floor.
 */
export const SUBAGENT_MIN_REPORT_CHARS = 40

/**
 * Did the run commit a usable final report? Checks only the two committed
 * text sources (the tool-free final turn `lastFinalText` — which the rescue
 * turn promotes into — and the transcript's most-recent assistant text),
 * NOT the raw streaming `outputText` blob, because that blob can hold
 * mid-tool preamble narration that is not a deliverable.
 */
export function subAgentProducedUsableReport(params: {
  lastFinalText: string
  transcriptLastAssistantText?: string
}): boolean {
  const best = Math.max(
    params.lastFinalText.trim().length,
    (params.transcriptLastAssistantText ?? '').trim().length,
  )
  return best >= SUBAGENT_MIN_REPORT_CHARS
}

/**
 * Detail variant of {@link resolveSubAgentReportedOutput} — also
 * reports whether the body was char-capped at
 * {@link SUBAGENT_OUTPUT_FALLBACK_MAX_CHARS}, and the original
 * (untruncated) length, so the parent agent can decide whether to
 * follow up with `TaskOutput` for the full text.
 */
export function resolveSubAgentReportedOutputDetail(params: {
  lastFinalText: string
  /**
   * upstream parity (`finalizeAgentTool` walkback): the joined text of
   * the most recent assistant message with at least one text block,
   * pulled from the agent's transcript after the loop terminates.
   *
   * Higher priority than `outputText` because the streaming buffer
   * can be partially rewound on `onStreamingFallback` and may contain
   * carbage / duplicate chunks; transcript text is whatever the
   * provider actually committed as a finished assistant message.
   *
   * Optional — when omitted the resolver falls back to the previous
   * three-source chain (worker spawn path, legacy callers).
   */
  transcriptLastAssistantText?: string
  outputText: string
  latestTextOutput?: string
  reachedMaxIterations: boolean
  aborted?: boolean
  abortReason?: string
}): {
  body: string
  /** Length of the chosen source string before any truncation. */
  originalCharCount: number
  /** True iff the chosen source exceeded {@link SUBAGENT_OUTPUT_FALLBACK_MAX_CHARS}. */
  charTruncated: boolean
} {
  let originalCharCount = 0
  let charTruncated = false
  const pick = (s: string) => {
    const v = s.trim()
    if (!v) return ''
    originalCharCount = v.length
    if (v.length <= SUBAGENT_OUTPUT_FALLBACK_MAX_CHARS) return v
    charTruncated = true
    return `${v.slice(-SUBAGENT_OUTPUT_FALLBACK_MAX_CHARS)}\n\n[…truncated to last ${SUBAGENT_OUTPUT_FALLBACK_MAX_CHARS} characters]`
  }

  let body = pick(params.lastFinalText)
  if (!body) body = pick(params.transcriptLastAssistantText ?? '')
  if (!body) body = pick(params.outputText)
  if (!body) body = pick(params.latestTextOutput ?? '')

  if (!body) {
    return {
      body: params.reachedMaxIterations
        ? 'Agent completed without output. (Stopped at iteration limit before a text-only final reply.)'
        : 'Agent completed without output.',
      originalCharCount: 0,
      charTruncated: false,
    }
  }
  if (params.reachedMaxIterations && !body.includes('iteration limit')) {
    body += '\n\n[Stopped at iteration limit; response may be incomplete.]'
  }
  if (params.aborted && body && !body.includes('stopped before completion')) {
    const reason = params.abortReason?.trim()
    body += reason
      ? `\n\n[Sub-agent stopped before completion: ${reason}; content above may be partial.]`
      : '\n\n[Sub-agent stopped before completion (time limit or cancel); content above may be partial.]'
  }
  body = stripLeadingSubAgentProcessNarration(body)
  return { body, originalCharCount, charTruncated }
}

export function resolveSubAgentReportedOutput(params: {
  lastFinalText: string
  transcriptLastAssistantText?: string
  outputText: string
  latestTextOutput?: string
  reachedMaxIterations: boolean
  aborted?: boolean
  abortReason?: string
}): string {
  return resolveSubAgentReportedOutputDetail(params).body
}
