/**
 * Permission Manager
 *
 * Manages tool permissions and access control.
 * Uses PermissionMode from the project's type system.
 */

import type { PermissionMode, ToolPermission } from '../../types/tool'
import { useChatStore } from '../../stores/useChatStore'
import { useSettingsStore } from '../../stores/useSettingsStore'

export type PermissionPolicy = {
  mode: PermissionMode
  allowList?: string[]
  denyList?: string[]
  ownerOnlyTools?: string[]
  /**
   * Tools considered "read-only" for plan-mode enforcement. Anything *not* in
   * this set is rejected while `mode === 'plan'`. Kept as a policy field so
   * callers can override (e.g., extend to MCP tools) without patching the
   * manager internals.
   */
  readOnlyTools?: string[]
}

/**
 * Conservative default: only explicitly-known safe tools pass in plan mode.
 * We match on both the renderer-side names (`read_file`, `web_search`, …) and
 * the main-process registry names (`Read`, `Grep`, …) so this works whichever
 * side calls `canUseTool`.
 */
const DEFAULT_READ_ONLY_TOOLS = [
  'read_file',
  'Read',
  'list_files',
  'LS',
  'Glob',
  'glob',
  'Grep',
  'grep',
  'web_search',
  'WebSearch',
  'WebFetch',
  'web_fetch',
  'Task',
  'TodoWrite',
]

class PermissionManagerImpl {
  private policy: PermissionPolicy = {
    mode: 'default',
    allowList: undefined,
    denyList: undefined,
    ownerOnlyTools: ['gateway', 'cron', 'system'],
    readOnlyTools: DEFAULT_READ_ONLY_TOOLS,
  }

  setPolicy(policy: Partial<PermissionPolicy>): void {
    this.policy = { ...this.policy, ...policy }
  }

  getPolicy(): PermissionPolicy {
    return { ...this.policy }
  }

  getMode(): PermissionMode {
    return this.policy.mode
  }

  setMode(mode: PermissionMode): void {
    this.policy.mode = mode
  }

  canUseTool(toolName: string, isOwner: boolean = true): ToolPermission {
    // bypassPermissions: always allow everything
    if (this.policy.mode === 'bypassPermissions') {
      return { toolName, allowed: true }
    }

    // Owner-only tools
    if (this.policy.ownerOnlyTools?.includes(toolName)) {
      if (!isOwner) {
        return { toolName, allowed: false, reason: 'Owner-only tool' }
      }
    }

    // Deny list
    if (this.policy.denyList?.includes(toolName)) {
      return { toolName, allowed: false, reason: 'Tool is denied' }
    }

    // Allow list (if specified)
    if (this.policy.allowList && !this.policy.allowList.includes(toolName)) {
      return { toolName, allowed: false, reason: 'Tool not in allow list' }
    }

    // Plan mode means "design, don't change the world". Previously this branch
    // returned `allowed: true` unconditionally which let `bash` / `write_file`
    // slip through and contradict the UX contract shown to the user.
    if (this.policy.mode === 'plan') {
      const readOnly = this.policy.readOnlyTools ?? DEFAULT_READ_ONLY_TOOLS
      if (!readOnly.includes(toolName)) {
        return {
          toolName,
          allowed: false,
          reason: 'Plan mode: only read-only tools are permitted',
        }
      }
      return { toolName, allowed: true }
    }

    return { toolName, allowed: true }
  }

  /**
   * Whether the current mode should prompt for approval before executing a
   * tool. `default` ⇒ yes; `bypassPermissions` / `plan` (already filtered by
   * `canUseTool`) ⇒ no. Exposed for UI layers that want to know up-front
   * whether to show a confirmation dialog.
   */
  requiresApproval(_toolName: string): boolean {
    return this.policy.mode === 'default'
  }
}

export const permissionManager = new PermissionManagerImpl()

// ---------------------------------------------------------------------------
// Store bridge: without this wiring, `permissionManager.mode` was permanently
// `'default'` and the plan / bypassPermissions branches in `canUseTool` were
// dead code because no UI path ever called `setMode`.
//
// We subscribe to `useChatStore.chatInteractionMode` (renderer-side enum:
// `'agent' | 'plan' | 'ask'`) and translate it into the PermissionManager
// vocabulary (`'default' | 'plan' | 'bypassPermissions'`):
//   - `plan` → `plan` (enforce read-only tools)
//   - `ask`  → `default` (ordinary per-tool approval flow)
//   - `agent` → `default` unless the user toggled
//     `settings.permissionDefaultMode === 'allow'` (= "auto-approve everything"),
//     which maps to `bypassPermissions`.
//
// The subscription is set up lazily (import-time) and only in browser envs
// with zustand available; tests and SSR skip it via the try/catch.
// ---------------------------------------------------------------------------
// Stores are imported statically (all consumers are renderer-side).
// Wrapped in try/catch so non-browser contexts (tests / SSR / worker) can
// still import this file for `canUseTool` without the subscription.
// Saved unsubscribe handles so a Vite HMR re-execution of this module can
// release the prior subscriptions before installing fresh ones; otherwise
// every dev-time hot reload doubled the `apply` listener count and chained
// N redundant store reads on every chatMode / settings change.
let _unsubChatStore: (() => void) | null = null
let _unsubSettingsStore: (() => void) | null = null
try {
  const apply = () => {
    try {
      const chatMode = useChatStore.getState().chatInteractionMode
      const defaultPolicy = useSettingsStore.getState().permissionDefaultMode
      if (chatMode === 'plan') {
        permissionManager.setMode('plan')
      } else if (defaultPolicy === 'allow') {
        permissionManager.setMode('bypassPermissions')
      } else {
        permissionManager.setMode('default')
      }
    } catch {
      /* stores not yet hydrated */
    }
  }
  apply()
  _unsubChatStore = useChatStore.subscribe(apply)
  _unsubSettingsStore = useSettingsStore.subscribe(apply)
  if (typeof import.meta !== 'undefined' && (import.meta as { hot?: { dispose: (cb: () => void) => void } }).hot) {
    ;(import.meta as { hot: { dispose: (cb: () => void) => void } }).hot.dispose(() => {
      try { _unsubChatStore?.() } catch { /* noop */ }
      try { _unsubSettingsStore?.() } catch { /* noop */ }
      _unsubChatStore = null
      _unsubSettingsStore = null
    })
  }
} catch {
  /* subscription failure (e.g. running in a worker) — leave default policy */
}
