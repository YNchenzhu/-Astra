/**
 * upstream 报告 §9.3 — micro-compact 后提示缓存“待处理”行为（不实现服务端 cache_edits 载荷，仅客户端状态）：
 * - 下一笔 Anthropic 消息级 cache 请求使用一次 fork 式断点（second-to-last），便于与 §9.1 对齐。
 *
 * Opt-in: `POLE_ANTHROPIC_CACHED_MICROCOMPACT=1`（需同时开启 `POLE_ANTHROPIC_MESSAGE_CACHE_CONTROL=1` 才有 wire 效果）
 */

import { registerLatchedCacheEditingBetasForConversation } from '../ai/anthropicBetaHeaderLatch'
import { getAgentContext } from '../agents/agentContext'
import { isMainThreadAgentForCompact } from '../agents/postCompactCleanup'

const pendingForkShiftOnce = new Set<string>()

function normalizeConversationId(conversationId: string | undefined): string | undefined {
  const t = conversationId?.trim()
  return t || undefined
}

/**
 * 在任意 micro-compact 应用后调用（ContextManager / reactive 兜底路径）。
 */
export function signalMicroCompactForPromptCache(conversationId: string | undefined): void {
  if (process.env.POLE_ANTHROPIC_CACHED_MICROCOMPACT !== '1') return
  if (!isMainThreadAgentForCompact(getAgentContext())) return
  const cid = normalizeConversationId(conversationId)
  if (!cid) return
  pendingForkShiftOnce.add(cid)
  registerLatchedCacheEditingBetasForConversation(cid)
}

/**
 * 下一笔 stream 消费：若存在 pending，则本回合 `secondToLastBreakpoint` 应为 true（在 `messages.length >= 2` 时生效）。
 */
export function consumeMicroCompactMessageCacheForkShiftOnce(conversationId: string | undefined): boolean {
  if (process.env.POLE_ANTHROPIC_CACHED_MICROCOMPACT !== '1') return false
  const cid = normalizeConversationId(conversationId)
  if (!cid || !pendingForkShiftOnce.has(cid)) return false
  pendingForkShiftOnce.delete(cid)
  return true
}

export function resetCachedMicrocompactPromptCacheForTests(): void {
  pendingForkShiftOnce.clear()
}
