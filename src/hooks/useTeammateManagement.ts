/**
 * useTeammateManagement Hook
 *
 * Manages teammate creation, listing, and lifecycle.
 */

import { useCallback, useState } from 'react'
import { useExecutionStore } from '../stores/executionStore'
import {
  spawnInProcessTeammate,
  killInProcessTeammate,
  getRunningTeammates,
} from '../services/agent/spawnInProcess'
import { requestTeammateShutdown } from '../services/InProcessTeammateTask'
import type { SpawnTeammateConfig } from '../services/agent/spawnInProcess'
import type { InProcessTeammateTaskState } from '../types/InProcessTeammateTask'

export function useTeammateManagement() {
  const store = useExecutionStore()
  const [error, setError] = useState<string | null>(null)

  const createTeammate = useCallback(
    (config: SpawnTeammateConfig) => {
      try {
        setError(null)
        const result = spawnInProcessTeammate(config)
        if (!result.success) {
          setError(result.error || 'Failed to spawn teammate')
          return null
        }
        return result.taskId
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err)
        setError(errorMessage)
        return null
      }
    },
    [],
  )

  const removeTeammate = useCallback(
    (taskId: string) => {
      try {
        setError(null)
        // First mark shutdownRequested so the running agent loop can finish
        // its current turn gracefully.
        requestTeammateShutdown(taskId)
        // Then abort via the stored AbortController (spawnInProcess sets one).
        killInProcessTeammate(taskId)
        // Finally actually remove the row from the task list. Previously
        // `killInProcessTeammate` only flipped status to 'stopped' and the
        // task stayed in `useExecutionStore.tasks` forever, so TeammatePanel's
        // "移除" button was misleading — clicking it left the row visible.
        store.deleteTask(taskId)
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err)
        setError(errorMessage)
      }
    },
    [store],
  )

  const getTeammates = useCallback((): InProcessTeammateTaskState[] => {
    return store.getAllTasks()
  }, [store])

  const getRunning = useCallback((): InProcessTeammateTaskState[] => {
    return getRunningTeammates()
  }, [])

  return {
    createTeammate,
    removeTeammate,
    getTeammates,
    getRunning,
    error,
  }
}
