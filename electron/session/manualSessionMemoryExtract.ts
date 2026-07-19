/**
 * upstream §3.5 — manual session memory extract (`/summary` equivalent), bypassing token gates.
 */

import { mergeSystemPromptLayers } from '../ai/systemPrompt'
import type { AgentContext } from '../agents/agentContext'
import { providerConfigFromDisk } from '../memory/autoExtract'
import { getWorkspacePath } from '../tools/workspaceState'
import { asAgentId } from '../tools/ids'
import { ensureSessionMemoryTree, getSessionMemoryMarkdownPath } from './sessionMemoryPaths'
import { manuallyExtractSessionMemory } from './sessionMemoryExtract'

function buildMinimalAgentContext(params: {
  messages: Array<Record<string, unknown>>
  conversationId: string
}): AgentContext | null {
  const disk = providerConfigFromDisk()
  if (!disk) return null
  const ac = new AbortController()
  const systemPrompt = mergeSystemPromptLayers(
    'You are the main chat host. Forked session-memory runs inherit this context.',
    '',
  )
  return {
    config: disk.config,
    model: disk.model,
    systemPrompt,
    messages: params.messages,
    signal: ac.signal,
    agentId: asAgentId('main'),
    streamConversationId: params.conversationId,
  }
}

export async function runManualSessionMemoryExtractFromMessages(params: {
  conversationId: string
  messages: Array<Record<string, unknown>>
}): Promise<{ ok: boolean; error?: string }> {
  const id = params.conversationId?.trim()
  if (!id) return { ok: false, error: 'missing conversationId' }

  const ctx = buildMinimalAgentContext({
    conversationId: id,
    messages: params.messages,
  })
  if (!ctx) {
    return { ok: false, error: 'AI credentials unavailable' }
  }

  try {
    await manuallyExtractSessionMemory({
      conversationId: id,
      parentSnapshot: ctx,
    })
    return { ok: true }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

export async function ensureManualSessionMemoryPaths(): Promise<void> {
  await ensureSessionMemoryTree(getWorkspacePath())
}

export function getManualSessionMemoryTargetPath(conversationId: string): string {
  return getSessionMemoryMarkdownPath(conversationId, getWorkspacePath())
}
