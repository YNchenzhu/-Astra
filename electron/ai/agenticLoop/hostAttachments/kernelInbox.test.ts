import { describe, expect, it, vi } from 'vitest'
import { kernelInboxCollector } from './kernelInbox'
import { makeAttachmentFixture } from './testFixtures'

describe('kernelInboxCollector', () => {
  it('runs at post_tool and no_tools_continue', () => {
    expect(kernelInboxCollector.callSites).toEqual(['post_tool', 'no_tools_continue'])
  })

  it('is a no-op when the Host drain is missing', async () => {
    const ctx = makeAttachmentFixture({})
    expect(await kernelInboxCollector.run(ctx)).toBeNull()
  })

  it('is a no-op when the Host did not inject a snapshot', async () => {
    const drainInbox = vi.fn(() => ({ injected: false as const }))
    const ctx = makeAttachmentFixture({
      stateOverrides: { hostTranscript: { commit: vi.fn(), drainInbox } },
    })

    expect(await kernelInboxCollector.run(ctx)).toBeNull()
    expect(drainInbox).toHaveBeenCalledTimes(1)
  })

  it('accepts the exact Host-authoritative snapshot without reconstructing messages', async () => {
    const messages = [
      { role: 'user', content: 'start' },
      {
        role: 'user',
        content: '<system-reminder>\nlate ping\n</system-reminder>',
        _convertedFromSystem: true,
        _sideChannelKind: 'generic_converted_system',
      },
    ]
    const drainInbox = vi.fn(() => ({
      injected: true as const,
      snapshot: {
        revision: 4,
        fingerprint: 'fingerprint',
        messages,
      },
    }))
    const acceptHostTranscript = vi.fn()
    const ctx = makeAttachmentFixture({
      iteration: 7,
      stateOverrides: {
        acceptHostTranscript,
        hostTranscript: { commit: vi.fn(), drainInbox },
      },
    })

    expect(await kernelInboxCollector.run(ctx)).toBeNull()
    expect(acceptHostTranscript).toHaveBeenCalledWith(messages)
    expect(ctx.state.appendixReport).toHaveBeenCalledWith(
      'P2_Q_inter_agent_inject',
      {
        iteration: 7,
        source: 'kernel_inbox',
        transcriptRevision: 4,
      },
    )
  })
})
