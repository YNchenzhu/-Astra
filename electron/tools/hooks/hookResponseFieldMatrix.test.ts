/**
 * AC-9.3 — matrix over {@link HookResponse} fields + common hookSpecificOutput shapes.
 * Documents expected normalization for regression safety (not upstream byte-identical claim).
 */

import { describe, expect, it } from 'vitest'
import { normalizeHookJsonToResponse, aggregateHookResponses } from './hookNormalize'

describe('hookResponse field matrix (AC-9.3)', () => {
  it('maps root-level HookResponse fields (async is handled as a dedicated branch)', () => {
    const asyncOnly = normalizeHookJsonToResponse({ async: true, asyncTimeout: 5000 })
    expect(asyncOnly).toEqual({ async: true, asyncTimeout: 5000 })

    const r = normalizeHookJsonToResponse({
      continue: false,
      preventContinuation: true,
      permissionDecision: 'ask',
      decision: 'ask',
      updatedInput: { a: 1 },
      additionalContext: 'ctx',
      systemMessage: 'sys',
      reason: 'because',
      updatedMCPToolOutput: { out: true },
    })
    expect(r).toMatchObject({
      continue: false,
      preventContinuation: true,
      permissionDecision: 'ask',
      decision: 'ask',
      updatedInput: { a: 1 },
      additionalContext: 'ctx',
      systemMessage: 'sys',
      reason: 'because',
      updatedMCPToolOutput: { out: true },
    })
  })

  it('flattens PostToolUse hookSpecificOutput.updatedMCPToolOutput', () => {
    const r = normalizeHookJsonToResponse({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        updatedMCPToolOutput: { patched: 1 },
      },
    })
    expect(r?.updatedMCPToolOutput).toEqual({ patched: 1 })
  })

  it('flattens UserPromptSubmit additionalContext from hookSpecificOutput', () => {
    const r = normalizeHookJsonToResponse({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: 'from-hso',
      },
    })
    expect(r?.additionalContext).toBe('from-hso')
  })

  it('aggregates deny over allow (merge order)', () => {
    const merged = aggregateHookResponses([
      { permissionDecision: 'allow' },
      { permissionDecision: 'deny' },
      { permissionDecision: 'ask' },
    ])
    expect(merged?.permissionDecision).toBe('deny')
  })
})
