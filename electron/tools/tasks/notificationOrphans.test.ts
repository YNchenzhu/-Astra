/**
 * Tests for the upstream-parity orphan-notification suppression fixes.
 *
 * Two adjacent bugs are covered:
 *
 *   1. **Agent-kill orphan drain**: a shell task spawned by agent A enqueues
 *      its "command completed" XML and then agent A is killed before the
 *      next drain. Without {@link dequeueByAgent}, the next agent that calls
 *      {@link drainNotificationsXml} would read a notification addressed to
 *      a dead agent and hallucinate about a task it never owned.
 *
 *   2. **Bash 137 noise suppression**: stopTask used to enqueue a generic
 *      `<status>killed</status>` XML for every task type. For shell tasks
 *      that's almost always user-initiated Ctrl+C noise and adds nothing
 *      the model can act on. We now suppress it for `local_bash` and keep
 *      the agent path intact (matches upstream stopTask.ts behaviour).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  registerForegroundAgent,
  killAgentTask,
  __clearAllAutoBackgroundTimersForTests,
} from './AgentTaskManager'
import {
  createShellTaskState,
  completeShellTask,
  killShellTasksForAgent,
  markAllShellTasksNotified,
} from './ShellTaskManager'
import { stopTask } from './taskDispatcher'
import {
  clearNotifications,
  drainNotificationsXml,
  hasPendingNotifications,
  dequeueByAgent,
  enqueueTaskNotification,
  taskCompletedNotification,
} from './notificationSystem'
import {
  clearAllTaskStates,
  getTaskState,
} from './taskStateManager'
import { __clearAllCleanupForTests } from './cleanupRegistry'
import { asAgentId } from '../ids'

const AGENT_A = asAgentId('agent-a')
const AGENT_B = asAgentId('agent-b')

function spawnForegroundAgent(taskId: string, agentId = AGENT_A): AbortController {
  const ac = new AbortController()
  registerForegroundAgent({
    taskId,
    agentId,
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
  // Auto-background timer would otherwise flip the agent and enqueue a
  // 'progress' notification mid-test, polluting assertions.
  process.env.POLE_AUTO_BACKGROUND_AGENTS_MS = '0'
})

afterEach(() => {
  __clearAllAutoBackgroundTimersForTests()
  __clearAllCleanupForTests()
  clearAllTaskStates()
  clearNotifications()
  delete process.env.POLE_AUTO_BACKGROUND_AGENTS_MS
})

describe('dequeueByAgent — pure unit', () => {
  it('drops only notifications tagged with the given agentId, returns count', () => {
    enqueueTaskNotification({ taskId: 'a1', taskType: 'local_agent', status: 'completed', agentId: AGENT_A })
    enqueueTaskNotification({ taskId: 'b1', taskType: 'local_bash', status: 'completed', agentId: AGENT_A })
    enqueueTaskNotification({ taskId: 'b2', taskType: 'local_bash', status: 'completed', agentId: AGENT_B })
    enqueueTaskNotification({ taskId: 'untagged', taskType: 'shell', status: 'stalled' })

    const removed = dequeueByAgent(AGENT_A)
    expect(removed).toBe(2)

    const xml = drainNotificationsXml() ?? ''
    expect(xml).not.toMatch(/<taskId>a1<\/taskId>/)
    expect(xml).not.toMatch(/<taskId>b1<\/taskId>/)
    expect(xml).toMatch(/<taskId>b2<\/taskId>/)
    expect(xml).toMatch(/<taskId>untagged<\/taskId>/)
  })

  it('returns 0 when nothing matches', () => {
    enqueueTaskNotification({ taskId: 'a1', taskType: 'local_agent', status: 'completed', agentId: AGENT_B })
    expect(dequeueByAgent(AGENT_A)).toBe(0)
    expect(hasPendingNotifications()).toBe(true)
  })
})

// Note on test IDs: ShellTaskManager / AgentTaskManager keep module-level
// `notifiedTasks` Sets to dedupe completion notifications across a task's
// lifetime. Those Sets are NOT cleared between tests (and shouldn't be —
// production code can't "reuse" a task id either). Use a unique id per
// `it()` to avoid cross-test bleed.

describe('killAgentTask purges queued notifications addressed to that agent', () => {
  it('drops in-flight shell completion notifications when the parent agent is killed', async () => {
    spawnForegroundAgent('a_kill_1', AGENT_A)
    // Shell task owned by AGENT_A pretends to complete moments before kill.
    createShellTaskState('b_kill_1', 'echo hi', AGENT_A, 'bash')
    completeShellTask('b_kill_1', 0)
    expect(hasPendingNotifications()).toBe(true)

    await killAgentTask('a_kill_1')

    // The shell's completion XML carried agentId=AGENT_A, so killAgentTask's
    // dequeueByAgent(AGENT_A) flushed it. Nothing left in the queue.
    expect(drainNotificationsXml()).toBeNull()
  })

  it('leaves notifications from other agents alone', async () => {
    spawnForegroundAgent('a_keep_a', AGENT_A)
    spawnForegroundAgent('a_keep_b', AGENT_B)
    createShellTaskState('b_keep_a', 'echo a', AGENT_A, 'bash')
    createShellTaskState('b_keep_b', 'echo b', AGENT_B, 'bash')
    completeShellTask('b_keep_a', 0)
    completeShellTask('b_keep_b', 0)

    await killAgentTask('a_keep_a')

    const xml = drainNotificationsXml() ?? ''
    expect(xml).not.toMatch(/<taskId>b_keep_a<\/taskId>/)
    expect(xml).toMatch(/<taskId>b_keep_b<\/taskId>/)
  })

  it('completion XML carries agentId so dequeueByAgent can find it later', () => {
    taskCompletedNotification('a_id_1', 'agent', 'all done', AGENT_A)
    expect(dequeueByAgent(AGENT_A)).toBe(1)
  })
})

describe('killShellTasksForAgent drains queue too', () => {
  it('flushes shell notifications owned by the agent after batch-kill', async () => {
    createShellTaskState('b_batch_1', 'echo hi', AGENT_A, 'bash')
    completeShellTask('b_batch_1', 0)
    expect(hasPendingNotifications()).toBe(true)

    await killShellTasksForAgent(AGENT_A)

    expect(drainNotificationsXml()).toBeNull()
  })
})

// Audit fix R6 (2026-05) — `markAllShellTasksNotified` pre-quiet for bulk kill.
//
// `KillAllTasksTool` calls `markAgentTasksNotified()` and now also
// `markAllShellTasksNotified()` BEFORE dispatching the bulk kill. The
// rationale: a shell task that naturally completes inside the race window
// between "user pressed ESC" and "kill reached child PID" used to enqueue
// a `<status>completed</status>` notification the user just asked us to
// silence. Pre-quieting fixes the asymmetry — agents were already covered.
describe('markAllShellTasksNotified — bulk pre-quiet for kill-all', () => {
  it('marks every running shell task notified=true and dedupes their completion XML', () => {
    createShellTaskState('b_pq_1', 'sleep 5', AGENT_A, 'bash')
    createShellTaskState('b_pq_2', 'sleep 10', AGENT_B, 'bash')

    markAllShellTasksNotified()

    expect(getTaskState('b_pq_1')?.notified).toBe(true)
    expect(getTaskState('b_pq_2')?.notified).toBe(true)

    // A shell that races to "completed" AFTER the pre-quiet must NOT
    // enqueue a completion XML — the per-task `notifiedTasks` set already
    // contains it.
    completeShellTask('b_pq_1', 0)
    completeShellTask('b_pq_2', 0)
    expect(drainNotificationsXml()).toBeNull()
  })

  it('does NOT touch terminal-state shell tasks (those are already done)', () => {
    const beforeCompleted = createShellTaskState('b_pq_done', 'echo old', AGENT_A, 'bash')
    completeShellTask(beforeCompleted.id, 0)
    // Drain so the test sees a clean slate.
    drainNotificationsXml()

    markAllShellTasksNotified()

    // The terminal task's `notified=false` (set by createShellTaskState) is
    // unchanged — the bulk mark only walks running/pending shells.
    expect(getTaskState('b_pq_done')?.notified).toBe(false)
  })

  it('skips non-bash tasks (agents are pre-quieted by markAgentTasksNotified)', () => {
    spawnForegroundAgent('a_pq_1', AGENT_A)

    markAllShellTasksNotified()

    // Bulk shell pre-quiet must not flip the agent row — that path is
    // owned by `markAgentTasksNotified()` in `AgentTaskManager`.
    expect(getTaskState('a_pq_1')?.notified).toBe(false)
  })
})

describe('stopTask: bash kill XML is suppressed, agent kill XML is kept', () => {
  it('does NOT enqueue a killed notification when stopping a local_bash task', async () => {
    createShellTaskState('b_stop_1', 'sleep 100', AGENT_A, 'bash')

    await stopTask('b_stop_1')

    expect(drainNotificationsXml()).toBeNull()
    // notified flag still flipped — eviction guards downstream see a
    // coherent terminal state.
    expect(getTaskState('b_stop_1')?.notified).toBe(true)
  })

  it('still emits killed XML when stopping a local_agent task (carries agentId)', async () => {
    spawnForegroundAgent('a_stop_1', AGENT_A)

    await stopTask('a_stop_1')

    const xml = drainNotificationsXml() ?? ''
    // killAgentTask itself purges its own notifications via dequeueByAgent,
    // so we expect the post-kill `taskKilledNotification` call in stopTask
    // to be the ONLY one that survives (it runs AFTER kill()) — and it
    // carries agentId so a future caller can still purge it on demand.
    expect(xml).toMatch(/<taskId>a_stop_1<\/taskId>/)
    expect(xml).toMatch(/<status>killed<\/status>/)
  })
})
