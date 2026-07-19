/**
 * Per-tool-execution context — explicitly passed to `Tool.execute(input, ctx?)`.
 *
 * Mirrors upstream's `ToolUseContext` (`src/Tool.ts`) but adapted for this
 * project's architecture:
 *
 *   1. Fields already provided by **module singletons** are NOT duplicated
 *      here — workspace path, file read state, agent context, etc. live in
 *      their own modules (`workspaceState`, `readFileState`,
 *      `agents/agentContext`). Tools that need them keep importing them
 *      directly. This ctx focuses on values that are **per-execution** and
 *      not derivable from a singleton.
 *
 *   2. upstream's `setToolJSX: (jsx: React.ReactNode) => void` field doesn't
 *      port — Electron's Main/Renderer process isolation forbids passing
 *      live React nodes across the boundary. The serializable replacement
 *      is {@link ToolUseContext.emitToolProgress}: tools emit JSON render
 *      hints, the agentic loop forwards them via IPC to the Renderer where
 *      React components materialize them. Stage 2 of the upstream alignment
 *      plan introduces the wire format and Renderer-side dispatch table.
 *
 * Field parity (upstream → here):
 *   - `abortController.signal`        → `abortSignal`
 *   - `options.permissionMode`        → `permissionMode`
 *   - `agentId / agentType`           → `agentId / agentType / isSubAgent`
 *   - `toolUseId`                     → `toolUseId`
 *   - `setToolJSX`                    → `emitToolProgress` (serializable)
 *   - (per-tool-call discovery state) → `discoveryExclude`
 */

import type { PermissionRulePayload } from '../ai/permissionRuleMatch'

/** Effective permission mode for this tool execution. */
export type ToolPermissionMode = 'default' | 'bypassPermissions'

/** Session default permission decision when no specific rule matches. */
export type ToolPermissionDefault = 'allow' | 'ask' | 'deny'

/**
 * Serializable progress event emitted by a tool mid-execution.
 *
 * The agentic loop forwards these to the Renderer (IPC) where the tool's
 * registered render-hint component decides how to display them. The shape
 * is intentionally `unknown` data so each tool type can define its own
 * payload schema in stage 2 (see upstream's `ToolProgressData` union).
 */
export type ToolProgressEvent = {
  /** Discriminant — typically the tool name (e.g. `'bash_output'`, `'web_search_partial'`). */
  type: string
  /** Tool-specific JSON-serializable payload. */
  data: unknown
}

export type ToolUseContext = {
  toolUseId: string
  toolName: string

  /**
   * Merged abort signal — fires on session abort, user-initiated tool stop,
   * or kill-all. Tools running long operations MUST honor this.
   */
  abortSignal: AbortSignal

  /**
   * Agent that is executing this tool. `'main'` for the user-facing thread,
   * a sub-agent id otherwise. Hooks and permission rules use this to
   * distinguish main-thread from sub-agent calls.
   */
  agentId: string
  agentType?: string
  isSubAgent: boolean

  permissionMode: ToolPermissionMode
  permissionDefaultMode: ToolPermissionDefault
  /** First-match-wins overrides from Settings → Permissions. */
  permissionRules?: ReadonlyArray<PermissionRulePayload>

  /**
   * Tool names already discovered / suggested this turn. ToolSearch and
   * suggestion-emitting tools use this to avoid suggesting the same tool
   * twice in one turn.
   */
  discoveryExclude: ReadonlySet<string>

  /**
   * Optional progress channel. When set, tools emit JSON render hints
   * during long-running operations (bash stdout, web search partials,
   * todo-list updates, etc.). When unset, tools fall back to silent
   * execution. See module docstring for IPC details.
   */
  emitToolProgress?: (progress: ToolProgressEvent) => void
}

/**
 * Inputs for {@link createToolUseContext}. Identical to `ToolUseContext` —
 * named separately so future ctx field additions can carry a different
 * "deps" shape (e.g. derived fields computed in the factory).
 */
export type CreateToolUseContextInput = ToolUseContext

export function createToolUseContext(deps: CreateToolUseContextInput): ToolUseContext {
  return { ...deps }
}
