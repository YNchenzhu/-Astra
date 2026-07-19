/**
 * Goal-drift score monitor (#3, 2026-07 deep-loop uplift) tests.
 *
 * The embedding backend is mocked — these tests cover the deterministic
 * machinery: opt-in gating, sampling cadence, cosine math, activity-text
 * extraction, score ring, low-score episode notices, and the process-wide
 * failure latch.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const mockGetAgentContext = vi.fn<() => { agentId?: string; streamConversationId?: string } | undefined>(
  () => ({ agentId: 'main', streamConversationId: 'conv-1' }),
)
vi.mock('../../../agents/agentContext', () => ({
  getAgentContext: () => mockGetAgentContext(),
}))

let mockObjective = ''
vi.mock('../../../tools/TodoWriteTool', () => ({
  getTodoObjective: () => mockObjective,
}))

let mockEmbedResult: { ok: boolean; vectors: number[][]; error?: string } = {
  ok: true,
  vectors: [],
}
const mockEmbed = vi.fn(async () => mockEmbedResult)
vi.mock('../../../embedding/highLevelApi', () => ({
  embedTextsViaSettings: (texts: string[]) => mockEmbed(texts),
}))

import {
  DRIFT_SCORE_MARKER,
  DEFAULT_INTERVAL_ITERATIONS,
  buildRecentActivityText,
  cosineSimilarity,
  driftScoreMonitorCollector,
  getDriftScores,
  __resetDriftMonitorForTests,
} from './driftScoreMonitor'
import type { AttachmentContext } from '../hostAttachments'
import type { LoopState } from '../loopShared'

function ctxAt(iteration: number, messages?: Array<Record<string, unknown>>): AttachmentContext {
  const state = {
    iteration,
    apiMessages: messages ?? [
      { role: 'user', content: '重构支付模块' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'working on it' },
          { type: 'tool_use', id: 't1', name: 'edit_file', input: { file_path: 'src/pay.ts' } },
        ],
      },
    ],
    appendixReport: () => {},
  } as unknown as LoopState
  return { state, systemPrompt: 'sys', callSite: 'post_tool' }
}

beforeEach(() => {
  __resetDriftMonitorForTests()
  mockObjective = '重构支付模块并保持接口兼容'
  mockGetAgentContext.mockReturnValue({ agentId: 'main', streamConversationId: 'conv-1' })
  mockEmbedResult = { ok: true, vectors: [[1, 0], [1, 0]] }
  mockEmbed.mockClear()
  process.env.POLE_DRIFT_MONITOR = '1'
})

afterEach(() => {
  delete process.env.POLE_DRIFT_MONITOR
  delete process.env.POLE_DRIFT_MONITOR_INTERVAL
  delete process.env.POLE_DRIFT_MONITOR_THRESHOLD
})

describe('cosineSimilarity', () => {
  it('1 for identical, 0 for orthogonal / degenerate', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1)
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0)
    expect(cosineSimilarity([], [])).toBe(0)
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0)
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0)
  })
})

describe('buildRecentActivityText', () => {
  it('summarizes recent tool calls (name + primary arg) and last assistant text', () => {
    const text = buildRecentActivityText([
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'a', name: 'Grep', input: { pattern: 'checkout' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'x' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'now editing the payment module' },
          { type: 'tool_use', id: 'b', name: 'edit_file', input: { file_path: 'src/pay.ts' } },
        ],
      },
    ])
    expect(text).toContain('Grep: checkout')
    expect(text).toContain('edit_file: src/pay.ts')
    expect(text).toContain('now editing the payment module')
  })

  it('empty for a transcript without assistant activity', () => {
    expect(buildRecentActivityText([{ role: 'user', content: 'hi' }])).toBe('')
  })
})

describe('driftScoreMonitorCollector', () => {
  it('is opt-in: does nothing without POLE_DRIFT_MONITOR=1', async () => {
    delete process.env.POLE_DRIFT_MONITOR
    expect(await driftScoreMonitorCollector.run(ctxAt(20))).toBeNull()
    expect(mockEmbed).not.toHaveBeenCalled()
  })

  it('samples every K post-tool passes (tick-based) and records the score ring', async () => {
    process.env.POLE_DRIFT_MONITOR_INTERVAL = '2'
    await driftScoreMonitorCollector.run(ctxAt(1)) // tick 1 — skipped
    await driftScoreMonitorCollector.run(ctxAt(2)) // tick 2 — sample 1
    await driftScoreMonitorCollector.run(ctxAt(3)) // tick 1 — skipped
    await driftScoreMonitorCollector.run(ctxAt(4)) // tick 2 — sample 2
    expect(mockEmbed).toHaveBeenCalledTimes(2)
    const scores = getDriftScores('conv-1')
    expect(scores.map((s) => s.iteration)).toEqual([2, 4])
    expect(scores[0]!.score).toBeCloseTo(1)
  })

  it('audit regression: cadence survives the per-turn iteration reset', async () => {
    // `state.iteration` resets to 1 on every user turn while the drift state
    // persists per conversation. The old iteration-delta cadence went
    // negative after a turn boundary and never sampled again; the tick
    // counter must keep sampling across turns.
    process.env.POLE_DRIFT_MONITOR_INTERVAL = '3'
    // Turn A: iterations 1..3 → sample on the 3rd pass.
    await driftScoreMonitorCollector.run(ctxAt(1))
    await driftScoreMonitorCollector.run(ctxAt(2))
    await driftScoreMonitorCollector.run(ctxAt(3))
    expect(mockEmbed).toHaveBeenCalledTimes(1)
    // Turn B: iteration counter RESET to 1..3 → must sample again.
    await driftScoreMonitorCollector.run(ctxAt(1))
    await driftScoreMonitorCollector.run(ctxAt(2))
    await driftScoreMonitorCollector.run(ctxAt(3))
    expect(mockEmbed).toHaveBeenCalledTimes(2)
  })

  it('high scores stay silent; a low score emits ONE notice per episode', async () => {
    process.env.POLE_DRIFT_MONITOR_INTERVAL = '1'
    process.env.POLE_DRIFT_MONITOR_THRESHOLD = '0.5'
    // Low-similarity vectors → score 0.
    mockEmbedResult = { ok: true, vectors: [[1, 0], [0, 1]] }
    const first = await driftScoreMonitorCollector.run(ctxAt(10))
    expect(first).not.toBeNull()
    const body = String(((first as { message: { content: unknown } }).message).content)
    expect(body).toContain(DRIFT_SCORE_MARKER)
    expect(body).toContain('重构支付模块并保持接口兼容')
    // Still low next sample — same episode, no second notice.
    expect(await driftScoreMonitorCollector.run(ctxAt(11))).toBeNull()
    // Recovery resets the episode…
    mockEmbedResult = { ok: true, vectors: [[1, 0], [1, 0]] }
    expect(await driftScoreMonitorCollector.run(ctxAt(12))).toBeNull()
    // …so a NEW low episode notices again.
    mockEmbedResult = { ok: true, vectors: [[1, 0], [0, 1]] }
    expect(await driftScoreMonitorCollector.run(ctxAt(13))).not.toBeNull()
  })

  it('falls back to the anchored user query when no objective is recorded', async () => {
    mockObjective = ''
    process.env.POLE_DRIFT_MONITOR_INTERVAL = '1'
    await driftScoreMonitorCollector.run(ctxAt(10))
    expect(mockEmbed).toHaveBeenCalledTimes(1)
    const texts = mockEmbed.mock.calls[0]![0] as string[]
    expect(texts[0]).toContain('重构支付模块') // from the user message
  })

  it('first embedding failure latches the monitor off for the process', async () => {
    process.env.POLE_DRIFT_MONITOR_INTERVAL = '1'
    mockEmbedResult = { ok: false, vectors: [], error: 'model missing' }
    expect(await driftScoreMonitorCollector.run(ctxAt(10))).toBeNull()
    expect(await driftScoreMonitorCollector.run(ctxAt(11))).toBeNull()
    expect(await driftScoreMonitorCollector.run(ctxAt(12))).toBeNull()
    expect(mockEmbed).toHaveBeenCalledTimes(1) // no retry spam
    expect(getDriftScores('conv-1')).toHaveLength(0)
  })

  it('main-chat only', async () => {
    mockGetAgentContext.mockReturnValue({ agentId: 'explore-1', streamConversationId: 'conv-1' })
    expect(await driftScoreMonitorCollector.run(ctxAt(DEFAULT_INTERVAL_ITERATIONS))).toBeNull()
    expect(mockEmbed).not.toHaveBeenCalled()
  })
})
