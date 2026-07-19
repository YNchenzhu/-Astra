/**
 * Hooks type definitions — runtime constants + type re-exports.
 *
 * {@link HOOK_EVENTS} and {@link HookEvent} are **re-exported** from the
 * canonical `src/types/hooks.ts` so the renderer and the electron main process
 * share one list (audit #3/#4 fix). `HookProcessResult` / `HookProcessResponse`
 * are the shell-execution-specific types used by the engine — they are
 * intentionally separate from the renderer's `HookResult` (callback semantic
 * result), so both aliases are exported below to let callers pick the
 * disambiguated name.
 */

// ============================================================================
// Runtime Constants (re-exported from the canonical renderer types file)
// ============================================================================

export { HOOK_EVENTS } from '../../../src/types/hooks'
export type { HookEvent } from '../../../src/types/hooks'

/**
 * How the hook command is interpreted at the process boundary (§9.2).
 * For `command`: shell argv. For `http`: URL. For `prompt`/`agent`: template text or `@file:` / relative path.
 */
export type HookExecutionKind = 'command' | 'prompt' | 'agent' | 'http'

/** Special exit codes */
export const HOOK_EXIT_SUCCESS = 0
export const HOOK_EXIT_BLOCKING = 2

/**
 * Result of executing a hook (shell / process execution result).
 *
 * NOT to be confused with the renderer-side semantic `HookResult` (see
 * `src/types/hooks.ts`) which models callback outcomes. The electron-side
 * `HookResult` is raw stdio/exit data. Prefer the {@link HookProcessResult}
 * alias below in new code to make the disambiguation explicit.
 */
export interface HookResult {
  /** Exit code: 0=success, 2=blocking error */
  exitCode: number
  /** Standard output */
  stdout: string
  /** Standard error */
  stderr: string
  /** Parsed JSON output if stdout is valid JSON */
  parsedOutput?: HookResponse
}

/**
 * Disambiguated alias for the shell-execution `HookResult`. Use this in any
 * code that also imports the renderer-side `HookResult` to avoid shadowing.
 */
export type HookProcessResult = HookResult

/**
 * Parsed hook response (stdout as JSON). Controls how the agentic loop reacts.
 *
 * The renderer-side `src/types/hooks.ts` does not define `HookResponse`, but
 * `HookProcessResponse` is exported as an explicit alias to pair with
 * {@link HookProcessResult} for cross-module clarity.
 */
export interface HookResponse {
  /** Whether to continue. false stops further processing. */
  continue?: boolean
  /** Permission decision for PreToolUse hooks */
  permissionDecision?: 'allow' | 'deny' | 'ask'
  /** Modified tool input for PreToolUse hooks */
  updatedInput?: Record<string, unknown>
  /** Additional context injected into conversation */
  additionalContext?: string
  /** Warning message shown to user */
  systemMessage?: string
  /** Whether to prevent the agent from continuing */
  preventContinuation?: boolean
  /** Reason for blocking (used with preventContinuation) */
  reason?: string
  /** Modified tool output (PostToolUse) */
  updatedMCPToolOutput?: Record<string, unknown> | string
  /** Permission decision for PermissionRequest hooks */
  decision?: 'allow' | 'deny' | 'ask'
  /** Async mode: background execution without blocking */
  async?: boolean
  /** Async timeout override */
  asyncTimeout?: number
}

/** Disambiguated alias for the process-side `HookResponse`. */
export type HookProcessResponse = HookResponse

// ============================================================================
// Type Re-exports (canonical definitions in src/types/hooks.ts)
// ============================================================================

export type {
  PromptRequest,
  PromptResponse,
  HookCallbackContext,
  HookInput,
  HookJSONOutput,
  AsyncHookJSONOutput,
  SyncHookJSONOutput,
  HookCallback,
  HookCallbackMatcher,
  HookProgress,
  HookBlockingError,
  PermissionRequestResult as HookPermissionRequestResult,
} from '../../../src/types/hooks'
export { isSyncHookJSONOutput, isAsyncHookJSONOutput } from '../../../src/types/hooks'
