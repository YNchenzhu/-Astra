import type { ChatMessage } from './tool'

// ============================================================================
// Hook System Types
// ============================================================================

/**
 * Prompt elicitation protocol request.
 */
export interface PromptRequest {
  prompt: string
  message: string
  options: Array<{
    key: string
    label: string
    description?: string
  }>
}

/**
 * Response to a prompt elicitation request.
 */
export interface PromptResponse {
  prompt_response: string
  selected: string
}

/**
 * Context passed to callback hooks for state access.
 */
export interface HookCallbackContext {
  getAppState: () => Record<string, unknown>
  updateAttributionState: (
    updater: (prev: Record<string, unknown>) => Record<string, unknown>,
  ) => void
}

/**
 * Canonical list of hook events supported across the renderer (callback hooks)
 * and electron main (process hooks). Audit #3/#4 called out that `HookEvent`
 * used to be duplicated with different members on each side — the runtime list
 * now lives here as the single source of truth and electron's
 * `electron/tools/hooks/types.ts` re-exports it.
 */
export const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'Subagent',
  'SubagentStart',
  'PermissionRequest',
  'PermissionDenied',
  'FileChanged',
  'CwdChanged',
  'WorktreeCreate',
  'UserPromptSubmit',
  'PreCompact',
  'PostCompact',
  'SessionStart',
  'SessionEnd',
  'SessionIdle',
  'Setup',
  'Stop',
  'StopFailure',
  'SubagentStop',
  'TaskCreated',
  'TaskCompleted',
  'TeammateIdle',
  'InstructionsLoaded',
  'ConfigChange',
  'WorktreeRemove',
  'StatusLine',
  'FileSuggestion',
  'PreSkillUse',
  'PostSkillUse',
  'Elicitation',
  'ElicitationResult',
] as const

/** Hook events that can be registered. */
export type HookEvent = (typeof HOOK_EVENTS)[number]

/**
 * Input shape passed to hook callbacks.
 */
export type HookInput = {
  hookEvent: HookEvent
  command: string
  cwd: string
  toolName?: string
  toolUseID?: string | null
  toolInput?: Record<string, unknown>
  promptText?: string
  sessionID?: string
  transcriptPath?: string
  [key: string]: unknown
}

/**
 * JSON output returned by hook callbacks.
 */
export type HookJSONOutput =
  | { async?: false; [key: string]: unknown }
  | { async: true; asyncTimeout?: number; [key: string]: unknown }

/**
 * Async hook output variant.
 */
export type AsyncHookJSONOutput = {
  async: true
  asyncTimeout?: number
}

/**
 * Sync hook output variant.
 */
export type SyncHookJSONOutput = {
  async?: false
  continue?: boolean
  suppressOutput?: boolean
  stopReason?: string
  decision?: 'approve' | 'block'
  reason?: string
  systemMessage?: string
  hookSpecificOutput?: Record<string, unknown>
  [key: string]: unknown
}

/**
 * Permission update operation for hook responses.
 */
export type PermissionUpdate = {
  type: string
  toolName?: string
  content?: string
  [key: string]: unknown
}

/**
 * Hook callback definition.
 */
export type HookCallback = {
  type: 'callback'
  callback: (
    input: HookInput,
    toolUseID: string | null,
    abort: AbortSignal | undefined,
    hookIndex?: number,
    context?: HookCallbackContext,
  ) => Promise<HookJSONOutput>
  timeout?: number
  internal?: boolean
}

/**
 * Matcher + hooks collection with optional plugin name.
 */
export type HookCallbackMatcher = {
  matcher?: string
  hooks: HookCallback[]
  pluginName?: string
}

/**
 * Hook progress event for UI display.
 */
export type HookProgress = {
  type: 'hook_progress'
  hookEvent: HookEvent
  hookName: string
  command: string
  promptText?: string
  statusMessage?: string
}

/**
 * Blocking error from hook execution.
 */
export type HookBlockingError = {
  blockingError: string
  command: string
}

/**
 * Permission request result from hooks.
 */
export type PermissionRequestResult =
  | {
      behavior: 'allow'
      updatedInput?: Record<string, unknown>
      updatedPermissions?: PermissionUpdate[]
    }
  | {
      behavior: 'deny'
      message?: string
      interrupt?: boolean
    }

/**
 * Single hook execution result.
 */
export type HookResult = {
  message?: ChatMessage
  systemMessage?: ChatMessage
  blockingError?: HookBlockingError
  outcome: 'success' | 'blocking' | 'non_blocking_error' | 'cancelled'
  preventContinuation?: boolean
  stopReason?: string
  permissionBehavior?: 'ask' | 'deny' | 'allow' | 'passthrough'
  hookPermissionDecisionReason?: string
  additionalContext?: string
  initialUserMessage?: string
  updatedInput?: Record<string, unknown>
  updatedMCPToolOutput?: unknown
  permissionRequestResult?: PermissionRequestResult
  retry?: boolean
}

/**
 * Aggregated result from multiple hook executions.
 */
export type AggregatedHookResult = {
  message?: ChatMessage
  blockingErrors?: HookBlockingError[]
  preventContinuation?: boolean
  stopReason?: string
  hookPermissionDecisionReason?: string
  permissionBehavior?: 'ask' | 'deny' | 'allow' | 'passthrough'
  additionalContexts?: string[]
  initialUserMessage?: string
  updatedInput?: Record<string, unknown>
  updatedMCPToolOutput?: unknown
  permissionRequestResult?: PermissionRequestResult
  retry?: boolean
}

/**
 * Type guard to check if hook output is sync.
 */
export function isSyncHookJSONOutput(
  json: HookJSONOutput,
): json is SyncHookJSONOutput {
  return !('async' in json && json.async === true)
}

/**
 * Type guard to check if hook output is async.
 */
export function isAsyncHookJSONOutput(
  json: HookJSONOutput,
): json is AsyncHookJSONOutput {
  return 'async' in json && json.async === true
}
