/**
 * Execution Store
 *
 * Global state management for agent execution (in-process teammates) using
 * Zustand.
 *
 * NOTE: Previously this store also carried `activeTaskId / isExecuting /
 * currentProgress` + their setters `setActiveTask / setExecuting / setProgress`.
 * Those were never read or written by any consumer — per-task state is already
 * carried on the task itself (`status`, `lastReportedToolCount`,
 * `lastReportedTokenCount`) and global "is anything running" is answered by
 * `useChatStore.isTyping` for the chat UI and by local `useState` inside
 * `useAgentExecution` for per-agent UI. They were removed to avoid confusing
 * future maintainers with three different "where does the progress live?" stores.
 *
 * `clearTasks` is retained as an admin-surface API even though no UI currently
 * calls it — `clearCompleted` is the user-facing action (via `TeammatePanel`).
 */

import { create } from 'zustand'
import type { InProcessTeammateTaskState } from '../types/InProcessTeammateTask'

export type ExecutionStoreState = {
  // Tasks
  tasks: Record<string, InProcessTeammateTaskState>

  // Actions
  createTask: (task: InProcessTeammateTaskState) => void
  updateTask: (taskId: string, updates: Partial<InProcessTeammateTaskState>) => void
  deleteTask: (taskId: string) => void
  getTask: (taskId: string) => InProcessTeammateTaskState | undefined
  getAllTasks: () => InProcessTeammateTaskState[]

  // Batch operations
  clearTasks: () => void
  clearCompleted: () => void
}

export const useExecutionStore = create<ExecutionStoreState>((set, get) => ({
  tasks: {},

  createTask: (task) =>
    set((state) => ({
      tasks: {
        ...state.tasks,
        [task.id]: task,
      },
    })),

  updateTask: (taskId, updates) =>
    set((state) => {
      const task = state.tasks[taskId]
      if (!task) return state
      return {
        tasks: {
          ...state.tasks,
          [taskId]: { ...task, ...updates },
        },
      }
    }),

  deleteTask: (taskId) =>
    set((state) => {
      const rest = { ...state.tasks }
      delete rest[taskId]
      return { tasks: rest }
    }),

  getTask: (taskId) => get().tasks[taskId],

  getAllTasks: () => Object.values(get().tasks),

  clearTasks: () => set({ tasks: {} }),

  clearCompleted: () =>
    set((state) => ({
      tasks: Object.fromEntries(
        Object.entries(state.tasks).filter(
          ([, task]) => !['completed', 'failed', 'stopped'].includes(task.status),
        ),
      ),
    })),
}))
