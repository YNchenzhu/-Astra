/**
 * Shared parser for tool-call `arguments` (OpenAI / Gemini / generic wire).
 *
 * Every wire that transports tool calls ends up with `arguments` as a JSON
 * **string** on the wire — OpenAI Chat (`function.arguments`), OpenAI Responses
 * (`function_call_arguments.delta`), and streaming proxies often re-serialize
 * Gemini's `functionCall.args` as a string too.
 *
 * Before this helper, every transformer and the compat client had its own
 * `try JSON.parse catch -> {}` block. Silently returning `{}` hides real
 * parse failures (malformed arguments, truncated streams, nested wrappers)
 * and causes downstream Zod to report "required field missing" with no clue
 * what the model actually tried to send — then the model "corrects" and keeps
 * sending `{}`.
 *
 * Policy here matches `providers/openai.ts#parseOpenAIToolCallArguments`:
 *   1. Try JSON.parse. If it yields an object, pass through.
 *   2. If the parsed object has a string `raw_arguments` (gateway nested
 *      wrapping), unwrap once.
 *   3. If the parsed "object" is really an array/primitive, wrap as raw.
 *   4. Parse failure — surface the raw string via `__rawArguments` so the
 *      tool validator can log the actual bytes and return a structured error
 *      back to the model.
 *
 * The `__rawArguments` marker key is intentionally double-underscored so it
 * cannot collide with any real tool parameter name.
 */

import { jsonrepair } from 'jsonrepair'

export const RAW_ARGUMENTS_KEY = '__rawArguments'

/**
 * Sentinel key stamped DIRECTLY on a tool-input object that could only be
 * parsed after the third-party `jsonrepair` pass (e.g. an unescaped interior
 * `"`). Stamped centrally here — on the recovered object itself — so it rides
 * through EVERY emission path (streaming flush, non-stream fallback, response
 * transformers like geminiToClaude, and the provider clients) without any
 * emitter needing to remember to set it. The write/edit Zod schemas detect it
 * and refuse the call (a mis-guessed `newString`/`content` boundary must never
 * be persisted); read-class tools ignore it and their transforms drop it, so
 * reads still benefit from the repair. `toolInputZod.ts` imports this constant
 * for the refusal check.
 */
export const LENIENT_REPAIRED_TOOL_ARGS_MARKER_KEY = '__argsLenientlyRepaired'

/**
 * Sentinel key stamped on a tool-input object recovered from a TRUNCATED wire
 * payload (unterminated string / unbalanced braces auto-closed by
 * {@link tryCloseTruncatedJson} — classic max_tokens cut mid-`content`). Like
 * the lenient marker it is stamped centrally so it covers every emission path,
 * including the non-stream fallback and the response transformers where the
 * streaming clients' per-emitter checks never run. The streaming clients
 * additionally stamp this key when the wire reported `stop_reason: max_tokens`
 * even though the JSON parsed cleanly (a signal only the client can see). The
 * write/edit schemas refuse it so a partial/corrupted file is never persisted.
 */
export const TRUNCATED_TOOL_ARGS_MARKER_KEY = '__argsTruncatedByMaxTokens'

/**
 * Inverse of {@link parseToolArguments}: serialize an Anthropic-shaped
 * `tool_use.input` to the JSON-string `arguments` that OpenAI Chat /
 * OpenAI2 Responses / generic OpenAI-compat wires expect on
 * historical `tool_call` echoes.
 *
 * Why this helper exists: the agentic loop replays prior assistant turns
 * back to the model, and `tool_use.input` may arrive as **either** an
 * object (the canonical Anthropic shape) **or** a JSON string (when the
 * upstream gateway re-serialized it during a previous round-trip and our
 * local consumer never re-parsed). A bare `JSON.stringify(input)` would
 * then produce a double-encoded string like `"\"{ \\\"path\\\": ... }\""`,
 * and the model would see a stringified-string as the tool's parameters
 * — typically responding with `null` / a hallucinated re-call.
 *
 * Routing through `parseToolArguments` first normalizes any wire form
 * back to a plain object, then a single `JSON.stringify` produces the
 * exact one-level-encoded form OpenAI requires. Empty / nullish input
 * collapses to `{}` so the wire payload is never literally `null`.
 */
export function stringifyToolInputForOpenAi(input: unknown): string {
  if (input === undefined || input === null) return '{}'
  if (typeof input === 'string') {
    // Already a string — could be valid JSON, raw text, or the
    // `__rawArguments` sentinel. `parseToolArguments` round-trips all
    // three correctly and gives us a real object to re-encode. Strip the
    // internal refusal sentinels so they never ride onto the wire.
    return JSON.stringify(stripInternalToolArgMarkers(parseToolArguments(input)))
  }
  if (typeof input === 'object' && !Array.isArray(input)) {
    // Already an object — fast path. Skip parseToolArguments to avoid the
    // tiny overhead of an unnecessary stringify+parse round-trip, but still
    // strip the internal sentinels (a clone so we don't mutate the caller's
    // object, which may still be needed elsewhere).
    return JSON.stringify(stripInternalToolArgMarkers({ ...(input as Record<string, unknown>) }))
  }
  // Array / number / boolean — invalid as tool input but not our problem
  // here; wrap so we don't crash the transformer and surface it raw to
  // downstream so the model can self-correct.
  return JSON.stringify(parseToolArguments(input))
}

export interface ParsedToolArguments extends Record<string, unknown> {
  [RAW_ARGUMENTS_KEY]?: string
}

/**
 * Remove the internal write/edit refusal sentinels from a tool-input object.
 * These are transient transport metadata consumed by the Zod gate and MUST NOT
 * leak onto the wire (a replayed prior tool call) or into persisted history.
 * Mutates and returns the same object for chaining; tolerant of non-objects.
 */
export function stripInternalToolArgMarkers<T>(input: T): T {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const rec = input as Record<string, unknown>
    delete rec[LENIENT_REPAIRED_TOOL_ARGS_MARKER_KEY]
    delete rec[TRUNCATED_TOOL_ARGS_MARKER_KEY]
  }
  return input
}

export interface ParseToolArgumentsMeta {
  /**
   * True when the parsed object was recovered ONLY by auto-closing an
   * unterminated string / unbalanced braces (`tryCloseTruncatedJson`) — i.e.
   * the wire payload was genuinely cut off mid-value (classic max_tokens
   * truncation while streaming a large `content` / `newString`). The recovered
   * object is structurally valid but its last string field is PARTIAL, so a
   * write/edit built from it would silently persist a corrupted file. Callers
   * that mutate the filesystem use this to refuse the write. NOT set for the
   * benign repairs (fence strip, trailing-prose carve) which don't lose data.
   */
  truncationRepaired: boolean
  /**
   * True when the object was recovered by the third-party `jsonrepair` library
   * (the last-ditch pass that fixes unescaped interior quotes, etc.) and NOT by
   * a strict parse or one of the cheap in-house repairs. The recovered object
   * is structurally valid, but `jsonrepair`'s unescaped-quote heuristic is
   * lookahead-based and CAN guess string boundaries wrong (documented failures
   * on `"…",` / `"…")` / `"…"/` shapes). That's harmless for non-destructive
   * tools (a wrong `read_file` path just 404s; a wrong `oldString` simply fails
   * to match disk) but UNSAFE for the persisted field of a write/edit — a
   * mis-guessed `newString` / `content` boundary would silently corrupt a file.
   * The write/edit Zod schemas refuse a lenient-repaired payload; read-class
   * tools accept it (that is the whole "reads benefit, writes don't risk" gate).
   */
  lenientRepaired: boolean
}

/**
 * Parse a tool call's `arguments` payload (string or already-object) into a
 * plain object. Never throws, never returns `{}` silently — on failure the
 * raw string is preserved under {@link RAW_ARGUMENTS_KEY}.
 */
export function parseToolArguments(raw: unknown): ParsedToolArguments {
  return parseToolArgumentsWithMeta(raw).value
}

/**
 * Same as {@link parseToolArguments} but also reports {@link ParseToolArgumentsMeta}
 * — notably whether the value was recovered from a truncated wire payload.
 */
export function parseToolArgumentsWithMeta(
  raw: unknown,
): { value: ParsedToolArguments; meta: ParseToolArgumentsMeta } {
  const noTrunc = (value: ParsedToolArguments) => ({
    value,
    meta: { truncationRepaired: false, lenientRepaired: false },
  })
  const lenient = (value: ParsedToolArguments) => {
    ;(value as Record<string, unknown>)[LENIENT_REPAIRED_TOOL_ARGS_MARKER_KEY] = true
    return { value, meta: { truncationRepaired: false, lenientRepaired: true } }
  }
  const truncated = (value: ParsedToolArguments) => {
    // Stamp centrally so the non-stream fallback + response transformers (where
    // the streaming clients' per-emitter check never runs) also refuse the write.
    ;(value as Record<string, unknown>)[TRUNCATED_TOOL_ARGS_MARKER_KEY] = true
    return { value, meta: { truncationRepaired: true, lenientRepaired: false } }
  }

  if (raw == null) return noTrunc({})

  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const rec = raw as Record<string, unknown>
    // Unwrap once if a nested `raw_arguments` string is present (gateway wrapping).
    if (typeof rec.raw_arguments === 'string' && rec.raw_arguments.trim()) {
      const unwrapped = tryParseJsonObject(rec.raw_arguments)
      if (unwrapped) return noTrunc(unwrapped)
    }
    return noTrunc(rec)
  }

  if (typeof raw !== 'string') {
    // Array / number / boolean — never a valid tool input, preserve as raw.
    return noTrunc({ [RAW_ARGUMENTS_KEY]: JSON.stringify(raw) })
  }

  const trimmed = raw.trim()
  if (!trimmed) return noTrunc({})

  const parsed = tryParseJsonObject(trimmed)
  if (parsed) {
    // Unwrap `{raw_arguments: "…"}` wrappers (DeepSeek / Moonshot proxies).
    const innerRaw = (parsed as Record<string, unknown>).raw_arguments
    if (typeof innerRaw === 'string' && innerRaw.trim()) {
      const inner = tryParseJsonObject(innerRaw)
      if (inner) return noTrunc(inner)
    }
    return noTrunc(parsed)
  }

  // Repair pass — DeepSeek / Kimi / GLM Anthropic-compat gateways often emit
  // tool `arguments` that are *almost* JSON: markdown fence wrapper, trailing
  // prose after the closing brace, stream truncated mid-string (common when
  // the LLM hits max_tokens writing a large file), or unbalanced braces.
  // Try two recovery heuristics before surrendering:
  //   1. Strip a ```json … ``` fence and any "Here is the JSON:" preamble.
  //   2. Carve out the longest balanced `{ … }` substring and parse that.
  //   3. For truncated strings / braces, try to auto-close and parse.
  //
  // All three keep the tool call alive for the common "model made a typo
  // but the intent is clear" case instead of surfacing the cryptic
  // `received keys: [__rawArguments]` loop to the user.
  const cleaned = stripCodeFence(trimmed)
  if (cleaned !== trimmed) {
    const reParsed = tryParseJsonObject(cleaned)
    if (reParsed) return noTrunc(reParsed)
  }

  const carved = carveBalancedObject(cleaned)
  if (carved) {
    const carvedParsed = tryParseJsonObject(carved)
    if (carvedParsed) return noTrunc(carvedParsed)
  }

  // The auto-close path is the ONLY repair that recovers from a genuinely
  // truncated payload (unterminated string / unbalanced braces). Flag it so
  // filesystem-mutating callers can refuse to persist the partial value.
  const closed = tryCloseTruncatedJson(carved ?? cleaned)
  if (closed) {
    const closedParsed = tryParseJsonObject(closed)
    if (closedParsed) {
      return truncated(closedParsed)
    }
  }

  // Last-ditch: the industry-standard `jsonrepair` library. It fixes the one
  // class our cheap in-house repairs cannot — an UNESCAPED interior `"` inside
  // a string value (the #1 failure mode for long Chinese edit payloads) — plus
  // single quotes, trailing commas, comments, etc. Its unescaped-quote fix is
  // a lookahead heuristic that can guess string boundaries wrong, so we tag the
  // result `lenientRepaired`: read-class tools accept it (a wrong path/oldString
  // fails safely), but write/edit schemas refuse it so a mis-guessed
  // `newString` / `content` boundary can never silently corrupt a file.
  if (process.env.DISABLE_LENIENT_JSON_REPAIR !== '1') {
    try {
      const repaired = jsonrepair(trimmed)
      const repairedParsed = tryParseJsonObject(repaired)
      if (repairedParsed) {
        // Unwrap a nested `{raw_arguments: "…"}` wrapper if jsonrepair surfaced one.
        const innerRaw = (repairedParsed as Record<string, unknown>).raw_arguments
        if (typeof innerRaw === 'string' && innerRaw.trim()) {
          const inner = tryParseJsonObject(innerRaw)
          if (inner) return lenient(inner)
        }
        return lenient(repairedParsed)
      }
    } catch {
      // jsonrepair throws JSONRepairError on truly unparseable input — fall
      // through to the raw-arguments surface so the model gets the pinpoint hint.
    }
  }

  // Unrecoverable. Could be truncation OR an escaping mistake (unescaped `"`),
  // so we do NOT claim `truncationRepaired` here — the downstream validator
  // already distinguishes those two via `looksLikeUnescapedQuoteInJson` and
  // surfaces the right hint. Surface raw so it can.
  return noTrunc({ [RAW_ARGUMENTS_KEY]: trimmed })
}

function tryParseJsonObject(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s) as unknown
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return v as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

/**
 * Strip a leading ```json / ``` code fence or a conversational preamble
 * ("Here is the JSON:"). Returns the trimmed inner payload, or the input
 * unchanged if no wrapper is detected.
 */
function stripCodeFence(s: string): string {
  let body = s
  // Leading prose like "Here is the JSON:\n" — keep it conservative: only
  // drop non-`{` non-`[` prefixes when the first `{` / `[` is reasonably
  // close (within the first 200 chars).
  const openIdx = body.search(/[{[]/)
  if (openIdx > 0 && openIdx <= 200) {
    body = body.slice(openIdx)
  }
  // Strip ```json … ``` fence (also plain ``` without lang tag).
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```\s*$/i
  const m = fence.exec(body)
  if (m) return m[1].trim()
  return body.trim()
}

/**
 * Carve out the **longest** balanced `{ … }` substring starting at the first
 * `{`. Tolerates trailing prose after the JSON body. Returns null when no
 * balanced object can be found.
 *
 * The scanner is string-aware (respects `"…"` and `\"` escapes) so braces
 * inside string literals don't confuse the counter.
 */
function carveBalancedObject(s: string): string | null {
  const start = s.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escape = false
  let lastCloseIdx = -1
  for (let i = start; i < s.length; i++) {
    const ch = s.charAt(i)
    if (inString) {
      if (escape) {
        escape = false
      } else if (ch === '\\') {
        escape = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) {
        lastCloseIdx = i
        // Keep scanning: nested empty objects may yield earlier closes, but
        // we want the outermost — stop at the first `depth === 0` AFTER
        // the opening `{`, since any further chars are trailing garbage.
        break
      }
    }
  }
  if (lastCloseIdx < 0) return null
  return s.slice(start, lastCloseIdx + 1)
}

/**
 * Last-ditch repair for streams truncated mid-string or mid-object. Scans the
 * payload, closes any unterminated `"…` string at the end, then appends the
 * right number of `}` / `]` to rebalance. Returns `null` if the repair would
 * clearly produce nonsense (empty input, no opening brace, too many unbalanced
 * closers).
 */
function tryCloseTruncatedJson(s: string): string | null {
  if (!s) return null
  const firstOpen = s.search(/[{[]/)
  if (firstOpen < 0) return null
  let body = s.slice(firstOpen)
  let inString = false
  let escape = false
  const stack: Array<'{' | '['> = []
  for (let i = 0; i < body.length; i++) {
    const ch = body.charAt(i)
    if (inString) {
      if (escape) {
        escape = false
      } else if (ch === '\\') {
        escape = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      stack.push('{')
    } else if (ch === '[') {
      stack.push('[')
    } else if (ch === '}' || ch === ']') {
      if (stack.length === 0) return null // more closers than openers — give up
      stack.pop()
    }
  }
  // An unterminated string: close it. A trailing `\` inside the string means
  // the provider cut the payload right after an escape sentinel — strip it so
  // the appended `"` is not consumed as part of the escape.
  if (inString) {
    if (escape) body = body.slice(0, -1)
    body += '"'
  }
  while (stack.length > 0) {
    const top = stack.pop()
    body += top === '{' ? '}' : ']'
  }
  return body
}
