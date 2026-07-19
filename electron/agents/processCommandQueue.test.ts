import { describe, expect, it, vi } from 'vitest'
import {
  clearProcessCommandQueueForTests,
  drainProcessCommandQueueForAgent,
  enqueueProcessCommand,
} from './processCommandQueue'
import { getAgentContext } from './agentContext'

vi.mock('./agentContext', () => ({
  getAgentContext: vi.fn(),
}))

describe('processCommandQueue', () => {
  it('drains agent-scoped commands when sub-agent id matches', async () => {
    clearProcessCommandQueueForTests()
    vi.mocked(getAgentContext).mockReturnValue({
      agentId: 'main',
    } as ReturnType<typeof getAgentContext>)

    const runs: string[] = []
    enqueueProcessCommand({
      agentId: 'agent-x',
      label: 'x1',
      run: () => {
        runs.push('x1')
      },
    })
    enqueueProcessCommand({
      agentId: 'agent-y',
      label: 'y1',
      run: () => {
        runs.push('y1')
      },
    })

    await drainProcessCommandQueueForAgent('agent-x')
    expect(runs).toEqual(['x1'])

    await drainProcessCommandQueueForAgent('agent-y')
    expect(runs).toEqual(['x1', 'y1'])
  })
})
