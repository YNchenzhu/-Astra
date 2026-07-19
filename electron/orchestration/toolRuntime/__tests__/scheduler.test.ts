/**
 * Unit tests for ToolScheduler — priority + DAG + wave planning.
 *
 * Run: npx vitest run electron/orchestration/__tests__/toolScheduler.test.ts
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  getToolScheduler,
  resetToolSchedulerForTests,
  ToolPriority,
  type ToolScheduleRequest,
} from '../scheduler'

describe('ToolScheduler', () => {
  beforeEach(() => {
    resetToolSchedulerForTests()
  })

  function makeReq(overrides: Partial<ToolScheduleRequest> & { toolUseId: string; toolName: string }): ToolScheduleRequest {
    return {
      agentId: 'agent-A',
      input: {},
      readOnly: false,
      priority: ToolPriority.NORMAL,
      ...overrides,
    } as ToolScheduleRequest
  }

  it('should schedule a single tool in one wave', () => {
    const scheduler = getToolScheduler()
    scheduler.enqueueBatch([
      makeReq({ toolUseId: 'tu_1', toolName: 'read_file', readOnly: true }),
    ])

    const plan = scheduler.planNextWaves()
    expect(plan.waves).toHaveLength(1)
    expect(plan.waves[0].parallelTools).toHaveLength(1)
    expect(plan.deferred).toHaveLength(0)
  })

  it('should group read-only tools into parallel waves', () => {
    const scheduler = getToolScheduler()
    scheduler.enqueueBatch([
      makeReq({ toolUseId: 'tu_1', toolName: 'read_file', readOnly: true }),
      makeReq({ toolUseId: 'tu_2', toolName: 'grep', readOnly: true }),
      makeReq({ toolUseId: 'tu_3', toolName: 'glob', readOnly: true }),
    ])

    const plan = scheduler.planNextWaves()
    // All three read-only tools should fit in one parallel wave
    expect(plan.waves).toHaveLength(1)
    expect(plan.waves[0].parallelTools).toHaveLength(3)
  })

  it('should separate mutation tools into serial waves', () => {
    const scheduler = getToolScheduler()
    scheduler.enqueueBatch([
      makeReq({ toolUseId: 'tu_1', toolName: 'write_file', readOnly: false }),
      makeReq({ toolUseId: 'tu_2', toolName: 'edit_file', readOnly: false }),
    ])

    const plan = scheduler.planNextWaves({ maxParallelMutationChunkSize: 1 })
    expect(plan.waves.length).toBeGreaterThanOrEqual(1)
    // Each mutation tool should be in serialTools (since parallel chunk size is 1)
    const totalSerial = plan.waves.reduce((sum, w) => sum + w.serialTools.length, 0)
    expect(totalSerial).toBe(2)
  })

  it('does not let a later same-agent read overtake an earlier mutation', () => {
    const scheduler = getToolScheduler()
    scheduler.enqueueBatch([
      makeReq({ toolUseId: 'write-first', toolName: 'write_file', readOnly: false }),
      makeReq({ toolUseId: 'read-after', toolName: 'read_file', readOnly: true }),
    ])

    const plan = scheduler.planNextWaves({ markScheduled: false })

    expect(plan.waves[0].serialTools.map((tool) => tool.toolUseId)).toEqual(['write-first'])
    expect(plan.waves[0].parallelTools).toHaveLength(0)
    expect(plan.waves[1].parallelTools.map((tool) => tool.toolUseId)).toEqual(['read-after'])
  })

  it('preserves same-agent ordinal even when a later tool has higher priority', () => {
    const scheduler = getToolScheduler()
    scheduler.enqueueBatch([
      makeReq({
        toolUseId: 'first-normal',
        toolName: 'write_file',
        readOnly: false,
        priority: ToolPriority.NORMAL,
      }),
      makeReq({
        toolUseId: 'later-critical',
        toolName: 'read_file',
        readOnly: true,
        priority: ToolPriority.CRITICAL,
      }),
    ])

    const plan = scheduler.planNextWaves({ markScheduled: false })
    expect(plan.waves[0].serialTools[0]?.toolUseId).toBe('first-normal')
  })

  it('enqueueBatch does NOT resurrect terminal/in-flight nodes from earlier batches (2026-06 fix)', () => {
    const scheduler = getToolScheduler()
    scheduler.enqueueBatch([
      makeReq({ toolUseId: 'tu_old', toolName: 'read_file', readOnly: true }),
    ])
    scheduler.planNextWaves() // tu_old → 'scheduled'
    scheduler.markCompleted('tu_old') // → 'completed'（保留 120s 与 runtime registry 对齐）

    scheduler.enqueueBatch([
      makeReq({ toolUseId: 'tu_new', toolName: 'grep', readOnly: true }),
    ])
    // Pre-fix the "mark ready" pass iterated ALL nodes and flipped tu_old
    // back to 'ready', re-planning an already-finished tool.
    expect(scheduler.getNodeStatus('tu_old')).toBe('completed')

    const plan = scheduler.planNextWaves()
    const ids = plan.waves
      .flatMap((w) => [...w.parallelTools, ...w.serialTools])
      .map((t) => t.toolUseId)
    expect(ids).toEqual(['tu_new'])
  })

  it('a new node depending on an already-completed node is immediately ready', () => {
    const scheduler = getToolScheduler()
    scheduler.enqueueBatch([
      makeReq({ toolUseId: 'tu_dep', toolName: 'write_file' }),
    ])
    scheduler.planNextWaves()
    scheduler.markCompleted('tu_dep')

    scheduler.enqueueBatch([
      makeReq({ toolUseId: 'tu_after', toolName: 'read_file', readOnly: true, dependsOn: ['tu_dep'] }),
    ])
    expect(scheduler.getNodeStatus('tu_after')).toBe('ready')
  })

  it('a new node depending on an already-failed node fails immediately (cascade)', () => {
    const scheduler = getToolScheduler()
    scheduler.enqueueBatch([
      makeReq({ toolUseId: 'tu_bad', toolName: 'write_file' }),
    ])
    scheduler.planNextWaves()
    scheduler.markFailed('tu_bad')

    scheduler.enqueueBatch([
      makeReq({ toolUseId: 'tu_after_bad', toolName: 'read_file', readOnly: true, dependsOn: ['tu_bad'] }),
    ])
    expect(scheduler.getNodeStatus('tu_after_bad')).toBe('failed')
  })

  it('cancelAgent removes same-agent dependents too (no 120s leak); cross-agent dependents cascade-fail and stay retained (P3 fix)', () => {
    const scheduler = getToolScheduler()
    scheduler.enqueueBatch([
      makeReq({ toolUseId: 'tu_root', toolName: 'write_file', agentId: 'agent-A' }),
      makeReq({
        toolUseId: 'tu_child_same',
        toolName: 'read_file',
        agentId: 'agent-A',
        readOnly: true,
        dependsOn: ['tu_root'],
      }),
      makeReq({
        toolUseId: 'tu_child_other',
        toolName: 'grep',
        agentId: 'agent-B',
        readOnly: true,
        dependsOn: ['tu_root'],
      }),
    ])

    const cancelled = scheduler.cancelAgent('agent-A')
    expect(cancelled).toBe(2)

    // Pre-fix, tu_child_same got cascade-failed BEFORE the cancel loop reached
    // it, stopped matching the cancellable filter, and leaked for 120s.
    expect(scheduler.getNodeStatus('tu_root')).toBeUndefined()
    expect(scheduler.getNodeStatus('tu_child_same')).toBeUndefined()
    // The other agent's dependent is cascade-failed but retained so its
    // owner's port still observes the failure during the alignment window.
    expect(scheduler.getNodeStatus('tu_child_other')).toBe('failed')
  })

  it('should respect priority ordering', () => {
    const scheduler = getToolScheduler()
    scheduler.enqueueBatch([
      makeReq({ toolUseId: 'tu_1', toolName: 'read_file', agentId: 'agent-low', readOnly: true, priority: ToolPriority.LOW }),
      makeReq({ toolUseId: 'tu_2', toolName: 'edit_file', agentId: 'agent-critical', readOnly: false, priority: ToolPriority.CRITICAL }),
      makeReq({ toolUseId: 'tu_3', toolName: 'grep', agentId: 'agent-high', readOnly: true, priority: ToolPriority.HIGH }),
    ])

    const plan = scheduler.planNextWaves()
    // Critical edit_file should appear before low-priority read_file
    const allIds = plan.waves.flatMap((w) => [
      ...w.serialTools.map((t) => t.toolUseId),
      ...w.parallelTools.map((t) => t.toolUseId),
    ])
    expect(allIds.indexOf('tu_2')).toBeLessThan(allIds.indexOf('tu_1'))
    expect(allIds.indexOf('tu_3')).toBeLessThan(allIds.indexOf('tu_1'))
  })

  it('should defer tools with unresolved dependencies', () => {
    const scheduler = getToolScheduler()
    scheduler.enqueueBatch([
      makeReq({ toolUseId: 'tu_1', toolName: 'write_file', readOnly: false }),
      makeReq({ toolUseId: 'tu_2', toolName: 'read_file', readOnly: true, dependsOn: ['tu_1'] }),
    ])

    const plan = scheduler.planNextWaves()
    // tu_2 depends on tu_1, so tu_2 should be deferred until tu_1 completes
    const allScheduledIds = plan.waves.flatMap((w) => [
      ...w.serialTools.map((t) => t.toolUseId),
      ...w.parallelTools.map((t) => t.toolUseId),
    ])
    expect(allScheduledIds).toContain('tu_1')
    expect(allScheduledIds).not.toContain('tu_2')
    expect(plan.deferred.map((d) => d.toolUseId)).toContain('tu_2')
  })

  it('should unlock dependents after a tool completes', () => {
    const scheduler = getToolScheduler()
    scheduler.enqueueBatch([
      makeReq({ toolUseId: 'tu_1', toolName: 'write_file', readOnly: false }),
      makeReq({ toolUseId: 'tu_2', toolName: 'read_file', readOnly: true, dependsOn: ['tu_1'] }),
    ])

    // First plan: tu_1 scheduled, tu_2 deferred
    let plan = scheduler.planNextWaves()
    expect(plan.deferred.map((d) => d.toolUseId)).toContain('tu_2')

    // Complete tu_1
    scheduler.markCompleted('tu_1')

    // Second plan: tu_2 should now be ready
    plan = scheduler.planNextWaves()
    const allScheduledIds = plan.waves.flatMap((w) => [
      ...w.serialTools.map((t) => t.toolUseId),
      ...w.parallelTools.map((t) => t.toolUseId),
    ])
    expect(allScheduledIds).toContain('tu_2')
    expect(plan.deferred).toHaveLength(0)
  })

  it('should cascade failure to dependents', () => {
    const scheduler = getToolScheduler()
    scheduler.enqueueBatch([
      makeReq({ toolUseId: 'tu_1', toolName: 'bash', readOnly: false }),
      makeReq({ toolUseId: 'tu_2', toolName: 'read_file', readOnly: true, dependsOn: ['tu_1'] }),
      makeReq({ toolUseId: 'tu_3', toolName: 'grep', readOnly: true, dependsOn: ['tu_2'] }),
    ])

    scheduler.markFailed('tu_1')

    // tu_2 and tu_3 should both be dropped from the DAG
    const plan = scheduler.planNextWaves()
    const allScheduledIds = plan.waves.flatMap((w) => [
      ...w.serialTools.map((t) => t.toolUseId),
      ...w.parallelTools.map((t) => t.toolUseId),
    ])
    expect(allScheduledIds).not.toContain('tu_2')
    expect(allScheduledIds).not.toContain('tu_3')
  })

  it('should cancel all tools for an agent', () => {
    const scheduler = getToolScheduler()
    scheduler.enqueueBatch([
      makeReq({ toolUseId: 'tu_1', toolName: 'bash', agentId: 'agent-A', readOnly: false }),
      makeReq({ toolUseId: 'tu_2', toolName: 'read_file', agentId: 'agent-A', readOnly: true }),
      makeReq({ toolUseId: 'tu_3', toolName: 'grep', agentId: 'agent-B', readOnly: true }),
    ])

    const cancelled = scheduler.cancelAgent('agent-A')
    expect(cancelled).toBe(2)

    const plan = scheduler.planNextWaves()
    const allScheduledIds = plan.waves.flatMap((w) => [
      ...w.serialTools.map((t) => t.toolUseId),
      ...w.parallelTools.map((t) => t.toolUseId),
    ])
    expect(allScheduledIds).not.toContain('tu_1')
    expect(allScheduledIds).not.toContain('tu_2')
    expect(allScheduledIds).toContain('tu_3')
  })

  it('should respect max parallel chunk size', () => {
    const scheduler = getToolScheduler()
    scheduler.enqueueBatch(
      Array.from({ length: 20 }, (_, i) =>
        makeReq({ toolUseId: `tu_${i}`, toolName: 'read_file', readOnly: true }),
      ),
    )

    const plan = scheduler.planNextWaves({ maxParallelChunkSize: 5 })
    expect(plan.waves.length).toBeGreaterThanOrEqual(2)
    for (const wave of plan.waves) {
      expect(wave.parallelTools.length + wave.serialTools.length).toBeLessThanOrEqual(5)
    }
  })
})
