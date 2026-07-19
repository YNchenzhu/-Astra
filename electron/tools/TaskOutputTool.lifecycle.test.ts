/**
 * Regression coverage for the parent↔sub-agent coordination fixes documented
 * in `electron/agents/agentTool.ts` (background path) and
 * `electron/tools/TaskOutputTool.ts` (rendering / wait support).
 *
 * The user's reported symptom chain was:
 *   1. Parent agent asserts the sub-agent has no usable output WHILE the
 *      sub-agent is still booting / thinking, then redoes the work itself.
 *   2. Background sub-agent failure is invisible to the parent.
 *   3. Parallel background spawns appear "blocked" / "failed to start" because
 *      the immediate post-spawn poll sees only the spawn JSON.
 *
 * The root cause was a runtime-store lifecycle bug: `markCompleted` fired at
 * spawn time for background agents (parent tool returned `success: true`
 * carrying the spawn JSON), so the runtime record was permanently stuck at
 * `Status: completed` even while the sub-agent was running, and never
 * transitioned to `Status: failed` on crash.
 *
 * These tests pin the new contract:
 *   - `taskOutputTool` distinguishes `running` (still working) from
 *     `completed` (truly done) in its rendered output.
 *   - `wait_for_status` actively blocks until status flips or output appears.
 *   - `taskRuntimeStore.waitForChange` wakes on status transitions.
 */

import { describe, expect, it, beforeEach } from 'vitest'
import { taskRuntimeStore } from './TaskRuntimeStore'
import { taskOutputTool } from './TaskOutputTool'

let counter = 0
function freshId(): string {
  counter++
  return `tu-test-${Date.now()}-${counter}`
}

describe('TaskOutputTool — running vs completed rendering (A3)', () => {
  beforeEach(() => {
    counter++
  })

  it('running record with empty buffer renders "still running, no output yet…" (NOT "(no output)")', async () => {
    const id = freshId()
    taskRuntimeStore.start(id, 'agent')
    const r = await taskOutputTool.execute({ task_id: id })
    expect(r.success).toBe(true)
    const out = String(r.output)
    expect(out).toContain('Status: running')
    expect(out).toContain('still running, no output yet')
    expect(out).not.toContain('(no output)')
    taskRuntimeStore.removeRecord(id)
  })

  it('running record with text output renders the chunks (no still-running banner)', async () => {
    const id = freshId()
    taskRuntimeStore.start(id, 'agent')
    taskRuntimeStore.append(id, 'text', 'partial findings')
    const r = await taskOutputTool.execute({ task_id: id })
    const out = String(r.output)
    expect(out).toContain('Status: running')
    expect(out).toContain('partial findings')
    expect(out).not.toContain('still running, no output yet')
    taskRuntimeStore.removeRecord(id)
  })

  it('completed record with no chunks renders "(task ended with no streamed output)"', async () => {
    const id = freshId()
    taskRuntimeStore.start(id, 'agent')
    taskRuntimeStore.markCompleted(id)
    const r = await taskOutputTool.execute({ task_id: id })
    const out = String(r.output)
    expect(out).toContain('Status: completed')
    expect(out).toContain('task ended with no streamed output')
    taskRuntimeStore.removeRecord(id)
  })

  it('failed record surfaces the Error verbatim in the rendered text body', async () => {
    const id = freshId()
    taskRuntimeStore.start(id, 'agent')
    taskRuntimeStore.markFailed(id, 'sub-agent crashed: ENOENT model.bin')
    const r = await taskOutputTool.execute({ task_id: id })
    const out = String(r.output)
    expect(out).toContain('Status: failed')
    expect(out).toContain('sub-agent crashed: ENOENT model.bin')
    taskRuntimeStore.removeRecord(id)
  })

  it('running record renders "(active)" hint after the status field so the LLM sees it is still working', async () => {
    const id = freshId()
    taskRuntimeStore.start(id, 'agent')
    const r = await taskOutputTool.execute({ task_id: id })
    expect(String(r.output)).toContain('Status: running (active)')
    taskRuntimeStore.removeRecord(id)
  })
})

describe('TaskRuntimeStore.waitForChange (C8)', () => {
  it('resolves immediately when the record is already terminal', async () => {
    const id = freshId()
    taskRuntimeStore.start(id, 'agent')
    taskRuntimeStore.markCompleted(id)
    const t0 = Date.now()
    const ok = await taskRuntimeStore.waitForChange(id, {
      sinceOffset: 0,
      waitForStatus: 'any_terminal',
      timeoutMs: 5000,
    })
    expect(ok).toBe(true)
    expect(Date.now() - t0).toBeLessThan(50)
    taskRuntimeStore.removeRecord(id)
  })

  it('resolves with true when markCompleted fires during the wait', async () => {
    const id = freshId()
    taskRuntimeStore.start(id, 'agent')
    setTimeout(() => taskRuntimeStore.markCompleted(id), 30)
    const ok = await taskRuntimeStore.waitForChange(id, {
      sinceOffset: 0,
      waitForStatus: 'any_terminal',
      timeoutMs: 1000,
    })
    expect(ok).toBe(true)
    taskRuntimeStore.removeRecord(id)
  })

  it('resolves with true when markFailed fires during the wait, distinguishing failed vs completed semantics', async () => {
    const id = freshId()
    taskRuntimeStore.start(id, 'agent')
    setTimeout(() => taskRuntimeStore.markFailed(id, 'oops'), 30)
    const ok = await taskRuntimeStore.waitForChange(id, {
      sinceOffset: 0,
      waitForStatus: 'failed',
      timeoutMs: 1000,
    })
    expect(ok).toBe(true)
    taskRuntimeStore.removeRecord(id)
  })

  it('resolves with false on plain timeout when nothing changes', async () => {
    const id = freshId()
    taskRuntimeStore.start(id, 'agent')
    const t0 = Date.now()
    const ok = await taskRuntimeStore.waitForChange(id, {
      sinceOffset: 0,
      waitForStatus: 'any_terminal',
      timeoutMs: 80,
    })
    expect(ok).toBe(false)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(60)
    taskRuntimeStore.removeRecord(id)
  })

  it('has_output mode wakes when any chunk appended, even without status change', async () => {
    const id = freshId()
    taskRuntimeStore.start(id, 'agent')
    setTimeout(() => taskRuntimeStore.append(id, 'text', 'first byte'), 30)
    const ok = await taskRuntimeStore.waitForChange(id, {
      sinceOffset: 0,
      waitForStatus: 'has_output',
      timeoutMs: 1000,
    })
    expect(ok).toBe(true)
    taskRuntimeStore.removeRecord(id)
  })

  it('completed-status mode wakes on a markFailed event (any terminal state ends the wait)', async () => {
    // Regression: previously the wait was gated on the specific requested
    // terminal kind, so `wait_for_status: 'completed'` on a task that
    // ACTUALLY FAILED would block until `timeoutMs` elapsed (up to 30 min
    // via MAX_WAIT_TIMEOUT_MS). That stalled the parent agent's
    // TaskOutput call indefinitely whenever a sub-agent hit the
    // read-only tool-call budget cap and was marked `failed`. The fix:
    // any terminal status wakes any non-`has_output` wait; the caller
    // reads `record.status` to branch on the actual outcome.
    const id = freshId()
    taskRuntimeStore.start(id, 'agent')
    setTimeout(() => taskRuntimeStore.markFailed(id, 'fail'), 20)
    const t0 = Date.now()
    const ok = await taskRuntimeStore.waitForChange(id, {
      sinceOffset: 0,
      waitForStatus: 'completed',
      timeoutMs: 5000,
    })
    expect(ok).toBe(true)
    expect(Date.now() - t0).toBeLessThan(500)
    taskRuntimeStore.removeRecord(id)
  })

  it('failed-status mode wakes on a markCompleted event (any terminal state ends the wait)', async () => {
    // Symmetric to the above — the same fail-fast contract holds in
    // reverse: a wait for `failed` wakes when the task instead succeeds,
    // because no future transition can reach `failed` once `completed`.
    const id = freshId()
    taskRuntimeStore.start(id, 'agent')
    setTimeout(() => taskRuntimeStore.markCompleted(id), 20)
    const t0 = Date.now()
    const ok = await taskRuntimeStore.waitForChange(id, {
      sinceOffset: 0,
      waitForStatus: 'failed',
      timeoutMs: 5000,
    })
    expect(ok).toBe(true)
    expect(Date.now() - t0).toBeLessThan(500)
    taskRuntimeStore.removeRecord(id)
  })
})

describe('TaskOutputTool — running sub-agent poll rate-limit (contract audit 2026-07)', () => {
  it('auto-defers a repeat read of a RUNNING agent when no new output arrived', async () => {
    const id = freshId()
    taskRuntimeStore.start(id, 'agent')
    taskRuntimeStore.append(id, 'text', 'first output')
    const r1 = await taskOutputTool.execute({ task_id: id })
    expect(String(r1.output)).toContain('first output')
    // Immediate second read, nothing new → deferred notice instead of buffer.
    const r2 = await taskOutputTool.execute({ task_id: id })
    expect(r2.success).toBe(true)
    const out2 = String(r2.output)
    expect(out2).toContain('[auto-deferred]')
    expect(out2).not.toContain('first output')
    taskRuntimeStore.removeRecord(id)
  })

  it('lets the repeat read through when NEW output arrived since the last read', async () => {
    const id = freshId()
    taskRuntimeStore.start(id, 'agent')
    taskRuntimeStore.append(id, 'text', 'first output')
    await taskOutputTool.execute({ task_id: id })
    taskRuntimeStore.append(id, 'text', ' second output')
    const r2 = await taskOutputTool.execute({ task_id: id })
    const out2 = String(r2.output)
    expect(out2).not.toContain('[auto-deferred]')
    expect(out2).toContain('second output')
    taskRuntimeStore.removeRecord(id)
  })

  it('never defers terminal records (completed readback always passes)', async () => {
    const id = freshId()
    taskRuntimeStore.start(id, 'agent')
    taskRuntimeStore.append(id, 'text', 'result body')
    await taskOutputTool.execute({ task_id: id })
    taskRuntimeStore.markCompleted(id)
    const r2 = await taskOutputTool.execute({ task_id: id })
    const out2 = String(r2.output)
    expect(out2).not.toContain('[auto-deferred]')
    expect(out2).toContain('result body')
    // And a third read of the completed record still passes.
    const r3 = await taskOutputTool.execute({ task_id: id })
    expect(String(r3.output)).toContain('result body')
    taskRuntimeStore.removeRecord(id)
  })

  it('does not rate-limit non-agent runtime tasks (bash has no auto-delivery channel)', async () => {
    const id = freshId()
    taskRuntimeStore.start(id, 'bash')
    taskRuntimeStore.append(id, 'stdout', 'building...')
    await taskOutputTool.execute({ task_id: id })
    const r2 = await taskOutputTool.execute({ task_id: id })
    const out2 = String(r2.output)
    expect(out2).not.toContain('[auto-deferred]')
    expect(out2).toContain('building...')
    taskRuntimeStore.removeRecord(id)
  })

  it('short-circuits BEFORE a blocking wait_for_status hold on a repeat poll', async () => {
    const id = freshId()
    taskRuntimeStore.start(id, 'agent')
    await taskOutputTool.execute({ task_id: id })
    const t0 = Date.now()
    const r2 = await taskOutputTool.execute({
      task_id: id,
      wait_for_status: 'any_terminal',
      wait_timeout_ms: 5000,
    })
    // Deferred read returns immediately instead of blocking ~5s.
    expect(Date.now() - t0).toBeLessThan(500)
    expect(String(r2.output)).toContain('[auto-deferred]')
    taskRuntimeStore.removeRecord(id)
  })
})

describe('TaskOutputTool — wait_for_status integration (C8)', () => {
  it('wait_for_status: any_terminal blocks until markCompleted, then renders Status: completed', async () => {
    const id = freshId()
    taskRuntimeStore.start(id, 'agent')
    taskRuntimeStore.append(id, 'text', 'progress')
    setTimeout(() => taskRuntimeStore.markCompleted(id), 30)
    const r = await taskOutputTool.execute({
      task_id: id,
      wait_for_status: 'any_terminal',
      wait_timeout_ms: 1000,
    })
    expect(r.success).toBe(true)
    const out = String(r.output)
    expect(out).toContain('Status: completed')
    expect(out).toContain('observed=yes')
    taskRuntimeStore.removeRecord(id)
  })

  it('wait_for_status timeout reports observed=no without changing status', async () => {
    const id = freshId()
    taskRuntimeStore.start(id, 'agent')
    const r = await taskOutputTool.execute({
      task_id: id,
      wait_for_status: 'any_terminal',
      wait_timeout_ms: 80,
    })
    const out = String(r.output)
    expect(out).toContain('Status: running')
    expect(out).toContain('observed=no')
    taskRuntimeStore.removeRecord(id)
  })

  it('rejects an invalid wait_for_status value with an actionable error', async () => {
    const id = freshId()
    taskRuntimeStore.start(id, 'agent')
    const r = await taskOutputTool.execute({
      task_id: id,
      wait_for_status: 'not_a_real_value',
    })
    expect(r.success).toBe(false)
    expect(String(r.error)).toContain('wait_for_status must be one of')
    taskRuntimeStore.removeRecord(id)
  })

  it('caps wait_timeout_ms at MAX_WAIT_TIMEOUT_MS (120s) to prevent UI freeze', async () => {
    const id = freshId()
    taskRuntimeStore.start(id, 'agent')
    setTimeout(() => taskRuntimeStore.markCompleted(id), 10)
    const r = await taskOutputTool.execute({
      task_id: id,
      wait_for_status: 'any_terminal',
      wait_timeout_ms: 999_999_999,
    })
    expect(r.success).toBe(true)
    const out = String(r.output)
    // The cap is now a hard 120s ceiling so a single TaskOutput call can
    // never freeze the agent on the "Task output" step for minutes. Longer
    // tasks return at the cap and are delivered out-of-band (task
    // notifications / sub-agent context block / idle auto-resume).
    // The rendered "timeout=…" line must reflect the ceiling.
    expect(out).toMatch(/timeout=120000ms/)
    taskRuntimeStore.removeRecord(id)
  })
})
