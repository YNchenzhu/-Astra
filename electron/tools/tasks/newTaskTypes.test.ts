/**
 * Integration tests for the three new task types:
 *   - local_workflow  (declarative pipelines)
 *   - monitor_mcp     (MCP server liveness)
 *   - dream           (proactive idle agents)
 *
 * Verify:
 *   1. Manager modules register their `Task` impl with the dispatcher on
 *      module load (so `taskDispatcher.stopTask` can route to them).
 *   2. Lifecycle transitions (register → kill) leave state consistent.
 *   3. `createTaskId(type)` produces a prefix that {@link inferTaskTypeFromId}
 *      can round-trip back to the same type.
 */

import { describe, it, expect, afterEach } from 'vitest'
import {
  createTaskId,
  inferTaskTypeFromId,
  getTaskByType,
  getTaskState,
  // workflow
  registerForegroundWorkflow,
  registerBackgroundWorkflow,
  updateWorkflowStep,
  completeWorkflowTask,
  failWorkflowTask,
  killWorkflowTask,
  // mcp monitor
  registerMcpMonitor,
  completeMcpMonitor,
  failMcpMonitor,
  killMcpMonitor,
  // dream
  registerDream,
  completeDream,
  wakeDream,
  killDream,
  isLocalWorkflowTask,
  isMonitorMcpTask,
  isDreamTask,
} from './index'
import { clearAllTaskStates } from './taskStateManager'

afterEach(() => {
  clearAllTaskStates()
})

describe('Task framework — new types registration', () => {
  it('registers local_workflow / monitor_mcp / dream impls', () => {
    expect(getTaskByType('local_workflow')?.name).toBe('LocalWorkflowTask')
    expect(getTaskByType('monitor_mcp')?.name).toBe('MonitorMcpTask')
    expect(getTaskByType('dream')?.name).toBe('DreamTask')
  })

  it('createTaskId / inferTaskTypeFromId round-trip for all 3 new types', () => {
    const wfId = createTaskId('local_workflow')
    const mcpId = createTaskId('monitor_mcp')
    const dreamId = createTaskId('dream')
    expect(inferTaskTypeFromId(wfId)).toBe('local_workflow')
    expect(inferTaskTypeFromId(mcpId)).toBe('monitor_mcp')
    expect(inferTaskTypeFromId(dreamId)).toBe('dream')
  })
})

describe('LocalWorkflowTaskManager', () => {
  it('register → step update → complete', () => {
    const taskId = createTaskId('local_workflow')
    const ac = new AbortController()
    const state = registerForegroundWorkflow({
      taskId,
      workflowName: 'unit-test-pipeline',
      description: 'run unit tests then deploy',
      abortController: ac,
      totalSteps: 3,
    })
    expect(state.type).toBe('local_workflow')
    expect(isLocalWorkflowTask(state)).toBe(true)
    expect(state.workflowName).toBe('unit-test-pipeline')

    updateWorkflowStep(taskId, 1, 'lint')
    const stepped = getTaskState(taskId)!
    expect(isLocalWorkflowTask(stepped)).toBe(true)
    if (isLocalWorkflowTask(stepped)) {
      expect(stepped.stepIndex).toBe(1)
      expect(stepped.currentStep).toBe('lint')
    }

    completeWorkflowTask(taskId, 'all green')
    expect(getTaskState(taskId)?.status).toBe('completed')
  })

  it('background register goes straight to background', () => {
    const taskId = createTaskId('local_workflow')
    const state = registerBackgroundWorkflow({
      taskId,
      workflowName: 'bg-pipe',
      description: 'long pipe',
      abortController: new AbortController(),
    })
    expect(state.isBackgrounded).toBe(true)
  })

  it('kill aborts the controller and flips status', async () => {
    const taskId = createTaskId('local_workflow')
    const ac = new AbortController()
    registerForegroundWorkflow({
      taskId,
      workflowName: 'killable',
      description: 'kill me',
      abortController: ac,
    })
    await killWorkflowTask(taskId)
    expect(ac.signal.aborted).toBe(true)
    expect(getTaskState(taskId)?.status).toBe('killed')
  })

  it('failure path emits failed status', () => {
    const taskId = createTaskId('local_workflow')
    registerForegroundWorkflow({
      taskId,
      workflowName: 'fails',
      description: 'will fail',
      abortController: new AbortController(),
    })
    failWorkflowTask(taskId, 'oops')
    expect(getTaskState(taskId)?.status).toBe('failed')
  })
})

describe('McpMonitorTaskManager', () => {
  it('register → complete', () => {
    const taskId = createTaskId('monitor_mcp')
    const state = registerMcpMonitor({
      taskId,
      serverName: 'test-mcp',
      description: 'monitor test mcp',
    })
    expect(state.type).toBe('monitor_mcp')
    expect(isMonitorMcpTask(state)).toBe(true)
    expect(state.serverName).toBe('test-mcp')
    expect(state.lastHeartbeatMs).toBeGreaterThan(0)

    completeMcpMonitor(taskId, 'shutdown clean')
    expect(getTaskState(taskId)?.status).toBe('completed')
  })

  it('failure path records lastError', () => {
    const taskId = createTaskId('monitor_mcp')
    registerMcpMonitor({
      taskId,
      serverName: 'flaky-mcp',
      description: 'flaky',
    })
    failMcpMonitor(taskId, 'connection reset')
    const state = getTaskState(taskId)
    expect(state?.status).toBe('failed')
    expect(isMonitorMcpTask(state!)).toBe(true)
    if (isMonitorMcpTask(state!)) {
      expect(state.lastError).toBe('connection reset')
    }
  })

  it('heartbeat ticks update lastHeartbeatMs and stop on kill', async () => {
    const taskId = createTaskId('monitor_mcp')
    let heartbeats = 0
    // 20ms interval / 120ms wait gives ≥4 expected ticks with a 2-tick floor
    // assertion — comfortable slack against Windows event-loop jitter
    // (the previous 5ms/25ms window flaked on slow CI / busy hosts).
    registerMcpMonitor({
      taskId,
      serverName: 'beating-mcp',
      description: 'beats',
      heartbeat: () => {
        heartbeats++
      },
      heartbeatIntervalMs: 20,
    })
    await new Promise((r) => setTimeout(r, 120))
    expect(heartbeats).toBeGreaterThanOrEqual(2)
    await killMcpMonitor(taskId)
    const beatsAtKill = heartbeats
    await new Promise((r) => setTimeout(r, 80))
    // After kill, the interval should have been cleared so the count
    // stays at most 1 above (final scheduled callback racing) — bound
    // generously to dodge any setInterval skew.
    expect(heartbeats).toBeLessThanOrEqual(beatsAtKill + 1)
    expect(getTaskState(taskId)?.status).toBe('killed')
  })

  it('heartbeat reject auto-flips to failed', async () => {
    const taskId = createTaskId('monitor_mcp')
    registerMcpMonitor({
      taskId,
      serverName: 'failing-mcp',
      description: 'will fail',
      heartbeat: async () => {
        throw new Error('lost connection')
      },
      heartbeatIntervalMs: 5,
    })
    await new Promise((r) => setTimeout(r, 25))
    const state = getTaskState(taskId)
    expect(state?.status).toBe('failed')
  })
})

describe('DreamTaskManager', () => {
  it('register → wake completes with summary', async () => {
    const taskId = createTaskId('dream')
    const ac = new AbortController()
    const state = registerDream({
      taskId,
      trigger: 'idle_5min',
      description: 'consolidate memory',
      abortController: ac,
    })
    expect(isDreamTask(state)).toBe(true)
    expect(state.trigger).toBe('idle_5min')

    await wakeDream(taskId, 'wrote 3 notes before user returned')
    expect(ac.signal.aborted).toBe(true)
    const final = getTaskState(taskId)
    expect(final?.status).toBe('completed')
    expect(isDreamTask(final!)).toBe(true)
    if (isDreamTask(final!)) {
      expect(final.summary).toBe('wrote 3 notes before user returned')
    }
  })

  it('killDream is equivalent to wakeDream (no killed-notification noise)', async () => {
    const taskId = createTaskId('dream')
    const ac = new AbortController()
    registerDream({
      taskId,
      trigger: 'idle_2min',
      description: 'tidy',
      abortController: ac,
    })
    await killDream(taskId)
    expect(ac.signal.aborted).toBe(true)
    expect(getTaskState(taskId)?.status).toBe('completed')
  })

  it('completeDream flow without abort', () => {
    const taskId = createTaskId('dream')
    registerDream({
      taskId,
      trigger: 'memory_consolidate',
      description: 'auto-summary',
      abortController: new AbortController(),
    })
    completeDream(taskId, 'consolidated 12 entries')
    expect(getTaskState(taskId)?.status).toBe('completed')
  })
})
