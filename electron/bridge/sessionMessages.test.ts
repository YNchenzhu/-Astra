/**
 * Tests for the bridge wire-message protocol — schema validation gate.
 *
 * The schemas are the contract between the spawner (main process) and
 * the worker. A mismatched bundle (e.g. worker built off a stale source)
 * must be rejected at the wire boundary, not silently mis-handled.
 */

import { describe, it, expect } from 'vitest'
import { KNOWN_TERMINATION_REASONS } from '../ai/queryTermination'
import { parseParentMessage, parseWorkerMessage } from './sessionMessages'
import { fingerprintTranscript } from '../orchestration/kernelTypes'

describe('parseParentMessage', () => {
  it('accepts a valid init payload', () => {
    const result = parseParentMessage({
      kind: 'init',
      payload: {
        sessionId: 'sess-1',
        params: {
          config: { id: 'anthropic', name: 'Anthropic', apiKey: 'k' },
          model: 'claude-test',
          messages: [{ role: 'user', content: 'hi' }],
        },
      },
    })
    expect(result.ok).toBe(true)
  })

  it('accepts a parent-acknowledged transcript snapshot for worker restart', () => {
    const messages = [{ role: 'user', content: 'resume here' }]
    const result = parseParentMessage({
      kind: 'init',
      payload: {
        sessionId: 'sess-resume',
        params: {
          config: { id: 'anthropic', name: 'Anthropic', apiKey: 'k' },
          model: 'claude-test',
          messages: [],
        },
        initialTranscriptSnapshot: {
          revision: 7,
          fingerprint: fingerprintTranscript(messages),
          messages,
        },
      },
    })
    expect(result.ok).toBe(true)
  })

  it('accepts abort with optional reason', () => {
    expect(parseParentMessage({ kind: 'abort' }).ok).toBe(true)
    expect(parseParentMessage({ kind: 'abort', reason: 'user' }).ok).toBe(true)
  })

  it('accepts update_token with non-empty token', () => {
    expect(parseParentMessage({ kind: 'update_token', token: 't' }).ok).toBe(true)
  })

  it('rejects update_token with empty token', () => {
    const result = parseParentMessage({ kind: 'update_token', token: '' })
    expect(result.ok).toBe(false)
  })

  it('rejects unknown kind', () => {
    const result = parseParentMessage({ kind: 'evil', payload: {} })
    expect(result.ok).toBe(false)
  })

  it('rejects init missing required fields', () => {
    const result = parseParentMessage({
      kind: 'init',
      payload: { sessionId: 'sess-1' /* missing params */ },
    })
    expect(result.ok).toBe(false)
  })

  it('rejects messages array beyond the 20k cap (DoS guard)', () => {
    const tooMany = Array.from({ length: 20_001 }, () => ({
      role: 'user' as const,
      content: 'x',
    }))
    const result = parseParentMessage({
      kind: 'init',
      payload: {
        sessionId: 'sess-2',
        params: {
          config: { id: 'anthropic', name: 'Anthropic', apiKey: 'k' },
          model: 'm',
          messages: tooMany,
        },
      },
    })
    expect(result.ok).toBe(false)
  })

  it('passes through unknown params extension keys (forward-compat)', () => {
    // The schema uses `passthrough()` so future params fields don't break
    // older parents. Validate this stays intentional.
    const result = parseParentMessage({
      kind: 'init',
      payload: {
        sessionId: 'sess-3',
        params: {
          config: { id: 'anthropic', name: 'Anthropic', apiKey: 'k' },
          model: 'm',
          messages: [],
          futureExperimentalFlag: true,
        },
      },
    })
    expect(result.ok).toBe(true)
  })

  // Regression — see `SessionInitSchema.toolDefinitions` docstring.
  // Before adding the field to the schema, default `z.object()` stripped
  // it on parse, so `subAgentWorker.startSession` received
  // `init.toolDefinitions === undefined` and `registerRpcTools` was a
  // no-op. The worker then had only its builtin tool subset, and any
  // sub-agent (e.g. Explore) directed by its system prompt to call
  // TodoWrite / Skill / MemdirScan would loop on "unknown tool" — which
  // surfaced upstream as a permanent "booting" state for the first phase
  // member of `research-plan-verify` / `coordinator-led` templates.
  it('preserves toolDefinitions through round-trip parse (worker RPC tool plumbing)', () => {
    const toolDefs = [
      { name: 'Agent', description: 'spawn sub-agents', inputSchema: [] },
      { name: 'TodoWrite', description: 'manage todos', inputSchema: [] },
    ]
    const result = parseParentMessage({
      kind: 'init',
      payload: {
        sessionId: 'sess-rpc',
        params: {
          config: { id: 'anthropic', name: 'Anthropic', apiKey: 'k' },
          model: 'm',
          messages: [],
        },
        toolDefinitions: toolDefs,
      },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.kind).toBe('init')
    if (result.value.kind !== 'init') return
    expect(result.value.payload.toolDefinitions).toEqual(toolDefs)
  })

  it('accepts init payload without toolDefinitions (field is optional)', () => {
    const result = parseParentMessage({
      kind: 'init',
      payload: {
        sessionId: 'sess-no-rpc',
        params: {
          config: { id: 'anthropic', name: 'Anthropic', apiKey: 'k' },
          model: 'm',
          messages: [],
        },
      },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    if (result.value.kind !== 'init') return
    expect(result.value.payload.toolDefinitions).toBeUndefined()
  })

  it('rejects toolDefinitions entries missing required keys', () => {
    const result = parseParentMessage({
      kind: 'init',
      payload: {
        sessionId: 'sess-rpc-bad',
        params: {
          config: { id: 'anthropic', name: 'Anthropic', apiKey: 'k' },
          model: 'm',
          messages: [],
        },
        toolDefinitions: [
          { name: '', description: 'missing name', inputSchema: [] },
        ],
      },
    })
    expect(result.ok).toBe(false)
  })
})

describe('parseWorkerMessage', () => {
  it('accepts ready / started lifecycle messages', () => {
    expect(parseWorkerMessage({ kind: 'ready' }).ok).toBe(true)
    expect(parseWorkerMessage({ kind: 'started', sessionId: 'sess-1' }).ok).toBe(true)
  })

  it('accepts an event wrapping a LoopEvent', () => {
    const result = parseWorkerMessage({
      kind: 'event',
      event: { type: 'text_delta', text: 'hello' },
    })
    expect(result.ok).toBe(true)
  })

  it('accepts log lines at all levels', () => {
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      const r = parseWorkerMessage({ kind: 'log', level, message: 'm' })
      expect(r.ok).toBe(true)
    }
  })

  it('rejects log line with unknown level', () => {
    const r = parseWorkerMessage({ kind: 'log', level: 'critical', message: 'm' })
    expect(r.ok).toBe(false)
  })

  it('accepts done with fully-shaped AgenticLoopResult + fail with string error', () => {
    // P4.1 — done.result is now strictly validated (was z.unknown()).
    // The legacy `result: {}` payload no longer parses; tests must
    // supply the full shape to round-trip cleanly.
    const validResult = {
      terminationResult: {
        reason: 'completed',
        turnCount: 3,
        terminatedAt: Date.now(),
        totalUsage: { inputTokens: 100, outputTokens: 50 },
      },
      totalUsage: { inputTokens: 100, outputTokens: 50 },
      transition: 'tool_use',
      transitionHistory: ['init', 'tool_use'],
    }
    expect(parseWorkerMessage({ kind: 'done', result: validResult }).ok).toBe(true)
    expect(parseWorkerMessage({ kind: 'fail', error: 'crash' }).ok).toBe(true)
  })

  // ── P4.1 — strict wire schema for AgenticLoopResult ─────────────────
  //
  // Two regression nets: positive (every TerminationReason round-trips)
  // and negative (a stale worker sending an unknown reason gets rejected
  // at the wire boundary so the parent can surface a clear error rather
  // than routing a malformed result into the retry policy).

  it('P4.1: accepts every known TerminationReason in done.result', () => {
    for (const reason of KNOWN_TERMINATION_REASONS) {
      const r = parseWorkerMessage({
        kind: 'done',
        result: {
          terminationResult: {
            reason,
            turnCount: 1,
            terminatedAt: Date.now(),
          },
          totalUsage: { inputTokens: 0, outputTokens: 0 },
          transition: 'init',
          transitionHistory: [],
        },
      })
      expect(r.ok, `reason: ${reason}`).toBe(true)
    }
  })

  it('P4.1: rejects done with an unknown TerminationReason (stale worker)', () => {
    const r = parseWorkerMessage({
      kind: 'done',
      result: {
        terminationResult: {
          reason: 'experimental_future_reason',
          turnCount: 1,
          terminatedAt: Date.now(),
        },
        totalUsage: { inputTokens: 0, outputTokens: 0 },
        transition: 'init',
        transitionHistory: [],
      },
    })
    expect(r.ok).toBe(false)
  })

  it('rejects unknown kind', () => {
    expect(parseWorkerMessage({ kind: 'mystery' }).ok).toBe(false)
  })
})
