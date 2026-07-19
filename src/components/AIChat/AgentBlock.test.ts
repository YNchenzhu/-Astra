import { describe, expect, it } from 'vitest'
import { getAgentOutputLabel, parseTodoPayloadFromAgentOutput } from './AgentBlock'

describe('getAgentOutputLabel', () => {
  it('labels running output as streaming rather than final output', () => {
    expect(getAgentOutputLabel(true)).toBe('Streaming output (进行中)')
  })

  it('labels terminal output as final output', () => {
    expect(getAgentOutputLabel(false)).toBe('Output')
  })
})

describe('parseTodoPayloadFromAgentOutput', () => {
  it('recognizes bare TodoWrite arrays emitted as final output', () => {
    const parsed = parseTodoPayloadFromAgentOutput(JSON.stringify([
      {
        activeForm: 'Testing team creation',
        content: 'Test TeamCreate',
        status: 'completed',
      },
      {
        activeForm: 'Testing team status',
        content: 'Test TeamStatus',
        status: 'pending',
      },
    ]))

    expect(parsed).toEqual([
      {
        activeForm: 'Testing team creation',
        content: 'Test TeamCreate',
        status: 'completed',
      },
      {
        activeForm: 'Testing team status',
        content: 'Test TeamStatus',
        status: 'pending',
      },
    ])
  })

  it('ignores normal output text', () => {
    expect(parseTodoPayloadFromAgentOutput('Finished the investigation.')).toBeUndefined()
  })
})
