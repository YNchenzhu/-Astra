/**
 * Type guards for task states.
 *
 * Extracted into a pure TypeScript file so non-React consumers
 * (e.g. stopTask, shellRunner) don't import UI modules.
 */

import type { TaskStateBase, TaskType } from './taskInterface'
import type { AgentId } from '../ids'

// ============================================================
// Shell task state (LocalShellTask)
// ============================================================

export interface LocalShellTaskState extends TaskStateBase {
  type: 'local_bash'
  command: string
  result?: { code: number; interrupted: boolean }
  agentId?: AgentId
  kind?: 'bash' | 'monitor'
  lastReportedTotalLines?: number
}

export function isLocalShellTask(task: TaskStateBase): task is LocalShellTaskState {
  return task.type === 'local_bash'
}

// ============================================================
// Agent task state (LocalAgentTask)
// ============================================================

export interface LocalAgentTaskState extends TaskStateBase {
  type: 'local_agent'
  agentId: AgentId
  prompt: string
  selectedAgent?: string
  model?: string
  progress?: {
    toolUseCount: number
    tokenCount: number
    summary?: string
  }
  agentType: string
  retain?: boolean
}

export function isLocalAgentTask(task: TaskStateBase): task is LocalAgentTaskState {
  return task.type === 'local_agent'
}

// ============================================================
// Main session task state (LocalMainSessionTask)
// ============================================================

export interface LocalMainSessionTaskState extends TaskStateBase {
  type: 'main_session'
  conversationId: string
}

export function isMainSessionTask(task: TaskStateBase): task is LocalMainSessionTaskState {
  return task.type === 'main_session'
}

// ============================================================
// Remote agent task state (RemoteAgentTask)
// ============================================================

export interface RemoteAgentTaskState extends TaskStateBase {
  type: 'remote_agent'
  remoteId: string
  ultraplanPhase?: string
}

export function isRemoteAgentTask(task: TaskStateBase): task is RemoteAgentTaskState {
  return task.type === 'remote_agent'
}

// ============================================================
// Local workflow task state (LocalWorkflowTask)
// ============================================================
//
// Declarative multi-step pipelines (e.g. WorkflowTool — the "research →
// implement → verify" runners) are first-class tasks so the renderer can
// display, kill, and notify against them uniformly with shells / agents.
// ============================================================

export interface LocalWorkflowTaskState extends TaskStateBase {
  type: 'local_workflow'
  /** Display name of the workflow (e.g. "ralphinho-rfc-pipeline"). */
  workflowName: string
  /** Optional current step label, updated as the workflow progresses. */
  currentStep?: string
  /** Optional step counter for progress UI. */
  stepIndex?: number
  totalSteps?: number
  /** AgentId that owns this workflow (so killTasksByAgent reaps it). */
  agentId?: AgentId
}

export function isLocalWorkflowTask(task: TaskStateBase): task is LocalWorkflowTaskState {
  return task.type === 'local_workflow'
}

// ============================================================
// MCP monitor task state (MonitorMcpTask)
// ============================================================
//
// Tracks a long-lived MCP server liveness probe. The task is "running" while
// the server is reachable; transitions to "failed" on disconnect so the
// notification system can surface a single XML reconnect notice.
// ============================================================

export interface MonitorMcpTaskState extends TaskStateBase {
  type: 'monitor_mcp'
  /** MCP server logical name (matches `McpClient.name`). */
  serverName: string
  /** Last successful heartbeat (ms epoch). */
  lastHeartbeatMs?: number
  /** Optional human label for the connection (host:port, transport, …). */
  connectionLabel?: string
  /** Last error message if the monitor flipped to `failed`. */
  lastError?: string
}

export function isMonitorMcpTask(task: TaskStateBase): task is MonitorMcpTaskState {
  return task.type === 'monitor_mcp'
}

// ============================================================
// Dream task state (DreamTask — proactive idle-time agent)
// ============================================================
//
// Dream tasks fire when the user is idle: they capture user-volunteered
// hints ("clean up while I'm away"), proactive suggestions, or background
// memory consolidation. Lifecycle differs from a normal sub-agent: Dream
// never blocks the main chat and auto-yields when the user returns.
// ============================================================

export interface DreamTaskState extends TaskStateBase {
  type: 'dream'
  /** Reason the dream was triggered (e.g. 'idle_5min', 'memory_consolidate'). */
  trigger: string
  /** Sub-agent id running the dream (so kill propagates to its abort signal). */
  agentId?: AgentId
  /** Optional final summary captured when the dream completes. */
  summary?: string
}

export function isDreamTask(task: TaskStateBase): task is DreamTaskState {
  return task.type === 'dream'
}

// ============================================================
// Union + helpers
// ============================================================

export type AnyTaskState =
  | LocalShellTaskState
  | LocalAgentTaskState
  | LocalMainSessionTaskState
  | RemoteAgentTaskState
  | LocalWorkflowTaskState
  | MonitorMcpTaskState
  | DreamTaskState

export function taskTypeLabel(type: TaskType): string {
  switch (type) {
    case 'local_bash': return 'shell'
    case 'local_agent': return 'agent'
    case 'main_session': return 'session'
    case 'remote_agent': return 'cloud'
    case 'local_workflow': return 'workflow'
    case 'monitor_mcp': return 'mcp'
    case 'dream': return 'dream'
  }
}
