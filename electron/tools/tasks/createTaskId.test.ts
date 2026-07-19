/**
 * Tests for createTaskId — prefix discipline and collision resistance.
 */

import { describe, it, expect } from 'vitest'
import { createTaskId, inferTaskTypeFromId, __TEST_ONLY__ } from './createTaskId'
import type { TaskType } from './taskInterface'

describe('createTaskId', () => {
  it('returns a single-letter prefix matching the type', () => {
    const checks: Array<[TaskType, string]> = [
      ['local_bash', 'b'],
      ['local_agent', 'a'],
      ['main_session', 's'],
      ['remote_agent', 'r'],
      ['local_workflow', 'w'],
      ['monitor_mcp', 'm'],
      ['dream', 'd'],
    ]
    for (const [type, expectedPrefix] of checks) {
      const id = createTaskId(type)
      expect(id[0]).toBe(expectedPrefix)
    }
  })

  it('all 7 task types map to distinct single-letter prefixes', () => {
    const seen = new Set<string>()
    for (const p of Object.values(__TEST_ONLY__.TYPE_PREFIXES)) {
      expect(p.length).toBe(1)
      expect(seen.has(p)).toBe(false)
      seen.add(p)
    }
    expect(seen.size).toBe(7)
  })

  it('suffix is base36 (lowercase a-z + 0-9 only)', () => {
    const id = createTaskId('local_agent')
    const suffix = id.slice(1)
    expect(suffix).toMatch(/^[0-9a-z]+$/)
    // log36(2^64) ≈ 12.4 → suffix length is bounded but variable (random
    // values < 36^11 produce shorter strings); enforce a sane lower bound.
    expect(suffix.length).toBeGreaterThanOrEqual(8)
    expect(suffix.length).toBeLessThanOrEqual(13)
  })

  it('1000 ids are unique within a single type (collision check)', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 1000; i++) {
      ids.add(createTaskId('local_bash'))
    }
    expect(ids.size).toBe(1000)
  })

  it('throws on unknown task type', () => {
    expect(() => createTaskId('not_a_real_type' as TaskType)).toThrow(/unknown task type/)
  })

  it('inferTaskTypeFromId round-trips for every type', () => {
    const types: TaskType[] = [
      'local_bash',
      'local_agent',
      'main_session',
      'remote_agent',
      'local_workflow',
      'monitor_mcp',
      'dream',
    ]
    for (const t of types) {
      const id = createTaskId(t)
      expect(inferTaskTypeFromId(id)).toBe(t)
    }
  })

  it('inferTaskTypeFromId returns undefined for legacy / unknown prefixes', () => {
    expect(inferTaskTypeFromId('')).toBeUndefined()
    expect(inferTaskTypeFromId('x')).toBeUndefined()
    expect(inferTaskTypeFromId('z42abc')).toBeUndefined()
    // Existing legacy id from streamHandler.ts: `${conv}-t${turn}` is opaque.
    expect(inferTaskTypeFromId('conv1-t5')).toBeUndefined()
  })
})
