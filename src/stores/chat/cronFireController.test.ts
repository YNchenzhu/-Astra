/**
 * Tests for the cron fire → main chat bridge (`cronFireController`).
 *
 * Locks in the renderer-side execution link of the cron system: on
 * `ai:cron-fire`, the prompt must be submitted through the main-chat send
 * pipeline; a user draft must never be clobbered (fires queue and retry);
 * queued fires preserve order and expire after the TTL.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const state = {
    inputText: '',
    pendingAttachments: [] as unknown[],
    sendMessage: vi.fn(async () => {
      // Mirror the real sendSlice: a successful send consumes the input box.
      state.inputText = ''
    }),
  }
  return {
    state,
    onCronFire: vi.fn((_cb: (p: unknown) => void) => () => {}),
  }
})

vi.mock('../../services/electronAPI', () => ({
  onCronFire: mocks.onCronFire,
}))

vi.mock('../useChatStore', () => ({
  useChatStore: {
    getState: () => mocks.state,
    setState: (partial: Record<string, unknown>) => {
      Object.assign(mocks.state, partial)
    },
  },
}))

import {
  ensureCronFireController,
  disposeCronFireController,
} from './cronFireController'

function firePayload(overrides: Partial<{ taskId: string; prompt: string }> = {}) {
  return {
    taskId: overrides.taskId ?? 'task-1',
    cron: '*/5 * * * *',
    prompt: overrides.prompt ?? '检查构建状态',
  }
}

/** The fire callback captured by the mocked `onCronFire`. */
function capturedHandler(): (p: unknown) => void {
  return mocks.onCronFire.mock.calls[0][0]
}

beforeEach(() => {
  vi.useFakeTimers()
  mocks.state.inputText = ''
  mocks.state.pendingAttachments = []
  mocks.state.sendMessage.mockClear()
  mocks.onCronFire.mockClear()
  ensureCronFireController()
})

afterEach(() => {
  disposeCronFireController()
  vi.useRealTimers()
})

describe('ensureCronFireController', () => {
  it('subscribes exactly once across repeated ensure calls', () => {
    ensureCronFireController()
    ensureCronFireController()
    expect(mocks.onCronFire).toHaveBeenCalledTimes(1)
  })
})

describe('cron fire handling', () => {
  it('submits the prompt through the send pipeline when idle', () => {
    capturedHandler()(firePayload())
    expect(mocks.state.sendMessage).toHaveBeenCalledTimes(1)
    // The injected inputText was consumed by sendMessage; verify the marker
    // made it in by inspecting what was set before the send (sendMessage mock
    // cleared it, so assert via the call having happened with non-empty text).
    expect(mocks.state.inputText).toBe('')
  })

  it('prefixes the injected text with task id and cron expression', () => {
    let seen = ''
    mocks.state.sendMessage.mockImplementationOnce(async () => {
      seen = mocks.state.inputText
      mocks.state.inputText = ''
    })
    capturedHandler()(firePayload({ taskId: 'task-9', prompt: '跑每日报表' }))
    expect(seen).toContain('task-9')
    expect(seen).toContain('*/5 * * * *')
    expect(seen).toContain('跑每日报表')
  })

  it('never clobbers a user draft — queues and retries until the draft clears', () => {
    mocks.state.inputText = '用户正在输入的草稿'
    capturedHandler()(firePayload())
    expect(mocks.state.sendMessage).not.toHaveBeenCalled()

    // Draft still present after a retry tick → still queued.
    vi.advanceTimersByTime(5_000)
    expect(mocks.state.sendMessage).not.toHaveBeenCalled()

    // Draft cleared → next tick delivers.
    mocks.state.inputText = ''
    vi.advanceTimersByTime(5_000)
    expect(mocks.state.sendMessage).toHaveBeenCalledTimes(1)
  })

  it('preserves fire order when fires queue behind a draft', () => {
    const sent: string[] = []
    mocks.state.sendMessage.mockImplementation(async () => {
      sent.push(mocks.state.inputText)
      mocks.state.inputText = ''
    })

    mocks.state.inputText = '草稿'
    capturedHandler()(firePayload({ taskId: 'first' }))
    capturedHandler()(firePayload({ taskId: 'second' }))

    mocks.state.inputText = ''
    vi.advanceTimersByTime(5_000)

    expect(sent).toHaveLength(2)
    expect(sent[0]).toContain('first')
    expect(sent[1]).toContain('second')
  })

  it('drops queued fires older than the TTL instead of replaying stale prompts', () => {
    mocks.state.inputText = '草稿'
    capturedHandler()(firePayload())

    // Hold the draft past the 10-minute TTL, then release it.
    vi.advanceTimersByTime(11 * 60_000)
    mocks.state.inputText = ''
    vi.advanceTimersByTime(5_000)

    expect(mocks.state.sendMessage).not.toHaveBeenCalled()
  })
})
