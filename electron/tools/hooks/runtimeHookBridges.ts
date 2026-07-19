/**
 * Wires product lifecycle points to upstream–style hook events (TaskCreated, ConfigChange, …).
 * Kept separate from {@link ./engine} to limit import cycles with skills / TaskManager.
 */

import { taskManager, type Task } from '../TaskManager'
import { getWorkspacePath } from '../workspaceState'
import { runHooks, runSessionIdleHooks } from './engine'

function hookCwd(): string {
  return getWorkspacePath()?.trim() || process.cwd()
}

function serializeTask(t: Task): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify({
      taskId: t.taskId,
      subject: t.subject,
      description: t.description,
      status: t.status,
      owner: t.owner,
      source: t.source,
      runtimeKind: t.runtimeKind,
      agentId: t.agentId,
      conversationId: t.conversationId,
      parentTaskId: t.parentTaskId,
      metadata: t.metadata,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    }),
  ) as Record<string, unknown>
}

let taskHooksInstalled = false
let setupHookFired = false

const SESSION_IDLE_DEBOUNCE_MS = 20_000
let sessionIdleTimer: ReturnType<typeof setTimeout> | undefined

/** Cancel pending SessionIdle hook (call when a new user turn starts). */
export function cancelSessionIdleHooksSchedule(): void {
  if (sessionIdleTimer) {
    clearTimeout(sessionIdleTimer)
    sessionIdleTimer = undefined
  }
}

/** Debounced SessionIdle — fires after inactivity following an assistant message end (main chat). */
export function scheduleSessionIdleHooks(workspacePath: string | undefined): void {
  cancelSessionIdleHooksSchedule()
  if (!workspacePath?.trim()) return
  const ws = workspacePath.trim()
  const cwd = hookCwd()
  sessionIdleTimer = setTimeout(() => {
    sessionIdleTimer = undefined
    void runSessionIdleHooks(ws, cwd).catch(() => {})
  }, SESSION_IDLE_DEBOUNCE_MS)
}

/** Idempotent — safe to call from app startup. */
export function installRuntimeHookBridges(): void {
  if (taskHooksInstalled) return
  taskHooksInstalled = true

  if (!setupHookFired) {
    setupHookFired = true
    void runHooks('Setup', 'app', { source: 'installRuntimeHookBridges' }, hookCwd()).catch(() => {})
  }

  taskManager.subscribe((e) => {
    const cwd = hookCwd()
    if (e.type === 'created') {
      void runHooks('TaskCreated', 'task', { task: serializeTask(e.task) }, cwd).catch(() => {})
    } else if (e.type === 'completed') {
      void runHooks('TaskCompleted', 'task', { task: serializeTask(e.task), outcome: 'completed' }, cwd).catch(
        () => {},
      )
    } else if (e.type === 'failed') {
      void runHooks('TaskCompleted', 'task', { task: serializeTask(e.task), outcome: 'failed' }, cwd).catch(
        () => {},
      )
    } else if (e.type === 'cancelled') {
      // P1-20: user-cancel surfaces as a distinct outcome so hook scripts can
      // skip retry / failure-notification logic that should only fire on
      // real failures.
      void runHooks('TaskCompleted', 'task', { task: serializeTask(e.task), outcome: 'cancelled' }, cwd).catch(
        () => {},
      )
    }
  })
}

export function fireInstructionsLoadedHooks(skillNames: string[], workspacePath?: string): void {
  const cwd = workspacePath?.trim() || hookCwd()
  // BUG-SK3 fix: surface failures so hook authors can diagnose them.
  // Previously these errors were dropped silently, making it impossible
  // to tell whether an `InstructionsLoaded` hook ran at all.
  void runHooks(
    'InstructionsLoaded',
    'instructions',
    { skill_names: [...skillNames], skill_count: skillNames.length },
    cwd,
  ).catch((err) => {
    console.warn(
      '[Hooks] InstructionsLoaded hook failed:',
      err instanceof Error ? err.message : String(err),
    )
  })
}

export function fireConfigChangeHooks(changedKeys: string[]): void {
  const cwd = hookCwd()
  const keys = [...new Set(changedKeys.filter((k) => typeof k === 'string' && k.trim()))]
  if (keys.length === 0) return
  // BUG-SK3 fix: same rationale — surface failures.
  void runHooks('ConfigChange', 'config', { changed_keys: keys }, cwd).catch((err) => {
    console.warn(
      '[Hooks] ConfigChange hook failed:',
      err instanceof Error ? err.message : String(err),
    )
  })
}

export function fireWorktreeRemoveHooks(payload: Record<string, unknown>): void {
  void runHooks('WorktreeRemove', 'worktree', payload, hookCwd()).catch(() => {})
}

export function fireTeammateIdleHooks(payload: Record<string, unknown>): void {
  void runHooks('TeammateIdle', 'teammate', payload, hookCwd()).catch(() => {})
}

export function firePermissionDeniedHooks(
  toolName: string,
  toolInput: Record<string, unknown>,
  reason: string,
  cwd: string,
  skillScope?: string,
): void {
  void runHooks(
    'PermissionDenied',
    toolName,
    { ...toolInput, reason },
    cwd,
    undefined,
    skillScope,
  ).catch(() => {})
}

export function fireNotificationHooks(payload: Record<string, unknown>): void {
  void runHooks('Notification', 'task', payload, hookCwd()).catch(() => {})
}

export function fireWorktreeCreateHooks(payload: Record<string, unknown>): void {
  void runHooks('WorktreeCreate', 'worktree', payload, hookCwd()).catch(() => {})
}

export function fireCwdChangedHooks(payload: Record<string, unknown>): void {
  void runHooks('CwdChanged', 'cwd', payload, hookCwd()).catch(() => {})
}

export function fireSubagentStartHooks(payload: Record<string, unknown>): void {
  void runHooks('SubagentStart', 'subagent', payload, hookCwd()).catch(() => {})
}

export function fireSubagentHooks(payload: Record<string, unknown>): void {
  void runHooks('Subagent', 'subagent', payload, hookCwd()).catch(() => {})
}

export function fireElicitationHooks(payload: Record<string, unknown>): void {
  void runHooks('Elicitation', 'elicitation', payload, hookCwd()).catch(() => {})
}

export function fireElicitationResultHooks(payload: Record<string, unknown>): void {
  void runHooks('ElicitationResult', 'elicitation', payload, hookCwd()).catch(() => {})
}

/** Renderer / CLI can call when status-line UI exists (hook parity with upstream). */
export function fireStatusLineHooks(payload: Record<string, unknown>): void {
  void runHooks('StatusLine', 'status_line', payload, hookCwd()).catch(() => {})
}

/** Renderer can call when file-suggestion UI exists. */
export function fireFileSuggestionHooks(payload: Record<string, unknown>): void {
  void runHooks('FileSuggestion', 'file_suggestion', payload, hookCwd()).catch(() => {})
}
