/**
 * E2E test hooks — mounts `window.__e2e*` injection helpers used by the
 * Playwright Electron tests in `e2e/`.
 *
 * **Lifecycle**
 *   - This file is only imported when the renderer is built with
 *     `VITE_E2E_HOOKS=1` (see `src/main.tsx`). It is tree-shaken out of
 *     dev / production builds so neither the global namespace nor the
 *     bundle size is affected outside of E2E runs.
 *
 * **Why a single file**
 *   - Centralizes the production ↔ test seam so source components stay
 *     ignorant of E2E concerns. Components only need (sparingly) added
 *     `data-testid` attributes; all mock data flows through this file.
 *
 * **Convention**
 *   - Each `__e2eInject*` function is a pure side-effecting writer onto a
 *     specific Zustand store (chat, running-agents, etc). Tests must call
 *     `__e2eClearAll()` between cases to keep state isolated.
 */

import { useChatStore } from '../stores/useChatStore'
import type {
  ChatMessage,
  SubAgentDisplay,
  ToolUseDisplay,
  SubAgentStructuredSummary,
} from '../types/tool'

declare global {
  interface Window {
    /** Inject N sub-agents into a single fake assistant message. (U-1, U-7, U-12, U-18) */
    __e2eInjectSubAgents?: (subAgents: ReadonlyArray<E2ESubAgentInput>) => void
    /**
     * Inject a single fake assistant message that mixes top-level text, a
     * thinking block, and one sub-agent. Drives U-03 (混合 ChatMessage
     * key 稳定性).
     */
    __e2eInjectMixedMessage?: () => void
    /**
     * Convenience over {@link __e2eInjectSubAgents} for U-04: a single
     * sub-agent whose `description` is the long string passed in.
     */
    __e2eInjectSubAgentWithDesc?: (description: string) => void
    /**
     * Inject one assistant message whose `content` is the markdown string
     * passed in. Drives U-10 (markdown XSS 防护).
     */
    __e2eInjectMarkdownContent?: (content: string) => void
    /**
     * Inject N top-level chat messages at once for the U-20 large-history
     * render-perf test. Caller supplies a minimal `{id, role, content}`
     * shape; `timestamp` is filled in.
     */
    __e2eInjectMessages?: (
      messages: ReadonlyArray<{ id: string; role: 'user' | 'assistant'; content: string }>,
    ) => void
    /** Clear all chat messages (call before each test for isolation). */
    __e2eClearAll?: () => void
    /** Sentinel so tests can confirm hooks are mounted in the renderer. */
    __e2eHooksMounted?: true
  }
}

/**
 * Loose status type for fake sub-agent injection.
 *
 * Production `SubAgentDisplay.status` is typed as `'running' | 'completed' |
 * 'failed'`, but real producers (`agentTool.ts`, Coordinator) write
 * `'error' / 'stopped' / 'cancelled' / 'timeout'` at runtime. The U-1 bug
 * was the SubAgentsProgressBar dropping those out-of-narrow-type values.
 * Tests must be able to drive those exact runtime values, so injection
 * accepts the wider runtime union.
 */
export type E2ESubAgentStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'error'
  | 'stopped'
  | 'cancelled'
  | 'timeout'

export interface E2EToolUseInput {
  /** Tool registry name (e.g. 'read_file', 'edit_file', 'bash'). Drives U-18 actionWord categorisation. */
  name: string
  /** Optional id; defaults to a unique synthesised id. */
  id?: string
  status?: 'running' | 'completed' | 'error' | 'failed' | 'stopped'
  input?: Record<string, unknown>
}

export interface E2ETodoInput {
  content: string
  status?: 'pending' | 'in_progress' | 'completed'
}

export interface E2ESubAgentInput {
  agentId: string
  agentType: string
  name: string
  status: E2ESubAgentStatus
  description?: string
  output?: string
  /** Real tool invocations (drives U-18 actionWord and U-2/U-15 large counts). */
  toolUses?: ReadonlyArray<E2EToolUseInput>
  /** When `toolUses` is omitted, set the count directly (totalToolUses). */
  totalToolUses?: number
  todos?: ReadonlyArray<E2ETodoInput>
  structuredSummary?: SubAgentStructuredSummary
  thinking?: string
  startedAt?: number
  endedAt?: number
}

let toolUseSeq = 0
function makeToolUse(name: string, idHint: string | undefined): ToolUseDisplay {
  toolUseSeq++
  return {
    id: idHint ?? `e2e-tu-${toolUseSeq}`,
    name,
    input: {},
    status: 'completed',
  } as ToolUseDisplay
}

function buildFakeMessage(subAgents: ReadonlyArray<E2ESubAgentInput>): ChatMessage {
  const now = Date.now()
  const normalized: SubAgentDisplay[] = subAgents.map((sa) => {
    const tools: ToolUseDisplay[] = sa.toolUses
      ? sa.toolUses.map((t) => {
          const base = makeToolUse(t.name, t.id)
          return {
            ...base,
            ...(t.input ? { input: t.input } : {}),
            ...(t.status ? { status: t.status as ToolUseDisplay['status'] } : {}),
          }
        })
      : []

    const todos = sa.todos
      ? sa.todos.map((td) => ({
          content: td.content,
          status: (td.status ?? 'pending') as 'pending' | 'in_progress' | 'completed',
        }))
      : undefined

    return {
      agentId: sa.agentId as SubAgentDisplay['agentId'],
      agentType: sa.agentType,
      description: sa.description ?? '',
      name: sa.name,
      // Cast to the narrow production type. The whole point of these tests
      // is to verify the consumer (e.g. SubAgentsProgressBar) handles the
      // wider runtime values without dropping them — so we deliberately
      // smuggle the wider value through.
      status: sa.status as SubAgentDisplay['status'],
      output: sa.output,
      toolUses: tools,
      totalToolUses: sa.totalToolUses ?? tools.length,
      totalDurationMs:
        sa.startedAt != null && sa.endedAt != null
          ? Math.max(0, sa.endedAt - sa.startedAt)
          : undefined,
      ...(todos ? { todos } : {}),
      ...(sa.structuredSummary ? { structuredSummary: sa.structuredSummary } : {}),
      ...(sa.thinking ? { thinking: sa.thinking } : {}),
    } as SubAgentDisplay
  })

  return {
    id: `e2e-msg-${now}`,
    role: 'assistant',
    content: '',
    timestamp: now,
    subAgents: normalized,
  }
}

export function mountE2ETestHooks(): void {
  if (typeof window === 'undefined') return
  if (window.__e2eHooksMounted) return

  window.__e2eInjectSubAgents = (subAgents) => {
    const msg = buildFakeMessage(subAgents)
    useChatStore.getState().setMessages([msg])
  }

  window.__e2eInjectMixedMessage = () => {
    const subMsg = buildFakeMessage([
      {
        agentId: 'e2e-mixed-sub',
        agentType: 'Explore',
        name: '混合-子代理',
        status: 'completed',
        description: '混合消息中的子代理片段。',
      },
    ])
    const now = Date.now()
    // Top-level text + deprecated `thinking` field + 1 sub-agent in the same
    // message. The deprecated fields still flow through `ChatMessage.tsx`'s
    // legacy branch and exercise the same key-stability path the U-03
    // FIXME targets without us having to construct a full `blocks[]` tree.
    const mixed: ChatMessage = {
      ...subMsg,
      id: `e2e-mixed-${now}`,
      content: '这是一条混合消息的顶层文本。',
      thinking: '思考流程示例：先列假设，再验证。',
      isThinking: false,
    }
    useChatStore.getState().setMessages([mixed])
  }

  window.__e2eInjectSubAgentWithDesc = (description) => {
    const msg = buildFakeMessage([
      {
        agentId: 'e2e-long-desc',
        agentType: 'Explore',
        name: '长描述代理',
        status: 'completed',
        description,
      },
    ])
    useChatStore.getState().setMessages([msg])
  }

  window.__e2eInjectMarkdownContent = (content) => {
    const now = Date.now()
    const msg: ChatMessage = {
      id: `e2e-md-${now}`,
      role: 'assistant',
      content,
      timestamp: now,
    }
    useChatStore.getState().setMessages([msg])
  }

  window.__e2eInjectMessages = (messages) => {
    const now = Date.now()
    const expanded: ChatMessage[] = messages.map((m, i) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      timestamp: now + i, // monotonic so list order is preserved
    }))
    useChatStore.getState().setMessages(expanded)
  }

  window.__e2eClearAll = () => {
    useChatStore.getState().setMessages([])
  }

  window.__e2eHooksMounted = true
  console.log('[E2E] testHooks mounted (window.__e2e*)')
}
