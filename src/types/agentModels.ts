export interface RecalledMemoryCompact {
  filename: string
  name: string
  type: string
  matchSnippet: string
}

export interface AgentInfoCompact {
  agentType: string
  whenToUse: string
  source: string
  isReadOnly?: boolean
  model?: string
}

export interface CustomAgentSync {
  id: string
  name: string
  description: string
  tools?: string[]
  disallowedTools?: string[]
  model: string
  prompt: string
  maxTurns?: number
  timeout?: number
  thinkingBudgetTokens?: number
}

export interface SkillInfo {
  name: string
  description: string
  argumentHint?: string
  source: string
  disableModelInvocation?: boolean
  context?: string
  userInvocable?: boolean
}
