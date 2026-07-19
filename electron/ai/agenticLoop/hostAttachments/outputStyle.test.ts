/**
 * Unit tests for the `output_style` collector.
 *
 * Per-conversation snapshot — first observation primes without
 * emitting (system prompt already conveys the style). Subsequent
 * observations emit only when the style differs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetOutputStyleSnapshotsForTests,
  outputStyleCollector,
} from './outputStyle'
import {
  expectPushMessageAction,
  makeAttachmentFixture,
} from './testFixtures'

const ORIGINAL_ENV = process.env.POLE_OUTPUT_STYLE_DELTA

const getAgentContextMock = vi.fn()
const loadSettingsMock = vi.fn()

vi.mock('../../../agents/agentContext', () => ({
  getAgentContext: () => getAgentContextMock(),
}))
vi.mock('../../../settings/settingsStore', () => ({
  loadSettings: () => loadSettingsMock(),
}))

beforeEach(() => {
  vi.clearAllMocks()
  __resetOutputStyleSnapshotsForTests()
  process.env.POLE_OUTPUT_STYLE_DELTA = '1'
  getAgentContextMock.mockReturnValue({
    agentId: 'main',
    streamConversationId: 'conv-1',
  })
  loadSettingsMock.mockReturnValue({ outputStyle: 'default' })
})

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.POLE_OUTPUT_STYLE_DELTA
  else process.env.POLE_OUTPUT_STYLE_DELTA = ORIGINAL_ENV
})

describe('outputStyleCollector — gating', () => {
  it('runs at post_tool only', () => {
    expect(outputStyleCollector.callSites).toEqual(['post_tool'])
  })

  it('is enabled when env flag is unset (default-on); first observation primes', async () => {
    delete process.env.POLE_OUTPUT_STYLE_DELTA
    // First observation primes baseline → null. But the gate didn't
    // close it — loadSettings was consulted.
    expect(
      await outputStyleCollector.run(makeAttachmentFixture({})),
    ).toBeNull()
    expect(loadSettingsMock).toHaveBeenCalled()
  })

  it('returns null when env flag is explicitly disabled (POLE_X=0)', async () => {
    process.env.POLE_OUTPUT_STYLE_DELTA = '0'
    expect(
      await outputStyleCollector.run(makeAttachmentFixture({})),
    ).toBeNull()
    expect(loadSettingsMock).not.toHaveBeenCalled()
  })

  it('returns null for sub-agents', async () => {
    getAgentContextMock.mockReturnValue({
      agentId: 'sub-1',
      streamConversationId: 'conv',
    })
    expect(
      await outputStyleCollector.run(makeAttachmentFixture({})),
    ).toBeNull()
  })

  it('returns null when no streamConversationId', async () => {
    getAgentContextMock.mockReturnValue({ agentId: 'main' })
    expect(
      await outputStyleCollector.run(makeAttachmentFixture({})),
    ).toBeNull()
  })

  it('returns null when loadSettings throws', async () => {
    loadSettingsMock.mockImplementation(() => {
      throw new Error('settings read failed')
    })
    expect(
      await outputStyleCollector.run(makeAttachmentFixture({})),
    ).toBeNull()
  })

  it('returns null when outputStyle setting is an unknown value', async () => {
    loadSettingsMock.mockReturnValue({ outputStyle: 'space-pirate' })
    expect(
      await outputStyleCollector.run(makeAttachmentFixture({})),
    ).toBeNull()
  })
})

describe('outputStyleCollector — first observation', () => {
  it('does NOT emit on first observation (system prompt already conveys it)', async () => {
    expect(
      await outputStyleCollector.run(makeAttachmentFixture({})),
    ).toBeNull()
  })

  it('does NOT emit when style is unchanged on subsequent observations', async () => {
    await outputStyleCollector.run(makeAttachmentFixture({}))
    expect(
      await outputStyleCollector.run(makeAttachmentFixture({})),
    ).toBeNull()
  })
})

describe('outputStyleCollector — change emission', () => {
  it('emits when the style changes mid-conversation', async () => {
    // Prime with `default`.
    await outputStyleCollector.run(makeAttachmentFixture({}))
    // User switches to `concise`.
    loadSettingsMock.mockReturnValue({ outputStyle: 'concise' })
    const action = await outputStyleCollector.run(makeAttachmentFixture({}))
    const body = String(expectPushMessageAction(action).message.content)
    expect(body).toContain('changed to **concise**')
    expect(body).toContain('Do not mention this notice')
  })

  it('emits again on subsequent change', async () => {
    await outputStyleCollector.run(makeAttachmentFixture({}))
    loadSettingsMock.mockReturnValue({ outputStyle: 'concise' })
    await outputStyleCollector.run(makeAttachmentFixture({}))
    loadSettingsMock.mockReturnValue({ outputStyle: 'explanatory' })
    const body = String(
      expectPushMessageAction(
        await outputStyleCollector.run(makeAttachmentFixture({})),
      ).message.content,
    )
    expect(body).toContain('changed to **explanatory**')
  })

  it('reports previousStyle + currentStyle to appendixReport', async () => {
    await outputStyleCollector.run(makeAttachmentFixture({}))
    loadSettingsMock.mockReturnValue({ outputStyle: 'concise' })
    const ctx = makeAttachmentFixture({ iteration: 4 })
    await outputStyleCollector.run(ctx)
    expect(ctx.state.appendixReport).toHaveBeenCalledWith(
      'P2_Q_compaction_reminder',
      expect.objectContaining({
        kind: 'output_style',
        previousStyle: 'default',
        currentStyle: 'concise',
      }),
    )
  })

  it('isolates snapshots per conversation', async () => {
    await outputStyleCollector.run(makeAttachmentFixture({})) // conv-1: default
    getAgentContextMock.mockReturnValue({
      agentId: 'main',
      streamConversationId: 'conv-2',
    })
    loadSettingsMock.mockReturnValue({ outputStyle: 'concise' })
    // conv-2 first observation — no emit even though "current global value differs from conv-1's snapshot".
    expect(
      await outputStyleCollector.run(makeAttachmentFixture({})),
    ).toBeNull()
  })
})
