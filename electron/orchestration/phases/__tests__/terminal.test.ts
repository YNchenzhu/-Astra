/**
 * Audit SA-6 — Terminal-phase transcript commit contract.
 *
 * The Terminal phase validates `AgentContext.messages` against the Kernel's
 * accepted snapshot, but the Kernel remains the commit authority.
 *
 * The committed snapshot is deep-copied, and the warn-only divergence check
 * compares complete message identities. Runtime metadata must be preserved on
 * both sides so equal healthy mirrors do not become same-length false positives.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

// ─── AgentContext mock (the only heavyweight dependency) ─────────────

let agentCtxValue:
  | { messages: Array<Record<string, unknown>> }
  | undefined

vi.mock('../../../agents/agentContext', () => ({
  getAgentContext: () => agentCtxValue,
}))

import { runTerminalPhase } from '../terminal'
import { __resetCloneDegradationCountsForTests } from '../../../ai/agenticLoopHelpers'
import { fingerprintTranscript, type KernelLoopState } from '../../kernelTypes'
import type { KernelPhaseCtx } from '../types'

// ─── Fake KernelPhaseCtx ──────────────────────────────────────────────

function makeCtx(initialTranscript: Array<Record<string, unknown>>): {
  ctx: KernelPhaseCtx
  getState: () => KernelLoopState
  onTranscriptCommitted: ReturnType<typeof vi.fn>
  emit: ReturnType<typeof vi.fn>
} {
  let state: KernelLoopState = {
    phase: 'CallModel',
    iteration: 1,
    innerIteration: 0,
    transcript: structuredClone(initialTranscript),
    transcriptRevision: 0,
    transcriptFingerprint: fingerprintTranscript(initialTranscript),
    inbox: [],
    maxOutputRecoveryCycles: 0,
    consecutiveCompactFailures: 0,
  }
  const onTranscriptCommitted = vi.fn(async () => {})
  const emit = vi.fn()
  const ctx = {
    get state() {
      return state
    },
    setState(next: KernelLoopState) {
      state = next
    },
    ports: {
      tools: {},
      permission: {},
      session: { onTranscriptCommitted },
      transport: { emit },
      hooks: {},
    },
    observer: undefined,
    streamConversationId: undefined,
    abortController: new AbortController(),
    hardAbortController: new AbortController(),
    emitPhase: vi.fn(),
    snapshot: vi.fn(),
    buildArtifactManifest: () => undefined,
    persistInbox: vi.fn(),
    wrapAppendixAReporterWithIterationTracking: (r: unknown) => r,
    drainInboxForInnerIteration: () => ({ injected: false }),
  } as unknown as KernelPhaseCtx
  return { ctx, getState: () => state, onTranscriptCommitted, emit }
}

beforeEach(() => {
  agentCtxValue = undefined
  __resetCloneDegradationCountsForTests()
})

describe('runTerminalPhase — SA-6 deep-copy commit', () => {
  it('commits a deep copy: mutating AgentContext content afterwards does not leak into the committed snapshot', async () => {
    const liveContent = [{ type: 'text', text: 'original' }]
    agentCtxValue = {
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: liveContent },
      ],
    }
    const { ctx, getState, onTranscriptCommitted } = makeCtx([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'original' }] },
    ])

    await runTerminalPhase(ctx)

    // Loop side mutates its live blocks AFTER the commit.
    liveContent[0].text = 'mutated-after-commit'

    // Kernel state committed from AgentContext, unaffected by the mutation.
    const committed = getState().transcript
    expect(committed.length).toBe(2)
    expect(
      (committed[1].content as Array<{ text: string }>)[0].text,
    ).toBe('original')

    // The snapshot handed to the session store must not alias live blocks.
    const persisted = onTranscriptCommitted.mock
      .calls[0]![0] as Array<Record<string, unknown>>
    expect((persisted[1].content as Array<{ text: string }>)[0].text).toBe(
      'original',
    )
    expect(persisted[1].content).not.toBe(liveContent)
  })

  it('warns (behaviour unchanged) when AgentContext and kernel transcript lengths diverge', async () => {
    agentCtxValue = {
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'follow-up' },
      ],
    }
    const { ctx, getState } = makeCtx([{ role: 'user', content: 'hi' }])

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await runTerminalPhase(ctx)
      const divergence = warn.mock.calls
        .map((c) => String(c[0]))
        .find((s) => s.includes('diverged'))
      expect(divergence).toBeDefined()
      expect(divergence).toContain('(3)')
      expect(divergence).toContain('(1)')
    } finally {
      warn.mockRestore()
    }
    // Kernel remains the only commit authority.
    expect(getState().transcript.length).toBe(1)
  })

  it('does not warn when lengths agree', async () => {
    agentCtxValue = {
      messages: [{ role: 'user', content: 'hi' }],
    }
    const { ctx } = makeCtx([{ role: 'user', content: 'hi' }])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await runTerminalPhase(ctx)
      const divergence = warn.mock.calls
        .map((c) => String(c[0]))
        .find((s) => s.includes('diverged'))
      expect(divergence).toBeUndefined()
    } finally {
      warn.mockRestore()
    }
  })

  it('does not report drift when both mirrors contain the same runtime usage metadata', async () => {
    const transcript = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'answer' }],
        _poleContextUsage: { inputTokens: 12, outputTokens: 4 },
      },
    ]
    agentCtxValue = { messages: structuredClone(transcript) }
    const { ctx, emit } = makeCtx(transcript)

    await runTerminalPhase(ctx)

    const drift = emit.mock.calls
      .map((call) => call[0] as { orchestrationPhase?: string })
      .find((event) => event.orchestrationPhase === 'transcript_drift')
    expect(drift).toBeUndefined()
  })

  it('still reports same-length semantic content drift', async () => {
    agentCtxValue = {
      messages: [{ role: 'user', content: 'agent-context value' }],
    }
    const { ctx, emit } = makeCtx([{ role: 'user', content: 'kernel value' }])

    await runTerminalPhase(ctx)

    const drift = emit.mock.calls
      .map((call) => call[0] as {
        orchestrationPhase?: string
        transcriptDrift?: { agentContextLength: number; kernelTranscriptLength: number }
      })
      .find((event) => event.orchestrationPhase === 'transcript_drift')
    expect(drift?.transcriptDrift).toMatchObject({
      agentContextLength: 1,
      kernelTranscriptLength: 1,
    })
  })

  it('falls back to cloning kernel state when AgentContext has no messages', async () => {
    agentCtxValue = undefined
    const original = [{ role: 'user', content: 'kernel-side' }]
    const { ctx, getState, onTranscriptCommitted } = makeCtx(original)

    await runTerminalPhase(ctx)

    expect(onTranscriptCommitted).toHaveBeenCalledTimes(1)
    const committed = getState().transcript
    expect(committed).toEqual([{ role: 'user', content: 'kernel-side' }])
    expect(committed[0]).not.toBe(original[0])
  })

  it('survives structuredClone-hostile content via the JSON fallback and still commits', async () => {
    // Symbol values: structuredClone throws, JSON drops them. Pre-fix this
    // made the channel's bare structuredClone throw inside
    // applySessionCommands and the commit was silently lost.
    agentCtxValue = {
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'ok', _marker: Symbol('m') }],
        },
      ],
    }
    const { ctx, getState, onTranscriptCommitted } = makeCtx([
      { role: 'user', content: 'hi' },
    ])

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await runTerminalPhase(ctx)
    } finally {
      warn.mockRestore()
    }

    // Commit happened from the accepted Kernel snapshot; hostile mirror data
    // is diagnostic-only and cannot overwrite it.
    expect(onTranscriptCommitted).toHaveBeenCalledTimes(1)
    const committed = getState().transcript
    expect(committed).toEqual([{ role: 'user', content: 'hi' }])
  })
})
