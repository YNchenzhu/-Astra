/**
 * Tests for the foreground-agent auto-background timer (upstream §10.6 parity).
 *
 * Behaviour:
 *   - A foreground agent registered without explicit backgrounding starts a
 *     timer that flips the task to background after the env-configured
 *     threshold (default 120s).
 *   - The timer is cleared on `complete`, `fail`, `kill`, and explicit
 *     `backgroundAgentTask` so a task that finishes inside the threshold
 *     doesn't get a stale auto-flip later.
 *   - `POLE_AUTO_BACKGROUND_AGENTS_MS=0` disables the behaviour entirely
 *     (no timer scheduled).
 *   - Background-registered agents do NOT schedule a timer.
 *
 * Uses Vitest fake timers so the 120-second wait is virtual.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  registerForegroundAgent,
  registerBackgroundAgent,
  completeAgentTask,
  failAgentTask,
  killAgentTask,
  backgroundAgentTask,
  __hasAutoBackgroundTimerForTests,
  __clearAllAutoBackgroundTimersForTests,
} from './AgentTaskManager'
import {
  getTaskState,
  clearAllTaskStates,
} from './taskStateManager'
import {
  clearNotifications,
  drainNotificationsXml,
} from './notificationSystem'
import { __clearAllCleanupForTests } from './cleanupRegistry'
import { asAgentId } from '../ids'

function spawn(taskId: string): AbortController {
  const ac = new AbortController()
  registerForegroundAgent({
    taskId,
    agentId: asAgentId(`agent-${taskId}`),
    prompt: 'do thing',
    agentType: 'general-purpose',
    abortController: ac,
  })
  return ac
}

beforeEach(() => {
  clearAllTaskStates()
  clearNotifications()
  __clearAllAutoBackgroundTimersForTests()
  __clearAllCleanupForTests()
  delete process.env.POLE_AUTO_BACKGROUND_AGENTS_MS
})

afterEach(() => {
  vi.useRealTimers()
  __clearAllAutoBackgroundTimersForTests()
  __clearAllCleanupForTests()
  clearAllTaskStates()
  clearNotifications()
  delete process.env.POLE_AUTO_BACKGROUND_AGENTS_MS
})

describe('AgentTaskManager auto-background timer', () => {
  it('flips a foreground agent to background after the default 120s threshold', () => {
    vi.useFakeTimers()
    spawn('fg-1')
    expect(__hasAutoBackgroundTimerForTests('fg-1')).toBe(true)
    expect(getTaskState('fg-1')?.isBackgrounded).toBe(false)

    // 119s — still foreground.
    vi.advanceTimersByTime(119_000)
    expect(getTaskState('fg-1')?.isBackgrounded).toBe(false)

    // Cross the threshold.
    vi.advanceTimersByTime(2_000)
    const state = getTaskState('fg-1')
    expect(state?.isBackgrounded).toBe(true)
    expect(state?.status).toBe('running')

    // Notification queued so the model sees the transition next turn.
    const xml = drainNotificationsXml()
    expect(xml).toMatch(/auto-backgrounded/)
    expect(xml).toMatch(/<status>progress<\/status>/)
    expect(xml).toMatch(/<taskId>fg-1<\/taskId>/)

    // Timer slot freed.
    expect(__hasAutoBackgroundTimerForTests('fg-1')).toBe(false)
  })

  it('respects POLE_AUTO_BACKGROUND_AGENTS_MS override', () => {
    process.env.POLE_AUTO_BACKGROUND_AGENTS_MS = '5000'
    vi.useFakeTimers()
    spawn('fg-fast')
    expect(getTaskState('fg-fast')?.isBackgrounded).toBe(false)
    vi.advanceTimersByTime(6_000)
    expect(getTaskState('fg-fast')?.isBackgrounded).toBe(true)
  })

  it('POLE_AUTO_BACKGROUND_AGENTS_MS=0 disables the timer entirely', () => {
    process.env.POLE_AUTO_BACKGROUND_AGENTS_MS = '0'
    vi.useFakeTimers()
    spawn('fg-disabled')
    expect(__hasAutoBackgroundTimerForTests('fg-disabled')).toBe(false)
    vi.advanceTimersByTime(10 * 60 * 1000) // 10 minutes
    expect(getTaskState('fg-disabled')?.isBackgrounded).toBe(false)
    expect(drainNotificationsXml()).toBeNull()
  })

  it('completeAgentTask clears the timer (no stale flip after success)', () => {
    vi.useFakeTimers()
    spawn('fg-complete')
    completeAgentTask('fg-complete', 'done')
    expect(__hasAutoBackgroundTimerForTests('fg-complete')).toBe(false)

    // Even if we somehow advance past 120s, the task stays completed and
    // doesn't get a phantom "auto-backgrounded" notification.
    clearNotifications()
    vi.advanceTimersByTime(200_000)
    expect(getTaskState('fg-complete')?.status).toBe('completed')
    expect(drainNotificationsXml()).toBeNull()
  })

  it('failAgentTask clears the timer', () => {
    vi.useFakeTimers()
    spawn('fg-fail')
    failAgentTask('fg-fail', 'boom')
    expect(__hasAutoBackgroundTimerForTests('fg-fail')).toBe(false)
    vi.advanceTimersByTime(200_000)
    expect(getTaskState('fg-fail')?.status).toBe('failed')
  })

  it('killAgentTask clears the timer', async () => {
    vi.useFakeTimers()
    spawn('fg-kill')
    await killAgentTask('fg-kill')
    expect(__hasAutoBackgroundTimerForTests('fg-kill')).toBe(false)
  })

  it('manual backgroundAgentTask clears the timer', () => {
    vi.useFakeTimers()
    spawn('fg-manual')
    expect(__hasAutoBackgroundTimerForTests('fg-manual')).toBe(true)
    expect(backgroundAgentTask('fg-manual')).toBe(true)
    expect(__hasAutoBackgroundTimerForTests('fg-manual')).toBe(false)
    expect(getTaskState('fg-manual')?.isBackgrounded).toBe(true)

    // No duplicate auto-background notification when the timer would have
    // fired — the manual flip already happened.
    clearNotifications()
    vi.advanceTimersByTime(200_000)
    expect(drainNotificationsXml()).toBeNull()
  })

  it('background-registered agents do not schedule the auto-bg timer', () => {
    vi.useFakeTimers()
    const ac = new AbortController()
    registerBackgroundAgent({
      taskId: 'bg-1',
      agentId: asAgentId('agent-bg-1'),
      prompt: 'do thing in bg',
      agentType: 'general-purpose',
      abortController: ac,
    })
    expect(__hasAutoBackgroundTimerForTests('bg-1')).toBe(false)
    vi.advanceTimersByTime(200_000)
    // No notification fired — was already in background, isBackgrounded
    // never flipped.
    expect(drainNotificationsXml()).toBeNull()
  })
})
