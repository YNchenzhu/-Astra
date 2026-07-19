import { describe, expect, it } from 'vitest'
import { formatTranscriptDriftDetail } from './orchestrationStreamEvents'

describe('formatTranscriptDriftDetail', () => {
  it('describes equal-length divergence as a content fingerprint mismatch', () => {
    const detail = formatTranscriptDriftDetail({
      agentContextLength: 6,
      kernelTranscriptLength: 6,
      resolvedWith: 'kernel',
      checkpoint: 'terminal_commit',
    })

    expect(detail).toContain('内容指纹不一致')
    expect(detail).not.toContain('长度不一致')
  })

  it('describes a real count divergence as a message-count mismatch', () => {
    const detail = formatTranscriptDriftDetail({
      agentContextLength: 7,
      kernelTranscriptLength: 6,
      resolvedWith: 'kernel',
      checkpoint: 'iteration_boundary',
    })

    expect(detail).toContain('消息数量不一致')
    expect(detail).toContain('AgentContext 7 条 vs 内核 6 条')
  })
})
