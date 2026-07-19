import { describe, expect, it } from 'vitest'
import { closeRunningSubAgentToolUses } from './subAgentToolState'
import type { ToolUseDisplay } from '../../types'

describe('closeRunningSubAgentToolUses', () => {
  it('marks unclosed running tools as stopped when a sub-agent completes', () => {
    const tools: ToolUseDisplay[] = [
      { id: 'running-1', name: 'Read', input: {}, status: 'running' },
      { id: 'done-1', name: 'Glob', input: {}, status: 'completed', result: 'ok' },
    ]

    const closed = closeRunningSubAgentToolUses(tools)

    expect(closed[0]).toMatchObject({
      id: 'running-1',
      status: 'stopped',
      error: expect.stringContaining('finished before this tool emitted a result'),
    })
    expect(closed[1]).toEqual(tools[1])
  })
})
