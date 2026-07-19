/**
 * Browser-mode `window.electronAPI` shim.
 *
 * In Electron, preload injects a rich `window.electronAPI`. In a phone/desktop
 * browser there is no preload, so we synthesize a compatible object that routes
 * the **chat-critical** surface to the desktop H5 server over REST + WebSocket,
 * and degrades every desktop-native capability (terminal, fs, git, lsp, …) to
 * a safe no-op. The existing renderer then runs unchanged on top of it.
 *
 * Scope (first version): send/cancel messages, receive the stream, reply to
 * permission / AskUserQuestion prompts, and list / load / save / delete /
 * rename conversations. Everything else returns empty/no-op so the renderer
 * boots and the chat flow works.
 */
import type { StreamEvent } from '../../types'
import type { SendAIMessageParams } from '../electronAPI'
import type { H5ConnectionInfo } from './h5Connection'
import { H5Transport } from './h5Transport'

/**
 * Default return value for an un-implemented desktop capability, chosen by the
 * method name so desktop-only panels degrade gracefully instead of crashing:
 *
 *   - a trailing function arg → treat as an event/handler registration and
 *     return a no-op unsubscribe (`onX(cb)`, `subscribeY(cb)`, …)
 *   - `list* / search* / getAll* / recent* / history*` → resolve `[]`
 *     (so callers that `.map()` / spread don't blow up on `undefined`)
 *   - everything else → resolve `{ success: false, error }`, the dominant
 *     IPC result shape (so `const { success } = await api.fs.x()` destructuring
 *     never throws on `undefined`)
 */
/**
 * A maximally-defensive "empty result": an empty array (so `.map`, `for..of`,
 * spread, `.length` all work) that ALSO answers the common IPC result fields
 * (`success: false`, `error`) and yields `undefined` for any other property.
 * This prevents the dominant browser-mode crash classes at once:
 *   - `(await api.x()).map(...)`        → [] (no "reading 'map' of undefined")
 *   - `const { success } = await api.x()` → false
 *   - `(await api.x()).items` / `.data`   → undefined (no throw)
 */
function emptyResult(): unknown {
  const arr: unknown[] = []
  return new Proxy(arr, {
    get(target, prop, receiver) {
      if (prop === 'then') return undefined
      if (prop === 'success') return false
      if (prop === 'error') return 'unavailable in browser (H5) mode'
      if (prop in target) return Reflect.get(target, prop, receiver)
      return undefined
    },
  })
}

function defaultForMethod(_name: string | undefined, args: unknown[]): unknown {
  const last = args[args.length - 1]
  if (typeof last === 'function') return () => {}
  return Promise.resolve(emptyResult())
}

/**
 * Universal no-op: callable AND deeply property-accessible. Supports
 * `api.someDomain.someMethod()`, `api.onSomething(cb)`, and nested access.
 * The most-recently-accessed property name drives {@link defaultForMethod}.
 */
function makeUniversalNoop(name?: string): unknown {
  const fn = (...args: unknown[]): unknown => defaultForMethod(name, args)
  return new Proxy(fn, {
    get(_t, prop) {
      if (prop === 'then') return undefined
      if (prop === Symbol.toPrimitive) return () => ''
      return makeUniversalNoop(typeof prop === 'string' ? prop : undefined)
    },
    apply(_t, _thisArg, args) {
      return defaultForMethod(name, args)
    },
  })
}

export function installBrowserElectronApiShim(info: H5ConnectionInfo): H5Transport {
  const transport = new H5Transport(info)

  const ai = {
    sendMessage: async (params: SendAIMessageParams): Promise<void> => {
      const conversationId = params.conversationId || 'default'
      transport.subscribe(conversationId)
      await transport.post('/api/chat/send', {
        conversationId,
        messages: params.messages,
        model: params.model,
        workspacePath: params.workspacePath,
        enableTools: params.enableTools ?? true,
        chatInteractionMode: params.chatInteractionMode,
        systemPrompt: params.systemPrompt,
        maxTokens: params.maxTokens,
      })
    },
    cancel: async (conversationId?: string): Promise<void> => {
      await transport.post('/api/chat/cancel', { conversationId })
    },
    onStreamEvent: (callback: (event: StreamEvent) => void): (() => void) =>
      transport.onStreamEvent(callback),
    respondPermissionRequest: async (params: {
      requestId: string
      behavior: 'allow' | 'deny'
      updatedInput?: Record<string, unknown>
    }): Promise<boolean> => {
      const r = await transport.post<{ ok: boolean }>('/api/permission/respond', params)
      return Boolean(r?.ok)
    },
    respondAskUserQuestion: async (params: {
      requestId: string
      answers: Record<string, string>
      conversationId?: string
    }): Promise<boolean> => {
      const r = await transport.post<{ ok: boolean }>('/api/ask/respond', params)
      return Boolean(r?.ok)
    },
    respondPlanApproval: async (): Promise<{ resolved: boolean }> => ({ resolved: false }),
    respondTeamPlanApproval: async (): Promise<{ resolved: boolean }> => ({ resolved: false }),
    teamPermissionReply: async (): Promise<boolean> => false,
    stopTask: async (): Promise<{ success: boolean }> => ({ success: false }),
    retryTask: async (): Promise<{ success: boolean }> => ({ success: false }),
    permissionRelayReply: async (): Promise<{ applied: boolean }> => ({ applied: false }),
    setDiffPermissionMode: async (mode: string) => ({ ok: true as const, mode }),
    onCronFire: () => () => {},
    runTeammate: async () => ({ runId: '' }),
    cancelTeammate: async () => ({ cancelled: false }),
    onTeammateStreamEvent: () => () => {},
  }

  const conversation = {
    save: async (params: {
      id: string
      messages: Record<string, unknown>[]
      workspacePath: string
      model?: string
      providerId?: string
    }): Promise<Record<string, unknown>> =>
      transport.post('/api/conversations/save', params),
    load: async (convId: string, workspacePath: string): Promise<Record<string, unknown>> =>
      transport.get(`/api/conversations/${encodeURIComponent(convId)}?workspacePath=${encodeURIComponent(workspacePath)}`),
    list: async (workspacePath: string): Promise<Record<string, unknown>[]> => {
      const r = await transport.get<{ conversations: Record<string, unknown>[] }>(
        `/api/conversations?workspacePath=${encodeURIComponent(workspacePath)}`,
      )
      return r?.conversations ?? []
    },
    delete: async (convId: string, workspacePath: string): Promise<{ success: boolean }> => {
      const r = await transport.post<{ ok: boolean }>(
        `/api/conversations/${encodeURIComponent(convId)}/delete`,
        { workspacePath },
      )
      return { success: Boolean(r?.ok) }
    },
    rename: async (convId: string, workspacePath: string, newTitle: string): Promise<Record<string, unknown>> => {
      await transport.post(`/api/conversations/${encodeURIComponent(convId)}/rename`, {
        workspacePath,
        title: newTitle,
      })
      return {}
    },
    search: async (): Promise<Record<string, unknown>[]> => [],
    autoTitle: async (): Promise<string> => '',
    setOrder: async (): Promise<{ success: boolean }> => ({ success: true }),
    resetThinkingClearLatch: async (): Promise<{ success: boolean }> => ({ success: true }),
  }

  const settings = {
    // Reflect the desktop's real settings (API configs / model / permissions),
    // with secrets masked server-side, so the phone isn't a blank user.
    get: async (): Promise<Record<string, unknown>> => {
      try {
        return await transport.get<Record<string, unknown>>('/api/settings')
      } catch {
        return {}
      }
    },
    set: async (next: Record<string, unknown>): Promise<void> => {
      try {
        await transport.post('/api/settings', next)
      } catch {
        /* best effort — phone settings edits are non-critical */
      }
    },
  }

  const realDomains: Record<string | symbol, unknown> = {
    platform: 'browser',
    ai,
    conversation,
    settings,
  }

  const shim = new Proxy(realDomains, {
    get(target, prop) {
      if (prop in target) return target[prop]
      if (prop === 'then') return undefined
      return makeUniversalNoop()
    },
  })

  const w = window as unknown as { electronAPI?: unknown; __H5_BROWSER_MODE__?: boolean }
  w.electronAPI = shim
  w.__H5_BROWSER_MODE__ = true
  try {
    document.documentElement.classList.add('h5-browser')
  } catch {
    /* ignore (non-DOM env) */
  }
  return transport
}
