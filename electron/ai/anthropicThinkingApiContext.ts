/**
 * Anthropic API-side thinking-context controls — the **server-side** family of
 * mechanisms that reduce historical thinking's impact on the model, mirroring
 * upstream's architecture (see `src/services/compact/apiMicrocompact.ts` and
 * `src/utils/betas.ts` in that codebase).
 *
 * Why this lives in its own module:
 *   The existing in-tree pieces (`anthropicExtendedThinking.ts`,
 *   `anthropicBetaHeaderLatch.ts`, `anthropicThinkingTranscript.ts`) each
 *   tackle one slice of the thinking problem (request `thinking` field,
 *   per-conversation upstream latch, transcript signature/strip rules).
 *   This module owns the FOUR upstream-style "let the API do the work"
 *   strategies that all three legacy modules deliberately do NOT touch:
 *
 *     • REDACT_THINKING_BETA_HEADER  ← API returns `redacted_thinking`
 *                                      blocks instead of raw `thinking`,
 *                                      so the client never persists
 *                                      raw chain-of-thought and the
 *                                      next-turn echo can't anchor the
 *                                      model with its own past reasoning.
 *     • CONTEXT_MANAGEMENT_BETA + clear_thinking_20251015
 *                                    ← server-side strategy that prunes
 *                                      historical thinking blocks based
 *                                      on the kept-turns count, decided
 *                                      by Anthropic with full request
 *                                      visibility (which we don't have).
 *     • INTERLEAVED_THINKING_BETA    ← lets the model emit fresh
 *                                      thinking BETWEEN tool_use blocks
 *                                      so it isn't stuck inside its own
 *                                      pre-tool reasoning trajectory.
 *     • adaptive thinking            ← already implemented in
 *                                      `anthropicExtendedThinking.ts`;
 *                                      noted here for completeness.
 *
 * Scope: **Anthropic-official only** (`provider.id === 'anthropic'` with
 * `quirks.supportsBetaHeaders === true`). Bedrock / Vertex / Foundry would
 * need to ride these via `extra_body` / `additionalModelRequestFields`,
 * which is provider-specific plumbing left for a follow-up. Third-party
 * Anthropic-compat gateways (DeepSeek / Zhipu / Kimi / DashScope / MiniMax)
 * don't honour `anthropic-beta` at all and are gated out at the call site.
 */

import {
  CONTEXT_MANAGEMENT_BETA_HEADER,
  INTERLEAVED_THINKING_BETA_HEADER,
  REDACT_THINKING_BETA_HEADER,
} from '../constants/betas'
import { readDiskSettings } from '../settings/settingsAccess'

// ─── Sticky thinking-clear latch (upstream §1h-idle pattern) ──────────────────
//
// Independent of `anthropicBetaHeaderLatch.ts` (which is upstream §10.4
// env-driven). upstream latches `clearAllThinking` after >1h since last
// successful API completion (cache miss confirmed → no benefit to keeping
// historical thinking) and KEEPS it latched on so a flip-back wouldn't
// bust the newly-warmed cache.

/** Default 1 hour, matches `CACHE_TTL_1HOUR_MS` in upstream. */
const THINKING_CLEAR_IDLE_MS = 60 * 60 * 1000
/**
 * Per-conversation last-success timestamp. Set after every successful
 * `messages.stream` finalisation; read by `getAnthropicThinkingApiContext`.
 */
const lastStreamSuccessMs = new Map<string, number>()
/**
 * Per-conversation sticky latch: once a >1h-idle agentic call flipped this
 * to `true`, all subsequent calls on the SAME conversation use the
 * tightened `keep: { type: 'thinking_turns', value: 1 }` strategy. Sticky
 * because flipping back to `keep: 'all'` would invalidate the cache that
 * was just warmed under the tighter setting.
 */
const clearAllThinkingLatched = new Set<string>()

/**
 * Record successful stream end so the next call's latch evaluation can see
 * the new gap. Independent of upstream latch (which is env-gated); this
 * one runs unconditionally for the upstream-style behaviour.
 *
 * `isMainAgent` MUST be true for sub-agent streams to be filtered out:
 * sub-agents inherit the parent's `streamConversationId` (see
 * `subAgentRunner.ts` — `parentContext?.streamConversationId`), so a
 * naive write here from EVERY stream success would have a long-running
 * sub-agent's mid-task completions perpetually refresh the parent's
 * idle timestamp and prevent the >1h-idle latch from ever flipping for
 * the parent. Only top-level main-agent stream completions actually
 * represent "the user paused" and so should bump the timestamp.
 */
export function recordAnthropicThinkingStreamSuccess(
  conversationId: string | undefined,
  isMainAgent: boolean,
): void {
  if (!isMainAgent) return
  const cid = conversationId?.trim()
  if (!cid) return
  lastStreamSuccessMs.set(cid, Date.now())
}

/**
 * Once latched, sticky on. Caller decides whether to evaluate this turn
 * (see {@link getAnthropicThinkingApiContext}). Exposed mainly for tests;
 * production callers go through the bundled-context API.
 */
export function isClearAllThinkingLatched(
  conversationId: string | undefined,
): boolean {
  const cid = conversationId?.trim()
  if (!cid) return false
  return clearAllThinkingLatched.has(cid)
}

/** Drop per-conversation latch state (called from the conversation cleanup path). */
export function cleanupAnthropicThinkingApiContextForConversation(
  conversationId: string | undefined,
): void {
  const cid = conversationId?.trim()
  if (!cid) return
  lastStreamSuccessMs.delete(cid)
  clearAllThinkingLatched.delete(cid)
}

/**
 * Reset ONLY the thinking-clear latch for a conversation — keep
 * {@link lastStreamSuccessMs} intact so the next idle evaluation can still
 * fire naturally on its own clock.
 *
 * Called after the user explicitly clears context (`/clear` equivalent —
 * `startNewConversation` / `clearConversationContext`) or after a successful
 * `autoCompact` completes: in both cases the historical thinking has already
 * been folded away, so the next agentic call should re-evaluate the
 * >1h-idle condition fresh rather than carrying over the latched state.
 *
 * Distinct from {@link cleanupAnthropicThinkingApiContextForConversation}:
 * cleanup is per-conversation TEARDOWN (deletes BOTH the latch AND the
 * last-success timestamp; called when a conversation is permanently
 * abandoned). reset-only is per-conversation REFRESH (drops only the latch
 * flag; called mid-conversation after compaction).
 *
 * 对齐 upstream-main `src/bootstrap/state.ts:1764-1773` 的 resetBetaHeaderLatches
 * 在 /clear /compact 时复位的设计。
 */
export function resetThinkingClearLatchOnly(
  conversationId: string | undefined,
): void {
  const cid = conversationId?.trim()
  if (!cid) return
  clearAllThinkingLatched.delete(cid)
  // NOTE: deliberately do NOT touch lastStreamSuccessMs — that's a real
  // timestamp of a real wire event, and the next idle latch evaluation
  // (>1h since last success) should still see it.
}

export function resetAnthropicThinkingApiContextForTests(): void {
  lastStreamSuccessMs.clear()
  clearAllThinkingLatched.clear()
}

// ─── Capability heuristics (per-model gating) ───────────────────────────────

/** One-shot log dedupe for {@link modelSupportsRedactAndInterleaved} misses. */
const loggedBetaUnsupportedModels = new Set<string>()

/**
 * Inline-side-prompt support — the model family that supports interleaved
 * thinking and the redact-thinking beta. upstream's `modelSupportsISP`
 * equivalent: Claude 4+ family + Claude 3.7 Sonnet support both betas.
 *
 * Older Claude 3.5 models pre-date the betas; 3rd-party gateways are
 * gated upstream so this only sees real Anthropic model ids.
 *
 * P3 audit fix (2026-07) — forward-compatible generation matching. The
 * previous exact-substring whitelist (`claude-opus-4` / `claude-sonnet-4` /
 * `claude-haiku-4`) silently returned `false` for any future naming
 * (`claude-sonnet-5`, `claude-5-opus`, …), turning off all three thinking
 * betas with no signal. Now any Claude family id whose generation number is
 * ≥ 4 matches — in either naming order, with or without a `us.anthropic.`
 * style namespace prefix — and an unmatched Anthropic model logs a one-shot
 * warn so the gap is visible instead of silent.
 */
function modelSupportsRedactAndInterleaved(model: string): boolean {
  const m = model.toLowerCase()
  // Claude 3.7 Sonnet — extended thinking GA, both betas valid.
  if (m.includes('claude-3-7') || m.includes('claude-3.7') || m.includes('3-7-sonnet')) {
    return true
  }
  // Generation-number match: `claude-<family>-<N>…` (claude-opus-4-6,
  // anthropic.claude-haiku-4-5, claude-sonnet-5) or `claude-<N>-<family>…`
  // (claude-4-sonnet). Generation N ≥ 4 supports both betas.
  const gen =
    m.match(/claude[-_.](?:opus|sonnet|haiku)[-_.](\d+)/) ??
    m.match(/claude[-_.](\d+)[-_.](?:opus|sonnet|haiku)/)
  if (gen) {
    const n = Number.parseInt(gen[1], 10)
    if (Number.isFinite(n) && n >= 4) return true
  }
  if (!loggedBetaUnsupportedModels.has(m)) {
    loggedBetaUnsupportedModels.add(m)
    console.warn(
      `[AnthropicThinkingApiContext] model "${model}" did not match the ` +
        'thinking-beta capability gate — interleaved/redact/clear_thinking ' +
        'betas disabled for this model. If this is a Claude 4+ model with an ' +
        'unrecognised id shape, extend modelSupportsRedactAndInterleaved.',
    )
  }
  return false
}

/** Read-through user setting: "show thinking summaries" disables redaction. */
function userWantsThinkingVisible(): boolean {
  try {
    const s = readDiskSettings() as { showThinkingSummaries?: unknown }
    return s.showThinkingSummaries === true
  } catch {
    // Settings not available (e.g. test env, very early boot). Default to
    // the privacy-leaning side: redact. The renderer's `<ThinkingBlock>`
    // gracefully renders an `AssistantRedactedThinkingMessage`-equivalent
    // when the wire returns redacted blocks.
    return false
  }
}

/**
 * REDACT_THINKING — Plan Phase 4 已经把端到端 4 条 pipeline 全部打通：
 *
 *   1. **Provider stream callbacks** (`providers/anthropic.ts`,
 *      `anthropicCompatHttp.ts`) — 双路径都已 listen
 *      `redacted_thinking` content_block_start 并发出
 *      `onRedactedThinkingBlock` callback (Plan §4.2)。
 *   2. **`ContentBlock` union** in `src/types/tool.ts` — 加了
 *      `{ type: 'redacted_thinking'; data: string; ... }` 变体 (Plan §4.1)。
 *   3. **`chatMessageToAgentApiRows`** in `src/services/contextBuilder.ts` —
 *      回灌分支 `if (b.type === 'redacted_thinking') {...}` 已落地，
 *      下一轮把 data blob 原样发回给 Anthropic 保 trajectory 连续
 *      (Plan §4.4)。
 *   4. **`<RedactedThinkingBlock>`** in
 *      `src/components/AIChat/RedactedThinkingBlock.tsx` — 不可展开的
 *      "✻ Thinking (私密推理已加密)" 占位组件 + CSS；ChatMessage 在
 *      block 类型分发处加了对应 case (Plan §4.3)。
 *
 * 默认开启 — 这是消除"主模型读到自己旧 thinking → 基于过时思考的
 * 幻觉"链路的根本性防护，与 upstream-main 默认配置一致。
 * 通过 `POLE_ANTHROPIC_REDACT_THINKING=0` 显式关闭（应急 / 调试场景，
 * 例如怀疑加密 blob 在某条新 provider 路径上 round-trip 不成功）。
 */
function isRedactThinkingEndToEndReady(): boolean {
  return process.env.POLE_ANTHROPIC_REDACT_THINKING !== '0'
}

// ─── Context-management strategy shapes (mirrors Anthropic API spec) ─────────

export type AnthropicThinkingApiContextEdit = {
  type: 'clear_thinking_20251015'
  keep: { type: 'thinking_turns'; value: number } | 'all'
}

export type AnthropicThinkingApiContextManagement = {
  edits: AnthropicThinkingApiContextEdit[]
}

export interface AnthropicThinkingApiContextResult {
  /**
   * Beta tokens to merge into the request's `anthropic-beta` header.
   * Always returns a fresh array; caller may push more / sort / dedupe.
   */
  extraBetas: string[]
  /**
   * `context_management` field to set on the request body. Undefined when
   * no strategy applies (no historical thinking + interleaved-only path).
   */
  contextManagement?: AnthropicThinkingApiContextManagement
  /**
   * True when REDACT_THINKING beta was added — the caller can use this to
   * skip downstream signature plumbing or change UI affordances.
   */
  isRedactThinkingActive: boolean
}

export interface AnthropicThinkingApiContextOptions {
  /** True when this turn opted into `output_config.effort` / `thinking`. */
  hasThinkingActiveOnRequest: boolean
  /** Resolved provider+model id; used for capability gating. */
  model: string
  /** Stream conversation id from the agent context — drives the idle latch. */
  conversationId: string | undefined
  /**
   * True when the current run is a top-level agentic query (not a
   * classifier / side-query). upstream only flips the latch from agentic
   * queries to avoid a one-shot classifier mid-turn flipping the main
   * thread's `context_management` config and busting the cache.
   */
  isAgenticQuery: boolean
  /**
   * Caller can force-disable the interleaved beta (e.g. test env or
   * `DISABLE_INTERLEAVED_THINKING` opt-out). Defaults to enabled when the
   * model supports it.
   */
  disableInterleaved?: boolean
}

/**
 * Compute beta tokens + `context_management` body field for an Anthropic
 * official request. Caller is responsible for:
 *   • only invoking this when `quirks.supportsBetaHeaders === true`
 *   • merging `extraBetas` into the eventual `anthropic-beta` header
 *   • setting `requestParams.context_management` from the result
 *   • calling {@link recordAnthropicThinkingStreamSuccess} after the
 *     stream's `finalMessage()` resolves
 *
 * Idempotent and stateless aside from the one-direction (off → on) latch
 * mutation under the >1h-idle condition. Safe to call once per request.
 */
export function getAnthropicThinkingApiContext(
  options: AnthropicThinkingApiContextOptions,
): AnthropicThinkingApiContextResult {
  const extraBetas: string[] = []
  const supportsBoth = modelSupportsRedactAndInterleaved(options.model)

  // ── P3: INTERLEAVED_THINKING ─────────────────────────────────────────
  // Doesn't depend on `hasThinkingActiveOnRequest` — interleaved is
  // exclusively about the model's ability to think between tool_use
  // blocks IF/WHEN it decides to think. Sending the beta with thinking
  // off is harmless (no-op server-side).
  if (supportsBoth && options.disableInterleaved !== true) {
    extraBetas.push(INTERLEAVED_THINKING_BETA_HEADER)
  }

  // ── P1: REDACT_THINKING ──────────────────────────────────────────────
  // Only useful when this turn is going to PRODUCE thinking (otherwise
  // there's nothing to redact). User opt-out via `showThinkingSummaries`.
  // Additionally gated behind {@link isRedactThinkingEndToEndReady} —
  // default ON since Plan Phase 4 wired all four pipeline legs (provider
  // callbacks / ContentBlock union / replay branch / renderer placeholder;
  // see that function's docstring). Emergency opt-out via
  // `POLE_ANTHROPIC_REDACT_THINKING=0`.
  let isRedactThinkingActive = false
  if (
    supportsBoth &&
    options.hasThinkingActiveOnRequest &&
    !userWantsThinkingVisible() &&
    isRedactThinkingEndToEndReady()
  ) {
    extraBetas.push(REDACT_THINKING_BETA_HEADER)
    isRedactThinkingActive = true
  }

  // ── P2: CONTEXT_MANAGEMENT + clear_thinking_20251015 ─────────────────
  // Skip when redact-thinking is already active — redacted blocks have no
  // model-visible content for clear_thinking to operate on, and upstream
  // documents the same skip in `apiMicrocompact.ts:82`. We need both to
  // (a) have thinking active this turn AND (b) the model support gate.
  let contextManagement: AnthropicThinkingApiContextManagement | undefined
  if (
    supportsBoth &&
    options.hasThinkingActiveOnRequest &&
    !isRedactThinkingActive
  ) {
    extraBetas.push(CONTEXT_MANAGEMENT_BETA_HEADER)

    // Idle-latch evaluation: only agentic queries flip the latch (a
    // classifier mid-turn shouldn't change the main thread's policy).
    const cid = options.conversationId?.trim()
    if (cid && options.isAgenticQuery && !clearAllThinkingLatched.has(cid)) {
      const last = lastStreamSuccessMs.get(cid)
      if (last != null && Date.now() - last > THINKING_CLEAR_IDLE_MS) {
        clearAllThinkingLatched.add(cid)
      }
    }

    const useTighten = cid ? clearAllThinkingLatched.has(cid) : false
    contextManagement = {
      edits: [
        {
          type: 'clear_thinking_20251015',
          // `keep: 'all'` is the API default — we send it explicitly so the
          // wire shape stays consistent across requests, which keeps the
          // prompt cache stable when the latch flips. The latch path uses
          // the tightened keep-1-turn variant.
          keep: useTighten ? { type: 'thinking_turns', value: 1 } : 'all',
        },
      ],
    }
  }

  return { extraBetas, contextManagement, isRedactThinkingActive }
}
