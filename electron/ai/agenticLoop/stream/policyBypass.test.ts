/**
 * `shouldBypassStreamingExecutorForPolicy` — streaming-executor bypass gate.
 *
 * When the gate returns true, `stream.ts` keeps the StreamingToolExecutor
 * empty so tool execution falls through to the orchestrated batch path
 * (full `PolicyEngine` preflight + `permission_denied_preflight` events).
 *
 * Coverage:
 *   - env override `POLE_STREAMING_TOOL_EXECUTOR=0` forces fallback;
 *   - chatMode plan / ask force fallback; agent does not;
 *   - configured permission rules force fallback;
 *   - permissionDefaultMode 'deny' forces fallback;
 *   - trivial case (agent, no rules, allow/ask) keeps streaming on.
 */
import { describe, it, expect } from 'vitest'
import { shouldBypassStreamingExecutorForPolicy } from './policyBypass'

describe('shouldBypassStreamingExecutorForPolicy', () => {
  it('env override "0" forces fallback', () => {
    expect(shouldBypassStreamingExecutorForPolicy({ envOverride: '0' })).toBe(true)
  })

  it('chatMode "plan" forces fallback', () => {
    expect(shouldBypassStreamingExecutorForPolicy({ chatMode: 'plan' })).toBe(true)
  })

  it('chatMode "ask" forces fallback', () => {
    expect(shouldBypassStreamingExecutorForPolicy({ chatMode: 'ask' })).toBe(true)
  })

  it('chatMode "agent" alone does NOT force fallback', () => {
    expect(shouldBypassStreamingExecutorForPolicy({ chatMode: 'agent' })).toBe(false)
  })

  it('configured permission rules force fallback', () => {
    expect(
      shouldBypassStreamingExecutorForPolicy({ permissionRules: [{}], chatMode: 'agent' }),
    ).toBe(true)
  })

  it('permissionDefaultMode "deny" forces fallback', () => {
    expect(
      shouldBypassStreamingExecutorForPolicy({ permissionDefaultMode: 'deny', chatMode: 'agent' }),
    ).toBe(true)
  })

  it('trivial case (agent, no rules, allow) keeps streaming on', () => {
    expect(
      shouldBypassStreamingExecutorForPolicy({
        chatMode: 'agent',
        permissionDefaultMode: 'allow',
        permissionRules: [],
      }),
    ).toBe(false)
  })

  it('trivial case with default mode "ask" keeps streaming on', () => {
    expect(
      shouldBypassStreamingExecutorForPolicy({
        chatMode: 'agent',
        permissionDefaultMode: 'ask',
      }),
    ).toBe(false)
  })
})
