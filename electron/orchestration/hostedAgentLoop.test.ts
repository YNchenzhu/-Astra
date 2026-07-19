import { describe, expect, it } from 'vitest'
import { createInMemoryAgentLoopHost } from './hostedAgentLoop'
import { fingerprintTranscript } from './kernelTypes'

const signal = new AbortController().signal

describe('createInMemoryAgentLoopHost', () => {
  it('continues revisions from a parent-acknowledged snapshot', () => {
    const messages = [{ role: 'user', content: 'resume' }]
    const host = createInMemoryAgentLoopHost(
      { messages: [], initialApiMessages: [], signal },
      {
        initialSnapshot: {
          revision: 5,
          fingerprint: fingerprintTranscript(messages),
          messages,
        },
      },
    )

    expect(host.transcript.getSnapshot()).toMatchObject({ revision: 5, messages })
    const nextMessages = [...messages, { role: 'assistant', content: 'continued' }]
    expect(host.transcript.commit(nextMessages)).toMatchObject({
      revision: 6,
      messages: nextMessages,
    })
  })

  it('rejects a corrupted initial snapshot before the model starts', () => {
    expect(() =>
      createInMemoryAgentLoopHost(
        { messages: [], initialApiMessages: [], signal },
        {
          initialSnapshot: {
            revision: 2,
            fingerprint: '0'.repeat(64),
            messages: [{ role: 'user', content: 'corrupt' }],
          },
        },
      ),
    ).toThrow(/fingerprint mismatch/)
  })
})
