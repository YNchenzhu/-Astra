/**
 * Personal-workspace Bundle system (see plan §4.5.10).
 *
 * Renderer uses this to list / switch / reload bundles and subscribe to
 * activation / change / delete broadcasts from main. Safe to call before
 * main has finished bootstrap — handlers return empty lists until the
 * registry is ready.
 */
import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Bundle } from '../agents/bundles/types'

type TryRunUsage =
  | {
      inputTokens?: number
      outputTokens?: number
      cacheCreationTokens?: number
      cacheReadTokens?: number
    }
  | null

export interface BundleApi {
  list: () => Promise<{
    bundles: Bundle[]
    activeId: string | null
    errors: Array<{ filePath: string; error: string }>
  }>
  getActive: () => Promise<{
    bundle: Bundle | null
    activeId: string | null
  }>
  activate: (id: string) => Promise<{ bundle: Bundle; activeId: string }>
  reload: () => Promise<{
    bundles: Bundle[]
    errors: Array<{ filePath: string; error: string }>
    activeId: string | null
  }>
  getLoadErrors: () => Promise<Array<{ filePath: string; error: string }>>
  /**
   * Phase 2 Sprint 2a: persist scalar agent fields. `patch` must be
   * a subset of the AgentBundleEntry surface the main-side Zod
   * schema accepts — complex fields (promptSections, agentHooks[],
   * tool arrays) are rejected until Sprint 2b adds their editors.
   * Preset-sourced bundles are auto-forked into the user tier.
   */
  saveAgent: (payload: {
    bundleId: string
    agentType: string
    patch: Record<string, unknown>
  }) => Promise<{ bundle: Bundle; activeId: string | null }>
  /**
   * Phase 2 Sprint 2c.1: persist a team patch. Same null-sentinel
   * convention as `saveAgent`. Team `id` rename is rejected by the
   * main side to prevent dangling references.
   */
  saveTeam: (payload: {
    bundleId: string
    teamId: string
    patch: Record<string, unknown>
  }) => Promise<{ bundle: Bundle; activeId: string | null }>
  /** Sprint 2c.2: persist a bundle-level meta patch. */
  saveMeta: (payload: {
    bundleId: string
    patch: Record<string, unknown>
  }) => Promise<{ bundle: Bundle; activeId: string | null }>
  /** Sprint 2c.2: create a new bundle (blank or forked). */
  create: (params: {
    id: string
    name?: string
    description?: string
    domain?: string
    author?: string
    copyFromId?: string
  }) => Promise<{ bundle: Bundle; activeId: string | null }>
  /** Sprint 2c.2: delete a non-preset bundle. */
  delete: (bundleId: string) => Promise<{
    deletedOnDisk: boolean
    newActiveId: string | null
    deletedId: string
  }>
  /** Sprint 2c.2b: append a new agent to a bundle. */
  addAgent: (payload: {
    bundleId: string
    seed: {
      agentType: string
      displayName?: string
      whenToUse?: string
      capability?: string
      systemPromptRaw?: string
      isPrimary?: boolean
    }
  }) => Promise<{ bundle: Bundle; activeId: string | null }>
  /** Sprint 2c.2b: remove an agent from a bundle. */
  removeAgent: (payload: {
    bundleId: string
    agentType: string
  }) => Promise<{ bundle: Bundle; activeId: string | null }>
  /** Sprint 2c.2b: append a new team to a bundle. */
  addTeam: (payload: {
    bundleId: string
    seed: {
      id: string
      name?: string
      description?: string
      coordination?: 'solo' | 'parallel' | 'sequential' | 'swarm' | 'coordinator'
    }
  }) => Promise<{ bundle: Bundle; activeId: string | null }>
  /** Sprint 2c.2b: remove a team from a bundle. */
  removeTeam: (payload: {
    bundleId: string
    teamId: string
  }) => Promise<{ bundle: Bundle; activeId: string | null }>
  /**
   * Sprint 2c.3b: open a native save-dialog and write the bundle's
   * JSON to the chosen path.
   */
  exportBundle: (payload: { bundleId: string }) => Promise<
    | { ok: true; filePath: string }
    | { ok: false; canceled: true }
    | { ok: false; canceled: false; error: string }
  >
  /**
   * Sprint 2c.3b: open a native open-dialog and import a bundle JSON.
   * `filePath` is used to retry a previously-opened file after the UI
   * resolves an id-conflict — skipping the dialog on retry.
   */
  importBundle: (options: {
    filePath?: string
    newId?: string
    replaceExisting?: boolean
  }) => Promise<
    | { ok: true; bundle: Bundle; usedId: string; replaced: boolean }
    | { ok: false; canceled: true }
    | {
        ok: false
        canceled: false
        reason: 'parse-error' | 'id-conflict' | 'preset-conflict' | 'write-error'
        error: string
        attemptedId?: string
        suggestedId?: string
        filePath?: string
      }
  >
  /**
   * Sprint 2d.a: kick off a one-shot LLM call that exercises the
   * selected agent's composed system prompt. Returns `{ok, runId}`
   * synchronously; the actual tokens arrive via `onTryRunDelta`
   * subscriptions and end with `onTryRunEnd` or `onTryRunError`.
   */
  tryRunAgent: (payload: {
    bundleId: string
    agentType: string
    messages: Array<{ role: 'user' | 'assistant'; content: string }>
    modelOverride?: string
    systemPromptOverride?: string
  }) => Promise<
    | { ok: true; runId: string; model: string; systemPromptLength: number }
    | { ok: false; error: string }
  >
  /** Sprint 2d.a: abort an in-flight try-run. */
  tryRunCancel: (payload: { runId: string }) => Promise<{ ok: boolean }>
  /** Sprint 2d.a: subscribe to streaming deltas. Returns unsubscribe. */
  onTryRunDelta: (
    handler: (payload: { runId: string; text: string }) => void,
  ) => () => void
  /** Sprint 2d.a: subscribe to terminal "end" events. */
  onTryRunEnd: (
    handler: (payload: { runId: string; usage: TryRunUsage }) => void,
  ) => () => void
  /** Sprint 2d.a: subscribe to terminal "error" events. */
  onTryRunError: (
    handler: (payload: { runId: string; error: string }) => void,
  ) => () => void
  /**
   * Phase 2 Sprint 2b.1: fetch the runtime system prompt for a
   * built-in agent, pre-split by `##` headers into editable
   * `PromptSection[]`. Returns `{ ok: false, error }` when the
   * requested agentType isn't a built-in (e.g. a user-defined one
   * that already lives inside the Bundle JSON).
   */
  getBuiltinPrompt: (payload: {
    bundleId: string
    agentType: string
  }) => Promise<
    | {
        ok: true
        raw: string
        sections: Array<{
          id: string
          title: string
          hint?: string
          body: string
          order: number
          required?: boolean
        }>
      }
    | { ok: false; error: string }
  >
  /**
   * Phase 2 Sprint 2b.2: enumerate all names the Workbench's
   * capability editors can offer. Partial results are returned on
   * best-effort — a subsystem that hasn't initialized yet simply
   * contributes an empty array to its slot.
   */
  getCapabilityCatalog: () => Promise<{
    tools: string[]
    skills: string[]
    mcpServers: string[]
  }>
  /** Subscribe to activation broadcasts from main. Returns an unsubscribe fn. */
  onActivated: (
    handler: (payload: { activeId: string | null; bundle: Bundle | null }) => void,
  ) => () => void
  /**
   * Subscribe to content-change broadcasts from main. Fires on
   * save / fork / future create/delete. Renderer bundle store uses
   * this to live-refresh without polling `bundle:list`.
   */
  onChanged: (
    handler: (payload: { bundle: Bundle; reason: string }) => void,
  ) => () => void
  /** Sprint 2c.2: subscribe to deletion broadcasts. */
  onDeleted: (
    handler: (payload: { deletedId: string }) => void,
  ) => () => void
  /**
   * Phase 3 Sprint 3.3: fetch runtime orchestrator status (agent tree,
   * concurrency counts, kernel states) for the Workbench runtime panel.
   */
  getOrchestratorStatus: () => Promise<{
    kernels: Array<{
      kernelId: string
      parentKernelId?: string
      conversationId?: string
      agentType: string
      affinity: string
      worktreePath?: string
      createdAt: number
      childCount: number
    }>
    maxConcurrentChildren: number
  }>
}

export function buildBundleApi(): BundleApi {
  return {
    list: () => ipcRenderer.invoke('bundle:list'),
    getActive: () => ipcRenderer.invoke('bundle:get-active'),
    activate: (id) => ipcRenderer.invoke('bundle:activate', id),
    reload: () => ipcRenderer.invoke('bundle:reload'),
    getLoadErrors: () => ipcRenderer.invoke('bundle:get-load-errors'),
    saveAgent: (payload) => ipcRenderer.invoke('bundle:save-agent', payload),
    saveTeam: (payload) => ipcRenderer.invoke('bundle:save-team', payload),
    saveMeta: (payload) => ipcRenderer.invoke('bundle:save-meta', payload),
    create: (params) => ipcRenderer.invoke('bundle:create', params),
    delete: (bundleId) => ipcRenderer.invoke('bundle:delete', bundleId),
    addAgent: (payload) => ipcRenderer.invoke('bundle:add-agent', payload),
    removeAgent: (payload) => ipcRenderer.invoke('bundle:remove-agent', payload),
    addTeam: (payload) => ipcRenderer.invoke('bundle:add-team', payload),
    removeTeam: (payload) => ipcRenderer.invoke('bundle:remove-team', payload),
    exportBundle: (payload) => ipcRenderer.invoke('bundle:export', payload),
    importBundle: (options) => ipcRenderer.invoke('bundle:import', options ?? {}),
    tryRunAgent: (payload) => ipcRenderer.invoke('bundle:try-run-agent', payload),
    tryRunCancel: (payload) => ipcRenderer.invoke('bundle:try-run-cancel', payload),
    onTryRunDelta: (handler) => {
      const wrapped = (_event: IpcRendererEvent, payload: { runId: string; text: string }) => {
        handler(payload)
      }
      ipcRenderer.on('bundle:try-run-delta', wrapped)
      return () => ipcRenderer.removeListener('bundle:try-run-delta', wrapped)
    },
    onTryRunEnd: (handler) => {
      const wrapped = (
        _event: IpcRendererEvent,
        payload: { runId: string; usage: TryRunUsage },
      ) => {
        handler(payload)
      }
      ipcRenderer.on('bundle:try-run-end', wrapped)
      return () => ipcRenderer.removeListener('bundle:try-run-end', wrapped)
    },
    onTryRunError: (handler) => {
      const wrapped = (_event: IpcRendererEvent, payload: { runId: string; error: string }) => {
        handler(payload)
      }
      ipcRenderer.on('bundle:try-run-error', wrapped)
      return () => ipcRenderer.removeListener('bundle:try-run-error', wrapped)
    },
    getBuiltinPrompt: (payload) =>
      ipcRenderer.invoke('bundle:get-builtin-prompt', payload),
    getCapabilityCatalog: () => ipcRenderer.invoke('bundle:get-capability-catalog'),
    onChanged: (handler) => {
      const wrapped = (_event: IpcRendererEvent, payload: { bundle: Bundle; reason: string }) => {
        handler(payload)
      }
      ipcRenderer.on('bundle:changed', wrapped)
      return () => ipcRenderer.removeListener('bundle:changed', wrapped)
    },
    onDeleted: (handler) => {
      const wrapped = (_event: IpcRendererEvent, payload: { deletedId: string }) => {
        handler(payload)
      }
      ipcRenderer.on('bundle:deleted', wrapped)
      return () => ipcRenderer.removeListener('bundle:deleted', wrapped)
    },
    onActivated: (handler) => {
      const wrapped = (
        _event: IpcRendererEvent,
        payload: { activeId: string | null; bundle: Bundle | null },
      ) => {
        handler(payload)
      }
      ipcRenderer.on('bundle:activated', wrapped)
      return () => ipcRenderer.removeListener('bundle:activated', wrapped)
    },
    getOrchestratorStatus: () => ipcRenderer.invoke('bundle:get-orchestrator-status'),
  }
}
