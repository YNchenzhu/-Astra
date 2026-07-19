/**
 * Renderer-side IPC bridge for conversation persistence.
 *
 * All return types here piggy-back on the `ConversationMeta` /
 * `ConversationSearchResult` shapes declared for `window.electronAPI`
 * in `src/types/index.ts`, so the renderer sees the same contract as
 * the main process.
 */

import type { ConversationMeta, ConversationSearchResult, TodoItem } from '../types'

/** Full conversation payload returned by `conversation:load`. Kept wide
 *  on `todos` and extended with `compactSummary` because renderer callers
 *  persist more fields than the preload declaration narrowed to. */
export interface ConversationData {
  meta: ConversationMeta
  messages: Array<{ role: string; content: string; id?: string; timestamp?: number }>
  todos?: TodoItem[]
  compactSummary?: string
}

/** Chat-message shape accepted by `conversation:save`. */
export type PersistedMessage = Record<string, unknown> & { role: string; content: string }

/** Todo shape accepted by `conversation:save`. The renderer's `TodoItem`
 *  carries an `activeForm` field and optional source/owner/summary that
 *  main-process persistence round-trips verbatim, so we accept any
 *  object with at least `{ content, status }`. */
export type PersistedTodo = Record<string, unknown> & { content: string; status: string }

function getAPI() {
  return typeof window !== 'undefined' && window.electronAPI
    ? window.electronAPI
    : null
}

/**
 * Throw when the preload `electronAPI` bridge is missing. Replaces the old
 * `if (!api) return null/[]/false` pattern that silently conflated "preload
 * broken" with legitimate "no conversations / not found". Upstream callers
 * (store actions, panels) now see a real Error they can route through
 * `reportUserActionError`. Keep the thrown message prefixed with the origin
 * so the user sees which action specifically failed.
 */
function requireAPI(origin: string) {
  const api = getAPI()
  if (!api) {
    throw new Error(
      `${origin}: window.electronAPI is not available (preload bridge missing).`,
    )
  }
  return api
}

export async function saveConversation(params: {
  id: string
  messages: PersistedMessage[]
  workspacePath: string
  model?: string
  providerId?: string
  todos?: PersistedTodo[]
  compactSummary?: string
  /** Plan §4.5.4: per-bundle conversation partitioning. Undefined maps
   *  to 'code-dev' on the main side (zero-migration default). */
  bundleId?: string
}): Promise<ConversationMeta | null> {
  const api = requireAPI('saveConversation')
  // The preload IPC signature declares narrower message / todo shapes
  // than what the renderer actually persists (renderer fields are
  // serialized verbatim by Electron). Cast at this single call boundary
  // so the service API can stay permissive for callers.
  return api.conversation.save(
    params as unknown as Parameters<typeof api.conversation.save>[0],
  )
}

export async function loadConversation(
  convId: string,
  workspacePath: string,
  bundleId?: string,
): Promise<ConversationData | null> {
  const api = requireAPI('loadConversation')
  // Main-process payload can carry extra fields (`compactSummary`, richer
  // todos) that the preload declaration trims; re-widen here.
  return (await api.conversation.load(convId, workspacePath, bundleId)) as ConversationData | null
}

export async function listConversations(
  workspacePath: string,
  bundleId?: string,
): Promise<ConversationMeta[]> {
  const api = requireAPI('listConversations')
  return api.conversation.list(workspacePath, bundleId)
}

export async function deleteConversation(
  convId: string,
  workspacePath: string,
  bundleId?: string,
): Promise<boolean> {
  const api = requireAPI('deleteConversation')
  // IPC 层:只关心能不能通,不能通才抛错。磁盘上找不到文件是合法状态
  // (刚新建、还没 message_stop 持久化的会话就是这样),调用方自己决定
  // 是否要把它当失败。以前这里在 success=false 时抛 —— 结果新会话的
  // 删除按钮根本跑不到状态清理那一行。
  const result = await api.conversation.delete(convId, workspacePath, bundleId)
  return result.success
}

export async function renameConversation(
  convId: string,
  workspacePath: string,
  newTitle: string,
  bundleId?: string,
): Promise<{ success: boolean } | null> {
  const api = requireAPI('renameConversation')
  return api.conversation.rename(convId, workspacePath, newTitle, bundleId)
}

export async function searchConversations(
  query: string,
  workspacePath?: string,
  bundleId?: string,
): Promise<ConversationSearchResult[]> {
  const api = requireAPI('searchConversations')
  return api.conversation.search(query, workspacePath, bundleId)
}

export async function autoTitle(
  convId: string,
  workspacePath: string,
  bundleId?: string,
): Promise<string> {
  const api = requireAPI('autoTitle')
  return api.conversation.autoTitle(convId, workspacePath, bundleId)
}

export async function setConversationOrder(
  workspacePath: string,
  orderedIds: string[],
  bundleId?: string,
): Promise<boolean> {
  const api = requireAPI('setConversationOrder')
  if (!api.conversation?.setOrder) {
    throw new Error(
      'setConversationOrder: api.conversation.setOrder is not available (preload bridge outdated).',
    )
  }
  const r = await api.conversation.setOrder(workspacePath, orderedIds, bundleId)
  return Boolean(r?.success)
}

/**
 * §10.4 — 复位 main 进程内该会话的 thinking-clear latch。
 *
 * Renderer 在 startNewConversation / clearConversationContext 后 fire-and-forget
 * 调用：让下一轮 agentic 请求重新评估 1h-idle 条件而不是携带 latch 旧状态。
 *
 * 静默降级：
 *   - main 进程旧版本没注册该 handler → 可选链返回 undefined，函数返回 false 不抛
 *   - handler 内部错 → main 端已经吞掉返回 success:false，本函数同样返回 false
 * 最坏情况下 latch 多保留一段时间，下一次 idle 评估时自然滚动 — 不影响聊天流。
 */
export async function resetThinkingClearLatch(
  conversationId: string,
): Promise<boolean> {
  if (!conversationId || !conversationId.trim()) return false
  const w = typeof window !== 'undefined' ? window : undefined
  const api = w?.electronAPI
  if (!api?.conversation?.resetThinkingClearLatch) return false
  try {
    const r = await api.conversation.resetThinkingClearLatch(conversationId)
    return Boolean(r?.success)
  } catch {
    return false
  }
}

// ========== Export (pure frontend, no IPC needed) ==========

/**
 * Format a conversation as Markdown for download.
 */
export function formatAsMarkdown(params: {
  title: string
  messages: Array<{
    role: 'user' | 'assistant'
    content: string
    timestamp: number
    toolUses?: Array<{ name: string; status: string }>
  }>
}): string {
  const { title, messages } = params
  const createdAt = messages[0]?.timestamp ?? Date.now()
  const date = new Date(createdAt).toLocaleString()

  const lines: string[] = [
    `# ${title}`,
    `> ${date} · ${messages.length} 条消息`,
    '',
  ]

  for (const msg of messages) {
    const role = msg.role === 'user' ? 'You' : '星构Astra'
    const time = new Date(msg.timestamp).toLocaleTimeString()

    lines.push(`## ${role} — ${time}`)
    lines.push('')

    if (msg.content) {
      lines.push(msg.content)
      lines.push('')
    }

    if (msg.toolUses && msg.toolUses.length > 0) {
      for (const tool of msg.toolUses) {
        const icon = tool.status === 'completed' ? '✓' : tool.status === 'error' ? '✗' : '…'
        lines.push(`> ${icon} Used \`${tool.name}\` tool`)
      }
      lines.push('')
    }

    lines.push('---')
    lines.push('')
  }

  return lines.join('\n')
}

/**
 * Trigger download of a Markdown string as a .md file.
 */
export function downloadMarkdown(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
