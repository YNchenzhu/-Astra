import { useCallback } from 'react'
import { create } from 'zustand'
import { onStreamEvent } from '../services/electronAPI'
import type { StreamEvent } from '../types'

export interface TaskOutputChunk {
  taskId: string
  stream: 'stdout' | 'stderr' | 'text' | 'meta'
  text: string
  timestamp: number
  status?: 'running' | 'completed' | 'failed' | 'stopped'
}

export interface TaskOutputState {
  chunks: TaskOutputChunk[]
  status: 'running' | 'completed' | 'failed' | 'stopped'
}

interface TaskOutputStoreState {
  byId: Record<string, TaskOutputState>
  _applyChunk: (event: StreamEvent) => void
}

export const useTaskOutputStore = create<TaskOutputStoreState>()((set) => ({
  byId: {},
  _applyChunk: (event) => {
    if (!event || event.type !== 'task:output-chunk') return
    const taskId: string | undefined = event.taskId
    if (!taskId) return
    const text: string = event.text ?? ''
    const stream: TaskOutputChunk['stream'] = event.stream ?? 'text'
    const timestamp: number = typeof event.timestamp === 'number' ? event.timestamp : Date.now()
    set((state) => {
      const prev = state.byId[taskId] ?? {
        chunks: [] as TaskOutputChunk[],
        status: 'running' as const,
      }
      // `StreamEvent.status` is a free-form string; narrow to the four task
      // lifecycle values the chunk consumer understands. Anything else is
      // dropped so the UI doesn't surface unexpected labels.
      const rawStatus = event.status
      const status: TaskOutputChunk['status'] =
        rawStatus === 'running' ||
        rawStatus === 'completed' ||
        rawStatus === 'failed' ||
        rawStatus === 'stopped'
          ? rawStatus
          : undefined
      const nextChunks = [
        ...prev.chunks,
        {
          taskId,
          stream,
          text,
          timestamp,
          status,
        },
      ]
      const nextStatus: TaskOutputState['status'] = status ?? prev.status
      return {
        byId: {
          ...state.byId,
          [taskId]: {
            chunks: nextChunks,
            status: nextStatus,
          },
        },
      }
    })
  },
}))

let taskOutputStreamInstalled = false
let taskOutputStreamUnsubscribe: (() => void) | null = null

/** Single IPC subscription for task stream chunks — avoids N×setState per ToolUseCard. */
export function ensureTaskOutputStream(): void {
  if (taskOutputStreamInstalled) return
  taskOutputStreamInstalled = true
  try {
    const off = onStreamEvent((event) => {
      useTaskOutputStore.getState()._applyChunk(event)
    })
    taskOutputStreamUnsubscribe = typeof off === 'function' ? off : null
  } catch {
    taskOutputStreamInstalled = false
    taskOutputStreamUnsubscribe = null
  }
}

/**
 * Tear down the task-output IPC subscription. Pair with
 * {@link ensureTaskOutputStream}; the main chat router invokes both as a
 * matched pair so HMR / test resets unwire cleanly. upstream alignment
 * audit P1-7: previously `disposeMainChatStreamRouter` only tore down
 * its own listener, leaving this one stuck `installed=true` across
 * resets and pinning a stale IPC listener.
 */
export function disposeTaskOutputStream(): void {
  if (taskOutputStreamUnsubscribe) {
    try { taskOutputStreamUnsubscribe() } catch { /* noop */ }
    taskOutputStreamUnsubscribe = null
  }
  taskOutputStreamInstalled = false
}

/** Select live task output for one tool card; only re-renders when this taskId changes. */
export function useTaskOutputSlice(taskId: string | undefined): TaskOutputState | undefined {
  return useTaskOutputStore(
    useCallback((s) => (taskId ? s.byId[taskId] : undefined), [taskId]),
  )
}

/**
 * Legacy hook kept for backward compatibility with ToolUseCard. Reads the
 * shared store so it benefits from the single IPC subscription installed
 * by {@link ensureTaskOutputStream}.
 */
export function useTaskOutput() {
  const byId = useTaskOutputStore((s) => s.byId)
  const getOutput = useCallback(
    (taskId: string): TaskOutputState | undefined => byId[taskId],
    [byId],
  )
  return { getOutput, outputs: byId }
}
