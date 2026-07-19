/**
 * Regression tests for the 2026-06 readFileState memory-bound fixes.
 *
 * Before the fix these all leaked:
 *   - a single scope accumulated one receipt per unique path (no cap)
 *   - byScope grew one bucket per sub-agent forever (no cap)
 *   - clearAllReadFileState left dedupStrikeCount entries behind
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  recordSuccessfulRead,
  tryConsumeReadDedup,
  listReadReceiptsInCurrentScope,
  clearAllReadFileState,
  __getReadFileStateInternalsForTests,
} from './readFileState'
import { runWithAgentContext, type AgentContext } from '../agents/agentContext'
import { asAgentId } from './ids'

function ctx(agentId: string, conv = 'mem-bounds'): AgentContext {
  return {
    agentId: asAgentId(agentId),
    streamConversationId: conv,
    model: 'm',
    systemPrompt: 's',
    messages: [],
    config: {} as never,
    signal: new AbortController().signal,
  } as unknown as AgentContext
}

describe('readFileState memory bounds', () => {
  beforeEach(() => clearAllReadFileState())
  afterEach(() => clearAllReadFileState())

  it('inner cap: a single scope is bounded to MAX_READ_RECEIPTS_PER_SCOPE', () => {
    const { maxReceiptsPerScope } = __getReadFileStateInternalsForTests()
    const N = maxReceiptsPerScope + 1500
    runWithAgentContext(ctx('main'), () => {
      for (let i = 0; i < N; i++) {
        recordSuccessfulRead(`C:/ws/f_${i}.ts`, {
          mtimeMs: i,
          isPartialView: false,
          fullFileContent: `x${i}`,
          viewedContent: `x${i}`,
        })
      }
      expect(listReadReceiptsInCurrentScope().length).toBe(maxReceiptsPerScope)
    })
    const internals = __getReadFileStateInternalsForTests()
    expect(internals.scopeCount).toBe(1)
    // readId index shrinks in lockstep with evictions.
    expect(internals.readIdCount).toBe(maxReceiptsPerScope)
  })

  it('inner cap: most-recent receipts are retained, oldest evicted', () => {
    const { maxReceiptsPerScope } = __getReadFileStateInternalsForTests()
    runWithAgentContext(ctx('main'), () => {
      for (let i = 0; i < maxReceiptsPerScope + 10; i++) {
        recordSuccessfulRead(`C:/ws/g_${i}.ts`, {
          mtimeMs: i,
          isPartialView: false,
          fullFileContent: `y${i}`,
          viewedContent: `y${i}`,
        })
      }
      const keys = listReadReceiptsInCurrentScope().map((r) => r.resolvedPathKey)
      // Oldest 10 evicted; newest present.
      expect(keys.some((k) => k.endsWith('/g_0.ts'))).toBe(false)
      expect(keys.some((k) => k.endsWith(`/g_${maxReceiptsPerScope + 9}.ts`))).toBe(true)
    })
  })

  it('outer cap: byScope bucket count is bounded across many sub-agents', () => {
    const { maxScopes } = __getReadFileStateInternalsForTests()
    const SUBS = maxScopes + 120
    for (let i = 0; i < SUBS; i++) {
      runWithAgentContext(ctx(`sub-${i}`), () => {
        recordSuccessfulRead(`C:/ws/s${i}.ts`, {
          mtimeMs: i,
          isPartialView: false,
          fullFileContent: 'z',
          viewedContent: 'z',
        })
      })
    }
    expect(__getReadFileStateInternalsForTests().scopeCount).toBeLessThanOrEqual(maxScopes)
  })

  it('clearAllReadFileState now also clears dedupStrikeCount (was leaked)', () => {
    runWithAgentContext(ctx('main'), () => {
      recordSuccessfulRead('C:/ws/dedup.ts', {
        mtimeMs: 1000,
        isPartialView: false,
        fullFileContent: 'body',
        viewedContent: 'body',
      })
      // Same window + unchanged mtime → dedup hit → bumps the strike counter.
      tryConsumeReadDedup('C:/ws/dedup.ts', 1000, 0, 50)
      tryConsumeReadDedup('C:/ws/dedup.ts', 1000, 0, 50)
    })
    expect(__getReadFileStateInternalsForTests().dedupStrikeCount).toBeGreaterThan(0)
    clearAllReadFileState()
    expect(__getReadFileStateInternalsForTests().dedupStrikeCount).toBe(0)
  })

  it('does not serve a truncated snapshot as a complete deduplicated read', () => {
    runWithAgentContext(ctx('main'), () => {
      const oversized = `${'x'.repeat(512 * 1024 + 64)}TAIL`
      recordSuccessfulRead('C:/ws/oversized.ts', {
        mtimeMs: 2000,
        isPartialView: false,
        fullFileContent: oversized,
        viewedContent: oversized,
      })
      expect(tryConsumeReadDedup('C:/ws/oversized.ts', 2000, 0, 2000)).toEqual({
        dedup: false,
      })
    })
  })
})
