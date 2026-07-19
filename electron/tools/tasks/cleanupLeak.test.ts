/**
 * Regression guard for the "kill leaves cleanup callback behind" bug.
 *
 * Before this fix, three kill paths flipped task state to `killed` but
 * never called {@link unregisterCleanup}, leaking one entry in the
 * cleanup registry per kill until process exit. Subsequent calls that
 * happened to reuse the task id (`registerForegroundAgent('a1', ...)`
 * after `killAgentTask('a1')`) tripped the "[CleanupRegistry] duplicate
 * cleanup registration" warning. Worse, the previous callback was
 * dropped without firing — silently orphaning whatever resource it
 * scoped (e.g. an AbortController that would now never abort).
 *
 * Covered managers:
 *   - {@link AgentTaskManager.killAgentTask}
 *   - {@link WorkflowTaskManager.killWorkflowTask}
 *   - {@link RemoteAgentTaskManager.killRemoteAgentTask}
 *
 * Each test:
 *   1. Asserts `cleanupCount()` increments on register.
 *   2. Calls `kill...Task(id)` directly (bypassing `taskDispatcher.stopTask`
 *      — that path adds its own unregisterCleanup as a safety net, so
 *      testing through it would mask the manager-level bug).
 *   3. Asserts `cleanupCount()` is back where it started.
 *   4. Re-registers the same id and asserts `console.warn` did NOT fire
 *      the "duplicate cleanup registration" message.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  registerForegroundAgent,
  killAgentTask,
  __clearAllAutoBackgroundTimersForTests,
} from './AgentTaskManager'
import {
  registerForegroundWorkflow,
  killWorkflowTask,
} from './WorkflowTaskManager'
import {
  registerBackgroundRemoteAgent,
  killRemoteAgentTask,
  getRemoteAgentSessionForTest,
} from './RemoteAgentTaskManager'
import {
  cleanupCount,
  __clearAllCleanupForTests,
} from './cleanupRegistry'
import {
  clearAllTaskStates,
} from './taskStateManager'
import { clearNotifications } from './notificationSystem'
import { asAgentId } from '../ids'

const AGENT = asAgentId('agent-cleanup-test')

beforeEach(() => {
  clearAllTaskStates()
  clearNotifications()
  __clearAllAutoBackgroundTimersForTests()
  __clearAllCleanupForTests()
  // Auto-background timer would otherwise flip / mutate state mid-test.
  process.env.POLE_AUTO_BACKGROUND_AGENTS_MS = '0'
})

afterEach(() => {
  __clearAllAutoBackgroundTimersForTests()
  __clearAllCleanupForTests()
  clearAllTaskStates()
  clearNotifications()
  delete process.env.POLE_AUTO_BACKGROUND_AGENTS_MS
  vi.restoreAllMocks()
})

/** Returns true if any `console.warn` invocation contained the dup-cleanup needle. */
function warnedAboutDuplicateCleanup(warnSpy: ReturnType<typeof vi.spyOn>): boolean {
  return warnSpy.mock.calls.some((args) =>
    args.some(
      (a) =>
        typeof a === 'string' && a.includes('duplicate cleanup registration'),
    ),
  )
}

describe('killAgentTask cleans up its registry entry', () => {
  it('cleanupCount returns to baseline after kill', async () => {
    const baseline = cleanupCount()
    const ac = new AbortController()
    registerForegroundAgent({
      taskId: 'a_leak_1',
      agentId: AGENT,
      prompt: 'do thing',
      agentType: 'general-purpose',
      abortController: ac,
    })
    expect(cleanupCount()).toBe(baseline + 1)

    await killAgentTask('a_leak_1')

    expect(cleanupCount()).toBe(baseline)
  })

  it('re-registering the same id after kill does NOT log dup-cleanup warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ac1 = new AbortController()
    registerForegroundAgent({
      taskId: 'a_dup_1',
      agentId: AGENT,
      prompt: 'first',
      agentType: 'general-purpose',
      abortController: ac1,
    })
    await killAgentTask('a_dup_1')

    const ac2 = new AbortController()
    registerForegroundAgent({
      taskId: 'a_dup_1',
      agentId: AGENT,
      prompt: 'second',
      agentType: 'general-purpose',
      abortController: ac2,
    })

    expect(warnedAboutDuplicateCleanup(warn)).toBe(false)
  })
})

describe('killWorkflowTask cleans up its registry entry', () => {
  it('cleanupCount returns to baseline after kill', async () => {
    const baseline = cleanupCount()
    const ac = new AbortController()
    registerForegroundWorkflow({
      taskId: 'w_leak_1',
      workflowName: 'demo',
      description: 'pipeline run',
      abortController: ac,
    })
    expect(cleanupCount()).toBe(baseline + 1)

    await killWorkflowTask('w_leak_1')

    expect(cleanupCount()).toBe(baseline)
  })

  it('re-registering the same id after kill does NOT log dup-cleanup warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ac1 = new AbortController()
    registerForegroundWorkflow({
      taskId: 'w_dup_1',
      workflowName: 'demo',
      description: 'first',
      abortController: ac1,
    })
    await killWorkflowTask('w_dup_1')

    const ac2 = new AbortController()
    registerForegroundWorkflow({
      taskId: 'w_dup_1',
      workflowName: 'demo',
      description: 'second',
      abortController: ac2,
    })

    expect(warnedAboutDuplicateCleanup(warn)).toBe(false)
  })
})

describe('killRemoteAgentTask cleans up its registry entry', () => {
  // RemoteAgentTaskManager expects a SessionHandle. The lifecycle binder
  // awaits `session.done`, so we hand it a never-resolving promise plus a
  // no-op `kill` — that's all the kill path touches.
  function fakeSession() {
    return {
      done: new Promise(() => {}),
      kill: async () => undefined,
    } as unknown as Parameters<typeof registerBackgroundRemoteAgent>[0]['session']
  }

  it('cleanupCount returns to baseline after kill', async () => {
    const baseline = cleanupCount()
    registerBackgroundRemoteAgent({
      taskId: 'r_leak_1',
      remoteId: 'remote-1',
      description: 'cloud run',
      session: fakeSession(),
    })
    expect(cleanupCount()).toBe(baseline + 1)
    expect(getRemoteAgentSessionForTest('r_leak_1')).toBeDefined()

    await killRemoteAgentTask('r_leak_1')

    expect(cleanupCount()).toBe(baseline)
  })

  it('re-registering the same id after kill does NOT log dup-cleanup warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    registerBackgroundRemoteAgent({
      taskId: 'r_dup_1',
      remoteId: 'remote-1',
      description: 'first',
      session: fakeSession(),
    })
    await killRemoteAgentTask('r_dup_1')

    registerBackgroundRemoteAgent({
      taskId: 'r_dup_1',
      remoteId: 'remote-1',
      description: 'second',
      session: fakeSession(),
    })

    expect(warnedAboutDuplicateCleanup(warn)).toBe(false)
  })
})
