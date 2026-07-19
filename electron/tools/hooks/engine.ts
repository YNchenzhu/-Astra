/**
 * Hooks execution engine.
 *
 * upstream invariant: hook `allow` must not bypass settings deny/ask — merge uses deny over ask over allow.
 *
 * Orchestrates the lifecycle of hooks:
 * 1. Fetches hooks for the given event from config (with matcher filtering)
 * 2. Builds environment with tool context
 * 3. Executes each hook command sequentially (or async for background hooks)
 * 4. Aggregates results into a HookResponse
 * 5. Merges skill-level hooks from the dynamic registry
 *
 * Usage:
 *   const response = await runPreToolUseHooks(toolName, toolInput, cwd)
 *   if (response?.permissionDecision === 'deny') { ... block ... }
 */

import type { HookEvent, HookExecutionKind, HookResult, HookResponse } from './types'
import { getHooksForEvent, hasHooksForEvent, getEnvVars, isHooksDisabled } from './config'
import {
  defaultTimeoutMsForHookKind,
  execHook,
  resultToResponse,
  resolveHookTimeoutMs,
  type AsyncHookResult,
  type CommandHookInput,
} from './execCommand'
import { buildClaudeCodeHookStdinPayload } from './hookPayload'
import {
  aggregateHookResponses,
  mergeHookResponse,
  type AggregatedHookResult,
} from './hookNormalize'
import type { ToolResult } from '../types'
import {
  getSkillHooksForEvent,
  hasSkillHooks,
  evaluateSkillHook,
  registerSkillHooks,
  buildSkillHookEnv,
  getSkillHookInstallRoot,
  listSkillNamesWithHooksForEvent,
} from '../../skills/skillHooks'
import type { SkillHookContext } from '../../skills/types'
import { getAgentContext } from '../../agents/agentContext'
import { matchesPattern } from './config'
import { shouldDeferPromptOrAgentHook } from './hookLlmExecution'
import { emitHookLifecycle } from './hookLifecycleEvents'

/**
 * Build environment variables for a hook process.
 * Sets `CLAUDE_HOOK_STDIN_JSON` to the upstream stdin / HTTP body shape (plus legacy `CLAUDE_TOOL_INPUT`).
 */
function buildHookEnv(
  event: HookEvent,
  toolName: string,
  toolInput: Record<string, unknown>,
  extraEnv?: Record<string, string>,
): Record<string, string> {
  const configuredEnv = getEnvVars()
  const cwd = extraEnv?.CLAUDE_CWD || process.cwd()
  const payload = buildClaudeCodeHookStdinPayload({
    event,
    toolName,
    toolInput,
    cwd,
    extraEnv,
  })
  const stdinJson = JSON.stringify(payload)
  return {
    CLAUDE_HOOK_EVENT: event,
    CLAUDE_TOOL_NAME: toolName,
    CLAUDE_TOOL_INPUT: JSON.stringify(toolInput),
    CLAUDE_HOOK_STDIN_JSON: stdinJson,
    CLAUDE_TOOL_OUTPUT: extraEnv?.CLAUDE_TOOL_OUTPUT ?? '',
    CLAUDE_TOOL_SUCCESS: extraEnv?.CLAUDE_TOOL_SUCCESS ?? '',
    CLAUDE_CWD: cwd,
    CLAUDE_PROJECT_DIR: cwd,
    ...configuredEnv,
    ...extraEnv,
  }
}

// Audit #4/#5 — `mergeResponse` used to live here with a slightly different
// `updatedMCPToolOutput` falsy check than {@link mergeHookResponse}. The
// duplicate has been removed; both blocking-merge and aggregated-merge now go
// through the single `mergeHookResponse` implementation so they can never
// diverge on edge cases (e.g. empty-string MCP output overrides).
const mergeResponse = mergeHookResponse

/**
 * Run hooks for a given event with tool context.
 *
 * Hooks execute sequentially. The first hook that returns a blocking response
 * (exit code 2 or parsed JSON with `continue: false`) short-circuits remaining hooks.
 * Async hooks skip blocking checks and run in background.
 *
 * @param event - The lifecycle event
 * @param toolName - The tool being used (used for matching)
 * @param toolInput - The tool's input parameters
 * @param cwd - Working directory
 * @param extraEnv - Additional environment variables
 * @param skillScope - Optional skill name to also run skill-level hooks
 * @returns Combined HookResponse, or undefined if no blocking hooks
 */
export type RunHooksResult = {
  response: HookResponse | undefined
  results: HookResult[]
  aggregated: AggregatedHookResult
}

export async function runHooks(
  event: HookEvent,
  toolName: string,
  toolInput: Record<string, unknown>,
  cwd: string,
  extraEnv?: Record<string, string>,
  skillScope?: string,
): Promise<RunHooksResult> {

  // (Audit 2026-05) The built-in `evaluateTodoWriteCompletionGate`
  // PreToolUse hook used to live here. It was a no-op pass-through
  // because nothing in the codebase produced `source: 'todo_sync'`
  // TaskManager rows for the gate's lookup to match against. The
  // dead branch was deleted as part of the upstream parity cleanup;
  // a future implementation should also wire `TodoWrite completed →
  // taskManager.create({ source: 'todo_sync', ... })` before
  // restoring the gate. See `verificationHook.ts` for the kept
  // helpers (`isResearchPhaseTodoSubject` /
  // `hasSkillTaskCompletedSince`).

  const results: HookResult[] = []
  const normalizedPerHook: Array<import('./types').HookResponse | undefined> = []
  let blockingResponse: HookResponse | undefined

  // ── Step 1: Global config-based hooks ──
  if (hasHooksForEvent(event, toolName)) {
    const eventHooks = getHooksForEvent(event, toolName)

    for (const hook of eventHooks) {
      if (shouldDeferPromptOrAgentHook(hook.executionKind ?? 'command')) {
        console.warn(
          `[Hooks] Skipping nested ${hook.executionKind ?? 'command'} hook for event ${event} (${toolName})`,
        )
        continue
      }
      const env = buildHookEnv(event, toolName, toolInput, {
        ...extraEnv,
        CLAUDE_CWD: cwd,
        CLAUDE_HOOK_EXECUTION_KIND: hook.executionKind ?? 'command',
      })

      const kind = hook.executionKind ?? 'command'
      const execInput: CommandHookInput = {
        command: hook.command,
        env,
        cwd,
        async: hook.async,
        asyncRewake: hook.asyncRewake,
        executionKind: kind,
        timeoutMs: resolveHookTimeoutMs(event, kind),
      }

      emitHookLifecycle({
        phase: 'before',
        event,
        toolName,
        hookId: hook.id,
        command: hook.command,
        executionKind: kind,
        source: 'config',
      })

      const rawResult = await execHook(execInput)

      // Async hook: don't block, just track it
      if ('onComplete' in rawResult) {
        const asyncResult = rawResult as AsyncHookResult
        normalizedPerHook.push({ async: true })
        results.push({
          exitCode: 0,
          stdout: `Async hook started (pid: ${asyncResult.pid ?? '?'})`,
          stderr: '',
          parsedOutput: { async: true },
        })
        // Fire-and-forget: async hooks run in background
        asyncResult.onComplete
          .then((finalResult) => {
            const resp = resultToResponse(finalResult)
            if (resp?.reason) {
              console.log(`[Hooks] Async hook completed: ${resp.reason}`)
            }
          })
          .catch((err) => {
            // BUG-H2 fix: surface async hook completion failures so that
            // hook authors can diagnose them. Previously these errors
            // were swallowed silently — a hook intended to block (e.g.
            // `continue: false`) that itself crashed during async exec
            // would let the action proceed without any trace.
            console.warn(
              `[Hooks] Async hook execution failed (event=${event}, hook=${hook.id ?? hook.command}):`,
              err instanceof Error ? err.message : String(err),
            )
          })
        continue
      }

      const result = rawResult as HookResult
      emitHookLifecycle({
        phase: 'after',
        event,
        toolName,
        hookId: hook.id,
        command: hook.command,
        executionKind: kind,
        exitCode: result.exitCode,
        source: 'config',
      })
      results.push(result)

      // Check for blocking condition
      const resp = resultToResponse(result)
      normalizedPerHook.push(resp)
      if (resp) {
        blockingResponse = mergeResponse(blockingResponse, resp)

        if (resp.continue === false || resp.preventContinuation || resp.permissionDecision === 'deny' || resp.decision === 'deny') {
          break
        }
      }
    }
  }

  // ── Step 1b: Per-agent hooks (markdown frontmatter `hooks` JSON on custom agents) ──
  // Audit #6 — align with Step 2 (skill hooks) by doing the blocking-check
  // inside the loop instead of pre-filtering outside. Same behavior, but no
  // longer looks like two unrelated strategies.
  const agentCtx = getAgentContext()
  const agentHookSpecs = agentCtx?.runtimeHooks?.filter((h) => h.event === event) ?? []
  for (const hook of agentHookSpecs) {
    if (
      blockingResponse?.continue === false ||
      blockingResponse?.permissionDecision === 'deny' ||
      blockingResponse?.decision === 'deny'
    ) {
      break // Already blocked by config hooks — stop running agent hooks.
    }
    if (!matchesPattern(toolName, hook.matcher)) continue
    if (shouldDeferPromptOrAgentHook(hook.executionKind ?? 'command')) {
      console.warn(
        `[Hooks] Skipping nested ${hook.executionKind ?? 'command'} agent-hook for event ${event} (${toolName})`,
      )
      continue
    }

    const env = buildHookEnv(event, toolName, toolInput, {
      ...extraEnv,
      CLAUDE_CWD: cwd,
      CLAUDE_AGENT_ID: agentCtx?.agentId ?? '',
      CLAUDE_HOOK_EXECUTION_KIND: hook.executionKind ?? 'command',
    })

    const kind = hook.executionKind ?? 'command'
    const execInput: CommandHookInput = {
      command: hook.command,
      env,
      cwd,
      async: hook.async,
      asyncRewake: undefined,
      executionKind: kind,
      timeoutMs: resolveHookTimeoutMs(event, kind),
    }

    emitHookLifecycle({
      phase: 'before',
      event,
      toolName,
      command: hook.command,
      executionKind: kind,
      source: 'agent',
    })

    const rawResult = await execHook(execInput)

    if ('onComplete' in rawResult) {
      const asyncResult = rawResult as AsyncHookResult
      normalizedPerHook.push({ async: true })
      results.push({
        exitCode: 0,
        stdout: `Async agent-hook started (pid: ${asyncResult.pid ?? '?'})`,
        stderr: '',
        parsedOutput: { async: true },
      })
      asyncResult.onComplete
        .then((finalResult) => {
          const resp = resultToResponse(finalResult)
          if (resp?.reason) {
            console.log(`[Hooks] Async agent-hook completed: ${resp.reason}`)
          }
        })
        .catch((err) => {
          // BUG-H2 fix: same rationale as the config-hook async branch
          // above — surface failures instead of dropping them.
          console.warn(
            `[Hooks] Async agent-hook execution failed (event=${event}):`,
            err instanceof Error ? err.message : String(err),
          )
        })
      continue
    }

    const result = rawResult as HookResult
    emitHookLifecycle({
      phase: 'after',
      event,
      toolName,
      command: hook.command,
      executionKind: kind,
      exitCode: result.exitCode,
      source: 'agent',
    })
    results.push(result)

    const resp = resultToResponse(result)
    normalizedPerHook.push(resp)
    if (resp) {
      blockingResponse = mergeResponse(blockingResponse, resp)

      if (
        resp.continue === false ||
        resp.preventContinuation ||
        resp.permissionDecision === 'deny' ||
        resp.decision === 'deny'
      ) {
        break
      }
    }
  }

  // ── Step 2: Skill-level dynamic hooks (阶段一 & 三) ──
  if (skillScope && hasSkillHooks(skillScope)) {
    const skillHookSpecs = getSkillHooksForEvent(skillScope, event, cwd, toolName)

    for (const hookSpec of skillHookSpecs) {
      if (
        blockingResponse?.continue === false ||
        blockingResponse?.permissionDecision === 'deny' ||
        blockingResponse?.decision === 'deny'
      ) {
        break // Already blocked by global hooks
      }

      const hookCtx: SkillHookContext = {
        skillName: skillScope,
        skillContext: 'inline',
        argumentsStr: JSON.stringify(toolInput),
        cwd,
        toolName,
        toolInput,
      }

      const hookResp = await evaluateSkillHook(hookSpec, hookCtx)
      normalizedPerHook.push(hookResp ?? undefined)
      if (hookResp) {
        blockingResponse = mergeResponse(blockingResponse, hookResp)

        if (
          hookResp.continue === false ||
          hookResp.preventContinuation ||
          hookResp.permissionDecision === 'deny' ||
          hookResp.decision === 'deny'
        ) {
          break
        }
      }
    }
  }

  const aggregated: AggregatedHookResult = {
    merged: aggregateHookResponses(normalizedPerHook) || blockingResponse,
    normalizedPerHook,
  }

  return { response: blockingResponse, results, aggregated }
}

/**
 * Run PostToolUse hooks after tool execution.
 * These can inject additional context or modify tool output.
 */
export async function runPostToolUseHooks(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolResult: ToolResult,
  cwd: string,
  skillScope?: string,
): Promise<RunHooksResult> {
  return runHooks(
    'PostToolUse',
    toolName,
    toolInput,
    cwd,
    {
      CLAUDE_TOOL_OUTPUT: JSON.stringify(toolResult),
      CLAUDE_TOOL_SUCCESS: String(toolResult.success),
    },
    skillScope,
  )
}

/**
 * Run PostToolUseFailure hooks after a tool execution error.
 */
export async function runPostToolUseFailureHooks(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolError: string,
  cwd: string,
  skillScope?: string,
): Promise<RunHooksResult> {
  return runHooks(
    'PostToolUseFailure',
    toolName,
    toolInput,
    cwd,
    {
      CLAUDE_TOOL_OUTPUT: JSON.stringify({ success: false, error: toolError }),
      CLAUDE_TOOL_SUCCESS: 'false',
    },
    skillScope,
  )
}

/**
 * Run PermissionRequest hooks before prompting the user.
 * These hooks can auto-approve or auto-deny the request.
 */
export async function runPermissionRequestHooks(
  toolName: string,
  toolInput: Record<string, unknown>,
  cwd: string,
  skillScope?: string,
): Promise<RunHooksResult> {
  return runHooks(
    'PermissionRequest',
    toolName,
    toolInput,
    cwd,
    undefined,
    skillScope,
  )
}

/**
 * Run FileChanged hooks after a file is modified.
 */
export async function runFileChangedHooks(
  filePath: string,
  cwd: string,
): Promise<RunHooksResult> {
  return runHooks(
    'FileChanged',
    'fs',
    { filePath },
    cwd,
  )
}

/**
 * Run SessionStart hooks when a new session begins.
 */
export async function runSessionStartHooks(
  workspacePath: string,
  cwd: string,
): Promise<RunHooksResult> {
  return runHooks(
    'SessionStart',
    'session',
    { workspacePath },
    cwd,
    { CLAUDE_WORKSPACE: workspacePath },
  )
}

/**
 * Run SessionEnd hooks when a session ends.
 */
export async function runSessionEndHooks(
  workspacePath: string,
  cwd: string,
): Promise<RunHooksResult> {
  return runHooks(
    'SessionEnd',
    'session',
    { workspacePath },
    cwd,
    { CLAUDE_WORKSPACE: workspacePath },
  )
}

/**
 * Run SessionIdle hooks after a period of inactivity (debounced by caller).
 */
export async function runSessionIdleHooks(
  workspacePath: string,
  cwd: string,
): Promise<RunHooksResult> {
  return runHooks(
    'SessionIdle',
    'session',
    { workspacePath },
    cwd,
    { CLAUDE_WORKSPACE: workspacePath },
  )
}

/** User message submitted (main chat) — inject `additionalContext` into prompt when hooks return it. */
export async function runUserPromptSubmitHooks(
  userPrompt: string,
  cwd: string,
  opts?: { messageCount?: number },
): Promise<RunHooksResult> {
  return runHooks(
    'UserPromptSubmit',
    'user_prompt',
    { prompt: userPrompt, messageCount: opts?.messageCount ?? 0 },
    cwd,
  )
}

/** Fired before context compaction mutates the transcript (micro / auto / block). */
export async function runPreCompactHooks(
  payload: Record<string, unknown>,
  cwd: string,
): Promise<RunHooksResult> {
  return runHooks('PreCompact', 'context', payload, cwd)
}

/** Fired after compaction successfully applied new messages. */
export async function runPostCompactHooks(
  payload: Record<string, unknown>,
  cwd: string,
): Promise<RunHooksResult> {
  return runHooks('PostCompact', 'context', payload, cwd)
}

type StopFamilyEvent = 'Stop' | 'SubagentStop'

async function notifyStopHookFailure(
  cwd: string,
  sourceEvent: StopFamilyEvent,
  detail: Record<string, unknown>,
): Promise<void> {
  if (isHooksDisabled()) return
  try {
    await runHooks(
      'StopFailure',
      'stop',
      { source_event: sourceEvent, ...detail },
      cwd,
    )
  } catch {
    /* non-blocking */
  }
}

/**
 * Stop-family hook outcome (discriminated union via `kind`).
 *
 * Variants:
 *
 * - **`'neutral'`** — hook had nothing to say; the loop terminates as planned.
 *
 * - **`'preventStop'`** — hook explicitly blocked the stop (exit code 2 /
 *   handler `preventContinuation`). The loop injects `appendUserContent`
 *   as a synthetic user turn and runs another model iteration.
 *
 * - **`'blockingError'`** — hook crashed with a non-zero, non-2 exit code
 *   (or its handler threw). Previously these were silently logged and
 *   ignored; that hides real CI / lint / test failures from the model.
 *   Now they're surfaced as a synthetic user error message so the model
 *   can see the failure and try to fix it. The agentic loop sets
 *   `state.stopHookActive = true` for one iteration so the same broken
 *   hook doesn't re-fire on the model's follow-up turn (recursion guard).
 *
 * - **`'forceStop'`** — hook explicitly requested terminal stop (exit
 *   code 3, or handler returned `forceStop: true`). The loop terminates
 *   with `stop_hook_prevented`. Distinct from `preventStop`: that one
 *   means *don't stop*; `forceStop` means *stop hard, no recovery*.
 */
export type StopFamilyHookOutcome =
  | { kind: 'neutral' }
  | { kind: 'preventStop'; appendUserContent: string; hookName?: string }
  | { kind: 'blockingError'; errorMessage: string; hookName?: string }
  | { kind: 'forceStop'; errorDetail?: string; hookName?: string }

/**
 * The non-blank continuation content a `preventStop` outcome wants injected
 * as a synthetic user turn, or `null` when the outcome is not `preventStop`
 * or its `appendUserContent` is blank.
 *
 * Single source of truth for "does this preventStop actually drive a
 * continuation?" — shared by the circuit-breaker would-trip pre-check
 * (`noTools.ts`) and the continuation decision (`iterationDecision.ts`) so
 * the two callers can never silently diverge on the trim / emptiness rule.
 */
export function preventStopContinuationContent(
  outcome: StopFamilyHookOutcome,
): string | null {
  if (outcome.kind !== 'preventStop') return null
  const trimmed = outcome.appendUserContent?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : null
}

/**
 * upstream `Stop` / `SubagentStop`:
 *   - exit code 2 → prevents ending (preventStop, appendUserContent)
 *   - exit code 3 → terminal stop (forceStop)
 *   - other non-zero → blockingError (inject error to model, force one
 *     more iteration; recursion-guarded by caller)
 *
 * Order: settings hooks → per-agent hooks → **skill hooks** (optional
 * `inlineSkillScope` first). `StopFailure` runs (non-blocking) on every
 * non-zero, non-2 exit so external observers still see the crash.
 */
async function runStopFamilyHooks(
  hookEvent: StopFamilyEvent,
  toolMatch: string,
  toolInput: Record<string, unknown>,
  cwd: string,
  opts?: { inlineSkillScope?: string; skipHooks?: ReadonlySet<string> },
): Promise<StopFamilyHookOutcome> {
  if (isHooksDisabled()) {
    return { kind: 'neutral' }
  }

  // P0.4 — per-hook recursion guard. The caller (agentic loop) tracks
  // which hooks fired a non-neutral outcome on the previous iteration in
  // `state.stopHookActive` (a `Set<string>`). For each such hook we
  // short-circuit `tryExec` so the same broken hook can't re-fire on the
  // model's recovery turn — but every OTHER hook still gets evaluated.
  // Pre-P0.4 a single boolean flag silenced ALL hooks for one iteration.
  const skipHooks = opts?.skipHooks
  const isSkipped = (hookName: string | undefined): boolean =>
    hookName !== undefined && skipHooks !== undefined && skipHooks.has(hookName)

  const tryExec = async (
    command: string,
    kind: HookExecutionKind,
    hookAsync: boolean | undefined,
    hookAsyncRewake: boolean | undefined,
    extraEnv: Record<string, string>,
    hookName?: string,
  ): Promise<StopFamilyHookOutcome | null> => {
    if (shouldDeferPromptOrAgentHook(kind)) return null
    if (isSkipped(hookName)) return null
    const env = buildHookEnv(hookEvent, toolMatch, toolInput, {
      ...extraEnv,
      CLAUDE_CWD: cwd,
      CLAUDE_HOOK_EXECUTION_KIND: kind,
    })
    const rawResult = await execHook({
      command,
      env,
      cwd,
      async: hookAsync,
      asyncRewake: hookAsyncRewake,
      executionKind: kind,
      timeoutMs: defaultTimeoutMsForHookKind(kind),
    })
    if ('onComplete' in rawResult) return null
    const r = rawResult as HookResult
    if (r.exitCode !== 0 && r.exitCode !== 2) {
      void notifyStopHookFailure(cwd, hookEvent, {
        exit_code: r.exitCode,
        stderr: r.stderr,
        stdout: r.stdout,
      })
    }
    if (r.exitCode === 2) {
      const msg =
        r.stderr.trim() ||
        r.stdout.trim() ||
        `${hookEvent} hook prevented session end.`
      return { kind: 'preventStop', appendUserContent: msg, ...(hookName ? { hookName } : {}) }
    }
    if (r.exitCode === 3) {
      const detail = r.stderr.trim() || r.stdout.trim()
      return {
        kind: 'forceStop',
        ...(detail ? { errorDetail: detail } : {}),
        ...(hookName ? { hookName } : {}),
      }
    }
    if (r.exitCode !== 0) {
      const errorMessage =
        r.stderr.trim() ||
        r.stdout.trim() ||
        `${hookEvent} hook exited with code ${r.exitCode}.`
      return { kind: 'blockingError', errorMessage, ...(hookName ? { hookName } : {}) }
    }
    return null
  }

  if (hasHooksForEvent(hookEvent, '')) {
    for (const hook of getHooksForEvent(hookEvent, '')) {
      const kind = hook.executionKind ?? 'command'
      const hit = await tryExec(hook.command, kind, hook.async, hook.asyncRewake, {}, hook.command)
      if (hit) return hit
    }
  }

  const agentCtx = getAgentContext()
  for (const hook of agentCtx?.runtimeHooks?.filter((h) => h.event === hookEvent) ?? []) {
    if (!matchesPattern(toolMatch, hook.matcher)) continue
    const kind = hook.executionKind ?? 'command'
    const hit = await tryExec(hook.command, kind, hook.async, undefined, {
      CLAUDE_AGENT_ID: agentCtx?.agentId ?? '',
    }, hook.command)
    if (hit) return hit
  }

  let skillNames = listSkillNamesWithHooksForEvent(hookEvent, cwd, toolMatch)
  const prefer = opts?.inlineSkillScope?.trim()
  if (prefer && skillNames.includes(prefer)) {
    skillNames = [prefer, ...skillNames.filter((n) => n !== prefer)]
  }

  for (const skillName of skillNames) {
    // P0.4 — skill-level skip. The skill name is the hookName attached
    // to outcomes from this branch (see `hookName: skillName` below),
    // so the same set membership applies.
    if (isSkipped(skillName)) continue
    const specs = getSkillHooksForEvent(skillName, hookEvent, cwd, toolMatch)
    for (const spec of specs) {
      const ctx: SkillHookContext = {
        skillName,
        skillContext: 'inline',
        argumentsStr: JSON.stringify(toolInput),
        cwd,
        toolName: toolMatch,
        toolInput,
      }

      if (typeof spec.handler === 'function') {
        const r = await evaluateSkillHook(spec, ctx)
        if (r?.preventContinuation) {
          return {
            kind: 'preventStop',
            appendUserContent: r.reason || `${hookEvent} skill hook prevented session end.`,
            hookName: skillName,
          }
        }
        continue
      }

      if (!spec.command?.trim()) continue
      if (shouldDeferPromptOrAgentHook(spec.executionKind ?? 'command')) continue

      const root = getSkillHookInstallRoot(skillName)
      const hookCwd = root || cwd
      const kind = spec.executionKind ?? 'command'
      const env = buildSkillHookEnv(ctx, hookEvent, hookCwd, kind)
      const rawResult = await execHook({
        command: spec.command.trim(),
        env,
        cwd: hookCwd,
        timeoutMs: spec.timeoutMs ?? defaultTimeoutMsForHookKind(kind),
        async: spec.async,
        asyncRewake: spec.asyncRewake,
        executionKind: kind,
      })
      if ('onComplete' in rawResult) continue
      const r = rawResult as HookResult
      if (r.exitCode !== 0 && r.exitCode !== 2) {
        void notifyStopHookFailure(cwd, hookEvent, {
          skill: skillName,
          exit_code: r.exitCode,
          stderr: r.stderr,
          stdout: r.stdout,
        })
      }
      if (r.exitCode === 2) {
        return {
          kind: 'preventStop',
          appendUserContent:
            r.stderr.trim() ||
            r.stdout.trim() ||
            `${hookEvent} skill hook prevented session end.`,
          hookName: skillName,
        }
      }
      if (r.exitCode === 3) {
        const detail = r.stderr.trim() || r.stdout.trim()
        return {
          kind: 'forceStop',
          ...(detail ? { errorDetail: detail } : {}),
          hookName: skillName,
        }
      }
      if (r.exitCode !== 0) {
        return {
          kind: 'blockingError',
          errorMessage:
            r.stderr.trim() ||
            r.stdout.trim() ||
            `${hookEvent} skill hook exited with code ${r.exitCode}.`,
          hookName: skillName,
        }
      }
    }
  }

  return { kind: 'neutral' }
}

export async function runStopHooks(
  accumulatedText: string,
  cwd: string,
  opts?: { inlineSkillScope?: string; skipHooks?: ReadonlySet<string> },
): Promise<StopFamilyHookOutcome> {
  return runStopFamilyHooks(
    'Stop',
    'stop',
    { assistant_text: accumulatedText },
    cwd,
    opts,
  )
}

/** Sub-agent text-only turn end — same semantics as {@link runStopHooks} but event `SubagentStop`. */
export async function runSubagentStopHooks(
  accumulatedText: string,
  cwd: string,
  opts?: { inlineSkillScope?: string; skipHooks?: ReadonlySet<string> },
): Promise<StopFamilyHookOutcome> {
  const agentCtx = getAgentContext()
  const toolInput: Record<string, unknown> = {
    assistant_text: accumulatedText,
    ...(agentCtx?.agentId ? { subagent_agent_id: agentCtx.agentId } : {}),
    ...(agentCtx?.sessionAgentType ? { subagent_agent_type: agentCtx.sessionAgentType } : {}),
  }
  return runStopFamilyHooks('SubagentStop', 'subagent_stop', toolInput, cwd, opts)
}

/**
 * Re-export registerSkillHooks so loader can auto-register on skill load.
 */
export { registerSkillHooks }