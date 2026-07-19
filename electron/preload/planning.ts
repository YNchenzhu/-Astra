/**
 * Planning bridge — exposes the active plan's task counts to the
 * renderer. Backed by `electron/planning/planRuntime.ts#getActivePlanStatus`.
 */
import { ipcRenderer } from 'electron'

export interface PlanningStatus {
  planFilePath: string
  total: number
  pending: number
  inProgress: number
  completed: number
}

export interface PlanningApi {
  /** Returns the active plan's status, or `null` when no plan is active. */
  getStatus: () => Promise<PlanningStatus | null>
}

export function buildPlanningApi(): PlanningApi {
  return {
    getStatus: () => ipcRenderer.invoke('planning:get-status'),
  }
}
