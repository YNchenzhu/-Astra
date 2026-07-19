/**
 * isPlanModeBlockingTool predicate (consumed by PolicyEngine.evaluate post-Chunk-6).
 *
 * The standalone `createChatModePermissionPort` factory was removed when Chunk 6 folded
 * chat-mode enforcement into `PolicyEngine.evaluate`. Chat-mode coverage now lives in
 * `policyEnginePermissionPort.test.ts` (end-to-end via the port) and
 * `toolRuntime/__tests__/policy.test.ts` (engine-level).
 */

import { describe, expect, it } from 'vitest'
import { isPlanModeBlockingTool, resolveFallbackChatMode } from './chatMode'

describe('isPlanModeBlockingTool', () => {
  it('read-only tools are not blocking', () => {
    for (const n of ['Read', 'Grep', 'Glob']) {
      expect(isPlanModeBlockingTool(n)).toBe(false)
    }
  })
  it('ExitPlanMode is the plan-mode exit ramp (not blocking)', () => {
    expect(isPlanModeBlockingTool('ExitPlanMode')).toBe(false)
  })
  it('unknown / mutating tools are blocking', () => {
    for (const n of ['Write', 'Edit', 'bash', 'UnknownTool']) {
      expect(isPlanModeBlockingTool(n)).toBe(true)
    }
  })
})

/**
 * P2-7 — fallback-path chatMode parity contract (locks the P1-5 wiring).
 *
 * The orchestrated main-chat PEP resolves chatMode from `getChatMode()` and the
 * fallback sub-agent path resolves it from `AgentContext.permissionModeOverride`
 * via `resolveFallbackChatMode`. Both feed the SAME `PolicyEngine.evaluate`
 * chat-mode gate (covered by policy.test.ts + policyEnginePermissionPort.test.ts).
 * This test locks the fallback mapping so a future refactor can't silently
 * reopen the "plan-mode sub-agent bypasses mutation blocking" gap, and so the
 * internal-fork modes are never accidentally swept into plan-blocking.
 */
describe('resolveFallbackChatMode (P2-7 parity contract)', () => {
  it("only 'plan' maps to a blocking chat mode", () => {
    expect(resolveFallbackChatMode('plan')).toBe('plan')
  })
  it('internal-fork + no-opinion modes map to undefined (no plan-blocking)', () => {
    for (const m of [
      'dontAsk', // session-memory-internal / async background forks
      'bypassPermissions', // hook LLM
      'acceptEdits',
      'default',
      'bubble',
      undefined,
    ]) {
      expect(resolveFallbackChatMode(m)).toBeUndefined()
    }
  })
  it("does not synthesize 'ask' (Ask mode is enforced by disabling tools upstream)", () => {
    expect(resolveFallbackChatMode('ask')).toBeUndefined()
  })
})
