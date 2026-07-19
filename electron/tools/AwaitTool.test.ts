import { describe, expect, it } from 'vitest'
import { awaitTool } from './AwaitTool'
import { taskRuntimeStore } from './TaskRuntimeStore'

const run = (input: Record<string, unknown>) => awaitTool.execute(input)

describe('Await tool', () => {
  it('resolves when an awaited task completes', async () => {
    taskRuntimeStore.start('t-await-complete', 'bash')
    const p = run({ task_ids: ['t-await-complete'], timeout_ms: 2000 })
    setTimeout(() => {
      taskRuntimeStore.append('t-await-complete', 'stdout', 'build done\n')
      taskRuntimeStore.markCompleted('t-await-complete', { exitCode: 0 })
    }, 20)
    const res = await p
    expect(res.success).toBe(true)
    expect(res.output).toContain('completed')
    expect(res.output).toContain('exit=0')
  })

  it('returns early when wait_for matches output (task still running)', async () => {
    taskRuntimeStore.start('t-await-ready', 'bash')
    const p = run({ task_ids: ['t-await-ready'], wait_for: 'Ready|Listening on', timeout_ms: 2000 })
    setTimeout(() => {
      taskRuntimeStore.append('t-await-ready', 'stdout', 'server Listening on :3000\n')
    }, 20)
    const res = await p
    expect(res.success).toBe(true)
    expect(res.output).toContain('matched=true')
    taskRuntimeStore.markStopped('t-await-ready')
  })

  it('flags failure when a task fails', async () => {
    taskRuntimeStore.start('t-await-fail', 'bash')
    const p = run({ task_ids: ['t-await-fail'], timeout_ms: 2000 })
    setTimeout(() => taskRuntimeStore.markFailed('t-await-fail', 'compile error'), 20)
    const res = await p
    expect(res.success).toBe(false)
    expect(res.output).toContain('failed')
  })

  it('reports not_found for unknown task ids', async () => {
    const res = await run({ task_ids: ['no-such-task'], timeout_ms: 100 })
    expect(res.success).toBe(false)
    expect(res.output).toContain('not_found')
  })

  it('times out a still-running task as running_timeout', async () => {
    taskRuntimeStore.start('t-await-timeout', 'bash')
    const res = await run({ task_ids: ['t-await-timeout'], timeout_ms: 60 })
    expect(res.success).toBe(false)
    expect(res.output).toContain('running_timeout')
    taskRuntimeStore.markStopped('t-await-timeout')
  })

  it('mode "any" returns after the first task settles and reports success (L1)', async () => {
    taskRuntimeStore.start('t-any-1', 'bash')
    taskRuntimeStore.start('t-any-2', 'bash')
    const p = run({ task_ids: ['t-any-1', 't-any-2'], mode: 'any', timeout_ms: 2000 })
    setTimeout(() => taskRuntimeStore.markCompleted('t-any-1', { exitCode: 0 }), 20)
    const res = await p
    expect(res.output).toContain('t-any-1: completed')
    // L1: the un-awaited t-any-2 (running_timeout) must NOT force success:false.
    expect(res.success).toBe(true)
    taskRuntimeStore.markStopped('t-any-2')
  })

  it('a completed-but-nonzero-exit task is NOT counted as success (L1)', async () => {
    taskRuntimeStore.start('t-nonzero', 'bash')
    const p = run({ task_ids: ['t-nonzero'], timeout_ms: 2000 })
    setTimeout(() => taskRuntimeStore.markCompleted('t-nonzero', { exitCode: 2 }), 20)
    const res = await p
    expect(res.success).toBe(false)
    expect(res.output).toContain('exit=2')
  })

  it('a lone not_found does not end an "any" wait early; the real task still wins (L1)', async () => {
    taskRuntimeStore.start('t-any-real', 'bash')
    const p = run({ task_ids: ['ghost-task', 't-any-real'], mode: 'any', timeout_ms: 2000 })
    // The real task completes a beat later; the not_found must not have already returned.
    setTimeout(() => taskRuntimeStore.markCompleted('t-any-real', { exitCode: 0 }), 30)
    const res = await p
    expect(res.success).toBe(true)
    expect(res.output).toContain('t-any-real: completed')
  })
})
