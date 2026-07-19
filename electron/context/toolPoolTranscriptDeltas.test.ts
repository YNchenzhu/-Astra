import { describe, expect, it } from 'vitest'
import {
  replayDeferredToolNamesFromTranscript,
  readLastBuiltInAgentTypesFromTranscript,
} from './toolPoolTranscriptDeltas'

describe('toolPoolTranscriptDeltas — transcript markers', () => {
  it('replays pole-dtd added/removed in order', () => {
    const messages: Array<Record<string, unknown>> = [
      {
        role: 'user',
        content:
          '<!-- pole-dtd:v1 added=Foo,Bar removed= -->\n',
      },
      {
        role: 'user',
        content: '<!-- pole-dtd:v1 added= removed=Foo -->\n',
      },
    ]
    const s = replayDeferredToolNamesFromTranscript(messages)
    expect(s.has('Bar')).toBe(true)
    expect(s.has('Foo')).toBe(false)
  })

  it('uses latest pole-ald types line', () => {
    const messages: Array<Record<string, unknown>> = [
      { role: 'user', content: '<!-- pole-ald:v1 types=alpha,beta -->' },
      { role: 'user', content: '<!-- pole-ald:v1 types=gamma -->' },
    ]
    const s = readLastBuiltInAgentTypesFromTranscript(messages)
    expect([...s].sort()).toEqual(['gamma'])
  })
})
