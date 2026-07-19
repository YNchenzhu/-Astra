/**
 * upstream-style Zod validation for registry tool inputs (AC-1.2 / AC-1.10).
 * Tools without {@link Tool.zInputSchema} skip this layer (e.g. dynamic MCP tools).
 */

import { z } from 'zod'
import type { ZodError, ZodTypeAny } from 'zod'
import type { Tool } from './types'
import { normalizeWebFetchUrlInput } from '../utils/webFetchNormalize'

/**
 * Stable substring embedded in the "dropped / truncated arguments" validation
 * headline produced by {@link formatZodToolInputError}.
 *
 * The cross-agent repeat-failure guard
 * (`electron/orchestration/toolRuntime/history.ts`) matches this marker to
 * EXCLUDE empty / truncated-argument validation failures from its block:
 * such failures are transport / generation glitches (e.g. a model emitting a
 * `tool_use` whose `input_json_delta` stream is empty, so `content` /
 * `oldString` never arrive) with ZERO cross-agent predictive value. Recording
 * them caused spurious `[Cross-agent block]` dead-ends after just two
 * identical empty calls. Keep this string in sync with both consumers.
 */
export const DROPPED_TOOL_ARGS_ERROR_MARKER =
  'arrived with missing/empty required argument'

/**
 * Internal input key set by the streaming layer (`compatibleClient` /
 * `anthropicCompatHttp` `flushToolCall`) on a write/edit tool_use whose
 * argument JSON had to be recovered from a TRUNCATED wire payload (the model
 * hit `max_tokens` mid-`content`). The write/edit Zod schemas detect it and
 * REFUSE the call so a partial/corrupted file is never silently persisted.
 * `.passthrough()` on those schemas keeps the key visible to `.superRefine`;
 * the `.transform` drops it so it never reaches the tool's `call()`.
 */
/**
 * Both write/edit refusal markers are stamped centrally (single source of truth:
 * {@link parseToolArguments}) on any tool-input object recovered via `jsonrepair`
 * (lenient) or truncation auto-close. The write/edit schemas below detect them and
 * REFUSE the call so a heuristically-repaired or partial `content` / `newString`
 * is never persisted. `.passthrough()` keeps them visible to `.superRefine`; the
 * `.transform` drops them so they never reach `call()`. Re-exported here so the
 * streaming clients can keep importing them from this module.
 */
import {
  LENIENT_REPAIRED_TOOL_ARGS_MARKER_KEY,
  TRUNCATED_TOOL_ARGS_MARKER_KEY,
} from '../ai/transformer/parseToolArguments'
export { LENIENT_REPAIRED_TOOL_ARGS_MARKER_KEY, TRUNCATED_TOOL_ARGS_MARKER_KEY }

/**
 * Stable substring embedded in the truncation validation error. Matched by the
 * cross-agent guard (`history.ts`) to EXCLUDE these failures from the block —
 * a max_tokens truncation is a transport glitch, not a "this call is broken"
 * signal. Keep in sync with `formatZodToolInputError` + `history.ts`.
 */
export const TRUNCATED_TOOL_ARGS_ERROR_MARKER =
  'arguments were truncated at the model output token limit'

/**
 * Stable substring embedded in the lenient-repair refusal error. Like the
 * truncation marker, it lets the cross-agent guard treat this as a recoverable
 * transport/escaping glitch rather than a "this call is fundamentally broken"
 * signal. Keep in sync with `formatZodToolInputError` + `history.ts`.
 */
export const LENIENT_REPAIRED_TOOL_ARGS_ERROR_MARKER =
  'arguments were only parseable after lenient JSON repair'

/**
 * Write/edit tools whose `content` / `newString` can be silently corrupted by
 * a mid-stream truncation, so the streaming layer tags them and the schemas
 * refuse a truncated payload. Only `.passthrough()` schemas that carry the
 * truncation `superRefine` check belong here (NOT `.strict()` notebook_edit).
 */
export const WRITE_EDIT_TOOL_NAMES_FOR_TRUNCATION_GUARD = new Set<string>([
  'write_file',
  'edit_file',
  'multi_edit_file',
  'Write',
  'Edit',
  'MultiEdit',
])

/**
 * Tools whose dropped-args headline gets the extra "the large `content` /
 * `newString` field is the likely truncation culprit — write in chunks or use
 * `edit_file`" advice. For every other tool that advice is off-topic (a
 * `glob` / `bash` empty call has no oversized string field), so they only get
 * the generic re-send guidance. Aliases included so the gate matches whatever
 * name the model used.
 */
const WRITE_EDIT_TOOL_NAMES_FOR_HINT = new Set<string>([
  'write_file',
  'edit_file',
  'multi_edit_file',
  'Write',
  'Edit',
  'MultiEdit',
  'notebook_edit',
  'NotebookEdit',
])

/** Optional numeric fields that models sometimes send as strings (strict finite number after parse). */
function optionalFiniteJsonNumber(): z.ZodType<number | undefined> {
  return z.preprocess((v: unknown) => {
    if (v === undefined || v === null || v === '') return undefined
    if (typeof v === 'number') return Number.isFinite(v) ? v : Number.NaN
    if (typeof v === 'string') {
      const t = v.trim()
      if (t === '') return undefined
      const n = Number(t)
      return Number.isFinite(n) ? n : Number.NaN
    }
    return Number.NaN
  }, z.number().finite().optional()) as z.ZodType<number | undefined>
}

/**
 * TodoWrite `todos` —forgiving input that accepts multiple shapes:
 *  1. A JSON-stringified array  —parse it
 *  2. An array of objects        —pass through
 *  3. An array of strings        —convert each to { content, status: "pending", activeForm }
 *
 * Sub-agents in particular often send todo items as plain strings because
 * the full object schema is verbose and some models simplify the format.
 */
function todoWriteTodosArray(): z.ZodType<Array<Record<string, unknown>>> {
  const itemSchema = z.record(z.string(), z.unknown())
  return z.preprocess((v: unknown) => {
    // Layer 1: top-level string —JSON.parse
    let arr: unknown = v
    if (typeof arr === 'string') {
      const t = arr.trim()
      if (t === '') return []
      try {
        arr = JSON.parse(t) as unknown
      } catch {
        return v // let validation fail with a clear message
      }
    }
    // Layer 2: array of strings —array of objects
    if (Array.isArray(arr)) {
      return arr.map((item: unknown) => {
        if (typeof item === 'string') {
          const s = item.trim()
          return { content: s, status: 'pending', activeForm: s }
        }
        return item
      })
    }
    return arr
  }, z.array(itemSchema)) as z.ZodType<Array<Record<string, unknown>>>
}

/** TaskUpdate `metadata`: models may send a JSON object instead of a stringified object. */
function taskUpdateMetadataField(): z.ZodType<string | undefined> {
  return z.preprocess((v: unknown) => {
    if (v === undefined || v === null) return undefined
    if (typeof v === 'string') return v
    if (typeof v === 'object') {
      try {
        return JSON.stringify(v)
      } catch {
        return v
      }
    }
    return v
  }, z.string().optional()) as z.ZodType<string | undefined>
}

function zodIssuesSummary(err: ZodError): string {
  return err.issues
    .map((i) => {
      const p = i.path.length ? i.path.join('.') : '(root)'
      return `${p}: ${i.message}`
    })
    .join('; ')
}

/**
 * Build a structured validation error message that helps the model
 * self-correct. We include:
 *   1. The canonical `InputValidationError` prefix (existing UI depends on
 *      the format).
 *   2. The list of issues from zod.
 *   3. **The keys the model actually sent** —without this, when the model
 *      misspells a field (e.g. `folder_path` instead of `path`), it has no
 *      signal that *any* of its input was recognized.
 *
 * Accepted keys are best-effort extracted from the underlying zod schema's
 * top-level `shape` (when present). Non-object / refined schemas fall back
 * to showing the received keys only.
 */
/** Maximum characters of `__rawArguments` preview to surface in the error
 *  message. Large enough for the model to see where its serialization broke,
 *  small enough to avoid blowing up the transcript when the field was a huge
 *  truncated file body. */
const RAW_ARGUMENTS_PREVIEW_CHARS = 500

/**
 * Heuristic: did the raw tool-arguments string fail to parse because the
 * model left a `"` unescaped *inside* a string value (or, equivalently,
 * dropped a `,`/`:` separator between adjacent string-valued fields)?
 * Both failure modes look identical at the JSON lexer level —after a `"`
 * closes a string, the very next non-whitespace char is something other
 * than `,`, `:`, `}`, `]`, or end-of-input.
 *
 * Returns true on the first such anomaly. Stays false on the truncation
 * case (unterminated string keeps `inString=true` to EOF, no close event
 * is ever observed), so this won't false-fire when the real cause is the
 * stream getting cut off —keeping the existing truncation hint correct.
 */
function findFirstUnescapedQuoteAnomaly(raw: string): number {
  let inString = false
  let escape = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw.charAt(i)
    if (inString) {
      if (escape) {
        escape = false
        continue
      }
      if (ch === '\\') {
        escape = true
        continue
      }
      if (ch === '"') {
        inString = false
        // Peek next non-whitespace char.
        let j = i + 1
        while (j < raw.length && /\s/.test(raw.charAt(j))) j++
        if (j < raw.length) {
          const next = raw.charAt(j)
          if (next !== ',' && next !== ':' && next !== '}' && next !== ']') {
            // This `"` looked like a string terminator but is followed by
            // non-structural content → it is almost certainly an interior
            // quote the model forgot to escape. Report its index so the caller
            // can show the model EXACTLY which `"` to fix.
            return i
          }
        }
      }
      continue
    }
    if (ch === '"') inString = true
  }
  return -1
}

/**
 * Build a short, pin-pointed excerpt around the first unescaped `"` so the
 * model can locate it in its own (often multi-thousand-char) payload. The
 * default preview is sliced from the START of the raw arguments, so a stray
 * quote deep inside a long Chinese `newString` is never shown — the model is
 * told "you have an unescaped quote" but not WHERE, and keeps re-emitting the
 * same broken call. This window centres on the offending byte with an
 * unmistakable `→»"«←` marker. Control chars are rendered visibly so the
 * excerpt stays on one line.
 */
function buildUnescapedQuoteExcerpt(raw: string, index: number): string {
  const CTX = 48
  const start = Math.max(0, index - CTX)
  const end = Math.min(raw.length, index + 1 + CTX)
  const clean = (s: string) =>
    s.replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t')
  const before = clean(raw.slice(start, index))
  const after = clean(raw.slice(index + 1, end))
  const lead = start > 0 ? '…' : ''
  const tail = end < raw.length ? '…' : ''
  return `${lead}${before}→»"«←${after}${tail}`
}

/**
 * Heuristic: did this tool call arrive with its required arguments
 * **missing / undefined** (rather than present-but-wrong)? Two shapes:
 *
 *   1. The whole input is an empty object `{}` — the strongest signal that
 *      the arguments never made it onto the wire at all. This is exactly the
 *      DeepSeek-on-Anthropic-compat symptom the user hit: the model emits a
 *      `tool_use` block whose `input_json_delta` stream is empty, so
 *      `write_file` / `edit_file` reach Zod with no `content` /
 *      `oldString` / `newString` and fail with the cryptic
 *      `content: expected string, received undefined`.
 *   2. The input is partial (e.g. `filePath` present but `content` dropped),
 *      which typically means the argument JSON was truncated mid-stream
 *      (max_tokens while emitting a large field). We detect this via the
 *      "received undefined" / "is required" issue shapes ONLY — a
 *      present-but-wrong-type value (e.g. a number where a string is
 *      expected) is a genuine model mistake, not a transport drop, and is
 *      left to fall through to the standard message.
 *
 * Skipped entirely when `__rawArguments` is present: that path means the
 * JSON failed to parse and has its own dedicated (escape / truncation) hint.
 */
function looksLikeDroppedOrTruncatedToolArgs(
  received: Record<string, unknown> | undefined,
  err: ZodError,
  hasRawArguments: boolean,
): boolean {
  if (!received) return false
  if (Object.keys(received).length === 0) return true
  if (hasRawArguments) return false
  return err.issues.some((i) => {
    const m = (i.message || '').toLowerCase()
    return m.includes('received undefined') || m.includes('is required')
  })
}

export function formatZodToolInputError(
  toolName: string,
  err: ZodError,
  received?: Record<string, unknown>,
  zSchema?: ZodTypeAny,
): string {
  // When the tool-call JSON could not be parsed, the most actionable signal
  // is the root cause of the parse failure — NOT the cascade of Zod issues
  // it triggered downstream. Surface that headline FIRST (before the generic
  // `InputValidationError (...)` prefix) so models scanning only the start
  // of the tool error see the fix-it instruction immediately. The existing
  // tail (received keys / preview / accepted keys) is preserved verbatim so
  // tests and downstream log consumers don't break.
  const rawValue =
    received && typeof received.__rawArguments === 'string'
      ? (received.__rawArguments as string)
      : ''
  const unescapedQuoteIndex =
    rawValue.length > 0 ? findFirstUnescapedQuoteAnomaly(rawValue) : -1
  const isUnescapedQuote = unescapedQuoteIndex >= 0

  const isMaxTokensTruncation = err.issues.some((i) =>
    (i.message || '').includes(TRUNCATED_TOOL_ARGS_ERROR_MARKER),
  )

  // Detect the refusal markers DIRECTLY on the input. The `.passthrough()`
  // write/edit schemas surface a tailored issue message via their superRefine,
  // but `.strict()` schemas (e.g. notebook_edit) reject with a generic
  // "unrecognized key" issue instead — so read the marker here to give those
  // tools the same actionable headline (and embed the stable error marker so
  // the cross-agent guard treats it as a recoverable glitch, not a hard block).
  const hasTruncatedMarker = received?.[TRUNCATED_TOOL_ARGS_MARKER_KEY] === true
  const hasLenientMarker = received?.[LENIENT_REPAIRED_TOOL_ARGS_MARKER_KEY] === true

  // Fix-3: write/edit failures tempt models into the bash/PowerShell escape
  // hatch (heredoc / echo / Set-Content), which bypasses every file-tool
  // safeguard (read receipts, empty-write guard, diff transactions,
  // truncation refusal). Explicitly forbid it in every write/edit headline.
  const noShellBypassTail = WRITE_EDIT_TOOL_NAMES_FOR_HINT.has(toolName)
    ? ' Do NOT fall back to bash / PowerShell (heredoc / echo / Set-Content) to write the file — that bypasses the write safeguards; re-issue this file tool call instead.'
    : ''

  const parts: string[] = []
  if (isMaxTokensTruncation || hasTruncatedMarker) {
    // The streaming layer recovered this write/edit from a truncated payload
    // (model hit max_tokens mid-content). Refusing the write avoids silently
    // persisting a corrupted file. The marker substring is preserved so the
    // cross-agent guard excludes this transport glitch from its block.
    parts.push(
      `FIX FIRST: your \`${toolName}\` ${TRUNCATED_TOOL_ARGS_ERROR_MARKER} (max_tokens), so the file was NOT written (refusing to save partial/corrupted content). Do NOT retry the same oversized call — create the file with the first chunk via \`write_file\`, then append the remaining parts with \`edit_file\`, or otherwise reduce the per-call output size.${noShellBypassTail}`,
    )
  } else if (hasLenientMarker) {
    // The payload only parsed after the `jsonrepair` lenient pass (e.g. an
    // unescaped interior `"`). Refused for write/edit because the heuristic
    // could have guessed a `content`/`newString` boundary wrong. Embed the
    // stable LENIENT marker substring so the cross-agent guard excludes it.
    parts.push(
      `FIX FIRST: your \`${toolName}\` ${LENIENT_REPAIRED_TOOL_ARGS_ERROR_MARKER} (likely an unescaped \`"\` inside a string value), so the file was NOT written — auto-repair could have guessed a string boundary wrong. Re-issue the SAME call as STRICT JSON: every literal ASCII \`"\` inside a string value MUST be \`\\"\`, every \`\\\` MUST be \`\\\\\`, every newline MUST be \`\\n\`. Curly quotes (“ ” ‘ ’) do NOT need escaping.${noShellBypassTail}`,
    )
  } else if (isUnescapedQuote) {
    // Compact, model-friendly before/after — keeps the message short
    // (transcripts pay per token) but unambiguous about the fix.
    const pinpoint =
      unescapedQuoteIndex >= 0
        ? ` The FIRST offending \`"\` is near char ${unescapedQuoteIndex} — escape THIS one (and any others like it): ${buildUnescapedQuoteExcerpt(rawValue, unescapedQuoteIndex)}`
        : ''
    parts.push(
      'FIX FIRST: your tool-call JSON has an unescaped `"` inside a string value (likely `oldString` / `newString` / `content`). Every literal ASCII `"` MUST be `\\"`, every `\\` MUST be `\\\\`, every newline MUST be `\\n`. Example — WRONG: `"oldString":"锚定"推动转型"目标"` ; RIGHT: `"oldString":"锚定\\"推动转型\\"目标"`. Curly quotes (“ ” ‘ ’) do NOT need escaping. Retry with a valid JSON object.' +
        pinpoint,
    )
  } else if (looksLikeDroppedOrTruncatedToolArgs(received, err, rawValue.length > 0)) {
    // Empty / partial argument block. Surface an actionable headline FIRST so
    // the model re-sends the FULL argument object (with materially different
    // content) instead of blindly repeating the same call — which would
    // otherwise trip the orchestrator's cross-agent block after two identical
    // failures and dead-end the turn. Two distinct shapes:
    if (received && Object.keys(received).length > 0) {
      // Partial-but-VALID arguments: the JSON parsed cleanly and carried some
      // keys, so a transport truncation is effectively ruled out — a genuine
      // mid-stream cut either fails to parse (→ `__rawArguments` branch) or
      // is auto-closed and tagged (→ max_tokens branch above; since fix-2 the
      // streaming layer also tags trailing write/edit calls flushed after a
      // `stop_reason: max_tokens`). Telling the model "truncated while
      // streaming" here taught it to conclude "content too long → bypass via
      // bash heredoc". State the real cause instead: the field was never
      // generated.
      parts.push(
        `FIX FIRST: this tool call ${DROPPED_TOOL_ARGS_ERROR_MARKER}(s) — the argument JSON itself arrived as a complete, valid object, but it only carried [${Object.keys(received).join(', ')}]; the missing required field(s) were never generated. This is almost certainly NOT a streaming truncation (a genuinely truncated payload is detected and reported separately), so do NOT conclude the content was "too long". Re-issue the call as a SINGLE valid JSON object with EVERY required field populated (see accepted keys below).${noShellBypassTail} Do NOT repeat the same incomplete call.`,
      )
    } else {
      // Whole input is `{}` — the strongest signal the arguments were dropped
      // or truncated in transit (e.g. a tool_use whose `input_json_delta`
      // stream is empty), NOT that the fields are optional.
      const writeEditTail = WRITE_EDIT_TOOL_NAMES_FOR_HINT.has(toolName)
        ? ' If a large field like `content` / `newString` caused the truncation, write in smaller chunks or use `edit_file` instead of one oversized `write_file`.'
        : ''
      parts.push(
        `FIX FIRST: this tool call ${DROPPED_TOOL_ARGS_ERROR_MARKER}(s) — one or more were received as \`undefined\`. This almost always means the tool-call arguments were dropped or truncated while streaming (NOT that the fields are optional). Re-issue the call as a SINGLE valid JSON object with EVERY required field populated (see accepted keys below).${writeEditTail}${noShellBypassTail} Do NOT repeat the same empty call.`,
      )
    }
  }
  parts.push(`InputValidationError (${toolName}): ${zodIssuesSummary(err)}`)
  if (received) {
    const receivedKeys = Object.keys(received)
    if (receivedKeys.length > 0) {
      parts.push(`received keys: [${receivedKeys.join(', ')}]`)
    }
    // When the only key is `__rawArguments` (or it's present at all), the
    // upstream tool-arguments JSON could not be parsed. Surface a preview so
    // the model can inspect its own malformed output and retry with a shorter
    // / properly escaped payload —otherwise it just gets "received keys:
    // [__rawArguments]" on every attempt and spins forever. See
    // parseToolArguments.ts: RAW_ARGUMENTS_KEY = '__rawArguments'.
    if (rawValue.length > 0) {
      const preview =
        rawValue.length > RAW_ARGUMENTS_PREVIEW_CHARS
          ? rawValue.slice(0, RAW_ARGUMENTS_PREVIEW_CHARS) +
            `—+${rawValue.length - RAW_ARGUMENTS_PREVIEW_CHARS} more chars)`
          : rawValue
      // Tail hint: keep the original two-branch text so existing telemetry
      // regexes (`unescaped` / `shorten the payload`) still match. The
      // headline above is what the model is supposed to read; the tail
      // stays as supporting detail.
      const hint = isUnescapedQuote
        ? 'Most likely cause: malformed JSON around an unescaped `"` at the JSON syntax layer inside one of your string values (e.g. `oldString` / `newString` / `content`). Retry the structured tool call with the same semantic string value and let the tool protocol serialize it; do not add a literal backslash to the field value itself. A missing `,` / `:` between adjacent fields produces the same symptom. Truncation is unlikely here.'
        : 'Retry with a valid JSON object for this tool\'s schema; for large string fields (e.g. `content`) split the work into smaller edit_file calls or shorten the payload so the JSON is not truncated.'
      parts.push(
        `raw arguments could not be parsed as JSON —preview: ${JSON.stringify(
          preview,
        )}. ${hint}`,
      )
    }
  }
  if (zSchema) {
    const acceptedKeys = extractAcceptedKeys(zSchema)
    if (acceptedKeys && acceptedKeys.length > 0) {
      parts.push(`accepted keys: [${acceptedKeys.join(', ')}]`)
    }
  }
  return parts.join(' | ')
}

/**
 * Best-effort extraction of the top-level key set from a zod schema. Returns
 * undefined when the schema is not object-shaped or when zod's internals
 * surface doesn't expose `shape`.
 */
function extractAcceptedKeys(schema: ZodTypeAny): string[] | undefined {
  const anySchema = schema as unknown as {
    _def?: { shape?: () => Record<string, unknown>; typeName?: string }
    shape?: Record<string, unknown>
  }
  // zod v3: schemas chained through .strict()/.passthrough()/etc. preserve a
  // `.shape` getter that returns the ZodRawShape. Schemas chained through
  // `.transform()` / `.superRefine()` wrap it, so we walk the inner def.
  let cursor: unknown = schema
  for (let depth = 0; depth < 6 && cursor; depth++) {
    const c = cursor as {
      _def?: {
        shape?: () => Record<string, unknown>
        typeName?: string
        schema?: unknown
        innerType?: unknown
      }
      shape?: Record<string, unknown>
    }
    if (c.shape && typeof c.shape === 'object' && !Array.isArray(c.shape)) {
      return Object.keys(c.shape)
    }
    const shapeFn = c._def?.shape
    if (typeof shapeFn === 'function') {
      try {
        const s = shapeFn() as Record<string, unknown>
        return Object.keys(s)
      } catch {
        /* ignore */
      }
    }
    cursor = c._def?.schema ?? c._def?.innerType ?? undefined
  }
  if (anySchema.shape && typeof anySchema.shape === 'object') {
    return Object.keys(anySchema.shape)
  }
  return undefined
}

export function validateToolZodInput(
  tool: Pick<Tool, 'name' | 'zInputSchema'>,
  input: Record<string, unknown>,
): { ok: true; data: Record<string, unknown> } | { ok: false; message: string } {
  if (!tool.zInputSchema) {
    return { ok: true, data: input }
  }
  const r = tool.zInputSchema.safeParse(input)
  if (r.success) {
    return { ok: true, data: r.data as Record<string, unknown> }
  }
  return {
    ok: false,
    message: formatZodToolInputError(tool.name, r.error, input, tool.zInputSchema),
  }
}

// ———Built-in filesystem / search ———

/** Tools that accept `{}` only at the Zod layer (upstream-style empty object). */
export const emptyToolInputZod = z.object({}).strict()

/**
 * Shared write/edit guard: if the streaming layer flagged this tool_use as
 * recovered from a truncated wire payload, add a clear issue and tell the
 * caller to stop validating (the partial content/newString must never be
 * persisted). `field` is the large string param whose truncation we refuse.
 * Returns true when the issue was added (caller should `return`).
 */
function rejectIfTruncatedToolArgs(
  data: Record<string, unknown>,
  ctx: { addIssue: (issue: { code: typeof z.ZodIssueCode.custom; message: string; path: (string | number)[] }) => void },
  field: 'content' | 'newString' | 'edits',
): boolean {
  if (data[TRUNCATED_TOOL_ARGS_MARKER_KEY] !== true) return false
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message:
      `${field} ${TRUNCATED_TOOL_ARGS_ERROR_MARKER} (max_tokens) — the file was NOT written to ` +
      `avoid persisting a partial / corrupted file. Re-do it in smaller pieces: create the file ` +
      `with the first chunk via write_file, then append the rest with edit_file. Do NOT retry the ` +
      `same oversized one-shot call.`,
    path: [field],
  })
  return true
}

/**
 * Companion to {@link rejectIfTruncatedToolArgs} for the lenient-repair gate.
 * When a write/edit payload was only parseable via `jsonrepair` (the streaming
 * layer set {@link LENIENT_REPAIRED_TOOL_ARGS_MARKER_KEY}), refuse it: the
 * library may have guessed a string boundary wrong, so the persisted
 * `content` / `newString` cannot be trusted. The fix is cheap for the model —
 * re-emit the SAME call with the offending `"` properly escaped as `\"`.
 * Returns true when the issue was added (caller should `return`).
 */
function rejectIfLenientlyRepairedToolArgs(
  data: Record<string, unknown>,
  ctx: { addIssue: (issue: { code: typeof z.ZodIssueCode.custom; message: string; path: (string | number)[] }) => void },
  field: 'content' | 'newString' | 'edits',
): boolean {
  if (data[LENIENT_REPAIRED_TOOL_ARGS_MARKER_KEY] !== true) return false
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message:
      `${field}: this tool call's ${LENIENT_REPAIRED_TOOL_ARGS_ERROR_MARKER} (likely an unescaped \`"\` ` +
      `inside a string), so the file was NOT written — auto-repair could have guessed the ${field} ` +
      `boundary wrong and corrupted the file. Re-issue the SAME call as STRICT JSON: every literal ASCII ` +
      `\`"\` inside a string value MUST be \`\\"\`, every \`\\\` MUST be \`\\\\\`, every newline MUST be \`\\n\`.`,
    path: [field],
  })
  return true
}

// upstream alignment stage 4: deliberately NOT annotated `: ZodTypeAny` —
// keeping the inferred specific type (`ZodEffects<ZodObject<—, —`) lets
// `z.infer<typeof readFileInputZod>` resolve to the post-transform shape,
// which `buildTool({ zInputSchema, call })` consumes for typed tool calls.
// Assigning back to a `ZodTypeAny` slot (Tool.zInputSchema) remains sound
// because every concrete schema is a subtype of `ZodTypeAny`.
export const readFileInputZod = z
  .object({
    filePath: z.string().optional(),
    /** upstream / FileReadTool snake_case alias */
    file_path: z.string().optional(),
    /** Common natural-language alias —many non-Claude models emit this. */
    path: z.string().optional(),
    offset: optionalFiniteJsonNumber(),
    limit: optionalFiniteJsonNumber(),
    maxSizeBytes: optionalFiniteJsonNumber(),
    maxTokens: optionalFiniteJsonNumber(),
  })
  // `.passthrough()` silently keeps unknown keys in the output instead of
  // failing the whole call. Most model misspellings (e.g. `lineOffset`) are
  // harmless —the extract below ignores anything outside the known set.
  .passthrough()
  .superRefine((data, ctx) => {
    const fp = (data.filePath ?? data.file_path ?? data.path ?? '').trim()
    if (!fp) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'filePath or file_path is required',
        path: ['filePath'],
      })
    }
  })
  .transform((data) => ({
    filePath: (data.filePath ?? data.file_path ?? data.path ?? '').trim(),
    offset: data.offset,
    limit: data.limit,
    maxSizeBytes: data.maxSizeBytes,
    maxTokens: data.maxTokens,
  }))

export const writeFileInputZod = z
  .object({
    filePath: z.string().optional(),
    file_path: z.string().optional(),
    /** Natural-language alias. */
    path: z.string().optional(),
    content: z.string().optional(),
    /**
     * Cross-provider content aliases. The file body must normally arrive under
     * `content`, but models emulating Anthropic's text-editor tool emit
     * `file_text`, and others use `contents` / `text`. Without these aliases a
     * write whose body landed under one of those keys hard-failed with
     * `content: expected string, received undefined` and the model would retry
     * the same wrong-keyed call forever (the "3 write_file in a row, all
     * failing" symptom). Mirrors the path aliases above.
     */
    file_text: z.string().optional(),
    contents: z.string().optional(),
    text: z.string().optional(),
    /**
     * Optional path-recovery fallback. Mirrors the same field on
     * `edit_file` / `multi_edit_file`: when the model has a recent
     * `read_file` receipt for the target and drops `filePath` from the
     * payload (commonly seen on long-content writes where the JSON
     * payload gets truncated, or where the agent reasons "baseReadId
     * already identifies the file"), the tool surface can recover the
     * resolved path via `findReadReceiptByReadId`. The Zod gate below
     * tolerates a missing filePath as long as a baseReadId is present.
     */
    baseReadId: z.string().optional(),
    base_read_id: z.string().optional(),
  })
  .passthrough()
  .superRefine((data, ctx) => {
    if (rejectIfTruncatedToolArgs(data as Record<string, unknown>, ctx, 'content')) return
    if (rejectIfLenientlyRepairedToolArgs(data as Record<string, unknown>, ctx, 'content')) return
    const body = data.content ?? data.file_text ?? data.contents ?? data.text
    if (typeof body !== 'string') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'content is required (the file body; also accepted as file_text / contents / text)',
        path: ['content'],
      })
    }
    const fp = (data.filePath ?? data.file_path ?? data.path ?? '').trim()
    const brid = (data.baseReadId ?? data.base_read_id ?? '').trim()
    if (!fp && !brid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'filePath or file_path is required (or supply baseReadId from a recent read_file response)',
        path: ['filePath'],
      })
    }
  })
  .transform((data) => ({
    filePath: (data.filePath ?? data.file_path ?? data.path ?? '').trim(),
    content: data.content ?? data.file_text ?? data.contents ?? data.text ?? '',
    baseReadId: (data.baseReadId ?? data.base_read_id ?? '').trim() || undefined,
  }))

export const editFileInputZod = z
  .object({
    filePath: z.string().optional(),
    file_path: z.string().optional(),
    oldString: z.string().optional(),
    /** upstream-style snake_case alias (matches validateEditToolPayload) */
    old_string: z.string().optional(),
    newString: z.string().optional(),
    new_string: z.string().optional(),
    replaceAll: z.boolean().optional(),
    replace_all: z.boolean().optional(),
    /**
     * Hash-anchored precision guard. If provided, the edit is validated against the exact
     * content snapshot + content-hash recorded when read_file issued this readId, instead
     * of the looser line-window heuristic. Highly recommended for all edits.
     *
     * SECONDARY ROLE: when `filePath` is omitted, the tool implementation
     * walks back to `findReadReceiptByReadId(baseReadId)` to recover the
     * file path. The Zod gate below tolerates a missing filePath as long
     * as a baseReadId is present, because models occasionally drop
     * `filePath` on multi-edit batches where they reason "baseReadId
     * already identifies the file" (which it does — `read_file` returned
     * the path bundled with the readId). The downstream tool surface
     * still hard-fails with a clear message when the readId can't be
     * resolved.
     */
    baseReadId: z.string().optional(),
    base_read_id: z.string().optional(),
    /**
     * P0 —soft cross-boundary guard. Optional `[startLine, endLine]` (1-based,
     * inclusive) declaring where the edit is expected to land. The tool
     * cross-checks the actual hit range against this window and rejects
     * edits whose match silently spans outside the declared bounds.
     *
     * Zod-level shape check is deliberately liberal (any number tuple of
     * length 2 here); the strict integer / start<=end / start>=1 check lives
     * in `validateEditTool.ts` so the failure surfaces with a model-friendly
     * message instead of a raw Zod issue.
     */
    expectedLineRange: z.array(z.number()).length(2).optional(),
    expected_line_range: z.array(z.number()).length(2).optional(),
    hashAnchor: z
      .object({
        startLine: z.number(),
        startHash: z.string(),
        endLine: z.number().optional(),
        endHash: z.string().optional(),
      })
      .optional(),
    hash_anchor: z
      .object({
        start_line: z.number(),
        start_hash: z.string(),
        end_line: z.number().optional(),
        end_hash: z.string().optional(),
      })
      .optional(),
    /** Natural-language alias accepted for forgiveness. */
    path: z.string().optional(),
  })
  .passthrough()
  .superRefine((data, ctx) => {
    if (rejectIfTruncatedToolArgs(data as Record<string, unknown>, ctx, 'newString')) return
    if (rejectIfLenientlyRepairedToolArgs(data as Record<string, unknown>, ctx, 'newString')) return
    const fp = (data.filePath ?? data.file_path ?? data.path ?? '').trim()
    // Loosened gate: tolerate missing filePath when a baseReadId is
    // provided — the tool surface recovers the path via
    // `findReadReceiptByReadId`. If baseReadId is also missing, fail
    // with the same message as before so the model gets actionable
    // feedback. (Mirrors `multiEditFileInputZod` for consistency.)
    const brid = (data.baseReadId ?? data.base_read_id ?? '').trim()
    if (!fp && !brid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'filePath or file_path is required (or supply baseReadId from a recent read_file response)',
        path: ['filePath'],
      })
    }
    const oldS = data.oldString ?? data.old_string
    const newS = data.newString ?? data.new_string
    if (oldS === undefined || newS === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'oldString and newString are required (old_string / new_string aliases allowed)',
        path: ['oldString'],
      })
    }
  })
  .transform((data) => {
    const rangeRaw = data.expectedLineRange ?? data.expected_line_range
    const hashAnchorRaw = data.hashAnchor ?? (
      data.hash_anchor
        ? {
            startLine: data.hash_anchor.start_line,
            startHash: data.hash_anchor.start_hash,
            endLine: data.hash_anchor.end_line,
            endHash: data.hash_anchor.end_hash,
          }
        : undefined
    )
    return {
      filePath: (data.filePath ?? data.file_path ?? data.path ?? '').trim(),
      oldString: (data.oldString ?? data.old_string) as string,
      newString: (data.newString ?? data.new_string) as string,
      replaceAll: data.replaceAll ?? data.replace_all,
      replace_all: data.replace_all ?? data.replaceAll,
      baseReadId: (data.baseReadId ?? data.base_read_id ?? '').trim() || undefined,
      expectedLineRange: rangeRaw as [number, number] | undefined,
      hashAnchor: hashAnchorRaw,
    }
  })

/**
 * multi_edit_file —array of {oldString, newString, replaceAll} edits applied
 * atomically against a single file. Each item supports upstream-style
 * snake_case aliases. The whole shape is forgiving (`.passthrough()`) so
 * unknown keys don't break models that decorate their tool calls with
 * extra hints.
 */
export const multiEditFileInputZod = z
  .object({
    filePath: z.string().optional(),
    file_path: z.string().optional(),
    /** Natural-language alias. */
    path: z.string().optional(),
    edits: z
      .array(
        z
          .object({
            oldString: z.string().optional(),
            old_string: z.string().optional(),
            newString: z.string().optional(),
            new_string: z.string().optional(),
            replaceAll: z.boolean().optional(),
            replace_all: z.boolean().optional(),
            /**
             * Per-edit positional cross-check (2026-07). `[startLine, endLine]`
             * in the coordinates of the PRE-BATCH file (the read_file output
             * the model composed the batch from). Validated against the
             * original buffer before any edit applies — see
             * `computeFileEditResultMulti`. Liberal shape here; strict
             * integer/order checks live in `validateEditTool.ts`.
             */
            expectedLineRange: z.array(z.number()).length(2).optional(),
            expected_line_range: z.array(z.number()).length(2).optional(),
          })
          .passthrough(),
      )
      .optional(),
    baseReadId: z.string().optional(),
    base_read_id: z.string().optional(),
  })
  .passthrough()
  .superRefine((data, ctx) => {
    if (rejectIfTruncatedToolArgs(data as Record<string, unknown>, ctx, 'edits')) return
    if (rejectIfLenientlyRepairedToolArgs(data as Record<string, unknown>, ctx, 'edits')) return
    const fp = (data.filePath ?? data.file_path ?? data.path ?? '').trim()
    // Loosened gate: tolerate missing filePath when a baseReadId is
    // provided — the tool surface recovers the path via
    // `findReadReceiptByReadId`. Common model failure mode: large
    // multi-edit batch where the model thinks "baseReadId already
    // identifies the target" and drops `filePath` from its tool_use
    // arguments. We let the request through and resolve at the
    // executor; downstream still hard-fails if the readId is unknown.
    const brid = (data.baseReadId ?? data.base_read_id ?? '').trim()
    if (!fp && !brid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'filePath or file_path is required (or supply baseReadId from a recent read_file response)',
        path: ['filePath'],
      })
    }
    const arr = data.edits
    if (!Array.isArray(arr) || arr.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          '`edits` must be a non-empty array of {oldString, newString, replaceAll?} objects',
        path: ['edits'],
      })
      return
    }
    for (let i = 0; i < arr.length; i++) {
      const e = arr[i] as Record<string, unknown>
      const oldS = e.oldString ?? e.old_string
      const newS = e.newString ?? e.new_string
      if (typeof oldS !== 'string' || typeof newS !== 'string') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `edits[${i}]: both oldString and newString are required (old_string / new_string aliases allowed)`,
          path: ['edits', i],
        })
      }
    }
  })
  .transform((data) => {
    const rawEdits = (data.edits ?? []) as Array<Record<string, unknown>>
    return {
      filePath: (data.filePath ?? data.file_path ?? data.path ?? '').trim(),
      edits: rawEdits.map((e) => ({
        oldString: (e.oldString ?? e.old_string) as string,
        newString: (e.newString ?? e.new_string) as string,
        replaceAll: (e.replaceAll ?? e.replace_all) as boolean | undefined,
        expectedLineRange: (e.expectedLineRange ?? e.expected_line_range) as
          | [number, number]
          | undefined,
      })),
      baseReadId: (data.baseReadId ?? data.base_read_id ?? '').trim() || undefined,
    }
  })

export const listFilesInputZod = z
  .object({
    dirPath: z.string().optional(),
    /** Natural-language / snake_case aliases: `path`, `directory`, `dir`. */
    dir_path: z.string().optional(),
    path: z.string().optional(),
    directory: z.string().optional(),
    dir: z.string().optional(),
  })
  .passthrough()
  .superRefine((data, ctx) => {
    const dp = (
      data.dirPath ??
      data.dir_path ??
      data.path ??
      data.directory ??
      data.dir ??
      ''
    ).trim()
    if (!dp) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'dirPath (or path / directory / dir alias) is required',
        path: ['dirPath'],
      })
    }
  })
  .transform((data) => ({
    dirPath: (
      data.dirPath ??
      data.dir_path ??
      data.path ??
      data.directory ??
      data.dir ??
      ''
    ).trim(),
  }))

export const globInputZod = z
  .object({
    pattern: z.string(),
    cwd: z.string().optional(),
    /** Common natural-language aliases (many models emit these). */
    path: z.string().optional(),
    directory: z.string().optional(),
    maxResults: z.number().optional(),
    includeDirs: z.boolean().optional(),
  })
  .passthrough()
  .transform((data) => ({
    pattern: data.pattern,
    cwd: data.cwd ?? data.path ?? data.directory,
    maxResults: data.maxResults,
    includeDirs: data.includeDirs,
  }))

/**
 * Lenient number coercion: accepts a number, or a string that represents one.
 * Used by Grep where some models/MCP clients serialize numeric inputs as strings.
 */
const zFlexNumber = z.union([
  z.number(),
  z
    .string()
    .trim()
    .regex(/^-?\d+(?:\.\d+)?$/, 'expected number')
    .transform((s) => Number(s)),
])

const zFlexBool = z.union([
  z.boolean(),
  z
    .string()
    .trim()
    .transform((s) => s.toLowerCase())
    .pipe(z.enum(['true', 'false', '1', '0', 'yes', 'no']))
    .transform((s) => s === 'true' || s === '1' || s === 'yes'),
])

export const grepInputZod = z
  .object({
    pattern: z.string().optional(),
    /** Alias for pattern (common model / API naming) */
    query: z.string().optional(),
    cwd: z.string().optional(),
    /** Alias for cwd (common model / API naming) */
    path: z.string().optional(),
    include: z.string().optional(),
    /** the IDE / upstream Grep convention —alias for `include`. */
    glob: z.string().optional(),
    exclude: z.string().optional(),
    maxResults: zFlexNumber.optional(),
    context: zFlexNumber.optional(),
    beforeLines: zFlexNumber.optional(),
    afterLines: zFlexNumber.optional(),
    /** the IDE / ripgrep CLI-style aliases. */
    '-A': zFlexNumber.optional(),
    '-B': zFlexNumber.optional(),
    '-C': zFlexNumber.optional(),
    '-i': zFlexBool.optional(),
    '-n': zFlexBool.optional(),
    caseInsensitive: zFlexBool.optional(),
    outputMode: z.enum(['content', 'files_with_matches', 'count']).optional(),
    /** Alias for outputMode (common shorthand). */
    output_mode: z.enum(['content', 'files_with_matches', 'count']).optional(),
    headLimit: zFlexNumber.optional(),
    head_limit: zFlexNumber.optional(),
    offset: zFlexNumber.optional(),
    multiline: zFlexBool.optional(),
    type: z.string().optional(),
    lineNumbers: zFlexBool.optional(),
  })
  .passthrough()
  .superRefine((data, ctx) => {
    const p = data.pattern ?? data.query
    if (!p || (typeof p === 'string' && !p.trim())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'pattern or query is required (non-empty string)',
        path: ['pattern'],
      })
    }
  })
  .transform((input) => {
    const d = input as Record<string, unknown> & {
      pattern?: string
      query?: string
      path?: string
      cwd?: string
      include?: string
      glob?: string
      outputMode?: 'content' | 'files_with_matches' | 'count'
      output_mode?: 'content' | 'files_with_matches' | 'count'
      headLimit?: number
      head_limit?: number
      context?: number
      beforeLines?: number
      afterLines?: number
      caseInsensitive?: boolean
      lineNumbers?: boolean
      '-A'?: number
      '-B'?: number
      '-C'?: number
      '-i'?: boolean
      '-n'?: boolean
    }
    return {
      pattern: (d.pattern ?? d.query ?? '').toString().trim(),
      cwd: d.cwd ?? d.path,
      include: d.include ?? d.glob,
      exclude: d.exclude as string | undefined,
      maxResults: d.maxResults as number | undefined,
      context: d.context ?? d['-C'],
      beforeLines: d.beforeLines ?? d['-B'],
      afterLines: d.afterLines ?? d['-A'],
      caseInsensitive: d.caseInsensitive ?? d['-i'],
      outputMode: d.outputMode ?? d.output_mode,
      headLimit: d.headLimit ?? d.head_limit,
      offset: d.offset as number | undefined,
      multiline: d.multiline as boolean | undefined,
      type: d.type as string | undefined,
      lineNumbers: d.lineNumbers ?? d['-n'],
    }
  })

export const webFetchInputZod = z
  .object({
    url: z.string(),
    maxLength: z.number().optional(),
  })
  .passthrough()
  .superRefine((data, ctx) => {
    const r = normalizeWebFetchUrlInput(data.url)
    if (!r.ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: r.error,
        path: ['url'],
      })
    }
  })
  .transform((data) => {
    const r = normalizeWebFetchUrlInput(data.url)
    return {
      url: r.ok ? r.url : data.url.trim(),
      maxLength: data.maxLength,
    }
  })

export const webSearchInputZod = z
  .object({
    query: z.string().optional(),
    /** Common aliases —OpenAI / Gemini models often use these. */
    q: z.string().optional(),
    search_query: z.string().optional(),
    searchQuery: z.string().optional(),
    maxResults: z.number().optional(),
    /**
     * Optional engine override. When omitted, the main-process router picks
     * based on query language (CJK —Baidu) and which keys are configured.
     * Accepts: `auto` | `brave` | `baidu` | `ddg`.
     */
    engine: z.enum(['auto', 'brave', 'baidu', 'ddg']).optional(),
    /**
     * Baidu-specific time filter. Ignored on non-Baidu engines. Two forms:
     *   - `pd` / `pw` / `pm` / `py` (past day / week / month / year)
     *   - `YYYY-MM-DDtoYYYY-MM-DD` (explicit range)
     */
    freshness: z.string().optional(),
  })
  .passthrough()
  .superRefine((data, ctx) => {
    const q =
      data.query ?? data.q ?? data.search_query ?? data.searchQuery ?? ''
    if (!q || (typeof q === 'string' && !q.trim())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'query (or q / search_query) is required (non-empty string)',
        path: ['query'],
      })
    }
  })
  .transform((data) => ({
    query: String(
      data.query ?? data.q ?? data.search_query ?? data.searchQuery ?? '',
    ).trim(),
    maxResults: data.maxResults,
    engine: data.engine,
    freshness: data.freshness,
  }))

export const memdirScanInputZod = z
  .object({
    maxResults: z.number().optional(),
  })
  .strict()

/**
 * Models trained on the upstream BashTool convention (upstream-main
 * `BashTool/BashTool.tsx` — `description` field with detailed prompt text)
 * routinely pass `description` and `timeout` even when our tool schema
 * doesn't list them. With `.strict()` they failed validation:
 *
 *   InputValidationError (bash): (root): Unrecognized key: "description"
 *
 * Accept these as optional ignored fields so the model's reflex doesn't
 * stall a turn. Bash-AST validation, sandbox, and timeout enforcement
 * still come from the canonical fields below.
 */
export const bashInputZod = z
  .object({
    command: z.string(),
    cwd: z.string().optional(),
    runInBackground: z.boolean().optional(),
    /** upstream-style snake_case alias */
    run_in_background: z.boolean().optional(),
    timeoutMs: optionalFiniteJsonNumber(),
    timeout_ms: optionalFiniteJsonNumber(),
    /** upstream BashTool convention — short description of the command (UI/telemetry only). */
    description: z.string().optional(),
    /** upstream BashTool convention — milliseconds (alias for `timeoutMs`). */
    timeout: optionalFiniteJsonNumber(),
    /** upstream sandbox override — accepted for compat, currently unused on this codebase. */
    dangerouslyDisableSandbox: z.boolean().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (!data.command.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'command is required (non-empty string)',
        path: ['command'],
      })
    }
  })
  .transform((data) => ({
    command: data.command.trim(),
    cwd: data.cwd,
    runInBackground: data.runInBackground ?? data.run_in_background,
    run_in_background: data.run_in_background ?? data.runInBackground,
    timeoutMs: data.timeoutMs ?? data.timeout_ms ?? data.timeout,
    timeout_ms: data.timeout_ms ?? data.timeoutMs ?? data.timeout,
    description: data.description,
  }))

export const powerShellInputZod = z
  .object({
    command: z.string(),
    cwd: z.string().optional(),
    runInBackground: z.boolean().optional(),
    run_in_background: z.boolean().optional(),
    timeoutMs: optionalFiniteJsonNumber(),
    timeout_ms: optionalFiniteJsonNumber(),
    /** upstream BashTool convention — short description of the command (UI/telemetry only). */
    description: z.string().optional(),
    /** upstream BashTool convention — milliseconds (alias for `timeoutMs`). */
    timeout: optionalFiniteJsonNumber(),
    /** upstream sandbox override — accepted for compat, currently unused on this codebase. */
    dangerouslyDisableSandbox: z.boolean().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (!data.command.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'command is required (non-empty string)',
        path: ['command'],
      })
    }
  })
  .transform((data) => ({
    command: data.command.trim(),
    cwd: data.cwd,
    runInBackground: data.runInBackground ?? data.run_in_background,
    run_in_background: data.run_in_background ?? data.runInBackground,
    timeoutMs: data.timeoutMs ?? data.timeout_ms ?? data.timeout,
    timeout_ms: data.timeout_ms ?? data.timeoutMs ?? data.timeout,
    description: data.description,
  }))

/**
 * Agent tool: models may send `task` instead of `prompt`; normalization runs in execute after Zod.
 */
export const agentToolInputZod = z
  .object({
    description: z.string().optional(),
    prompt: z.string().optional(),
    task: z.string().optional(),
    subagent_type: z.string().optional(),
    /** Explore sub-agent thoroughness level (quick / medium / very thorough) — common model-facing field, aligned with upstream docs. */
    thoroughness: z.string().optional(),
    model: z.string().optional(),
    run_in_background: z.boolean().optional(),
    name: z.string().optional(),
    team_name: z.string().optional(),
    /** upstream-style allowlist; also accepts `allowedAgentTypes` alias in execute after normalize. */
    allowed_subagent_types: z.array(z.string()).optional(),
    allowedAgentTypes: z.array(z.string()).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const prompt = (data.prompt?.trim() || data.task?.trim()) ?? ''
    if (!prompt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Either prompt or task (non-empty string) is required',
      })
    }
    const desc =
      data.description?.trim() ||
      (prompt ? prompt.split('\n').find((l) => l.trim())?.trim() : '') ||
      ''
    if (!desc) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'description is required, or provide prompt/task with a first line to derive it',
      })
    }
  })

/**
 * Product tools with rich / nested JSON: still run through Zod so every registry path validates object shape (§1.3).
 * Prefer replacing with `.strict()` per-tool schemas over time.
 */
export const looseRegistryToolInputZod = z.record(z.string(), z.unknown())

/**
 * Skill tool —strict known keys; when {@link end_inline_skill_session} is not true, {@link skill} must be non-empty.
 */
export const skillToolInputZod = z
  .object({
    skill: z.string().optional(),
    args: z.string().optional(),
    end_inline_skill_session: z.boolean().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.end_inline_skill_session === true) return
    if (!(data.skill ?? '').trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'skill is required (non-empty) unless end_inline_skill_session is true',
        path: ['skill'],
      })
    }
  })
  .transform((data) => ({
    skill: (data.skill ?? '').trim(),
    ...(data.args !== undefined ? { args: data.args } : {}),
    ...(data.end_inline_skill_session !== undefined
      ? { end_inline_skill_session: data.end_inline_skill_session }
      : {}),
  }))

export const enterPlanModeInputZod = emptyToolInputZod

export const sendMessageInputZod = z
  .object({
    to: z.string(),
    message: z.string(),
    type: z.enum(['task', 'result', 'query', 'broadcast']).optional(),
    payload: z.string().optional(),
    team_name: z.string().optional(),
    plain: z.boolean().optional(),
    /**
     * Optional registered inter-agent schema name (e.g. `plan_approval_request`).
     * When provided, the SendMessage tool JSON-parses the message body and runs
     * the registered Zod schema against it BEFORE delivery —malformed
     * structured handoffs are rejected at send time instead of being
     * silently mis-consumed by the receiver. See
     * `electron/agents/teamInterAgentProtocol.ts` for built-in schema names.
     */
    schema: z.string().optional(),
  })
  .strict()

/**
 * IDE-style structured plan todo: `id` is optional for backwards
 * compatibility with the renderer `TodoItem` shape (which doesn't carry one);
 * `cancelled` is supported per the IDE `create_plan` contract even though
 * the legacy renderer-side `TodoItem.status` doesn't include it.
 *
 * Lenient on input shape on purpose — models emit plan todos in several
 * forms and the strict object-only schema hard-failed `ExitPlanMode` on
 * cosmetic mismatches (notably for `phases[].todos[]`):
 *   1. a bare title string, e.g. `"搭建项目骨架"`,
 *   2. the rich TodoWrite shape `{ content, activeForm, status }`,
 *   3. the minimal `{ content }` with no `status`.
 * All three are normalized to `{ id?, content, activeForm?, status }` so the
 * approval card + plan persistence get a single shape. `status` defaults to
 * `pending`, and unknown keys are dropped instead of rejected.
 */
const planTodoObjectSchema = z.object({
  id: z.string().optional(),
  content: z.string(),
  // Accepted for parity with the TodoWrite tool shape (models frequently
  // include it); surfaced as the in-progress label by the plan card.
  activeForm: z.string().optional(),
  status: z
    .enum(['pending', 'in_progress', 'completed', 'cancelled'])
    .optional()
    .default('pending'),
})

const planTodoSchema = z.union([
  z
    .string()
    .transform((content) => ({ content, status: 'pending' as const })),
  planTodoObjectSchema,
])

export const exitPlanModeInputZod = z
  .object({
    allowedPrompts: z.array(z.record(z.string(), z.unknown())).optional(),
    /**
     * Optional full plan markdown / ```plan-json code block —when provided,
     * `planRuntime.persistPlanFromOutput` writes a structured plan file to
     * `<workspace>/.cursor/plans/*.plan.md` and seeds corresponding TaskList
     * entries. Without this, plan mode still exits correctly but the plan
     * is not durably recorded.
     */
    planMarkdown: z.string().optional(),
    /**
     * the IDE-style structured plan envelope. All optional — when omitted,
     * the approval card falls back to rendering just the `planMarkdown`
     * body. When supplied, the renderer shows a richer plan card with
     * todos / phased breakdown / overview.
     */
    name: z.string().optional(),
    overview: z.string().optional(),
    isProject: z.boolean().optional(),
    todos: z.array(planTodoSchema).optional(),
    phases: z
      .array(
        z
          .object({
            name: z.string(),
            todos: z.array(planTodoSchema),
          })
          .strict(),
      )
      .optional(),
  })
  .strict()

/**
 * `VerifyPlanExecution` tool input. The model calls this AFTER
 * implementing a plan (post-`ExitPlanMode`) to verify the work
 * matches the plan. The tool prompts the model to produce a
 * structured verification report and clears the
 * `pendingPlanVerification` state that drives the reminder
 * collector.
 *
 * Both `planId` and `verificationReport` are optional so the model
 * can call the tool with just a free-form report for ad-hoc
 * verification (without a corresponding `ExitPlanMode`).
 */
export const verifyPlanExecutionInputZod = z
  .object({
    /**
     * Plan id (from the corresponding `ExitPlanMode` result). Used to
     * match the pending verification entry. When omitted, the tool
     * resolves against the conversation's most recent pending entry.
     */
    planId: z
      .string()
      .optional()
      .describe('Plan identifier from ExitPlanMode (optional).'),
    /**
     * The model's structured verification report. Conventionally:
     *   - "Completed steps:" with bullet list
     *   - "Skipped / deferred steps:" with reasons
     *   - "Deviations from plan:" with rationale
     *   - "Tests run / passing:" with results
     */
    verificationReport: z
      .string()
      .min(1)
      .describe(
        'Structured verification report covering completed / skipped / deviated plan steps.',
      ),
  })
  .strict()

// P1-6 (audit): previously `cron` and `prompt` were both required strings,
// but the runtime `call` in `CronTools.ts` happily accepted `command` as a
// `prompt` alias and converted `intervalMinutes` into a cron expression
// when `cron` was empty. Those fallbacks were dead code ? Zod rejected
// the payload before `call` ever ran. Align the schema with the
// runtime: at least one of {prompt, command} must be present, and at
// least one of {cron, intervalMinutes} must be present. Either path
// resolves to a valid scheduled task.
export const cronCreateInputZod = z
  .object({
    cron: z.string().optional().describe('Standard 5-field cron expression'),
    prompt: z.string().optional().describe('Prompt or command to execute'),
    recurring: z.boolean().optional().describe('Repeat (default true, 7-day auto-expiry)'),
    durable: z.boolean().optional().describe('Persist to disk for cross-session'),
    permanent: z.boolean().optional().describe('No auto-expiry'),
    id: z.string().optional(),
    label: z.string().optional().describe('Human-readable label for this task'),
    description: z.string().optional().describe('Alias for label — accepted because LLMs gravitate toward "description" as the generic annotation name'),
    intervalMinutes: z.number().optional().describe('Legacy: converted to */N * * * *'),
    command: z.string().optional().describe('Legacy alias for prompt'),
  })
  .strict()
  .superRefine((data, ctx) => {
    const hasPrompt = (typeof data.prompt === 'string' && data.prompt.trim().length > 0)
      || (typeof data.command === 'string' && data.command.trim().length > 0)
    if (!hasPrompt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'prompt (or legacy command alias) is required',
        path: ['prompt'],
      })
    }
    const hasSchedule = (typeof data.cron === 'string' && data.cron.trim().length > 0)
      || (typeof data.intervalMinutes === 'number' && data.intervalMinutes > 0)
    if (!hasSchedule) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'cron (or legacy intervalMinutes alias) is required',
        path: ['cron'],
      })
    }
  })

export const cronDeleteInputZod = z
  .object({
    id: z.string(),
  })
  .strict()

export const taskCreateInputZod = z
  .object({
    subject: z.string(),
    description: z.string().optional(),
    activeForm: z.string().optional(),
    owner: z.string().optional(),
    source: z.enum(['user', 'plan', 'coordinator', 'system']).optional(),
    status: z
      .enum(['pending', 'in_progress', 'completed', 'failed', 'cancelled'])
      .optional()
      .describe('Initial task status (default pending). Use TaskUpdate to change later.'),
    addBlockedBy: z.string().optional(),
    // P2-V2 (intent comprehension): same semantics as TodoWrite.objective —
    // the user's ultimate goal (the *why*), re-surfaced during long runs.
    objective: z.string().optional(),
  })
  .strict()

export const taskGetInputZod = z
  .object({
    taskId: z.string(),
  })
  .strict()

export const listMcpResourcesInputZod = z
  .object({
    server: z.string().optional(),
  })
  .strict()

export const readMcpResourceInputZod = z
  .object({
    server: z.string(),
    uri: z.string(),
  })
  .strict()

export const taskOutputInputZod = z
  .object({
    task_id: z.string(),
    offset: z.number().optional(),
    limit: z.number().optional(),
    format: z.enum(['text', 'json']).optional(),
    wait_for_status: z
      .enum(['completed', 'failed', 'any_terminal', 'has_output'])
      .optional(),
    wait_timeout_ms: z.number().optional(),
  })
  .strict()

export const taskStopInputZod = z
  .object({
    taskId: z.string().optional(),
    task_id: z.string().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const id = String(data.taskId ?? data.task_id ?? '').trim()
    if (!id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'taskId or task_id is required',
        path: ['taskId'],
      })
    }
  })
  .transform((data) => ({
    taskId: String(data.taskId ?? data.task_id ?? '').trim(),
  }))

export const killAllTasksInputZod = z
  .object({
    scope: z.enum(['all', 'agents']).optional(),
  })
  .strict()

export const killAgentTasksInputZod = z
  .object({
    agentId: z.string(),
    scope: z.enum(['all', 'shells']).optional(),
  })
  .strict()

export const remoteTriggerInputZod = z
  .object({
    operation: z.enum(['start', 'stop', 'status']),
  })
  .strict()

export const swarmMultiplexerInputZod = z
  .object({
    operation: z.enum(['create_session', 'list_sessions']),
    session_name: z.string().optional(),
    command: z.string().optional(),
  })
  .strict()
  .superRefine((d, ctx) => {
    if (d.operation === 'create_session' && !String(d.session_name ?? '').trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'session_name is required for create_session',
      })
    }
  })

// ——— AC-1.2/1.10/4.1: strict per-field Zod schemas — replaces looseRegistryToolInputZod fallback ———

export const configToolInputZod = z
  .object({
    setting: z.string(),
    value: z.string().optional(),
  })
  .strict()

export const toolSearchInputZod = z
  .object({
    query: z.string(),
    maxResults: z.number().optional(),
  })
  .strict()

export const taskUpdateInputZod = z
  .object({
    taskId: z.string().optional(),
    task_id: z.string().optional(),
    subject: z.string().optional(),
    /** Common alias for subject */
    title: z.string().optional(),
    description: z.string().optional(),
    activeForm: z.string().optional(),
    active_form: z.string().optional(),
    status: z.enum(['pending', 'in_progress', 'completed', 'failed', 'deleted']).optional(),
    owner: z.string().optional(),
    source: z.string().optional(),
    addBlockedBy: z.string().optional(),
    add_blocked_by: z.string().optional(),
    metadata: taskUpdateMetadataField(),
  })
  .strict()
  .transform((data) => ({
    taskId: data.taskId ?? data.task_id,
    subject: data.subject ?? data.title,
    description: data.description,
    activeForm: data.activeForm ?? data.active_form,
    status: data.status,
    owner: data.owner,
    source: data.source,
    addBlockedBy: data.addBlockedBy ?? data.add_blocked_by,
    metadata: data.metadata,
  }))

export const teamStatusInputZod = z
  .object({
    team_name: z.string(),
  })
  .strict()

export const teamCreateInputZod = z
  .object({
    team_name: z.string(),
    description: z.string().optional(),
    agent_type: z.string().optional(),
    /**
     * Optional reference to a `TeamTemplate.id` from the active Bundle's
     * `teams` array. When set **and** `POLE_TEAM_AUTO_LAUNCH=1` is enabled,
     * the orchestrator auto-launches the template (spawns members according
     * to the template's `coordination` policy) instead of leaving member
     * spawn to downstream `Agent` tool calls. Unknown / empty —classic
     * empty-shell TeamCreate behavior.
     */
    template: z.string().optional(),
  })
  .strict()

export const teamDeleteInputZod = z
  .object({
    team_name: z.string().optional(),
  })
  .strict()

export const enterWorktreeInputZod = z
  .object({
    name: z.string().optional(),
    link_node_modules: z.boolean().optional(),
  })
  .strict()

export const exitWorktreeInputZod = z
  .object({
    action: z.string(),
    discard_changes: z.boolean().optional(),
  })
  .strict()

export const spawnTeammateInputZod = z
  .object({
    mode: z.string(),
    shell_command: z.string(),
    tmux_session: z.string().optional(),
  })
  .strict()

export const briefToolInputZod = z
  .object({
    message: z.string(),
    status: z.enum(['normal', 'proactive']).optional(),
    attachments: z.array(z.string()).optional(),
  })
  .strict()

export const readDiagnosticsInputZod = z
  .object({
    file: z.string().optional(),
    severity: z.string().optional(),
  })
  .strict()

export const askUserQuestionInputZod = z
  .object({
    questions: z.array(z.record(z.string(), z.unknown())),
    answers: z.record(z.string(), z.unknown()).optional(),
    annotations: z.record(z.string(), z.unknown()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

export const lspToolInputZod = z
  .object({
    operation: z.enum([
      'goToDefinition', 'findReferences', 'hover', 'documentSymbol',
      'workspaceSymbol', 'goToImplementation', 'prepareCallHierarchy',
      'incomingCalls', 'outgoingCalls',
      'codeAction', 'completion', 'signatureHelp', 'formatting', 'rename', 'foldingRange',
      'semanticTokens',
    ]),
    filePath: z.string().optional(),
    /** snake_case alias emitted by OpenAI-family models. */
    file_path: z.string().optional(),
    /** Natural-language alias. */
    path: z.string().optional(),
    line: z.number().optional(),
    character: z.number().optional(),
    endLine: z.number().optional(),
    endCharacter: z.number().optional(),
    newName: z.string().optional(),
    query: z.string().optional(),
    semanticTokensMode: z.enum(['full', 'range']).optional(),
  })
  .passthrough()
  .superRefine((data, ctx) => {
    const fp = (data.filePath ?? data.file_path ?? data.path ?? '').trim()
    // `workspaceSymbol` is a workspace-wide query and never needs a specific
    // file. Requiring filePath here forced the AI into a paradox ("I want to
    // find symbol X —but you must tell me which file to look in first?")
    // and was the main reason the operation was effectively unused.
    if (data.operation !== 'workspaceSymbol' && !fp) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'filePath (or file_path / path alias) is required',
        path: ['filePath'],
      })
    }
    if (data.operation === 'workspaceSymbol') {
      const q = typeof data.query === 'string' ? data.query.trim() : ''
      if (!q) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'workspaceSymbol requires a non-empty `query` (the symbol name or fragment to search for).',
          path: ['query'],
        })
      }
    }
  })
  .transform((data) => ({
    operation: data.operation,
    filePath: (data.filePath ?? data.file_path ?? data.path ?? '').trim(),
    line: data.line,
    character: data.character,
    endLine: data.endLine,
    endCharacter: data.endCharacter,
    newName: data.newName,
    query: data.query,
    semanticTokensMode: data.semanticTokensMode,
  }))

export const replToolInputZod = z
  .object({
    prompt: z.string(),
    agentType: z.string().optional(),
    maxTurns: z.number().optional(),
    model: z.string().optional(),
  })
  .strict()

export const notebookEditInputZod = z
  .object({
    notebook_path: z.string(),
    cell_id: z.string().optional(),
    new_source: z.string(),
    cell_type: z.enum(['code', 'markdown']).optional(),
    edit_mode: z.enum(['replace', 'insert', 'delete']).optional(),
  })
  .strict()

/**
 * Input schema for the `recall_attachment` tool —pulls the bytes of a
 * historical attachment that was stripped from context (see P2
 * `<recall-pointer>` in `src/services/contextBuilder.ts`).
 *
 * The model echoes the `sha256` + `kind` values verbatim from a
 * `<recall-pointer>` tag's attributes; both are required because the
 * attachment cache is keyed by `(sha256, kindHint)` and the same content
 * could in principle live under multiple kinds (e.g. raw bytes vs. parsed
 * preview). A non-strict `.passthrough()` matches the rest of the registry
 * —extra keys are ignored, not rejected.
 */
export const recallAttachmentInputZod = z
  .object({
    sha256: z.string().min(1, 'sha256 must be a non-empty hex string'),
    kind: z
      .string()
      .min(1, 'kind must be the same value seen in the <recall-pointer> tag (e.g. "image" / "pdf" / "docx")'),
  })
  .passthrough()

export const todoWriteInputZod = z
  .object({
    todos: todoWriteTodosArray(),
    // P2 (intent comprehension): optional one-line statement of the user's
    // ultimate objective (the *why* behind the task). Stored verbatim and
    // re-surfaced at the tail of the model's context by goal recitation so
    // the deep intent — not just the step list — survives long runs.
    objective: z.string().optional(),
  })
  .strict()

/**
 * Input schema for the `Await` tool — block until background shell / sub-agent
 * tasks finish or their output matches a pattern. `.passthrough()` matches the
 * lenient majority of registry schemas (stray model-emitted keys are ignored).
 */
export const awaitToolInputZod = z
  .object({
    task_ids: z.array(z.string().min(1)).min(1),
    wait_for: z.string().optional(),
    mode: z.enum(['all', 'any']).optional(),
    timeout_ms: z.number().int().positive().optional(),
  })
  .passthrough()

/**
 * Input schema for the `BestOfN` tool — run one task N ways in parallel
 * (isolated git worktrees), score the results, and cherry-pick the winner.
 */
export const bestOfNToolInputZod = z
  .object({
    task: z.string().min(1),
    n: z.number().int().positive().optional(),
    variants: z.array(z.string()).optional(),
    agent_type: z.string().optional(),
    verify: z.boolean().optional(),
    integrate: z.boolean().optional(),
  })
  .passthrough()
