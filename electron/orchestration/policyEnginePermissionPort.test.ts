/**
 * `createPolicyEnginePermissionPort` adapter (single PEP after Chunk 6).
 *
 * Coverage:
 *   1. `policyDecisionToPreflight` translation helper.
 *   2. Engine allow → adapter allow.
 *   3. Engine global deny rule → adapter deny with matched rule.
 *   4. Agent allowlist restricts to listed tools (via resolveContext).
 *   5. Chat mode 'ask' denies every tool (via resolveContext).
 *   6. Chat mode 'plan' denies mutating tools.
 *   7. Workspace permission rule pattern deny (via resolveContext).
 *   8. Resolver throw → fail-closed default; POLE_PREFLIGHT_FAIL_OPEN=1 reverses.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createPolicyEnginePermissionPort,
  policyDecisionToPreflight,
} from './policyEnginePermissionPort'
import { getPolicyEngine, resetPolicyEngineForTests } from './toolRuntime/policy'
import { asAgentId } from '../tools/ids'

const previousFailOpen = process.env.POLE_PREFLIGHT_FAIL_OPEN

afterEach(() => {
  if (previousFailOpen === undefined) {
    delete process.env.POLE_PREFLIGHT_FAIL_OPEN
  } else {
    process.env.POLE_PREFLIGHT_FAIL_OPEN = previousFailOpen
  }
  resetPolicyEngineForTests()
})

describe('policyDecisionToPreflight', () => {
  it('allowed → allow', () => {
    expect(policyDecisionToPreflight({ allowed: true })).toEqual({ decision: 'allow' })
  })

  it('denied → deny with reason + matched rules joined', () => {
    const r = policyDecisionToPreflight({
      allowed: false,
      reason: 'rule X',
      matchedRules: ['a', 'b'],
    })
    expect(r.decision).toBe('deny')
    expect(r.reason).toBe('rule X')
    expect(r.matchedRule).toBe('a,b')
  })

  it('denied with no rules → matchedRule defaults to "policyEngine"', () => {
    const r = policyDecisionToPreflight({ allowed: false })
    expect(r.decision).toBe('deny')
    expect(r.matchedRule).toBe('policyEngine')
  })
})

describe('createPolicyEnginePermissionPort', () => {
  beforeEach(() => {
    resetPolicyEngineForTests()
  })

  it('engine allow → adapter allow', async () => {
    const engine = getPolicyEngine()
    engine.setGlobalRules([])
    const port = createPolicyEnginePermissionPort({
      engine,
      resolveContext: () => ({ agentId: asAgentId('agent-1') }),
    })
    const res = await port.preflight!({
      toolName: 'Read',
      toolUseId: 'tu_1',
      toolInput: { path: '/foo' },
    })
    expect(res.decision).toBe('allow')
  })

  it('engine global deny rule → adapter deny with reason', async () => {
    const engine = getPolicyEngine()
    engine.setGlobalRules([
      { kind: 'deny', toolPattern: 'Bash', reason: 'no shells' },
    ])
    const port = createPolicyEnginePermissionPort({
      engine,
      resolveContext: () => ({ agentId: asAgentId('agent-1') }),
    })
    const res = await port.preflight!({
      toolName: 'Bash',
      toolUseId: 'tu_x',
      toolInput: { cmd: 'ls' },
    })
    expect(res.decision).toBe('deny')
    expect(res.reason).toBe('no shells')
    expect(res.matchedRule).toMatch(/global_deny/)
  })

  it('agent allowlist restricts to listed tools', async () => {
    const engine = getPolicyEngine()
    engine.setGlobalRules([])
    const port = createPolicyEnginePermissionPort({
      engine,
      resolveContext: () => ({
        agentId: asAgentId('readonly-agent'),
        toolAllowlist: ['Read', 'Grep'],
      }),
    })
    const allowed = await port.preflight!({
      toolName: 'Read',
      toolUseId: 'tu_a',
      toolInput: {},
    })
    expect(allowed.decision).toBe('allow')
    const denied = await port.preflight!({
      toolName: 'Edit',
      toolUseId: 'tu_b',
      toolInput: {},
    })
    expect(denied.decision).toBe('deny')
    expect(denied.matchedRule).toMatch(/agent_allowlist/)
  })

  it('Chunk 6 — chat mode "ask" denies every tool', async () => {
    const engine = getPolicyEngine()
    engine.setGlobalRules([])
    const port = createPolicyEnginePermissionPort({
      engine,
      resolveContext: () => ({
        agentId: asAgentId('agent-1'),
        chatMode: 'ask',
      }),
    })
    const res = await port.preflight!({
      toolName: 'Read',
      toolUseId: 'tu',
      toolInput: {},
    })
    expect(res.decision).toBe('deny')
    expect(res.matchedRule).toBe('chat_mode:ask')
  })

  it('Chunk 6 — chat mode "plan" denies mutating tools, allows read-only', async () => {
    const engine = getPolicyEngine()
    engine.setGlobalRules([])
    const port = createPolicyEnginePermissionPort({
      engine,
      resolveContext: () => ({
        agentId: asAgentId('agent-1'),
        chatMode: 'plan',
      }),
    })
    const denied = await port.preflight!({
      toolName: 'Write',
      toolUseId: 'tu_w',
      toolInput: {},
    })
    expect(denied.decision).toBe('deny')
    expect(denied.matchedRule).toBe('chat_mode:plan')

    const allowed = await port.preflight!({
      toolName: 'Read',
      toolUseId: 'tu_r',
      toolInput: {},
    })
    expect(allowed.decision).toBe('allow')
  })

  it('Chunk 6 — workspace permission rule pattern deny', async () => {
    const engine = getPolicyEngine()
    engine.setGlobalRules([])
    const port = createPolicyEnginePermissionPort({
      engine,
      resolveContext: () => ({
        agentId: asAgentId('agent-1'),
        permissionRules: [{ mode: 'deny', pattern: 'DangerTool' }],
      }),
    })
    const denied = await port.preflight!({
      toolName: 'DangerTool',
      toolUseId: 'tu_d',
      toolInput: {},
    })
    expect(denied.decision).toBe('deny')
    expect(denied.matchedRule).toMatch(/rule:DangerTool/)
    const allowed = await port.preflight!({
      toolName: 'Read',
      toolUseId: 'tu_r',
      toolInput: {},
    })
    expect(allowed.decision).toBe('allow')
  })

  it('Chunk 6 — chat mode wins over permission rules (ordering)', async () => {
    const engine = getPolicyEngine()
    engine.setGlobalRules([])
    const port = createPolicyEnginePermissionPort({
      engine,
      resolveContext: () => ({
        agentId: asAgentId('agent-1'),
        chatMode: 'ask',
        permissionRules: [{ mode: 'allow', pattern: 'Read' }],
      }),
    })
    const res = await port.preflight!({
      toolName: 'Read',
      toolUseId: 'tu',
      toolInput: {},
    })
    expect(res.decision).toBe('deny')
    expect(res.matchedRule).toBe('chat_mode:ask')
  })

  it('resolver throw → fail-closed by default; POLE_PREFLIGHT_FAIL_OPEN=1 reverses', async () => {
    const engine = getPolicyEngine()
    const port = createPolicyEnginePermissionPort({
      engine,
      resolveContext: () => {
        throw new Error('context resolver down')
      },
    })
    delete process.env.POLE_PREFLIGHT_FAIL_OPEN
    const denied = await port.preflight!({
      toolName: 'Read',
      toolUseId: 'tu',
      toolInput: {},
    })
    expect(denied.decision).toBe('deny')
    expect(denied.matchedRule).toContain('resolver-error')

    process.env.POLE_PREFLIGHT_FAIL_OPEN = '1'
    const allowedOnFail = await port.preflight!({
      toolName: 'Read',
      toolUseId: 'tu',
      toolInput: {},
    })
    // Fail-open: resolver throw is swallowed, returns allow IMMEDIATELY
    // (audit P0 §4.4 — symmetric with engine-throw branch; previously
    // fell through to engine.evaluate({ agentId: 'unknown' }) which was
    // a third undocumented behaviour).
    expect(allowedOnFail.decision).toBe('allow')
  })

  // ── Audit P0 §4.4 — fail-open symmetry test ──
  it('engine throw → fail-closed by default; POLE_PREFLIGHT_FAIL_OPEN=1 reverses to allow (mirrors resolver-throw branch)', async () => {
    const engine = getPolicyEngine()
    // Inject a deny rule with a regex that we can break by passing a
    // payload that makes the matcher throw (or simpler: stub the engine's
    // evaluate to throw via an env-controlled flag would be cleaner, but
    // we don't have that handle. Instead, monkey-patch evaluate.).
    const originalEvaluate = engine.evaluate.bind(engine)
    engine.evaluate = (() => {
      throw new Error('engine.evaluate down')
    }) as typeof originalEvaluate
    try {
      const port = createPolicyEnginePermissionPort({
        engine,
        resolveContext: () => ({ agentId: asAgentId('agent-1') }),
      })

      delete process.env.POLE_PREFLIGHT_FAIL_OPEN
      const fcDenied = await port.preflight!({
        toolName: 'Read',
        toolUseId: 'tu',
        toolInput: {},
      })
      expect(fcDenied.decision).toBe('deny')
      expect(fcDenied.matchedRule).toContain('engine-error')

      process.env.POLE_PREFLIGHT_FAIL_OPEN = '1'
      const foAllowed = await port.preflight!({
        toolName: 'Read',
        toolUseId: 'tu',
        toolInput: {},
      })
      expect(foAllowed.decision).toBe('allow')
      // No matched rule means clean allow path (not "denied with err").
      expect(foAllowed.reason).toBeUndefined()
    } finally {
      engine.evaluate = originalEvaluate
    }
  })
})
