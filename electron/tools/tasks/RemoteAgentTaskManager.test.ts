/**
 * RemoteAgentTaskManager — task framework integration for worker-isolated
 * sub-agents. Verifies registerForeground/Background, lifecycle promise
 * binding (done → completed/failed), kill routing, and task ID prefix.
 */

import { describe, it, expect, afterEach } from 'vitest'
import {
  registerForegroundRemoteAgent,
  registerBackgroundRemoteAgent,
  killRemoteAgentTask,
  failRemoteAgentTask,
  completeRemoteAgentTask,
  killAllRemoteAgentTasks,
  getRemoteAgentSessionForTest,
} from './RemoteAgentTaskManager'
import { createTaskId, getTaskState, getTaskByType, isRemoteAgentTask } from './index'
import { clearAllTaskStates } from './taskStateManager'
import type { SessionHandle, SessionDoneStatus } from '../../bridge/sessionSpawner'
import type { LoopEvent, AgenticLoopResult } from '../../ai/loopEvents'

afterEach(() => {
  clearAllTaskStates()
})

/**
 * Minimal SessionHandle stub. We don't run a real worker here — these
 * tests verify the *adapter layer* (Task framework ↔ SessionHandle), not
 * the worker itself. Worker behaviour is covered in
 * `electron/bridge/sessionSpawner.test.ts`.
 */
function makeSessionStub(opts: {
  doneStatus?: SessionDoneStatus
  doneRejection?: Error
  killImpl?: () => Promise<SessionDoneStatus>
} = {}): { session: SessionHandle; resolveDone: (s: SessionDoneStatus) => void } {
  let resolveDone!: (s: SessionDoneStatus) => void
  let rejectDone!: (e: Error) => void
  const donePromise = new Promise<SessionDoneStatus>((res, rej) => {
    resolveDone = res
    rejectDone = rej
  })
  if (opts.doneStatus) queueMicrotask(() => resolveDone(opts.doneStatus!))
  if (opts.doneRejection) queueMicrotask(() => rejectDone(opts.doneRejection!))

  const events: AsyncIterable<LoopEvent> = {
    async *[Symbol.asyncIterator]() {
      // No events — tests don't drive the stream here.
    },
  }
  const session: SessionHandle = {
    sessionId: 'stub',
    done: donePromise,
    events,
    activities: () => [],
    stderr: () => [],
    kill:
      opts.killImpl ??
      (async () => {
        const status: SessionDoneStatus = {
          terminatedAt: Date.now(),
          error: 'killed',
        }
        resolveDone(status)
        return status
      }),
    forceKill: async () => {
      const status: SessionDoneStatus = {
        terminatedAt: Date.now(),
        error: 'force-killed',
      }
      resolveDone(status)
      return status
    },
    updateAccessToken: () => {},
  }
  return { session, resolveDone }
}

describe('RemoteAgentTaskManager — registration', () => {
  it('register impl is wired into taskInterface', () => {
    expect(getTaskByType('remote_agent')?.name).toBe('RemoteAgentTask')
  })

  it('createTaskId produces an `r`-prefixed id', () => {
    const id = createTaskId('remote_agent')
    expect(id[0]).toBe('r')
  })

  it('foreground registration creates a remote_agent state with the right shape', () => {
    const taskId = createTaskId('remote_agent')
    const { session } = makeSessionStub()
    const state = registerForegroundRemoteAgent({
      taskId,
      remoteId: 'remote-1',
      description: 'do the thing',
      session,
    })
    expect(state.type).toBe('remote_agent')
    expect(isRemoteAgentTask(state)).toBe(true)
    expect(state.isBackgrounded).toBe(false)
    expect(state.remoteId).toBe('remote-1')
    expect(getRemoteAgentSessionForTest(taskId)).toBe(session)
  })

  it('background registration sets isBackgrounded=true', () => {
    const taskId = createTaskId('remote_agent')
    const { session } = makeSessionStub()
    const state = registerBackgroundRemoteAgent({
      taskId,
      remoteId: 'remote-2',
      description: 'bg work',
      session,
    })
    expect(state.isBackgrounded).toBe(true)
  })
})

describe('RemoteAgentTaskManager — lifecycle binding', () => {
  it('SessionHandle.done with result → task transitions to completed', async () => {
    const taskId = createTaskId('remote_agent')
    const result: AgenticLoopResult = {
      terminationResult: { reason: 'completed', turnCount: 3, terminatedAt: Date.now() },
      totalUsage: { inputTokens: 100, outputTokens: 50 },
      transition: 'tool_use',
      transitionHistory: ['init', 'tool_use', 'tool_use', 'tool_use'],
    }
    const { session } = makeSessionStub({
      doneStatus: { result, terminatedAt: Date.now() },
    })
    registerForegroundRemoteAgent({
      taskId,
      remoteId: 'r-1',
      description: 'auto-complete',
      session,
    })
    // Wait two microtasks for the bind to fire (queueMicrotask + .then chain).
    await new Promise((r) => setTimeout(r, 0))
    const final = getTaskState(taskId)
    expect(final?.status).toBe('completed')
  })

  it('SessionHandle.done with error → task transitions to failed', async () => {
    const taskId = createTaskId('remote_agent')
    const { session } = makeSessionStub({
      doneStatus: { error: 'segfault', terminatedAt: Date.now() },
    })
    registerForegroundRemoteAgent({
      taskId,
      remoteId: 'r-2',
      description: 'will crash',
      session,
    })
    await new Promise((r) => setTimeout(r, 0))
    const final = getTaskState(taskId)
    expect(final?.status).toBe('failed')
  })

  it('SessionHandle.done rejection → task transitions to failed', async () => {
    const taskId = createTaskId('remote_agent')
    const { session } = makeSessionStub({
      doneRejection: new Error('promise was rejected'),
    })
    registerForegroundRemoteAgent({
      taskId,
      remoteId: 'r-3',
      description: 'rejection',
      session,
    })
    await new Promise((r) => setTimeout(r, 0))
    const final = getTaskState(taskId)
    expect(final?.status).toBe('failed')
  })
})

describe('RemoteAgentTaskManager — explicit kill', () => {
  it('killRemoteAgentTask routes to SessionHandle.kill and flips state to killed', async () => {
    const taskId = createTaskId('remote_agent')
    let killed = false
    const { session } = makeSessionStub({
      killImpl: async () => {
        killed = true
        return { error: 'aborted', terminatedAt: Date.now() }
      },
    })
    registerForegroundRemoteAgent({
      taskId,
      remoteId: 'r-4',
      description: 'killable',
      session,
    })
    await killRemoteAgentTask(taskId)
    expect(killed).toBe(true)
    expect(getTaskState(taskId)?.status).toBe('killed')
  })

  it('killRemoteAgentTask is idempotent for unknown task ids', async () => {
    // No throw, no crash.
    await expect(killRemoteAgentTask('rNONEXISTENT')).resolves.toBeUndefined()
  })

  it('failRemoteAgentTask + completeRemoteAgentTask are externally callable', () => {
    const taskId = createTaskId('remote_agent')
    const { session } = makeSessionStub()
    registerBackgroundRemoteAgent({
      taskId,
      remoteId: 'r-5',
      description: 'manual lifecycle',
      session,
    })
    failRemoteAgentTask(taskId, 'manual fail')
    expect(getTaskState(taskId)?.status).toBe('failed')

    const taskId2 = createTaskId('remote_agent')
    const stub2 = makeSessionStub()
    registerBackgroundRemoteAgent({
      taskId: taskId2,
      remoteId: 'r-6',
      description: 'manual ok',
      session: stub2.session,
    })
    completeRemoteAgentTask(taskId2, 'manual ok')
    expect(getTaskState(taskId2)?.status).toBe('completed')
  })

  it('killAllRemoteAgentTasks reaps every running task', async () => {
    const sessions = [makeSessionStub(), makeSessionStub(), makeSessionStub()]
    const ids = sessions.map(({ session }) => {
      const taskId = createTaskId('remote_agent')
      registerForegroundRemoteAgent({
        taskId,
        remoteId: taskId,
        description: 'parallel',
        session,
      })
      return taskId
    })
    const killed = await killAllRemoteAgentTasks()
    expect(killed.sort()).toEqual(ids.sort())
    for (const id of ids) {
      expect(getTaskState(id)?.status).toBe('killed')
    }
  })
})
