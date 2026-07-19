import type { CustomAgentSync } from '../agentModels'

export interface ElectronAgentsApi {
  syncCustom: (agents: CustomAgentSync[]) => Promise<{ success: boolean; count: number }>
  // Audit P1-4 (2026-05): `list: () => Promise<AgentInfoCompact[]>` was
  // declared here but never implemented in preload OR main — calling
  // `window.electronAPI.agents.list()` would throw at runtime. No
  // renderer caller existed, so the type declaration was a silent
  // foot-gun. Removed; use `listAll()` below for the panel surface.
  /**
   * Disk-backed custom-agent management. Every method is OPTIONAL — the
   * renderer panels use defensive optional chaining so they degrade
   * gracefully on shells where the main process never registered the
   * handler. Full implementation lives under electron/agents/* (see
   * the next backend iteration).
   */
  listAll?: () => Promise<{
    success: boolean
    agents: unknown[]
    scopeDirs: {
      userGlobal: string
      userApp: string | null
      project: string | null
      extra: string[]
    }
    disabledCustomAgents?: string[]
    error?: string
  }>
  /** Subscribe to fs-watcher notifications (unsubscribe returned). */
  onChanged?: (cb: () => void) => () => void
  /** Replace the list of extra dirs scanned for custom-agent `.md` files. */
  setExtraDirs?: (dirs: string[]) => Promise<{ success: boolean; error?: string }>
  /** Replace the set of disabled custom-agent names. */
  setDisabled?: (names: string[]) => Promise<{ success: boolean; error?: string }>
  /**
   * Persist a new / updated custom-agent definition to disk.
   * Accepts either a flat shape (older callers) or the nested
   * `{ scope, agent: {...} }` shape used by the current AgentsPanel.
   */
  saveToDisk?: (params: {
    scope: 'user-global' | 'user-app' | 'project' | 'extra'
    extraDirIndex?: number
    agent?: {
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
    // Flat-shape fields (legacy / fallback):
    agentType?: string
    name?: string
    description?: string
    tools?: string[]
    disallowedTools?: string[]
    model?: string
    prompt?: string
    maxTurns?: number
    timeout?: number
    thinkingBudgetTokens?: number
    originalSourcePath?: string
    originalAgentType?: string
  }) => Promise<{
    success: boolean
    sourcePath?: string
    filePath?: string
    error?: string
  }>
  /** Delete a disk-backed custom agent by its `.md` path. */
  deleteFromDisk?: (sourcePath: string) => Promise<{ success: boolean; error?: string }>
  /** Open an OS directory picker (used by the extra-dirs UI). */
  pickDirectory?: (title?: string) => Promise<{ path?: string; canceled?: boolean }>
  /**
   * Phase 3 Sprint 3.1a: runtime "Running Agents" snapshot.
   * Optional (main process may not register the handler in
   * degraded environments; the panel copes gracefully).
   */
  listActive?: () => Promise<{
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
      /** Sprint 3.4: true if record came from disk (prior run). */
      fromDisk: boolean
    }>
    fetchedAt: number
  }>
  /** Phase 3 Sprint 3.1a: forcibly terminate a running agent. */
  abortActive?: (payload: { agentId: string }) => Promise<
    | { ok: true; agentId: string }
    | { ok: false; error: string }
  >
  /**
   * Stage 2.3 — cooperatively pause the orchestration kernel for a conversation.
   * Contract audit (2026-07): also cascades into sub-agents registered under
   * the conversation and reports coverage — `childrenPaused` kernels honored
   * the pause; `childrenUnsupported` run on legacy AbortController shims with
   * NO pause capability and keep running (surface this to the user).
   */
  pauseActive?: (payload: { conversationId: string }) => Promise<
    | { ok: true; childrenPaused?: number; childrenUnsupported?: number }
    | { ok: false; error?: string; childrenPaused?: number; childrenUnsupported?: number }
  >
  /** Stage 2.3 — resume a previously paused orchestration kernel (+ kernel-backed children). */
  resumeActive?: (payload: { conversationId: string }) => Promise<
    | { ok: true; childrenResumed?: number }
    | { ok: false; error?: string; childrenResumed?: number }
  >
}

/**
 * Stage 2.3 — OrchestrationKernel checkpoint / persistence control surface.
 * All channels keyed on `conversationId` because the active-kernel registry is.
 */
export interface ElectronOrchestrationApi {
  snapshot: (payload: { conversationId: string; tag: string }) => Promise<
    | { ok: true; checkpointId: string }
    | { ok: false; error: string }
  >
  rewind: (payload: { conversationId: string; checkpointId: string }) => Promise<{
    ok: boolean
  }>
  listCheckpoints: (payload: { conversationId: string }) => Promise<{
    ok: boolean
    checkpoints: Array<{
      id: string
      tag: string
      at: number
      parentId?: string
    }>
  }>
  persist: (payload: { conversationId: string }) => Promise<
    | { ok: true; savedAt: number }
    | { ok: false; error: string }
  >
}
