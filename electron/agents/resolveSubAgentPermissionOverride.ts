/**
 * upstream report §3.1 / §3.2 — effective permission mode for a sub-agent run.
 *
 * Foreground: optional per-definition override; `bubble` uses the parent's chat mode snapshot.
 * Background: defaults to `dontAsk` (auto-deny anything that would prompt) unless the definition
 * sets `bubble` (inherit parent snapshot) or another explicit mode.
 *
 * Report §3.2 — `subagentToolProfile: async_agent` (Explore / Plan): same as upstream async column —
 * no permission prompts unless `permissionMode: bubble` (inherit parent) or a non-`default`
 * explicit mode (e.g. `plan`, `acceptEdits`).
 *
 * §7.8 fix — when `permissionMode: 'default'` AND `parentPolicy: 'inherit'`, inherit the parent's
 * effective permission mode so the child doesn't trigger permission prompts that the parent already bypassed.
 */

import type { PermissionMode } from '../ai/interactionState'
import type { AgentDefinitionPermissionMode, AgentDefinitionUnion } from './types'

export function resolveSubAgentPermissionOverride(params: {
  agentDef: AgentDefinitionUnion
  runInBackground: boolean
  /** `getPermissionMode()` at spawn time (after killswitches). */
  parentEffectiveMode: PermissionMode
}): AgentDefinitionPermissionMode | undefined {
  const { agentDef, runInBackground, parentEffectiveMode } = params
  const pm = agentDef.permissionMode
  const isAsyncProfile = agentDef.subagentToolProfile === 'async_agent'
  const inheritsFromParent = agentDef.parentPolicy === 'inherit'

  if (runInBackground) {
    if (pm === 'bubble') {
      return parentEffectiveMode as AgentDefinitionPermissionMode
    }
    if (pm === undefined || (isAsyncProfile && pm === 'default')) {
      return 'dontAsk'
    }
    return pm
  }

  if (isAsyncProfile) {
    if (pm === 'bubble') {
      return parentEffectiveMode as AgentDefinitionPermissionMode
    }
    if (pm !== undefined && pm !== 'default') {
      return pm
    }
    return 'dontAsk'
  }

  if (pm === undefined) {
    return undefined
  }
  if (pm === 'bubble') {
    return parentEffectiveMode as AgentDefinitionPermissionMode
  }

  // When permissionMode is 'default' and the agent inherits from parent,
  // inherit the parent's effective mode to avoid permission prompt regression.
  if (pm === 'default' && inheritsFromParent) {
    return parentEffectiveMode as AgentDefinitionPermissionMode
  }

  return pm
}

/** Report §3.2 — background sub-agents default to 1800s (30 min) wall-clock unless overridden. */
export const OPENCLAUDE_BACKGROUND_SUBAGENT_TIMEOUT_MS = 1_800_000
