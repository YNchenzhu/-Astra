/**
 * Bridges agenticLoop ↔ hooks engine (upstream–style lifecycle).
 */

import type { HookResponse } from '../tools/hooks/types'
import {
  runHooks,
  runPostToolUseHooks,
  runPostToolUseFailureHooks,
  runPermissionRequestHooks,
} from '../tools/hooks/engine'
import { getWorkspacePath } from '../tools/workspaceState'
import { toolRegistry } from '../tools/registry'
import { validateToolZodInput } from '../tools/toolInputZod'
import type { ToolResult } from '../tools/types'

export function hookWorkspaceCwd(): string {
  return getWorkspacePath() || process.cwd()
}

export function hookResponseBlocksExecution(response: HookResponse | undefined): boolean {
  if (!response) return false
  if (response.continue === false || response.preventContinuation) return true
  if (response.permissionDecision === 'deny' || response.decision === 'deny') return true
  return false
}

/**
 * Distinct from {@link hookResponseBlocksExecution}: a hook returning
 * `continue: false` / `preventContinuation: true` is asking the *entire
 * agentic loop* to terminate, not merely denying *this* tool call.
 *
 * The agentic loop translates this into a `hook_stopped` termination
 * reason instead of feeding the model a `tool_result: Error: ...` and
 * letting it try a different approach (which is what `permissionDecision:
 * deny` correctly enables).
 */
export function hookResponseRequestsLoopStop(
  response: HookResponse | undefined,
): boolean {
  if (!response) return false
  return response.continue === false || response.preventContinuation === true
}

/**
 * Merge a hook's `updatedInput` into the tool input and re-validate the
 * result against the tool's Zod schema (audit B-P0-2 hooks: hook JSON is
 * config-file-sourced data and used to be shallow-merged unvalidated,
 * letting a poisoned hook rewrite `filePath` / `command` to arbitrary
 * shapes AFTER the loop's own Zod pass had already run).
 *
 * On validation failure the tool call must FAIL — silently dropping the
 * hook's rewrite could execute the very action the hook tried to redirect.
 */
export function mergeHookUpdatedInputValidated(
  toolName: string,
  base: Record<string, unknown>,
  response: HookResponse | undefined,
): { ok: true; input: Record<string, unknown> } | { ok: false; reason: string } {
  if (!response?.updatedInput) return { ok: true, input: base }
  const merged = { ...base, ...response.updatedInput }
  const tool = toolRegistry.get(toolName)
  // Unknown tool (e.g. MCP tool not in the registry snapshot): keep the
  // merge — downstream execution validates/fails on its own.
  if (!tool) return { ok: true, input: merged }
  const zod = validateToolZodInput(tool, merged)
  if (!zod.ok) {
    return {
      ok: false,
      reason: `Hook updatedInput for "${toolName}" failed the tool's input schema and was rejected: ${zod.message}`,
    }
  }
  return { ok: true, input: zod.data }
}

/** PreToolUse: block or rewrite input via hook stdout JSON / exit 2 */
export async function runPreToolUsePhase(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  /** When set, skill-scoped hooks from hooks.json / frontmatter run in addition to global hooks */
  skillScope?: string,
): Promise<{
  blocked: boolean
  reason?: string
  input: Record<string, unknown>
  /**
   * True when the hook block is a *loop-stop* request (continue:false /
   * preventContinuation), not merely a per-tool deny. Body propagates
   * this to AgentContext for the agentic loop to translate into a
   * `hook_stopped` termination.
   */
  loopStopRequested?: boolean
}> {
  const { response } = await runHooks('PreToolUse', toolName, input, cwd, undefined, skillScope)
  if (hookResponseBlocksExecution(response)) {
    return {
      blocked: true,
      reason: response?.reason || response?.systemMessage || 'Hook blocked this tool call',
      input,
      ...(hookResponseRequestsLoopStop(response) ? { loopStopRequested: true } : {}),
    }
  }
  const merged = mergeHookUpdatedInputValidated(toolName, input, response)
  if (!merged.ok) {
    return { blocked: true, reason: merged.reason, input }
  }
  return { blocked: false, input: merged.input }
}

export function permissionHookAutoAllow(response: HookResponse | undefined): boolean {
  return response?.decision === 'allow' || response?.permissionDecision === 'allow'
}

export function permissionHookAutoDeny(response: HookResponse | undefined): boolean {
  return response?.decision === 'deny' || response?.permissionDecision === 'deny'
}

export async function runPermissionHookPhase(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  skillScope?: string,
): Promise<{ response: HookResponse | undefined }> {
  const { response } = await runPermissionRequestHooks(toolName, input, cwd, skillScope)
  return { response }
}

/** PreSkillUse: block skill load via hook stdout JSON / exit 2 (upstream §9). */
export async function runPreSkillUsePhase(
  skillName: string,
  input: Record<string, unknown>,
  cwd: string,
): Promise<{ blocked: boolean; reason?: string }> {
  const { response } = await runHooks('PreSkillUse', skillName, input, cwd, undefined, skillName)
  if (hookResponseBlocksExecution(response)) {
    return {
      blocked: true,
      reason: response?.reason || response?.systemMessage || 'PreSkillUse hook blocked this skill',
    }
  }
  return { blocked: false }
}

/** PostSkillUse — best-effort; does not block skill results. */
export async function runPostSkillUseHooksSafe(
  skillName: string,
  payload: Record<string, unknown>,
  cwd: string,
  success: boolean,
  error?: string,
): Promise<void> {
  try {
    const extraEnv: Record<string, string> = {
      CLAUDE_TOOL_SUCCESS: success ? 'true' : 'false',
      CLAUDE_TOOL_OUTPUT: JSON.stringify({ success, ...(error ? { error } : {}) }),
    }
    await runHooks(
      'PostSkillUse',
      skillName,
      { ...payload, success, ...(error ? { error } : {}) },
      cwd,
      extraEnv,
      skillName,
    )
  } catch (err) {
    console.warn('[SkillHooks] PostSkillUse hook error:', err)
  }
}

export async function runPostToolHooksSafe(
  toolName: string,
  input: Record<string, unknown>,
  result: ToolResult,
  cwd: string,
  skillScope?: string,
): Promise<void> {
  try {
    if (result.success) {
      await runPostToolUseHooks(toolName, input, result, cwd, skillScope)
    } else {
      await runPostToolUseFailureHooks(
        toolName,
        input,
        result.error || 'Unknown error',
        cwd,
        skillScope,
      )
    }
  } catch (err) {
    console.warn('[AgenticLoop] PostToolUse hook error:', err)
  }
}
