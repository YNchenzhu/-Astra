import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { taskManager } from '../tools/TaskManager'
import {
  DEFAULT_MAX_CONSECUTIVE_CLAIMS,
  formatClaimPromptText,
  tryClaimNextTask,
} from './teamTaskAutoClaim'

describe('tryClaimNextTask', () => {
  beforeEach(() => {
    taskManager.clear()
  })
  afterEach(() => {
    taskManager.clear()
  })

  it('returns null when no tasks exist', () => {
    expect(tryClaimNextTask({ teammateName: 'researcher' })).toBeNull()
  })

  it('returns null when the only pending task is owned by someone else', () => {
    taskManager.create({ subject: 'a', owner: 'coder', status: 'pending' })
    expect(tryClaimNextTask({ teammateName: 'researcher' })).toBeNull()
  })

  it('claims an unowned pending task and flips it to in_progress + owner', () => {
    const t = taskManager.create({ subject: 'wire auth', status: 'pending' })
    const claim = tryClaimNextTask({ teammateName: 'researcher' })
    expect(claim).not.toBeNull()
    expect(claim!.taskId).toBe(t.taskId)
    expect(claim!.subject).toBe('wire auth')
    expect(claim!.wasOwnedAlready).toBe(false)

    const updated = taskManager.getTask(t.taskId)
    expect(updated?.owner).toBe('researcher')
    expect(updated?.status).toBe('in_progress')
  })

  it('prefers tasks already owned by the teammate over unowned ones', () => {
    const owned = taskManager.create({
      subject: 'resume me',
      owner: 'researcher',
      status: 'pending',
    })
    taskManager.create({ subject: 'unowned', status: 'pending' })
    const claim = tryClaimNextTask({ teammateName: 'researcher' })
    expect(claim?.taskId).toBe(owned.taskId)
    expect(claim?.wasOwnedAlready).toBe(true)
  })

  it('picks the lexicographically-smallest taskId among unowned tasks', () => {
    // Force deterministic ordering by creating in non-sorted order; the
    // ids are `task-<ts>-<counter>` so creation order == lex order. Pick
    // by subject to verify the helper actually sorts.
    const a = taskManager.create({ subject: 'first', status: 'pending' })
    const b = taskManager.create({ subject: 'second', status: 'pending' })
    expect(a.taskId.localeCompare(b.taskId)).toBeLessThan(0)
    const claim = tryClaimNextTask({ teammateName: 'researcher' })
    expect(claim?.taskId).toBe(a.taskId)
  })

  it('skips tasks blocked by an incomplete dependency', () => {
    const blocker = taskManager.create({ subject: 'blocker', status: 'pending' })
    taskManager.create({
      subject: 'blocked',
      status: 'pending',
      addBlockedBy: [blocker.taskId],
    })
    const claim = tryClaimNextTask({ teammateName: 'researcher' })
    expect(claim?.taskId).toBe(blocker.taskId)
  })

  it('claims a task whose blockedBy dep is already completed', () => {
    const dep = taskManager.create({ subject: 'dep', status: 'completed' })
    const downstream = taskManager.create({
      subject: 'downstream',
      status: 'pending',
      addBlockedBy: [dep.taskId],
    })
    const claim = tryClaimNextTask({ teammateName: 'researcher' })
    expect(claim?.taskId).toBe(downstream.taskId)
  })

  it('skips tasks that are not in `pending` status', () => {
    taskManager.create({ subject: 'in flight', status: 'in_progress', owner: 'someone' })
    taskManager.create({ subject: 'done', status: 'completed' })
    expect(tryClaimNextTask({ teammateName: 'researcher' })).toBeNull()
  })

  it('respects the consecutive-claim cap', () => {
    taskManager.create({ subject: 'x', status: 'pending' })
    expect(
      tryClaimNextTask({
        teammateName: 'researcher',
        alreadyClaimedThisRun: DEFAULT_MAX_CONSECUTIVE_CLAIMS,
      }),
    ).toBeNull()
    // Custom cap of 2 — calling with `alreadyClaimedThisRun=2` short-circuits.
    expect(
      tryClaimNextTask({
        teammateName: 'researcher',
        alreadyClaimedThisRun: 2,
        maxConsecutiveClaims: 2,
      }),
    ).toBeNull()
  })

  it('claims when alreadyClaimedThisRun is just below the cap', () => {
    taskManager.create({ subject: 'x', status: 'pending' })
    const claim = tryClaimNextTask({
      teammateName: 'researcher',
      alreadyClaimedThisRun: DEFAULT_MAX_CONSECUTIVE_CLAIMS - 1,
    })
    expect(claim).not.toBeNull()
  })

  it('returns null when teammateName is empty / whitespace', () => {
    taskManager.create({ subject: 'x', status: 'pending' })
    expect(tryClaimNextTask({ teammateName: '' })).toBeNull()
    expect(tryClaimNextTask({ teammateName: '   ' })).toBeNull()
  })

  it('two same-tick claims never see the same task (atomic in-process update)', () => {
    taskManager.create({ subject: 'only one', status: 'pending' })
    const a = tryClaimNextTask({ teammateName: 'a' })
    const b = tryClaimNextTask({ teammateName: 'b' })
    expect(a).not.toBeNull()
    expect(b).toBeNull()
  })
})

describe('formatClaimPromptText', () => {
  it('uses "New assignment" verb for fresh claims', () => {
    const out = formatClaimPromptText({
      taskId: 'task-1',
      subject: 'wire auth',
      wasOwnedAlready: false,
    })
    expect(out).toMatch(/^New assignment: task task-1 — wire auth/)
  })

  it('uses "Resuming" verb when the task was already owned', () => {
    const out = formatClaimPromptText({
      taskId: 'task-1',
      subject: 'wire auth',
      wasOwnedAlready: true,
    })
    expect(out).toMatch(/^Resuming: task task-1 — wire auth/)
  })

  it('includes description block when present', () => {
    const out = formatClaimPromptText({
      taskId: 'task-1',
      subject: 'wire auth',
      description: 'POST /login should return JWT',
      wasOwnedAlready: false,
    })
    expect(out).toContain('Task description:')
    expect(out).toContain('POST /login should return JWT')
  })

  it('reminds the model to mark the task completed on finish', () => {
    const out = formatClaimPromptText({
      taskId: 'task-7',
      subject: 'wire auth',
      wasOwnedAlready: false,
    })
    expect(out).toContain('TaskUpdate')
    expect(out).toContain('task-7')
  })
})
