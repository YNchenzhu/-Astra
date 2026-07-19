import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { asAgentId } from '../../../tools/ids'
import {
  getToolAdmissionCoordinator,
  type ToolAdmissionRequest,
} from '../admission'
import {
  clearToolRuntimeStateForTests,
  getToolEntry,
  preemptTool,
} from '../state'
import {
  getToolScheduler,
  resetToolSchedulerForTests,
  ToolPriority,
} from '../scheduler'
import {
  getResourceQuotaManager,
  resetResourceQuotaManagerForTests,
} from '../quota'

function request(
  toolUseId: string,
  overrides: Partial<ToolAdmissionRequest> = {},
): ToolAdmissionRequest {
  return {
    toolUseId,
    toolName: 'grep',
    agentId: asAgentId('agent-1'),
    input: {},
    isReadOnly: true,
    priority: ToolPriority.NORMAL,
    signal: new AbortController().signal,
    quotaMode: 'deny',
    ...overrides,
  }
}

beforeEach(() => {
  clearToolRuntimeStateForTests()
  resetToolSchedulerForTests()
  resetResourceQuotaManagerForTests()
})

afterEach(() => {
  clearToolRuntimeStateForTests()
  resetToolSchedulerForTests()
  resetResourceQuotaManagerForTests()
  vi.unstubAllEnvs()
})

describe('ToolAdmissionCoordinator', () => {
  it('creates one runtime entry, one scheduler node, and one stable preempt signal', async () => {
    const result = await getToolAdmissionCoordinator().acquire(request('tool-1'))
    expect(result.admitted).toBe(true)
    if (!result.admitted) return

    const signal = result.lease.effectiveSignal
    result.lease.start()

    expect(result.lease.priority).toBe(ToolPriority.NORMAL)
    expect(getToolEntry('tool-1')?.status).toBe('running')
    expect(getToolScheduler().getNodeStatus('tool-1')).toBe('scheduled')
    expect(preemptTool('tool-1', 'test preempt')).toBe(true)
    expect(result.lease.effectiveSignal).toBe(signal)
    expect(signal.aborted).toBe(true)

    result.lease.finish('aborted', 'test preempt')
    expect(getToolEntry('tool-1')?.status).toBe('aborted')
  })

  it('rejects a duplicate active id without replacing the original controller', async () => {
    const first = await getToolAdmissionCoordinator().acquire(request('same-id'))
    expect(first.admitted).toBe(true)
    if (!first.admitted) return
    const originalSignal = first.lease.effectiveSignal

    const duplicate = await getToolAdmissionCoordinator().acquire(
      request('same-id', { priority: ToolPriority.HIGH }),
    )
    expect(duplicate).toMatchObject({
      admitted: false,
      ruleId: 'duplicate_active_tool_use_id',
    })
    expect(first.lease.effectiveSignal).toBe(originalSignal)
    expect(originalSignal.aborted).toBe(false)
    first.lease.finish('completed')
  })

  it('makes finish idempotent and preserves the first terminal outcome', async () => {
    const release = vi.spyOn(getResourceQuotaManager(), 'release')
    const result = await getToolAdmissionCoordinator().acquire(request('finish-once'))
    expect(result.admitted).toBe(true)
    if (!result.admitted) return

    result.lease.start()
    result.lease.finish('completed')
    result.lease.finish('failed', 'late failure')

    expect(getToolEntry('finish-once')?.status).toBe('completed')
    expect(getToolScheduler().getNodeStatus('finish-once')).toBe('completed')
    expect(release).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledWith('finish-once')
  })

  it('preempts through the exact AbortSignal observed by the running victim', async () => {
    getResourceQuotaManager().updateConfig({
      maxGlobalMutationParallel: 1,
      enablePreemption: true,
      backpressureMaxWaitMs: 0,
    })
    const victim = await getToolAdmissionCoordinator().acquire(
      request('victim', {
        toolName: 'write_file',
        agentId: asAgentId('background'),
        isReadOnly: false,
        priority: ToolPriority.BACKGROUND,
      }),
    )
    expect(victim.admitted).toBe(true)
    if (!victim.admitted) return
    victim.lease.start()

    const incoming = await getToolAdmissionCoordinator().acquire(
      request('incoming', {
        toolName: 'write_file',
        agentId: asAgentId('main'),
        isReadOnly: false,
        priority: ToolPriority.HIGH,
      }),
    )

    expect(incoming.admitted).toBe(true)
    expect(victim.lease.effectiveSignal.aborted).toBe(true)
    expect(getToolEntry('victim')?.status).toBe('aborted')
    if (incoming.admitted) incoming.lease.finish('completed')
  })

  it('authoritative mode grants higher priority first and advances on finish', async () => {
    vi.stubEnv('POLE_TOOL_SCHEDULER_MODE', 'authoritative')
    const low = await getToolAdmissionCoordinator().acquire(
      request('low', {
        agentId: asAgentId('background'),
        priority: ToolPriority.BACKGROUND,
      }),
    )
    const high = await getToolAdmissionCoordinator().acquire(
      request('high', {
        agentId: asAgentId('main'),
        priority: ToolPriority.HIGH,
      }),
    )
    expect(low.admitted && high.admitted).toBe(true)
    if (!low.admitted || !high.admitted) return

    let lowGranted = false
    const lowWait = low.lease.waitUntilGranted().then(() => {
      lowGranted = true
    })
    await high.lease.waitUntilGranted()
    expect(lowGranted).toBe(false)

    high.lease.start()
    high.lease.finish('completed')
    await lowWait
    expect(lowGranted).toBe(true)
    low.lease.start()
    low.lease.finish('completed')
  })

  it('authoritative mode preserves same-agent write-before-read order', async () => {
    vi.stubEnv('POLE_TOOL_SCHEDULER_MODE', 'authoritative')
    const write = await getToolAdmissionCoordinator().acquire(
      request('write-first', {
        toolName: 'write_file',
        isReadOnly: false,
      }),
    )
    const read = await getToolAdmissionCoordinator().acquire(
      request('read-after', {
        toolName: 'read_file',
        isReadOnly: true,
      }),
    )
    expect(write.admitted && read.admitted).toBe(true)
    if (!write.admitted || !read.admitted) return

    let readGranted = false
    const readWait = read.lease.waitUntilGranted().then(() => {
      readGranted = true
    })
    await write.lease.waitUntilGranted()
    expect(readGranted).toBe(false)

    write.lease.start()
    write.lease.finish('completed')
    await readWait
    read.lease.start()
    read.lease.finish('completed')
  })
})
