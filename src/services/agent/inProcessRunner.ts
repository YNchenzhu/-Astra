/**
 * In-Process Teammate Runner — IPC bridge to the main-process agentic loop.
 *
 * Replaces the previous renderer-only `runAgent.ts` shim that invoked the
 * Anthropic SDK directly (no compaction, no streaming, no watchdog, no
 * fallback model, no max-output recovery, no fork, no stop-hooks). The
 * teammate now runs through `electron/agents/teammateRunner.ts` →
 * `runAgenticLoop`, so every parity layer (compaction, strip-retry, prompt
 * cache, etc.) is shared with the main chat. No more two-implementation
 * drift.
 *
 * Renderer responsibility (this file):
 *   1. Translate the renderer's task identity into IPC params.
 *   2. Subscribe to `ai:teammate-stream-event` filtered by `runId`.
 *   3. Convert stream events back into `Message` objects via
 *      `appendTeammateMessage` so existing UI bindings keep working.
 *   4. Resolve the lifecycle promise on the `done` event (or on
 *      AbortController cancellation, propagated as `cancelTeammate`).
 *
 * Provider config (apiKey / baseUrl / providerId / model) flows through the
 * IPC schema; the main process merges with disk settings if any field is
 * empty. The renderer NEVER touches `process.env.ANTHROPIC_API_KEY`
 * anymore — that direct-SDK leak was the original `runAgent.ts` sin.
 */

import type { InProcessTeammateTaskState } from '../../types/InProcessTeammateTask'
import type { Message } from '../../utils/messages'
import {
  createMessage,
  createTextMessage,
  createToolResultMessage,
} from '../../utils/messages'
import { useExecutionStore } from '../../stores/executionStore'
import { appendTeammateMessage } from '../InProcessTeammateTask'

/**
 * Renderer-side handle on `window.electronAPI.ai`. Defined as `unknown` and
 * narrowed at call sites so this file compiles in Vitest's jsdom env where
 * `window.electronAPI` is undefined.
 */
type ElectronAi = {
  runTeammate: (params: {
    runId?: string
    taskId?: string
    prompt: string
    model: string
    systemPrompt?: string
    maxIterations?: number
    maxTokens?: number
    agentId?: string
    parentSessionId?: string
    history?: {
      role: 'user' | 'assistant'
      content: string | Array<Record<string, unknown>>
    }[]
    providerId?: string
    apiKey?: string
    baseUrl?: string
    awsRegion?: string
    projectId?: string
    /**
     * P0-2 follow-up: route the worker through plan mode and require the
     * user to click Approve/Deny on the inline card before implementation
     * starts. {@link leaderConversationId} MUST be supplied — without it
     * the main process throws.
     */
    planModeRequired?: boolean
    leaderConversationId?: string
  }) => Promise<{ runId: string }>
  cancelTeammate: (runId: string) => Promise<{ cancelled: boolean }>
  onTeammateStreamEvent: (
    callback: (event: TeammateStreamEvent) => void,
  ) => () => void
}

type TeammateStreamEvent = {
  runId: string
} & (
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | {
      type: 'tool_start'
      toolUse: { id: string; name: string; input: Record<string, unknown> }
    }
  | {
      type: 'tool_result'
      toolResult: {
        id: string
        name: string
        success: boolean
        output?: string
        error?: string
        toolErrorClass?: string
        errorWhat?: string
        errorTried?: string[]
        errorContext?: Record<string, string | number | null | undefined>
        errorNext?: string[]
      }
    }
  | { type: 'context_compact'; level: string }
  | {
      type: 'message_end'
      usage?: { inputTokens: number; outputTokens: number }
    }
  | {
      type: 'done'
      success: boolean
      error?: string
      usage?: { inputTokens: number; outputTokens: number }
    }
  | { type: 'error'; error: string }
  | { type: 'max_iterations_reached'; maxIterations: number }
)

function getAi(): ElectronAi | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { electronAPI?: { ai?: ElectronAi } }
  return w.electronAPI?.ai ?? null
}

export type InProcessRunnerOptions = {
  task: InProcessTeammateTaskState
  onStateUpdate?: (updates: Partial<InProcessTeammateTaskState>) => void
  onMessage?: (message: Message) => void
  abortSignal?: AbortSignal
  /**
   * P0-2 follow-up: when the teammate's `identity.planModeRequired` is true
   * (set at spawn time by the panel checkbox), the runner must hand the
   * worker the conversation id where the user's approval card should
   * appear. This is the renderer's `currentConversationId` at the moment
   * `startExecution()` is called — i.e. the chat the user is currently
   * looking at. Without this id the main process throws on plan-mode runs.
   */
  leaderConversationId?: string
}

/**
 * Run an in-process teammate.
 *
 * Returns when the underlying main-process run completes (or aborts /
 * fails). The returned snapshot reflects the final task state with the
 * accumulated messages history and last reported usage.
 */
export async function runInProcessTeammate(
  options: InProcessRunnerOptions,
): Promise<InProcessTeammateTaskState> {
  const { task, onStateUpdate, onMessage, abortSignal, leaderConversationId } = options

  const ai = getAi()
  if (!ai?.runTeammate) {
    const err = 'In-process teammate requires Electron (IPC bridge missing).'
    onStateUpdate?.({ status: 'failed', error: err, isIdle: true })
    return { ...task, status: 'failed', error: err }
  }

  onStateUpdate?.({ status: 'running', isIdle: false })

  // Initial user-turn message. The main process re-creates this from the
  // raw `prompt` string, but we still publish it locally so the renderer
  // shows the bubble immediately (don't wait for the first stream event).
  const initialMessage = createTextMessage('user', task.prompt)
  onMessage?.(initialMessage)
  appendTeammateMessage(task.id, initialMessage)

  // Convert renderer-shaped Message[] history into the IPC envelope that
  // the main process expects. Drop `tool_use` / `tool_result` blocks: the
  // main process will execute its own tools, replaying old tool calls
  // against a fresh tool registry would either dupe side effects or break
  // tool_use_id pairing.
  const sanitisedHistory = (task.messages || [])
    .map((m) => {
      const text = m.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('\n')
        .trim()
      if (!text) return null
      return {
        role: m.role,
        content: text,
      }
    })
    .filter((m): m is { role: 'user' | 'assistant'; content: string } => m !== null)

  let accumulatingAssistantText = ''
  let lastUsage: { inputTokens: number; outputTokens: number } | undefined
  let toolCount = 0
  let runId: string | null = null

  const flushAssistantText = (): void => {
    const text = accumulatingAssistantText
    accumulatingAssistantText = ''
    if (!text.trim()) return
    const msg = createTextMessage('assistant', text)
    onMessage?.(msg)
    appendTeammateMessage(task.id, msg)
  }

  // Set up the listener BEFORE invoking runTeammate so we can't miss the
  // first text_delta. We filter by runId once we know it; events with a
  // mismatched runId are ignored.
  let resolveDone: (result: { success: boolean; error?: string }) => void
  const donePromise = new Promise<{ success: boolean; error?: string }>(
    (resolve) => {
      resolveDone = resolve
    },
  )

  const unsubscribe = ai.onTeammateStreamEvent((event) => {
    if (runId && event.runId !== runId) return
    switch (event.type) {
      case 'text_delta': {
        accumulatingAssistantText += event.text
        return
      }
      case 'thinking_delta': {
        // Swallow — teammate UI doesn't render the thinking pane today.
        return
      }
      case 'tool_start': {
        // Flush any pending assistant text before publishing the tool_use
        // bubble so the UI ordering matches transcript ordering.
        flushAssistantText()
        toolCount++
        const msg = createMessage('assistant', [
          {
            type: 'tool_use',
            id: event.toolUse.id,
            name: event.toolUse.name,
            input: event.toolUse.input,
          },
        ])
        onMessage?.(msg)
        appendTeammateMessage(task.id, msg)
        onStateUpdate?.({ lastReportedToolCount: toolCount })
        return
      }
      case 'tool_result': {
        const r = event.toolResult
        const body = r.success ? r.output ?? '' : r.error ?? 'tool failed'
        const msg = createMessage('user', [
          createToolResultMessage(r.id, body, !r.success),
        ])
        onMessage?.(msg)
        appendTeammateMessage(task.id, msg)
        return
      }
      case 'message_end': {
        flushAssistantText()
        if (event.usage) {
          lastUsage = event.usage
          onStateUpdate?.({
            lastReportedTokenCount:
              event.usage.inputTokens + event.usage.outputTokens,
          })
        }
        return
      }
      case 'context_compact': {
        // Status hint only; the message stream resumes immediately.
        return
      }
      case 'max_iterations_reached': {
        flushAssistantText()
        return
      }
      case 'error': {
        flushAssistantText()
        onStateUpdate?.({ status: 'failed', error: event.error })
        return
      }
      case 'done': {
        flushAssistantText()
        resolveDone({ success: event.success, error: event.error })
        return
      }
    }
  })

  // Honour caller's AbortSignal — translate to ai.cancelTeammate.
  const onAbort = (): void => {
    if (runId) void ai.cancelTeammate(runId).catch(() => undefined)
  }
  abortSignal?.addEventListener('abort', onAbort)

  try {
    // P0-2 follow-up: forward plan-mode flag + leader conversation id when
    // the teammate was spawned with `planModeRequired: true`. Main process
    // throws if the pair is incomplete — surface that immediately so the
    // user sees a clear failure rather than a 10-minute hang.
    const planModeRequired = task.identity.planModeRequired === true
    if (planModeRequired && !leaderConversationId) {
      const err =
        '此队友勾选了「需要计划审批」,但启动时没有携带主聊天的 conversationId。请在主聊天有活跃会话时再次启动。'
      onStateUpdate?.({ status: 'failed', error: err, isIdle: true })
      return { ...task, status: 'failed', error: err }
    }

    const startResp = await ai.runTeammate({
      runId: task.id,
      taskId: task.id,
      prompt: task.prompt,
      model: task.model || 'claude-opus-4-6',
      systemPrompt: 'You are a helpful AI assistant.',
      agentId: task.identity.agentId,
      parentSessionId: task.identity.parentSessionId,
      history: sanitisedHistory,
      ...(planModeRequired ? { planModeRequired: true } : {}),
      ...(leaderConversationId ? { leaderConversationId } : {}),
      // No provider override here: main process falls back to disk settings
      // (loaded via `loadSettings()` in the IPC handler), which is what the
      // user already configured via the Settings dialog.
    })
    runId = startResp.runId

    const result = await donePromise
    if (result.success) {
      onStateUpdate?.({
        status: 'completed',
        isIdle: true,
        lastReportedTokenCount: lastUsage
          ? lastUsage.inputTokens + lastUsage.outputTokens
          : task.lastReportedTokenCount,
      })
      return {
        ...task,
        status: 'completed',
        lastReportedTokenCount: lastUsage
          ? lastUsage.inputTokens + lastUsage.outputTokens
          : task.lastReportedTokenCount,
      }
    }
    onStateUpdate?.({
      status: 'failed',
      isIdle: true,
      error: result.error || 'Teammate run failed',
    })
    return { ...task, status: 'failed', error: result.error }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    onStateUpdate?.({ status: 'failed', isIdle: true, error: errorMessage })
    return { ...task, status: 'failed', error: errorMessage }
  } finally {
    abortSignal?.removeEventListener('abort', onAbort)
    unsubscribe()
  }
}

/**
 * Run teammate with store integration.
 */
export async function runTeammateWithStore(
  taskId: string,
  abortSignal?: AbortSignal,
  options?: { leaderConversationId?: string },
): Promise<void> {
  const store = useExecutionStore.getState()
  const task = store.getTask(taskId)
  if (!task) {
    throw new Error(`Task not found: ${taskId}`)
  }
  await runInProcessTeammate({
    task,
    onStateUpdate: (updates) => {
      store.updateTask(taskId, updates)
    },
    onMessage: () => {
      // appendTeammateMessage is invoked inside runInProcessTeammate.
    },
    abortSignal,
    ...(options?.leaderConversationId ? { leaderConversationId: options.leaderConversationId } : {}),
  })
}
