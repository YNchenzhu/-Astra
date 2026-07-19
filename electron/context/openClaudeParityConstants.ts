/**
 * Constants and window math aligned with doc/upstream上下文功能深度分析报告.txt §1.3 / §2.
 * Used to optionally derive {@link ContextThresholds} and document parity with upstream naming.
 */

import { getOverrideContextWindowTokens } from './modelWindowOverrides'

/** Default context window when model is unknown (report: MODEL_CONTEXT_WINDOW_DEFAULT). */
export const MODEL_CONTEXT_WINDOW_DEFAULT = 200_000

/** Reserved from window for summary / output negotiation (report: MAX_OUTPUT_TOKENS_FOR_SUMMARY-style). */
export const OPENCLAUDE_EFFECTIVE_WINDOW_OUTPUT_RESERVE = 20_000

/**
 * Report §6.3 — when estimated input tokens reach this fraction of the effective window,
 * drain queued context-collapse summaries into the message list (before micro/auto-compact).
 */
export const CONTEXT_COLLAPSE_FRAC_OF_EFFECTIVE_WINDOW = 0.9

/** Auto-compact trigger buffer (report: AUTOCOMPACT_BUFFER_TOKENS). */
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000

/** Blocking / manual compact buffer (report: MANUAL_COMPACT_BUFFER_TOKENS). */
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000

/** History snip tries to land this many tokens under auto-compact before API call. */
export const SNIP_TARGET_MARGIN_BELOW_AUTO = 6_000

/**
 * Report §1.3 — WARNING_THRESHOLD_BUFFER_TOKENS / ERROR_THRESHOLD_BUFFER_TOKENS (20_000 each).
 * Mapped to tier spacing: warning fires at W − (both), error at W − error buffer, keeping warning < error < micro.
 */
export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000
export const ERROR_THRESHOLD_BUFFER_TOKENS = 20_000

/** Delta from effective window for micro-compact tier (between error and auto). */
export const MICRO_COMPACT_WINDOW_DELTA = 18_000

/** Delta from effective window for error tier (= ERROR_THRESHOLD_BUFFER_TOKENS). */
export const ERROR_WINDOW_DELTA = ERROR_THRESHOLD_BUFFER_TOKENS

/** Delta from effective window for warning tier (= sum of §1.3 warning + error buffers). */
export const WARNING_WINDOW_DELTA =
  WARNING_THRESHOLD_BUFFER_TOKENS + ERROR_THRESHOLD_BUFFER_TOKENS

/** Max consecutive auto-compact failures (report: MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) — see ContextManager. */
export const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3

/** Report §1.3 / §17.4 — post-compact hint list size (full attachment matrix is non-goal). */
export const POST_COMPACT_MAX_FILES_TO_RESTORE = 5

/** Report §4.4 — compact request itself hit prompt-too-long: max head-truncation retries. */
export const MAX_COMPACT_PTL_RETRIES = 2

function envInt(name: string): number | undefined {
  const v = process.env[name]?.trim()
  if (!v) return undefined
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined
}

/**
 * Known model → context-window mapping.
 *
 * Matched in declaration order; first match wins. Put more specific variants
 * (1M overrides, size-suffixed families) ABOVE their base families so e.g.
 * `qwen-3-turbo-1m` hits the 1M entry before the 128k `qwen-3` fallback.
 *
 * Patterns are deliberately loose — provider gateways often prefix / suffix
 * names (`openrouter/deepseek/deepseek-v4-pro-0326`). Use boundary-aware
 * tokens (`-`, `_`, start/end) instead of raw substrings where confusion is
 * likely.
 */
const MODEL_WINDOW_REGISTRY: ReadonlyArray<{ pattern: RegExp; tokens: number }> = [
  // ─── 1M tier ─────────────────────────────────────────────────────────
  { pattern: /deepseek[-_]?v4[-_]?pro/i, tokens: 1_000_000 },
  { pattern: /gpt[-_]?4\.1\b/i, tokens: 1_000_000 },
  { pattern: /gemini[-_]?(?:1\.5|2\.0|2\.5|3)[-_]?(?:pro|flash)/i, tokens: 1_000_000 },
  { pattern: /qwen[-_]?(?:2\.5|3)[-_]?turbo/i, tokens: 1_000_000 },
  // Qwen3 Coder Plus / Next — 1M per Aliyun DashScope docs. Must be ABOVE the
  // 128k `qwen[-_]?(?:2\.5|3)` fallback or it would be downgraded.
  { pattern: /qwen[-_]?3[-_]?coder/i, tokens: 1_000_000 },
  { pattern: /(?:kimi|moonshot)[-_]?.*?(?:\b|[-_])1m\b/i, tokens: 1_000_000 },
  { pattern: /glm[-_]?4\.?[56][-_]?.*?(?:\b|[-_])1m\b/i, tokens: 1_000_000 },
  { pattern: /grok[-_]?(?:3|4)[-_]?.*?(?:\b|[-_])1m\b/i, tokens: 1_000_000 },
  { pattern: /\[1m\]|[-_]1m(?:[-_]|$)|1m[-_]context/i, tokens: 1_000_000 },

  // ─── 256k tier ───────────────────────────────────────────────────────
  { pattern: /kimi[-_]?k2/i, tokens: 256_000 },
  { pattern: /grok[-_]?(?:3|4)\b/i, tokens: 256_000 },
  { pattern: /qwen[-_]?(?:2\.5|3)[-_]?max/i, tokens: 256_000 },
  // Qwen3.5+ Plus/Flash family (qwen3.5-plus, qwen3.6-plus, …) — 256K per
  // Aliyun DashScope docs. Placed before the 128k `qwen…\b` fallback to
  // win first-match; without this, `qwen3.6-plus` was wrongly treated as
  // 128k because `\b` matches between `3` and `.`.
  { pattern: /qwen[-_]?3\.[5-9]/i, tokens: 256_000 },

  // ─── 200k tier (Claude family) ───────────────────────────────────────
  { pattern: /claude[-_]?(?:3|3\.5|3\.7|4|opus|sonnet|haiku)/i, tokens: 200_000 },

  // ─── 128k tier ───────────────────────────────────────────────────────
  { pattern: /gpt[-_]?4[-_]?turbo/i, tokens: 128_000 },
  { pattern: /gpt[-_]?4o\b/i, tokens: 128_000 },
  { pattern: /gpt[-_]?5\b/i, tokens: 128_000 },
  { pattern: /deepseek[-_]?(?:v3|chat|coder)/i, tokens: 128_000 },
  // `glm-4` and `glm-4.0..4.5` are 128K. `(?![.\d])` prevents accidentally
  // matching newer point variants like `glm-4.6` / `glm-4.7` (which are not
  // 128K) — those fall through to the 200K default unless explicitly added.
  { pattern: /glm[-_]?4(?:\.[0-5])?(?![.\d])/i, tokens: 128_000 },
  // Same defensive lookahead for Qwen base — `qwen3` / `qwen-3` stays 128K
  // but `qwen3.5+` / `qwen3.6+` (handled above as 256K) doesn't sneak in.
  { pattern: /qwen[-_]?(?:2\.5|3)(?![.\d])/i, tokens: 128_000 },
  { pattern: /mistral[-_]?(?:large|medium)/i, tokens: 128_000 },
  { pattern: /llama[-_]?3\.[12]/i, tokens: 128_000 },
  { pattern: /moonshot[-_]?v1[-_]?128k/i, tokens: 128_000 },

  // ─── Legacy / small tiers ───────────────────────────────────────────
  { pattern: /gpt[-_]?4[-_]?32k/i, tokens: 32_000 },
  { pattern: /gpt[-_]?3\.5[-_]?turbo[-_]?16k/i, tokens: 16_000 },
  { pattern: /moonshot[-_]?v1[-_]?32k/i, tokens: 32_000 },
  { pattern: /moonshot[-_]?v1[-_]?8k/i, tokens: 8_000 },
]

/**
 * Effective context window for threshold math (upstream §2.1 style, simplified).
 *
 * Resolution priority (each step short-circuits the rest):
 *   1. `POLE_CONTEXT_WINDOW_TOKENS` / `CLAUDE_CODE_MAX_CONTEXT_TOKENS` env
 *   2. **User override** (Settings → 上下文 → 模型窗口覆盖)
 *   3. **Provider registry** (`src/data/providerRegistry.ts::contextWindow`,
 *      pushed via `context:set-registry-windows` at boot)
 *   4. {@link MODEL_WINDOW_REGISTRY} pattern match (legacy fallback for
 *      models not in the registry, e.g. `compatible` provider with custom id)
 *   5. {@link MODEL_CONTEXT_WINDOW_DEFAULT} (200k) final fallback
 *
 * `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` forces any 1M match back to the
 * default — kept for parity with upstream CC. Affects steps 2/3/4: if any
 * of them reports 1M, it is downgraded to the default.
 */
export function getModelContextWindowTokens(model: string): number {
  const fromEnv = envInt('POLE_CONTEXT_WINDOW_TOKENS') ?? envInt('CLAUDE_CODE_MAX_CONTEXT_TOKENS')
  if (fromEnv !== undefined) return fromEnv

  const disable1m = process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT === '1'
  const apply1mGate = (tokens: number): number =>
    disable1m && tokens === 1_000_000 ? MODEL_CONTEXT_WINDOW_DEFAULT : tokens

  const fromOverride = getOverrideContextWindowTokens(model)
  if (fromOverride !== undefined) return apply1mGate(fromOverride)

  for (const { pattern, tokens } of MODEL_WINDOW_REGISTRY) {
    if (pattern.test(model)) return apply1mGate(tokens)
  }
  return MODEL_CONTEXT_WINDOW_DEFAULT
}

export function getEffectiveContextWindowTokens(model: string): number {
  const w = getModelContextWindowTokens(model)
  return Math.max(32_000, w - OPENCLAUDE_EFFECTIVE_WINDOW_OUTPUT_RESERVE)
}

/**
 * Compact-planning window cap (2026-07, Codex-parity proactive compaction).
 *
 * Long-context models (1M tier) technically FIT huge transcripts, but
 * attention fidelity degrades long before the physical window is full —
 * instruction blocks buried hundreds of K tokens deep lose influence while
 * the model anchors on its own recent (possibly wrong) outputs, and nothing
 * ever flushes them because the auto-compact tier sits at W − 13k
 * (≈967k for a 1M model — unreachable in practice).
 *
 * Codex CLI solves this with `model_auto_compact_token_limit`: compact
 * proactively at a budget far below the physical window, then rebuild the
 * instruction prefix verbatim. We mirror that by capping the window used
 * for THRESHOLD MATH (not the window reported to providers): models whose
 * effective window exceeds the cap start compacting at
 * `cap − AUTOCOMPACT_BUFFER_TOKENS` instead of `W − 13k`. Models at or
 * under the cap (≤400k) are unaffected.
 *
 * Tunable via `POLE_COMPACT_PLANNING_WINDOW_CAP_TOKENS`; set `0` to
 * disable the cap and restore full-window thresholds.
 */
export const COMPACT_PLANNING_WINDOW_CAP_TOKENS = 400_000

function getCompactPlanningWindowCap(): number | undefined {
  const raw = process.env.POLE_COMPACT_PLANNING_WINDOW_CAP_TOKENS?.trim()
  if (raw === undefined || raw === '') return COMPACT_PLANNING_WINDOW_CAP_TOKENS
  const n = Number(raw)
  if (!Number.isFinite(n)) return COMPACT_PLANNING_WINDOW_CAP_TOKENS
  if (n <= 0) return undefined // explicit opt-out
  return Math.floor(n)
}

/**
 * Effective window for compaction-threshold derivation: the provider
 * window minus output reserve, capped at the compact-planning cap. Use
 * this (NOT {@link getEffectiveContextWindowTokens}) wherever the result
 * feeds `deriveContextThresholdsFromOpenClaudeWindow` or the collapse
 * drain gate, so the whole compaction ladder shares one planning window
 * and tier ordering (drain < auto < blocking) is preserved.
 */
export function getCompactPlanningWindowTokens(model: string): number {
  const eff = getEffectiveContextWindowTokens(model)
  const cap = getCompactPlanningWindowCap()
  return cap === undefined ? eff : Math.min(eff, cap)
}

/**
 * Token estimate at which the §6.1 pre-model chain drains queued collapse summaries into messages.
 * @param override — tests: use a low value to force drain without huge transcripts
 */
export function getContextCollapseDrainThresholdTokens(
  model: string,
  override?: number,
): number {
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
    return Math.max(1, Math.floor(override))
  }
  // Planning window (not raw effective window): keeps the drain gate BELOW
  // the capped auto-compact tier on 1M models — with the raw window the
  // drain would sit at ~882k while auto fires at ~387k, making drain dead.
  const eff = getCompactPlanningWindowTokens(model)
  return Math.max(1, Math.floor(eff * CONTEXT_COLLAPSE_FRAC_OF_EFFECTIVE_WINDOW))
}

/** Report §1.3 — default / cap for `max_tokens` negotiation heuristics. */
export const MAX_OUTPUT_TOKENS_DEFAULT = 32_000
export const MAX_OUTPUT_TOKENS_UPPER_LIMIT = 64_000

/** upstream §5.7 / §19 — meta user turns to continue after output-token truncation. */
export const MAX_OUTPUT_TOKENS_RECOVERY_ATTEMPTS = 3

/**
 * Report §2.2 `getModelMaxOutputTokens` — simplified id matching for gateway/model strings.
 */
export function getModelMaxOutputTokensBounds(model: string): {
  default: number
  upperLimit: number
} {
  const m = model.toLowerCase()
  if (m.includes('claude-3-opus') || m.includes('claude_3_opus')) {
    return { default: 4_000, upperLimit: 4_000 }
  }
  if (m.includes('opus-4-6') || m.includes('opus_4_6')) {
    return { default: 64_000, upperLimit: 128_000 }
  }
  if (m.includes('sonnet-4-6') || m.includes('sonnet_4_6')) {
    return { default: 32_000, upperLimit: 128_000 }
  }
  if (m.includes('opus-4-5') || m.includes('opus_4_5')) {
    return { default: 32_000, upperLimit: 64_000 }
  }
  if (m.includes('sonnet-4') || m.includes('haiku-4') || m.includes('haiku_4')) {
    return { default: 32_000, upperLimit: 64_000 }
  }
  if (m.includes('opus-4-1') || m.includes('opus_4_1')) {
    return { default: 32_000, upperLimit: 32_000 }
  }
  if (m.includes('opus-4') && !m.includes('opus-4-5') && !m.includes('opus-4-6')) {
    return { default: 32_000, upperLimit: 32_000 }
  }
  return { default: MAX_OUTPUT_TOKENS_DEFAULT, upperLimit: MAX_OUTPUT_TOKENS_UPPER_LIMIT }
}

/**
 * Map upstream-style effective window to our ContextThresholds ordering (warning < error < micro < auto < block).
 */
export function deriveContextThresholdsFromOpenClaudeWindow(effectiveWindow: number): {
  warningTokens: number
  errorTokens: number
  /** Sits between {@link errorTokens} and {@link microCompactTokens}. */
  historySnipTokens: number
  microCompactTokens: number
  autoCompactTokens: number
  blockingTokens: number
} {
  const W = effectiveWindow
  const errorTokens = Math.max(8_000, W - ERROR_WINDOW_DELTA)
  const microCompactTokens = Math.max(10_000, W - MICRO_COMPACT_WINDOW_DELTA)
  return {
    warningTokens: Math.max(4_000, W - WARNING_WINDOW_DELTA),
    errorTokens,
    historySnipTokens: Math.round((errorTokens + microCompactTokens) / 2),
    microCompactTokens,
    autoCompactTokens: Math.max(12_000, W - AUTOCOMPACT_BUFFER_TOKENS),
    blockingTokens: Math.max(16_000, W - MANUAL_COMPACT_BUFFER_TOKENS),
  }
}

/** Default idle before upstream-style “old tool result cleared” pass (§4.1.1 ~60 minutes). */
export const DEFAULT_IDLE_TOOL_CLEAR_MS = 60 * 60 * 1000

export function getIdleToolClearMs(): number {
  const v = envInt('CONTEXT_IDLE_TOOL_CLEAR_MS')
  if (v !== undefined) return v
  return DEFAULT_IDLE_TOOL_CLEAR_MS
}
