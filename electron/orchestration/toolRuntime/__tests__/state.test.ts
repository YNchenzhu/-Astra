/**
 * Unit tests for ToolRuntimeState — global visibility into tool invocations.
 *
 * Run: npx vitest run electron/orchestration/__tests__/toolRuntimeState.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  registerToolInvocation,
  markToolPreparing,
  markToolRunning,
  markToolPaused,
  markToolResumed,
  markToolCompleted,
  markToolFailed,
  markRunningToolsPausedForConversation,
  markPausedToolsResumedForConversation,
  recordToolResourceDelta,
  getToolEntry,
  getToolsByAgent,
  getToolsByStatus,
  getActiveToolsForAgent,
  getToolRuntimeSnapshot,
  agentHasRunningTools,
  abortAllToolsForAgent,
  abortToolsInTree,
  clearToolRuntimeStateForTests,
  preemptTool,
  getToolPreemptSignal,
} from '../state'

describe('ToolRuntimeState', () => {
  beforeEach(() => {
    clearToolRuntimeStateForTests()
  })

  afterEach(() => {
    clearToolRuntimeStateForTests()
  })

  it('should register a tool invocation with default values', () => {
    const entry = registerToolInvocation({
      toolUseId: 'tu_1',
      toolName: 'read_file',
      agentId: 'agent-main',
      input: { filePath: 'foo.ts' },
    })

    expect(entry.toolUseId).toBe('tu_1')
    expect(entry.toolName).toBe('read_file')
    expect(entry.agentId).toBe('agent-main')
    expect(entry.status).toBe('queued')
    expect(entry.priority).toBe(0)
    expect(entry.preemptible).toBe(false)
    expect(entry.generation).toBe(1)
  })

  it('rejects duplicate active ids but permits a new generation after terminal', () => {
    const first = registerToolInvocation({
      toolUseId: 'tu_reused',
      toolName: 'read_file',
      agentId: 'agent-A',
      input: {},
    })
    const firstSignal = first.preemptController?.signal
    expect(() =>
      registerToolInvocation({
        toolUseId: 'tu_reused',
        toolName: 'read_file',
        agentId: 'agent-B',
        input: {},
      }),
    ).toThrow(/duplicate_active_tool_use_id/)
    expect(getToolEntry('tu_reused')?.preemptController?.signal).toBe(firstSignal)

    markToolCompleted('tu_reused')
    const second = registerToolInvocation({
      toolUseId: 'tu_reused',
      toolName: 'read_file',
      agentId: 'agent-B',
      input: {},
    })
    expect(second.generation).toBe(2)
    expect(second.preemptController?.signal).not.toBe(firstSignal)
  })

  it('should track lifecycle transitions', () => {
    registerToolInvocation({
      toolUseId: 'tu_1',
      toolName: 'bash',
      agentId: 'agent-A',
      input: { command: 'echo hi' },
    })

    markToolPreparing('tu_1')
    expect(getToolEntry('tu_1')!.status).toBe('preparing')

    markToolRunning('tu_1')
    expect(getToolEntry('tu_1')!.status).toBe('running')
    expect(getToolEntry('tu_1')!.startedAt).toBeTypeOf('number')

    markToolPaused('tu_1')
    expect(getToolEntry('tu_1')!.status).toBe('paused')

    markToolResumed('tu_1')
    expect(getToolEntry('tu_1')!.status).toBe('running')

    markToolCompleted('tu_1', { input: 100, output: 50 })
    expect(getToolEntry('tu_1')!.status).toBe('completed')
    expect(getToolEntry('tu_1')!.resources.tokensUsed).toBe(150)
  })

  it('should record resource deltas cumulatively', () => {
    registerToolInvocation({
      toolUseId: 'tu_1',
      toolName: 'write_file',
      agentId: 'agent-A',
      input: { filePath: 'out.txt', content: 'hello' },
    })

    recordToolResourceDelta('tu_1', { tokensUsed: 100, diskWriteBytes: 1024 })
    recordToolResourceDelta('tu_1', { tokensUsed: 50, networkBytes: 2048 })

    const entry = getToolEntry('tu_1')!
    expect(entry.resources.tokensUsed).toBe(150)
    expect(entry.resources.diskWriteBytes).toBe(1024)
    expect(entry.resources.networkBytes).toBe(2048)
  })

  it('should filter by agent and status', () => {
    registerToolInvocation({ toolUseId: 'tu_1', toolName: 'read_file', agentId: 'agent-A', input: {} })
    registerToolInvocation({ toolUseId: 'tu_2', toolName: 'bash', agentId: 'agent-B', input: {} })
    registerToolInvocation({ toolUseId: 'tu_3', toolName: 'grep', agentId: 'agent-A', input: {} })

    markToolRunning('tu_1')
    markToolRunning('tu_2')

    expect(getToolsByAgent('agent-A')).toHaveLength(2)
    expect(getToolsByAgent('agent-B')).toHaveLength(1)
    expect(getToolsByStatus('running')).toHaveLength(2)
    expect(getActiveToolsForAgent('agent-A')).toHaveLength(2)
  })

  it('should detect running tools per agent', () => {
    registerToolInvocation({ toolUseId: 'tu_1', toolName: 'bash', agentId: 'agent-A', input: {} })
    expect(agentHasRunningTools('agent-A')).toBe(false)

    markToolRunning('tu_1')
    expect(agentHasRunningTools('agent-A')).toBe(true)
  })

  it('should produce a snapshot summary', () => {
    registerToolInvocation({ toolUseId: 'tu_1', toolName: 'read_file', agentId: 'agent-A', input: {} })
    registerToolInvocation({ toolUseId: 'tu_2', toolName: 'bash', agentId: 'agent-A', input: {} })
    registerToolInvocation({ toolUseId: 'tu_3', toolName: 'grep', agentId: 'agent-B', input: {} })

    markToolRunning('tu_1')
    markToolFailed('tu_2', 'exit 1')
    markToolCompleted('tu_3')

    const snap = getToolRuntimeSnapshot()
    expect(snap.summary.totalRunning).toBe(1)
    expect(snap.summary.totalFailed).toBe(1)
    expect(snap.summary.totalCompleted).toBe(1)
  })

  it('should abort all tools for an agent', () => {
    registerToolInvocation({ toolUseId: 'tu_1', toolName: 'bash', agentId: 'agent-A', input: {} })
    registerToolInvocation({ toolUseId: 'tu_2', toolName: 'read_file', agentId: 'agent-A', input: {} })
    registerToolInvocation({ toolUseId: 'tu_3', toolName: 'bash', agentId: 'agent-B', input: {} })

    markToolRunning('tu_1')
    markToolRunning('tu_2')
    markToolRunning('tu_3')

    const count = abortAllToolsForAgent('agent-A', 'test_cleanup')
    expect(count).toBe(2)
    expect(getToolEntry('tu_1')!.status).toBe('aborted')
    expect(getToolEntry('tu_2')!.status).toBe('aborted')
    expect(getToolEntry('tu_3')!.status).toBe('running')
  })

  it('should abort tools in a parent tree', () => {
    registerToolInvocation({ toolUseId: 'tu_1', toolName: 'bash', agentId: 'parent', input: {} })
    registerToolInvocation({ toolUseId: 'tu_2', toolName: 'read_file', agentId: 'child', parentAgentId: 'parent', input: {} })
    registerToolInvocation({ toolUseId: 'tu_3', toolName: 'grep', agentId: 'orphan', input: {} })

    markToolRunning('tu_1')
    markToolRunning('tu_2')
    markToolRunning('tu_3')

    abortToolsInTree('parent', 'parent_stopped')
    expect(getToolEntry('tu_1')!.status).toBe('aborted')
    expect(getToolEntry('tu_2')!.status).toBe('aborted')
    expect(getToolEntry('tu_3')!.status).toBe('running')
  })

  // ── P2-6 (2026-06) — tree/agent aborts fire the per-tool cancel lane ──
  it('abortAllToolsForAgent fires each tool\'s preempt signal so in-flight work unwinds (P2-6 fix)', () => {
    registerToolInvocation({ toolUseId: 'tu_a1', toolName: 'bash', agentId: 'agent-A', input: {} })
    registerToolInvocation({ toolUseId: 'tu_a2', toolName: 'web_fetch', agentId: 'agent-A', input: {} })
    registerToolInvocation({ toolUseId: 'tu_other', toolName: 'bash', agentId: 'agent-B', input: {} })
    markToolRunning('tu_a1')
    markToolRunning('tu_a2')
    markToolRunning('tu_other')

    abortAllToolsForAgent('agent-A', 'agent_unregistered')

    // Pre-fix only the registry status flipped; the per-tool AbortController
    // stayed un-fired so the real shell child / network request kept running.
    expect(getToolPreemptSignal('tu_a1')!.aborted).toBe(true)
    expect(getToolPreemptSignal('tu_a2')!.aborted).toBe(true)
    expect(getToolPreemptSignal('tu_other')!.aborted).toBe(false)
    expect(getToolEntry('tu_other')!.status).toBe('running')
  })

  it('abortToolsInTree fires preempt signals transitively (P2-6 fix)', () => {
    registerToolInvocation({ toolUseId: 'tu_p', toolName: 'bash', agentId: 'parent', input: {} })
    registerToolInvocation({
      toolUseId: 'tu_c',
      toolName: 'bash',
      agentId: 'child',
      parentAgentId: 'parent',
      input: {},
    })
    registerToolInvocation({ toolUseId: 'tu_out', toolName: 'bash', agentId: 'stranger', input: {} })
    markToolRunning('tu_p')
    markToolRunning('tu_c')
    markToolRunning('tu_out')

    abortToolsInTree('parent', 'tree_interrupt:user')

    expect(getToolPreemptSignal('tu_p')!.aborted).toBe(true)
    expect(getToolPreemptSignal('tu_c')!.aborted).toBe(true)
    expect(getToolPreemptSignal('tu_out')!.aborted).toBe(false)
  })

  // ── Audit P0 §4.5 — abortToolsInTree truly recursive ──
  it('aborts grandchildren in a 3-level agent tree (audit P0 §4.5)', () => {
    // Tree: main → coordinator → explore → grep
    // Each level owns a tool; abortToolsInTree('main') must reach all 4.
    registerToolInvocation({ toolUseId: 'tu_main', toolName: 'bash', agentId: 'main', input: {} })
    registerToolInvocation({
      toolUseId: 'tu_coord',
      toolName: 'bash',
      agentId: 'coordinator',
      parentAgentId: 'main',
      input: {},
    })
    registerToolInvocation({
      toolUseId: 'tu_explore',
      toolName: 'grep',
      agentId: 'explore',
      parentAgentId: 'coordinator',
      input: {},
    })
    registerToolInvocation({
      toolUseId: 'tu_deep',
      toolName: 'read_file',
      agentId: 'grep',
      parentAgentId: 'explore',
      input: {},
    })
    // Sibling subtree under main, should also be aborted.
    registerToolInvocation({
      toolUseId: 'tu_sibling',
      toolName: 'bash',
      agentId: 'plan',
      parentAgentId: 'main',
      input: {},
    })
    // Unrelated agent — must NOT be aborted.
    registerToolInvocation({
      toolUseId: 'tu_unrelated',
      toolName: 'bash',
      agentId: 'unrelated',
      input: {},
    })
    for (const id of ['tu_main', 'tu_coord', 'tu_explore', 'tu_deep', 'tu_sibling', 'tu_unrelated']) {
      markToolRunning(id)
    }

    const count = abortToolsInTree('main', 'tree_cancel')

    // 5 in the tree (main, coordinator, explore, grep, plan) — unrelated stays.
    expect(count).toBe(5)
    expect(getToolEntry('tu_main')!.status).toBe('aborted')
    expect(getToolEntry('tu_coord')!.status).toBe('aborted')
    expect(getToolEntry('tu_explore')!.status).toBe('aborted')
    expect(getToolEntry('tu_deep')!.status).toBe('aborted') // 3 levels deep
    expect(getToolEntry('tu_sibling')!.status).toBe('aborted')
    expect(getToolEntry('tu_unrelated')!.status).toBe('running')
  })

  // ── P1 §5.2 — preempt actually fires victim's signal ──
  describe('preemptTool (audit P1 §5.2)', () => {
    it('fires the per-tool preemptController when called', () => {
      registerToolInvocation({
        toolUseId: 'tu_victim',
        toolName: 'bash',
        agentId: 'main',
        input: {},
      })
      markToolRunning('tu_victim')

      const sig = getToolPreemptSignal('tu_victim')
      expect(sig).toBeDefined()
      expect(sig!.aborted).toBe(false)

      const fired = preemptTool('tu_victim', 'preempted by HIGH-priority newcomer')

      expect(fired).toBe(true)
      expect(sig!.aborted).toBe(true)
      expect(getToolEntry('tu_victim')!.status).toBe('aborted')
      expect(getToolEntry('tu_victim')!.errorMessage).toContain('HIGH-priority newcomer')
    })

    it('returns false for unknown toolUseId (idempotent on no-op)', () => {
      expect(preemptTool('tu_does_not_exist', 'whatever')).toBe(false)
    })

    it('returns false when the tool is already terminal (no double-fire)', () => {
      registerToolInvocation({
        toolUseId: 'tu_done',
        toolName: 'bash',
        agentId: 'main',
        input: {},
      })
      markToolRunning('tu_done')
      markToolCompleted('tu_done')

      // Already 'completed' — preempt is a no-op.
      expect(preemptTool('tu_done', 'too late')).toBe(false)
      // Underlying signal must NOT be aborted retroactively.
      expect(getToolPreemptSignal('tu_done')!.aborted).toBe(false)
    })

    it('exposes the preempt signal so callers can merge it with their batch signal', () => {
      registerToolInvocation({
        toolUseId: 'tu_a',
        toolName: 'bash',
        agentId: 'main',
        input: {},
      })
      const sig = getToolPreemptSignal('tu_a')
      expect(sig).toBeInstanceOf(AbortSignal)

      let observed = false
      sig!.addEventListener('abort', () => {
        observed = true
      }, { once: true })
      preemptTool('tu_a', 'preempted')
      expect(observed).toBe(true)
    })
  })

  // ── §3.2 wire-up — pause/resume per conversation ──
  describe('markRunning/PausedToolsForConversation (audit §3.2)', () => {
    it('flips only running tools owned by the given conversation to paused', () => {
      registerToolInvocation({
        toolUseId: 'tu_a',
        toolName: 'bash',
        agentId: 'main',
        conversationId: 'conv-A',
        input: {},
      })
      registerToolInvocation({
        toolUseId: 'tu_b',
        toolName: 'bash',
        agentId: 'main',
        conversationId: 'conv-A',
        input: {},
      })
      registerToolInvocation({
        toolUseId: 'tu_c',
        toolName: 'bash',
        agentId: 'main',
        conversationId: 'conv-B',
        input: {},
      })
      markToolRunning('tu_a')
      markToolRunning('tu_b')
      // tu_b transitions to completed before pause — should NOT be touched.
      markToolCompleted('tu_b')
      markToolRunning('tu_c')

      const flipped = markRunningToolsPausedForConversation('conv-A')

      expect(flipped).toBe(1) // only tu_a (tu_b is terminal, tu_c is other conv)
      expect(getToolEntry('tu_a')!.status).toBe('paused')
      expect(getToolEntry('tu_b')!.status).toBe('completed')
      expect(getToolEntry('tu_c')!.status).toBe('running')
    })

    it('resume flips paused-back-to-running only for matching conversation', () => {
      registerToolInvocation({
        toolUseId: 'tu_a',
        toolName: 'bash',
        agentId: 'main',
        conversationId: 'conv-A',
        input: {},
      })
      markToolRunning('tu_a')
      markToolPaused('tu_a')

      const flipped = markPausedToolsResumedForConversation('conv-A')
      expect(flipped).toBe(1)
      expect(getToolEntry('tu_a')!.status).toBe('running')
    })

    it('handles empty conversation id gracefully', () => {
      expect(markRunningToolsPausedForConversation('')).toBe(0)
      expect(markPausedToolsResumedForConversation('   ')).toBe(0)
    })
  })
})
