/**
 * Zod schemas for hook JSON output validation.
 *
 * Validates the stdout JSON returned by external hook commands to ensure
 * it matches the expected shape for the configured hook event.
 *
 * Each hook event has a specific `hookSpecificOutput` shape (mirroring
 * upstream's syncHookResponseSchema). Hooks without valid output are
 * treated as fire-and-forget (exit code 0 = success).
 */

import { z } from 'zod'
import { HOOK_EVENTS, type HookEvent } from './types'

// ============================================================================
// Permission behavior schema (shared across hooks)
// ============================================================================

export const permissionBehaviorSchema = z.enum(['allow', 'deny', 'ask'])

// ============================================================================
// Common fields shared by all hook responses
// ============================================================================

const commonHookFields = z.object({
  continue: z.boolean().optional(),
  suppressOutput: z.boolean().optional(),
  stopReason: z.string().optional(),
  decision: z.enum(['approve', 'block']).optional(),
  reason: z.string().optional(),
  systemMessage: z.string().optional(),
  preventContinuation: z.boolean().optional(),
  additionalContext: z.string().optional(),
})

// ============================================================================
// Event-specific hookSpecificOutput schemas
// ============================================================================

const preToolUseOutput = z.object({
  hookEventName: z.literal('PreToolUse'),
  permissionDecision: permissionBehaviorSchema.optional(),
  permissionDecisionReason: z.string().optional(),
  updatedInput: z.record(z.string(), z.unknown()).optional(),
  additionalContext: z.string().optional(),
})

const userPromptSubmitOutput = z.object({
  hookEventName: z.literal('UserPromptSubmit'),
  additionalContext: z.string().optional(),
})

const sessionStartOutput = z.object({
  hookEventName: z.literal('SessionStart'),
  additionalContext: z.string().optional(),
  initialUserMessage: z.string().optional(),
  watchPaths: z.array(z.string()).optional(),
})

const sessionEndOutput = z.object({
  hookEventName: z.literal('SessionEnd'),
  additionalContext: z.string().optional(),
})

const sessionIdleOutput = z.object({
  hookEventName: z.literal('SessionIdle'),
  additionalContext: z.string().optional(),
})

const preSkillUseOutput = z.object({
  hookEventName: z.literal('PreSkillUse'),
  additionalContext: z.string().optional(),
})

const postSkillUseOutput = z.object({
  hookEventName: z.literal('PostSkillUse'),
  additionalContext: z.string().optional(),
})

const setupOutput = z.object({
  hookEventName: z.literal('Setup'),
  additionalContext: z.string().optional(),
})

const subagentStartOutput = z.object({
  hookEventName: z.literal('SubagentStart'),
  additionalContext: z.string().optional(),
})

const postToolUseOutput = z.object({
  hookEventName: z.literal('PostToolUse'),
  additionalContext: z.string().optional(),
  updatedMCPToolOutput: z.unknown().optional(),
})

const postToolUseFailureOutput = z.object({
  hookEventName: z.literal('PostToolUseFailure'),
  additionalContext: z.string().optional(),
})

const permissionRequestOutput = z.object({
  hookEventName: z.literal('PermissionRequest'),
  decision: z
    .union([
      z.object({
        behavior: z.literal('allow'),
        updatedInput: z.record(z.string(), z.unknown()).optional(),
      }),
      z.object({
        behavior: z.literal('deny'),
        message: z.string().optional(),
        interrupt: z.boolean().optional(),
      }),
    ])
    .optional(),
})

const elicitationOutput = z.object({
  hookEventName: z.literal('Elicitation'),
  action: z.enum(['accept', 'decline', 'cancel']).optional(),
  content: z.record(z.string(), z.unknown()).optional(),
})

const elicitationResultOutput = z.object({
  hookEventName: z.literal('ElicitationResult'),
  action: z.enum(['accept', 'decline', 'cancel']).optional(),
  content: z.record(z.string(), z.unknown()).optional(),
})

const cwdChangedOutput = z.object({
  hookEventName: z.literal('CwdChanged'),
  watchPaths: z.array(z.string()).optional(),
})

const fileChangedOutput = z.object({
  hookEventName: z.literal('FileChanged'),
  watchPaths: z.array(z.string()).optional(),
})

const worktreeCreateOutput = z.object({
  hookEventName: z.literal('WorktreeCreate'),
  worktreePath: z.string(),
})

const notificationOutput = z.object({
  hookEventName: z.literal('Notification'),
  additionalContext: z.string().optional(),
})

const preCompactOutput = z.object({
  hookEventName: z.literal('PreCompact'),
  additionalContext: z.string().optional(),
})

const postCompactOutput = z.object({
  hookEventName: z.literal('PostCompact'),
  additionalContext: z.string().optional(),
})

const subagentOutput = z.object({
  hookEventName: z.literal('Subagent'),
  additionalContext: z.string().optional(),
})

const permissionDeniedOutput = z.object({
  hookEventName: z.literal('PermissionDenied'),
  retry: z.boolean().optional(),
})

// ============================================================================
// Full sync hook response schema
// ============================================================================

/**
 * Schema for a synchronous hook response.
 * The `hookSpecificOutput` discriminates on the hook event name.
 */
export const syncHookResponseSchema = z.object({
  ...commonHookFields.shape,
  hookSpecificOutput: z
    .union([
      preToolUseOutput,
      userPromptSubmitOutput,
      sessionStartOutput,
      sessionEndOutput,
      sessionIdleOutput,
      preSkillUseOutput,
      postSkillUseOutput,
      setupOutput,
      subagentStartOutput,
      postToolUseOutput,
      postToolUseFailureOutput,
      permissionDeniedOutput,
      notificationOutput,
      permissionRequestOutput,
      elicitationOutput,
      elicitationResultOutput,
      cwdChangedOutput,
      fileChangedOutput,
      worktreeCreateOutput,
      preCompactOutput,
      postCompactOutput,
      subagentOutput,
    ])
    .optional(),
})

/**
 * Schema for an asynchronous hook response.
 * Marked with `async: true` to signal non-blocking execution.
 */
export const asyncHookResponseSchema = z.object({
  async: z.literal(true),
  asyncTimeout: z.number().optional(),
})

/**
 * Union schema for any valid hook JSON output.
 */
export const hookJSONOutputSchema = z.union([asyncHookResponseSchema, syncHookResponseSchema])

export type SchemaHookJSONOutput = z.infer<typeof hookJSONOutputSchema>
export type SyncHookResponse = z.infer<typeof syncHookResponseSchema>
export type AsyncHookResponse = z.infer<typeof asyncHookResponseSchema>

// ============================================================================
// Validation helpers
// ============================================================================

/**
 * Validate hook stdout as JSON against the schema.
 * Returns parsed output on success, or an error message on failure.
 */
export function validateHookOutput(
  stdout: string,
): { ok: true; data: SchemaHookJSONOutput } | { ok: false; error: string } {
  if (!stdout.trim()) {
    return { ok: true, data: {} as SchemaHookJSONOutput }
  }

  try {
    const parsed = JSON.parse(stdout)
    const result = hookJSONOutputSchema.safeParse(parsed)
    if (result.success) {
      return { ok: true, data: result.data }
    }
    const issues = result.error.issues
      .map((i) => {
        const p = i.path.length ? i.path.join('.') : '(root)'
        return `${p}: ${i.message}`
      })
      .join('; ')
    return { ok: false, error: `Hook output validation failed: ${issues}` }
  } catch (e) {
    return { ok: false, error: `Hook output is not valid JSON: ${(e as Error).message}` }
  }
}

/**
 * Validate hook stdout against the event-specific schema.
 * More targeted than validateHookOutput — checks the hookSpecificOutput
 * shape matches the expected event.
 */
export function validateHookOutputForEvent(
  stdout: string,
  event: HookEvent,
): { ok: true; data: SchemaHookJSONOutput } | { ok: false; error: string } {
  const base = validateHookOutput(stdout)
  if (!base.ok) return base

  const data = base.data
  if ('hookSpecificOutput' in data && data.hookSpecificOutput) {
    const hso = data.hookSpecificOutput as Record<string, unknown>
    if (hso.hookEventName !== event) {
      return {
        ok: false,
        error: `hookSpecificOutput.hookEventName (${String(hso.hookEventName)}) does not match configured event (${event})`,
      }
    }
  }

  return { ok: true, data }
}

/**
 * Check if the given event name is a valid HookEvent.
 */
export function isHookEvent(value: string): value is HookEvent {
  return (HOOK_EVENTS as readonly string[]).includes(value)
}
