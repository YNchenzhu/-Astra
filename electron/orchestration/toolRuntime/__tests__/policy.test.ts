/**
 * Unit tests for PolicyEngine — centralized policy enforcement.
 *
 * Run: npx vitest run electron/orchestration/__tests__/policyEngine.test.ts
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  getPolicyEngine,
  resetPolicyEngineForTests,
} from '../policy'
import { resetResourceQuotaManagerForTests } from '../quota'
import { resetGlobalToolCallHistoryForTests } from '../history'
import {
  registerToolInvocation,
  markToolRunning,
  markToolCompleted,
  markToolFailed,
  clearToolRuntimeStateForTests,
} from '../state'
import {
  recordToolInvocationForRateLimit,
  clearToolRateLimitRingForTests,
} from '../rateLimitRing'

describe('PolicyEngine', () => {
  beforeEach(() => {
    clearToolRuntimeStateForTests()
    resetResourceQuotaManagerForTests()
    resetGlobalToolCallHistoryForTests()
    resetPolicyEngineForTests()
  })

  it('should allow a tool with no restrictions', () => {
    const engine = getPolicyEngine()
    const decision = engine.evaluate({
      toolName: 'read_file',
      toolInput: { filePath: 'foo.ts' },
      toolUseId: 'tu_1',
      context: { agentId: 'agent-A' },
      isReadOnly: true,
      priority: 50,
    })
    expect(decision.allowed).toBe(true)
  })

  it('should deny a tool not in the allowlist', () => {
    const engine = getPolicyEngine()
    const decision = engine.evaluate({
      toolName: 'bash',
      toolInput: { command: 'rm -rf /' },
      toolUseId: 'tu_1',
      context: {
        agentId: 'agent-A',
        toolAllowlist: ['read_file', 'grep'],
      },
      isReadOnly: false,
      priority: 50,
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toContain('allowlist')
    expect(decision.matchedRules).toContain('agent_allowlist')
  })

  it('should deny a tool in the denylist', () => {
    const engine = getPolicyEngine()
    const decision = engine.evaluate({
      toolName: 'bash',
      toolInput: { command: 'echo hi' },
      toolUseId: 'tu_1',
      context: {
        agentId: 'agent-A',
        toolDenylist: ['bash', 'powershell'],
      },
      isReadOnly: false,
      priority: 50,
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toContain('denylist')
    expect(decision.matchedRules).toContain('agent_denylist')
  })

  it('should enforce global deny rules', () => {
    const engine = getPolicyEngine()
    engine.setGlobalRules([
      { kind: 'deny', toolPattern: 'bash', reason: 'Shell execution is disabled globally' },
    ])

    const decision = engine.evaluate({
      toolName: 'bash',
      toolInput: { command: 'ls' },
      toolUseId: 'tu_1',
      context: { agentId: 'agent-A' },
      isReadOnly: false,
      priority: 50,
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('Shell execution is disabled globally')
    expect(decision.matchedRules).toContain('global_deny:Shell execution is disabled globally')
  })

  it('should enforce rate limits', () => {
    const engine = getPolicyEngine()
    engine.setGlobalRules([
      { kind: 'rateLimit', toolPattern: 'web_fetch', maxCallsPerMinute: 1, reason: 'Too many fetches' },
    ])

    // First call allowed
    const d1 = engine.evaluate({
      toolName: 'web_fetch',
      toolInput: { url: 'https://example.com' },
      toolUseId: 'tu_1',
      context: { agentId: 'agent-A' },
      isReadOnly: true,
      priority: 50,
    })
    expect(d1.allowed).toBe(true)

    // Record the first call in runtime state so the rate limit window sees it
    registerToolInvocation({ toolUseId: 'tu_1', toolName: 'web_fetch', agentId: 'agent-A', input: {} })
    markToolRunning('tu_1')
    markToolCompleted('tu_1')

    // Second call blocked
    const d2 = engine.evaluate({
      toolName: 'web_fetch',
      toolInput: { url: 'https://example.org' },
      toolUseId: 'tu_2',
      context: { agentId: 'agent-A' },
      isReadOnly: true,
      priority: 50,
    })
    expect(d2.allowed).toBe(false)
    expect(d2.reason).toContain('Too many fetches')
  })

  it('rate-limit counting window is 1 minute, not maxCallsPerMinute minutes (2026-06 fix)', () => {
    const engine = getPolicyEngine()
    engine.setGlobalRules([
      { kind: 'rateLimit', toolPattern: 'web_fetch', maxCallsPerMinute: 5, reason: 'Too many fetches' },
    ])

    // 5 invocations recorded 2 minutes ago — OUTSIDE the 1-minute window.
    // The pre-fix implementation passed `maxCallsPerMinute` (5) as the window
    // in MINUTES, so these stale calls would have counted and blocked here.
    const twoMinutesAgo = Date.now() - 120_000
    for (let i = 0; i < 5; i++) {
      recordToolInvocationForRateLimit('web_fetch', twoMinutesAgo)
    }
    const staleOnly = engine.evaluate({
      toolName: 'web_fetch',
      toolInput: { url: 'https://example.com' },
      toolUseId: 'tu_stale',
      context: { agentId: 'agent-A' },
      isReadOnly: true,
      priority: 50,
    })
    expect(staleOnly.allowed).toBe(true)

    // 5 fresh invocations inside the 1-minute window → blocked.
    for (let i = 0; i < 5; i++) {
      recordToolInvocationForRateLimit('web_fetch', Date.now())
    }
    const fresh = engine.evaluate({
      toolName: 'web_fetch',
      toolInput: { url: 'https://example.com' },
      toolUseId: 'tu_fresh',
      context: { agentId: 'agent-A' },
      isReadOnly: true,
      priority: 50,
    })
    expect(fresh.allowed).toBe(false)
    expect(fresh.reason).toContain('Too many fetches')
  })

  it('rate-limit registry fallback counts failed calls like the ring does (P3 fix)', () => {
    const engine = getPolicyEngine()
    engine.setGlobalRules([
      { kind: 'rateLimit', toolPattern: 'bash', maxCallsPerMinute: 2, reason: 'Too many shells' },
    ])

    // Two bash calls that started and FAILED within the window.
    for (const id of ['tu_f1', 'tu_f2']) {
      registerToolInvocation({ toolUseId: id, toolName: 'bash', agentId: 'agent-A', input: {} })
      markToolRunning(id)
      markToolFailed(id, 'exit 1')
    }
    // Force the registry-scan fallback by clearing the fast-path ring.
    clearToolRateLimitRingForTests()

    const d = engine.evaluate({
      toolName: 'bash',
      toolInput: { command: 'echo hi' },
      toolUseId: 'tu_next',
      context: { agentId: 'agent-A' },
      isReadOnly: false,
      priority: 50,
    })
    // Pre-fix the fallback only counted running|completed entries, so two
    // failing calls sailed through while the ring path would have blocked.
    expect(d.allowed).toBe(false)
    expect(d.reason).toContain('Too many shells')
  })

  it('should enforce token quotas', () => {
    const engine = getPolicyEngine()
    engine.setGlobalRules([
      { kind: 'quota', toolPattern: 'read_file', maxTokensPerCall: 100, reason: 'File too large' },
    ])

    const decision = engine.evaluate({
      toolName: 'read_file',
      toolInput: { filePath: 'huge.log' },
      toolUseId: 'tu_1',
      context: { agentId: 'agent-A' },
      isReadOnly: true,
      priority: 50,
      estimatedTokens: 200,
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toContain('File too large')
  })

  it('should allow tools that match global allow rules', () => {
    const engine = getPolicyEngine()
    engine.setGlobalRules([
      { kind: 'allow', toolPattern: 'read_file', reason: 'Read is always safe' },
    ])

    const decision = engine.evaluate({
      toolName: 'read_file',
      toolInput: { filePath: 'foo.ts' },
      toolUseId: 'tu_1',
      context: { agentId: 'agent-A' },
      isReadOnly: true,
      priority: 50,
    })
    expect(decision.allowed).toBe(true)
    expect(decision.matchedRules).toContain('global_allow:Read is always safe')
  })

  it('should block based on global history repeat failures', () => {
    const engine = getPolicyEngine()
    const history = engine['globalHistory'] // Access internal for test setup
    history.record('bash', { command: 'broken' }, { success: false, errorSummary: 'not found' })
    history.record('bash', { command: 'broken' }, { success: false, errorSummary: 'not found' })
    history.record('bash', { command: 'broken' }, { success: false, errorSummary: 'not found' })

    const decision = engine.evaluate({
      toolName: 'bash',
      toolInput: { command: 'broken' },
      toolUseId: 'tu_1',
      context: { agentId: 'agent-A' },
      isReadOnly: false,
      priority: 50,
    })
    expect(decision.allowed).toBe(false)
    expect(decision.historyAdvice?.level).toBe('block')
  })

  describe('Chunk 6 — chat mode + permission rules in evaluate()', () => {
    it("chat mode 'ask' denies every tool with matchedRule chat_mode:ask", () => {
      const engine = getPolicyEngine()
      const r = engine.evaluate({
        toolName: 'Read',
        toolInput: {},
        toolUseId: 'tu_a',
        context: { agentId: 'agent-A', chatMode: 'ask' },
        isReadOnly: true,
        priority: 50,
      })
      expect(r.allowed).toBe(false)
      expect(r.matchedRules).toContain('chat_mode:ask')
    })

    it("chat mode 'plan' allows read-only but denies mutating tools", () => {
      const engine = getPolicyEngine()
      const allowed = engine.evaluate({
        toolName: 'Read',
        toolInput: {},
        toolUseId: 'tu_r',
        context: { agentId: 'agent-A', chatMode: 'plan' },
        isReadOnly: true,
        priority: 50,
      })
      expect(allowed.allowed).toBe(true)
      const denied = engine.evaluate({
        toolName: 'Write',
        toolInput: {},
        toolUseId: 'tu_w',
        context: { agentId: 'agent-A', chatMode: 'plan' },
        isReadOnly: false,
        priority: 50,
      })
      expect(denied.allowed).toBe(false)
      expect(denied.matchedRules).toContain('chat_mode:plan')
    })

    it('permission rules pattern deny → blocked with matchedRule rule:<pattern>', () => {
      const engine = getPolicyEngine()
      const r = engine.evaluate({
        toolName: 'DangerTool',
        toolInput: {},
        toolUseId: 'tu_d',
        context: {
          agentId: 'agent-A',
          permissionRules: [{ id: '1', pattern: 'DangerTool', mode: 'deny' }],
        },
        isReadOnly: false,
        priority: 50,
      })
      expect(r.allowed).toBe(false)
      expect(r.matchedRules?.some((m) => m.startsWith('rule:DangerTool'))).toBe(true)
    })

    it('shell/path-qualified deny rules are SKIPPED at upstream evaluate (deep check is runtime)', () => {
      const engine = getPolicyEngine()
      const r = engine.evaluate({
        toolName: 'bash',
        toolInput: {},
        toolUseId: 'tu_b',
        context: {
          agentId: 'agent-A',
          permissionRules: [
            { id: '1', pattern: 'bash', mode: 'deny', shellPattern: 'rm -rf *' },
          ],
        },
        isReadOnly: false,
        priority: 50,
      })
      // Pure tool-name preflight should allow; deep check (evaluateRules + bash ctx) is where shell rules fire.
      expect(r.allowed).toBe(true)
    })

    it('permissionDefaultMode "deny" with no rules → default-deny', () => {
      const engine = getPolicyEngine()
      const r = engine.evaluate({
        toolName: 'Read',
        toolInput: {},
        toolUseId: 'tu',
        context: { agentId: 'agent-A', permissionDefaultMode: 'deny' },
        isReadOnly: true,
        priority: 50,
      })
      expect(r.allowed).toBe(false)
      expect(r.matchedRules).toContain('default-deny')
    })

    it('chat mode is evaluated BEFORE permission rules (ask wins even if rules allow)', () => {
      const engine = getPolicyEngine()
      const r = engine.evaluate({
        toolName: 'Read',
        toolInput: {},
        toolUseId: 'tu',
        context: {
          agentId: 'agent-A',
          chatMode: 'ask',
          permissionRules: [{ id: '1', pattern: 'Read', mode: 'allow' }],
        },
        isReadOnly: true,
        priority: 50,
      })
      expect(r.allowed).toBe(false)
      expect(r.matchedRules).toEqual(['chat_mode:ask'])
    })
  })

  describe('evaluateRules (Chunk 7 — deep check entry point)', () => {
    it('returns defaultMode when no rules supplied', () => {
      const engine = getPolicyEngine()
      const r = engine.evaluateRules('Read', 'ask', undefined)
      expect(r).toEqual({ effectiveMode: 'ask', matchedRule: false })
    })

    it('resolves pure tool-name deny pattern (matches resolveToolPermissionMode)', () => {
      const engine = getPolicyEngine()
      const r = engine.evaluateRules('DangerTool', 'allow', [
        { id: '1', pattern: 'DangerTool', mode: 'deny' },
      ])
      expect(r).toEqual({ effectiveMode: 'deny', matchedRule: true })
    })

    it('respects shellPattern context for bash rules', () => {
      const engine = getPolicyEngine()
      const rules = [{ id: '1', pattern: 'bash', mode: 'deny' as const, shellPattern: 'rm *' }]
      const matched = engine.evaluateRules('bash', 'ask', rules, { bashCommand: 'rm -rf /tmp/x' })
      expect(matched).toEqual({ effectiveMode: 'deny', matchedRule: true })
      const skipped = engine.evaluateRules('bash', 'ask', rules, { bashCommand: 'ls' })
      expect(skipped).toEqual({ effectiveMode: 'ask', matchedRule: false })
    })

    it('returns ask when an "ask" rule matches', () => {
      const engine = getPolicyEngine()
      const r = engine.evaluateRules('Edit', 'allow', [
        { id: '1', pattern: 'Edit', mode: 'ask' },
      ])
      expect(r).toEqual({ effectiveMode: 'ask', matchedRule: true })
    })
  })
})
