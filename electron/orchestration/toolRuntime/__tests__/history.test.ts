/**
 * Unit tests for GlobalToolCallHistory — cross-agent deduplication.
 *
 * Run: npx vitest run electron/orchestration/__tests__/globalToolCallHistory.test.ts
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  getGlobalToolCallHistory,
  resetGlobalToolCallHistoryForTests,
} from '../history'
import {
  DROPPED_TOOL_ARGS_ERROR_MARKER,
  formatZodToolInputError,
  writeFileInputZod,
} from '../../../tools/toolInputZod'
import { parseToolArgumentsWithMeta } from '../../../ai/transformer/parseToolArguments'

describe('GlobalToolCallHistory', () => {
  beforeEach(() => {
    resetGlobalToolCallHistoryForTests()
  })

  it('should allow a never-seen tool call', () => {
    const history = getGlobalToolCallHistory()
    const advice = history.check('bash', { command: 'echo hello' })
    expect(advice.level).toBe('allow')
  })

  it('should hint after the first failure', () => {
    const history = getGlobalToolCallHistory({ hintThreshold: 0, blockThreshold: 2 })
    history.record('bash', { command: 'exit 1' }, { success: false, errorSummary: 'exit 1' })

    const advice = history.check('bash', { command: 'exit 1' })
    expect(advice.level).toBe('hint')
    expect(advice.previousFailures).toBe(1)
  })

  it('should block after repeated failures', () => {
    const history = getGlobalToolCallHistory({ hintThreshold: 0, blockThreshold: 1 })
    history.record('bash', { command: 'exit 1' }, { success: false, errorSummary: 'exit 1' })
    history.record('bash', { command: 'exit 1' }, { success: false, errorSummary: 'exit 1' })

    const advice = history.check('bash', { command: 'exit 1' })
    expect(advice.level).toBe('block')
    expect(advice.previousFailures).toBeGreaterThanOrEqual(2)
  })

  it('fingerprints nested input faithfully — different nested values are different calls (2026-06 fix)', () => {
    // Pre-fix, `JSON.stringify(input, Object.keys(input).sort())` used a
    // replacer ARRAY which filters keys at EVERY level — nested objects
    // collapsed to `{}` so all `multi_edit_file` calls on the same file
    // shared one fingerprint and two unrelated failures blocked a third,
    // materially different call.
    const history = getGlobalToolCallHistory({ hintThreshold: 0, blockThreshold: 2 })
    const failingEdits = {
      file_path: 'a.ts',
      edits: [{ old_string: 'x', new_string: 'y' }],
    }
    history.record('multi_edit_file', failingEdits, { success: false, errorSummary: 'no match' })
    history.record('multi_edit_file', failingEdits, { success: false, errorSummary: 'no match' })

    // Identical call → still blocked.
    expect(history.check('multi_edit_file', failingEdits).level).toBe('block')

    // Same top-level keys, different nested edits → different fingerprint → allowed.
    const differentEdits = {
      file_path: 'a.ts',
      edits: [{ old_string: 'p', new_string: 'q' }],
    }
    expect(history.check('multi_edit_file', differentEdits).level).toBe('allow')
  })

  it('fingerprint is key-order insensitive at every nesting level', () => {
    const history = getGlobalToolCallHistory({ hintThreshold: 0, blockThreshold: 1 })
    history.record('t', { a: { x: 1, y: 2 }, b: 1 }, { success: false, errorSummary: 'e' })
    // Re-ordered keys (top level AND nested) must hit the same entry.
    expect(history.check('t', { b: 1, a: { y: 2, x: 1 } }).level).toBe('block')
  })

  it('a success resets the consecutive-failure streak (2026-06 fix)', () => {
    // Pre-fix the block counted TOTAL failures within the TTL, so
    // "fail ×2 → fix environment → succeed" still blocked the next call.
    const history = getGlobalToolCallHistory({ hintThreshold: 1, blockThreshold: 2 })
    const input = { command: 'npm test' }
    history.record('bash', input, { success: false, errorSummary: 'exit 1' })
    history.record('bash', input, { success: false, errorSummary: 'exit 1' })
    expect(history.check('bash', input).level).toBe('block')

    history.record('bash', input, { success: true })
    expect(history.check('bash', input).level).toBe('allow')
  })

  it('does NOT count empty/truncated-argument validation failures toward the block', () => {
    // Repro: DeepSeek (Anthropic-compat) emits `write_file` with an empty
    // argument stream → Zod rejects with the dropped-args headline. These
    // are transport glitches, not "this call is broken", so they must not
    // accumulate into a [Cross-agent block] that dead-ends the turn.
    const history = getGlobalToolCallHistory({ hintThreshold: 0, blockThreshold: 1 })
    const r = writeFileInputZod.safeParse({})
    if (r.success) throw new Error('expected empty write_file input to fail validation')
    const droppedArgsError = formatZodToolInputError('write_file', r.error, {}, writeFileInputZod)
    expect(droppedArgsError).toContain(DROPPED_TOOL_ARGS_ERROR_MARKER)

    // Two identical empty calls would normally block at blockThreshold=1.
    history.record('write_file', {}, { success: false, errorSummary: droppedArgsError })
    history.record('write_file', {}, { success: false, errorSummary: droppedArgsError })

    expect(history.check('write_file', {}).level).toBe('allow')
  })

  it('does NOT count max_tokens-truncation write failures toward the block (end-to-end)', () => {
    // Simulate the streaming layer: a write_file whose content was truncated
    // mid-stream gets tagged, the schema refuses it, and that failure must be
    // excluded from the cross-agent block.
    const history = getGlobalToolCallHistory({ hintThreshold: 0, blockThreshold: 1 })
    const truncatedArgs = '{"filePath":"big.ts","content":"line1\\nline2\\nstill writing when cut'
    const { value, meta } = parseToolArgumentsWithMeta(truncatedArgs)
    expect(meta.truncationRepaired).toBe(true)
    const input = { ...value, __argsTruncatedByMaxTokens: true }
    const r = writeFileInputZod.safeParse(input)
    if (r.success) throw new Error('expected truncated write_file input to fail validation')
    const truncErr = formatZodToolInputError('write_file', r.error, input, writeFileInputZod)

    history.record('write_file', input, { success: false, errorSummary: truncErr })
    history.record('write_file', input, { success: false, errorSummary: truncErr })

    expect(history.check('write_file', input).level).toBe('allow')
  })

  it('still blocks a genuine repeated validation failure that is NOT a dropped-args glitch', () => {
    // Control: a normal validation failure (wrong value, not missing/empty)
    // keeps its cross-agent predictive value and still blocks.
    const history = getGlobalToolCallHistory({ hintThreshold: 0, blockThreshold: 1 })
    const err = 'InputValidationError (bash): command: invalid value'
    history.record('bash', { command: 'broken' }, { success: false, errorSummary: err })
    history.record('bash', { command: 'broken' }, { success: false, errorSummary: err })

    expect(history.check('bash', { command: 'broken' }).level).toBe('block')
  })

  it('should treat different inputs as distinct fingerprints', () => {
    const history = getGlobalToolCallHistory({ hintThreshold: 0, blockThreshold: 1 })
    history.record('bash', { command: 'exit 1' }, { success: false })

    const advice = history.check('bash', { command: 'echo ok' })
    expect(advice.level).toBe('allow')
  })

  it('should forget stale entries after TTL', async () => {
    // Self-audit fix (2026-05): this test used to record a failure,
    // assert it hinted, then comment "After TTL eviction happens" and
    // assert nothing — a textbook false-green. Now we actually advance
    // fake time past the TTL and assert that the level returns to
    // `allow`, so a real eviction-logic regression would catch fire.
    vi.useFakeTimers()
    try {
      const history = getGlobalToolCallHistory({
        ttlMs: 50,
        hintThreshold: 1,
        blockThreshold: 2,
      })
      history.record('bash', { command: 'exit 1' }, { success: false })

      // Immediately should hint (1 failure, hintThreshold=1, blockThreshold=2).
      expect(history.check('bash', { command: 'exit 1' }).level).toBe('hint')

      // Advance past TTL — both the entry's own outcome cutoff (`now -
      // ttlMs`) and the lastTouched-based eviction in `evictStale`
      // should classify this entry as stale. The next `check()` runs
      // `evictStale` which deletes the entry; result level → `allow`.
      vi.advanceTimersByTime(60)
      expect(history.check('bash', { command: 'exit 1' }).level).toBe('allow')
    } finally {
      vi.useRealTimers()
    }
  })

  it('should invalidate a specific fingerprint', () => {
    const history = getGlobalToolCallHistory({ hintThreshold: 0, blockThreshold: 1 })
    history.record('bash', { command: 'exit 1' }, { success: false })
    history.invalidate('bash', { command: 'exit 1' })

    expect(history.check('bash', { command: 'exit 1' }).level).toBe('allow')
  })

  it('should invalidate all entries for a tool name', () => {
    const history = getGlobalToolCallHistory({ hintThreshold: 0, blockThreshold: 1 })
    history.record('bash', { command: 'exit 1' }, { success: false })
    history.record('bash', { command: 'exit 2' }, { success: false })
    history.invalidateTool('bash')

    expect(history.check('bash', { command: 'exit 1' }).level).toBe('allow')
    expect(history.check('bash', { command: 'exit 2' }).level).toBe('allow')
  })

  it('should cap max entries and evict oldest', () => {
    const history = getGlobalToolCallHistory({ maxEntries: 2 })
    history.record('bash', { command: 'a' }, { success: true })
    history.record('bash', { command: 'b' }, { success: true })
    history.record('bash', { command: 'c' }, { success: true })

    // 'a' should have been evicted
    expect(history.getOutcomes('bash', { command: 'a' })).toHaveLength(0)
    expect(history.getOutcomes('bash', { command: 'c' })).toHaveLength(1)
  })

  // F3 follow-up — Chunk 5b cross-agent guarantee: history is fingerprint-keyed
  // (toolName + sorted-JSON input) and agnostic of which agent recorded the outcome.
  // Agent B's check sees Agent A's failures.
  describe('Chunk 5b — cross-agent fingerprint sharing', () => {
    it("agent A's repeated failures block agent B's same call", () => {
      const history = getGlobalToolCallHistory({ hintThreshold: 0, blockThreshold: 2 })
      // Agent A records 2 failures with the same fingerprint.
      history.record(
        'bash',
        { command: 'npm install' },
        { success: false, errorSummary: 'EACCES', agentId: 'agent-A' },
      )
      history.record(
        'bash',
        { command: 'npm install' },
        { success: false, errorSummary: 'EACCES', agentId: 'agent-A' },
      )
      // Agent B (different) tries the same call → should be blocked
      // because fingerprint is shared, agent id is metadata only.
      const advice = history.check('bash', { command: 'npm install' })
      expect(advice.level).toBe('block')
      if (advice.level === 'block') {
        expect(advice.message).toMatch(/agent-A/)
      }
    })

    it('different key order in input still matches same fingerprint (sorted JSON)', () => {
      const history = getGlobalToolCallHistory({ hintThreshold: 0, blockThreshold: 1 })
      history.record(
        'bash',
        { command: 'ls', cwd: '/tmp' },
        { success: false, agentId: 'agent-A' },
      )
      // Different key order — same fingerprint after sorted-JSON serialisation.
      const advice = history.check('bash', { cwd: '/tmp', command: 'ls' })
      expect(advice.level).not.toBe('allow')
      expect(advice.previousFailures).toBeGreaterThan(0)
    })

    it('record() with agentId surfaces it in block message', () => {
      const history = getGlobalToolCallHistory({ hintThreshold: 0, blockThreshold: 2 })
      history.record('bash', { cmd: 'x' }, { success: false, agentId: 'foreground-1' })
      history.record('bash', { cmd: 'x' }, { success: false, agentId: 'background-2' })
      const advice = history.check('bash', { cmd: 'x' })
      expect(advice.level).toBe('block')
      if (advice.level === 'block') {
        // Last failure agent should be surfaced.
        expect(advice.message).toMatch(/background-2/)
      }
    })
  })

  // Audit fix H4 — dual-track lineage scoping:
  // sibling agents should NOT block each other; parent-child chains SHOULD.
  describe('H4 — lineage-aware isolation (siblings) + bubble-up (parent/child)', () => {
    it('SIBLINGS — Explore-1 and Plan-1 (both children of main) do NOT share failure history', () => {
      // NB: use realistic hint=1 / block=2 so "0 failures → hint" doesn't
      // mask the isolation behaviour we're trying to assert.
      const history = getGlobalToolCallHistory({ hintThreshold: 1, blockThreshold: 2 })
      // Explore-1's two failures
      history.record('grep', { pattern: 'foo' }, {
        success: false,
        errorSummary: 'no matches',
        agentId: 'explore-1',
        parentAgentId: 'main',
        agentType: 'Explore',
      })
      history.record('grep', { pattern: 'foo' }, {
        success: false,
        errorSummary: 'no matches',
        agentId: 'explore-1',
        parentAgentId: 'main',
        agentType: 'Explore',
      })
      // Plan-1 is also a child of main, but a SIBLING of Explore-1. Its
      // own `grep "foo"` must not be blocked by Explore-1's failures.
      history.registerAgentLineage('plan-1', { parentAgentId: 'main', agentType: 'Plan' })
      const adviceForPlan = history.check('grep', { pattern: 'foo' }, { callerAgentId: 'plan-1' })
      expect(adviceForPlan.level).toBe('allow')
    })

    it('PARENT sees CHILD failures (so the parent does not redo broken work)', () => {
      const history = getGlobalToolCallHistory({ hintThreshold: 0, blockThreshold: 2 })
      // Child explore-1 records failures
      history.record('grep', { pattern: 'foo' }, {
        success: false,
        agentId: 'explore-1',
        parentAgentId: 'main',
        agentType: 'Explore',
      })
      history.record('grep', { pattern: 'foo' }, {
        success: false,
        agentId: 'explore-1',
        parentAgentId: 'main',
        agentType: 'Explore',
      })
      // Parent main now checks — child's failure is on the parent's
      // lineage, so the block fires.
      const adviceForMain = history.check('grep', { pattern: 'foo' }, { callerAgentId: 'main' })
      expect(adviceForMain.level).toBe('block')
    })

    it('CHILD sees PARENT failures (so the child does not redo what the parent already failed at)', () => {
      const history = getGlobalToolCallHistory({ hintThreshold: 0, blockThreshold: 2 })
      // Parent records failures
      history.record('grep', { pattern: 'foo' }, {
        success: false,
        agentId: 'main',
        agentType: 'main',
      })
      history.record('grep', { pattern: 'foo' }, {
        success: false,
        agentId: 'main',
        agentType: 'main',
      })
      // Child explore-1 spawned later
      history.registerAgentLineage('explore-1', { parentAgentId: 'main', agentType: 'Explore' })
      const adviceForChild = history.check('grep', { pattern: 'foo' }, { callerAgentId: 'explore-1' })
      expect(adviceForChild.level).toBe('block')
    })

    it('block message names agentType + opaque id + truncated tool input description', () => {
      const history = getGlobalToolCallHistory({ hintThreshold: 0, blockThreshold: 2 })
      history.record('grep', { pattern: 'foo' }, {
        success: false,
        agentId: 'explore-1',
        parentAgentId: 'main',
        agentType: 'Explore',
      })
      history.record('grep', { pattern: 'foo' }, {
        success: false,
        agentId: 'explore-1',
        parentAgentId: 'main',
        agentType: 'Explore',
      })
      const advice = history.check('grep', { pattern: 'foo' }, { callerAgentId: 'main' })
      expect(advice.level).toBe('block')
      if (advice.level === 'block') {
        // Audit fix H4 surfaces agentType (Explore) AND id AND tool desc.
        expect(advice.message).toMatch(/Explore/)
        expect(advice.message).toMatch(/explore-1/)
        expect(advice.message).toMatch(/grep/)
        expect(advice.message).toMatch(/pattern.*foo/)
        // Plus the "override if your context differs" guidance.
        expect(advice.message).toMatch(/override/i)
      }
    })

    // Self-audit R2-H (2026-05) — orphan agents (no parentAgentId, no
    // sessionAgentType, never registered via registerAgentLineage) are
    // implicitly promoted under `main` so their failures still bubble
    // to / from main. Without this, an ad-hoc spawned agent's bad
    // calls would be invisible to the main agent and to its other
    // children — defeating the H4 contract for the most common
    // "I forgot to register lineage" failure mode.
    it('R2-H orphan fallback — agents with no registered parent are treated as children of main', () => {
      const history = getGlobalToolCallHistory({ hintThreshold: 1, blockThreshold: 2 })
      // adhoc-1 records two failures WITHOUT registering or providing
      // a parentAgentId in the outcome — the classic orphan case.
      history.record('grep', { pattern: 'orphan' }, {
        success: false,
        agentId: 'adhoc-1',
      })
      history.record('grep', { pattern: 'orphan' }, {
        success: false,
        agentId: 'adhoc-1',
      })
      // main checks the same call — orphan fallback means adhoc-1's
      // lineage is ['main', 'adhoc-1'] which shares lineage with
      // ['main'], so main sees the block.
      const adviceForMain = history.check('grep', { pattern: 'orphan' }, { callerAgentId: 'main' })
      expect(adviceForMain.level).toBe('block')
    })

    // Audit fix R3 (2026-05) — session-memory-internal is a hard-sandboxed
    // sub-agent. Its sandbox-rejection failures (`[session-memory-internal]
    // Access denied: ...`) must NOT propagate into the cross-agent history,
    // because the sandbox is unique to that agent and the rejection has
    // no predictive value for the parent / siblings. Without this filter,
    // a session-memory-internal child that hallucinates a read outside
    // its sandbox produces 2× failures that block the main agent's
    // identical (legitimate) read.
    describe('R3 — session-memory-internal sandbox-rejection isolation', () => {
      it('does NOT record session-memory-internal sandbox-rejection failures', () => {
        const history = getGlobalToolCallHistory({ hintThreshold: 1, blockThreshold: 2 })
        const sandboxErr =
          '[session-memory-internal] Access denied: this agent may only read/write files under the session-memory directory.'
        // Two sandbox-rejected failures from a session-memory-internal child
        history.record(
          'read_file',
          { filePath: 'C:/Users/x/Desktop/some-file.txt' },
          {
            success: false,
            errorSummary: sandboxErr,
            agentId: 'sm-1',
            parentAgentId: 'main',
            agentType: 'session-memory-internal',
          },
        )
        history.record(
          'read_file',
          { filePath: 'C:/Users/x/Desktop/some-file.txt' },
          {
            success: false,
            errorSummary: sandboxErr,
            agentId: 'sm-1',
            parentAgentId: 'main',
            agentType: 'session-memory-internal',
          },
        )
        // Main (parent) tries the same call — it has no sandbox, must be allowed.
        const advice = history.check(
          'read_file',
          { filePath: 'C:/Users/x/Desktop/some-file.txt' },
          { callerAgentId: 'main' },
        )
        expect(advice.level).toBe('allow')
        expect(
          history.getOutcomes('read_file', { filePath: 'C:/Users/x/Desktop/some-file.txt' }),
        ).toHaveLength(0)
      })

      it('still records non-sandbox failures from session-memory-internal (e.g. ENOENT inside the sandbox)', () => {
        const history = getGlobalToolCallHistory({ hintThreshold: 0, blockThreshold: 2 })
        // A genuine failure (file missing) — error does NOT carry the
        // sandbox prefix, so it should still be recorded normally.
        history.record(
          'read_file',
          { filePath: '/home/u/.claude/session-memory/conv.md' },
          {
            success: false,
            errorSummary: 'ENOENT: no such file or directory',
            agentId: 'sm-1',
            parentAgentId: 'main',
            agentType: 'session-memory-internal',
          },
        )
        expect(
          history.getOutcomes('read_file', {
            filePath: '/home/u/.claude/session-memory/conv.md',
          }),
        ).toHaveLength(1)
      })

      it('lineage registry is still populated from skipped sandbox rejections', () => {
        const history = getGlobalToolCallHistory({ hintThreshold: 1, blockThreshold: 2 })
        const sandboxErr = '[session-memory-internal] Access denied: tool "Bash" is not permitted for this agent.'
        history.record(
          'Bash',
          { command: 'ls /' },
          {
            success: false,
            errorSummary: sandboxErr,
            agentId: 'sm-7',
            parentAgentId: 'main',
            agentType: 'session-memory-internal',
          },
        )
        // No outcome stored, but the lineage map should still know about
        // sm-7's parent so an UNRELATED future failure attributed to sm-7
        // (e.g. a non-sandbox error) bubbles up to main correctly.
        history.record(
          'Bash',
          { command: 'echo hi' },
          {
            success: false,
            errorSummary: 'unrelated failure',
            agentId: 'sm-7',
            agentType: 'session-memory-internal',
          },
        )
        const adviceForMain = history.check(
          'Bash',
          { command: 'echo hi' },
          { callerAgentId: 'main' },
        )
        // 1 failure, hintThreshold=1 → hint level (proves the
        // lineage chain reached main, otherwise it'd be allow).
        expect(adviceForMain.level).toBe('hint')
      })
    })

    it('omitting callerAgentId preserves legacy "all outcomes count" behaviour (back-compat)', () => {
      const history = getGlobalToolCallHistory({ hintThreshold: 0, blockThreshold: 2 })
      history.record('grep', { pattern: 'foo' }, {
        success: false,
        agentId: 'explore-1',
        parentAgentId: 'main',
        agentType: 'Explore',
      })
      history.record('grep', { pattern: 'foo' }, {
        success: false,
        agentId: 'plan-1',
        parentAgentId: 'main',
        agentType: 'Plan',
      })
      // Legacy callers (no callerAgentId) still see ALL outcomes —
      // critical for upstream consumers that haven't migrated.
      const advice = history.check('grep', { pattern: 'foo' })
      expect(advice.level).toBe('block')
      expect(advice.previousFailures).toBe(2)
    })
  })

  // ── Audit fix H-1 — conversation-scoped fingerprints ──────────────────
  describe('H-1 conversation isolation', () => {
    it('does NOT cross-block an identical call in a different conversation', () => {
      const history = getGlobalToolCallHistory({ hintThreshold: 0, blockThreshold: 2 })
      // Tab A: main agent fails `npm install` twice (reaches block threshold).
      history.record('bash', { command: 'npm install' }, {
        success: false,
        errorSummary: 'EACCES',
        agentId: 'main',
        conversationId: 'conv-A',
      })
      history.record('bash', { command: 'npm install' }, {
        success: false,
        errorSummary: 'EACCES',
        agentId: 'main',
        conversationId: 'conv-A',
      })
      // Same conversation → blocked.
      expect(
        history.check('bash', { command: 'npm install' }, {
          callerAgentId: 'main',
          conversationId: 'conv-A',
        }).level,
      ).toBe('block')
      // Different conversation (another tab) → must NOT be blocked.
      expect(
        history.check('bash', { command: 'npm install' }, {
          callerAgentId: 'main',
          conversationId: 'conv-B',
        }).level,
      ).toBe('allow')
    })

    it('still blocks within the same conversation across its sub-agents (shared convId)', () => {
      const history = getGlobalToolCallHistory({ hintThreshold: 0, blockThreshold: 2 })
      // A sub-agent (explore-1) and the main agent share the conversation id.
      history.record('grep', { pattern: 'foo' }, {
        success: false,
        agentId: 'explore-1',
        parentAgentId: 'main',
        agentType: 'Explore',
        conversationId: 'conv-A',
      })
      history.record('grep', { pattern: 'foo' }, {
        success: false,
        agentId: 'explore-1',
        parentAgentId: 'main',
        agentType: 'Explore',
        conversationId: 'conv-A',
      })
      // Parent (main) in the same conversation sees the child's failures.
      expect(
        history.check('grep', { pattern: 'foo' }, {
          callerAgentId: 'main',
          conversationId: 'conv-A',
        }).level,
      ).toBe('block')
    })

    it('scoped invalidate/getOutcomes only touch the matching conversation bucket', () => {
      const history = getGlobalToolCallHistory({ hintThreshold: 0, blockThreshold: 1 })
      history.record('bash', { command: 'x' }, { success: false, conversationId: 'conv-A' })
      history.record('bash', { command: 'x' }, { success: false, conversationId: 'conv-B' })
      expect(history.getOutcomes('bash', { command: 'x' }, 'conv-A')).toHaveLength(1)
      expect(history.getOutcomes('bash', { command: 'x' }, 'conv-B')).toHaveLength(1)
      history.invalidate('bash', { command: 'x' }, 'conv-A')
      expect(history.getOutcomes('bash', { command: 'x' }, 'conv-A')).toHaveLength(0)
      // conv-B bucket is untouched.
      expect(history.getOutcomes('bash', { command: 'x' }, 'conv-B')).toHaveLength(1)
    })
  })
})
