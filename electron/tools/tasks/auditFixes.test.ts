/**
 * Regression tests for the audit fixes covered in
 * docs/WORKSPACE_TOOL_SUBSYSTEM_AUDIT_REPORT.md:
 *
 *   - BUG-2.1  foregroundTracker did not propagate `isBackgrounded` into
 *              the central taskStateManager. After the fix, both stores
 *              must agree.
 *   - LOGIC-3.5 stopTask used to set status='killed' BEFORE invoking
 *              `taskImpl.kill()`. After the fix, a kill() rejection must
 *              leave status='failed' (not 'killed') so the OS-level
 *              "phantom-dead" UX bug doesn't return.
 *   - QUAL-4.1 taskStateManager grew without bound. After the fix, the
 *              lazy sweep must drop terminal records past the TTL.
 *   - QUAL-4.2 cleanupRegistry silently overwrote duplicate registrations.
 *              After the fix, a duplicate must produce a console.warn so
 *              the regression is visible in dev/CI logs.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import {
  backgroundAllForegroundTasks,
  backgroundForegroundTask,
  registerForegroundTask,
} from './foregroundTracker'
import {
  clearAllTaskStates,
  getBackgroundTasks,
  getForegroundTasks,
  getTaskState,
  getAllTaskStates,
  registerTaskState,
  updateTaskState,
} from './taskStateManager'
import { stopTask } from './taskDispatcher'
import { getTaskByType, registerTaskImpl } from './taskInterface'
import type { Task, TaskStateBase } from './taskInterface'
import { registerCleanup, unregisterCleanup } from './cleanupRegistry'

function makeShellState(id: string): TaskStateBase {
  return {
    id,
    type: 'local_bash',
    status: 'running',
    description: `task ${id}`,
    startTime: Date.now(),
    notified: false,
    isBackgrounded: false,
  }
}

afterEach(() => {
  clearAllTaskStates()
})

describe('BUG-2.1 — foregroundTracker propagates to taskStateManager', () => {
  it('backgroundAllForegroundTasks: central store sees isBackgrounded=true', () => {
    const a = makeShellState('bash-aaa')
    const b = makeShellState('bash-bbb')
    registerTaskState(a)
    registerTaskState(b)
    registerForegroundTask(a.id, a)
    registerForegroundTask(b.id, b)

    // Sanity: both visible as foreground in the central store.
    expect(getForegroundTasks().map((t) => t.id).sort()).toEqual(['bash-aaa', 'bash-bbb'])
    expect(getBackgroundTasks()).toEqual([])

    backgroundAllForegroundTasks()

    // After background-all the CENTRAL store must report them as
    // background — that's what the renderer / IPC handlers consult.
    expect(getForegroundTasks()).toEqual([])
    expect(getBackgroundTasks().map((t) => t.id).sort()).toEqual(['bash-aaa', 'bash-bbb'])
    expect(getTaskState('bash-aaa')?.isBackgrounded).toBe(true)
    expect(getTaskState('bash-bbb')?.isBackgrounded).toBe(true)
  })

  it('backgroundForegroundTask (single): central store sees isBackgrounded=true', () => {
    const a = makeShellState('bash-single')
    registerTaskState(a)
    registerForegroundTask(a.id, a)
    expect(getTaskState('bash-single')?.isBackgrounded).toBe(false)

    const ok = backgroundForegroundTask('bash-single')
    expect(ok).toBe(true)
    expect(getTaskState('bash-single')?.isBackgrounded).toBe(true)
    expect(getForegroundTasks()).toEqual([])
    expect(getBackgroundTasks().map((t) => t.id)).toEqual(['bash-single'])
  })

  it('backgroundForegroundTask returns false for unknown id without touching state', () => {
    const a = makeShellState('only-one')
    registerTaskState(a)
    registerForegroundTask(a.id, a)

    const ok = backgroundForegroundTask('does-not-exist')
    expect(ok).toBe(false)
    expect(getTaskState('only-one')?.isBackgrounded).toBe(false)
  })
})

describe('LOGIC-3.5 — stopTask order: kill first, then mark', () => {
  // Use a brand-new task type so we can register a deterministic Task
  // impl without contaminating existing managers' singletons.
  const SUCCESS_KILL_TYPE = 'local_bash' as const
  const successImpl: Task = {
    name: 'TestSuccessKill',
    type: SUCCESS_KILL_TYPE,
    async kill(): Promise<void> {
      // resolves
    },
  }

  let originalImpl: Task | undefined
  beforeEach(() => {
    // Save the production impl (registered when ShellTaskManager loaded
    // earlier in this vitest worker) so we don't bleed our test stub
    // into other tests' shared registry state.
    originalImpl = getTaskByType(SUCCESS_KILL_TYPE)
  })
  afterEach(() => {
    if (originalImpl) registerTaskImpl(originalImpl)
  })

  it('successful kill() leaves status=killed', async () => {
    registerTaskImpl(successImpl)
    const a = makeShellState('killable-1')
    registerTaskState(a)

    await stopTask('killable-1')

    expect(getTaskState('killable-1')?.status).toBe('killed')
  })

  it('kill() rejection leaves status=failed (NOT killed) and rethrows', async () => {
    const failingImpl: Task = {
      name: 'TestFailingKill',
      type: SUCCESS_KILL_TYPE,
      async kill(): Promise<void> {
        throw new Error('kill failed: process gone')
      },
    }
    registerTaskImpl(failingImpl)
    const a = makeShellState('killable-2')
    registerTaskState(a)

    await expect(stopTask('killable-2')).rejects.toThrow('kill failed: process gone')

    // Status must reflect the actual outcome — the previous "mark before
    // kill" version would have left this as 'killed'.
    expect(getTaskState('killable-2')?.status).toBe('failed')
  })
})

describe('QUAL-4.1 — taskStateManager TTL sweep of terminal records', () => {
  it('drops a terminal record past TTL on the very next register call', () => {
    // Register a fresh, running task first (no TTL impact).
    registerTaskState(makeShellState('live-1'))

    // Now register a stale, terminal record. The sweep runs after `set`
    // so this stale record is dropped immediately by its own register
    // call's sweep pass.
    const stale = makeShellState('stale-completed')
    stale.status = 'completed'
    stale.endTime = Date.now() - 11 * 60 * 1000

    registerTaskState(stale)

    expect(getTaskState('stale-completed')).toBeUndefined()
    expect(getTaskState('live-1')?.id).toBe('live-1')
  })

  it('does NOT drop running/pending records regardless of age', () => {
    const ancient = makeShellState('long-running')
    ancient.startTime = Date.now() - 60 * 60 * 1000 // 1h old, still running
    registerTaskState(ancient)

    // Trigger another register — sweep runs but ancient is `running`.
    registerTaskState(makeShellState('canary-1'))

    expect(getTaskState('long-running')?.id).toBe('long-running')
  })

  it('does NOT drop fresh terminal records (within TTL)', () => {
    const recent = makeShellState('just-finished')
    recent.status = 'completed'
    recent.endTime = Date.now() - 30 * 1000 // 30s ago, well within TTL
    registerTaskState(recent)

    registerTaskState(makeShellState('canary-2'))

    expect(getTaskState('just-finished')?.id).toBe('just-finished')
  })

  it('updateTaskState path also runs the sweep', () => {
    // Sequence that exercises the update-time sweep path:
    //   1. Register a running task that is OLD enough to qualify as
    //      stale once it transitions to terminal.
    //   2. Register a separate live task — sweep runs but neither is
    //      eligible (one is running, the other is fresh terminal).
    //   3. Update the first task to a terminal state with an OLD
    //      endTime so it qualifies. The same `update` call's sweep
    //      should drop it on the spot.
    //
    //   This guards the call site in `updateTaskState` — without it, a
    //   task that goes terminal in a path that never calls `register`
    //   afterwards (e.g. failBackgroundShellTask hitting an idle store)
    //   would leak.
    const a = makeShellState('age-then-fail')
    registerTaskState(a)
    registerTaskState(makeShellState('live-anchor'))

    expect(getTaskState('age-then-fail')?.id).toBe('age-then-fail')

    updateTaskState('age-then-fail', (s) => ({
      ...s,
      status: 'failed' as const,
      endTime: Date.now() - 11 * 60 * 1000, // backdated past TTL
    }))

    expect(getTaskState('age-then-fail')).toBeUndefined()
    expect(getTaskState('live-anchor')?.id).toBe('live-anchor')
  })
})

describe('QUAL-4.2 — cleanupRegistry duplicate registration warning', () => {
  it('warns (not silently overwrites) when the same taskId registers twice', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const first = vi.fn(async () => {})
      const second = vi.fn(async () => {})
      registerCleanup('dup-id', first)
      registerCleanup('dup-id', second)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]![0]).toMatch(/duplicate cleanup registration/i)

      // The second registration still wins (preserve the historical
      // semantics so this stays a forward-compatible warn-only change).
      await unregisterCleanup('dup-id')
      expect(first).not.toHaveBeenCalled()
      expect(second).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('does NOT warn on a normal first registration', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      registerCleanup('clean-id', async () => {})
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
      void unregisterCleanup('clean-id')
    }
  })
})

describe('Sanity — getAllTaskStates and basic round-trip', () => {
  it('registers and clears cleanly across tests', () => {
    expect(getAllTaskStates()).toEqual([])
    registerTaskState(makeShellState('rt-1'))
    expect(getAllTaskStates().map((t) => t.id)).toEqual(['rt-1'])
  })
})
