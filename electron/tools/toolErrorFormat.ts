/**
 * Shared error-message formatter for tool failures.
 *
 * The goal is "first-try-correct" tool calls: when a tool DOES fail, the
 * error it returns must tell the model exactly:
 *   1. **What went wrong** — plain one-liner, no jargon.
 *   2. **What we tried** — the actual inputs we attempted, so the model can
 *      see which assumption was wrong.
 *   3. **How to fix it** — a concrete, actionable next step (not "try again").
 *
 * Research from Anthropic's tool-use guide + OpenAI function-calling docs +
 * the IDE's tool schemas all converge on the same principle: a model is far
 * more likely to correct on the NEXT turn when the error message is
 * structured, not when it is a raw exception string. This helper exists so
 * every tool in this repo can produce that shape without re-inventing it.
 *
 * Example output:
 *
 *   Path not found: src/foo.py
 *   Tried: C:\astra\src\foo.py | G:\ws\app\src\foo.py
 *   Next: use a path relative to the workspace root (G:\ws\app), or an absolute path.
 */

import type { ToolErrorClass } from '../ai/classifyToolError'

export interface ToolErrorInput {
  /** Headline — what failed, in <=80 chars. */
  what: string
  /** Structured "what we tried" lines (each printed as-is under "Tried:"). */
  tried?: string[]
  /** Concrete next step(s) — single string or bullet list. */
  next?: string | string[]
  /** Optional lookup hint to include (file size / cwd / workspace root / …). */
  context?: Record<string, string | number | null | undefined>
}

function joinList(items: string[] | undefined): string {
  if (!items || items.length === 0) return ''
  if (items.length === 1) return items[0]!
  return items.join('  |  ')
}

/**
 * Format a tool error into a consistent multi-line string.
 *
 * All sections are optional except `what`. Empty sections are omitted so
 * short messages stay short and detailed ones surface the full context.
 */
export function formatToolError(input: ToolErrorInput): string {
  const parts: string[] = []
  parts.push(input.what.trim())

  const triedLine = joinList(input.tried)
  if (triedLine) parts.push(`Tried: ${triedLine}`)

  if (input.context && Object.keys(input.context).length > 0) {
    const ctx = Object.entries(input.context)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(', ')
    if (ctx) parts.push(`Context: ${ctx}`)
  }

  if (input.next !== undefined && input.next !== null) {
    const nextLines = Array.isArray(input.next) ? input.next : [input.next]
    const clean = nextLines.filter((x) => x && x.trim())
    if (clean.length === 1) {
      parts.push(`Next: ${clean[0]!.trim()}`)
    } else if (clean.length > 1) {
      parts.push('Next:')
      for (const line of clean) parts.push(`  - ${line.trim()}`)
    }
  }

  return parts.join('\n')
}

/**
 * Convenience: wrap a raw error / thrown exception into a structured
 * message. Falls back to `String(err)` when there's no `.message`.
 */
export function formatUnexpectedToolError(
  toolName: string,
  err: unknown,
  next?: string | string[],
): string {
  const raw = err instanceof Error ? err.message : String(err)
  return formatToolError({
    what: `${toolName} hit an unexpected error: ${raw}`,
    next:
      next ??
      'Check tool arguments against the schema; if the issue persists, retry once — transient filesystem/network errors are common.',
  })
}

/**
 * Build a structured tool failure that carries BOTH the formatted, model-
 * visible string AND the structured fields the UI can render as separate
 * regions (headline / "Tried" list / "Next" recovery hints).
 *
 * Why both: the model's tool-result channel only accepts text, so we MUST
 * keep the formatted `error` string for self-correction (this is the
 * `What/Tried/Context/Next` shape locked by `toolErrorShape.test.ts`).
 * But the renderer benefits enormously from rendering each section
 * independently — recovery hints become an inline affordance, raw stderr
 * stays collapsed, and the headline gets typographic emphasis. Returning
 * both shapes from one call lets callers spread the result onto a
 * `ToolResult` object without remembering to keep them in sync.
 *
 * Usage:
 *
 *     return { success: false, ...buildToolFailure({ what: '...', next: ['...'] }) }
 *
 * The spread populates `error` (string), `errorWhat` / `errorTried` /
 * `errorContext` / `errorNext` (structured) in one go. Callers that only
 * need the legacy string keep using `formatToolError` directly — the two
 * helpers are intentionally non-exclusive.
 */
export interface ToolFailureFields {
  /** Already-formatted, model-visible error message (legacy `error` field). */
  error: string
  /**
   * Tool's self-declared error class. When set, `runAgenticToolUseBody`'s
   * post-execution classifier preserves it instead of overwriting with a
   * heuristic regex guess (audit fix B3). Callers pass it via the second
   * `buildToolFailure` argument:
   *
   *     return { success: false, ...buildToolFailure({...}, 'not_found') }
   *
   * Optional — when omitted the heuristic classifier still kicks in, so
   * legacy call sites continue to work. The type is intentionally the
   * full {@link ToolErrorClass} union (not bare string) so a typo at the
   * caller surfaces at typecheck time.
   */
  toolErrorClass?: ToolErrorClass
  /** Single-line headline; mirrors `ToolErrorInput.what`. */
  errorWhat: string
  /** Attempted inputs / paths / commands; mirrors `ToolErrorInput.tried`. */
  errorTried?: string[]
  /** Lookup hints (workspace root, cwd, …); mirrors `ToolErrorInput.context`. */
  errorContext?: Record<string, string | number | null | undefined>
  /** Recovery hints, normalised to an array; mirrors `ToolErrorInput.next`. */
  errorNext?: string[]
}

export function buildToolFailure(
  input: ToolErrorInput,
  toolErrorClass?: ToolErrorClass,
): ToolFailureFields {
  const out: ToolFailureFields = {
    error: formatToolError(input),
    errorWhat: input.what.trim(),
  }
  if (toolErrorClass) {
    out.toolErrorClass = toolErrorClass
  }
  if (input.tried && input.tried.length > 0) {
    out.errorTried = input.tried.slice()
  }
  if (input.context && Object.keys(input.context).length > 0) {
    // Filter empty values to mirror the formatter's "skip empty" semantics
    // — keeps the structured payload aligned with what the model sees.
    const filtered: Record<string, string | number | null | undefined> = {}
    for (const [k, v] of Object.entries(input.context)) {
      if (v !== undefined && v !== null && v !== '') filtered[k] = v
    }
    if (Object.keys(filtered).length > 0) out.errorContext = filtered
  }
  if (input.next !== undefined && input.next !== null) {
    const arr = Array.isArray(input.next) ? input.next : [input.next]
    const clean = arr.map((s) => s.trim()).filter((s) => s.length > 0)
    if (clean.length > 0) out.errorNext = clean
  }
  return out
}
