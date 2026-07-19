import { describe, it, expect, beforeEach, vi } from 'vitest'

// We test the TaskManager class directly, not the singleton,
// so we can get a fresh instance for each test.
// Re-import the module internals by reading the class from the file.

// Since TaskManager is exported as a singleton, we'll test through it
// but reset state between tests.
import { taskManager } from './TaskManager'

describe('TaskManager', () => {
  beforeEach(() => {
    taskManager.clear()
  })

  describe('create', () => {
    it('should create a task with default values', () => {
      const task = taskManager.create({ subject: 'Fix auth bug' })
      expect(task.taskId).toBeTruthy()
      expect(task.subject).toBe('Fix auth bug')
      expect(task.status).toBe('pending')
      expect(task.source).toBe('system')
      expect(task.blockedBy).toEqual([])
      expect(task.outputChunks).toEqual([])
      expect(task.outputCursor).toBe(0)
      expect(task.createdAt).toBeGreaterThan(0)
    })

    it('should create with initial in_progress and startedAt', () => {
      const task = taskManager.create({ subject: 'Running', status: 'in_progress' })
      expect(task.status).toBe('in_progress')
      expect(task.startedAt).toBeDefined()
      expect(task.startedAt).toBeLessThanOrEqual(Date.now())
    })

    it('should create a task with all fields', () => {
      const task = taskManager.create({
        subject: 'Refactor module',
        description: 'Full refactor of the auth module',
        activeForm: 'Refactoring module',
        source: 'agent',
        owner: 'Explore',
        agentId: 'agent-123',
        conversationId: 'conv-456',
        parentTaskId: 'task-parent',
        summary: '正在重构认证模块',
        runtimeKind: 'agent',
        addBlockedBy: ['task-other'],
        metadata: { priority: 'high' },
      })

      expect(task.source).toBe('agent')
      expect(task.owner).toBe('Explore')
      expect(task.agentId).toBe('agent-123')
      expect(task.conversationId).toBe('conv-456')
      expect(task.parentTaskId).toBe('task-parent')
      expect(task.summary).toBe('正在重构认证模块')
      expect(task.runtimeKind).toBe('agent')
      expect(task.blockedBy).toEqual(['task-other'])
      expect(task.metadata).toEqual({ priority: 'high' })
    })

    it('should generate unique IDs', () => {
      const t1 = taskManager.create({ subject: 'Task 1' })
      const t2 = taskManager.create({ subject: 'Task 2' })
      expect(t1.taskId).not.toBe(t2.taskId)
    })
  })

  describe('update', () => {
    it('should update task fields', () => {
      const task = taskManager.create({ subject: 'Original' })
      const result = taskManager.update(task.taskId, {
        subject: 'Updated',
        description: 'New description',
      })
      expect(result.task?.subject).toBe('Updated')
      expect(result.task?.description).toBe('New description')
      expect(result.updatedFields).toContain('subject')
      expect(result.updatedFields).toContain('description')
    })

    it('should track status changes', () => {
      const task = taskManager.create({ subject: 'Test' })
      const result = taskManager.update(task.taskId, { status: 'in_progress' })
      expect(result.statusChange).toEqual({ from: 'pending', to: 'in_progress' })
      expect(result.task?.startedAt).toBeGreaterThan(0)
    })

    it('should set finishedAt on terminal status', () => {
      const task = taskManager.create({ subject: 'Test' })
      taskManager.update(task.taskId, { status: 'in_progress' })
      const result = taskManager.update(task.taskId, { status: 'completed' })
      expect(result.task?.finishedAt).toBeGreaterThan(0)
    })

    it('should delete task when status is deleted', () => {
      const task = taskManager.create({ subject: 'Delete me' })
      const result = taskManager.update(task.taskId, { status: 'deleted' })
      expect(result.task).toBeNull()
      expect(taskManager.getTask(task.taskId)).toBeUndefined()
    })

    it('should return null for non-existent task', () => {
      const result = taskManager.update('nonexistent', { subject: 'X' })
      expect(result.task).toBeNull()
      expect(result.updatedFields).toEqual([])
    })

    it('should merge metadata', () => {
      const task = taskManager.create({ subject: 'Test', metadata: { a: 1 } })
      taskManager.update(task.taskId, { metadata: { b: 2 } })
      const updated = taskManager.getTask(task.taskId)
      expect(updated?.metadata).toEqual({ a: 1, b: 2 })
    })
  })

  describe('lifecycle', () => {
    it('should start a task', () => {
      const task = taskManager.create({ subject: 'Run it' })
      const started = taskManager.start(task.taskId, 'bash')
      expect(started?.status).toBe('in_progress')
      expect(started?.runtimeKind).toBe('bash')
      expect(started?.startedAt).toBeGreaterThan(0)
    })

    // Audit fix R8 (2026-05) — `start()` is now strict: unknown id is
    // refused (returns null) with a console.warn, and no phantom row is
    // created. Callers wanting the legacy auto-create must call
    // `ensureTask()` first.
    it('refuses unknown id on start: returns null, no phantom row, warns', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const started = taskManager.start('unknown-id', 'agent')
        expect(started).toBeNull()
        expect(taskManager.getTask('unknown-id')).toBeUndefined()
        expect(warnSpy).toHaveBeenCalledOnce()
        expect(warnSpy.mock.calls[0]![0]).toMatch(/unknown task id/i)
      } finally {
        warnSpy.mockRestore()
      }
    })

    it('ensureTask creates a pending placeholder when id is unknown', () => {
      const t = taskManager.ensureTask('placeholder-1', {
        subject: 'background scaffold',
        runtimeKind: 'agent',
        source: 'plan',
      })
      expect(t.status).toBe('pending')
      expect(t.subject).toBe('background scaffold')
      expect(t.runtimeKind).toBe('agent')
      expect(t.source).toBe('plan')
      // Idempotent — second call returns the same row, no duplicate created event.
      const events: string[] = []
      taskManager.subscribe((e) => events.push(e.type))
      const again = taskManager.ensureTask('placeholder-1')
      expect(again).toBe(t)
      expect(events).not.toContain('created')
    })

    it('start + ensureTask: legacy auto-create flow via the explicit two-call sequence', () => {
      taskManager.ensureTask('worker-7', { subject: 'compose job' })
      const started = taskManager.start('worker-7', 'bash')
      expect(started?.status).toBe('in_progress')
      expect(started?.runtimeKind).toBe('bash')
    })

    it('should mark completed with summary', () => {
      const task = taskManager.create({ subject: 'Complete me' })
      taskManager.start(task.taskId, 'agent')
      taskManager.markCompleted(task.taskId, { summary: 'Done!' })
      const completed = taskManager.getTask(task.taskId)
      expect(completed?.status).toBe('completed')
      expect(completed?.summary).toBe('Done!')
      expect(completed?.finishedAt).toBeGreaterThan(0)
    })

    it('should mark failed with error', () => {
      const task = taskManager.create({ subject: 'Fail me' })
      taskManager.start(task.taskId, 'bash')
      taskManager.markFailed(task.taskId, 'Something went wrong')
      const failed = taskManager.getTask(task.taskId)
      expect(failed?.status).toBe('failed')
      expect(failed?.error).toBe('Something went wrong')
    })

    it('should stop a running task', async () => {
      const task = taskManager.create({ subject: 'Stop me' })
      taskManager.start(task.taskId, 'bash')
      const stopped = await taskManager.stop(task.taskId)
      expect(stopped).toBe(true)
      expect(taskManager.getTask(task.taskId)?.status).toBe('cancelled')
    })

    it('should cancel a pending task (TaskUpdate default before start)', async () => {
      const task = taskManager.create({ subject: 'Pending cancel' })
      expect(task.status).toBe('pending')
      const stopped = await taskManager.stop(task.taskId)
      expect(stopped).toBe(true)
      expect(taskManager.getTask(task.taskId)?.status).toBe('cancelled')
    })

    it('should call stop handler', async () => {
      const task = taskManager.create({ subject: 'With handler' })
      taskManager.start(task.taskId, 'agent')
      const handler = vi.fn()
      taskManager.setStopHandler(task.taskId, handler)
      await taskManager.stop(task.taskId)
      expect(handler).toHaveBeenCalledOnce()
    })
  })

  describe('output', () => {
    it('should append output chunks', () => {
      const task = taskManager.create({ subject: 'Output test' })
      taskManager.appendOutput(task.taskId, 'stdout', 'Hello ')
      taskManager.appendOutput(task.taskId, 'stdout', 'World')
      const t = taskManager.getTask(task.taskId)
      expect(t?.outputChunks).toHaveLength(2)
      expect(t?.outputCursor).toBe(2)
    })

    it('should paginate output', () => {
      const task = taskManager.create({ subject: 'Paginate test' })
      for (let i = 0; i < 10; i++) {
        taskManager.appendOutput(task.taskId, 'stdout', `Line ${i}\n`)
      }
      const slice = taskManager.getOutputSlice(task.taskId, 0, 3)
      expect(slice?.items).toHaveLength(3)
      expect(slice?.hasMore).toBe(true)
      expect(slice?.nextOffset).toBe(3)

      const slice2 = taskManager.getOutputSlice(task.taskId, 8, 5)
      expect(slice2?.items).toHaveLength(2)
      expect(slice2?.hasMore).toBe(false)
    })

    // Audit fix R8 (2026-05) — `appendOutput()` is now strict: unknown
    // id drops the output and warns. Phantom rows no longer leak from
    // typo'd ids.
    it('refuses unknown id on appendOutput: drops chunk, no phantom row, warns', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        taskManager.appendOutput('unknown-output-id', 'text', 'data')
        expect(taskManager.getTask('unknown-output-id')).toBeUndefined()
        expect(warnSpy).toHaveBeenCalledOnce()
        expect(warnSpy.mock.calls[0]![0]).toMatch(/unknown task id/i)
      } finally {
        warnSpy.mockRestore()
      }
    })

    it('ensureTask + appendOutput: explicit create-then-append flow works', () => {
      taskManager.ensureTask('explicit-id')
      taskManager.appendOutput('explicit-id', 'stdout', 'hello')
      const task = taskManager.getTask('explicit-id')
      expect(task).toBeTruthy()
      expect(task?.outputChunks).toHaveLength(1)
      expect(task?.outputChunks[0]?.text).toBe('hello')
    })
  })

  describe('queries', () => {
    it('should find by status', () => {
      taskManager.create({ subject: 'A' })
      const b = taskManager.create({ subject: 'B' })
      taskManager.update(b.taskId, { status: 'in_progress' })

      expect(taskManager.findByStatus('pending')).toHaveLength(1)
      expect(taskManager.findByStatus('in_progress')).toHaveLength(1)
    })

    it('should find by conversation', () => {
      taskManager.create({ subject: 'A', conversationId: 'conv-1' })
      taskManager.create({ subject: 'B', conversationId: 'conv-2' })
      taskManager.create({ subject: 'C', conversationId: 'conv-1' })

      expect(taskManager.findByConversation('conv-1')).toHaveLength(2)
      expect(taskManager.findByConversation('conv-2')).toHaveLength(1)
    })

    it('should find by agent', () => {
      taskManager.create({ subject: 'A', agentId: 'agent-1' })
      taskManager.create({ subject: 'B', agentId: 'agent-2' })

      expect(taskManager.findByAgent('agent-1')).toHaveLength(1)
    })

    it('should find children', () => {
      const parent = taskManager.create({ subject: 'Parent' })
      taskManager.create({ subject: 'Child 1', parentTaskId: parent.taskId })
      taskManager.create({ subject: 'Child 2', parentTaskId: parent.taskId })
      taskManager.create({ subject: 'Other' })

      expect(taskManager.findChildren(parent.taskId)).toHaveLength(2)
    })
  })

  describe('events', () => {
    it('should emit created event', () => {
      const events: string[] = []
      taskManager.subscribe((e) => events.push(e.type))
      taskManager.create({ subject: 'Test' })
      expect(events).toContain('created')
    })

    it('should emit output event on appendOutput', () => {
      const task = taskManager.create({ subject: 'Test' })
      const events: string[] = []
      taskManager.subscribe((e) => events.push(e.type))
      taskManager.appendOutput(task.taskId, 'stdout', 'data')
      expect(events).toContain('output')
    })

    it('should allow unsubscribe', () => {
      const events: string[] = []
      const unsub = taskManager.subscribe((e) => events.push(e.type))
      taskManager.create({ subject: 'A' })
      unsub()
      taskManager.create({ subject: 'B' })
      expect(events).toHaveLength(1)
    })
  })

  describe('clear', () => {
    it('should remove all tasks', () => {
      taskManager.create({ subject: 'A' })
      taskManager.create({ subject: 'B' })
      taskManager.clear()
      expect(taskManager.listTasks()).toHaveLength(0)
    })

    it('should clear by conversation', () => {
      taskManager.create({ subject: 'A', conversationId: 'c1' })
      taskManager.create({ subject: 'B', conversationId: 'c2' })
      taskManager.clearConversation('c1')
      expect(taskManager.listTasks()).toHaveLength(1)
      expect(taskManager.listTasks()[0].conversationId).toBe('c2')
    })
  })

  describe('addBlocks', () => {
    it('pushes new task id onto blockedBy of each listed task', () => {
      const a = taskManager.create({ subject: 'A' })
      const b = taskManager.create({ subject: 'B' })
      const c = taskManager.create({ subject: 'C', addBlocks: [a.taskId, b.taskId] })
      expect(taskManager.getTask(a.taskId)!.blockedBy).toContain(c.taskId)
      expect(taskManager.getTask(b.taskId)!.blockedBy).toContain(c.taskId)
    })

    it('update addBlocks links existing task to others', () => {
      const a = taskManager.create({ subject: 'A' })
      const b = taskManager.create({ subject: 'B' })
      const c = taskManager.create({ subject: 'C' })
      taskManager.update(c.taskId, { addBlocks: [a.taskId] })
      expect(taskManager.getTask(a.taskId)!.blockedBy).toContain(c.taskId)
      expect(taskManager.getTask(b.taskId)!.blockedBy).toHaveLength(0)
    })
  })
})
