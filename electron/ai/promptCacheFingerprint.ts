/**
 * upstream 上下文报告 §7.4 / §17.5 — prompt-cache signal fingerprint + optional break logging.
 */

import { createHash } from 'node:crypto'
import { getAgentContext } from '../agents/agentContext'
import type { SystemPromptLayers } from './systemPrompt'
import { toolRegistry } from '../tools/registry'

export function serializeSystemForFingerprint(
  systemPrompt: string | undefined,
  layers: SystemPromptLayers | undefined,
): string {
  if (layers && (layers.systemContext.trim() !== '' || layers.userContext.trim() !== '')) {
    return `L:${layers.systemContext.length}:${layers.userContext.length}:${layers.systemContext}\n---\n${layers.userContext}`
  }
  return systemPrompt ?? ''
}

export function buildPromptCacheFingerprint(input: {
  providerId: string
  model: string
  systemSerialized: string
  toolNames: string[]
}): string {
  const toolPart = `${toolRegistry.getToolsetRevision()}:${[...input.toolNames].sort().join('\n')}`
  const raw = [input.providerId, input.model, input.systemSerialized, toolPart].join('\0')
  return createHash('sha256').update(raw).digest('hex')
}

/**
 * When `POLE_PROMPT_CACHE_BREAK_LOG=1`, logs once per ALS context when the fingerprint changes
 * (system / tool surface / model / provider).
 */
export function logPromptCacheBreakIfChanged(fingerprint: string): void {
  if (process.env.POLE_PROMPT_CACHE_BREAK_LOG !== '1') return
  const ctx = getAgentContext()
  if (!ctx) return
  const prev = ctx.promptCacheFingerprintLast
  if (prev !== undefined && prev !== fingerprint) {
    console.info(
      `[PromptCache][CTX-7.4] break conv=${ctx.streamConversationId ?? '?'} agent=${ctx.agentId} ${prev.slice(0, 12)}… → ${fingerprint.slice(0, 12)}…`,
    )
  }
  ctx.promptCacheFingerprintLast = fingerprint
}
