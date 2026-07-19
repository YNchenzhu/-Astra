/**
 * Hooks system — barrel exports.
 */

export * from './types'
export * from './config'
export {
  runHooks,
  runPostToolUseHooks,
  runPostToolUseFailureHooks,
  runPermissionRequestHooks,
  runFileChangedHooks,
  runUserPromptSubmitHooks,
  runPreCompactHooks,
  runPostCompactHooks,
  runSessionStartHooks,
  runSessionEndHooks,
  runSessionIdleHooks,
  runStopHooks,
  runSubagentStopHooks,
  type RunHooksResult,
} from './engine'
export { matchesPattern } from './config'
export {
  isResearchPhaseTodoSubject,
  hasSkillTaskCompletedSince,
} from './verificationHook'

// Zod validation schemas for hook output
export {
  hookJSONOutputSchema,
  syncHookResponseSchema,
  asyncHookResponseSchema,
  permissionBehaviorSchema,
  isHookEvent,
  validateHookOutput,
  validateHookOutputForEvent,
} from './hookSchema'
export type { SchemaHookJSONOutput, SyncHookResponse, AsyncHookResponse } from './hookSchema'
export type { AggregatedHookResult } from './hookNormalize'
export {
  normalizeHookJsonToResponse,
  hookStdoutToResponse,
  aggregateHookResponses,
  mergeHookResponse,
} from './hookNormalize'
