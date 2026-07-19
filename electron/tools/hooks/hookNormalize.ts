/**
 * Normalize upstream-style hook stdout JSON (optional `hookSpecificOutput` discriminant)
 * into the flat {@link HookResponse} used by the agentic loop.
 */

import type { HookResponse } from './types'

type HookSpecific = Record<string, unknown> & { hookEventName?: string }

function strMap(obj: unknown): Record<string, unknown> | undefined {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined
  return obj as Record<string, unknown>
}

/**
 * Map PermissionRequest nested `decision` to flat `decision` + optional `updatedInput`.
 */
function mapPermissionRequestDecision(hso: HookSpecific): Partial<HookResponse> {
  const d = hso.decision
  if (!d || typeof d !== 'object' || Array.isArray(d)) return {}
  const b = (d as { behavior?: string }).behavior
  if (b === 'allow') {
    const ui = (d as { updatedInput?: Record<string, unknown> }).updatedInput
    return {
      decision: 'allow',
      ...(ui && typeof ui === 'object' ? { updatedInput: ui } : {}),
    }
  }
  if (b === 'deny') {
    const msg = (d as { message?: string }).message
    return {
      decision: 'deny',
      ...(typeof msg === 'string' && msg ? { reason: msg } : {}),
    }
  }
  return {}
}

/**
 * Flatten validated / parsed hook JSON into {@link HookResponse}.
 */
export function normalizeHookJsonToResponse(parsed: unknown): HookResponse | undefined {
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const o = parsed as Record<string, unknown>

  if (o.async === true) {
    return {
      async: true,
      asyncTimeout: typeof o.asyncTimeout === 'number' ? o.asyncTimeout : undefined,
    }
  }

  const out: HookResponse = {}

  if (typeof o.continue === 'boolean') out.continue = o.continue
  if (typeof o.preventContinuation === 'boolean') out.preventContinuation = o.preventContinuation
  if (typeof o.reason === 'string') out.reason = o.reason
  if (typeof o.systemMessage === 'string') out.systemMessage = o.systemMessage
  if (typeof o.additionalContext === 'string') out.additionalContext = o.additionalContext

  // Root-level permission (legacy flat JSON)
  if (o.permissionDecision === 'allow' || o.permissionDecision === 'deny' || o.permissionDecision === 'ask') {
    out.permissionDecision = o.permissionDecision
  }
  // upstream synonyms: approve / block (top-level decision)
  if (o.decision === 'block') {
    out.continue = false
    out.preventContinuation = true
    if (!out.permissionDecision) out.permissionDecision = 'deny'
    out.decision = 'deny'
  } else if (o.decision === 'approve') {
    out.decision = 'allow'
  } else if (o.decision === 'allow' || o.decision === 'deny' || o.decision === 'ask') {
    out.decision = o.decision
  }
  const rootUi = strMap(o.updatedInput)
  if (rootUi) out.updatedInput = rootUi
  const mcpOut = o.updatedMCPToolOutput
  if (mcpOut !== undefined) out.updatedMCPToolOutput = mcpOut as Record<string, unknown> | string

  const hso = o.hookSpecificOutput as HookSpecific | undefined
  if (hso && typeof hso === 'object') {
    const name = hso.hookEventName
    if (typeof hso.additionalContext === 'string' && hso.additionalContext) {
      out.additionalContext = (out.additionalContext || '') + hso.additionalContext
    }
    if (name === 'PreToolUse') {
      const pd = hso.permissionDecision
      if (pd === 'allow' || pd === 'deny' || pd === 'ask') out.permissionDecision = pd
      const pr = hso.permissionDecisionReason
      if (typeof pr === 'string' && pr && !out.reason) out.reason = pr
      const ui = strMap(hso.updatedInput)
      if (ui) out.updatedInput = { ...out.updatedInput, ...ui }
    }
    if (name === 'PermissionRequest') {
      Object.assign(out, mapPermissionRequestDecision(hso))
    }
    if (name === 'PostToolUse' || name === 'PostToolUseFailure') {
      if (hso.updatedMCPToolOutput !== undefined) {
        out.updatedMCPToolOutput = hso.updatedMCPToolOutput as Record<string, unknown> | string
      }
    }
  }

  if (
    out.continue === undefined &&
    out.preventContinuation === undefined &&
    out.permissionDecision === undefined &&
    out.decision === undefined &&
    out.updatedInput === undefined &&
    out.additionalContext === undefined &&
    out.systemMessage === undefined &&
    out.reason === undefined &&
    out.updatedMCPToolOutput === undefined &&
    out.async === undefined
  ) {
    return undefined
  }

  return out
}

/**
 * Parse stdout and normalize; on invalid JSON returns undefined (caller may fall back to exit-code semantics).
 */
export function hookStdoutToResponse(stdout: string): HookResponse | undefined {
  const t = stdout.trim()
  if (!t) return undefined
  try {
    return normalizeHookJsonToResponse(JSON.parse(t))
  } catch {
    return undefined
  }
}

export interface AggregatedHookResult {
  /** Merged blocking-relevant fields (same merge order as engine). */
  merged: HookResponse | undefined
  /** Per-hook normalized responses (parallel to engine results order). */
  normalizedPerHook: Array<HookResponse | undefined>
}

export function aggregateHookResponses(responses: Array<HookResponse | undefined>): HookResponse | undefined {
  let merged: HookResponse | undefined
  for (const resp of responses) {
    if (!resp) continue
    merged = mergeHookResponse(merged, resp)
  }
  return merged
}

/**
 * Single source of truth for merging hook responses (audit #4/#5).
 *
 * Uses `!== undefined` for `updatedMCPToolOutput` so a legitimate empty-string
 * override is not silently dropped. `engine.ts` {@link runHooks} also uses
 * this to keep the blocking merge and the aggregated merge in sync.
 */
export function mergeHookResponse(
  existing: HookResponse | undefined,
  resp: HookResponse,
): HookResponse {
  const merged: HookResponse = { ...existing }

  if (resp.async === true) {
    merged.async = true
    if (resp.asyncTimeout !== undefined) merged.asyncTimeout = resp.asyncTimeout
  }
  if (resp.continue === false) merged.continue = false
  if (resp.preventContinuation) merged.preventContinuation = true
  if (resp.permissionDecision) {
    const order = { deny: 0, ask: 1, allow: 2 }
    if (
      !merged.permissionDecision ||
      order[resp.permissionDecision] < order[merged.permissionDecision]
    ) {
      merged.permissionDecision = resp.permissionDecision
    }
  }
  if (resp.decision) {
    const order = { deny: 0, ask: 1, allow: 2 }
    if (!merged.decision || order[resp.decision] < order[merged.decision]) {
      merged.decision = resp.decision
    }
  }
  if (resp.updatedInput) merged.updatedInput = { ...merged.updatedInput, ...resp.updatedInput }
  if (resp.updatedMCPToolOutput !== undefined) merged.updatedMCPToolOutput = resp.updatedMCPToolOutput
  if (resp.additionalContext) {
    merged.additionalContext = (merged.additionalContext || '') + resp.additionalContext
  }
  if (resp.systemMessage) {
    merged.systemMessage = (merged.systemMessage || '') + resp.systemMessage
  }
  if (resp.reason && !merged.reason) merged.reason = resp.reason

  return merged
}
