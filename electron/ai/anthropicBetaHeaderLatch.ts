/**
 * upstream 报告 §9.4 — 按会话锁存 `anthropic-beta`：某 beta 一旦在本会话用过，后续同会话请求合并进头（逗号分隔）。
 *
 * Opt-in: `POLE_ANTHROPIC_BETA_HEADER_LATCH=1`
 *  effort 锁存（首次带 output_config.effort 成功后）：`POLE_ANTHROPIC_LATCH_EFFORT_BETA=1`
 *  由 micro-compact 触发的 cache 相关 beta（用户配置名）：`POLE_ANTHROPIC_LATCHED_CACHE_EDITING_BETA`（逗号分隔多个 token）
 * §10.4 thinkingClearLatched：距上次成功 Anthropic 流结束超过 `POLE_ANTHROPIC_THINKING_CLEAR_IDLE_LATCH_MS`（默认 3600000）后锁存，
 *   后续同会话请求合并 `POLE_ANTHROPIC_LATCHED_THINKING_CLEAR_BETA`（须配置，逗号分隔）。
 */

import { EFFORT_BETA_HEADER } from '../constants/betas'

/** Must match Messages API docs for `output_config.effort`. */
export const ANTHROPIC_EFFORT_BETA_HEADER = EFFORT_BETA_HEADER

const effortLatchedConversations = new Set<string>()
const cacheEditingLatchedConversations = new Set<string>()
const thinkingClearLatchedConversations = new Set<string>()
/** Last successful `finalMessage()` time per conversation (ms since epoch). */
const lastAnthropicStreamSuccessEndMs = new Map<string, number>()

function latchEnabled(): boolean {
  return process.env.POLE_ANTHROPIC_BETA_HEADER_LATCH === '1'
}

function effortLatchArmEnabled(): boolean {
  return process.env.POLE_ANTHROPIC_LATCH_EFFORT_BETA === '1'
}

function normalizeConversationId(conversationId: string | undefined): string | undefined {
  const t = conversationId?.trim()
  return t || undefined
}

export function registerAnthropicEffortBetaLatch(conversationId: string | undefined): void {
  if (!latchEnabled() || !effortLatchArmEnabled()) return
  const cid = normalizeConversationId(conversationId)
  if (!cid) return
  effortLatchedConversations.add(cid)
}

/**
 * §9.3 配套：micro-compact 后把用户配置的 cache 相关 beta 记入会话，后续请求始终带上（需 LATCH=1）。
 */
export function registerLatchedCacheEditingBetasForConversation(conversationId: string | undefined): void {
  if (!latchEnabled()) return
  const cid = normalizeConversationId(conversationId)
  if (!cid) return
  const raw = process.env.POLE_ANTHROPIC_LATCHED_CACHE_EDITING_BETA?.trim()
  if (!raw) return
  cacheEditingLatchedConversations.add(cid)
}

function parseBetaHeaderValue(raw: string | undefined): string[] {
  if (!raw?.trim()) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function latchedCacheEditingTokensForConversation(conversationId: string | undefined): string[] {
  const cid = normalizeConversationId(conversationId)
  if (!cid || !cacheEditingLatchedConversations.has(cid)) return []
  return parseBetaHeaderValue(process.env.POLE_ANTHROPIC_LATCHED_CACHE_EDITING_BETA)
}

function thinkingClearIdleLatchMs(): number {
  const raw = process.env.POLE_ANTHROPIC_THINKING_CLEAR_IDLE_LATCH_MS
  if (raw === undefined || raw === '') return 3_600_000
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : 3_600_000
}

/**
 * 在组头前调用：若距上次成功流已超过 idle 阈值，则锁存 thinking-clear beta（报告 §10.4）。
 */
function refreshThinkingClearLatchFromIdle(conversationId: string | undefined): void {
  if (!latchEnabled()) return
  const betaEnv = process.env.POLE_ANTHROPIC_LATCHED_THINKING_CLEAR_BETA?.trim()
  if (!betaEnv) return
  const cid = normalizeConversationId(conversationId)
  if (!cid || thinkingClearLatchedConversations.has(cid)) return
  const last = lastAnthropicStreamSuccessEndMs.get(cid)
  if (last == null) return
  if (Date.now() - last >= thinkingClearIdleLatchMs()) {
    thinkingClearLatchedConversations.add(cid)
  }
}

function latchedThinkingClearTokensForConversation(conversationId: string | undefined): string[] {
  const cid = normalizeConversationId(conversationId)
  if (!cid || !thinkingClearLatchedConversations.has(cid)) return []
  return parseBetaHeaderValue(process.env.POLE_ANTHROPIC_LATCHED_THINKING_CLEAR_BETA)
}

/** 每次 Anthropic 流式 `finalMessage()` 成功后调用，供 idle latch 计算间隔。 */
export function recordAnthropicStreamSuccessForThinkingClearLatch(conversationId: string | undefined): void {
  if (!latchEnabled()) return
  const cid = normalizeConversationId(conversationId)
  if (!cid) return
  lastAnthropicStreamSuccessEndMs.set(cid, Date.now())
}

/**
 * 合并本请求需要的 beta 与会话已锁存的 beta，返回应传给 `messages.stream` 的 `headers` 片段（可能为空对象）。
 */
export function buildAnthropicStreamBetaHeaders(params: {
  conversationId: string | undefined
  /** 本请求显式需要的 token（如 effort） */
  requestBetaTokens?: string[]
}): Record<string, string> {
  const request = params.requestBetaTokens ?? []
  if (!latchEnabled()) {
    const only = [...new Set(request.filter(Boolean))]
    if (!only.length) return {}
    return { 'anthropic-beta': only.join(',') }
  }

  refreshThinkingClearLatchFromIdle(params.conversationId)

  const tokens = new Set<string>(request.filter(Boolean))
  const cid = normalizeConversationId(params.conversationId)
  if (cid && effortLatchedConversations.has(cid)) {
    tokens.add(ANTHROPIC_EFFORT_BETA_HEADER)
  }
  for (const t of latchedCacheEditingTokensForConversation(cid)) {
    tokens.add(t)
  }
  for (const t of latchedThinkingClearTokensForConversation(cid)) {
    tokens.add(t)
  }
  const ordered = [...tokens]
  if (!ordered.length) return {}
  return { 'anthropic-beta': ordered.join(',') }
}

export function resetAnthropicBetaHeaderLatchForTests(): void {
  effortLatchedConversations.clear()
  cacheEditingLatchedConversations.clear()
  thinkingClearLatchedConversations.clear()
  lastAnthropicStreamSuccessEndMs.clear()
}

/**
 * Drop all per-conversation latch state for {@link conversationId}.
 *
 * Called from {@link handleSendMessage}'s finally so beta-latch sets/maps do
 * not retain entries for conversations that have ended (closed tab,
 * unrecoverable error, app shutdown). Without this, the four module-level
 * structures grow once per conversation lifetime — invisible per-entry but
 * unbounded across long-running processes (server-mode / CI agents).
 *
 * Idempotent and safe to call for unknown ids — `Set.delete` /
 * `Map.delete` no-op when the key is absent.
 */
export function cleanupAnthropicBetaHeaderLatchForConversation(
  conversationId: string | undefined,
): void {
  const cid = normalizeConversationId(conversationId)
  if (!cid) return
  effortLatchedConversations.delete(cid)
  cacheEditingLatchedConversations.delete(cid)
  thinkingClearLatchedConversations.delete(cid)
  lastAnthropicStreamSuccessEndMs.delete(cid)
}
