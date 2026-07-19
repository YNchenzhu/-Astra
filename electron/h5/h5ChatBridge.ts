/**
 * H5 chat bridge — connects the remote HTTP/WS surface to the existing
 * in-process agentic chat loop.
 *
 * Design (see chat exploration notes): rather than re-implementing the agentic
 * loop, we reuse `handleSendMessage` exactly as the desktop renderer does. A
 * single global stream tap (`addStreamTap`) mirrors every main-chat
 * `StreamEvent` and fans it out to the WebSocket clients subscribed to the
 * matching `conversationId`. Remote clients therefore receive the same event
 * protocol the renderer's `mainStreamRouter` already understands.
 */
import type { WebSocket } from 'ws'
import { addStreamTap } from '../ai/streamHandlerRegistry'
import { handleSendMessage, cancelStream } from '../ai/streamHandler'
import type { StreamEvent } from '../ai/streamHandlerTypes'
import { getMainWindow } from '../window/mainWindow'
import { loadSettings } from '../settings/settingsStore'
import { acceptWorkspacePathFromRenderer } from '../security/workspaceAccept'
import { setWorkspacePath } from '../tools/workspaceState'

const DEFAULT_CONVERSATION = 'default'

/** conversationId → set of subscribed sockets. */
const subscribers = new Map<string, Set<WebSocket>>()
let tapDisposer: (() => void) | null = null

export function startH5ChatBridge(): void {
  if (tapDisposer) return
  tapDisposer = addStreamTap((event) => {
    const cid =
      typeof event?.conversationId === 'string' && event.conversationId.trim()
        ? event.conversationId.trim()
        : DEFAULT_CONVERSATION
    broadcast(cid, event)
  })
}

export function stopH5ChatBridge(): void {
  tapDisposer?.()
  tapDisposer = null
  subscribers.clear()
}

export function subscribe(conversationId: string | undefined, ws: WebSocket): void {
  const cid = conversationId?.trim() || DEFAULT_CONVERSATION
  let set = subscribers.get(cid)
  if (!set) {
    set = new Set()
    subscribers.set(cid, set)
  }
  set.add(ws)
}

export function unsubscribe(ws: WebSocket): void {
  for (const [cid, set] of subscribers) {
    set.delete(ws)
    if (set.size === 0) subscribers.delete(cid)
  }
}

function broadcast(conversationId: string, event: StreamEvent): void {
  const set = subscribers.get(conversationId)
  if (!set || set.size === 0) return
  const payload = JSON.stringify({ channel: 'ai:stream-event', event })
  for (const ws of set) {
    // 1 === WebSocket.OPEN; avoid importing the value just for the constant.
    if (ws.readyState === 1) {
      try {
        ws.send(payload)
      } catch {
        /* drop: a failing socket is cleaned up on close */
      }
    }
  }
}

export interface H5SendRequest {
  conversationId?: string
  messages: { role: 'user' | 'assistant'; content: string | unknown }[]
  model?: string
  workspacePath?: string
  enableTools?: boolean
  chatInteractionMode?: 'agent' | 'plan' | 'ask'
  systemPrompt?: string
  maxTokens?: number
}

/**
 * Kick off one chat turn for a remote client. Mirrors the merge precedence in
 * `aiHandlers.ts` (`ai:send-message`): renderer-supplied fields win, disk
 * settings fill the gaps for provider credentials.
 *
 * Resolves once `handleSendMessage` returns (turn complete). Streaming is
 * delivered out-of-band over the subscriber's WebSocket.
 */
interface ResolvedProvider {
  providerId: string
  model: string
  apiKey: string
  baseUrl: string
  awsRegion: string
  projectId: string
  maxTokens: number | undefined
}

/**
 * Resolve the effective provider + model + credentials the same way the
 * renderer's settings store does: an active saved API config wins; otherwise
 * fall back to the manual config. This is essential for IM/H5 chats which carry
 * no model of their own — picking it up from disk top-level only worked for
 * manual mode, leaving config-mode users with an empty model (provider 400).
 */
function resolveActiveProvider(settings: Record<string, unknown>): ResolvedProvider {
  const apiConfigs = Array.isArray(settings.apiConfigs)
    ? (settings.apiConfigs as Array<Record<string, unknown>>)
    : []
  const activeId = typeof settings.activeConfigId === 'string' ? settings.activeConfigId : null
  const active = activeId ? apiConfigs.find((c) => c.id === activeId) : undefined
  if (active) {
    return {
      providerId: (active.providerId as string) || 'anthropic',
      model: (active.model as string) || '',
      apiKey: (active.apiKey as string) || '',
      baseUrl: (active.baseUrl as string) || '',
      awsRegion: (active.awsRegion as string) || '',
      projectId: (active.projectId as string) || '',
      maxTokens: typeof active.maxTokens === 'number' ? active.maxTokens : undefined,
    }
  }
  const mc = (settings.manualConfig && typeof settings.manualConfig === 'object'
    ? (settings.manualConfig as Record<string, unknown>)
    : {}) as Record<string, unknown>
  return {
    providerId: (settings.manualProviderId as string) || (settings.providerId as string) || 'anthropic',
    model: (settings.manualModel as string) || (settings.model as string) || '',
    apiKey: (mc.apiKey as string) || (settings.apiKey as string) || '',
    baseUrl: (mc.baseUrl as string) || (settings.baseUrl as string) || '',
    awsRegion: (mc.awsRegion as string) || (settings.awsRegion as string) || '',
    projectId: (mc.projectId as string) || (settings.projectId as string) || '',
    maxTokens: typeof settings.manualMaxTokens === 'number' ? settings.manualMaxTokens : undefined,
  }
}

export async function startH5Chat(req: H5SendRequest): Promise<void> {
  const mainWindow = getMainWindow()
  if (!mainWindow) throw new Error('No window available')

  if (req.workspacePath) {
    const outcome = acceptWorkspacePathFromRenderer(req.workspacePath, { source: 'h5:send-message' })
    if (!outcome.ok) throw new Error(outcome.reason)
    if (outcome.effective) setWorkspacePath(outcome.effective)
  }

  const settings = loadSettings()
  const provider = resolveActiveProvider(settings)
  const merged = {
    messages: req.messages,
    // Prefer an explicit per-request model (H5 browser sends one); otherwise
    // use the SAME model the desktop resolves from its active config / manual
    // setup — without this WeChat sends an empty model and the provider 400s.
    model: req.model || provider.model,
    conversationId: req.conversationId?.trim() || DEFAULT_CONVERSATION,
    workspacePath: req.workspacePath,
    enableTools: req.enableTools ?? true,
    chatInteractionMode: req.chatInteractionMode,
    systemPrompt: req.systemPrompt,
    maxTokens: req.maxTokens || provider.maxTokens,
    providerId: provider.providerId,
    apiKey: provider.apiKey,
    baseUrl: provider.baseUrl,
    awsRegion: provider.awsRegion,
    projectId: provider.projectId,
    outputStyle: (settings.outputStyle as string) || 'default',
    language: (settings.language as string) ?? '',
  }

  await handleSendMessage(mainWindow, merged as Parameters<typeof handleSendMessage>[1])
}

export function cancelH5Chat(conversationId?: string): void {
  cancelStream(conversationId?.trim() || DEFAULT_CONVERSATION)
}
