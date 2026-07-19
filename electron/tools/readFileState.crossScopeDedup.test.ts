/**
 * P0-1 — cross-agent read dedup.
 *
 * When sibling sub-agents in the same conversation read the same file,
 * the second one should hit dedup against the first one's receipt and
 * receive cached content immediately (no stub-cycle).
 */

import { describe, it, expect, afterEach } from 'vitest'
import { runWithAgentContext, type AgentContext } from '../agents/agentContext'
import type { ProviderConfig } from '../ai/client'
import {
  clearAllReadFileState,
  recordSuccessfulRead,
  tryConsumeReadDedup,
  listReadReceiptsForConversation,
} from './readFileState'

const cfg: ProviderConfig = { id: 'anthropic', name: 't', apiKey: '' }

function ctx(agentId: string, conv?: string): AgentContext {
  return {
    config: cfg,
    model: 'm',
    systemPrompt: '',
    messages: [],
    signal: new AbortController().signal,
    agentId,
    streamConversationId: conv,
  }
}

describe('readFileState — cross-agent dedup (P0-1)', () => {
  afterEach(() => {
    clearAllReadFileState()
  })

  it('sibling sub-agent in same conversation receives cachedContent on first read', () => {
    const p = 'C:/tmp/cross-scope-test.txt'.replace(/\\/g, '/')
    const body = 'line1\nline2\nline3'

    runWithAgentContext(ctx('agent-a', 'conv-1'), () => {
      recordSuccessfulRead(p, {
        mtimeMs: 100,
        isPartialView: false,
        fullFileContent: body,
        viewedContent: body,
        readOffset: 0,
        readLimit: 2000,
      })
    })

    runWithAgentContext(ctx('agent-b', 'conv-1'), () => {
      const r = tryConsumeReadDedup(p, 100, 0, 2000)
      expect(r.dedup).toBe(true)
      if (!r.dedup) return
      expect(r.crossAgent).toBe(true)
      expect(r.sourceAgentId).toBe('agent-a')
      expect(r.cachedContent).toBe(body)
      expect(r.sourceIsPartial).toBe(false)
    })
  })

  it('does NOT cross conversations', () => {
    const p = 'C:/tmp/cross-conv-test.txt'.replace(/\\/g, '/')

    runWithAgentContext(ctx('agent-a', 'conv-1'), () => {
      recordSuccessfulRead(p, {
        mtimeMs: 200,
        isPartialView: false,
        fullFileContent: 'x',
        viewedContent: 'x',
        readOffset: 0,
        readLimit: 2000,
      })
    })

    runWithAgentContext(ctx('agent-b', 'conv-2'), () => {
      const r = tryConsumeReadDedup(p, 200, 0, 2000)
      expect(r.dedup).toBe(false)
    })
  })

  it('cross-agent does not match when mtime differs', () => {
    const p = 'C:/tmp/cross-mtime-test.txt'.replace(/\\/g, '/')
    runWithAgentContext(ctx('agent-a', 'conv-1'), () => {
      recordSuccessfulRead(p, {
        mtimeMs: 300,
        isPartialView: false,
        fullFileContent: 'x',
        viewedContent: 'x',
        readOffset: 0,
        readLimit: 2000,
      })
    })

    runWithAgentContext(ctx('agent-b', 'conv-1'), () => {
      const r = tryConsumeReadDedup(p, 301, 0, 2000)
      expect(r.dedup).toBe(false)
    })
  })

  it('cross-agent containment: sibling read covers requested narrower window', () => {
    const p = 'C:/tmp/cross-window-test.txt'.replace(/\\/g, '/')
    const body = Array.from({ length: 500 }, (_, i) => `L${i + 1}`).join('\n')
    runWithAgentContext(ctx('agent-a', 'conv-1'), () => {
      recordSuccessfulRead(p, {
        mtimeMs: 400,
        isPartialView: true,
        viewedContent: body,
        readOffset: 0,
        readLimit: 500,
      })
    })

    runWithAgentContext(ctx('agent-b', 'conv-1'), () => {
      const r = tryConsumeReadDedup(p, 400, 100, 50)
      expect(r.dedup).toBe(true)
      if (r.dedup) {
        expect(r.crossAgent).toBe(true)
        expect(r.sourceIsPartial).toBe(true)
      }
    })
  })

  it('same-scope receipt still wins (no cross-agent path when local exists)', () => {
    const p = 'C:/tmp/own-vs-cross.txt'.replace(/\\/g, '/')
    runWithAgentContext(ctx('agent-a', 'conv-1'), () => {
      recordSuccessfulRead(p, {
        mtimeMs: 500,
        isPartialView: false,
        fullFileContent: 'sibling',
        viewedContent: 'sibling',
        readOffset: 0,
        readLimit: 2000,
      })
    })
    runWithAgentContext(ctx('agent-b', 'conv-1'), () => {
      recordSuccessfulRead(p, {
        mtimeMs: 500,
        isPartialView: false,
        fullFileContent: 'own',
        viewedContent: 'own',
        readOffset: 0,
        readLimit: 2000,
      })
      const r = tryConsumeReadDedup(p, 500, 0, 2000)
      expect(r.dedup).toBe(true)
      if (r.dedup) {
        expect(r.crossAgent).toBeFalsy()
      }
    })
  })
})

describe('readFileState — listReadReceiptsForConversation (P0-2 helper)', () => {
  afterEach(() => {
    clearAllReadFileState()
  })

  it('returns receipts across all agents in a conversation', () => {
    const p1 = 'C:/tmp/list-1.txt'.replace(/\\/g, '/')
    const p2 = 'C:/tmp/list-2.txt'.replace(/\\/g, '/')

    runWithAgentContext(ctx('main', 'conv-x'), () => {
      recordSuccessfulRead(p1, {
        mtimeMs: 1,
        isPartialView: false,
        fullFileContent: 'a',
        viewedContent: 'a',
        readOffset: 0,
        readLimit: 100,
      })
    })
    runWithAgentContext(ctx('agent-a', 'conv-x'), () => {
      recordSuccessfulRead(p2, {
        mtimeMs: 2,
        isPartialView: false,
        fullFileContent: 'b',
        viewedContent: 'b',
        readOffset: 0,
        readLimit: 100,
      })
    })

    const items = listReadReceiptsForConversation('conv-x')
    expect(items).toHaveLength(2)
    expect(items.map((i) => i.resolvedPathKey).sort()).toEqual([
      p1.toLowerCase(),
      p2.toLowerCase(),
    ])
  })

  it('dedups by path keeping the most recent receipt across agents', () => {
    const p = 'C:/tmp/list-dedup.txt'.replace(/\\/g, '/')

    runWithAgentContext(ctx('agent-old', 'conv-y'), () => {
      recordSuccessfulRead(p, {
        mtimeMs: 1,
        isPartialView: false,
        fullFileContent: 'old',
        viewedContent: 'old',
        readOffset: 0,
        readLimit: 100,
      })
    })
    // Force a later readAt
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        runWithAgentContext(ctx('agent-new', 'conv-y'), () => {
          recordSuccessfulRead(p, {
            mtimeMs: 1,
            isPartialView: false,
            fullFileContent: 'new',
            viewedContent: 'new',
            readOffset: 0,
            readLimit: 100,
          })
        })
        const items = listReadReceiptsForConversation('conv-y')
        expect(items).toHaveLength(1)
        expect(items[0].agentId).toBe('agent-new')
        resolve()
      }, 5)
    })
  })

  it('excludeAgentId omits matching agent', () => {
    const p = 'C:/tmp/list-exclude.txt'.replace(/\\/g, '/')
    runWithAgentContext(ctx('agent-a', 'conv-z'), () => {
      recordSuccessfulRead(p, {
        mtimeMs: 1,
        isPartialView: false,
        fullFileContent: 'x',
        viewedContent: 'x',
        readOffset: 0,
        readLimit: 100,
      })
    })
    expect(listReadReceiptsForConversation('conv-z', { excludeAgentId: 'agent-a' })).toHaveLength(0)
    expect(listReadReceiptsForConversation('conv-z')).toHaveLength(1)
  })

  it('returns empty for unknown conversation', () => {
    expect(listReadReceiptsForConversation('does-not-exist')).toEqual([])
  })
})
