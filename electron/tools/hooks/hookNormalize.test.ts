import { describe, expect, it } from 'vitest'
import { normalizeHookJsonToResponse, hookStdoutToResponse } from './hookNormalize'

describe('hookNormalize', () => {
  it('flattens PreToolUse hookSpecificOutput', () => {
    const r = normalizeHookJsonToResponse({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'nope',
        updatedInput: { path: '/tmp/x' },
      },
    })
    expect(r?.permissionDecision).toBe('deny')
    expect(r?.reason).toBe('nope')
    expect(r?.updatedInput).toEqual({ path: '/tmp/x' })
  })

  it('flattens PermissionRequest nested decision.allow', () => {
    const r = normalizeHookJsonToResponse({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow', updatedInput: { x: 1 } },
      },
    })
    expect(r?.decision).toBe('allow')
    expect(r?.updatedInput).toEqual({ x: 1 })
  })

  it('parses hookStdoutToResponse', () => {
    const r = hookStdoutToResponse(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: 'hello',
        },
      }),
    )
    expect(r?.additionalContext).toBe('hello')
  })

  it('maps Claude Code decision block to deny + stop', () => {
    const r = normalizeHookJsonToResponse({ decision: 'block' })
    expect(r?.decision).toBe('deny')
    expect(r?.permissionDecision).toBe('deny')
    expect(r?.continue).toBe(false)
    expect(r?.preventContinuation).toBe(true)
  })

  it('maps Claude Code decision approve to allow', () => {
    const r = normalizeHookJsonToResponse({ decision: 'approve' })
    expect(r?.decision).toBe('allow')
  })
})
