/**
 * Agents panel + running-agent registry bridge.
 *
 * Channels:
 *   - `agents:sync-custom`        persist renderer snapshot
 *   - `agents:list-all`           scope-scanned disk agents
 *   - `agents:save-to-disk` / `delete-from-disk`
 *   - `agents:set-disabled` / `set-extra-dirs`
 *   - `agents:pick-directory`     native folder picker
 *   - `agents:changed`            broadcast hook for the panel refresh
 *   - `agents:list-active` / `abort-active`   Running Agents panel
 */
import { ipcRenderer } from 'electron'

export interface AgentsApi {
  syncCustom: (agents: unknown[]) => Promise<{ success: boolean; count: number }>
  listAll: () => Promise<{
    success: boolean
    agents: unknown[]
    scopeDirs: {
      userGlobal: string
      userApp: string | null
      project: string | null
      extra: string[]
    }
    disabledCustomAgents: string[]
    error?: string
  }>
  saveToDisk: (params: {
    scope: 'user-global' | 'user-app' | 'project' | 'extra'
    extraDirIndex?: number
    agent: {
      agentType: string
      description?: string
      capability?: string
      tools?: string[]
      disallowedTools?: string[]
      model?: string
      prompt: string
      maxTurns?: number
      timeout?: number
      thinkingBudgetTokens?: number
    }
  }) => Promise<{
    success: boolean
    sourcePath?: string
    filePath?: string
    error?: string
  }>
  deleteFromDisk: (sourcePath: string) => Promise<{ success: boolean; error?: string }>
  setDisabled: (names: string[]) => Promise<{ success: boolean; error?: string }>
  setExtraDirs: (dirs: string[]) => Promise<{ success: boolean; error?: string }>
  pickDirectory: (title?: string) => Promise<{ path?: string; canceled?: boolean }>
  onChanged: (cb: () => void) => () => void
  /**
   * Phase 3 Sprint 3.1a: snapshot of the runtime active-agent
   * registry. Polled by the Running Agents panel.
   */
  listActive: () => Promise<{
    agents: Array<{
      agentId: string
      agentType: string
      description: string
      name?: string
      teamName?: string
      status: 'running' | 'completed' | 'failed' | 'killed'
      startTime: number
      endedAt?: number
      elapsedMs: number
      tokenCount: number
      maxTokenBudget: number
      tokenBudgetExceeded: boolean
      timeoutMs: number
      pendingMessageCount: number
      parentAgentId?: string
      streamConversationId?: string
      background: boolean
      model?: string
      /**
       * P1-1: spawn-time permission mode (upstream §3.1). One of
       * `default | plan | bypassPermissions | acceptEdits | dontAsk`,
       * or `undefined` for legacy / pre-P1-1 records (and a few async
       * profiles that don't carry an override). UI treats unknown values
       * as "no badge".
       */
      permissionMode?: string
      /** Sprint 3.4: true if this record was loaded from disk
       *  (i.e. from a previous process run). */
      fromDisk: boolean
    }>
    fetchedAt: number
  }>
  /** Phase 3 Sprint 3.1a: forcibly terminate a running agent. */
  abortActive: (payload: { agentId: string }) => Promise<
    | { ok: true; agentId: string }
    | { ok: false; error: string }
  >
  /**
   * Stage 2.3 — cooperatively pause an in-flight orchestration kernel. Pause
   * is observed at the next iteration boundary; in-flight tool execution and
   * streaming are NOT interrupted (use {@link abortActive} for hard stop).
   *
   * Keyed on conversationId (matching the kernel registry's key) so the chat
   * panel can pause without resolving an agentId. Returns `{ ok: false }`
   * when no kernel is registered for the conversation.
   */
  pauseActive: (payload: { conversationId: string }) => Promise<
    | { ok: true; childrenPaused?: number; childrenUnsupported?: number }
    | { ok: false; error?: string; childrenPaused?: number; childrenUnsupported?: number }
  >
  /** Stage 2.3 — resume a previously paused orchestration kernel (+ kernel-backed children). */
  resumeActive: (payload: { conversationId: string }) => Promise<
    | { ok: true; childrenResumed?: number }
    | { ok: false; error?: string; childrenResumed?: number }
  >
}

export function buildAgentsApi(): AgentsApi {
  return {
    syncCustom: (agents) =>
      ipcRenderer.invoke('agents:sync-custom', agents) as Promise<{ success: boolean; count: number }>,
    listAll: () =>
      ipcRenderer.invoke('agents:list-all') as Promise<{
        success: boolean
        agents: unknown[]
        scopeDirs: {
          userGlobal: string
          userApp: string | null
          project: string | null
          extra: string[]
        }
        disabledCustomAgents: string[]
        error?: string
      }>,
    saveToDisk: (params) =>
      ipcRenderer.invoke('agents:save-to-disk', params) as Promise<{
        success: boolean
        sourcePath?: string
        filePath?: string
        error?: string
      }>,
    deleteFromDisk: (sourcePath) =>
      ipcRenderer.invoke('agents:delete-from-disk', sourcePath) as Promise<{
        success: boolean
        error?: string
      }>,
    setDisabled: (names) =>
      ipcRenderer.invoke('agents:set-disabled', names) as Promise<{
        success: boolean
        error?: string
      }>,
    setExtraDirs: (dirs) =>
      ipcRenderer.invoke('agents:set-extra-dirs', dirs) as Promise<{
        success: boolean
        error?: string
      }>,
    pickDirectory: (title) =>
      ipcRenderer.invoke('agents:pick-directory', title) as Promise<{
        path?: string
        canceled?: boolean
      }>,
    onChanged: (cb) => {
      const handler = () => cb()
      ipcRenderer.on('agents:changed', handler)
      return () => ipcRenderer.removeListener('agents:changed', handler)
    },
    listActive: () => ipcRenderer.invoke('agents:list-active'),
    abortActive: (payload) => ipcRenderer.invoke('agents:abort-active', payload),
    pauseActive: (payload) => ipcRenderer.invoke('agents:pause-active', payload),
    resumeActive: (payload) => ipcRenderer.invoke('agents:resume-active', payload),
  }
}
