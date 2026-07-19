import { describe, expect, it } from 'vitest'
import {
  USER_INPUT_INBOX_SOURCE,
  createInitialKernelLoopState,
  normalizeKernelLoopState,
} from './kernelTypes'
import {
  applySessionCommands,
  applyTranscriptCommit,
  drainInboxToTranscript,
  flushInboxToTranscript,
} from './sessionCommands'
import {
  KERNEL_USER_INPUT_MARKER,
  SIDE_CHANNEL_KIND,
  makeSideChannelUserMessage,
} from '../constants/sideChannelKinds'

describe('applySessionCommands', () => {
  it('syncs transcript from renderer messages', () => {
    const s0 = createInitialKernelLoopState([])
    const state = applySessionCommands(s0, [
      {
        kind: 'SyncTranscriptFromRenderer',
        messages: [{ role: 'user', content: 'hi' }],
      },
    ])
    expect(state.transcript).toEqual([{ role: 'user', content: 'hi' }])
    expect(state.transcriptRevision).toBe(1)
    expect(state.transcriptFingerprint).not.toBe(s0.transcriptFingerprint)
  })

  it('rejects a stale transcript commit without changing accepted state', () => {
    const seeded = applySessionCommands(createInitialKernelLoopState([]), [
      { kind: 'SyncTranscriptFromRenderer', messages: [{ role: 'user', content: 'seed' }] },
    ])
    const accepted = applyTranscriptCommit(seeded, {
      baseRevision: seeded.transcriptRevision,
      source: 'agent_loop',
      messages: [
        { role: 'user', content: 'seed' },
        { role: 'assistant', content: 'accepted' },
      ],
    })
    expect(accepted.result.ok).toBe(true)
    const stale = applyTranscriptCommit(accepted.state, {
      baseRevision: seeded.transcriptRevision,
      source: 'agent_loop',
      messages: [{ role: 'assistant', content: 'stale overwrite' }],
    })
    expect(stale.result).toEqual({
      ok: false,
      kind: 'revision_conflict',
      expectedRevision: seeded.transcriptRevision,
      actualRevision: accepted.state.transcriptRevision,
    })
    expect(stale.state).toBe(accepted.state)
    expect(stale.state.transcript.at(-1)?.content).toBe('accepted')
  })

  it('upgrades a legacy state without revision fields at load time', () => {
    const legacy = {
      phase: 'Idle' as const,
      iteration: 0,
      innerIteration: 0,
      transcript: [{ role: 'user', content: 'legacy' }],
      inbox: [],
      maxOutputRecoveryCycles: 0,
      consecutiveCompactFailures: 0,
    }
    const upgraded = normalizeKernelLoopState(legacy)
    expect(upgraded.transcriptRevision).toBe(0)
    expect(upgraded.transcriptFingerprint).toHaveLength(64)
  })

  it('flushes inbox as a canonical host side-channel message', () => {
    let s = createInitialKernelLoopState([])
    s = applySessionCommands(s, [
      { kind: 'SyncTranscriptFromRenderer', messages: [{ role: 'user', content: 'base' }] },
      { kind: 'EnqueueInbox', item: { kind: 'synthetic_user_text', text: 'extra' } },
    ])
    const state = flushInboxToTranscript(s)
    expect(state.inbox).toHaveLength(0)
    expect(state.transcript).toEqual([
      { role: 'user', content: 'base' },
      makeSideChannelUserMessage(SIDE_CHANNEL_KIND.genericConvertedSystem, 'extra'),
    ])
  })

  it('keeps a tool_result turn pure and appends the side-channel after it', () => {
    let s = createInitialKernelLoopState([])
    s = applySessionCommands(s, [
      {
        kind: 'SyncTranscriptFromRenderer',
        messages: [
          { role: 'user', content: 'prompt' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'calling tool' },
              { type: 'tool_use', id: 'tu_1', name: 'Read', input: {} },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tu_1', content: 'file contents' },
            ],
          },
        ],
      },
      { kind: 'EnqueueInbox', item: { kind: 'synthetic_user_text', text: 'synthetic' } },
    ])
    const state = flushInboxToTranscript(s)
    expect(state.inbox).toHaveLength(0)
    expect(state.transcript).toHaveLength(4)
    // tool_result user turn stays pure, synthetic text lands in a fresh user turn.
    expect(state.transcript[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'file contents' }],
    })
    expect(state.transcript[3]).toEqual(
      makeSideChannelUserMessage(SIDE_CHANNEL_KIND.genericConvertedSystem, 'synthetic'),
    )
  })

  it('does not merge host text into a structured user turn', () => {
    let s = createInitialKernelLoopState([])
    s = applySessionCommands(s, [
      {
        kind: 'SyncTranscriptFromRenderer',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'question' }],
          },
        ],
      },
      { kind: 'EnqueueInbox', item: { kind: 'synthetic_user_text', text: 'extra' } },
    ])
    const state = flushInboxToTranscript(s)
    expect(state.transcript).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'question' }],
      },
      makeSideChannelUserMessage(SIDE_CHANNEL_KIND.genericConvertedSystem, 'extra'),
    ])
  })

  it('atomically returns the accepted snapshot for real mid-turn user input', () => {
    let state = createInitialKernelLoopState([{ role: 'user', content: 'start' }])
    state = applySessionCommands(state, [
      {
        kind: 'EnqueueInbox',
        item: {
          kind: 'synthetic_user_text',
          text: 'switch to the login bug',
          source: USER_INPUT_INBOX_SOURCE,
        },
      },
    ])

    const drained = drainInboxToTranscript(state)

    expect(drained.snapshot?.revision).toBe(state.transcriptRevision + 1)
    expect(drained.snapshot?.messages.at(-1)).toEqual(
      makeSideChannelUserMessage(
        SIDE_CHANNEL_KIND.kernelUserInput,
        `${KERNEL_USER_INPUT_MARKER}\nswitch to the login bug`,
      ),
    )
    expect(drained.state.inbox).toHaveLength(0)
    expect(drained.snapshot?.fingerprint).toBe(drained.state.transcriptFingerprint)
  })
})
