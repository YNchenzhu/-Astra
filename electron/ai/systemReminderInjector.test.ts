import { beforeEach, describe, expect, it } from 'vitest'
import {
  __resetSystemReminderStateForTests,
  collectPendingReminders,
  formatRemindersForUserMeta,
} from './systemReminderInjector'

describe('systemReminderInjector', () => {
  beforeEach(() => __resetSystemReminderStateForTests())

  it('emits nothing on the first observation (no baseline yet)', () => {
    const reminders = collectPendingReminders('conv-1', {
      skillsVersion: 5,
      skillNames: ['debug', 'commit'],
    })
    expect(reminders).toEqual([])
  })

  it('emits a skill-delta reminder only when the version changed', () => {
    collectPendingReminders('conv-1', { skillsVersion: 1, skillNames: ['a', 'b'] })
    // Same version → nothing.
    const stable = collectPendingReminders('conv-1', { skillsVersion: 1, skillNames: ['a', 'b'] })
    expect(stable).toEqual([])

    const afterChange = collectPendingReminders('conv-1', { skillsVersion: 2, skillNames: ['a', 'c'] })
    expect(afterChange).toHaveLength(1)
    expect(afterChange[0].id).toBe('skill-version-change')
    expect(afterChange[0].body).toMatch(/added: c/u)
    expect(afterChange[0].body).toMatch(/removed: b/u)

    // Next turn with no further change → no re-emission.
    const settled = collectPendingReminders('conv-1', { skillsVersion: 2, skillNames: ['a', 'c'] })
    expect(settled).toEqual([])
  })

  it('emits stale-memory reminders only once per (conversation, memory)', () => {
    const first = collectPendingReminders('conv-1', {
      skillsVersion: 1,
      skillNames: [],
      recalledMemories: [
        { name: 'old-note', ageDays: 120 },
        { name: 'recent-note', ageDays: 3 },
      ],
    })
    expect(first.find((r) => r.id === 'stale-memory-warning')?.body).toMatch(/old-note/u)

    const second = collectPendingReminders('conv-1', {
      skillsVersion: 1,
      skillNames: [],
      recalledMemories: [{ name: 'old-note', ageDays: 121 }],
    })
    expect(second.find((r) => r.id === 'stale-memory-warning')).toBeUndefined()
  })

  it('keeps per-conversation state isolated', () => {
    collectPendingReminders('A', { skillsVersion: 1, skillNames: ['x'] })
    collectPendingReminders('B', { skillsVersion: 1, skillNames: ['x'] })
    const aDelta = collectPendingReminders('A', { skillsVersion: 2, skillNames: ['x', 'y'] })
    const bSame = collectPendingReminders('B', { skillsVersion: 1, skillNames: ['x'] })
    expect(aDelta.some((r) => r.id === 'skill-version-change')).toBe(true)
    expect(bSame).toEqual([])
  })

  it('ignores blank conversation ids without mutating shared state', () => {
    const r1 = collectPendingReminders('', { skillsVersion: 1, skillNames: ['x'] })
    expect(r1).toEqual([])
    // A real conv still sees its first observation as baseline-only.
    const r2 = collectPendingReminders('conv-real', { skillsVersion: 1, skillNames: ['x'] })
    expect(r2).toEqual([])
  })

  it('formatRemindersForUserMeta wraps reminders in a single <system-reminder> block', () => {
    const wrapped = formatRemindersForUserMeta([
      { id: 'a', body: 'first body' },
      { id: 'b', body: 'second body' },
    ])
    // Audit fix R4-L3 (2026-05): no longer wraps in a nested
    // `<system-reminder>` (the user-meta block ALREADY lives inside
    // `<system-reminder type="user-meta-context">`); we now emit a
    // plain `# Incremental reminders` section heading that rides
    // inside the outer wrap without doubling the framing tag.
    expect(wrapped).not.toContain('<system-reminder>')
    expect(wrapped).not.toContain('</system-reminder>')
    expect(wrapped).toContain('# Incremental reminders')
    expect(wrapped).toContain('- first body')
    expect(wrapped).toContain('- second body')
  })

  it('formatRemindersForUserMeta returns empty string when no reminders', () => {
    expect(formatRemindersForUserMeta([])).toBe('')
  })

  it('evicts the coldest conversation buckets once the cap is hit', () => {
    // Seed 35 conversations, then verify a cold one's baseline is gone
    // (re-observing it would emit nothing, same as first observation).
    for (let i = 0; i < 35; i++) {
      collectPendingReminders(`c${i}`, { skillsVersion: 1, skillNames: ['a'] })
    }
    // Touch a recent one so it's now "newest" — eviction should target c0.
    collectPendingReminders('c34', { skillsVersion: 1, skillNames: ['a'] })

    // c0 was evicted: observing it again is treated as a fresh first
    // observation (no delta even with a different skill version).
    const re = collectPendingReminders('c0', { skillsVersion: 2, skillNames: ['a', 'b'] })
    expect(re).toEqual([])
    // c34 is fresh: same version + same names → still no delta.
    const same = collectPendingReminders('c34', { skillsVersion: 1, skillNames: ['a'] })
    expect(same).toEqual([])
  })
})
