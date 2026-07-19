// ========== Custom Agent Types ==========

export interface CustomAgentInfo {
  id: string
  name: string
  /** "当...的时候调用" — trigger description shown in the Agent tool prompt. */
  description: string
  /** "功能是..." — short capability sentence rendered into the Agent tool prompt. */
  capability?: string
  tools?: string[]
  disallowedTools?: string[]
  model: string
  prompt: string
  maxTurns?: number
  timeout?: number
  thinkingBudgetTokens?: number
}

/**
 * Disk-backed agent as returned by `window.electronAPI.agents.listAll`.
 * Distinct from {@link CustomAgentInfo} (which is renderer-local, stored in
 * localStorage) — one ships with scope metadata, the other doesn't.
 */
export interface DiskAgentInfo {
  agentType: string
  source: 'built-in' | 'custom' | 'plugin'
  sourceScope?: string
  sourcePath?: string
  extraDirIndex?: number
  whenToUse: string
  /** "功能是..." — optional short capability sentence for the Agent tool prompt. */
  capability?: string
  model?: string
  tools?: string[]
  disallowedTools?: string[]
  isReadOnly?: boolean
  maxTurns?: number
  timeout?: number
  thinkingBudgetTokens?: number
  pluginName?: string
  prompt?: string
  filename?: string
}

export interface ScopeDirs {
  userGlobal: string
  userApp: string | null
  project: string | null
  extra: string[]
}
