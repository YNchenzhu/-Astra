/**
 * Agent Type Definitions
 *
 * Defines the structure for AI agents that can be executed in-process.
 */

import type { AgentId, SessionId } from './ids'

export type AgentModel = 'claude-opus-4-6' | 'claude-sonnet-4-6' | 'claude-haiku-4-5' | string

export type AgentDefinition = {
  id: string
  name: string
  description: string
  model?: AgentModel
  systemPrompt?: string
  tools?: string[] // Tool names this agent can use
  planModeRequired?: boolean
}

export type AgentToolResult = {
  success: boolean
  content: string
  details?: unknown
  error?: string
}

export type AgentExecutionState = 'idle' | 'running' | 'paused' | 'completed' | 'failed' | 'stopped'

export type AgentExecutionContext = {
  agentId: AgentId
  sessionId: SessionId
  model: AgentModel
  systemPrompt: string
  tools: string[]
  planModeRequired: boolean
  permissionMode: 'auto' | 'manual' | 'deny'
}
