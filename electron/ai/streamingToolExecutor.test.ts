import { describe, expect, it } from 'vitest'
import { STREAMING_TOOL_EXECUTOR_EDGES, type StreamingToolExecutorPhase } from './streamingToolExecutor'

describe('streamingToolExecutor (report §4.3 labels)', () => {
  it('defines a simple linear progression for docs/tests', () => {
    const walk = (p: StreamingToolExecutorPhase): StreamingToolExecutorPhase[] => {
      const out: StreamingToolExecutorPhase[] = [p]
      let cur = p
      for (;;) {
        const next = STREAMING_TOOL_EXECUTOR_EDGES[cur][0]
        if (!next) break
        out.push(next)
        cur = next
      }
      return out
    }
    expect(walk('queued')).toEqual(['queued', 'executing', 'completed', 'yielded'])
  })
})
