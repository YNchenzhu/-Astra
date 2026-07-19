/**
 * upstream report §16.2 — per-query-chain identifiers on the transcript (internal keys stripped before API).
 */

import { randomUUID } from 'node:crypto'
import type { AgentContext } from './agentContext'
import type { QuerySource } from './querySource'
import { querySourceFromAgentId } from './querySource'
import { POLE_QUERY_TRACKING_KEY } from '../context/tokenUsageAccounting'

export { POLE_QUERY_TRACKING_KEY }

export type PoleQueryTracking = {
  chainId: string
  requestId: string
  source: QuerySource
}

export function generateQueryChainId(): string {
  return randomUUID()
}

/**
 * Walk from the newest message: return the latest `requestId` carried on a user turn (§16.2 concurrency).
 */
export function getPreviousRequestIdFromMessages(
  messages: Array<Record<string, unknown>>,
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user') continue
    const t = m[POLE_QUERY_TRACKING_KEY]
    if (t && typeof t === 'object' && typeof (t as PoleQueryTracking).requestId === 'string') {
      const id = (t as PoleQueryTracking).requestId.trim()
      if (id) return id
    }
  }
  return undefined
}

/**
 * Attach tracking metadata to the last user message (mutates that message object in-place).
 */
export function attachPoleQueryTrackingToTailUserMessage(
  messages: Array<Record<string, unknown>>,
  tracking: PoleQueryTracking,
): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      messages[i] = { ...messages[i], [POLE_QUERY_TRACKING_KEY]: tracking }
      return
    }
  }
}

export function resolveQuerySourceForContext(ctx: AgentContext | null | undefined): QuerySource {
  if (ctx?.querySource) return ctx.querySource
  return querySourceFromAgentId(ctx?.agentId)
}

/**
 * Build tracking for the next model request from current ALS context.
 */
export function buildPoleQueryTrackingForNextRequest(ctx: AgentContext | null | undefined): PoleQueryTracking {
  const chainId = ctx?.queryChainId?.trim() || generateQueryChainId()
  return {
    chainId,
    requestId: generateQueryChainId(),
    source: resolveQuerySourceForContext(ctx),
  }
}
