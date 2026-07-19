/**
 * Unified `stop_reason` mapping from provider-native finish reasons to the
 * Claude Messages vocabulary used by `agenticLoop` and the renderer UI.
 *
 * Why this exists: before this file, each transformer just passed the native
 * value through untouched (e.g. Gemini's `STOP`, OpenAI's `tool_calls`,
 * Responses API's `completed`). That means downstream consumers that check
 * for Claude semantics — most importantly `agenticLoop.ts` L968/L1011's
 * max-tokens recovery — silently failed on every non-Claude provider.
 *
 * The canonical Claude stop reasons are:
 *   - `end_turn`       — model finished on its own
 *   - `tool_use`       — model emitted one or more `tool_use` blocks
 *   - `max_tokens`     — hit the generation cap
 *   - `stop_sequence`  — matched a user-supplied stop sequence
 *   - `refusal`        — safety / policy refusal
 *   - `pause_turn`     — native Anthropic long-running turn pause
 *   - `model_context_window_exceeded`
 *
 * The mapping is intentionally conservative: when the raw value is unknown or
 * already matches a Claude value, we return it as-is. This keeps our behavior
 * future-proof when Anthropic adds new reasons.
 */

import type { WireFormat } from './providerQuirks'

export type ClaudeStopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'stop_sequence'
  | 'refusal'
  | 'pause_turn'
  | 'model_context_window_exceeded'
  | (string & Record<never, never>)

const CLAUDE_CANONICAL_REASONS = new Set([
  'end_turn',
  'tool_use',
  'max_tokens',
  'stop_sequence',
  'refusal',
  'pause_turn',
  'model_context_window_exceeded',
])

/**
 * Hint: whether the response included any `tool_use` content blocks. OpenAI
 * and Gemini both surface tool calls as side-effects of a normal "stop" —
 * `finish_reason` is `stop`/`STOP` even when the model emitted a tool call.
 * Without this signal we can't distinguish "model wants to call a tool" from
 * "model produced its final text and is done".
 */
export interface StopReasonHints {
  hasToolUseBlocks?: boolean
  safetyBlocked?: boolean
}

/**
 * Map a provider-native stop/finish reason to the Claude vocabulary.
 *
 * The mapping rules:
 *   1. If the raw value is already a Claude canonical reason, pass through.
 *   2. Use wire-specific alias tables (e.g. Gemini `MAX_TOKENS` → `max_tokens`).
 *   3. If any hint indicates tool use and we would otherwise report `end_turn`,
 *      upgrade to `tool_use`.
 *   4. Fallback: `end_turn`.
 */
export function mapStopReasonToClaude(
  wire: WireFormat,
  raw: string | null | undefined,
  hints: StopReasonHints = {},
): ClaudeStopReason {
  const rawStr = typeof raw === 'string' ? raw.trim() : ''

  // Rule 1: already Claude.
  if (CLAUDE_CANONICAL_REASONS.has(rawStr)) {
    return rawStr as ClaudeStopReason
  }

  // Rule 2: alias tables.
  const aliased = mapByWire(wire, rawStr, hints)

  // Rule 3: upgrade end_turn → tool_use when tools were emitted.
  if (aliased === 'end_turn' && hints.hasToolUseBlocks) {
    return 'tool_use'
  }

  return aliased
}

function mapByWire(wire: WireFormat, raw: string, hints: StopReasonHints): ClaudeStopReason {
  switch (wire) {
    case 'anthropic':
    case 'anthropic-compat':
      // Anthropic may also emit null / empty → default to end_turn.
      return raw.length === 0 ? 'end_turn' : (raw as ClaudeStopReason)

    case 'openai-native':
    case 'openai-compat':
      return mapOpenAiChat(raw, hints)

    case 'openai2-native':
    case 'openai2-compat':
      return mapOpenAi2(raw, hints)

    case 'gemini-native':
    case 'gemini-compat':
      return mapGemini(raw, hints)

    default:
      return raw.length === 0 ? 'end_turn' : (raw as ClaudeStopReason)
  }
}

// Audit Bug 13 — providers periodically introduce new finish reasons
// (e.g. policy / safety variants) that we silently used to map to
// `'end_turn'`, indistinguishable from a normal completion. Log the
// raw value once per process so the next surfacing in telemetry /
// logs makes the surprise visible without spamming. We intentionally
// keep returning `'end_turn'` to avoid hard-failing on unknown
// reasons — only the telemetry/logging behaviour changes.
const seenUnknownStopReasons = new Set<string>()
function logUnknownStopReason(wire: string, raw: string): void {
  const key = `${wire}::${raw}`
  if (seenUnknownStopReasons.has(key)) return
  seenUnknownStopReasons.add(key)
  console.warn(
    `[stopReasonMap] Unknown stop reason from ${wire}: "${raw}" — defaulting to 'end_turn'.`,
  )
}

/** OpenAI Chat Completions `finish_reason`. */
function mapOpenAiChat(raw: string, hints: StopReasonHints): ClaudeStopReason {
  switch (raw.toLowerCase()) {
    case '':
    case 'stop':
      // OpenAI emits `stop` regardless of whether tools were invoked.
      return hints.hasToolUseBlocks ? 'tool_use' : 'end_turn'
    case 'length':
      return 'max_tokens'
    case 'tool_calls':
    case 'function_call':
      return 'tool_use'
    case 'content_filter':
      return 'refusal'
    default:
      logUnknownStopReason('openai', raw)
      return 'end_turn'
  }
}

/** OpenAI Responses API (openai2). */
function mapOpenAi2(raw: string, hints: StopReasonHints): ClaudeStopReason {
  switch (raw.toLowerCase()) {
    case '':
    case 'completed':
      return hints.hasToolUseBlocks ? 'tool_use' : 'end_turn'
    case 'incomplete':
      // Responses API puts the detail in `incomplete_details.reason`; without
      // that plumbed through, treat as `max_tokens` since that's the most
      // common incomplete cause.
      return 'max_tokens'
    case 'failed':
    case 'cancelled':
      return 'end_turn'
    case 'content_filter':
      return 'refusal'
    case 'tool_calls':
    case 'function_call':
      return 'tool_use'
    default:
      logUnknownStopReason('openai2', raw)
      return 'end_turn'
  }
}

/** Gemini `finishReason`. */
function mapGemini(raw: string, hints: StopReasonHints): ClaudeStopReason {
  switch (raw.toUpperCase()) {
    case '':
    case 'STOP':
      return hints.hasToolUseBlocks ? 'tool_use' : 'end_turn'
    case 'MAX_TOKENS':
      return 'max_tokens'
    case 'SAFETY':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
      return 'refusal'
    case 'RECITATION':
      return 'stop_sequence'
    case 'FINISH_REASON_UNSPECIFIED':
    case 'OTHER':
      return 'end_turn'
    default:
      logUnknownStopReason('gemini', raw)
      return 'end_turn'
  }
}
