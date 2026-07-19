/**
 * Skill-level dynamic Hook registry.
 *
 * Declarative hooks use `command` (shell, cwd = skill directory); stdout JSON matches global hooks.
 * Bundled skills may attach `handler` functions in code.
 *
 * Registration: initSkills() calls registerSkillHooks for each loaded skill that has hooks.
 */

import path from 'node:path'
import type { HookEvent, HookResponse } from '../tools/hooks/types'
import { getEnvVars } from '../tools/hooks/config'
import { buildClaudeCodeHookStdinPayload } from '../tools/hooks/hookPayload'
import {
  execHook,
  resolveHookTimeoutMs,
  resultToResponse,
  type AsyncHookResult,
} from '../tools/hooks/execCommand'
import { shouldDeferPromptOrAgentHook } from '../tools/hooks/hookLlmExecution'
import type { SkillHookSpec, SkillHookContext, SkillHookDecision } from './types'

/** Internal representation of a registered skill hook */
interface RegisteredSkillHook {
  skillName: string
  spec: SkillHookSpec
  active: boolean
}

const registry = new Map<string, RegisteredSkillHook[]>()
/** Skill install directory (SKILL.md parent) — hook commands run with this cwd */
const skillInstallRoots = new Map<string, string>()

function skillDecisionToHookResponse(d: SkillHookDecision): HookResponse {
  return {
    continue: d.continue,
    reason: d.reason,
    permissionDecision: d.permissionDecision,
    decision: d.decision,
    updatedInput: d.updatedInput,
    preventContinuation: d.preventContinuation,
    additionalContext: d.additionalContext,
    systemMessage: d.systemMessage,
  }
}

export function buildSkillHookEnv(
  ctx: SkillHookContext,
  event: string,
  hookCwd: string,
  executionKind?: string,
): Record<string, string> {
  const configuredEnv = getEnvVars()
  const projectDir = ctx.cwd || hookCwd
  const toolInput: Record<string, unknown> =
    ctx.toolInput !== undefined ? (ctx.toolInput as Record<string, unknown>) : {}
  const toolInputStr =
    ctx.toolInput !== undefined ? JSON.stringify(ctx.toolInput) : ctx.argumentsStr
  const stdinPayload = buildClaudeCodeHookStdinPayload({
    event: event as HookEvent,
    toolName: ctx.toolName || '',
    toolInput,
    cwd: projectDir,
    extraEnv: { CLAUDE_TOOL_OUTPUT: '', CLAUDE_TOOL_SUCCESS: '' },
  })
  return {
    ...configuredEnv,
    CLAUDE_HOOK_EVENT: event,
    CLAUDE_HOOK_EXECUTION_KIND: executionKind ?? 'command',
    CLAUDE_TOOL_NAME: ctx.toolName || '',
    CLAUDE_TOOL_INPUT: toolInputStr,
    CLAUDE_HOOK_STDIN_JSON: JSON.stringify(stdinPayload),
    CLAUDE_TOOL_OUTPUT: '',
    CLAUDE_CWD: projectDir,
    CLAUDE_PROJECT_DIR: projectDir,
    ASTRA_SKILL_NAME: ctx.skillName,
    ASTRA_SKILL_ROOT: hookCwd,
  }
}

/**
 * Register hooks for a skill. Called from initSkills after filesystem + bundled load.
 */
export function registerSkillHooks(
  skillName: string,
  hooks: SkillHookSpec[],
  skillInstallRoot?: string,
): void {
  registry.delete(skillName)

  if (skillInstallRoot) {
    skillInstallRoots.set(skillName, path.resolve(skillInstallRoot))
  } else {
    skillInstallRoots.delete(skillName)
  }

  if (hooks.length === 0) {
    return
  }

  const registered: RegisteredSkillHook[] = hooks.map((spec) => ({
    skillName,
    spec,
    active: true,
  }))

  registry.set(skillName, registered)
  console.log(`[SkillHookRegistry] Registered ${registered.length} hooks for skill: ${skillName}`)
}

export function unregisterSkillHooks(skillName: string): void {
  registry.delete(skillName)
  skillInstallRoots.delete(skillName)
}

export function clearSkillHookRegistry(): void {
  registry.clear()
  skillInstallRoots.clear()
}

export function getSkillHookInstallRoot(skillName: string): string | undefined {
  return skillInstallRoots.get(skillName)
}

/**
 * Audit fix G-6 (2026-05) — `workspacePattern` was previously fed to
 * `RegExp` directly after only escaping `*` → `.*`. Windows paths contain
 * `(`, `)`, `.`, and backslashes that all carry regex meaning, so a real
 * cwd like `C:\Users\foo (work)\repo` blew up matcher behaviour
 * completely. Both patterns now share the same escape-then-glob recipe
 * the `toolPattern` branch already used. This keeps wildcards (`*`)
 * working while treating everything else as literal text — matching what
 * users almost certainly mean when they author hooks.
 */
function globMatcherToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`, 'i')
}

function matchesMatcher(
  matcher: SkillHookSpec['matcher'],
  cwd?: string,
  toolName?: string,
): boolean {
  if (!matcher) return true
  if (matcher.workspacePattern && cwd) {
    if (!globMatcherToRegExp(matcher.workspacePattern).test(cwd)) return false
  }
  if (matcher.toolPattern) {
    if (!toolName) return false
    if (!globMatcherToRegExp(matcher.toolPattern).test(toolName)) return false
  }
  return true
}

export function getSkillHooksForEvent(
  skillName: string,
  event: string,
  cwd?: string,
  toolName?: string,
): SkillHookSpec[] {
  const hooks = registry.get(skillName) || []
  return hooks
    .filter((h) => h.active && h.spec.event === event)
    .filter((h) => matchesMatcher(h.spec.matcher, cwd, toolName))
    .map((h) => h.spec)
}

export function hasSkillHooks(skillName: string): boolean {
  const hooks = registry.get(skillName) || []
  return hooks.some((h) => h.active)
}

/** Skill names that have at least one active hook for `event` (matcher included). */
export function listSkillNamesWithHooksForEvent(
  event: HookEvent,
  cwd: string,
  toolName?: string,
): string[] {
  const out: string[] = []
  for (const name of registry.keys()) {
    if (getSkillHooksForEvent(name, event, cwd, toolName).length > 0) {
      out.push(name)
    }
  }
  return out
}

/**
 * Run one skill hook: programmatic handler and/or shell command (JSON stdout like global hooks).
 */
export async function evaluateSkillHook(
  spec: SkillHookSpec,
  ctx: SkillHookContext,
): Promise<HookResponse | null> {
  const root = getSkillHookInstallRoot(ctx.skillName)
  const hookCwd = root || ctx.cwd || process.cwd()

  if (typeof spec.handler === 'function') {
    try {
      const d = await spec.handler(ctx)
      if (!d) return null
      return skillDecisionToHookResponse(d)
    } catch (err) {
      console.error(`[SkillHookRegistry] Hook handler failed for ${ctx.skillName}:`, err)
      return {
        continue: false,
        preventContinuation: true,
        reason: `Skill hook error: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  if (spec.command?.trim()) {
    if (shouldDeferPromptOrAgentHook(spec.executionKind ?? 'command')) {
      console.warn(
        `[SkillHookRegistry] Skipping nested ${spec.executionKind ?? 'command'} hook for skill ${ctx.skillName}`,
      )
      return null
    }
    const env = buildSkillHookEnv(ctx, String(spec.event), hookCwd, spec.executionKind ?? 'command')
    const kind = spec.executionKind ?? 'command'
    const rawResult = await execHook({
      command: spec.command.trim(),
      env,
      cwd: hookCwd,
      timeoutMs:
        spec.timeoutMs ??
        resolveHookTimeoutMs(spec.event as HookEvent, kind),
      async: spec.async,
      asyncRewake: spec.asyncRewake,
      executionKind: kind,
    })

    if ('onComplete' in rawResult) {
      const asyncResult = rawResult as AsyncHookResult
      asyncResult.onComplete
        .then((final) => {
          const r = resultToResponse(final)
          if (r?.reason) console.log(`[SkillHookRegistry] Async skill hook done: ${r.reason}`)
        })
        .catch(() => {})
      return null
    }

    return resultToResponse(rawResult) ?? null
  }

  return null
}
