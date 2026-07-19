/**
 * `TransportPort.emitPhase` typed sink + `emitPhaseEvent` fallback.
 *
 * Invariants asserted:
 *   1. `createTransportAdapter`-built transports emit the exact same `StreamEvent` shape via
 *      `emit` and `emitPhase` (renderer subscribers can switch without behaviour drift).
 *   2. `emitPhaseEvent` prefers the typed sink when present; falls back to `emit` for legacy
 *      mocks that only provide `{ emit }`.
 *   3. Adapter swallows transport throws so kernel callsites never crash on a flaky sink.
 */

import { describe, expect, it, vi } from 'vitest'
import { createTransportAdapter, emitPhaseEvent } from './transport'
import type { OrchestrationPhasePayload, TransportPort } from './ports'

const samplePayload: OrchestrationPhasePayload = {
  phase: 'CallModel',
  iteration: 3,
  innerIteration: 2,
  conversationId: 'conv-1',
  interruptReason: undefined,
}

describe('TransportPort sinks (P1.1)', () => {
  it('createTransportAdapter routes emitPhase to the same emit callback', () => {
    const emit = vi.fn()
    const transport = createTransportAdapter(emit)
    transport.emitPhase?.(samplePayload)
    expect(emit).toHaveBeenCalledTimes(1)
    const ev = emit.mock.calls[0][0] as Record<string, unknown>
    expect(ev.type).toBe('orchestration_phase')
    expect(ev.orchestrationPhase).toBe('CallModel')
    expect(ev.orchestrationIteration).toBe(3)
    expect(ev.orchestrationInnerIteration).toBe(2)
    expect(ev.conversationId).toBe('conv-1')
    // Optional fields not provided → MUST be absent (not undefined) so the renderer can
    // rely on `field in event` checks.
    expect('interruptReason' in ev).toBe(false)
    expect('artifactManifest' in ev).toBe(false)
    expect('permissionDenial' in ev).toBe(false)
  })

  it('emitPhaseEvent prefers the typed sink when present', () => {
    const emit = vi.fn()
    const emitPhase = vi.fn()
    const transport: TransportPort = { emit, emitPhase }
    emitPhaseEvent(transport, samplePayload)
    expect(emitPhase).toHaveBeenCalledWith(samplePayload)
    expect(emit).not.toHaveBeenCalled()
  })

  it('emitPhaseEvent falls back to emit() when only emit is implemented (legacy mocks)', () => {
    const emit = vi.fn()
    const transport: TransportPort = { emit }
    emitPhaseEvent(transport, samplePayload)
    expect(emit).toHaveBeenCalledTimes(1)
    const ev = emit.mock.calls[0][0] as Record<string, unknown>
    expect(ev.type).toBe('orchestration_phase')
    expect(ev.orchestrationPhase).toBe('CallModel')
  })

  it('emitPhaseEvent swallows transport throws (kernel hot path must never bubble)', () => {
    const transport: TransportPort = {
      emit: () => {
        throw new Error('renderer pipe closed')
      },
    }
    expect(() => emitPhaseEvent(transport, samplePayload)).not.toThrow()
  })

  it('emits artifactManifest payload through both paths', () => {
    const emit = vi.fn()
    const adapter = createTransportAdapter(emit)
    const manifest: NonNullable<OrchestrationPhasePayload['artifactManifest']> = {
      turn: 7,
      entries: [
        {
          id: 'a1',
          kind: 'diff',
          producer: 'Edit',
          producerTurn: 7,
          payload: { filePath: '/foo.ts' },
          at: 1700000000000,
        },
      ],
    }
    adapter.emitPhase?.({
      phase: 'artifact_manifest',
      iteration: 7,
      innerIteration: 0,
      conversationId: 'conv-2',
      artifactManifest: manifest,
    })
    const ev = emit.mock.calls[0][0] as Record<string, unknown>
    expect(ev.orchestrationPhase).toBe('artifact_manifest')
    expect(ev.artifactManifest).toEqual(manifest)
  })

  it('emits permissionDenial payload (DefaultToolRuntimePort callsite shape)', () => {
    const emit = vi.fn()
    const adapter = createTransportAdapter(emit)
    adapter.emitPhase?.({
      phase: 'permission_denied_preflight',
      iteration: 0,
      permissionDenial: {
        toolName: 'Bash',
        toolUseId: 'tu_42',
        reason: 'nope',
        matchedRule: 'kernel:rule',
      },
    })
    const ev = emit.mock.calls[0][0] as Record<string, unknown>
    expect(ev.orchestrationPhase).toBe('permission_denied_preflight')
    expect(ev.permissionDenial).toEqual({
      toolName: 'Bash',
      toolUseId: 'tu_42',
      reason: 'nope',
      matchedRule: 'kernel:rule',
    })
    // iteration 0 sentinel still surfaces (renderer groups by toolUseId, not iteration).
    expect(ev.orchestrationIteration).toBe(0)
    // No conversationId provided → not in event.
    expect('conversationId' in ev).toBe(false)
  })

  it('drops empty conversationId rather than leaking the trim() ternary into the wire', () => {
    const emit = vi.fn()
    const adapter = createTransportAdapter(emit)
    adapter.emitPhase?.({ phase: 'Idle', iteration: 0, conversationId: '   ' })
    const ev = emit.mock.calls[0][0] as Record<string, unknown>
    expect('conversationId' in ev).toBe(false)
  })
})

// ── Audit P2 §6.3 — discriminated-union per-variant builders ──

describe('Phase event builders (audit P2 §6.3)', () => {
  it('buildKernelFsmPhase produces a payload with FSM tag and only common fields', async () => {
    const { buildKernelFsmPhase } = await import('./transport')
    const p = buildKernelFsmPhase({ phase: 'CallModel', iteration: 5, innerIteration: 2 })
    expect(p.phase).toBe('CallModel')
    expect(p.iteration).toBe(5)
    expect(p.innerIteration).toBe(2)
    // No discriminant-specific fields leak.
    expect('preemption' in p).toBe(false)
    expect('hitlPending' in p).toBe(false)
  })

  it('buildInterruptPhase carries interruptReason; hitlPending optional', async () => {
    const { buildInterruptPhase } = await import('./transport')
    const p1 = buildInterruptPhase({ iteration: 1, interruptReason: 'user' })
    expect(p1.phase).toBe('interrupt')
    expect(p1.interruptReason).toBe('user')
    expect('hitlPending' in p1).toBe(false)

    const p2 = buildInterruptPhase({
      iteration: 1,
      interruptReason: 'hitl',
      hitlPending: { toolUseId: 'tu_1', question: { q: 'k?' }, kind: 'ask_user_question' },
    })
    expect(p2.hitlPending).toEqual({
      toolUseId: 'tu_1',
      question: { q: 'k?' },
      kind: 'ask_user_question',
    })
  })

  it('buildPreemptionPhase carries the typed preemption payload', async () => {
    const { buildPreemptionPhase, emitPhaseEvent } = await import('./transport')
    const emit = vi.fn()
    const adapter = createTransportAdapter(emit)
    emitPhaseEvent(
      adapter,
      buildPreemptionPhase({
        iteration: 4,
        innerIteration: 1,
        conversationId: 'conv-x',
        preemption: {
          victimToolUseId: 'tu_v',
          victimToolName: 'bash',
          incomingToolUseId: 'tu_i',
          incomingToolName: 'WebFetch',
          resource: 'shell',
          victimPriority: 30,
          incomingPriority: 70,
        },
      }),
    )
    const ev = emit.mock.calls[0][0] as Record<string, unknown>
    expect(ev.orchestrationPhase).toBe('tool_preempted')
    expect(ev.preemption).toMatchObject({
      victimToolUseId: 'tu_v',
      incomingToolName: 'WebFetch',
      resource: 'shell',
    })
    expect(ev.conversationId).toBe('conv-x')
  })

  it('buildOuterLoopPhase / buildHitlFailedPhase / buildArtifactManifestPhase wire-format ', async () => {
    const {
      buildOuterLoopPhase,
      buildHitlFailedPhase,
      buildArtifactManifestPhase,
    } = await import('./transport')
    const outer = buildOuterLoopPhase({
      iteration: 1,
      outerLoopStats: {
        iterations: 3,
        overflowed: false,
        exitReason: 'completed',
        inboxRemaining: 0,
        maxOuterIterations: 16,
      },
    })
    expect(outer.phase).toBe('outer_loop_complete')
    expect(outer.outerLoopStats.exitReason).toBe('completed')

    const hitl = buildHitlFailedPhase({
      iteration: 1,
      hitlPersistenceFailed: { reason: 'disk_error', error: 'EIO', pendingHumanResumeCount: 2 },
    })
    expect(hitl.phase).toBe('hitl_persistence_failed')
    expect(hitl.hitlPersistenceFailed.reason).toBe('disk_error')

    const art = buildArtifactManifestPhase({
      iteration: 2,
      artifactManifest: { turn: 2, entries: [] },
    })
    expect(art.phase).toBe('artifact_manifest')
    expect(art.artifactManifest.turn).toBe(2)
  })

  it('builders trim conversationId and drop empty/whitespace strings', async () => {
    const { buildLifecyclePhase } = await import('./transport')
    const trimmed = buildLifecyclePhase({
      phase: 'paused',
      iteration: 1,
      conversationId: '  spaced  ',
    })
    expect(trimmed.conversationId).toBe('spaced')

    const dropped = buildLifecyclePhase({
      phase: 'paused',
      iteration: 1,
      conversationId: '   ',
    })
    expect('conversationId' in dropped).toBe(false)
  })
})
