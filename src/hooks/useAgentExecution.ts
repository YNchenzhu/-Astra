/**
 * useAgentExecution Hook
 *
 * Manages agent execution lifecycle in React components.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useExecutionStore } from '../stores/executionStore'
import { runTeammateWithStore } from '../services/agent/inProcessRunner'
import { useChatStore } from '../stores/useChatStore'
import type { InProcessTeammateTaskState } from '../types/InProcessTeammateTask'

export function useAgentExecution(taskId: string | null) {
  const store = useExecutionStore()
  const [task, setTask] = useState<InProcessTeammateTaskState | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)

  // Subscribe to task updates
  useEffect(() => {
    if (!taskId) {
      setTask(null)
      return
    }

    const currentTask = store.getTask(taskId)
    setTask(currentTask || null)

    const unsubscribe = useExecutionStore.subscribe((state) => {
      setTask(state.tasks[taskId] || null)
    })

    return unsubscribe
  }, [taskId, store])

  const startExecution = useCallback(async () => {
    if (!taskId) return

    setIsRunning(true)
    setError(null)
    abortControllerRef.current = new AbortController()

    // P0-2 follow-up: capture the main chat's currentConversationId AT THE
    // POINT THE TEAMMATE STARTS so plan-approval cards land in the right
    // conversation. Read directly from the store instead of subscribing,
    // because we only need the value once (the snapshot is forwarded into
    // the main process — re-rendering this hook later wouldn't update it
    // anyway). Using getState avoids re-running this hook on every chat
    // turn for a possibly-irrelevant teammate.
    const currentChatConvId = useChatStore.getState().currentConversationId ?? undefined

    try {
      await runTeammateWithStore(taskId, abortControllerRef.current.signal, {
        ...(currentChatConvId ? { leaderConversationId: currentChatConvId } : {}),
      })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      setError(errorMessage)
      store.updateTask(taskId, {
        status: 'failed',
        error: errorMessage,
      })
    } finally {
      setIsRunning(false)
    }
  }, [taskId, store])

  const stopExecution = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }
    if (taskId) {
      store.updateTask(taskId, {
        status: 'stopped',
        shutdownRequested: true,
      })
    }
    setIsRunning(false)
  }, [taskId, store])

  return {
    task,
    isRunning,
    error,
    startExecution,
    stopExecution,
  }
}
